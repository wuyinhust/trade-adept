# customLogin 云函数部署指南

## 前置条件

- CloudBase 环境 `grandware-d9gb4owez89cb9df9` 已创建
- 拥有 CloudBase 控制台管理权限

## 部署步骤

### 1. 上传云函数

1. 打开 [CloudBase 控制台](https://console.cloud.tencent.com/tcb) → 选择环境 `grandware`
2. 左侧导航 → **云函数** → 点击 **新建云函数**
3. 配置：
    - 函数名称：`customLogin`
    - 运行环境：`Node.js 18.x`（或更高）
    - 超时时间：`10` 秒
    - 内存：`256 MB`
4. 上传方式选择 **本地上传文件夹**，选择 `cloudfunctions/customLogin/` 目录
5. 确认 package.json 和 index.js 都已上传

### 2. 配置环境变量

在云函数详情页 → **环境变量** 中设置：

| 变量名          | 值                             | 说明                                             |
| --------------- | ------------------------------ | ------------------------------------------------ |
| `SHARED_SECRET` | 自定义随机字符串（至少 16 位） | 客户端调用密钥，与 cloud.js 的 CLOUD_SECRET 一致 |
| `TCB_ENV_ID`    | `grandware-d9gb4owez89cb9df9`  | CloudBase 环境 ID                                |

### 3. 配置 HTTP 触发器

在云函数详情页 → **触发器** → **新建触发器**：

- 触发方式：`HTTP 触发器`
- 路径：`/customLogin`
- 鉴权方式：`免鉴权`（由 SHARED_SECRET 保护）

### 4. 安装依赖并测试

云函数部署后会自动安装 package.json 中的依赖（`@cloudbase/node-sdk`）。
部署完成后，在 **函数测试** 页面发送测试请求：

```json
{
    "username": "David",
    "passwordHash": "f283230b435d9874fd9ff9aa7c7522f4e67c437c2ed9222992bba1e50965eddf",
    "secret": "<你设置的 SHARED_SECRET>"
}
```

预期响应：

```json
{
    "statusCode": 200,
    "body": "{\"ok\":true,\"ticket\":\"...\",\"user\":{...}}"
}
```

### 5. 更新客户端配置

部署成功后，在 `js/cloud.js` 中更新以下配置：

```js
CLOUD_SECRET: '<你设置的 SHARED_SECRET>',
CLOUD_FN_URL: 'https://grandware-d9gb4owez89cb9df9.service.tcloudbase.com/customLogin',
```

### 6. 升级数据库安全规则（可选）

部署自定义登录后，可将数据库安全规则升级为需要身份验证的版本：

```json
{
    "read": "auth != null",
    "write": "auth != null && doc.dataType in ['gw_data', '_diag_test']",
    "create": "auth != null && (doc.dataType == 'gw_data' || (doc.dataType == '_diag_test' && auth.custom.role == 'admin'))",
    "update": "auth != null && doc.dataType in ['gw_data', '_diag_test']",
    "delete": false
}
```

> ⚠️ 升级安全规则前请确认自定义登录已正常工作，否则会导致所有用户无法访问数据库。
> 如果出现问题，可以随时回退到匿名模式的安全规则。

### 故障排查

| 现象                | 可能原因                           | 解决                                              |
| ------------------- | ---------------------------------- | ------------------------------------------------- |
| 云函数返回 403      | SHARED_SECRET 不匹配               | 检查环境变量和 cloud.js 的 CLOUD_SECRET 一致      |
| 客户端降级匿名登录  | 云函数 URL 不可达                  | 检查 CLOUD_FN_URL 是否正确、HTTP 触发器是否已启用 |
| 云函数部署失败      | @cloudbase/node-sdk 依赖问题       | 检查 package.json，确保 Node.js 版本 >= 18        |
| ticket 登录后无权限 | 数据库安全规则升级但用户未正确认证 | 先回退安全规则，确认自定义登录工作后再升级        |
