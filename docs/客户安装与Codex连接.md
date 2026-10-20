# 客户安装与 Codex 连接

适用版本：0.11.0-studio.6，Windows x64 完整便携包。

[下载完整 Windows 包](https://github.com/344996/deepwhite-studio-collab/releases/download/v0.11.0-studio.6/deepwhite-0.11.0-studio.6-windows-x64-portable.zip) · [以后使用的最新版入口](https://github.com/344996/deepwhite-studio-collab/releases/latest) · [已有客户在线更新步骤及公开验收](公开发布与在线更新-20261021.md)。

## 发给客户的操作步骤

1. 下载文件名以 `windows-x64-portable.zip` 结尾的完整包，**完整解压**到自己的可写文件夹，例如 `D:\深白片场`。不要在压缩包内运行，也不要只复制启动文件。
2. 双击 `Start.cmd`。程序自带 Python，不需要安装开发环境。画布和 Codex 都在这台 Windows 电脑上运行。
3. 打开画布的 **设置 → 外接智能体 / MCP**，勾选 **启用 MCP 访问**，再点 **自动配置 Codex**。
4. 点 **检查本机连接**。随后在 Codex 中重启该 MCP 连接，或退出并重新打开 Codex。
5. 在画布点击 **复制测试提示词**，粘贴给 Codex，让它列出画布。成功读取后再尝试创建文字节点、连线等操作。

不需要复制开发者的配置或修改任何 Python 路径。程序使用客户自己电脑的安装位置和当前 Windows 用户配置。没有安装 Codex 的客户可以正常使用画布；自动配置不会替他们安装 Codex。

本地编辑不用登录。调用模型生成时，仍需在画布的“账户与 API”配置服务。MCP 读取项目和编辑节点与 API 网站登录是两个独立步骤。首次生成默认需要在画布确认，自动配置不授予自动生成权限。

## 升级、移动目录和更换电脑

- **同一安装内更新版本**：连接指向 `userdata/integrations/deepwhite-mcp.ps1` 固定入口，自动选择 `current.json` 指定版本的包内 Python，不需要每次重新配置。
- **移动整个文件夹**：先停止这一份画布，再移动完整文件夹；从新位置打开，在 MCP 页面重新自动配置。已有连接不一致时页面要求确认“更新为当前画布”。重新打开 Codex 后生效。
- **换电脑**：在新电脑解压完整包并按上面步骤配置。若迁移项目，请先停止画布并备份整个 `userdata/`，不要把旧电脑的 Codex 配置直接粘贴过去。
- **保留两份安装**：`deepwhite-studio` 这个连接名称一次指向一份安装。切换安装时在目标画布确认更新连接，避免控制另一份副本。

`windows-x64-version.zip` 是给更新器使用的版本包，不能作为完整安装直接启动。

## 自动配置会改什么

只有客户主动点击按钮后才写配置；打开设置、检查连接、刷新页面不会自动修改 Codex 文件。

配置目标是当前运行画布的 Windows 用户：通常为 `%USERPROFILE%\.codex\config.toml`。如果启动画布时设置了绝对路径 `CODEX_HOME`，则使用该目录的 `config.toml`。不接受网页传入的任意保存路径、命令或配置内容。不要使用另一个管理员账号启动画布后给普通用户配置。

只更新 `[mcp_servers.deepwhite-studio]` 的连接命令、参数、环境及超时，启用这一条连接；保留其他模型、提供商、MCP 服务、注释及本连接已有工具限制/审批策略。旧连接指向其他目录时需要明确确认，重复点击不会重复添加。

每次实际安装/更新连接之前，原文件按字节备份到同一 Codex 用户目录的 `deepwhite-backups/config-时间-随机标识.toml`。这些文件可能包含客户原有私密配置，留在客户电脑，不随诊断导出，也不要上传仓库。

“高级 / 其他客户端”中的撤销功能恢复上一次深白连接的设置，并保留之后修改的其他 Codex 偏好。如果连接本身随后被其他软件改过，会拒绝自动撤销，避免覆盖新的修改。原来没有配置文件时，撤销会留下一个空的 `config.toml`，其有效配置与未设置相同。

写入采用临时文件、完整写盘和原子替换。合并前后校验其他配置的语义，提交前再次检查文件修订；配置损坏、链接/重定向位置、文件占用、权限不足或并发修改时会提示错误，保留原文件。系统管理员强制策略不会被自动更改。

## 客户端还没连上时

| 页面状态 | 操作 |
| --- | --- |
| 未启用 MCP | 先勾选启用，再自动配置 |
| 尚未配置 | 点击自动配置 Codex |
| 检测到另一份深白连接 | 确认要连接当前画布后更新，再重启 Codex 连接 |
| 已配置，但 Codex 没有工具 | 重启 Codex MCP 连接/应用，使用“复制测试提示词”；检查是否运行在同一 Windows 用户下 |
| 本机检查未通过 | 按页面提示处理；高级选项可复制检查命令或导出不含密钥的诊断 |
| 配置已变化 | 刷新连接状态再试，不直接覆盖新内容 |
| 配置格式异常 | 原配置未改动；先在 Codex 修复格式，或使用备份人工恢复 |

画布的“检查本机连接”验证启动入口、服务身份和授权，只表示本机桥接可用；客户端真正发现并调用工具仍需在 Codex 完成。项目级 `.codex/config.toml`、企业管理策略、指定配置 profile 可以覆盖用户配置，自动配置不会修改这些文件。

此流程面向本机 Windows Codex。WSL、容器、远程电脑的文件和 localhost 不是这份 Windows 安装的环境；它们不属于自动配置支持范围。Claude/其他 stdio 客户端仍使用高级选项中的 JSON 配置，不能据此声称已经自动安装或实测所有客户端。

## 维护与 AI 继续开发

| 文件 | 职责 |
| --- | --- |
| `app/studio_codex_setup.py` | 固定目标发现、TOML 保留式合并、冲突修订、备份和撤销 |
| `app/studio_control.py` | `/api/studio/control/codex` 状态与显式操作；同源 JSON 写入及启用检查 |
| `app/studio_mcp_config.py` | 当前安装的客户端配置和固定入口生成 |
| `app/studio_mcp_bootstrap.ps1` | 每次读取当前版本并启动包内桥接，保持 stdio |
| `app/static/studio-control.js` / `.css` | 客户接入步骤、状态、按钮及高级配置 |
| `app/tests/test_codex_setup*.py` | 配置保留、撤销、失败和 HTTP 边界回归 |
| `app/tests/check-control-ui.cjs` | 接入、取消、错误恢复、键盘和窄屏交互 |
| `scripts/check_customer_mcp_release.py` | 实际便携 ZIP、独立用户目录、移动安装、Codex 客户端验证 |

新增客户端时先定义其真实配置格式及备份/撤销契约，不开放网页任意路径写入。不要将完整配置/备份、token、API Key 加进诊断；不要把本机检查通过显示成“所有客户端已经连接”。

配置格式依据 [OpenAI MCP 文档](https://developers.openai.com/codex/mcp/)；保留式编辑使用 [TOML Kit](https://tomlkit.readthedocs.io/en/latest/quickstart/)。本版结果见 [本次发行与验收](发行产物-20261021.md)，以前版本的测试不计入本次结果。
