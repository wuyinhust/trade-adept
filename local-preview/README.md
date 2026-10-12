# 本地静态资源与历史来源

当前 Tradept 只有统一 Frappe/ERPNext 业务后端；入口为 `trade-order-system/server/app.py`。旧浏览器快照预览服务器和 bootstrap 已移至 `archive/parallel-systems-v0.1.1`，不再作为另一套可写系统启动。

`vendor/` 保留工作台离线使用的 Chart.js / SheetJS 库。`data/` 是已授权的私有只读来源快照，不进入 Git，不作为在线数据库；原始文件和哈希用于迁移核验。历史截图与导入取证工具不证明当前在线环境状态。
