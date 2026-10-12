# 统一本地测试环境恢复

恢复复用 Lima `tradept-erp`、原 project `tradept-erp` 和持久 volumes。应用为自定义 `tradept-erpnext-unified:0.2.0` 镜像；ERPNext 16.32.3 / Frappe 16.31.0。两个独立站点为 `grandware.test` 与 `frontend`。公网 0.1.1 测试实例保持独立，不在此流程中更新。

## 当前实际位置

- Lima home：`/Users/wangyao/.tradept-lima`，VM 为 VZ ARM64、4CPU、4GiB RAM、20GiB 稀疏盘，无宿主目录挂载。
- limactl：`/Users/wangyao/.codex/visualizations/2026/10/11/01a12ab3-4b8a-7240-ab2a-0f86986c7d99/.trade-erpnext-runtime/tools/bin/limactl`。
- Guest 私有目录：`/home/wangyao.guest/trade-private`，0700；既有 `erpnext.env`、新 `unified-image.env` 为 0600，不覆盖原密码。
- Guest compose：`compose-unified.yaml`、`tradept-sites.map.conf` 与 `tradept-frappe-nginx.conf.template`；原 `compose.yaml` 仍保存作为迁移前基线。
- 网关 runtime：上述 APFS visualization 目录下 `.trade-unified-gateway`，0700；`frappe-sites.json` 为 0600。
- 原数据私有备份：同级 `.trade-unified-infra-20261012/backups`。`sqlite/pre-unified-20261012.sqlite3`、`sqlite/grandware-source-snapshot.json`、`original-grandware` 与 `erp/frontend-20261012` 保存迁移前原始资料。
- 最终双站宿主备份：同一私有目录的 `backups/erp/unified-final-r5-complete-20261012/{frontend,grandware.test}`；每站SQL、公开文件、私有文件与site_config共四份，manifest SHA256为 `cb5155a58695cf25c24e453641c1f4a9bdbd018ec36d06636c8bac0cc7b69f37`，八份文件已在guest及宿主分别校验SHA/0700目录/0600文件。
- 最终guest副本：`/home/wangyao.guest/trade-private/unified-native-backups/unified-final-r5-complete-20261012`；原生持久卷内原档：`/home/frappe/frappe-bench/sites/SITE/private/tradept-native-backups/unified-final-r5-complete-20261012`，`SITE`分别为`frontend`与`grandware.test`。

迁移前原 frontend 已使用 `bench --site frontend backup --with-files --ignore-backup-conf` 产生数据库、公开文件、私有文件和 site_config 四份备份。目录0700、文件0600，通过本地 Lima SSH/SCP 复制至宿主，manifest 记录哈希。原 SQLite 使用 backup API 产生一致备份并通过 quick_check。完整备份含账号/配置和原业务数据，不能放入 Git、前端或公共云镜像。

已在新建未映射 `tradept-restore-check.test` / 独立数据库实际恢复迁移前 frontend 的 SQL、公开和私有文件，恢复后 SO1/PO2/DN1/PE1/GL2，借贷各1000，原单据财务哈希与当前frontend基线相等。恢复站点启用 maintenance mode、暂停scheduler，Nginx站点白名单不包含它；在用两个租户未被覆盖。纯元数据证据为私有 `backups/erp/restore-probe-receipt.json`。原5单据没有重新提交。[restore_probe.py](restore_probe.py) 拒绝覆盖已存在的恢复站点，读取私有 stdin 参数并核验四份备份SHA后才建独立库。

## 启停与故障判断

宿主：

```sh
export LIMA_HOME=/Users/wangyao/.tradept-lima
TRADE_LIMACTL=/Users/wangyao/.codex/visualizations/2026/10/11/01a12ab3-4b8a-7240-ab2a-0f86986c7d99/.trade-erpnext-runtime/tools/bin/limactl
df -h /Users/wangyao
sysctl vm.swapusage
"$TRADE_LIMACTL" list
"$TRADE_LIMACTL" start tradept-erp
"$TRADE_LIMACTL" shell tradept-erp
```

guest：

```sh
sudo docker compose -p tradept-erp --env-file /home/wangyao.guest/trade-private/erpnext.env --env-file /home/wangyao.guest/trade-private/unified-image.env -f /home/wangyao.guest/trade-private/compose-unified.yaml ps -a
sudo docker compose -p tradept-erp --env-file /home/wangyao.guest/trade-private/erpnext.env --env-file /home/wangyao.guest/trade-private/unified-image.env -f /home/wangyao.guest/trade-private/compose-unified.yaml up -d
sudo docker exec tradept-erp-frontend-1 nginx -t
```

宿主可用匿名只读请求判断固定站点路由：`/api/method/ping` 在两个已知站点应被业务 RPC 守卫拒绝为403，未知 `X-Frappe-Site-Name` 应为404；进一步健康验收使用配置账号登录和业务回读，不能把匿名403当作服务故障。未知值不得访问默认租户。DB3306/Redis6379 不公开，Lima 仅转发 loopback3088。网关不可回退到旧 SQLite API，旧3086静态站点和旧3087 API 已停止。

原生管理入口分别为 Example `http://127.0.0.1:3088/`、Grandware `http://grandware.localhost:3088/`。固定 Host/site map 和 server-level 守卫覆盖静态资产；未知 Host、未知 site 或 Grandware hostname 携 Example site 头均404。浏览器已实际验证 Grandware Desk 可以列出原四公司；跨站 SID 不通用。原生管理员配置保存在私有 `native-admin-credentials.json`，不能把密码填入公共 compose。

本次迁移前 VM 内存可用约2.68GiB、磁盘可用约12.18GiB；宿主 APFS 可用约10.56GiB，这是本机实测预算。启动/重建前重新检查。宿主可用低于4GiB或 swap 快速增长时停止本任务 VM，保留磁盘，不继续拉取镜像。当前2GiB共享云主机没有足够稳定预算承载新增统一ERP服务，不能在其上挤占 Kuohu；未采购新云资源。

## 镜像与数据持久化

持久 volumes：`tradept-erp_sites`、`tradept-erp_logs`、`tradept-erp_db-data`、`tradept-erp_redis-queue-data`。`apps/tradept_core` 属于镜像，业务数据库属于 MariaDB volume；容器重建不能改变 project 名称或删除 volumes。

固定基础镜像为 `frappe/erpnext@sha256:a9dea1cc498aa08010eb3567f1808c7bed98e4b9d17dcbd4265791c9ad00971e`。镜像构建和 apps.txt 的恢复见 [README.md](README.md)。源码升级后对每个站点执行 `bench --site SITE migrate`，重启本任务 ERP 服务使 workers 使用同一源版本。先备份再升级，不能仅替换活容器内文件。

## 备份与恢复边界

备份指定站点，不改另一站点：

```sh
sudo docker exec tradept-erp-backend-1 bench --site frontend backup --with-files --ignore-backup-conf
sudo docker exec tradept-erp-backend-1 bench --site grandware.test backup --with-files --ignore-backup-conf
```

使用 Frappe [backup](https://docs.frappe.io/framework/user/en/bench/reference/backup) / [restore](https://docs.frappe.io/framework/user/en/bench/reference/restore) 工具恢复数据库与两个文件归档。恢复前停止该站点写入，核对 backup manifest、site_config 的 encryption_key 与镜像版本；数据库根密码仅从既有私有 env 在进程内读取。先恢复到独立隔离站点核验，再决定原站点切换，不直接覆盖唯一当前库。

[backup_sites.py](backup_sites.py) 在 guest 内为两个站点分别执行原生完整备份，要求调用者先停止工作台、原生管理员及业务任务的写入。指定全新 `--backup-id`，工具拒绝覆盖历史目录；每站保留 SQL、公开文件、私有文件与 site_config 四份文件，目录0700/文件0600。manifest 比较前后业务投影、汇率/配置、所列原生单据父表/账本、公私文件内容SHA，同时要求两站数据库哈希不同；完整SQL备份覆盖全库，内容比对只针对所列范围。通过 Lima SSH/SCP取回宿主私有目录后再核验SHA，不把原始备份加入Git。

迁移前 frontend 备份记录旧系统原生单据基线；迁移后的双站完整备份包含新 `tradept_core` 的 workspace、profile、审计和快照。恢复后核对两个 DB 名称哈希不同、Grandware 67条资料（含软删除）及21条历史订单逐字段无损、原 Example SO/2PO/DN/PE/2GL 财务指纹、账号登录和 CAS 409。本轮虚构新单据与其新增总账单独按来源统计，不与迁移前基线混淆。不能把 SQLite 恢复为当前主业务库，不能再次提交已存在财务单据。旧 broad integration 用户已禁用，私有历史配置只保留为备份。

Frappe16默认`private/backups`清理函数把子目录当可删除文件处理，会触发`IsADirectoryError`。本任务原始四文件归档已原子迁至`/home/frappe/frappe-bench/sites/frontend/private/tradept-backup-archives/tradept-unified-20261012`，迁移前后四文件SHA全部相等；宿主迁移前副本不变。自定义归档不再嵌套默认backup目录，ERPNext/Frappe core未修改。后续恢复演练的私有stdin应引用当前归档路径或重新上传已核验的宿主副本，不引用历史receipt中的旧物理位置。

最终完整镜像ID为`sha256:f627c2d8f15b94aa1b4c3c54805a4d1f9faf600fc7a04fb4273496d69f8fa474`，17个应用源文件绑定manifest `2c80f89e9d0c3f3205a3306167833cea98bdb4668adc8a7f0be6adda85d08bfc`。六应用实际重启后，Example revision55、Grandware revision3，业务/汇率/配置、所列原生单据/账本和文件SHA保持一致；数据库/Redis容器身份、启动时间与volumes均未变。Root独立验证backend停止时网关返回503且不提供旧SQLite数据，恢复后配置账号登录与原业务可回读。

Docker 的既有官方 TLS 兼容设置与代理仅为此机器网络使用。不要关闭证书验证、不使用 insecure registry，也不要把本机代理或 API key 写入公共模板。纯源码和可信离线 wheels 的镜像构建可使用 `--network=none`；迁移私有资料不进入镜像层。
