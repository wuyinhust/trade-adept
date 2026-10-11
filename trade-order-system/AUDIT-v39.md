# Grandware@once 代码质量审计报告

**日期**: 2026-08-01 | **版本**: v38 -> v39 | **审计员**: Senior Developer  
**项目规模**: 14,000+ 行 (JS: 7,600+ + CSS: 1,600+ + HTML: 190 + Tests: 3,800+ + E2E: 50+)

---

## 综合评分

| 维度               | v38        | **v39**    | 变化     |
| ------------------ | ---------- | ---------- | -------- |
| 1. 架构与模块化    | 7.5        | **7.5**    | -        |
| 2. 代码质量        | 7.5        | **8.0**    | +0.5     |
| 3. 安全性          | 9.0        | **9.0**    | -        |
| 4. 测试            | 8.5        | **8.5**    | -        |
| 5. 错误处理 & 韧性 | 8.5        | **9.0**    | +0.5     |
| 6. 性能            | 7.0        | **7.0**    | -        |
| 7. 可维护性        | 7.5        | **8.0**    | +0.5     |
| 8. 生产就绪度      | 8.5        | **9.0**    | +0.5     |
| **加权总分**       | **8.5/10** | **8.8/10** | **+0.3** |

---

## v39 核心改进

### 关键生产缺陷修复（2 项）

| 修复                                      | 根因                                                                    | 影响                                               |
| ----------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------- |
| **软删除模型** (Soft Delete / Tombstones) | "追加+合并"存储模型下，物理删除后旧文档中的数据在合并时"复活"           | 删除订单/客户/工厂后刷新不再重现，数据一致性恢复   |
| **ID 类型统一** (String() 比较)           | HTML `<select>` value 始终为字符串，DB 中 ID 可能为数字，`===` 匹配失败 | 编辑订单时客户联系人下拉正常加载，工厂匹配正常工作 |

### 软删除实现详情

**删除方法（3 个）：**

- `deleteOrder`: 标记 `deleted: true` + `deletedAt`，关联 shipments/invoices 同步标记
- `deleteCustomer`: 标记 `deleted: true` + `deletedAt`
- `deleteFactory`: 标记 `deleted: true` + `deletedAt`

**查询方法过滤（13 个）：**

- `getOrders` / `getOrder` / `getCustomerOrders` / `getFactoryOrders`
- `getCustomers` / `getCustomer`
- `getFactories` / `getFactory`
- `getShipments` / `getShipment` / `getShipmentByOrder`
- `getInvoices` / `getInvoice` / `getInvoicesByOrder`
- `getDashboardStats` / `getProfitAnalysis`

**测试适配（5 个）：** CRUD 测试更新为验证软删除行为（`deleted` 标记 + getter 过滤）

### ID 类型统一详情

| 文件        | 位置                  | 修复                                                                       |
| ----------- | --------------------- | -------------------------------------------------------------------------- |
| `orders.js` | showEditForm 客户查找 | `c.id === order.customerId` -> `String(c.id) === String(order.customerId)` |
| `orders.js` | option selected 判断  | 同上                                                                       |
| `data.js`   | getCustomer           | `c.id === id` -> `String(c.id) === String(id)`                             |
| `data.js`   | getCustomerOrders     | `o.customerId === customerId` -> `String(...)`                             |
| `data.js`   | getFactory            | `f.id === id` -> `String(f.id) === String(id)`                             |
| `data.js`   | getFactoryOrders      | `includes(factoryId)` -> `some(id => String(id) === String(factoryId))`    |
| `data.js`   | getDashboardStats     | monthlyStats/profitAnalysis 中 customerId 过滤统一 String()                |
| `data.js`   | getProfitAnalysis     | customerId 过滤统一 String()                                               |

---

## 逐维度分析

### 1. 架构与模块化 -- 7.5/10

**保持**: ES Modules 全迁移完成。页面模块单体化（orders.js 1,400+ 行）待拆分。`window.X` 全局暴露仍为架构债务。
**v39 影响**: 软删除不改变架构结构，但 Tombstone 模式是数据层架构升级的正确方向。

### 2. 代码质量 -- 8.0/10 (+0.5)

**提升**: String() 统一比较消除类型不一致隐患。软删除避免了物理删除与合并策略的冲突，代码逻辑更清晰。
**保持**: ESLint 0 error / 0 warning。`_applyProfitFields()` 统一利润计算。
**待改进**: orders.js 单体拆分，JSDoc 类型标注。

### 3. 安全性 -- 9.0/10

**保持**: 登录频率限制 + CSP header + SHA-256 哈希 + 88 处 XSS 全防护 + 时序攻击防护。
**提示**: `CLOUD_SECRET` 部署前需填入真实密钥。

### 4. 测试 -- 8.5/10

**保持**: 394 单元测试 + 6 E2E 测试 = 400 测试，全部通过。exchange.js 100% 覆盖。
**v39 影响**: 5 个 CRUD 测试适配软删除行为，验证 `deleted` 标记和 getter 过滤逻辑正确。

### 5. 错误处理与韧性 -- 9.0/10 (+0.5)

**提升**: 软删除从根本上解决了"删除后数据复活"的数据完整性问题——这是生产环境中最严重的错误类型之一。Tombstone 模式确保即使合并策略有缺陷，已删除数据也不会重新出现。
**保持**: 全局错误边界 + 三层降级 + beforeunload 双保险。

### 6. 性能 -- 7.0/10

**保持**: 保存队列合并、轮询跳过窗口、SW 缓存。软删除的 `filter(!deleted)` 在数据量小时无感知开销。
**待改进**: 页面模块一次性全量加载，动态 import 懒加载。

### 7. 可维护性 -- 8.0/10 (+0.5)

**提升**: 软删除比物理删除更可维护——保留了审计轨迹（何时删除的），且避免了与合并策略的复杂交互。String() 统一比较是防御性编程的良好实践，减少未来 ID 类型变更的脆弱性。
**待改进**: `DB<->Exchange` 双向依赖，页面模块 HTML 字符串生成器。

### 8. 生产就绪度 -- 9.0/10 (+0.5)

**提升**: 两个关键生产缺陷修复——删除不生效和联系人下拉不加载。已部署到 CloudBase 静态托管 (v39)。
**保持**: PWA + CloudBase + localStorage 安全网 + .tcbignore + Git Hooks + ESLint/Prettier。
**待做**: CI/CD 自动化部署（GitHub Actions）。

---

## 历史演进

| 版本    |  评分   | 关键里程碑                                    |
| ------- | :-----: | --------------------------------------------- |
| v34     |   2.3   | 起始基线                                      |
| v36     |   7.4   | 架构解耦 + XSS 全防护 + ESLint/Prettier       |
| v37     |   7.8   | ES Modules + CloudBase 自定义登录 + 367 tests |
| v38     |   8.5   | P1 安全加固 + 暗色模式 + 400 tests + E2E      |
| **v39** | **8.8** | **软删除 + ID 类型统一 + 关键缺陷修复**       |

---

## 达到 9.0 的路线图

| 优先级 | 事项                                           | 预估影响        |
| ------ | ---------------------------------------------- | --------------- |
| P1     | GitHub Actions CI/CD（测试 -> 部署 CloudBase） | 生产就绪度 +0.5 |
| P2     | orders.js 拆分为列表/表单/详情（3 文件）       | 架构 +0.5       |
| P2     | 动态 import 按路由懒加载页面模块               | 性能 +0.5       |
| P3     | CSS Critical 内联 + 代码分割                   | 性能 +0.5       |
| P3     | TypeScript / JSDoc 类型标注                    | 可维护性 +0.5   |

---

**总结**: v39 修复了两个最影响用户信任的生产缺陷——删除不生效和数据类型不匹配。软删除模型从架构层面解决了"追加+合并"存储策略的固有缺陷，ID 类型统一消除了前端表单与后端数据之间的类型鸿沟。系统已从 8.5 提升至 8.8，距离 9.0 还需 CI/CD 自动化和架构拆分。
