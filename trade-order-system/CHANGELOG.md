# Tradept — 更新日志

## 0.2.0（2026-10-12）

- 将两套系统并行版本完整保存在 `archive/parallel-systems-v0.1.1`；历史标签和发布记录保持原提交。
- 统一为 Tradept 工作台和 Frappe/ERPNext 业务后台：复用原生账号、权限、公司、客户、供应商、订单、收付款与事务；移除当前分支的 SQLite 业务存储、同步队列和 CloudBase 登录降级。
- 每个企业独立站点和数据库；Grandware 四家公司使用明确授权和历史利润政策，通用企业使用独立配置。默认管理员配置账号，原生注册可选，注册不自动获得业务权限。
- 原始 Grandware 数据逐字段无损迁移；不规范的历史联系方式保留来源原文，标准联系方式继续校验；缺失历史事实保持未知，累计余额不生成会计凭证。
- Excel 明确区分历史参考和新业务，预览取消零写入、空白不清除原值、整批提交受权限和版本保护。正式业务完善真实 SKU 后建立原生 SO/PO，金额、收款和出运从原生单据回读。
- 生产计划保留产品类型、验货和预计出货日期；正式单据的客户、数量、金额、付款和实际出运不能通过普通表单覆盖。当前汇率配置不重算正式单据的冻结金额。
- 并发保存采用原生当前读取和事务锁，冲突保留草稿；原生管理员操作纳入同一版本和审计。快照不能回退已提交账务，完整备份支持独立站点恢复。
- 保留现有 logo、布局和视觉。隔离本地部署与两套需求的实际验收见 [0.2.0 验收记录](docs/RELEASE-0.2.0.md)；公网测试环境版本单独说明。
- 正式订单详情从真实商品明细显示数量和计量单位；缺失值显示“—”。原生控制器在已授权订单和法人范围内执行，主单据、子行和凭证账本记录真实操作者，原登录会话与历史创建者保留。

## 0.1.1（2026-10-12）

- 将当前本地应用、隔离 ERPNext、旧 CloudBase 统一明确为测试环境；当前没有生产环境。
- 工作区状态显示“数据库工作区 · 测试环境”，本地服务启动提示及测试部署说明保持一致。
- 更新入口资源缓存版本；沿用当前私有本机数据库与配置。旧浏览器快照预览说明与数据库 API 预览分开，避免端口冲突。
- 支持固定 HTTPS Origin 的云测试反向代理，严格检查 Host 和同源请求、设置 Secure 会话 Cookie；增加独立资源受限服务模板及 13 项部署边界 / 虚构种子持久化验证。
- 本次本地更新与云端目标核验见 [测试环境更新记录](docs/RELEASE-0.1.1.md)；Git 版本及各环境部署分别回读。

## 0.1.0（2026-10-12）

Tradept 首个通用外贸订单产品开发版本，以 Grandware 作为优先客户模板。交付范围及两套需求的实现、测试和后续边界见 [阶段验收](docs/RELEASE-0.1.0.md)；本版本不代表完整 PRD 或生产部署已完成。

### 产品与数据基础

- 接入对话最新 Tradept 原 logo，保留现有布局、毛玻璃导航和浅/深主题，小幅调整品牌配色；产品名与租户名称分开。
- 登录表单显示前应用主题偏好，修复暗色首次登录对比度；配置角色名称与单证角色在界面正确显示。
- 配置账号、多租户、多法人及可配置角色能力；服务端校验会话、法人、记录分配和财务读写，使用独立虚构租户验证通用化。
- 本地 SQLite 事务、租户版本 CAS、字段补丁批量保存、审计及快照恢复；409 保留草稿，阻止静默覆盖；保留原 Grandware 历史数据和核算口径。

### 业务修复

- 公共生产字段独立于财务控件；非财务编辑保全隐藏成本、收款和历史引用；产品类别按实际产品类型汇总，备注编辑不重写历史类别。
- 复用 SheetJS，Excel 先解析预览再确认；取消零写入，失败重试复用记录 ID，数据库确认后显示真实成功数。
- 订单和物流页可建立同法人出运记录；ETD 与实际报关/装船/到港/签收日期分开；香港港口及数量/金额/日期/状态增加验证。
- 批量状态默认不修改，等待持久化再完成；收款失败重试不重复累计；订单详情移除废弃物流字段，负责人筛选复用配置名录。
- 保留 `grandware-v40` 的 CNY/USD 利润策略与旧字段实际单位，历史读取和公开编辑不自动重算。

### 复用 ERPNext 与验证

- 增加私有配置、显式入队、持久 outbox 与标准客户/供应商/销售/采购单映射；稳定外部 ID、来源一致性及远端修改检查保护重试。
- 本轮 ERP 映射限 USD 主体并要求明确 SKU/数量/单价/供应商及叶子分类，旧成本字段须显式声明 USD；禁止密钥请求重定向，loopback 禁用系统代理，远端金额或币种差异阻断同步并保留映射。
- 实际隔离 ERPNext 16.32.3 验收通过：销售单 USD 1000、两家供应商采购单 USD 420/280、出运数量 100 与交付 100%、收款 USD 1000 和总账借贷平衡。常规产品默认同步草稿；验收脚本显式提交不构成生产上线或双向业务回写，见 [实际记录](docs/erpnext-real-acceptance.json)。
- 完整类 Excel 编辑器、PostgreSQL/客户本地云数据库管理、任意币种税务、分批出货、生产 ERP 双向流程、订阅计费和生产运维仍为后续工作。

以下保留原 Grandware 系统历史日志，历史 v37 等标记不等于 Tradept 的三段版本号。

## v37 (2026-07-31) — 部署优化 + 自定义登录基础设施

### 📦 部署优化

#### `.tcbignore` 部署排除规则

- 新建 `.tcbignore`：排除 `node_modules/`、`tests/`、`coverage/`、开发工具配置、文档、诊断页面
- 效果：CloudBase 静态托管部署时只上传运行时必要文件（index.html、css/、js/、assets/、sw.js、manifest.json）
- 减小部署体积 ~99%（跳过约 200MB 的 node_modules）

### 🔐 CloudBase 自定义登录（基础设施）

#### 云函数 `customLogin` (`cloudfunctions/customLogin/`)

- 新建 `index.js`：接收用户名+密码哈希，验证后签发 CloudBase 自定义登录票据
- 支持 `SHARED_SECRET` 环境变量（服务端密钥，阻止未授权调用）
- 将用户 `role`/`teamId`/`visibleCompanyIds` 写入 `auth.custom` claims
- 响应包含票据 `ticket` 和用户信息，客户端可用 `auth.signInWithTicket()` 建立会话
- 新建 `package.json`（依赖 `@cloudbase/node-sdk`）和 `config.json`（环境变量模板）

#### 客户端 `cloud.js` v13 适配

- `init()` 新增自定义登录优先策略：先尝试 `_tryCustomLogin()`，失败后降级匿名登录
- 新增 `_tryCustomLogin()`：调用 cloudfunction URL，获取 ticket，建立自定义登录会话
- 新增 `getLoginType()` / `isCustomLogin()`：查询当前登录方式
- 新增 `CLOUD_SECRET` / `CLOUD_FN_URL` 配置项
- `resetSession()` 同步重置 `_loginType` + `_customLoginTried`
- 更新 JSDoc 注释：包含两套安全规则（匿名模式 vs 自定义登录模式）

> **注意**：自定义登录需要部署 `customLogin` 云函数后才能生效。未部署时自动降级为匿名登录，行为与 v36 完全一致。详见 `cloudfunctions/customLogin/` 部署说明。

### 🧪 测试覆盖提升

- cloud.js：覆盖率 3.14% → **21.25%**（+29 测试）
- app.js：覆盖率 5.65% → **9.52%**（+7 测试）
- data.js：覆盖率 68.75% → **71.79%**（+38 测试）
- **综合覆盖率**：语句 48% → **53.26%**，分支 43.37% → **50.69%**
- **总测试数**：293 → **367**（+74）

### 🔄 版本号

- HTML/CSS/JS 引用 `?v=37` → `?v=38`
- Service Worker 缓存 `grandware-v7` → `grandware-v8`

---

### 🔒 P0 安全修复 — XSS 全面防护

#### 数据渲染层 XSS 防护（所有模块）

- `js/orders.js`：`renderTable()` + `renderDetail()` 中所有用户输入字段使用 `App.escapeHtml()` 转义
- `js/customers.js`：`renderTable()` + `renderDetail()` + 联系人列表全部转义
- `js/factories.js`：`renderTable()` + `renderDetail()` + 关联订单列表全部转义
- `js/profit.js`：利润分析表格中的订单数据转义
- `js/shipping.js`：出运列表和详情页数据转义
- `js/settings.js`：汇率获取错误消息转义
- `js/orders.js`：Excel 导入错误和结果消息转义

### 🏗️ 架构设计提升

#### 事件总线解耦 (`js/app.js`)

- 新增 `App.on(event, callback)` / `App.off(event, callback)` / `App.emit(event, data)`
- 为后续模块间通信提供发布订阅机制，减少直接耦合

### 🛡️ 代码质量提升

#### 魔法数字 → 集中常量 (`js/constants.js`)

- 新建 `js/constants.js`：统一管理所有魔法数字
- 常量清单：汇率默认值、时间阈值、数据限制、安全参数、公司代码
- `data.js`, `exchange.js`, `cloud.js` 全部替换为 `CONSTANTS.*` 引用

#### 消除重复代码 (`js/data.js`)

- 提取 `_doInit()` 和 `_checkRemoteUpdates()` 中重复的汇率合并逻辑
- 新建 `DB._applyExchangeData(source)` 统一方法，消除 16 行重复代码

#### Promise.race 改造 (`js/data.js`)

- `DB.init()` 从手动 `settled` 标志 + `clearTimeout` 改造为 `Promise.race`
- 代码更简洁，更不容易出现竞态条件

### 🛡️ 数据层加固

#### contacts 合并逻辑健壮化 (`js/cloud.js`)

- `_mergeMultipleDocs()` 联系人 key 从 `name` 升级为 `name|position|phone|email` 组合键
- 修复同名不同人联系人被错误合并的问题
- 修复合并结果只在数量增加时才替换的 bug，改为始终使用合并结果

#### 旧文档清理并发安全 (`js/cloud.js`)

- `_cleanupOldDocs()` 新增 `_cleaning` 标志，防止并发执行

### 🛡️ 工程规范

#### ESLint + Prettier + EditorConfig

- `.eslintrc.config.js`：推荐规则 + 自定义全局变量（App/DB/Auth/Cloud 等）
- `.prettierrc`：统一代码格式（单引号、120 字符行宽）
- `.editorconfig`：跨编辑器一致的缩进和编码

#### npm 项目初始化

- `package.json`：项目元数据 + `test`/`lint`/`format` 脚本
- 安装 `jest` + `jest-environment-jsdom` + `eslint` + `prettier` + `@eslint/js`

#### 单元测试 (`tests/`)

- `tests/constants.test.js`：常量定义验证（4 项测试 ✅）
- `tests/exchange.test.js`：汇率计算 + 利润公式验证（6 项测试 ✅）
- `tests/auth.test.js`：角色权限检查（1 项测试 ✅，5 项 Web Crypto 测试因 jsdom 限制 skip）

### 📦 部署更新

- 所有 JS 引用版本号 `?v=35` → `?v=36`（缓存刷新）
- 新增脚本加载：`js/constants.js`（最优先）
- Service Worker 缓存版本 `grandware-v5` → `grandware-v6`

---

## v35 (2026-07-31) — 安全加固 + 代码质量提升

### 🔒 P0 安全修复

#### 明文密码 → SHA-256 哈希 (`js/auth.js`)

- 所有 10 个用户的密码从明文替换为 SHA-256 哈希值
- `login()` 改为异步，使用 Web Crypto API (`crypto.subtle.digest`) 计算输入密码的哈希后比对
- 找不到用户时仍执行一次哈希运算，防止时序攻击（timing attack）

#### XSS 注入防护 (`js/app.js`)

- 新增 `App.escapeHtml()` 通用 HTML 转义函数
- 修复 `showConfirm()` — 用户输入消息现在会被转义
- 修复 `toast()` — 通知消息现在会被转义
- 修复 `showApp()` 错误页 — 错误消息现在会被转义

#### CloudBase 数据库权限收紧 (`js/cloud.js`)

- 更新安全规则文档：从 `{"read":true,"write":true}` 改为基于 `dataType` 字段的受限规则
- 推荐规则限制只能读写 `gw_data` 和 `_diag_test` 类型文档
- 禁止 `delete` 操作，通过 `active=false` 软删除代替

### 🛡️ 代码质量提升

#### 统一错误处理 (`js/app.js`)

- 新增 `App.handleError(error, context, options)` — 集中式错误日志 + 用户友好提示
- 新增 `App._userFriendlyError()` — 技术错误自动转译为用户可理解的中文提示
- 新增 `App.safeCall(fn, context)` — 安全包装异步调用，自动捕获错误
- 批量替换 `data.js` 中 20+ 处 `.catch(e => console.error(...))` 为统一错误处理

#### 输入验证增强 (`js/app.js`)

- 新增 `App.validate` 工具对象：`required()`, `positive()`, `numeric()`, `email()`, `phoneCN()`, `length()`, `checkAll()`
- `addCustomer()` 增加公司名称必填验证
- `addFactory()` 增加工厂名称必填验证
- `addOrder()` 增加客户 ID、操作单号、订单金额验证

### 🏗️ 架构重构

#### data.js 模块化拆分

- 提取汇率与利润计算逻辑 → 新文件 `js/exchange.js`（Exchange 模块）
- `DB.recalcAllOrders()`, `DB.fetchExchangeRate()`, `DB.calcOrderProfit()` 等方法委托给 Exchange
- 保持所有现有 `DB.*` 调用接口不变，向后兼容

#### Service Worker 升级

- 缓存版本 `grandware-v4` → `grandware-v5`
- 静态资源列表新增 `js/exchange.js`

### 📦 部署更新

- 所有 JS 引用版本号 `?v=34` → `?v=35`（缓存刷新）
- 新增脚本加载：`js/exchange.js`（在 `data.js` 之前）

### 同行评审备注

- 数据表渲染层（customers.js, factories.js, orders.js）的 innerHTML 模板暂未全面重构为安全 DOM API。当前数据来源为团队内部受信数据库，风险可控。建议下一版本逐步迁移到 `App.escapeHtml()` 转义模式。
- 如需更强的权限控制，建议引入 CloudBase 自定义登录（非匿名），配合安全规则实现行级权限。
