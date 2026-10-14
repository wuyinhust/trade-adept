# 工具与代码（供 AI 执行）

返回 [guide](guide.md)。你先检查部署电脑，再安装缺少的工具；不要让主人逐条复制命令。下列命令是模板，先替换实际路径、域名、地域和版本。只读查询可直接做，购买按[采购附件](Tradept-腾讯云选择与购买.md)处理。

## 1. 工具

部署电脑需要：可执行本地命令的 AI 工具、Python 3.11 或更高版本、Git、SSH/SCP、tccli、GitHub CLI（`gh`，默认用于私有仓库访问和安装测试查询）。普通网页聊天没有命令执行能力时，先直白告诉主人需要换到可操作终端的 AI 工具。

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

Windows 后续用完整路径调用 tccli，前面保留 `&`；macOS／Linux 新开终端后重新激活环境，或直接用可执行文件的完整路径。服务器默认使用 Ubuntu 24.04；Docker、Compose、Python 和 Caddy 按[执行附录](Tradept-部署执行附录.md)中的自动入口安装。

## 2. 连接企业腾讯云账号

先检查是否已有可用配置，不读取或输出密钥。没有时，告诉主人：

> 请登录企业自己的腾讯云账号，完成实名认证。我会帮你查询方案。云账号、服务器和域名都应归企业所有。

由企业云管理员在 [CAM](https://console.cloud.tencent.com/cam)创建部署子账号，按所选服务授予轻量或 CVM、域名／DNS、网络操作权限；选择云备份后再补充相应权限。API 密钥由主人在本地终端输入：[配置说明](https://cloud.tencent.com/document/product/440/34012)。

```sh
tccli configure
tccli lighthouse DescribeRegions --region ap-guangzhou
```

`configure` 中地域可先填 `ap-guangzhou`，输出格式填 `json`；后续每条地区相关命令显式传所选 `--region`。只读查询成功才算工具可用。权限失败就说明缺少哪个服务权限，不让主人反复重装。不要用主账号密钥，不在对话、命令参数、代码仓库或交接表中放密码和 SecretKey。

## 3. 取得可部署版本

对外交付仓库：[wuyinhust/trade-adept](https://github.com/wuyinhust/trade-adept)；[wuyinhust/tradept](https://github.com/wuyinhust/tradept) 同步保留相同安装能力。使用主人给出的获授权仓库，访问失败先处理权限，不自动切换另一个私有仓库。产品名称仍为 tradept。新安装入口在 `trade-order-system/integrations/private-deploy/`。

先读取仓库根 README 和全部部署附件。用已登录 gh 克隆，查询提交和安装测试，例如（仓库变量按主人给出的地址填写）：

```sh
TRADEPT_REPO=wuyinhust/trade-adept
gh auth status
gh repo clone "$TRADEPT_REPO" tradept
TRADEPT_COMMIT=$(git -C tradept rev-parse HEAD)
gh run list --repo "$TRADEPT_REPO" --workflow private-deploy.yml \
  --commit "$TRADEPT_COMMIT" --limit 5 --json status,conclusion,headSha,url
```

若当前提交的安装工作流还在排队或运行，等待它完成；失败则先查日志。只有仓库维护者能处理的访问或流水线问题，明确返回给交付方，不让主人先购买。

选择 `Private deployment from source` 已成功的完整提交 SHA，并在部署电脑和服务器都检出同一个 SHA；没有成功记录时先检查流水线，不能拿别的提交或单元测试的成功代替。部署期间固定提交，不自动跟随 main 升级。正式标签若包含安装器且同一提交通过检查，也可按标签选择。旧 v0.4.1 只有历史构建入口，不是本次新安装器的交付版本。

新安装器走**从源码直接构建**的路径，不依赖 Release 附件或开发者电脑上的 wheels。先在部署电脑执行材料检查：

```sh
cd tradept
python3 trade-order-system/integrations/private-deploy/deploy.py materials --cache /tmp/tradept-wheels
```

Windows 将缓存目录改为当前账户可写路径。安装器从公开 URL 下载三份 wheels，按仓库清单验证 SHA256；基础服务使用固定镜像摘要。采购前在部署电脑核验材料、镜像可用性和待购套餐的 Ubuntu 24.04／amd64／内存／磁盘条件；已有服务器时同时检查其网络。新服务器尚未购买，不能声称已验证它的出站网络。购买后、安装前在目标机重新验证材料下载和镜像拉取；失败先处理网络，不跳过校验，也不拿本机成功代替目标机成功。

随后按[自动安装入口](https://github.com/wuyinhust/trade-adept/tree/main/trade-order-system/integrations/private-deploy)执行 prepare、install、check；实际运行使用已经冻结的本地提交中的文件。旧 `unified_build.py` 为历史离线构建路径，固定依赖不同，不与新清单混用。未修改的源码、企业 logo 补丁及最终实际文件清单分别记录，不能把定制版本冒充原版。

GitHub 权限、云账号、DNS／SSH 授权仍由主人提供；“只给仓库地址”意味着 AI 能从仓库取得完整技术路径，不表示无须主人选择、付款或提供企业资料。

## 4. 管理员和服务器凭据

告诉主人：

> 请先准备一个管理员账号和密码。账号用小写字母开头，可含小写字母、数字、点、下划线或短横线，共 3–64 位；密码用独立的长密码，至少 12 位。请私下输入，不发到聊天里。你也可以让我生成，再通过私有文件交给你。

现有初始化接口支持 12–128 位密码；禁止 `administrator`、`guest` 等保留用户名。你依据所选版本的接口验证输入。业务管理员和原生运维 Administrator 使用独立凭据。

购买后查询实例，取得 IP、地域、系统和登录用户名。轻量用 `tccli lighthouse DescribeInstances --region <地域>`，CVM 用 `tccli cvm DescribeInstances --region <地域> --Limit 20`，需要时按接口分页。SSH 私钥由企业保管，只向你提供文件路径。

```sh
ssh -i <本机SSH私钥路径> <实际SSH用户>@<服务器公网IP>
```

首次连接核对云控制台中的服务器身份。确认可以进入且 `whoami` 正确，再继续安装。不要读取或回显私钥内容。
