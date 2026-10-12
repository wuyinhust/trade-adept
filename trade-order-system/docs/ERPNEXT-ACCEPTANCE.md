# ERPNext 接入验收记录

2026-10-12：隔离本地 ERPNext 的真实业务链路验收通过。证据为 [实际回读报告](erpnext-real-acceptance.json)，不是模拟结果或生产部署。只使用虚构租户 `example-company`、法人 `EX-01`、订单 `EX-ORDER-DEMO`；Grandware 的真实数据没有发送给 ERPNext。

## 真实单据与下游证据

| 标准单据 | ERPNext 编号 | 实际回读结果 |
| --- | --- | --- |
| Customer | Example Buyer Demo | 客户公司名与 Trade 的 `customer.company` 一致 |
| Supplier | Example Supplier Demo / Example Supplier Two Demo | 两个独立供应商，采购归属与原始明细一致 |
| Sales Order | SAL-ORD-2026-00001 | 已提交，USD 1000；客户 PO 为 DEMO-PO-001 |
| Purchase Order | PUR-ORD-2026-00001 | 已提交，USD 420 |
| Purchase Order | PUR-ORD-2026-00002 | 已提交，USD 280 |
| Delivery Note | MAT-DN-2026-00001 | 已提交，数量 100；销售订单实际交付率 100% |
| Payment Entry | ACC-PAY-2026-00001 | 已提交，实际收到 USD 1000；销售订单预收 USD 1000 |
| GL Entry | ACC-PAY-2026-00001 对应两条分录 | 借 Trade Demo Bank USD 1000、贷 Debtors USD 1000，总账平衡 |

先使用产品 outbox/有限批次 worker 创建 Customer、两个 Supplier、SO 与两个 PO 草稿，并独立回读 USD 1000/420/280。随后专门的虚构验收脚本通过标准 API 提交上述单据、创建 DN/PE 并回读总账。再次执行验收复用了相同单据编号，没有新建第二组销售、采购、出运或收款单据。

脚本逐字比较执行前后的 Example 业务 payload 与 revision，同时比较其他租户的 revision/payload SHA。Example 保持 revision 9、Trade `paidAmountUSD=0`；Grandware 保持 revision 1。另与同步前单独保存的 Grandware SHA 比较一致。脚本仅刷新 ERP links 的单据元数据，没有反向修改 Trade 业务金额、出运或收款状态。

## 实际运行环境

- 官方 Lima 2.2.1，Ubuntu 24.04 ARM64；4 CPU、4 GiB RAM、20 GiB 稀疏磁盘，无宿主数据挂载。
- Ubuntu 官方签名包：Docker Engine 29.1.3、Docker Compose 2.40.3；隔离 VM 内 rootful `overlay2`。
- 官方 ERPNext 16.32.3 / Frappe 16.31.0；ARM64 镜像固定 `sha256:a9dea1cc498aa08010eb3567f1808c7bed98e4b9d17dcbd4265791c9ad00971e`。MariaDB 11.8、Redis 6.2-alpine 使用独立 volumes。
- `create-site` 与 configurator 实际 exit 0，数据库 healthy，各服务运行，宿主 `http://127.0.0.1:3088/api/method/ping` 实际返回 200。只发布 loopback 3088；数据库和 Redis 无宿主端口。
- 私有 APFS 的凭据目录 0700、文件 0600；独立 Frappe site `frontend` 仅绑定 Example，集成用户使用标准销售、采购、库存和财务角色，没有 System Manager。
- 验收后宿主可用约 9.9 GiB、swap 951 MiB；guest 使用约 6.2 GiB/19 GiB，内存可用约 2.7 GiB。低于 4 GiB 宿主可用空间或 swap 快速增长时停止本任务 VM，并按 [恢复指引](../integrations/erpnext/RECOVERY.md) 处理。

实际执行发现并修复两个部署缺口：Customer/Supplier 创建分别需要 Sales Master Manager/Purchase Master Manager；Customer 不能选择分组树根节点。bootstrap 现建立明确的虚构叶子客户组、供应商组和区域，并自检所需创建/总账读取权限。公司缺少这些明确映射时，队列在任何 ERP 写入前返回 `MASTER_DATA_MAPPING_REQUIRED`。

## 实现与回归验证

接入为持久单向 outbox：SQLite 业务提交与入队同一事务，远端 ERP 提交是独立事务。网络或部分失败保留已创建单据的唯一外部 ID，重试恢复原单据，不声称跨数据库原子提交。

财务角色显式排队，服务端校验租户、法人、记录和来源 revision；浏览器无法指定 ERP URL、site、DocType 或密钥。商品映射使用原订单 `erpItems` 和原保存/CAS 流程，稳定行 ID，SKU/数量/销售与采购单价/供应商必填。来源两种总额以及 ERP 实际返回的币种、`grand_total` 都必须一致。

修改前检查上次同步 `modified`，PUT 带相同时间。ERP 外部编辑、已提交单据、有采购引用的销售行增删或供应商迁移会阻断静默覆盖。排队后及同步结束再次核对来源；旧快照不会执行或被标成成功。存在 ERP job/link 后，整库恢复与整体导入被阻断，避免本地回滚后重放旧单据。状态读取按持久化的精确 `order_id` 授权，不通过字符串前缀猜测所有权。

2026-10-12 最终全量后端回归：`python3 -m unittest discover -s server/tests -v`，117 项通过，其中 bridge 32 项。覆盖事务回滚、财务权限、记录/法人/租户隔离、分组映射缺失、真实模型字段、历史成本币种、金额偏差、来源变化、外部修改、部分提交/丢响应重试、唯一外部 ID、loopback 禁用全局代理及拒绝携带密钥跟随 HTTP redirect。

## 本轮交付边界

常规界面交付商品明细配置、显式排队、SO/PO 草稿同步和状态查询。`server.erpnext_cli run --limit N` 是管理员运行的有限批次 worker；点击排队后需要管理员执行该命令，未交付常驻轮询或定时调度。界面展示 bridge 最近确认的单据元数据，不能当作 ERP 外部修改的实时回读。

虚构验收中的 DN/PE 提交证明标准 ERP 链路可用，产品界面尚未交付正式出运/财务提交审批、取消/amend、双向回写、跨币种采购、库存迁移或税费模板配置。ERP 中示例实际收到 USD 1000，Trade 业务已收金额仍为 0，两者不能混同。Grandware 未配置 ERPNext，不能套用虚构 EX-01 对历史成本字段的 USD 兼容映射。

此前 2026-10-11 的空测试 VM 因宿主资源不足停止；后续现场检查其临时实例目录已经不存在，未声称主动删除旧磁盘。当前环境重新建立在持久 APFS 目录，恢复命令与固定镜像校验值见 [RECOVERY](../integrations/erpnext/RECOVERY.md)。

官方依据：[Frappe REST API](https://docs.frappe.io/framework/user/en/api/rest)、[固定版本 Sales Order](https://github.com/frappe/erpnext/blob/v16.32.3/erpnext/selling/doctype/sales_order/sales_order.py)、[固定版本 Payment Entry](https://github.com/frappe/erpnext/blob/v16.32.3/erpnext/accounts/doctype/payment_entry/payment_entry.py)、[官方容器部署](https://github.com/frappe/frappe_docker/blob/main/pwd.yml)。
