# 腾讯云选择与购买（供 AI 执行）

返回 [guide](guide.md)。按域名 → 服务器 → 备份的顺序问，每次只处理当前选择。下列引用话术是你向主人的提问，不是让主人执行技术命令。

本文的金额是主人希望筛选的**首年人民币预算范围**，不是实时保证价。你用企业账号的 tccli 查询，再核对活动资格和结算页；同时展示首年价、续费价、额外收费和查询日期。旧询价文档只供参考，不能代替当天报价。

## 1. 域名

先问是否已有企业域名；有就优先使用 `trade.企业域名`，通常无需另买。没有再问：

> 这个网址主要给企业内部使用。你想选便宜域名，比如首年几元钱的，还是普通域名，比如几十元起的 .com？我会查实际价格和续费价。

主人选择档位后，再请他给出喜欢的名字；你结合当前可售后缀提出 2–3 个候选，逐个查询是否能注册。首次低价不代表续费也便宜。若服务器准备放大陆，域名还须符合备案要求，不能只按最低价选后缀。

```sh
tccli domain DescribeDomainPriceList \
  --TldList '[".com",".cn"]' --Year '[1]' --Operation '["new","renew"]'
tccli domain CheckDomain --DomainName <主人选择的完整域名> --Period 1
```

上面后缀为示例；低价档先查[官方域名活动](https://cloud.tencent.com/act/pro/domain-sales)，把实际可售后缀代入查询。注册查询读取 `Available`、`Reason`、`Premium`、`RealPrice`、`FeeRenew`；续费还要对照价格列表。域名 API 不要求 Region。查询可注册不是已买到；溢价词或超预算时说明价格并给替代名字。依据：[域名注册查询](https://cloud.tencent.com/document/api/242/38894)、[价格列表](https://cloud.tencent.com/document/api/242/38893)。

主人确定可用域名后，你准备好[域名注册入口](https://dnspod.cloud.tencent.com/)和具体选项：域名、1 年期限、企业实名模板、首年费、续费费及是否自动续费。由主人核对并付款；你回查订单和域名持有状态再记录“已购买”。域名与邮箱是两回事，不必因买域名再买邮箱。

## 2. 服务器地域

> 服务器想放中国大陆，还是大陆之外？大陆先按一年 100–200 元找活动；大陆之外先按一年 200–1000 元找。大陆员工访问境外可能慢一些，但境外服务器无需中国大陆 ICP 接入备案。实际价格和速度我会再核对。

价格范围不含域名、额外备份和超额流量；没有符合预算的现货或账号无活动资格，就给出实际报价，让主人决定换地域、加预算或用已有服务器。不要承诺每个地域都买得到该价。

主人选大陆：问主要办公城市，查询附近地域；通过公网域名使用时按下面步骤指导备案。主人选大陆之外：

> 你想放首尔、雅加达、曼谷、香港，还是新加坡？我会查当前可购买的套餐；员工主要在哪儿使用，也请告诉我。

| 选项 | API 地域标识 |
|---|---|
| 首尔 | `ap-seoul` |
| 雅加达 | `ap-jakarta` |
| 曼谷 | `ap-bangkok` |
| 中国香港 | `ap-hongkong` |
| 新加坡 | `ap-singapore` |

你先用 `DescribeRegions` 确认可用地域，再查询该地域套餐。某地域没有轻量资源时明确说明，可比较 CVM 或其它已列地域。跨境访问速度按员工网络试用，不能把所有境外地域统一判定为慢。

## 3. 服务器配置

> 你想“够用就好”，还是选“推荐配置”？我会把两档当天可买的配置和总价列给你。

| 档位 | 初始筛选方式 | 怎么向主人解释 |
|---|---|---|
| 够用就好 | 优先低价 Linux 轻量套餐，尽量 2 核 4 GB，使用套餐自带 SSD | 先控制费用，实际导入、报表和多人使用要测试 |
| 推荐配置 | 在所选地域比较 4–8 GB 内存；可选 2 核 8 GB 或 4 核 8 GB | 数据库和后台任务有更多余量，通常更贵 |

2 核 2 GB 可以列为更低价试用选项，但完整 Tradept／ERPNext 尚无此容量通过生产验收的证据。不要仅因为落在预算内就承诺够用。任何档位都要验收；镜像构建内存需求和运行内存需求分别评估，小主机优先载入预构建镜像。

命令模板：

```sh
tccli lighthouse DescribeRegions --region ap-guangzhou
tccli lighthouse DescribeBundles --region <所选地域> --Limit 100 --Offset 0
tccli lighthouse DescribeBlueprints --region <所选地域> --Limit 100 --Offset 0
tccli lighthouse InquirePriceCreateInstances \
  --region <所选地域> --BundleId <查询得到的套餐ID> \
  --InstanceChargePrepaid '{"Period":12}' --InstanceCount 1
```

套餐、镜像均按实际返回分页，筛选 Linux、可售状态和匹配架构。Ubuntu 24.04 LTS／x86_64 可作为初选，须与发布镜像匹配。询价读取 `Price.InstancePrice.DiscountPrice`、`OriginalPrice` 和 `Currency`。API 普通询价可能没有活动优惠，去[官方服务器活动](https://cloud.tencent.com/act/pro/2024spring)核对企业账号资格和结算价，不能用普通价否定活动，也不能拿宣传价当已确认订单。[轻量 API 概览](https://cloud.tencent.cn/document/product/1207/47579)、[创建实例询价](https://cloud.tencent.cn/document/api/1207/55558)。

需要企业 VPC、扩容或轻量没有合适资源时，改查 CVM：先 `tccli cvm DescribeInstanceTypeConfigs --region <地域>`，再依当天 API 参数生成 `InquiryPriceRunInstances` 的完整请求，包含实例、系统盘、带宽、期限及数量。不要把 CVM 主机裸价当总价。[CVM API 概览](https://cloud.tencent.com/document/product/213/15689)。

最终只给主人看 2–3 个可买方案：地域、CPU／内存、SSD、带宽／流量、首年合计、续费规则、需不需要备案。说明选中的一档及取舍，不默认加数据盘、云数据库或负载均衡。

你在[轻量控制台](https://console.cloud.tencent.com/lighthouse)或 [CVM 控制台](https://console.cloud.tencent.com/cvm)准备具体订单。付款前请主人核对地域、Linux 镜像、配置、数量 1 台、期限、首年总价和续费设置，再由他完成付款。若主人明确授权 API 下单，只针对已确认的完整订单执行。付款后用对应 `DescribeInstances` 确认实例 ID、运行状态、IP 和到期时间；订单成功还不等于应用部署成功。

## 4. 大陆服务器备案

通过大陆服务器的公网域名提供网站时，即使只供员工使用，也按适用要求办理备案。境外服务器无需中国大陆 ICP 接入备案。仅经公司内网／VPN 访问的方案，先向腾讯云核对实际接入要求，不能仅凭“内部使用”判断免备案。

你说明并指导主人在[腾讯云备案控制台](https://console.cloud.tencent.com/beian)完成：

1. 检查所购大陆资源是否符合备案资格；目前 CVM／轻量包年包月累计至少 3 个月，备案时剩余至少 1 个月等要求须当天复核。
2. 检查域名后缀可备案、企业实名完成、主体信息一致。
3. 准备营业执照、主体及网站负责人资料，填写网站用途、域名和服务器信息。
4. 主人完成证件提交、人脸／短信验证；你跟踪审核并按退回原因协助修改。
5. 备案通过并完成接入后再开放公网网站，按要求展示备案号及办理后续事项。

等待期间你继续完成服务器安装和私有通道验收。不要把“已提交”写成“备案通过”。依据：[备案云资源](https://cloud.tencent.com/document/product/243/18908)、[备案常见问题](https://cloud.tencent.com.cn/document/faq/243/73180)。

## 5. 数据备份

> 需要数据备份吗？可以额外付费，把备份放在企业私有云存储；也可以不买云备份，把备份下载到你或运维人员的电脑。只放在同一服务器里，服务器坏了仍可能一起丢失。你想选哪种？

云备份、电脑备份按[备份与验收](Tradept-备份与验收.md)落地。云备份另报容量、存储、请求和下载费用，主人确认后购买。电脑备份先确认接收电脑、保存目录、频率和负责人；不因此把在线业务数据库迁到电脑。主人明确不备份时记录选择和风险，交付标明“未配置备份”，不能填“恢复验收通过”。
