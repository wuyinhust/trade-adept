# v37 路线图推进总结

## 完成事项

### 1. ES Modules 迁移 ✅（v37 已部署）

所有脚本已使用 `<script type="module">` + `import`/`export`，`package.json` 设置 `"type": "module"`。

### 2. `.tcbignore` 部署排除规则 ✅

新建 `.tcbignore`，排除 `node_modules/`（~200MB）、`tests/`、`coverage/`、ESLint/Prettier 配置、文档、诊断页面等。部署体积减少约 99%。

### 3. CloudBase 自定义登录基础设施 ✅

- **云函数** `cloudfunctions/customLogin/`：完整的自定义登录 SCF，支持 SHARED_SECRET 鉴权、用户验证、ticket 签发
- **客户端** `js/cloud.js` v13：自定义登录优先 + 匿名登录降级，零破坏性变更
- **部署指南** `cloudfunctions/customLogin/DEPLOY.md`：6 步部署流程 + 故障排查

### 测试覆盖（本轮累计）

- 总测试 367 个，全部通过
- 综合覆盖率：语句 53.26% / 分支 50.69%

## 待部署（需要 CloudBase 控制台操作）

customLogin 云函数尚未部署到生产环境。部署后：

1. 用户登录将使用自定义身份（auth.uid = 用户 ID）
2. 可升级数据库安全规则为 `auth != null`（需要认证）
3. 为未来的行级权限（按团队/用户隔离数据）奠定基础

## 文件变更清单

- 新增：`.tcbignore`
- 新增：`cloudfunctions/customLogin/index.js`
- 新增：`cloudfunctions/customLogin/package.json`
- 新增：`cloudfunctions/customLogin/config.json`
- 新增：`cloudfunctions/customLogin/DEPLOY.md`
- 修改：`js/cloud.js`（v12 → v13，自定义登录 + 降级）
- 修改：`index.html`（v=37 → v=38）
- 修改：`sw.js`（grandware-v7 → grandware-v8）
- 修改：`CHANGELOG.md`（新增 v37 条目）
