# Tradept

通用外贸订单工作台，以 Grandware 的 Excel 历史数据验证企业适用性。**0.3.0 企业管理版本**提供管理中心、新企业初始化及实时汇率。Tradept 界面由 Frappe/ERPNext 承担唯一在线业务存储、原生账号、公司、客户、供应商、正式订单与收付款。

[单系统需求与架构](trade-order-system/docs/UNIFIED-SYSTEM.md) 承接 [通用产品需求](trade-order-system/docs/通用外贸订单系统-产品需求-v1.md)，替代其中旧 SQLite/outbox 实现方案。Grandware 通过公司、权限、汇率、历史政策和 Excel 导入配置使用通用产品。logo、现有布局和毛玻璃视觉继续保留。

## 启动

先依照 [隔离 ERPNext 部署](trade-order-system/integrations/erpnext/README.md) 安装 ERPNext 与 `tradept_core`。每个企业独立 site/database，Grandware 四个公司主体处于同一站点。应用和数据库使用私有本地或云块盘，SMB 共享卷只保存源码。

```sh
cd trade-order-system
python3 -m server.cli --runtime /private/tmp/tradept-gateway init --sites server/frappe-sites.example.json
python3 -m server.app --runtime /private/tmp/tradept-gateway --port 3087
```

打开 `http://127.0.0.1:3087/`。账号由原生 User 管理，密码、管理员环境文件和客户数据不进入 Git。固定路由、原生会话、权限、CAS 和 API 说明见 [网关文档](trade-order-system/server/README.md)。

企业管理员在 Tradept 的“管理中心”配置公司、部门、成员、角色权限和邮箱。平台首先开通独立站点及首位管理员，新企业管理员首次登录后完成六步初始化。原生维护入口继续使用同一企业数据库；Grandware 四家公司和历史资料保留，真实商品及银行/会计配置须按真实资料验证。

## 历史数据与正式业务

Grandware 的历史记录保留来源 ID、软删除、金额和原始关联；不凭累计收款金额推造会计流水。新订单先保存业务计划，完善真实商品和价格后生成原生 SO/PO；后续金额和余额来自同一数据库的原生业务单据。Excel 预览和表单提交执行相同的权限、验证、冲突保护和审计。

## 版本与环境

[archive/parallel-systems-v0.1.1](https://github.com/wuyinhust/tradept/tree/archive/parallel-systems-v0.1.1) 保留两套系统并行版本，提交 `287b92407017900a1f58c138af9d522b921ebffe`。历史标签和 Releases 未移动；原始 ZIP 仍在 `original-zip`。版本规则见 [VERSIONING](trade-order-system/docs/VERSIONING.md)。

所有当前环境都是测试环境。公网 [tradept-test.szkuohu.com](https://tradept-test.szkuohu.com/) 已使用两套独立 ERPNext 数据库。实际部署版本、Git 提交和源文件清单哈希从 [/api/version](https://tradept-test.szkuohu.com/api/version) 回读；Git 标签与云端部署各自核验。升级使用云端现有数据的完整备份和原生应用迁移，保留旧版本包用于恢复。

## 验证

```sh
cd trade-order-system
npm ci
npm test -- --runInBand
npm run lint
python3 -m unittest discover -s server/tests -v
python3 -m unittest discover -s integrations/frappe_app/tests -v
python3 scripts/version.py
```

网关单元测试与真实原生数据库验收分别记录，当前版本结果见 [0.3.0 验收记录](trade-order-system/docs/RELEASE-0.3.0.md)。发布核对 Grandware 初始迁移、两个站点与角色隔离、多人冲突与批次回滚、Excel 导入、原生单据和重启持久化；历史验收记录按其版本保留。
