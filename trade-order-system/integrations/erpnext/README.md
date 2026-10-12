# ERPNext 隔离本地环境

2026-10-12：官方 ERPNext 16.32.3 / Frappe 16.31.0 已在本机隔离 VM 运行，虚构 Example 的 Customer、两 Supplier、SO、两 PO、DN、PE 与平衡总账实际验收通过。结果见 [验收记录](../../docs/ERPNEXT-ACCEPTANCE.md) 与 [实际回读 JSON](../../docs/erpnext-real-acceptance.json)。宿主入口仅为 `http://127.0.0.1:3088`，并非线上生产部署。

本目录基于官方 [frappe_docker 的 pwd.yml](https://github.com/frappe/frappe_docker/blob/main/pwd.yml) 服务结构，ERPNext 固定 `v16.32.3`。MariaDB、Redis、站点和日志使用独立 Docker volumes，不挂载 Grandware 原数据。原 Compose MIT 许可保留在 `FRAPPE-DOCKER-LICENSE`；ERPNext 使用 [GPL-3.0](https://github.com/frappe/erpnext/blob/v16.32.3/license.txt)，本系统通过标准 API 交互。

密码与 API key 放在 APFS 私有目录，目录 `0700`、文件 `0600`。不在仓库创建 `.env` 或输出密钥。示例配置的连接默认关闭。现有实例及资源阈值见 [RECOVERY](RECOVERY.md)；恢复时复用同一实例和 volumes。

## 建立独立环境

Lima 模板 [lima.yaml](lima.yaml) 使用 4 CPU、4 GiB RAM、20 GiB 稀疏磁盘，无宿主挂载，仅转发 loopback 3088。使用短路径的 APFS 持久私有 `LIMA_HOME`，避免 UNIX socket 路径超长和临时目录被清理。Docker/Compose 来自 Ubuntu 官方签名包。

将本目录的 Compose 与脚本复制到隔离 VM 私有目录。用 `python3 private_env.py --output /private-config/erpnext.env` 生成随机管理员/数据库密码；父目录需 `0700`，文件 `0600`，已存在时拒绝覆盖。生成内容固定 ERPNext v16.32.3 官方 ARM64 manifest digest，无公开默认管理员密码。

```sh
sudo docker compose -p tradept-erp --env-file /private-config/erpnext.env -f compose.yaml up -d
sudo docker compose -p tradept-erp --env-file /private-config/erpnext.env -f compose.yaml logs create-site
```

`create-site` 遇到已有 `frontend` 会跳过创建。不得使用 `down -v` 删除现有数据库，或改 project 名称创建第二套 volumes。Lima 转发 guest 3088 → host `127.0.0.1:3088`；DB/Redis 不发布宿主端口。

## 初始化虚构验收资料

`bootstrap.py` 创建 Example Trade Demo / EX-01 的 USD 法人、叶子客户组/供应商组/区域、两种非库存样品 SKU、USD 价目表、会计科目和受限集成用户。标准角色包括 Sales/Purchase Manager、Sales/Purchase Master Manager、Stock Manager、Accounts Manager/User；不授予 System Manager。自检所需单据创建和 GL 读取权限通过后才输出初始化成功；输出不含凭据。

```sh
sudo docker compose -p tradept-erp --env-file /private-config/erpnext.env -f compose.yaml cp bootstrap.py backend:/tmp/trade-bootstrap.py
sudo docker compose -p tradept-erp --env-file /private-config/erpnext.env -f compose.yaml exec -u root -T backend chmod 644 /tmp/trade-bootstrap.py
sudo docker compose -p tradept-erp --env-file /private-config/erpnext.env -f compose.yaml exec -T backend /home/frappe/frappe-bench/env/bin/python /tmp/trade-bootstrap.py --site frontend --output /tmp/private-trade/erpnext.json
```

从容器复制生成配置回 Trade 的 APFS 私有 runtime `erpnext.json`，设为 `0600`；文件不能留在源码 SMB 目录或前端。一个 Trade 租户对应独立 origin 与 Frappe site；本地代理固定 site header，不能仅修改 site 字段隔离租户。同站点共享 Customer/Supplier 不能替代租户隔离。Grandware 没有 ERP 配置，不发送其真实数据。

企业接入需明确公司/币种、叶子 `customerGroup`、`supplierGroup`、`territory`、价格表及会计科目等实际映射；缺少或使用分组树根节点时，排队返回 `MASTER_DATA_MAPPING_REQUIRED`，远端零写入。服务器管理 origin/site/凭据，浏览器无法指定 ERP URL、DocType 或密钥。

## 明细、队列与管理员批次 worker

财务角色在设置页“商品明细”编辑已有 ERP SKU、数量、销售单价、采购单价及供应商。每行稳定 ID，明细销售/采购合计分别必须等于已保存订单金额/成本；ERP 实际计算的币种和 `grand_total` 也须一致，否则保留部分单据映射并 blocked。

当前只支持明确映射的 USD 结算法人。采购成本优先读取 `factoryCostUSD`；历史 `factoryCostRMB` 只有私有法人配置明确 `legacyPurchaseCostCurrency: "USD"` 时才能作为既有 USD 成本使用，缺映射/CNY 均 blocked。bootstrap 只为虚构 Example 配置这个兼容项，不能用于 Grandware 的真实人民币成本；不自动做 FX 转换或重命名金额。

财务显式将订单排队后，管理员在本机执行有限批次：

```sh
python3 -m server.erpnext_cli --runtime /private-runtime/trade run --limit 10
```

本轮没有常驻 Trade outbox 轮询或定时调度；点击排队本身不会自动持续执行。Frappe 容器自带 queue/scheduler 也不负责 Trade 的 outbox。worker 创建标准 Customer/Supplier 和 SO/分供应商 PO 草稿。SQLite 入队与远端 ERP 提交为独立事务；持久外部唯一 ID 支持丢响应/部分成功重试。ERP 外部修改、已提交单据、关联采购的明细/供应商迁移阻断静默覆盖。

界面状态是 bridge 最近确认的 ERP 单据元数据，非 ERP 外部变更实时回读。synced 表示该队列内容已完成草稿同步，不能当作已出运或已收款。

## 真实提交验收

仅对虚构 Example 的 USD 1000 销售、USD 700 两供应商采购订单使用：

```sh
python3 integrations/erpnext/acceptance.py --runtime /private-runtime/trade --order-id EX-ORDER-DEMO --report docs/erpnext-real-acceptance.json --submit-fictional-demo
```

脚本显式提交标准 SO/PO、创建并提交 DN/PE，回读交付率、收款与总账；严格限定 loopback/frontend/Example，按持久映射复用同一单据。实测结果为 SO 1000、PO 420/280、DN 数量 100、PE 1000、GL 借贷各 1000。源业务 payload/revision 与其他租户均不变，Trade 已收金额仍为 0。

提交只是独立虚构验收能力。常规产品界面本轮交付草稿同步；正式提交审批、取消/amend、双向业务回写、跨币种采购、库存与税费模板须后续开发。验收脚本不能充当生产自动收款流程。
