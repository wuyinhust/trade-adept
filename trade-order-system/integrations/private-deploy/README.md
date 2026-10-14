# AI 私有部署执行入口

从仓库根目录执行。默认目标为**空的 Ubuntu 24.04 amd64 服务器，建议先用至少 4 GB 内存、40 GB 可用磁盘**；容量仍需按企业实际业务验收。依赖和基础镜像均通过本目录清单下载并核验，源码已包含前端离线 JS、后端应用和安装脚本，无需另索取 Release 附件。

`trade-adept` 是对外交付入口；`tradept` 同步保留相同安装能力。使用主人给出的获授权仓库，不自动切换仓库。私有仓库访问、腾讯云付款、域名实名／备案和企业资料仍需要主人配合。AI 需要能执行命令、联网及 SSH；这不是浏览器聊天中的自动托管服务。

## 1. 采购前确认材料

克隆当前仓库，选择 `Private deployment from source` 工作流已成功的**完整提交 SHA**并检出，不直接跟随 main 自动变化。记录该提交的运行链接。没有成功记录先说明，不能把别的提交的绿灯套过来。

```sh
python3 trade-order-system/integrations/private-deploy/deploy.py materials --cache /tmp/tradept-wheels
```

三份公开 wheels 均以 `dependencies.json` 固定的 URL 和 SHA256 校验；ERPNext、MariaDB、Redis、Caddy 固定镜像摘要。先核对 Docker Hub 能访问、目标架构可拉取、域名和所选套餐符合需求，再付款。公网部署 DNS 指向服务器；80／443 用于证书及业务，SSH 限运维地址。数据库、Redis 和内部接口不对公网开放。

## 2. 在服务器安装

通过已授权 GitHub 身份克隆同一完整提交，或由部署电脑传输该提交的完整仓库（含 `local-preview/vendor`）。不要把 GitHub 凭据放进代码或 URL。首次先检查 80、443、3087、3088 无冲突；安装器只用于新企业，不能覆盖现有生产部署。

```sh
sudo sh trade-order-system/integrations/private-deploy/install-prerequisites.sh
sudo python3 trade-order-system/integrations/private-deploy/deploy.py prepare \
  --domain trade.example.com --tenant enterprise --name '企业实际名称'
sudo python3 trade-order-system/integrations/private-deploy/deploy.py install
sudo python3 trade-order-system/integrations/private-deploy/deploy.py check
```

先替换域名、企业名称和固定企业 ID。`prepare` 默认生成管理员凭据，只写入 `/opt/tradept-private/initial-admin.json`（0600）。主人自选账号时增加 `--admin-username <账号> --ask-password`，密码在本机私下输入。运维 Administrator、数据库和网关密钥分别生成，保存在受限目录，不输出到聊天。

`prepare` 只运行一次；相同目录再次 prepare 会拒绝，避免重置密钥。安装中断先读受限日志，修复原因后重新运行 install；已初始化站点不会重新建企业或重置管理员。发生代码问题按根 README 请示主人，不能擅自修改。改过 logo 或代码时，先在仓库跟踪新增文件，保留补丁；prepare 的清单绑定实际文件内容，准备后的源码不允许偷偷改动。

安装器自动构建企业镜像、启动数据库和队列、建立空站点、安装 ERPNext／tradept_core、建立空企业和管理员、配置内部映射、启用网关 systemd 和 Caddy HTTPS。**还没有自动替主人填公司资料，也没有自动购买备份。** check 确认 HTTPS、源码身份和登录接口，不能代替业务验收。

状态目录默认为 `/opt/tradept-private`。如更改，所有命令都在子命令前加 `--state /固定绝对路径`，后续不要换目录。主机仅部署这一套，固定使用 3087／3088。数据使用固定 Compose 项目下的 Docker 持久卷；不要删除卷或执行 `down -v`。

## 3. 企业初始化与交付

主人打开网址，私下取用账号密码，选择账号登录即可不配置 SMTP，填写真实公司、部门等资料。AI 按[备份与验收](../../docs/Tradept-备份与验收.md)逐项验收并填[交接表](../../docs/Tradept-部署信息与交接表.md)。原生后台默认仅通过 SSH 隧道访问 3088。

启停与日志（项目名按 tenant 修改）：

```sh
sudo docker compose -p tradept-enterprise -f /opt/tradept-private/compose.json ps -a
sudo systemctl status tradept-private-enterprise
sudo journalctl -u tradept-private-enterprise --since '10 minutes ago'
sudo docker compose -p tradept-enterprise -f /opt/tradept-private/compose.json logs --tail 100 backend frontend
```

`initialize.log` 可能含原生工具输出或凭据，仅本机受限查看。对外反馈先脱敏。升级前备份；本安装器当前只负责首次安装及同一版本的中断恢复，不要把新版本 checkout 覆盖正在运行的 source。

Caddy 保存证书并自动续期；监测到期和 HTTPS，确认 80／443、DNS、出站连接一直满足验证条件。公网大陆域名在备案允许之前不开网站。等备案期间可经私有网络使用 `--tls internal` 演练，并仅向企业受管设备安装该次 Caddy CA；它不会自动成为浏览器信任的公网证书。正式公网部署使用默认 `public`，不要把内部证书测试通过当成公网证书已签发。

## 4. 测试范围

`tests/` 检查输入、端口隔离、依赖完整性及私有文件。GitHub Actions 在空 Ubuntu 中从源码构建，使用私有测试 CA 验证 HTTPS，实际完成空企业管理员登录、账号模式初始化、公司与部门保存、409 冲突、容器重建、数据库及文件备份、隔离恢复。`smoke.py` 和 `restore_probe.py` 仅允许测试域名／租户，不能在企业实例执行。

测试不代替真实域名 ACME 签发、腾讯云采购／备案、整机重启、业务容量、企业财务单据和所选 logo 的实际验收。验收结论必须对应当次运行证据。
