# Local Trade Workspace API

Python 标准库实现的可运行本地业务服务；数据库为 SQLite。所有记录读写经过服务端会话、租户、法人、角色能力和记录范围校验。账号由配置或管理员 CLI 管理，没有公开注册接口。

## 启动

从 `trade-order-system/` 目录运行（Python 3.10+，建议 3.12）：

```sh
python3 -m server.cli init --config server/config.example.json
python3 -m server.app --port 3087
```

服务仅监听 `127.0.0.1`，浏览器打开 `http://127.0.0.1:3087/`。默认运行目录为 `server/runtime/`，已加入 `server/.gitignore`。目录强制 0700，数据库和随机演示口令文件强制 0600；不打印口令。

当前项目位于 SMB 网络挂载卷；它的 chmod 属性缓存可能短暂报告所请求权限，但实际文件仍显示 0777，而且不能假设提供本地 SQLite 锁和持久性。服务显式拒绝网络挂载运行目录，在无法落实权限时同样拒绝创建敏感数据库。此环境使用私有本机目录：

```sh
python3 -m server.cli --runtime /private/tmp/trade-order-runtime init --config server/config.example.json
python3 -m server.app --runtime /private/tmp/trade-order-runtime --port 3087
```

`/private/tmp` 适合本地演示；系统清理可能删除该目录。长期使用应指定支持权限的持久目录并建立独立备份，不应依赖临时目录作为唯一数据库副本。也可设置 `TRADE_RUNTIME_DIR`。

首次初始化会为配置中未指定密码的新账号生成随机密码，保存到私有 `runtime/demo-credentials.json`。文件只用于本地演示交付，含 Grandware Demo 和第二虚拟租户的独立凭据；不复用归档前端公开哈希。重新应用没有 password 字段的配置保留原有密码。

## 账号与租户配置

`config.example.json` 包含 Grandware Demo 与独立 Example Trading Demo 两租户。Grandware 保留历史 U00x 和 CO-xx 标识，便于已归档订单归属匹配；用户密码全部重新生成。未授权/未知账号归属和无 companyId 的旧记录不会向普通角色返回。管理员可检查隔离中的旧数据，但写入必须补齐有效法人。

```sh
python3 -m server.cli --runtime /private/tmp/trade-order-runtime configure --config /path/to/private-config.json
python3 -m server.cli --runtime /private/tmp/trade-order-runtime set-password --tenant grandware --user U001
```

CLI 重置密码采用交互式输入；口令不进入命令行参数或日志。配置 `disabled:true` 或从该租户配置中移除账号，都会立即撤销旧会话；配置提供新 password 也会撤销会话。账号/角色配置存储与业务快照分开，恢复旧业务版本不会恢复旧账号权限。

角色配置字段：`scope` 为 `self`、`team`、`tenant`；`permissions` 为能力数组或布尔 map；`pages` 为前端页面名数组；可设置 `baseRole` 与 `collections`。`readScopes` 可按集合设置 `self/team/entities/tenant` 读取范围，仍先校验租户与法人授权。能力包括 `read/create/edit/delete/assign/finance.read/finance.write/rates.write/snapshots.read/snapshots.restore/accounts.configure`。所有账号（包括 admin/finance）需要显式个人 `visibleCompanyIds` 或有明确法人授权的团队，缺配置默认拒绝访问。scope=tenant 只决定已授权法人的记录范围，不自动授予全部法人；示例管理员与财务显式列出全部主体。

默认 admin 为租户全部管理能力；finance 可查看/编辑财务、管理汇率，禁止删除与快照读取/恢复；manager 为团队范围，salesperson/document 为自己创建或负责的记录范围。后三类无财务权限；document 无删除。不同客户可以更改模板，但权限最终由服务端判断。

五模板默认 `readScopes: {"factories":"entities"}`，工厂在用户已授权的法人内共享读取；工厂成本与银行字段仍按财务权限隐藏，修改与删除继续使用原 self/team/tenant 范围。已知模板允许部分覆盖，自定义角色必须明确 scope；pages 和 readScopes 在配置阶段验证，并随 session.user 返回。已有数据库需要重新应用不含 password 的配置才能更新模板设置，重启本身不会改配置。

## 归档数据导入

```sh
python3 -m server.cli --runtime /private/tmp/trade-order-runtime import /path/to/business-export.json --tenant grandware --expected-version 0
```

也可在首次 init 时传 `--import /path/to/business-export.json --tenant grandware`。CLI 只读取源文件，不改源件、不调用线上数据库。支持顶层 `{data,exchangeRates,rateMetas}`、CloudBase 导出的 `{payload,...}` 或业务集合对象。导入保留历史金额、ID、墓碑和时间，不自动重算；导入本身生成新 revision、快照与审计。再次导入要求显式 expected-version；版本不符拒绝，不自动覆盖。

## API 合同

GET 返回值不增加外层 data wrapper；所有 POST 必须使用同源 Origin。除了无需正文的 logout，POST 使用 JSON Content-Type。

| 请求 | 返回/说明 |
| --- | --- |
| `POST /api/login` `{tenantId,username,password}` | `{ok,user}`；设置随机 `trade_session` Cookie，HttpOnly、SameSite=Strict，8 小时有效 |
| `GET /api/session` | `{user,users,teams,companies,roles,tenant}`；不返回密码/摘要；普通账号仅自己及同团队安全名录 |
| `POST /api/logout` | `{ok:true}`；撤销当前会话并清 Cookie |
| `GET /api/data` | `{data,exchangeRates,rateMetas,meta}`；record/字段裁剪后的当前数据 |
| `GET /api/meta` | `{ok:true,meta:{version,updatedAt,updatedBy}}` |
| `POST /api/changes` | `{expectedVersion,changes:[{collection,id,value} 或 {collection,id,deleted:true}],exchangeRates?,rateMetas?}` → `{ok,meta,snapshotId}` |
| `GET /api/snapshots` | `{snapshots:[{id,version,createdAt,createdBy,kind}]}`；只返回当前租户元数据，默认仅 admin |
| `POST /api/restore` `{snapshotId,expectedVersion}` | `{ok,meta,snapshotId}`；恢复为新的 revision，禁止跨租户 |

`value` 是字段 patch：省略字段保留原值；contacts 等公开数组整体替换。新记录 value 提供整条数据。新记录创建人和更新时间由服务器写入；客户端不能转租户或改创建来源。id 可使用稳定 UUID，不使用可修改操作单号当数据库主键；兼容归档旧 id。技术 ID（记录 id、嵌套联系人 id、factoryId）限定 `\w`、点、冒号、短横线，长度 1–200，包含中文字母数字及下划线；拒绝引号、反斜杠、控制符等，导入同样校验且不改源件。显示名称和业务操作号保留自由文本，前端仍须正确 HTML 转义。操作单号在租户+法人范围内 trim/case-insensitive 唯一，包括软删除记录，不自动复用。

同一批次包含新关联记录时，提交顺序为 customers → factories → orders → shipments → invoices；服务端在操作发生时验证引用，不接受指向尚未创建或无权限的对象。

没有 `finance.write` 的账号不能通过顶层字段、嵌套 factories 或其他对象改成本、利润、银行及收付款数据。读取端递归移除敏感字段，公开工厂数组变更按唯一 factoryId 保留隐藏成本及隐藏嵌套对象；重复 factoryId 拒绝。多产品重复工厂行需要后续稳定明细 ID 设计。移除含财务字段的工厂条目会拒绝，需交给有权限的账号。含隐藏字段的对象不能替换成 null/字符串等；未知含财务数据数组不能由普通账号重排或替换，避免按位置挂错隐藏金额。

新建/变更订单关联的客户与工厂、出运关联订单必须存在、可读取且属于订单同一法人；仅变更订单法人时也会重查全部关联。工厂共享读不会允许跨法人引用，未来跨法人共享须显式设计映射。已有出运或发票历史的订单不能直接切换法人，返回 `LEGAL_ENTITY_MIGRATION_REQUIRED`；需要后续专门迁移事务。

## 并发、快照和金额

SQLite `BEGIN IMMEDIATE` 原子校验整租户 revision 后提交整个 changes 批次、汇率、快照和审计。一个操作失败整批回滚。两个用户基于同一版本保存，至多一个成功；另一个收到 HTTP 409：

```json
{"error":"Data changed; reload and review your pending changes","code":"VERSION_CONFLICT","latestVersion":2}
```

客户端保留草稿并让用户重新检查，不得自动改 expectedVersion 重试覆盖。此版本采用租户级 CAS，不同记录的同时编辑也可能冲突；后续可升级逐记录版本，但不会用 last-writer-wins 代替冲突检查。

每次成功写入/导入/恢复生成完整内部快照及审计。软删除保留记录，删除订单同步标记关联出运/单证。普通 patch 不能复活已删除记录；快照恢复需要当前管理员能力、租户全部法人授权和正确当前 revision，恢复生成新历史，不篡改旧快照。仅被授权部分法人的管理员不能执行整租户恢复。目前保留全部快照，列表返回最近 200 条；生产需增加容量/留存和离线备份策略。

法人配置 `profitPolicy=grandware-v40`、`settlementCurrency=CNY/USD`，保留 v40 业务字段的实际含义。国内公式：`orderAmountUSD * rate - factoryCostRMB - freightCostUSD - otherCostUSD + factoryCostRMB / 1.13 * insuranceCostUSD / 100`，其中 freight/other 的旧字段实际是人民币，insurance 实际是退税百分比；HK 为 `orderAmountUSD - factoryCostRMB - otherCostUSD`。服务器在原始财务输入变化时派生金额/利润，不采信客户端派生字段；状态/备注、读取、导入、汇率设置本身、保留各工厂金额的数组顺序变更均不重算历史。跨币种规范字段重命名与通用税务政策仍属后续模型工作。

## 验证与边界

```sh
python3 -m unittest server.tests.test_service -v
```

测试使用临时私有数据库与真实 loopback HTTP，涵盖两个租户、法人/角色/字段、工厂共享读与写删边界、猜测/跨法人关联 ID、并发 CAS、批次回滚、软删/单号唯一、全租户恢复授权、不可伪造/过期/禁用会话、服务端登录锁定、配置角色、密码更改撤会话、嵌套保护容器替换/数组重排、重复工厂明细、历史利润保留、静态允许清单和跨 Origin/Host 拒绝。没有调用生产服务。

2026-10-11 最终运行：42 项通过，耗时 6.910 秒；另有独立增量审查 12 个合成 SQLite 场景通过。技术 ID 注入、恶意批次回滚、联系人/工厂嵌套 ID 与只读源件导入拒绝均有回归。

静态服务仅允许 index/manifest、css、js 运行模块、assets 图片、两本地 vendor 文件；server/runtime、配置、文档、测试、云函数、SDK、目录列表和路径穿越都拒绝。默认 Cookie 未设置 Secure，因为服务只支持 loopback HTTP；公网发布需要 HTTPS、Secure Cookie、正式反向代理与运维控制。本轮交付 SQLite 本地适配；企业本地 SQL/云数据库驱动、计费和注册产品尚未实现，不能据此声明通用商业部署已完成。
