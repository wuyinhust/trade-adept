# Tradept 与 ERPNext 统一系统（隔离本地测试）

Tradept 的订单界面通过固定站点网关调用 `tradept_core`，账号、权限、业务单据、审计、并发版本和快照均保存在 Frappe/MariaDB。没有 SQLite 业务库或跨库 outbox。ERPNext 16.32.3 / Frappe 16.31.0 使用既有隔离 Lima VM；数据库与 Redis 不发布宿主端口。原 Compose 结构来自官方 [frappe_docker](https://github.com/frappe/frappe_docker)，MIT 许可保留在 `FRAPPE-DOCKER-LICENSE`，ERPNext 为 GPL-3.0。

Grandware 在 `grandware.test`，虚构 Example 在既有 `frontend`，二者拥有独立站点、数据库和账号。原 Example 已提交的 SO、两 PO、DN、PE 与总账保留；迁移只绑定原单据的稳定来源标识，不重复提交。Grandware 原始历史资料在本地导入为历史订单，不根据汇总金额生成商品、交付或财务流水。来源文件、原 SQLite 和原 frontend 的完整备份保存在 APFS 私有目录；恢复路径见 [RECOVERY.md](RECOVERY.md)。当前公网测试环境仍是旧独立版本，没有接入此本地业务库。

## 入口与私有配置

- Tradept 网关：`http://127.0.0.1:3087/`，默认登录使用已配置账号。可选原生注册不自动授予租户或业务权限，需管理员另行配置。
- Example Native Desk：`http://127.0.0.1:3088/`；Grandware Native Desk：`http://grandware.localhost:3088/`。这是同一业务库的原生管理入口，管理员凭据只在本机私有配置中。
- 网关路由配置：私有 runtime 中 `frappe-sites.json`，格式见 [config.example.json](config.example.json)，文件 `0600`、目录 `0700`。
- Nginx 固定 Host/site 组合仅允许 loopback 的 Example 与 Grandware；未知 Host、未知站点、Grandware 专属 Host 的冲突站点头均返回404，资产路径也受同一守卫保护。两站原生 SID 已实际双向验证跨站403。浏览器不能自行指定 ERP URL、DocType 或集成 token。

`FRAPPE_SITE_NAME_HEADER: "$$tradept_site_name"` 是 Compose 对字面 `$` 的转义。配套 [tradept-sites.map.conf](tradept-sites.map.conf) 与 [tradept-frappe-nginx.conf.template](tradept-frappe-nginx.conf.template) 必须与 Compose 一起复制。模板保留官方 Nginx locations，新增站点守卫并保留原 Host 端口。两个租户不能指向同一 Frappe site。

Grandware 四家原公司已使用既有科目表，通过官方 setup 完成标志进入 Desk；没有重跑向导或建重复公司。两家中国主体使用 CNY，两家香港主体使用 USD。Grandware 目前仍是历史资料导入与管理演示：默认银行账户尚未配置，未根据历史金额创建 SKU、订单或总账，也未验收其真实会计工作流。

## 固定自定义镜像

[Unified.Containerfile](Unified.Containerfile) 在已核验的官方 ERPNext ARM64 digest 上安装纯源码 `tradept_core`，没有凭据或业务数据。应用保存在镜像 `/home/frappe/frappe-bench/apps/tradept_core`，站点、日志、数据库仍使用原 volumes。容器重建后应用不会丢失。修改 app 后重建镜像并对两个站点 migrate，不能把临时 `docker cp` 当作最终部署。

[unified_build.py](unified_build.py) 仅复制 Python 源码、`modules.txt`、`pyproject.toml`，拒绝符号链接；离线 wheels 使用固定 SHA256。当前可信 wheels 由本机官方 bundled Python 已安装分发包的 RECORD 校验后重打包，原始证据在私有构建目录；无需关闭 TLS 或向全局 Python 安装依赖。

宿主准备全新构建目录后，通过 Lima 的 SSH/SCP 复制至 guest 私有目录：

```sh
python3 integrations/erpnext/unified_build.py --app integrations/frappe_app --wheels /private/offline-wheels --output /private/new-build-context
```

guest 内使用缓存的同一官方 base，构建不需要网络：

```sh
sudo docker build --network=none --pull=false --build-arg BASE_IMAGE=tradept-erpnext-base:16.32.3 -f Unified.Containerfile -t tradept-erpnext-unified:0.2.0 .
```

私有 `unified-image.env` 仅设置 `TRADEPT_ERPNEXT_IMAGE=tradept-erpnext-unified:0.2.0`。复用原 project、密码、DB/Redis 和 volumes：

```sh
sudo docker compose -p tradept-erp --env-file /home/wangyao.guest/trade-private/erpnext.env --env-file /home/wangyao.guest/trade-private/unified-image.env -f /home/wangyao.guest/trade-private/compose-unified.yaml up -d --no-deps backend frontend queue-long queue-short scheduler websocket
```

不得执行 `down -v`。`sites/apps.txt` 需要包含 `tradept_core`；初始化工具会在两个站点安装 app，已有站点不重新建库。

## 管理员迁移与验收

[unified_site_ops.py](unified_site_ops.py) 在容器内运行。私有参数通过 stdin JSON 或容器私有文件传递，不把密码放在命令行。输出仅包括结果、数量、版本、来源 SHA256；失败仅输出异常类型和代码行号，事务回滚后保留原数据。

操作顺序为：完整备份 → 安装 app → 新建 Grandware 独立站点 → 每站配置一个租户 → 按来源 SHA256 初始导入 → Example 显式绑定已有提交单据 → 真实权限/并发/原生单据回读 → 禁用旧集成账号。旧 `trade.integration@example.invalid` 已禁用，APIkey/secret和该用户旧会话已撤销；原私有配置仅作为历史备份。首次导入不能覆盖已使用的 workspace；再次执行同一来源会返回已导入。原始来源的并发版本与新数据库实例分别记录，不能重放旧 SQLite 草稿。

原 Example 来源 revision 9 的历史已收金额为 0；绑定现存 PE 后，新原生投影必须如实回读已收 USD1000，并保留原历史快照。原始 SO1000、PO420/280、DN100、PE1000、借贷各1000是保留基线，不是本轮重新生成的收入。

管理员后台直接修改 native master 会在同一事务更新审计、快照和并发版本。旧版本保存应返回 409。产品账号使用 Website User 和 Tradept 配置权限；标准 REST、业务 RPC 与跨租户入口需真实负向验收，不能仅依据界面隐藏字段判断权限。

本地已用虚构 Example 验证原生管理员保存客户名称使 workspace 32→33，普通 API 可见新名称且旧版本保存409；恢复名称至34后，标准 Payment Entry 对本轮新 PO 记录 USD10预付款，工厂付款投影与 PO.advance_paid 同步为10。该记录仅为隔离账务测试，没有实际银行转账。原 SO/2PO/DN/PE/2GL 的财务指纹仍保持迁移前基线。

历史 SQLite 的提交验收脚本、outbox worker 和广泛 API token bootstrap 已归档并从当前源码删除。后续企业部署必须使用明确法人币种、会计科目和真实 SKU 明细；汇总历史订单不能直接充当会计凭证。测试资源与恢复工具见 [RECOVERY.md](RECOVERY.md)。
