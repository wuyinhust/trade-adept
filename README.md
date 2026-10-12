# Tradept

通用外贸订单系统，以 Grandware 为首个演示客户。账号由管理员配置，支持租户、公司主体、角色和订单分配权限。界面沿用现有毛玻璃与简洁布局，使用 Tradept 标识。

当前正式开发版本为 **0.1.0**。本阶段交付范围和后续需求见 [发布验收](trade-order-system/docs/RELEASE-0.1.0.md)，版本递增规则见 [VERSIONING](trade-order-system/docs/VERSIONING.md)。Git 源码发布与生产系统上线分别验证。

## 本地启动

服务使用 Python 3.12；CI 使用 Node.js 22。本机验收环境为 Python 3.12.14、Node.js 24.19.0。从仓库根目录执行：

```sh
cd trade-order-system
python3 -m server.cli --runtime "$HOME/Library/Application Support/Tradept/workspace" init --config server/config.example.json
python3 -m server.app --runtime "$HOME/Library/Application Support/Tradept/workspace" --port 3087
```

打开 `http://127.0.0.1:3087/`。初始化生成的随机演示账号口令保存在指定运行目录的 `demo-credentials.json`。SQLite 运行目录必须放在支持权限和文件锁的本地磁盘；SMB 共享卷只存源码。持久使用请另选本机目录并配置备份。

服务只监听本机回环地址。配置、数据导入、权限、快照和恢复说明见 [API 服务说明](trade-order-system/server/README.md)。真实客户数据通过已授权副本另行导入；源码仓库不包含运行数据库、业务导出或密钥。

## 成熟组件

ERPNext 承接客户、供应商、销售订单、采购订单、交货与收款单据。当前桥接使用明确的 SKU、数量和价格映射，后台 outbox 负责幂等重试及来源版本检查；默认创建草稿。Grandware 原有利润口径仍在 Tradept 中兼容。

隔离本地测试部署与真实单据验收见 [ERPNext 集成](trade-order-system/integrations/erpnext/README.md) 和 [验收记录](trade-order-system/docs/ERPNEXT-ACCEPTANCE.md)。

## 需求与验收

- [通用产品需求](trade-order-system/docs/通用外贸订单系统-产品需求-v1.md)
- [原始需求与代码审查](trade-order-system/docs/CODE-REVIEW-20261011.md)
- [品牌验收](trade-order-system/docs/BRAND-ACCEPTANCE.md)
- [业务验收](trade-order-system/docs/BUSINESS-RELEASE-ACCEPTANCE.md)
- [独立发布审查](trade-order-system/docs/RELEASE-REVIEW.md)
- [变更记录](trade-order-system/CHANGELOG.md)

## 历史归档

`original-zip` 分支及同名标签保留原始 ZIP 源码；`current-20261011` 标签保留正式开发之前的快照。历史文件校验清单位于 `docs/source-snapshots/`。发布版本使用 `v大.中.小` 标签。

## 验证

```sh
cd trade-order-system
npm ci
npm test -- --runInBand
npm run lint
python3 -m unittest discover -s server/tests -v
python3 scripts/version.py
```

GitHub Actions 执行上述源码验证；生产数据库接入和生产部署需要单独的环境配置与验收。
