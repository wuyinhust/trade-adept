# Tradept 统一业务网关

Tradept 保留现有工作台，Frappe/ERPNext 是唯一在线业务数据库和账号系统。网关只提供同源静态文件、固定站点路由和协议适配；没有 SQLite、账号口令数据库、订单镜像、同步队列或断线写入备用库。

## 启动

先按 [隔离部署说明](../integrations/erpnext/README.md) 安装 ERPNext 与 `tradept_core`，建立独立租户站点并完成迁移核验。每个租户对应独立 site/database；Grandware 的四个公司在同一个租户站点内。

```sh
cp server/frappe-sites.example.json /private/tmp/tradept-frappe-sites.json
openssl rand -hex 32
# 将输出粘贴到该租户的 gatewayHmacKey，并把同一值写入对应 Frappe 站点：
bench --site grandware.test set-config tradept_gateway_hmac_key '<该租户的 64 位十六进制密钥>'
# 每个租户重新运行 openssl rand -hex 32，密钥不得共用。
chmod 600 /private/tmp/tradept-frappe-sites.json
python3 -m server.cli --runtime /private/tmp/tradept-gateway init --sites /private/tmp/tradept-frappe-sites.json
python3 -m server.app --runtime /private/tmp/tradept-gateway --port 3087
```

示例路由把 Grandware 指向 `grandware.test`、Example 指向 `frontend`，均由回环端口 3088 接入。示例中的密钥是故意不可用的占位文本，必须替换。网关配置中的 `gatewayHmacKey` 与站点 `site_config.json` 中的 `tradept_gateway_hmac_key` 必须逐租户一一对应；缺失、弱占位值、跨租户复用或两端不一致都会关闭实时汇率财务写入。轮换时同时更新两端并重启网关，避免新旧密钥窗口。企业本地部署或云端部署可指定自己的固定 HTTPS Frappe 地址。浏览器不能提交数据库地址、site、API 密钥或任意 DocType。网络共享卷只保存源码；路由和签名密钥放在支持私有权限的持久本地盘，目录 0700、文件 0600。`/private/tmp` 只适合临时演示。

账号、密码、密码重置、启停和会话由原生 User 管理。迁移器可按审核后的私有配置导入原有账号，工作台角色和公司范围只是原生用户的产品授权配置。企业默认由管理员配置账号。可选原生自助注册不会自动加入企业或获得业务权限；必须由管理员批准并赋予公司范围。

## API

所有写请求要求同源 Origin；Cookie 为 HttpOnly、SameSite=Strict。公网模式须配置 `--public-origin https://固定域名`，Cookie 使用 Secure；只信任固定 Host，不信任客户端 forwarded headers。每个写请求向原生会话取得 CSRF token，整个变更批次在一次 Frappe 事务中执行。需要当前汇率的财务写入由网关附加 3 分钟 HMAC 断言，绑定站点、租户、原生 SID、action、版本、幂等键、完整 payload 哈希、完整汇率快照和随机 nonce；Frappe 在任何金额派生或单据转换之前验签。浏览器即使持有自己的 Frappe SID/CSRF 也不能伪造实时汇率。

| 请求 | 用途 |
| --- | --- |
| POST /api/login | `{tenantId,username,password}`，原生登录后返回安全用户信息 |
| POST /api/logout | 原生注销并清除工作台 Cookie |
| GET /api/session | 当前原生用户的角色、公司和工作区配置 |
| GET /api/data | 授权记录、授权字段、历史兼容汇率及当前 revision |
| GET /api/exchange-rate | 当前 USD/CNY 行情、供应商发布时间、网关取得时间及下次发布时间 |
| GET /api/meta | 当前 revision |
| POST /api/changes | `{expectedVersion,changes,exchangeRates?,rateMetas?}`，原子补丁保存 |
| GET /api/snapshots | 授权管理员的历史快照元数据 |
| POST /api/restore | `{expectedVersion,snapshotId}`，受限恢复并产生新 revision |
| GET /api/backend/status | 当前授权订单阶段和同库原生单据 |
| POST /api/orders/convert | `{expectedVersion,orderId,idempotencyKey}`，网关注入当前行情并生成冻结汇率的 SO/PO 草稿 |
| POST /api/orders/submit | 显式提交已有原生订单 |
| POST /api/orders/payment | 原生收款，要求版本、幂等键和明确金额/凭证信息 |
| POST /api/orders/cancel | 原生取消，受已提交收款/物流/发票依赖保护 |

原 `/api/erpnext/status` 只保留读取兼容别名；原队列接口已关闭。网关转发原生 409，返回当前 revision，浏览器保留待保存草稿，不能自动提升版本覆盖别人的保存。服务不可用时返回 503，不能退回旧数据源。原生管理员/导入的业务修改也在同一提交事务中更新 revision，避免工作台的旧副本覆盖原生后台新值。

## 数据与迁移

客户、供应商、联系人和公司使用原生对象。当前 USD/CNY 报价由网关读取 ExchangeRate-API：优先使用带供应商发布时间与下次发布时间的 v6 接口，v4 为备用；同一发布周期只访问一次上游，到期未发布或请求失败时至少退避 5 分钟。浏览器只访问同源鉴权接口，实时值不写入 `Currency Exchange`，也不触发业务 revision 或快照。设置页可以继续展示并明确标记 stale 缓存，但 stale 行情会以 `503 LIVE_RATE_STALE` 拒绝新报价计算和正式单据转换。

先建订单后补明细的流程使用 `Trade Order Brief`；真实商品、供应商、数量、币种和价格完善后，网关在转换请求中注入当次服务端行情，原生 Sales Order / Purchase Order 把该值冻结在 `conversion_rate`，审计同时保留来源与发布时间。后续行情变化不改写已有正式单据。历史导入的汇率只用于还原历史事实，不作为当前行情。转换后金额、付款和明细来源于原生单据。外贸港口、生产计划和历史参考等缺少原生对应的内容使用最小扩展。

Grandware 的 Excel 历史数据导入为有明确来源的历史记录；保留 ID、软删除、原始金额和关联。没有真实逐笔付款及商品明细时，不伪造商品、收付款或总账。Excel 导入明确选择历史参考或新业务；更新按技术 ID 或同法人操作单号匹配，空列不清空已有值。预览和表单修改使用同一权限、验证、CAS 和审计流程。已有关联原生单据的工作区禁止通过 JSON 快照倒退财务记录；应使用原生取消、修订和对账流程。

## 验证范围

```sh
python3 -m unittest discover -s server/tests -v
```

这些测试验证网关协议、同源边界、签名防篡改、原生会话撤销、CSRF、冲突透传和不可用时关闭访问，不替代真实 Frappe/ERPNext 的迁移及业务验收。真实验收另保存来源哈希、记录比较、双租户权限、并发回滚、原生收付款和重启持久化证据。历史 0.1.x 验收报告属于归档版本，不能用于证明新版。
