# 隔离 ERPNext 环境恢复

2026-10-12 当前状态：持久 Lima VM `tradept-erp` 运行；真实 Example 业务链通过，详见 [验收记录](../../docs/ERPNEXT-ACCEPTANCE.md) 与 [回读证据](../../docs/erpnext-real-acceptance.json)。ERPNext 16.32.3 / Frappe 16.31.0、Docker Engine 29.1.3、Compose 2.40.3；服务仅暴露宿主 loopback 3088。恢复时复用当前实例、私有密码与 Docker volumes，不重新创建空站点。

## 实际位置与资源阈值

- Lima 状态：`/Users/wangyao/.tradept-lima`，0700；实际配置为该目录的 `tradept-erp/lima.yaml`。
- 官方工具/镜像/私有 env：`/Users/wangyao/.codex/visualizations/2026/10/11/01a12ab3-4b8a-7240-ab2a-0f86986c7d99/.trade-erpnext-runtime`。
- Trade 数据库与 API 配置：同级 `.trade-runtime`；凭据文件 `erpnext.json` 为 0600，不能复制到源码 SMB 目录。
- Guest 私有配置：`/home/wangyao.guest/trade-private`，0700；`erpnext.env`、`erpnext.json` 为 0600。
- Guest Compose 文件：上述目录的 `compose.yaml`；固定 project `tradept-erp`、site `frontend`。

VM 为 VZ ARM64、4 CPU、4 GiB RAM、20 GiB 稀疏盘，不挂载任何宿主目录。验收后 guest 使用约 6.2 GiB/19 GiB，内存可用约 2.7 GiB；宿主 APFS 可用约 9.9 GiB、swap 951 MiB。启动或拉取前检查宿主资源；**可用空间低于 4 GiB 或 swap 快速增长时，停止本任务 VM 并汇报，不能继续拉镜像直至耗尽系统盘。** 新建完整环境建议至少 8–10 GiB 可用 APFS 并能分配 4 GiB RAM；这是本次实测预算，不是上游最低配置。

2026-10-11 的空测试 VM 曾因宿主资源不足停机，后续现场其临时目录已不存在。未声称主动删除旧盘；当前实例重新建立于上面的持久短路径，避免临时目录丢失及 UNIX socket 超长。现有 VM 已有真实虚构 ERP 数据，不能套用此前删除空环境的操作。

## 启停与服务检查

```sh
export LIMA_HOME=/Users/wangyao/.tradept-lima
TRADE_LIMACTL=/Users/wangyao/.codex/visualizations/2026/10/11/01a12ab3-4b8a-7240-ab2a-0f86986c7d99/.trade-erpnext-runtime/tools/bin/limactl
df -h /Users/wangyao
sysctl vm.swapusage
"$TRADE_LIMACTL" list
"$TRADE_LIMACTL" start tradept-erp
"$TRADE_LIMACTL" shell tradept-erp
```

在 guest 内：

```sh
sudo docker version
sudo docker compose version
sudo docker info --format '{{.Driver}}'
sudo docker compose -p tradept-erp --env-file /home/wangyao.guest/trade-private/erpnext.env -f /home/wangyao.guest/trade-private/compose.yaml ps -a
sudo docker compose -p tradept-erp --env-file /home/wangyao.guest/trade-private/erpnext.env -f /home/wangyao.guest/trade-private/compose.yaml up -d
```

在宿主检查 `curl --noproxy '*' http://127.0.0.1:3088/api/method/ping` 应返回 `{"message":"pong"}`。configurator/create-site 已成功 exit 0；数据库 healthy。宿主仅发布 3088，DB3306/Redis6379 仅 guest Docker 内网。Lima 其余端口转发禁用，guest avahi/mDNS 已停止。

资源不足时退出 guest，在宿主执行 `"$TRADE_LIMACTL" stop tradept-erp`。这会保留磁盘和 volumes；不要执行 `down -v`、删除实例目录或 API 配置。

## 固定镜像与可重复重建

公共模板为 [lima.yaml](lima.yaml)。Ubuntu 官方固定镜像：

```text
https://cloud-images.ubuntu.com/releases/noble/release-20260926/ubuntu-24.04-server-cloudimg-arm64.img
sha256:1d6bffe64b848468ac97f821d369a4846d983de1800ccf6b5ec8853e85cefc55
```

本次完整下载后校验 SHA 一致，保存在私有工具目录 `ubuntu-24.04-arm64-verified.img`（620224512 bytes）；当前实际 VM 配置引用该文件。公共模板保留官方 URL 与相同 SHA，若重建可复用经校验文件，不能使用未经验证的替代镜像。

实际拉取的官方 ARM64 镜像：

| 镜像 | 实際 digest |
| --- | --- |
| ERPNext 16.32.3 | sha256:a9dea1cc498aa08010eb3567f1808c7bed98e4b9d17dcbd4265791c9ad00971e |
| MariaDB 11.8 | sha256:6422478cb8e159f080fb1d8ccf65101e26fe51385787fde7d16c3b165a331f15 |
| Redis 6.2-alpine | sha256:b362b5dff9d14d961dc3352db4776aba6a8c53ca2661d7c74ad2c121f82cdaea |

ERP 镜像 17 层压缩合计约 840 MiB，已经实际拉取并运行；压缩大小不能当作解压落盘预算。私有 env 固定 ERPNext digest；保留原文件中的随机管理员/数据库密码。若确需创建全新独立实例，先按 README 用 `private_env.py` 生成新的私有随机配置，不覆盖现有文件。

## 当前网络与 Docker 运行配置

官方 get.docker.com 安装在本机网络遇到 TLS 下载错误；实际使用 Ubuntu 官方签名 `docker.io` / `docker-compose-v2` 包，公共 Lima 模板已改为这个可重复路径。guest 内只运行 rootful Docker，使用 `sudo docker`，daemon 设置 `features.containerd-snapshotter=false`、`max-concurrent-downloads=1`。

当前 Docker 拉取通过本机已有代理在 guest 的 `http://192.168.5.2:7890`，no-proxy 为 localhost/127.0.0.1/::1；registry 使用官方 `https://index.docker.io` alias，没有第三方镜像站。代理地址只用于此次机器网络，其他机器按其实际网络配置，不把本机代理写入公共模板。

Docker 的 Go1.24 TLS 客户端在本网络拉取曾返回 EOF；guest systemd override `/etc/systemd/system/docker.service.d/tls-compat.conf` 设置 `Environment=GODEBUG=tlsmlkem=0` 后官方 pull 实际成功。该 [官方 Go1.24 兼容开关](https://go.dev/doc/go1.24#crypto/tls) 使用标准 TLS 密钥交换，保留证书验证；没有设置 insecure-registry 或关闭 TLS 校验。只在复现同类网络故障时使用，勿用它掩盖其他认证/证书问题。

Trade 的 loopback ERP API 调用显式禁用全局代理，且拒绝跟随 HTTP redirect，避免 API 密钥被送往代理或其他 origin。网络诊断禁止打印 Authorization header、私有 env 或 API 配置。

## 继续使用与重新验收

受限用户 `trade.integration@example.invalid` 已建 Customer/Supplier 创建所需的 Master Manager 角色；没有 System Manager。bootstrap 还建立叶子客户组/供应商组/区域和 USD 价格表。重新运行会保留已有 API key/secret，不需要重置正常凭据。

只对 Example / EX-01 操作：原示例 revision 9、SO USD1000、两 PO USD420/280，已通过虚构脚本提交 DN/PE。Trade 业务已收金额仍为 0，Grandware revision1/payload SHA 保持不变。不要自动导入或同步 Grandware。

新的虚构订单需在财务界面配置明确 ERP 明细，并使用当前数据库 revision 显式排队。管理员运行 `python3 -m server.erpnext_cli --runtime <私有runtime> run --limit 10`；这是有限批次操作，没有常驻自动调度。已提交订单的实质修改会 blocked，后续需要明确 cancel/amend 流程，不可通过删除本地 links 或 outbox 强制重放。

[acceptance.py](acceptance.py) 仅用于原虚构 Example / loopback 站点，可回读并复用同一组单据。生成报告前会检查交付、收款、平衡总账以及业务/其他租户数据不变。正式生产接入、审批与双向回写仍在本轮边界之外。
