# 发布前独立代码审查

审查日期：2026-10-11，增补于 2026-10-12。范围：ERPNext 标准单据映射、同步队列与来源一致性、财务与租户权限、快照/覆盖导入限制、ERP 映射界面保存流程。本审查使用临时 SQLite、虚构业务记录及 FakeFrappe；未读取客户数据库或生产环境。

## 当前结论

本次审查发现的 P1 已修复；当前审查范围内没有仍未关闭的 P0/P1。最终完整后端回归 117 项全部通过（24.482 秒），前端 14 套 636 项通过。下表列出的修复已由针对性回归或源代码检查确认；真实浏览器和隔离 ERP 的执行证据单独记录。

2026-10-12 增补：旧成本字段不能仅凭 USD 结算主体就解释成 USD。ERP 公司映射现在必须显式声明 `legacyPurchaseCostCurrency=USD` 才接受兼容的旧成本字段；缺失或其他币种均在远端写入前阻断。增加三项回归后完整后端为 **112 项全部通过**（Service/HTTP 50、Routes 23、Bridge 27、Validation 12），23.543 秒，0 失败/错误/跳过。实际 ERP 运行结果仍独立记录。

最后新增的传输与金额保护完成独立只读复核。携带密钥的请求不跟随重定向，loopback 不继承系统代理；真实本机 HTTP 回归确认重定向目标没有收到请求。ERP 返回的销售/采购 `grand_total`、币种、缺失总额及非有限数值均必须通过校验，失败置为 `blocked`，已创建的关联先保留。5 项定向回归及独立临时故障注入确认显式重试复用原 ERP 单据 ID。该复核未修改源码，也未操作真实 ERP。

真实 ERPNext 16.32.3 验收修复了两个静态测试未能揭示的配置缺口：Sales/Purchase Manager 不具备主数据创建权限，受限集成用户补充 Sales/Purchase Master Manager；客户/供应商分类不可选树形根节点，私有公司映射必须明确叶子分类和区域。初始化检查所需权限，排队缺映射即阻断且远端零写入。官方依据为固定版本 [Customer](https://github.com/frappe/erpnext/blob/v16.32.3/erpnext/selling/doctype/customer/customer.json) 和 [Supplier](https://github.com/frappe/erpnext/blob/v16.32.3/erpnext/buying/doctype/supplier/supplier.json) 权限与树形分类规则。真实链路已通过，单据及总账回读见 [验收 JSON](erpnext-real-acceptance.json)。

### 已关闭 P1：ERP 单据来源 ID 的字符串前缀可绕过订单范围

- 位置：`server/erpnext.py::status`；`server/store.py::erp_status`。
- 原因：`source_id.split('::', 1)[0]` 被用作所有 DocType 的订单授权依据。合法技术 ID 允许冒号，且 Customer/Supplier 与订单使用不同 ID 空间。
- 可执行复现：受限财务账号仅授权订单 `scoped-order`，同租户另有未授权订单 `scoped-order::hidden`。关联表包含该隐藏订单的 Sales Order 和 Purchase Order，以及 source ID 恰好为 `scoped-order` 的无关 Customer/Supplier。请求 `GET /api/erpnext/status` 会返回四张未授权单据。
- 修复前证据：`server/tests/test_erpnext_routes.py::test_status_document_sources_cannot_alias_authorized_order_ids` 通过真实本地 HTTP 复现，新增返回 `UNAUTHORIZED-SO`、`UNAUTHORIZED-PO`、`UNRELATED-CUSTOMER`、`UNRELATED-SUPPLIER`。
- 当前修复：`erp_links` 增加明确 `order_id`，交易单据 `upsert` 必须传入来源订单，并拒绝现有关联的来源碰撞；`status` 用来源订单精确匹配可见订单集。旧关联缺少来源时保持隐藏并要求人工核对；Customer/Supplier 无订单来源，不能以同名 ID 获得授权。
- 修复后验收：上述真实 HTTP 回归已通过；授权订单的 SO/PO 仍可见，隐藏订单、同名客户/供应商，以及已授权订单对应但缺来源的旧关联均不返回。

## 已检查及关闭的问题

| 场景                                       | 当前实现与证据                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 客户名称与客户采购单号映射                 | `prepare_order`、`process_order` 使用客户 `company`（兼容旧 `name`）、订单 `customerOrderNo`（兼容旧 `poNumber`）；交期取 `expectedShipDate`，未配置有效交期时在 ERP 写入前阻断。                                                                                                                                   |
| 一张销售单关联多家工厂采购单               | `process_order` 为每家供应商创建独立 Purchase Order，并以 SO 子表实际 `name` 写入 `sales_order_item`；SO 明细保留 `custom_trade_line_id` 和 `custom_trade_supplier_id`。`integrations/erpnext/bootstrap.py` 安装这两个字段。                                                                                        |
| 已同步明细换供应商导致旧 PO 与新 PO 累加   | `guard_supplier_ownership` 在任何后续远程写入之前检查 SO 的明细/供应商归属及历史 PO 关联，拒绝改变已关联归属；`test_changing_line_supplier_blocks_before_duplicate_purchase_is_created` 覆盖该场景。                                                                                                                |
| 重排明细破坏 PO 子表引用                   | SO 更新保留已有子表 `name`；`test_reordering_lines_preserves_existing_purchase_references` 验证重排后 PO 引用仍然正确。                                                                                                                                                                                             |
| 多供应商同步中途失败与重试                 | 稳定外部 ID 和本地关联保留已完成单据；`test_lost_create_response_recovers_same_external_id`、`test_second_supplier_failure_retries_partial_purchase_links` 验证重试不重复采购。SQLite 与 ERP 分别提交，失败时已创建 ERP 单据仍保留供核对。                                                                          |
| 队列使用浏览器提供的外部地址/凭据/单据内容 | `/api/erpnext/queue` 只采纳订单 ID 与 expectedVersion，从当前授权数据库快照准备内容；配置来自私有 `erpnext.json`。Routes 测试覆盖外部参数不采纳、0600、来源事务回滚、CAS、同版本幂等及租户隔离。                                                                                                                    |
| 来源在排队后或网络写入中发生变化           | Worker 在远程写入前后比较完整准备内容；分别返回 `SOURCE_CHANGED` 和 `SOURCE_CHANGED_DURING_SYNC`，不把旧内容标记为同步成功。ERP 已创建的单据保持可审计。                                                                                                                                                            |
| ERP 被其他人修改/提交                      | `upsert` 比较远程 `modified`；不一致则 `ERP_MODIFIED` 阻断。修改已提交单据需显式取消/修订；FakeFrappe 测试验证没有静默覆盖，真实 Frappe 并发修改仍需部署验收。                                                                                                                                                      |
| 非财务读取/修改采购映射                    | `erpItems` 整体及 `purchaseRate` 为财务字段；Routes 测试验证非财务无法读取、修改、清空或置 null，finance.read 无法写入；被拒操作完整保留 SQLite 状态。                                                                                                                                                              |
| 跨法人供应商与 Grandware 历史关联兼容      | 新客户/工厂关联、显式主体变更、ERP 明细保存和排队均严格检查法人与可见范围。对原订单已关联的历史跨主体客户/工厂，保留 ID 的公开备注/生产信息更新可以继续，不新增跨主体授权；完整虚构场景验证工厂数量/验货日期更新后金额、预付、成本、历史利润及 ERP 明细保持。改变关联或主体、排队旧跨主体工厂/客户均 403 原子拒绝。 |
| 管理员创建出运后销售/单证无法继续工作      | `record_allowed` 对 shipment/invoice 继承父订单分配，同时保留 collection、tenant、company 权限边界；新增 Service 测试验证销售及单证可编辑，同公司未分配人员和另一租户被拒，已删父订单的遗留子记录被拒。                                                                                                             |
| 已同步 ERP 后通过快照/覆盖导入回退本地数据 | `has_jobs` 同时检查 outbox 和历史 ERP links；恢复/覆盖导入要求先处理 ERP 关联。新增 Service 测试覆盖队列所有五种状态、仅保留 links、同租户原子拒绝及另一租户独立导入。                                                                                                                                              |

标准映射按 ERPNext v15 的 [Sales Order 定义](https://raw.githubusercontent.com/frappe/erpnext/version-15/erpnext/selling/doctype/sales_order/sales_order.json) 和 [Purchase Order Item 定义](https://raw.githubusercontent.com/frappe/erpnext/version-15/erpnext/buying/doctype/purchase_order_item/purchase_order_item.json) 核对。这里的检查证明字段与关联形状，真实服务器是否接受及返回正确单据由隔离 ERP 环境另行验收。

## 界面保存顺序检查

2026-10-12 使用实际保留数据库的本机 API 再次验证销售/单证可见父订单及出运、隐藏财务值保全、备注保存、409 旧版本拒绝及 403 财务越权拒绝。Grandware 全部 payload、汇率和 revision 均保持不变；另逐条对比原始归档，除导入时添加 `tenantId=grandware` 外，原业务字段、顺序及汇率完全相等，revision 保持 1，见 [验收 JSON](live-api-acceptance-20261012.json)。登录主题和配置角色名称的补充回归后，前端 14 套 **636 项通过**（本机 Node.js 24.19.0）；静态代码检查和版本一致性检查通过。后端本机运行时为 Python 3.12.14。根 CI 使用 Node.js 22/Python 3.12，远端运行结果在 Git 发布时单独核验。视觉补验见 [记录](visual-acceptance-20261012.json)。

`js/erpnext-panel.js::editMapping` 保留稳定行 ID，校验数量/单价与销售/采购总额；保存流程为 `DB.updateOrder → await DB.flush → 关闭表单/成功提示`，失败后恢复按钮且保留表单。加入队列先 `await DB.flush`，再使用确认后的 `DB._cloudVersion` 请求队列。

`js/data.js::flush` 等待保存队列；`js/api-client.js::saveData` 基于读取基线发送 expectedVersion，并且只确认本次提交快照，冲突不会自动覆盖远程数据。本审查对上述 UI 流程做了代码核对；真实浏览器交互由本轮本地预览验收记录提供。

## 本轮测试记录

- 原有集成基线：86 项，85 通过；一项失败是权限检查前移导致旧断言由 `RELATED_RECORD_DENIED` 变为 `ASSIGNMENT_DENIED`，已更新精确错误码，403 拒绝行为保留。
- 补充父订单授权及 ERP 导入保护后：`ServiceTest` 44 项全部通过，165.644 秒。
- ERP 来源 ID 别名权限回归：修复前 1 项失败；明确来源订单修复后已通过。
- Grandware 历史跨主体关联兼容回归：`test_historical_cross_entity_edits_preserve_finance_but_new_links_entity_and_erp_stay_strict` 通过，5.265 秒；只使用虚构临时数据，包含历史工厂公开信息编辑、历史客户同 ID 编辑、财务值保持、新关联/主体变更拒绝与 ERP 排队严格校验。
- 最终完整后端命令（Python 3.12）：`python3 -m unittest server.tests.test_service server.tests.test_erpnext_routes server.tests.test_erpnext server.tests.test_validation -v`。
- 前一轮完整结果：106 项全部通过，44.450 秒。
- 历史关联规则更新后：109 项全部通过，163.856 秒，0 失败、0 错误、0 跳过；其中 Service/HTTP 50 项、ERP Routes 23 项、ERP Bridge 24 项、业务 Validation 12 项。
- 2026-10-12 最终冻结前结果：117 项全部通过，24.482 秒，0 失败、0 错误、0 跳过；Service/HTTP 50、ERP Routes 23、ERP Bridge 32、业务 Validation 12。HTTP 错误响应显式关闭，最终日志没有连接资源警告。自动测试使用独立临时数据库；Routes 仅访问本机 HTTP，远程 ERP 请求由 FakeFrappe 替代。真实 ERP 另由实际验收报告证明。

验证结果分层：本地临时数据库/HTTP/FakeFrappe 回归；真实浏览器预览；真实隔离 ERPNext 服务器；Git 发布。前一层的通过不替代后一层的执行证据。
