# 企业私有部署：邮箱登录与 Tradept 品牌

本轮实现日期：2026-10-13。适用企业私有域名、单企业单站点部署；同一企业可包含多个法人公司。没有切换既有云端 0.3.0，也没有覆盖两个既有演示企业库。

## 登录行为

- 首次部署用管理员账号和密码登录企业初始化；完成邮箱验证后，登录页切换为邮箱和密码。站点由服务器固定配置决定，无工作区选择。
- 网关配置只有一个 tenant 时自动固定；旧测试配置可以显式增加 `privateTenant`，但该网关只允许访问此租户，其他原有租户 Cookie 失效。其他站点数据库不删除。
- 原生会话必须属于已启用邮箱政策的成员，或处于初始化中的指定管理员。初始账号只能配置企业，不能新增成员或执行业务写入；业务查询返回空数据。
- 管理员配置三种准入模式：多个精确邮箱域名、具体邮箱地址、所有邮箱。域名不隐含授权其子域；所有邮箱模式仍要求邀请和验证。
- 管理员创建成员时生成不对用户展示的随机初始口令，邀请邮件进入原生 Email Queue。成员打开一次性链接，验证邮箱并设置自己的密码，随后重新登录。没有密码或明文 token 响应返回给管理员。
- 重发邀请强制撤销会话并要求重新设置密码；一分钟内重复请求复用先前请求的处理状态，避免邮件轰炸。成员停用或白名单变更，在后续请求上由服务端检查。
- 找回密码在 Tradept 完成，响应不泄露邮箱是否存在。原生 reset hash、User 密码和会话是唯一账号权威；不建立第二套密码数据库。
- 设置密码要求 12–128 位，执行原生强度策略并拒绝使用原密码。链接一小时过期；按工作区与 User 行加锁，一次性消费，清除旧会话。token 放在 URL fragment，页面读取后立即清除地址栏中的 token。
- 第一版不增加二次验证。邮箱激活证明邮箱控制权，不等同于 MFA。
- 已有登录会话时，邮件设置密码页面优先于自动恢复工作台；支持新标签及同一标签的激活链接。只打开页面不撤销原会话，提交有效新密码后才按账号流程撤销会话。
- 企业邮箱政策针对 Tradept 身份。启用的原生 System User 只有在既无 Trade User Profile、也无 Tradept 原生角色时，才能保留原生认证及 ERP 权限；Administrator 保留恢复边界。Website User 或残留 Tradept 角色不能使用此例外，工作台 dispatch 仍必须有成员资料，原生 REST/RPC 限制保留。

## 首次启用

先备份、冻结待部署源码、安装应用并 migrate。当前发布采用部署时生成唯一初始管理员账号及密码，不要求提前提供真实邮箱、白名单或 SMTP。没有通用默认密码。

本次部署入口为 `tradept_core.login_setup.provision_deployment(credentials_output="/绝对路径/私有目录/initial-admin.json")`，仅原生 Administrator 可通过 bench 调用，未暴露为浏览器 RPC。父目录必须预先建立且权限为 0700；凭据文件必须不存在，使用排他创建写为 0600，返回值和日志不包含账号密码。调用方负责提交事务、确认凭据对应的真实登录可用、经私有渠道交付凭据。事务回滚会删除尚未生效的凭据文件；重复运行拒绝重置已有管理员或覆盖文件。

该入口在现有 workspace 上新增独立 Profile ID，授予配置内所有现有公司的原生 User Permission，并应用已有细粒度财务管理员模板和标准管理员商品权限模板。它不重建企业、公司、团队或历史归属。原 Tradept 成员/角色账号被停用，密码及 API secret 被撤销，API key/重置链接清空，OAuth bearer 置 Revoked 并清除 refresh token，原 SID 在同一数据库事务内删除，提交后才清理 Redis 会话缓存，回滚保留旧会话；User/Profile 及历史成员 ID 保留。

被移出私有入口的 Example 站点由部署负责人调用 `tradept_core.login_setup.retire_workspace_access()` 停用原工作台账号，保留资料；该方法拒绝对已经完成私有配置的站点误执行。原生 Administrator 和非 Tradept 运维用户不由上述批处理停用。此次原生 Administrator 运维密码及旧会话由部署负责人单独轮换，外部初始管理员与运维账号分离。网关固定指向 Grandware，生产不启用演示选择器。

以下手工配置入口仅为已有部署工具的兼容方式，本次发布使用上述自动生成入口：

准备 0600 的管理员初始化 JSON（真实文件不能提交，执行后删除）：

```json
{
  "administrator": {
    "id": "enterprise-admin",
    "name": "企业管理员",
    "username": "initial-admin",
    "password": "替换为独立的12至128位安全密码",
    "visibleCompanyIds": []
  }
}
```

以原生 Administrator 在对应站点执行 `tradept_core.enterprise_login.provision_private_access(configuration="/绝对路径/private-login.json")`。该方法只允许未初始化的站点执行一次，拒绝覆盖已经启用的登录规则。初始用户名使用 3–64 位小写字母、数字、点、下划线或连字符，并以字母开头；不允许 Administrator/Guest。内部建立不可用于收信的占位身份，界面使用账号密码登录。

首次登录后的步骤：

1. 完善企业资料、经营主体及组织资料。
2. 在“邮箱登录”中填写企业 HTTPS 私有域名、管理员真实邮箱，选择域名白名单、指定邮箱或所有邮箱。可先保存，不发送邮件，也不切换登录方式。
3. 在“业务准备”中配置 SMTP，启用发信并设为默认发信邮箱。凭据由原生 Email Account 存储。
4. 回到“邮箱登录”，勾选“SMTP 已配置，保存并发送管理员验证邮件”。管理员邮箱必须符合白名单；配置变更会使旧验证链接失效，可重新发送。
5. 管理员打开邮件并设置新的个人密码。服务端在同一事务中验证一次性 token，启用邮箱政策，绑定原管理员成员 ID、角色及公司/邮箱权限，停用初始账号并撤销会话。随后使用真实邮箱和新密码登录。

验证前，初始账号仍能继续配置；发信失败或链接过期不能提前切换。未验证的邮箱不能登录。保留原生 Administrator 作为受控运维恢复入口，不能作为工作台账号。完成邮箱验证前不能将初始化标记为完成。普通成员在切换后由管理员邀请进入。

网关私有配置推荐只包含一个 tenant：

```json
{
  "tenants": {
    "enterprise": {
      "origin": "http://127.0.0.1:3088",
      "site": "enterprise.example",
      "gatewayHmacKey": "替换为原站点匹配的独立64位十六进制密钥"
    }
  }
}
```

tenant ID 必须等于已初始化工作区 ID。网关 `--public-origin`、反向代理域名、邀请策略 `publicOrigin` 必须一致。原生 backend、数据库和 Redis 不对公网开放；Desk 管理入口按实际部署访问策略开放。原生 `host_name` 也应设为经审核的企业地址，避免恢复邮件沿用错误域名。

保存企业域名不会自动修改 DNS、证书或反向代理；部署时使它们与配置一致，再发送验证邮件。必须先确认 SMTP 真正发出且管理员收到邀请，再验收正式入口。`emailDelivery: queued` 只表示队列接受，不代表送达。

## 现有双演示站的显式兼容

此模式仅用于已有多个演示企业的测试入口，由服务器私有路由配置显式开启，不是新企业部署的默认行为。现有站点没有真实邮箱/SMTP时，不能仅更新登录页面就强制切换邮箱身份。

```json
{
  "demoMode": true,
  "demoTenants": ["grandware", "example-company"],
  "tenants": {
    "grandware": {"origin": "原固定后端地址", "site": "原站点名称", "gatewayHmacKey": "保留原独立密钥"},
    "example-company": {"origin": "原固定后端地址", "site": "原另一站点名称", "gatewayHmacKey": "保留原另一独立密钥"}
  }
}
```

示例 ID 必须与实际配置一致；不得猜测或重新生成正在使用的站点密钥。`demoMode` 必须是真正的布尔值，`demoTenants` 必须显式列出非空、唯一且已经配置的企业 ID，不能同时设置 `privateTenant`。公开登录配置仅返回这些 ID，不公开原生域名、后端地址、用户或密钥。未列入名单的站点从网关可访问范围移除，旧 Cookie 也不能访问它。

登录页显示“演示企业”，必须主动选择，无默认企业；原账号名称和密码流程保留。登录仍由所选原生站点验证，返回会话的企业 ID 必须与路由匹配；Cookie 签名、CSRF、工作台成员要求和财务权限不变。演示模式隐藏未配置的邮件找回入口，服务端也拒绝恢复请求，不根据邮箱或客户端参数猜站点。多站点配置未显式选择此模式时，登录入口保持关闭。

用户已明确此次发布不保留演示账号，因此本次生产不启用此兼容模式。兼容代码及测试保留用于隔离 QA；实际私有部署使用单站点或明确 `privateTenant`，移除 demo 配置，部署生成初始管理员并停用旧演示账号，SMTP 与邮箱政策在初始化时填写。

## Desk 品牌与开源义务

使用原生 Website Settings、Navbar Settings、boot hook 和本应用静态资源：网页标题、图标、导航标识、v16 应用显示名及网站页脚显示 Tradept。原生应用标识、DocType 名、API 名及业务文档内容保持原样，不做全局字符串替换。上游原有 About/许可证内容不删除。

`/tradept-licenses` 和 Desk 中“Tradept · 开源许可与来源”入口保留上游版权、无担保条款、再分发权利、来源说明及完整 GPL/MIT 许可。许可证直接取自当前安装镜像原件，位于 `tradept_core/public/licenses/`。

品牌调整不等同于拥有上游著作权或官方背书。对客户分发私有部署镜像/安装包时，必须同时满足适用 GPL 对应源码交付要求，提供对应版本及修改、构建安装资料，不能只给上游仓库链接。此次没有对外分发镜像或声称完成法律认证。

构建工具已包含 public 资源、许可证及 www 页面。部署时运行 `bench build --app tradept_core` 生成本应用 assets 链接；backend 与 frontend 必须使用同一版本镜像及 assets。迁移后核验四类资源（JS/CSS、图标、许可证、法律说明页面）HTTP 200，再验收登录与 Desk 的实际画面。

依据：
- https://frappe.io/erpnext/license-trademark
- https://github.com/frappe/erpnext/blob/v16.32.3/license.txt
- https://github.com/frappe/frappe/blob/v16.31.0/LICENSE

## 与其他对话的边界

2026-10-13 读取“开发”对话：正在实施应收、应付、核销、账龄和细粒度财务权限。读取“完善”对话：进行产品差距研究，并保留云端 0.3.0 发布基线。

本次独立模块：enterprise_login.py、login_policy.py、branding.py、enterprise-login.js、login-policy-admin.js、Desk public/www 资源及独立认证测试。公共接线集中在 administrator、hooks/install/request_guard、session DTO、网关与 bootstrap；没有修改财务流程实现、财务权限规则和财务测试来消除对方开发中的失败。发布前必须从同一冻结源码合并验收，不能从持续变化的共享目录直接发布。

统一发布收尾时，由财务侧维护 `permissions.is_workbench_user` 与 `domain.NATIVE_ROLE_PREFIX`，登录模块直接复用其原生身份分类。此前口述的 unprefixed 测试名称并不存在；核对对象是现有 RPC/v2、cmd 伪装、原生操作员、token 身份先解析等测试，不创建或恢复一个并不存在的测试基线。

## 当前验收边界

独立 Frappe 认证测试站点为 `tradept-login-review-20261013.test`，不经过现有原生入口域名白名单。认证检查使用真实 User、密码哈希、数据库锁及重置键；邮件 transport 被拦截，业务快照调用使用 mock。测试成员事务最后回滚，站点保留测试 schema/工作区，没有对原企业库创建测试成员。

真实域名、管理员邮箱、白名单和 SMTP 在企业初始化时填写；实际 SMTP 送达和最终 Desk 浏览器验收仍需真实部署与冻结版本。不能将单元测试、队列接受或品牌配置写入当成已上线/已送达。

### 部署与会话事务补充验收

独立 auth-only 站点通过 94 项原生验证，包括真实 SID、密码激活和部署过程禁止隐式 commit、注入审计失败后恢复账号/密码/配置/SID并删除凭据文件、savepoint 回滚后提交保留缓存、完整回滚保留会话、成功提交清理数据库与 Redis。会话查询直接使用 `sid`，不使用没有 `name` 字段的 Sessions 表执行通用 DocType exists 查询。测试邮件和业务快照使用替身；未验证真实收件，也不代表最终合并镜像或 Grandware 四公司数据验收。最终发布必须包含 `session_security.py`。

私有启动与旧演示站账号退役同时持久化 `allowNativeSignup=false`，防止后续 migrate 按旧配置重新开放原生注册。原生验收调用实际 install 入口验证初始化中、已激活、已退役三种配置的访问设置；仅跳过最小 auth 站点不具备的业务 schema、静态资源及品牌写入，完整镜像 migrate 仍由统一发布验收。

管理中心成员事务新增真实 LoginManager.logout 调用链验证：停用、System User 转 Website User、更新密码分别在 Profile 实际写入后注入失败，禁止隐式提交，回滚恢复 User、roles、__Auth、Profile、工作区配置及 SQL/Redis 会话。成功路径真实 commit 后会话才全部失效。LoginManager 使用真实类和真实方法，仅不执行会启动新登录的构造器；此测试不是完整 HTTP 请求验收。

部署初始化显式调用商品权限模板，给已有标准 admin 角色补齐 `catalog.read/create/write/disable`，不会仅依赖新 DEFAULT_ROLES，也不扩展 finance 或自定义角色。初始化 guard 允许 `catalog_template` 权限配置，继续拒绝 `catalog_state/catalog_operation` 业务读写。独立登录探针只验证权限及初始化边界；商品 Item 业务验收属于统一候选镜像。
