# Tradept

通用外贸订单系统。Trade + Adept（精通者），寓意“贸易行家”。

产品面向外贸企业，支持按配置管理账号、租户、公司主体和角色；Grandware 是首个 demo 客户。当前开发版包含本地 SQLite 业务 API、权限校验、并发版本检查、快照，以及重订的界面设计。具体实现和验证边界以开发文档为准。

## 两个版本

| 版本 | Git 位置 | 内容 |
| --- | --- | --- |
| 最初 ZIP 版本 | [original-zip 分支](https://github.com/wuyinhust/tradept/tree/original-zip)、同名标签 | 原 ZIP 的全部 82 个源码文件，按文件 SHA-256 校验一致 |
| 当前开发版本 | `main`、`current-20261011` 标签 | 当前工作区的 130 个源码、文档、预览和品牌文件 |

[比较两个固定版本](https://github.com/wuyinhust/tradept/compare/original-zip...current-20261011) · [原版校验清单](docs/source-snapshots/original-zip.json) · [当前快照清单](docs/source-snapshots/current-20261011.json)

## 目录

- `trade-order-system/`：前端业务源码、Python API、需求、审查报告和测试。
- `local-preview/`：独立预览启动层、虚构示例种子、导入工具及本地前端库。
- `brand/tradept-v1/`：Tradept 标识与预览资源。

## 本地启动

Python 3.10+，建议 3.12。从仓库目录执行：

```sh
cd trade-order-system
python3 -m server.cli --runtime /private/tmp/tradept-runtime init --config server/config.example.json
python3 -m server.app --runtime /private/tmp/tradept-runtime --port 3087
```

打开 `http://127.0.0.1:3087/`。初始化生成的本机演示口令保存在指定运行目录的 `demo-credentials.json`；运行目录应放在支持文件权限与 SQLite 锁的本地磁盘，不能放在 SMB 网络共享卷。临时运行目录适合演示，持久使用请指定受备份保护的目录。

更多配置、导入和验证命令见 [服务说明](trade-order-system/server/README.md)。界面独立预览可从仓库目录运行 `python3 local-preview/server.py --dataset example --port 3086`。

## 数据和验证记录

此仓库保存开发源码与虚构示例种子。依赖目录、缓存、运行数据库、随机演示口令和 `local-preview/data/` 下的线上 Grandware 业务快照按忽略规则排除；需要真实业务数据时，通过本地导入器另行导入已获授权的数据副本。

- [通用产品需求](trade-order-system/docs/通用外贸订单系统-产品需求-v1.md)
- [代码审查](trade-order-system/docs/CODE-REVIEW-20261011.md)
- [界面规范](trade-order-system/docs/UI-DESIGN-v1.md)
- [本地交付与验证记录](trade-order-system/docs/本地交付与验证-20261011.md)

本次提交是源码版本归档；本地验证记录保留在上述文档中。
