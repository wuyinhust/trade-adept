# 部署执行附录（供 AI 执行）

返回 [guide](guide.md)。你负责执行；主人只提供选择、认证和企业资料。每完成一步，简短说明结果，再继续。本文是可执行操作的索引和模板，命令须适配已冻结的正式版本与目标服务器。不要把所有命令转交给主人。

## 1. 部署范围与材料

目标：一家企业、一台企业自有或企业腾讯云账号下的独立服务器、一个 Frappe site／业务数据库。企业可以有多个法人公司。Tradept 网页、Python 网关、ERPNext／Frappe、`tradept_core`、MariaDB、Redis、workers、scheduler、websocket 和 HTTPS 均在这台服务器运行；业务数据不转存 CloudBase。

先按[工具与代码](Tradept-工具与代码.md)取得正式标签、完整提交、代码、匹配架构的镜像或构建材料。仓库内应用目录是 `trade-order-system/`。技术入口在该目录下：

| 文件／模块 | 使用方式 |
|---|---|
| `integrations/erpnext/compose.yaml` | 作为服务结构参考，改成企业单站点配置后使用 |
| `tradept-sites.map.conf`、`tradept-frappe-nginx.conf.template` | 与 Compose 配套，改为企业固定 Host／site，移除演示映射 |
| `Unified.Containerfile`、`unified_build.py` | 对应正式版本的镜像构建入口，使用匹配哈希的依赖材料 |
| `integrations/frappe_app/tradept_core/migration.py` | 建立空企业 Workspace 的已有接口 |
| `login_setup.py`、`enterprise_login.py`、`login_policy.py` | 管理员初始化与登录规则；必须以所选版本实际接口为准 |
| `server/README.md`、`server/cli.py`、`server/app.py` | 网关路由、初始化、检查与启动 |
| `integrations/cloud-test/tradept-test.service` | systemd 示例；替换测试路径、域名、环境和资源限制 |

`unified_site_ops.py` 含旧演示迁移逻辑，不能当成通用企业安装器。不要复制 Grandware／Example 数据、旧服务器配置、`/private/tmp` 或原开发人员的用户名路径。新企业不导入示例租户、演示账号或虚构财务单据。

本文件编写时，本地源码显示账号登录与可选邮箱验证接口；这不是对某个远端 Release 的发布证明。你检查目标标签及其发布说明，不能把旧版邮箱强制流程或新版接口套到不支持的版本上。

## 2. 检查服务器并安装基础软件

通过 SSH 检查发行版、架构、CPU、内存、磁盘余量、现有服务及端口占用。已有业务先备份，重装或格式化前说明实际对象和影响并取得主人确认；新购空服务器直接继续。

在 Ubuntu 上按[Docker 官方安装说明](https://docs.docker.com/engine/install/ubuntu/)安装 Docker Engine 和 Compose 插件，安装 Git、Python 3.11 或更高版本／venv、Nginx、CA 证书及证书工具。检查：

```sh
docker --version
docker compose version
python3 --version
nginx -v
```

使用专用系统账户 `tradept`。推荐目录：

| 目录 | 内容 |
|---|---|
| `/opt/tradept/releases/<版本>/` | 当前版本应用文件 |
| `/opt/tradept/current` | 指向运行版本的链接 |
| `/etc/tradept/` | Compose、Nginx、环境和路由配置；含密钥文件 0600 |
| `/var/lib/tradept/` | 网关 runtime；目录 0700，归 tradept |
| `/srv/tradept-data/` | 数据库、sites、附件、队列、日志、本机备份 |

含密钥文件的 0600 必须配合正确所有者：路由文件及 runtime 归运行网关的 `tradept` 用户；Compose 私有 env 由执行 Compose 的运维账户读取；容器内管理员输入文件归实际 Bench 用户。宿主目录与容器 UID/GID 按镜像检查，不能只设 root:root 后让非 root 服务读取，也不要用 0777 绕过权限。

起步可用套餐自带 SSD，不必买独立数据盘。若购买数据盘，你检查为空后按 UUID 挂载；挂载失败时阻止业务启动，避免写回系统盘。数据库、sites 和附件须实际挂载到持久目录或卷，创建空目录不算完成。设置重启策略、开机启动和日志轮转。

## 3. 安装镜像，准备单站点配置

主人选择替换 logo 时，先按[企业 logo 适配与替换](Tradept-企业logo适配与替换.md)完成网页和深色模式处理，把企业资源及引用修改纳入本次构建；选择保留时直接继续。

优先使用正式交付的对应架构镜像，校验下载文件 SHA256、镜像摘要和版本。只有离线构建材料时，按同版本构建说明运行；现有构建器示例：

```sh
cd <源码仓库>/trade-order-system
python3 integrations/erpnext/unified_build.py \
  --app integrations/frappe_app --wheels <已校验wheels目录> \
  --output <全新构建目录>
```

确认上述命令成功后，在匹配目标 CPU 架构的构建机运行：

```sh
docker build --file <全新构建目录>/Unified.Containerfile \
  --tag <本次企业镜像标签> <全新构建目录>
```

也可从已校验的镜像包 `docker load --input <镜像包>`。用 `docker image inspect <镜像标签> --format '{{.Os}}/{{.Architecture}}'` 对照服务器架构。构建成功后记录镜像 ID／仓库摘要；不要依赖目标机未验证的跨架构模拟。构建器依赖固定哈希的 wheels；不要随意下载同版本包替换或删除校验。使用实际交付的基础镜像摘要，不从本文猜镜像仓库地址。

镜像必须包含 `tradept_core`、JS／CSS、图标、许可证和网站页，backend／frontend 使用同一镜像。核对 ERPNext／Frappe 版本与 Release 一致。不要用临时 `docker cp` 维持应用安装。

你生成 `/etc/tradept/compose.yaml` 及私有环境文件，并完成：

- 将 `create-site` 的站点名及“站点已存在”检查从 `frontend` 改成实际站点，例如 `enterprise.internal`；已有站点不重建。
- 固定数据库、Redis、worker 和 scheduler 配置，绑定所有持久卷。
- frontend 仅绑定 `127.0.0.1:3088`，网关仅内部访问它；数据库及 Redis 不开放公网端口。
- 配套 Nginx map 只允许本企业 Host／site，未知 Host／站点返回拒绝；保留 Compose `$$` 对 Nginx `$` 变量的转义。
- 把原生 Administrator、数据库口令和 HMAC 密钥存入私有文件，分别生成，不写入代码、构建上下文或命令输出。

整个部署固定同一个 Compose 项目名，防止创建另一组空卷。初始化 shell 使用失败即退出（如 `set -e`），不能让前一条失败被后一条成功掩盖。以下由 AI 替换占位值后在同一 shell 逐段执行，每段通过后才继续：

```sh
set -e
tradept_compose() {
  docker compose --env-file <私有env> -p <固定项目名> \
    -f /etc/tradept/compose.yaml "$@"
}
tradept_compose config --quiet
tradept_compose up -d --wait --wait-timeout 180 db redis-cache redis-queue
tradept_compose up --no-deps --exit-code-from configurator configurator
tradept_compose up --no-deps --exit-code-from create-site create-site
tradept_compose up -d --no-deps backend
tradept_compose exec -T backend bench --site <实际site> list-apps
```

`--wait` 对有 healthcheck 的服务等健康、其他服务只等运行；create-site 仍须检查依赖及建站结果。确认数据库健康、初始化容器以 0 退出、backend 正在运行，才可执行后面的 `exec backend`。配置和建站服务是一次性任务，不能给它们设置永久重启。不要在新站点尚未就绪时一口气 `up -d` 全部服务。依据：[Docker Compose up](https://docs.docker.com/reference/cli/docker/compose/up/)。

完成第 4 节应用安装、企业与管理员初始化，以及第 5 节站点密钥后，再启动业务服务：

```sh
tradept_compose up -d --no-deps frontend websocket queue-long queue-short scheduler
tradept_compose ps -a
```

最后启动网关和 HTTPS。以上 `--no-deps` 仅用于已显式启动依赖的步骤；不用于跳过缺失服务。初始化服务成功退出正常，长期服务反复退出需修复。

## 4. 建立空企业与私有管理员

进入目标站点的 Bench 管理环境。以下示例假定 Compose 服务叫 `backend`；替换项目名、env 和实际 site：

```sh
docker compose --env-file <私有env> -p <项目名> \
  -f /etc/tradept/compose.yaml exec backend \
  bench --site <实际site> list-apps
```

确认已安装 erpnext、tradept_core；create-site 应已安装 erpnext，缺失时先检查其退出原因。tradept_core 未安装时用同镜像中的 `bench --site <site> install-app tradept_core`，随后 `bench --site <site> migrate`，按版本构建静态资源并再次检查 list-apps。不要因为镜像含有应用文件就认为站点已安装该应用。

空站点只初始化一次。进入同一 backend 的 `bench --site <site> console`，在 Python 上下文调用已有接口：

```python
import frappe
from tradept_core.migration import configure_workspace
frappe.set_user("Administrator")
if frappe.db.exists("Trade Workspace", "workspace"):
    raise RuntimeError("企业已存在，先检查状态，不重复初始化")
result = configure_workspace({
    "id": "enterprise",
    "name": "企业实际名称",
    "companies": [],
    "users": [],
    "allowNativeSignup": False,
    "onboarding": {"status": "required"}
})
frappe.db.commit()
```

企业 ID 和名称先替换。失败时回滚并检查；`configure_workspace` 会影响成员配置，不得作为日常启动脚本。`server.cli init` 仅创建网关 runtime，不创建企业或管理员。

主人自选管理员时，将他私下输入的内容写到容器内绝对路径的普通 JSON 文件，权限 0600、目录 0700，包含：

```json
{
  "administrator": {
    "id": "enterprise-admin",
    "name": "企业管理员",
    "username": "替换为主人准备的账号",
    "password": "私下输入的独立密码，不保留本占位值",
    "visibleCompanyIds": []
  }
}
```

这是文件格式，不将真实内容粘贴进聊天。站点已有公司时按实际公司 ID 设置范围。使用该版本支持的入口，在 Bench console 中执行：

```python
import frappe
from tradept_core.enterprise_login import provision_private_access
frappe.set_user("Administrator")
result = provision_private_access(configuration="/容器内私有目录/admin-input.json")
frappe.db.commit()
```

如主人选择自动生成，改用 `tradept_core.login_setup.provision_deployment(credentials_output="/容器内私有目录/initial-admin.json")` 并显式提交。输出父目录须真实存在、0700、归执行用户所有、无符号链接；输出文件须不存在。接口排他写入 0600 文件，不能反复调用重置已初始化账号。

生成或自选二者择一。核验实际账号可登录、权限完整、旧演示身份不可用；自选输入文件核验后安全移除，自动生成凭据通过企业密码库或受限文件私下交付。不要输出密码、私钥、数据库口令或激活链接。保留受限原生 Administrator 作为运维恢复身份，不能作日常工作台账号。

## 5. 网关、域名与 HTTPS

为本企业生成私有路由文件 `/etc/tradept/frappe-sites.json`：

```json
{
  "tenants": {
    "enterprise": {
      "origin": "http://127.0.0.1:3088",
      "site": "enterprise.internal",
      "gatewayHmacKey": "私下写入随机生成的64位十六进制密钥"
    }
  }
}
```

tenant ID 等于 Workspace ID；site 等于实际站点名。同一密钥也写入站点 `tradept_gateway_hmac_key`，不要在可记录的命令参数中放真实值。Nginx 内部映射也须允许这个 site。当前网关访问 `origin` 时 Host 是 `127.0.0.1:3088`，另外发送固定 `X-Frappe-Site-Name`，所以不能只将 map 改成公网域名。示例内部 map（按实际 site 替换）：

```nginx
map "$http_host|$http_x_frappe_site_name" $tradept_site_name {
    default __tradept_invalid_site__;
    "127.0.0.1:3088|enterprise.internal" enterprise.internal;
    "127.0.0.1:3088|" enterprise.internal;
    "localhost:3088|" enterprise.internal;
}
```

map 配合仓库 Nginx 模板的无效站点拒绝逻辑；仅限 frontend 回环端口，空 header 的两项用于本机／隧道运维。测试固定 site 可以访问、伪造 site 被拒绝。新部署只保留一个 tenant，不配置 demoMode／demoTenants。

通过所选版本支持的站点配置接口，把私有文件中的密钥写入当前 site，保持 JSON 其余项及文件权限，不打印密钥；重启 backend 及后台服务使配置生效。网关路由文件同样由 `tradept` 可读。不要在 console 中直接敲真实密钥使其进入历史记录。

在服务器应用目录运行：

```sh
cd /opt/tradept/current/trade-order-system
sudo -u tradept /usr/bin/python3 -m server.cli \
  --runtime /var/lib/tradept init --sites /etc/tradept/frappe-sites.json
sudo -u tradept /usr/bin/python3 -m server.cli \
  --runtime /var/lib/tradept check
```

systemd 使用上述工作目录和专用用户，网关启动行为：

```sh
/usr/bin/python3 -m server.app --runtime /var/lib/tradept \
  --port 3087 --public-origin https://<企业实际域名>
```

不要照搬测试模板的 CPU／内存上限。服务启动后检查监听范围、状态、日志及开机启动。

你在实际 DNS 服务商处增加 A 记录，指向服务器公网 IP；使用 DNSPod 时可调用其对应 API，操作前查询现有记录，保留已有网站和邮箱记录。HTTP／HTTPS 入口仅接受企业固定域名；公网 Nginx 代理到 `127.0.0.1:3087`，保留真实 Host。

安全组／轻量防火墙只开放所需入口：22 限运维 IP，443 按员工访问范围；HTTP 证书验证时开放 80，随后 HTTP 跳转 HTTPS。不要公开 3087、3088、3306、6379、8000、9000。内网／VPN 部署使用对应访问范围和 DNS 证书验证。

安装匹配域名的有效证书、自动续期和失败告警，实际检查续期。大陆公网入口等备案通过后再开放。Desk 默认通过 SSH 隧道／VPN 访问内部端口；需要公开原生后台时单独验证固定入口、权限、资产、Cookie 和 WebSocket。

网关 `--public-origin`、反向代理域名、邮箱策略 `publicOrigin`、Frappe `host_name` 保持一致，不能关闭 Origin 校验绕过错误。运行时还需要出站 DNS、校时、更新、汇率 HTTPS；启用邮箱时需对应 SMTP 连接。行情过期导致写入失败时修复出站连接，不能伪造实时汇率。

## 6. 主人完成企业初始化

你用直白的话让主人打开网址、输入私有管理员账号，填真实企业、公司、国家／地区、本位币和部门。资料填写是主人负责，点击和检查由你尽量完成。公司币种和科目在建账前核对，不凭历史汇总金额生成虚构账务。

登录方式按该正式版本支持的能力选择：

| 方式 | 主人操作／你核验 |
|---|---|
| 账号密码 | 选择账号登录并保存；不用先购买邮箱或配置 SMTP，核验初始化解除且成员与业务可用 |
| 邮箱登录、不要求邮件验证 | 设置允许邮箱范围和关闭验证；按该版本规则核验管理员及成员登录，不能声称已验证邮箱归属 |
| 邮箱登录、要求邮件验证 | 主人准备真实邮箱和邮件服务；你配置 SMTP、白名单和企业网址，发送验证邮件，主人收信并激活 |

普通账号仍需管理员创建并授予角色和公司范围，不能开放匿名业务访问。邮箱后缀可按产品规则选择任意、域名白名单或指定邮箱；允许任意后缀不等于任何人都有业务权限。

选择邮件验证时，先配置默认发信账号，再发送管理员验证。实际收到并激活后，核验新身份可登录、初始身份按版本规则停用；队列显示 queued 不代表送达。SMTP 配错时保留初始化通道修正，不反复生成管理员。账号模式下，初始管理员可按规则保留为正式管理员，不套用“必须失效”的邮箱验收条件。

邀请成员、验证、找回密码仅在启用对应邮件功能时验收。SMTP 为邮件功能服务，不把它列为账号登录的强制采购项。旧版本不支持所选登录方式时说明限制，取得支持该能力的正式版本后再继续。

## 7. 完成检查和交付

按[备份与验收](Tradept-备份与验收.md)完成实际检查，填[交接表](Tradept-部署信息与交接表.md)。首笔正式业务由企业财务确认；测试账务放隔离验收站点，不污染正式账套。升级使用明确版本和迁移流程；失败时恢复对应代码、数据库、附件和配置，不能只回退网页。

| 现象 | 你先检查 |
|---|---|
| tccli 不可用 | 环境激活、地域、CAM 服务权限 |
| SSH 超时／拒绝 | 实例运行状态、22 规则、用户名和私钥 |
| 网站打不开／502 | DNS、证书、Nginx、网关及原生服务 |
| 登录 403 | 固定域名、public-origin、站点映射与身份权限 |
| 初始化未解除 | 所选登录规则是否已保存；邮件验证模式是否真实激活 |
| 保存失败 | 汇率网络、两端 HMAC、业务资料和权限 |
| 重启后数据消失 | 数据库及 sites 持久卷、实际挂载和开机服务 |

修复后重复失败的检查。不要删除数据卷、运行 `docker compose down -v`、关闭权限校验或切换旧 SQLite／CloudBase 来掩盖故障。


## 8. 安装受阻时修改代码

安装遇到问题时，可以通过修改代码解决或绕过，但必须先请示主人。这包括应用源码、构建脚本、安装脚本及依赖定义的临时修补；不能把它当成普通配置调整直接执行。

1. 先排查，准备具体改动方案或补丁说明：问题原因、修改哪些文件、对功能／数据／安全及以后升级的影响，以及验证和回退方法。请示前不应用代码改动。
2. 用直白的话说明并询问，例如：“安装卡在……。我可以修改……来解决，影响是……，失败时可以……恢复。你同意我按这个方案修改吗？”
3. 暂停这项修改，等主人明确同意；等待期间可继续不依赖该修改的检查。沉默不算同意，不能先改后报。已有对同一具体方案的明确授权无需重复请示；新增超出授权范围的改动需重新说明。
4. 同意后在企业部署副本中做最小修改，保留原版本和补丁，重新构建并验证安装及受影响功能；失败则回退或再提出方案。交接时记录授权、修改、验证结果和回退方法，标明这是基于正式版本的企业定制，不能冒充原版已通过验收。

按已确认方案填写域名、端口、密钥路径等部署配置可继续执行。已同意的 logo 替换按原范围执行；为排除安装故障而额外改代码，仍遵循本节。
