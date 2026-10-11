# Grandware@once 代码质量审计报告

**日期**: 2026-07-31 | **版本**: v37 → v38 | **审计员**: Senior Developer  
**项目规模**: 12,454 行 (JS: 7,348 + CSS: 1,393 + HTML: 182 + Tests: 3,531)

---

## 综合评分

| 维度               | v34 基线   | v36        | **v37**    | 变化     |
| ------------------ | ---------- | ---------- | ---------- | -------- |
| 1. 架构与模块化    | 2.5        | 7.0        | **7.5**    | +0.5     |
| 2. 代码质量        | 3.0        | 6.5        | **7.0**    | +0.5     |
| 3. 安全性          | 4.0        | 7.5        | **8.5**    | +1.0     |
| 4. 测试            | 1.5        | 7.0        | **7.5**    | +0.5     |
| 5. 错误处理 & 韧性 | 2.0        | 7.5        | **8.0**    | +0.5     |
| 6. 性能            | 3.0        | 6.5        | **7.0**    | +0.5     |
| 7. 可维护性        | 2.0        | 7.0        | **7.0**    | —        |
| 8. 生产就绪度      | 2.0        | 7.0        | **7.5**    | +0.5     |
| **加权总分**       | **2.3/10** | **7.4/10** | **7.8/10** | **+0.4** |

---

## 逐维度分析

### 1. 架构与模块化 — 7.5/10

**✅ 优势**

- ES Modules 迁移完成：10 个核心模块 + 7 个页面模块全部使用 `import/export`
- 清晰的关注点分离：`auth.js` (认证) → `cloud.js` (云层) → `data.js` (业务逻辑) → `app.js` (UI 控制器)
- `utils.js` 提取打破了 `App ↔ DB` 循环依赖 (EventBus, escapeHtml, toast, validate)
- `constants.js` 集中管理全部魔法数字 (37 个常量)
- CloudBase 自定义登录架构 (cloudfunctions/customLogin/) 模块化清晰

**⚠️ 待改进**

- ESLint 配置 `sourceType: 'script'` 与实际 ES Modules 代码不匹配 → 6 个模块解析失败
- 页面模块 (orders.js 1,387 行, customers.js 782 行) 单体化，无组件拆分
- 12 处 `window.X = X` 全局污染 (兼容 HTML onclick 内联调用)
- `DB` 作为可变全局对象的紧耦合仍然存在 (Exchange 直接读写 DB.data)

---

### 2. 代码质量 — 7.0/10

**✅ 优势**

- JSDoc 注释覆盖所有主要函数
- 一致的命名规范 (camelCase)
- `async/await` 统一使用，无原始 Promise 链
- 代码中零 TODO/FIXME/HACK
- cloudbase-sdk.js 已从 ESLint 检查中排除

**⚠️ 待改进**

- ESLint 解析错误（sourceType 不匹配）— 见上方架构
- `getDashboardStats()` 达 61 行，`_mergeMultipleDocs()` 达 89 行 — 建议拆分
- orders.js (1,387 行) 是最大的单体文件，建议拆分为列表/表单/详情组件
- 未强制 Prettier 格式化（需手动运行）
- `data.js` 部分 CRUD 方法存在重复的模式代码（利润率计算公式重复 3 次）

---

### 3. 安全性 — 8.5/10 (最高分)

**✅ 优势**

- **XSS 防护**: `escapeHtml()` 在 88 处 innerHTML 注入点全部使用，无遗漏
- **密码安全**: SHA-256 哈希 via Web Crypto API，永不明文存储
- **时序攻击防护**: 用户不存在时仍执行 `_hashPassword()` 运算
- **输入验证**: `validate` 工具集在所有 CRUD 入口使用 (required, positive, checkAll)
- 无 `eval()`, `Function()`, `document.write()`, `innerHTML` 裸注入
- sessionStorage 会话管理 (生命周期 = 单个标签页)

**⚠️ 待改进**

- `CLOUD_SECRET` 和 `CLOUD_FN_URL` 硬编码占位符在 `cloud.js` 中 — 部署前需填入实际密钥（前端暴露风险）
- 登录失败次数计数器已定义 (`MAX_LOGIN_ATTEMPTS`, `LOCKOUT_DURATION_MS`) 但未在运行时强制执行
- 无 CSP header 配置（当前依赖代码内 XSS 防护）
- `auth.js` 密码哈希硬编码在源码中（此项目架构下可接受，无后端服务器）

---

### 4. 测试 — 7.5/10

**✅ 优势**

| 模块         | 语句   | 分支   | 函数   | 行     |
| ------------ | ------ | ------ | ------ | ------ |
| constants.js | 100%   | 100%   | 100%   | 100%   |
| auth.js      | 98.43% | 95.45% | 100%   | 99%    |
| utils.js     | 93.67% | 95.94% | 90%    | 96.77% |
| exchange.js  | 87.5%  | 76%    | 84.61% | 88.88% |
| data.js      | 71.79% | 60.53% | 75.92% | 72.17% |

- **367 个测试, 7 个套件, 100% 通过率**
- 覆盖率提升曲线: 293 → 367 测试 (+74), 语句覆盖 48% → 52.04%
- 边缘用例丰富: XSS 转义、非法输入、null/undefined、边界值

**⚠️ 待改进**

| 模块                       | 语句   | 未覆盖原因                                     |
| -------------------------- | ------ | ---------------------------------------------- |
| app.js                     | 9.52%  | DOM 密集 (router, showModal, showApp) — 需 E2E |
| cloud.js                   | 19.11% | CloudBase SDK 依赖 (init, loadData, saveData)  |
| orders/customers/factories | 0%     | 纯 DOM 渲染 — 不在单元测试范围内               |

- 无 E2E/集成测试
- 无用户工作流测试 (登录 → 创建订单 → 保存同步)
- data.js branches 仅 60.53% (部分分支逻辑未覆盖)

---

### 5. 错误处理与韧性 — 8.0/10

**✅ 优势**

- 统一错误处理: `handleError()` → 技术错误 → 用户友好提示 → `toast()`
- 错误分类: 网络/CORS/权限/SDK 失败各自有特定提示
- 优雅降级三层: CloudBase 不可用 → localStorage 安全网 → 空白数据启动
- `beforeunload` 双重保险: `localStorage` (100% 可靠) + `sendBeacon` (尽力而为)
- 云端数据异常保护: 客户数为 0 → 拒绝覆盖并告警
- 追加模式写入避免多用户并发冲突
- `_recoverFromLocal` 合并本地未同步数据

**⚠️ 待改进**

- 部分 catch 块静默(空): `catch (_) {}`
- `_checkRemoteUpdates` 异常被吞没 (catch 块无日志)
- 无全局 `unhandledrejection` 监听器
- 无离线模式指示器 (仅 CloudBase 状态条)

---

### 6. 性能 — 7.0/10

**✅ 优势**

- 保存队列合并: `_processQueue()` 合并中间保存 → 减少 CloudBase 写入
- 轮询跳过窗口: 保存后 3 秒内跳过远程检查
- Service Worker (PWA) 离线缓存
- localStorage 同步缓存 (写操作 0 延迟)
- 追加模式避免写入锁竞争
- 旧文档自动清理 (`_cleanupOldDocs`, 5 分钟窗口)
- 版本化静态资源 (`?v=38`)

**⚠️ 待改进**

- 所有页面模块在 `index.html` 中通过 side-effect import 一次性全部加载 (无延迟加载)
- CSS 1,393 行单文件阻塞渲染
- 无 Critical CSS 内联
- 无代码分割/动态 import
- `sendBeacon` 在 `beforeunload` 中使用的 REST API 路径可能已过期

---

### 7. 可维护性 — 7.0/10

**✅ 优势**

- 零魔法数字: 全部通过 `CONSTANTS` 引用
- CHANGELOG.md 跟踪 38 个版本变更
- `.tcbignore` 部署排除规则
- ESLint + Prettier 工具链配置
- 清晰的模块边界和职责文档

**⚠️ 待改进**

- 页面模块为整体式 HTML 字符串生成器 (难以单独修改/测试)
- 无 TypeScript 或 JSDoc 类型标注
- `DB` ↔ `Exchange` 双向依赖 (Exchange 直接操作 DB.data)
- `window.App`, `window.DB` 等全局暴露是架构债务
- `data.js` `refreshFromCloud()` 重复了 `_applyExchangeData()` 的逻辑

---

### 8. 生产就绪度 — 7.5/10

**✅ 优势**

- Service Worker + manifest.json (PWA 可安装)
- CloudBase 自定义登录基础设施完整 (云函数 + 客户端)
- localStorage 安全网 (刷新不丢数据)
- `.tcbignore` 部署排除
- 多人协作架构完整 (append-only + mergeMultipleDocs + 轮询)

**⚠️ 待改进**

- 无 CI/CD 流程
- CSS 无暗色模式支持 (0 条 dark/theme 规则)
- 无 staging 环境
- 无自动部署脚本
- 无 Health Check 端点

---

## 改进路线图

### 高优先级 (P1 — 安全性/稳定性)

1. **ESLint 配置修复**: 将 `sourceType` 改为 `'module'` (当前 6 个模块解析失败)
2. **运行时登录频率限制**: 实现 `MAX_LOGIN_ATTEMPTS` 和 `LOCKOUT_DURATION_MS`
3. **全局错误边界**: 添加 `unhandledrejection` 监听器 + `window.onerror`
4. **CSP Header**: 添加 Content-Security-Policy meta 标签

### 中优先级 (P2 — 工程质量)

5. **data.js 代码重复消除**: 利润计算逻辑抽象为单一函数
6. **orders.js 拆分**: 列表/表单/详情分离 (1,387 行 → 3 个文件)
7. **暗色模式**: CSS 变量 + data-theme 切换
8. **页面懒加载**: 使用 dynamic import 按路由加载页面模块
9. **E2E 测试**: 1-2 个关键用户工作流的 Playwright 测试

### 低优先级 (P3 — 锦上添花)

10. **TypeScript 迁移**: 逐步添加 JSDoc 类型注解
11. **CI/CD**: GitHub Actions 自动测试 + CloudBase 部署
12. **刷新逻辑去重**: `refreshFromCloud` 复用 `_applyExchangeData`

---

## 与 v36 对比关键提升

| 改进项                             | 影响                       |
| ---------------------------------- | -------------------------- |
| CloudBase 自定义登录架构           | 安全性 +1.0 (行级权限基础) |
| `.tcbignore` 部署排除              | 生产就绪度 +0.5            |
| 测试: 293→367 (+74), 覆盖 48%→52%  | 测试 +0.5                  |
| cloud.js v13 双登录策略            | 韧性 +0.5                  |
| `_mergeMultipleDocs` 100% 测试覆盖 | 测试信心提升               |

**总结**: Grandware@once 已从一个内部工具演变为一个架构合理、安全加固、测试覆盖良好的生产级应用。主要差距在 ESLint 配置修复、暗色模式和页面模块拆分。
