# Tradept 独立云测试环境

所有现有环境都属于测试环境。这里提供部署适配模板；模板存在和本机测试通过，不表示云资源已创建或云部署已验收。部署记录需要另行记录账号、主机、版本、固定访问地址和实际验证结果。

## 支持的部署方式

当前后端使用 SQLite，同一台独立 CVM / Lighthouse 虚拟机上运行一个 Python API 实例和 Caddy HTTPS 反向代理。数据库必须位于这台主机的可靠本地盘或云块盘，例如 `/var/lib/tradept/workspace.sqlite3`。该目录只供一个环境使用，运行用户为 `tradept`，目录权限 `0700`、文件权限 `0600`。

CloudBase Run 的临时文件系统、COS、CFS、SMB / NAS 共享目录均不适用于当前 SQLite 工作区。不能用静态托管替代这个后端，也不能开多个 API 实例或自动扩容共写这个文件。平台没有适合的持久盘时，应先更换部署平台或实施独立 SQL 数据库适配。

当前账号中的既有主机要先确认能够隔离目录、服务和端口，避免占用其他测试应用。没有合适资源时，新购资源的规格和费用由主任务确认。此目录中的文件不执行购买、端口开放或云数据写入。

## 访问边界

Python 始终监听 `127.0.0.1:3087`。配置一个固定的 HTTPS origin，例如 `https://tradept-test.example.com`：

```sh
python3 -m server.app --runtime /var/lib/tradept --port 3087 \
  --public-origin https://tradept-test.example.com
```

公共域名仅为占位示例，部署时必须替换为实际域名。不能使用 wildcard、IP 地址、HTTP、路径、用户名或密码作为 origin。默认 HTTPS 端口 443 会归一化为没有端口的 origin。

应用只接受配置域名的 Host。需要写入的请求必须携带完全相同的 HTTPS Origin；跨站请求、重复 Host / Origin 和伪造的 `X-Forwarded-*` 都不能绕过校验。云模式的登录和退出 cookie 都包含 `Secure`、`HttpOnly`、`SameSite=Strict`，无跨域或匿名业务 API。

`Caddyfile` 供同一台主机上的 Caddy 使用。Caddy 的服务环境中必须设置相同的 `TRADE_PUBLIC_ORIGIN`，代理保留原始 Host，不设置 `header_up Host` 将任意访问域名改写成被授权的域名。主机安全组与防火墙只允许需要的 HTTPS / 证书验证端口和受限的管理入口，不开放 3087。

已有 Nginx / HTTPS 服务的共用主机优先复用现有 Nginx。`nginx.conf.example` 只增加一个专用的 `server_name`，使用该测试域名对应的证书，保留原始 `Host $http_host` 并代理到 loopback API。替换示例域名后，`TRADE_PUBLIC_ORIGIN` 必须设置为完全相同的 HTTPS origin；不能使用 wildcard、把它改成默认站点或硬编码 Host 将其他域名转入。模板不会配置 DNS、申请证书或开放端口。实际部署先执行现有 Nginx 的配置检查，再平滑 reload；保留原来的站点和 TLS 配置。此时不启动新的 Caddy 抢占现有 80 / 443 端口。

`tradept-test.service` 是 Linux systemd 模板。部署目录为 `/opt/tradept`，其中同时包含 `trade-order-system` 和 `local-preview/vendor` 两个目录；后者提供两个离线依赖库。`/etc/tradept/cloud-test.env` 保存一个环境值：

```text
TRADE_PUBLIC_ORIGIN=https://tradept-test.example.com
```

该文件不放入 Git。账号配置与密码生成文件、ERPNext token、数据库和快照都存放在私有运行目录，不能进入发布包、日志或网页。云测试初始数据仅使用虚构企业样例；本机 Grandware 档案保留在本机，不作为新云环境的种子数据。

服务默认限制为 `CPUQuota=25%`、`MemoryMax=256M`、`TasksMax=64`，用于已预付主机上的小型隔离测试。CPU 配额是一个逻辑 CPU 的四分之一；内存与任务数量由 systemd / cgroup 限制。部署前检查主机容量与现有服务，若导入、并发或备份达到限制，应先测量再明确调整，不能自动取消限额或提高实例规格。

如果尚无可用 HTTPS 域名，可先在隔离主机上使用默认 loopback 模式并通过 SSH 隧道验收。浏览器的本地转发端口必须与远端 API 的监听端口相同，保证 Host / Origin 匹配。例如远端 API 显式使用 3089，SSH 使用 `-L 127.0.0.1:3089:127.0.0.1:3089`，浏览器访问 `http://localhost:3089`。Cookie 的主机范围不按端口隔离，因此云预览使用 `localhost`，与本地 `http://127.0.0.1:3087` 的同名会话 Cookie 分开。此方式的访问需要 SSH 授权，不产生公开 HTTP 入口；不配置 `--public-origin`，也不对公网开放 3089。

## 数据与版本更新

首次部署先在独立运行目录配置虚构租户和配置式账号，再导入虚构样例。新环境的密码和 token 必须独立生成，不复制本机 demo 凭据。没有 ERPNext 云测试服务时保持 ERPNext 对接关闭。

已发布的 `local-preview/seed.json` 是公开源码中的虚构样例，含 4 客户、4 工厂、4 订单、4 出运和四个 Grandware Demo 法人。使用 `server/config.example.json` 自动生成新环境口令：

```sh
python3 -m server.cli --runtime /var/lib/tradept init \
  --import ../local-preview/seed.json --tenant grandware
```

命令从 `trade-order-system` 目录执行。`grandware` 是 demo 工作区标识；这里导入的是虚构样例，不能改用 `local-preview/data` 中的真实客户归档。发布包最多带入这一个 seed 和两个 vendor 库，不打包整个 `local-preview` 数据目录。生成的密码仅存在运行目录的 `demo-credentials.json`，由授权管理员在主机上私下读取，不放入网页、Git、部署日志或验收报告。

更新采用单实例停旧再启新。停止 API 写入后使用 SQLite backup API 建立备份、计算校验值，保留先前代码版本和账号配置。只替换应用文件，不能覆盖运行目录。启动后验证 SQLite `quick_check`、租户 / 公司 / 角色隔离、HTTPS 登录、写入后的重启持久化、旧版本保存返回 409、备份恢复。失败时停止新实例并按已验证的备份回退，不能复制一个仍在写入的裸数据库文件冒充快照。

## 适配验证

专门的真实 loopback HTTP 测试使用临时 SQLite 与虚构账号：

```sh
python3 -m unittest server.tests.test_cloud_test -v
```

覆盖固定 Host / HTTPS Origin、默认本地兼容、无登录访问拒绝、跨站拒绝、伪造代理头拒绝、重复头拒绝、Secure cookie 登录 / 注销和错误配置不创建数据库。完整后端回归仍需运行 `python3 -m unittest discover -s server/tests -v`。Caddy TLS、云安全组、主机持久盘和真实公网访问必须在选定部署后另行验收。
