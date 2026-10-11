# HK 公司利润计算修复 (v45)

## 问题
HK 公司（CO-GW, CO-LK）利润计算结果错误。`orderAmountRMB` 对 HK 公司也乘了汇率（如 $30,000 × 7.18 = ¥215,400），但 HK 公司全部是美金交易，不需要换算。导致利润率、利润额等数据全部错误。

## 根因
- `exchange.js` `recalcAllOrders()`：所有公司都执行 `o.orderAmountRMB = o.orderAmountUSD * rate`
- `data.js` `_applyProfitFields()`：同样无条件乘汇率
- 多处 UI 直接显示 `orderAmountRMB` 而不分国内/HK

## 修复（6个文件）

### 1. exchange.js — `recalcAllOrders()`
```diff
- o.orderAmountRMB = Math.round(o.orderAmountUSD * rate * 100) / 100;
+ o.orderAmountRMB = isHK
+     ? Math.round(o.orderAmountUSD * 100) / 100       // HK: 美金直接用
+     : Math.round(o.orderAmountUSD * rate * 100) / 100; // 国内: 乘汇率
```

### 2. data.js — `_applyProfitFields()`
```diff
- const totalRevenueRMB = order.orderAmountUSD * rate;
+ const totalRevenueRMB = isHK ? order.orderAmountUSD : order.orderAmountUSD * rate;
```

### 3. orders.js — 订单详情页
- HK 公司不显示 "≈ ¥XXX" 换算行
- HK 公司不显示 "订单总金额 (RMB)" 行
- Excel 导出标签动态化（HK→USD, 国内→RMB）

### 4. dashboard.js — 仪表盘
- HK 公司显示 "美金交易" 替代 "≈ ¥XXX"
- 工厂成本货币符号从硬编码 CNY → 动态（isHK ? USD : CNY）

### 5. profit.js — 利润分析
- 成本结构图：`costRate = isHK ? 1 : rate`（HK 不乘汇率）
- 客户利润分布图 x 轴：硬编码 '¥' → `currencySymbol`
- Excel 导出标签动态化

## 验证
- 530 个测试全部通过（7 suites）
- 语法检查通过

## 版本号
- index.html: v44 → v45
- sw.js: grandware-v14 → v15
