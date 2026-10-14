# 工具与代码（供 AI 执行）

返回 [guide](guide.md)。你先检查部署电脑，再安装缺少的工具；不要让主人逐条复制命令。下列命令是模板，先替换实际路径、域名、地域和版本。只读查询可直接做，购买按[采购附件](Tradept-腾讯云选择与购买.md)处理。

## 1. 工具

部署电脑需要：可执行本地命令的 AI 工具、Python 3、Git、SSH/SCP、tccli；使用 GitHub Release 时建议安装 GitHub CLI（`gh`）。普通网页聊天没有命令执行能力时，先直白告诉主人需要换到可操作终端的 AI 工具。

你检查 `python3 --version`、`git --version`、`ssh -V`、`tccli --version` 和 `gh --version`。Windows 用 `py -3` 检查 Python。按当前操作系统的官方安装方式补齐，不强制主人换用某一款 AI。

tccli 是腾讯云官方命令名，文档中提到的 TCCLI 或 tcccli 均指它。安装到独立 Python 环境：[官方安装说明](https://cloud.tencent.com/document/product/440/34011)。

macOS／Linux：

```sh
python3 -m venv "$HOME/.venvs/tradept-tccli"
"$HOME/.venvs/tradept-tccli/bin/python" -m pip install --upgrade tccli
source "$HOME/.venvs/tradept-tccli/bin/activate"
tccli --version
```

Windows PowerShell：

```powershell
py -3 -m venv "$env:USERPROFILE\.venvs\tradept-tccli"
& "$env:USERPROFILE\.venvs\tradept-tccli\Scripts\python.exe" -m pip install --upgrade tccli
& "$env:USERPROFILE\.venvs\tradept-tccli\Scripts\tccli.exe" --version
```

Windows 后续用完整路径调用 tccli，前面保留 `&`；macOS／Linux 新开终端后重新激活环境，或直接用可执行文件的完整路径。服务器内部另装 Docker Engine、Compose 插件、Python 3、Nginx 等，见[执行附录](Tradept-部署执行附录.md)。

## 2. 连接企业腾讯云账号

先检查是否已有可用配置，不读取或输出密钥。没有时，告诉主人：

> 请登录企业自己的腾讯云账号，完成实名认证。我会帮你查询方案。云账号、服务器和域名都应归企业所有。

由企业云管理员在 [CAM](https://console.cloud.tencent.com/cam)创建部署子账号，按所选服务授予轻量或 CVM、域名／DNS、网络操作权限；选择云备份后再补充相应权限。API 密钥由主人在本地终端输入：[配置说明](https://cloud.tencent.com/document/product/440/34012)。

```sh
tccli configure
tccli lighthouse DescribeRegions --region ap-guangzhou
```

`configure` 中地域可先填 `ap-guangzhou`，输出格式填 `json`；后续每条地区相关命令显式传所选 `--region`。只读查询成功才算工具可用。权限失败就说明缺少哪个服务权限，不让主人反复重装。不要用主账号密钥，不在对话、命令参数、代码仓库或交接表中放密码和 SecretKey。

## 3. 取得正式版本

部署代码仓库：[wuyinhust/trade-adept](https://github.com/wuyinhust/trade-adept)。产品名称仍为 tradept，下面 clone 命令的本地目录也命名为 `tradept`；应用目录为仓库内 `trade-order-system/`。仓库访问失败时，请主人登录获授权的 GitHub 身份或让开发方授予只读访问；不要把访问令牌写进 URL。

如已安装 gh，你先查询 Release：

```sh
gh auth status
gh release list --repo wuyinhust/trade-adept --limit 10
gh release view <已选正式标签> --repo wuyinhust/trade-adept --json tagName,isDraft,isPrerelease,assets,url
git clone --branch <已选正式标签> --single-branch git@github.com:wuyinhust/trade-adept.git tradept
git -C tradept rev-parse HEAD
gh release download <已选正式标签> --repo wuyinhust/trade-adept --dir <本次部署材料目录>
```

没有 SSH GitHub 身份时用已登录 gh 的 `gh repo clone wuyinhust/trade-adept tradept`，再检出所选标签。没有 gh 时按 GitHub 官方安装方式安装，或从获授权的 Release 页面取得相同材料。

核对正式标签、完整提交、源码清单、SHA256、CPU 架构及发布验收。固定该版本，不直接部署 main，不把本地 `package.json` 的版本号当成正式发布证据。不在附件中固定“最新版本”；每次部署重新核对。

Release、标签和附件以 `trade-adept` 仓库的实际结果为准；代码相同不代表 Release 附件也已同步。若缺少 Release 或附件，请开发方提供该仓库相同提交的正式交付包及校验清单，不自动切回 `wuyinhust/tradept`。

下载与目标架构对应的完整镜像或离线构建材料。只有源码 ZIP 不够；缺少镜像、匹配哈希的 wheels 或构建说明时，先列清缺项并向开发方索取。不要猜镜像地址、跳过哈希校验或把测试数据库当安装包。

## 4. 管理员和服务器凭据

告诉主人：

> 请先准备一个管理员账号和密码。账号用小写字母开头，可含小写字母、数字、点、下划线或短横线，共 3–64 位；密码用独立的长密码，至少 12 位。请私下输入，不发到聊天里。你也可以让我生成，再通过私有文件交给你。

现有初始化接口支持 12–128 位密码；禁止 `administrator`、`guest` 等保留用户名。你依据所选版本的接口验证输入。业务管理员和原生运维 Administrator 使用独立凭据。

购买后查询实例，取得 IP、地域、系统和登录用户名。轻量用 `tccli lighthouse DescribeInstances --region <地域>`，CVM 用 `tccli cvm DescribeInstances --region <地域> --Limit 20`，需要时按接口分页。SSH 私钥由企业保管，只向你提供文件路径。

```sh
ssh -i <本机SSH私钥路径> <实际SSH用户>@<服务器公网IP>
```

首次连接核对云控制台中的服务器身份。确认可以进入且 `whoami` 正确，再继续安装。不要读取或回显私钥内容。
