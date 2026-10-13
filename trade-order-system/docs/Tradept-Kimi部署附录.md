# Tradept 私有部署指南





## A. 版本与交付材料

核对日期：2026-10-13。已核实 GitHub `main` 与 Release `v0.3.0` 的提交均为 `001a73c32a60a1999cd6299db9c7ebeaad8a2713`。已发布依赖基线为 ERPNext 16.32.3 / Frappe 16.31.0。

0.4.0 候选已经包含财务模块、商品维护、企业邮箱登录、部署生成管理员及 Desk 品牌调整，正在进行统一镜像验收，尚未成为正式 Release。实施当天重新检查正式 Release 和开发方交付清单；不要按文件存在、模块测试通过或候选分支存在就认定已发布。

下文区分 0.3.0 的已发布接口与 0.4.0 候选的新入口。企业正式交付采用包含完整私有初始化流程的已验收版本；候选入口仅供准备部署方案，不能提前用于生产。

仓库为私有仓库。由部署人员先配置只读 SSH Deploy Key 或获授权的 GitHub 身份，不在 clone URL 中嵌入访问令牌。0.3.0 的源码取得方式：

```sh
git clone --branch v0.3.0 --single-branch git@github.com:wuyinhust/tradept.git tradept
cd tradept
git rev-parse HEAD
```

输出应与上面的完整提交号一致。新版替换标签和对应提交号，不沿用旧哈希。没有 GitHub 权限时，由开发方提供同一提交的源码包及 SHA256 清单。

部署前必须齐备：源码及前端 vendor 资源、服务器对应架构的完整镜像或可复现构建输入、镜像摘要、单企业初始化参数、恢复方法。当前 v0.3.0 Release 没有单独附加镜像或安装包资产；不要杜撰 `ghcr.io/...` 等发布地址。

0.3.0 的旧部署文档含过时测试环境状态，版本以该标签的源码、Release 和实际回读为准。尤其注意以下已有工具的适用范围：

| 文件 | 使用前处理 |
|---|---|
| `integrations/erpnext/compose.yaml` | 来自本地测试；默认创建 `frontend`，应改为本企业单站点部署配置 |
| `tradept-sites.map.conf` 及 Nginx 模板 | 移除双企业示例映射；固定本企业 Host 和 site，拒绝未知值 |
| `Unified.Containerfile` | 默认 digest 在文档中标为 ARM64；x86_64 主机需核实并固定 amd64 基础镜像摘要 |
| `unified_build.py` | 依赖特定哈希的离线 wheel，不能用同版本任意下载包替换并跳过校验；须取得原构建材料，或另提供经验证的构建流程 |
| `unified_site_ops.py` | 限定 `frontend`、`grandware.test`，包含演示迁移逻辑；不能当成通用新企业初始化命令 |
| `integrations/cloud-test/tradept-test.service` | 替换目录、域名、环境文件；其测试 CPU／内存限制需按企业环境评估 |

不要复制 `/private/tmp`、Lima、原部署人的用户名路径或已有云测试数据库。Docker 镜像须包含安装好的 `tradept_core`；不能靠容器启动后临时复制源码维持运行。新版若有品牌 JS/CSS、图片或网页模板，必须核对它们进入镜像及静态资源构建；0.3.0 的构建脚本仅收集 Python、modules.txt 和 pyproject.toml，不能直接用于打包新增品牌资源。

0.4.0 候选构建器已增加 public、www、单据定义及许可资源的收集，基础镜像改为多架构摘要。部署时使用对应正式版本的完整构建器，核对目标 `linux/amd64` 或 `linux/arm64` 实际镜像，不套用旧版 ARM64 默认值。品牌源码、许可证和适用的对应源码交付材料随镜像提供，参照正式版本的 `docs/PRIVATE-LOGIN-AND-BRANDING.md`。

## B. 服务器与持久化

通过 SSH 确认系统、架构、空闲内存、磁盘、已有服务及公网 IP。新服务器也须确认数据盘为空后才能格式化。按 UUID 挂载到 `/srv/tradept-data`，写入开机挂载配置；挂载失败时业务服务应停止启动，避免误写系统盘。

按 [Docker 官方 Ubuntu 文档](https://docs.docker.com/engine/install/ubuntu/) 使用 apt 仓库安装 Docker Engine 与 Compose 插件，同时安装 Python 3、venv、Nginx、Git、CA 证书及 HTTPS 证书工具。应用运行账户使用 `tradept`；宿主不必全局安装整套 Bench。

推荐目录：

| 目录 | 用途 |
|---|---|
| `/opt/tradept/releases/<版本>/` | 指定版本的只读应用文件 |
| `/opt/tradept/current` | 当前运行版本链接 |
| `/etc/tradept/` | Compose、Nginx、环境配置；含密钥文件设 0600 |
| `/var/lib/tradept/` | 网关私有 runtime，归 `tradept`，目录 0700 |
| `/srv/tradept-data/` | MariaDB、Frappe sites、Redis 队列、日志和本机备份 |

网关目录没有业务数据库。数据库、sites 中的附件和配置必须真正挂载到数据盘；仅创建一个空数据目录不算完成。为持续服务配置自动重启、开机启动和日志轮转。

部署顺序：数据库与 Redis → configurator 完成 → 新建 site → 安装 erpnext 和 tradept_core → 企业初始化 → backend、frontend、websocket、workers、scheduler → 网关 → 公网 Nginx。一次性初始化容器成功退出是正常状态，长期服务持续退出则需排查。

## C. 建立一个真实企业站点

为新企业创建空 site，例如 `enterprise.internal`，以及独立随机数据库口令和管理员口令。只初始化一次；重试时识别已存在的站点，避免重建。

按目标版本的 `tradept_core.migration.configure_workspace` 和管理模块建立 `Trade Workspace`、首位原生 User、`Trade User Profile` 和角色授权。0.3.0 允许 `companies: []` 配合 `onboarding.status: required`，由管理员首次进入时建立公司。`server.cli init` **只安装网关路由，不会创建企业或账号**。

初始化应由开发方提供适配该版本的入口；若现场需编写一次性适配脚本，只调用已有正式接口、通过受限私有文件读取参数，先在空的隔离站点验证，再用于目标站点。不要用旧 Grandware 导入操作代替初始化。`configure_workspace` 会停用配置之外的已有成员，不得作为日常启动或反复同步配置的步骤。

0.3.0 初始化函数会生成内部 `.tradept.invalid` User 标识，不等同于真实邮箱激活；不要将其当作企业邮箱登录方案。新版按正式发布的邀请、管理员引导与账号迁移入口操作，先验证真实管理员能激活和登录，再启用强制策略。保留仅运维可用的恢复账户，避免白名单或 SMTP 配错后全员被锁住。

### 0.4.0 私有管理员生成入口（候选，正式发布后使用）

新企业先建立空 Workspace，`companies: []`、`users: []`、`onboarding.status: required`；由部署工具在原生 Administrator 上下文中提交并核验。不要生成演示账号。此后的管理员生成入口是：

```python
tradept_core.login_setup.provision_deployment(
    credentials_output="/绝对路径/私有目录/initial-admin.json"
)
```

这是代码入口示意，不是可以直接粘贴进 shell 的命令。实施人员根据正式部署包，在选定 site 的 Bench 管理上下文调用，并显式提交事务、核验真实登录；不要假定函数返回就已提交。

调用前，确保输出文件的父目录在容器内存在，权限为 0700、归执行进程所有、路径不含符号链接；文件必须尚不存在。若目录需挂载到宿主，检查容器用户 UID 的写入权限。该方法排他生成 0600 文件，包含随机账号、密码和 tenant ID，返回值不含凭据。凭据文件不是应用构建输入，不得通过日志或 Kimi 对话交付。

该入口要求 Workspace 已存在，只负责生成初始管理员、授予公司与财务／商品管理员权限、停用旧工作台账号及撤销旧密码和会话；保留历史 User/Profile ID 与业务归属。它不能代替创建数据库、安装应用或建立 Workspace，也不能当作每次启动的步骤。重复执行会拒绝覆盖；失败时先核对事务与文件状态，不删除已有有效凭据强行重跑。

原生 Administrator 与非 Tradept 运维账号另行管理、轮换旧凭据并限制维护入口。业务版本回退时继续保持旧演示账号停用；旧版本不支持新认证时进入维护状态，不能重新开放演示路由。

初始账号只能配置企业、公司、部门、SMTP 和邮箱规则，业务查询为空，不能添加员工或处理订单／商品。管理员收到验证邮件并设置密码后，邮箱规则才启用，初始账号同时停用；之后才开通员工和正常业务。没有真实邮箱和 SMTP 可以完成软件安装，不能标为业务上线完成。

### 网关配置

0.3.0 支持的单企业路由示意如下，占位符必须替换：

```json
{
  "tenants": {
    "enterprise": {
      "origin": "http://127.0.0.1:3088",
      "site": "enterprise.internal",
      "gatewayHmacKey": "REPLACE_WITH_RANDOM_64_HEX"
    }
  }
}
```

`enterprise` 必须与 Workspace 的企业 ID 一致。Nginx 内部映射必须允许该 site；不能只改 JSON。生成 32 字节随机密钥，私下写入上述 `gatewayHmacKey` 和该站点的 `tradept_gateway_hmac_key`，两端保持相同。不要在工具输出或聊天中显示密钥。

由 `tradept` 运行用户执行下列初始化；`cd` 到应用目录，以正确解释 Python 模块路径：

```sh
cd /opt/tradept/current/trade-order-system
sudo -u tradept /usr/bin/python3 -m server.cli \
  --runtime /var/lib/tradept init --sites /etc/tradept/frappe-sites.json
sudo -u tradept /usr/bin/python3 -m server.cli \
  --runtime /var/lib/tradept check
```

配置文件须允许 `tradept` 读取。systemd 的工作目录同上，网关启动参数为：

```sh
/usr/bin/python3 -m server.app --runtime /var/lib/tradept \
  --port 3087 --public-origin https://trade.example.com
```

0.3.0 登录仍使用企业 ID 和账号；单企业免填工作区与真实邮箱登录属于新版能力。不要给 0.3.0 添加它不支持的 `privateTenant` 配置字段。

0.4.0 候选在仅有一个 tenant 时自动固定企业。新部署保留单条路由，不配置 `demoMode` 或 `demoTenants`；不要复制双企业演示选择器。`privateTenant` 只在对应正式版本支持且确有需要时使用。

## D. HTTPS、邮件和外部连接

公网 Nginx 只接受企业固定域名，把 Tradept 请求代理到 `127.0.0.1:3087`，保留真实 Host。网关访问本机 `127.0.0.1:3088`；MariaDB、Redis 和内部服务不得发布公网端口。

域名解析生效后安装匹配域名的有效证书，配置自动续期和失败告警，并验证一次续期检查。HTTP 跳转 HTTPS。`--public-origin` 必须与浏览器访问的 HTTPS 地址完全一致，不能用通配 Host 或关闭 Origin 校验绕过登录报错。

Desk 是同一站点的原生业务后台。默认只允许运维通过 SSH 隧道／VPN 进入内部 3088 端口，并配置与该站点一致的固定 Host 映射。企业需要公开 Desk 时，使用经过该版本验收的固定入口和角色限制，连同静态资源、WebSocket、Cookie 和登录重定向一起验证；不要直接把 Tradept 的 `/api` 整段转发到原生后台，也不要另建一套业务库。

SMTP 使用企业邮件服务提供的端口和 TLS 配置，通常是 465 或 587，以提供商要求为准。配置 SPF／DKIM／DMARC 时遵照邮件服务商说明，保留已有邮件记录。发送一封实际测试邮件，并检查 worker、scheduler 及邮件队列；保存邮箱配置不代表能发信。

新版激活和重置链接须指向企业 HTTPS 域名；验证过期链接、重复使用链接和停用账号。允许全部邮箱仍必须走邀请授权。按当前产品方案不默认开启二次验证。

统一核对网关 `--public-origin`、邮箱策略 `publicOrigin`、原生 `host_name` 与反向代理域名。邮箱域名名单按精确匹配配置，不能默认把子域也视为已允许。新管理员真实邮箱必须在允许范围内；先保存规则、设置默认 SMTP，再勾选发送管理员验证邮件。`emailDelivery: queued` 只表示入队，需管理员实际收到并完成验证。

0.3.0 网关需访问汇率提供商，见 `server/README.md` 和目标版本源码。出站 HTTPS 不通或行情过期会阻止部分财务写入；应修复网络或服务状态，不能用过期值伪装实时行情。

## E. 验收、备份与升级

先在隔离验收站点运行测试，实际检查登录、权限、同企业多公司隔离、并发保存、Excel 预览与导入、订单转换及目标版本包含的新功能。验收财务单据不得混入企业正式账套。完成后才开放真实业务。

公网检查命令：

```sh
curl --fail --silent --show-error https://trade.example.com/api/version
```

检查 `version`、`sourceCommit`、`sourceManifestSHA256` 与冻结交付清单一致。0.3.0 读取应用目录中的 `release-build.json`；缺少该文件时哈希为 null。由真实源码清单生成标识，不填写未经计算的哈希。该版接口固定返回 `environment: test`，这不是可用环境变量切换的生产认证；不能以改显示字段替代验收。

设置每日一致性备份，包含数据库、公开及私有附件、site_config/common_site_config、加密密钥、企业部署配置和对应版本镜像摘要；备份文件加密后复制到同地域企业私有 COS 或独立服务器。备份中保存了可解密邮箱等凭据的配置，权限应与数据库同等严格。

首次上线前在隔离环境恢复一次，禁用该恢复环境的实际发信及外部业务操作，验证附件、账号和业务记录可用。云盘快照可以补充备份，但不能代替已验证的应用一致性恢复。

升级步骤：停止业务写入和相关后台任务 → 完整备份 → 部署固定版本镜像和网页 → 对已有 site 执行目标版本迁移 → 清理并更新静态资源 → 检查新旧功能 → 恢复访问。保持原数据库、sites 与公司资料，不重复执行企业初始化。回退须协调恢复代码、数据库、附件和配置；备份后的新业务不能静默丢弃。

交付一个不含密码的运维文件，记录实例及磁盘、域名、版本、镜像摘要、Compose 项目名、systemd 服务名、启动／停止／日志命令、备份计划、恢复命令、证书续期及负责人。部署失败时按实际错误修复；不要删除数据卷、关闭权限检查或切回旧 SQLite／CloudBase 数据源。

## 对照资料

- [Tradept 0.3.0 Release](https://github.com/wuyinhust/tradept/releases/tag/v0.3.0)
- [0.3.0 网关说明](https://github.com/wuyinhust/tradept/blob/v0.3.0/trade-order-system/server/README.md)
- [0.3.0 原生部署目录](https://github.com/wuyinhust/tradept/tree/v0.3.0/trade-order-system/integrations/erpnext)
- [Docker Ubuntu 安装](https://docs.docker.com/engine/install/ubuntu/)
- [TCCLI 安装](https://cloud.tencent.com/document/product/440/34011)与[配置](https://cloud.tencent.com/document/product/440/34012)
- [Kimi Code 安装](https://www.kimi.com/code/docs/kimi-code-cli/guides/getting-started)
