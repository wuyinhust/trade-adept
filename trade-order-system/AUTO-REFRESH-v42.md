# 美金汇率自动刷新功能 (v42)

## 概述
实现了每小时自动更新最新实时美金汇率的功能，无需手动操作。

## 改动文件

### 1. `js/exchange.js` — 核心改动
- **提取 `_fetchRawRate()`**：将 API 调用逻辑从 `fetchRate()` 中提取为独立私有方法，便于复用
- **重构 `fetchRate()`**：现在调用 `_fetchRawRate()` 后应用到当前公司
- **新增 `_autoRefreshAll()`**：获取最新汇率后同时应用到所有国内公司 (CO-GR, CO-WY)，HK 公司不受影响
- **新增 `startAutoRefresh()`**：启动 `setInterval` 定时器，每 1 小时执行 `_autoRefreshAll()`
  - 首次启动时立即用 `autoFetchIfStale()` 检查是否需要刷新
  - 防止重复启动（先 `stopAutoRefresh()` 再启）
- **新增 `stopAutoRefresh()`**：清除定时器，停止自动刷新
- **新增 `isAutoRefreshActive()`**：返回自动刷新是否在运行
- **新增 `getNextRefreshTime()`**：返回下次刷新时间的 ISO 字符串

### 2. `js/data.js` — 初始化变更
- `DB.init()` 中的 `this.tryAutoFetchRate()` → `Exchange.startAutoRefresh()`
- 持久化自动刷新（非一次性检查）

### 3. `js/app.js` — 侧边栏 UI
- `updateExchangeRateDisplay()` 增强：
  - 自动刷新激活时，tooltip 显示"下次自动刷新"时间
  - 来源小字图标从 🔄 改为 ⏰ 表示定时刷新中

### 4. `js/settings.js` — 设置页面
- 新增"停止自动刷新"/"开启自动刷新"切换按钮
- 汇率状态区显示下次自动刷新时间
- 新增 `toggleAutoRefresh()` 方法

### 5. 版本号
- `index.html`: v41 → v42
- `sw.js`: grandware-v11 → grandware-v12

## 测试
- 新增 13 个测试用例 (总 47 → 530)，全部通过
- 覆盖：`_fetchRawRate`、`_autoRefreshAll`、`startAutoRefresh`/`stopAutoRefresh`、`getNextRefreshTime`

## 工作原理
```
应用启动 → Exchange.startAutoRefresh()
  ├─ 立即检查汇率是否过期 (>1h) → 过期则立即获取
  └─ 启动 setInterval(每1小时)
       └─ _autoRefreshAll()
            ├─ _fetchRawRate() → 调用免费汇率 API
            ├─ 应用到 CO-GR + CO-WY (国内公司)
            ├─ recalcAllOrders() → 重算全量订单利润
            ├─ DB.save() → 同步到 CloudBase 云端
            └─ updateDisplay() → 刷新 UI
```
