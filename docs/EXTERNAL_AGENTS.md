# 外接智能体、MCP 与 Skill

MCP 是客户端调用画布工具的协议，不是某个网站。此项目使用本机 stdio 桥接：Codex 或其他客户端启动一个本机进程，该进程访问本机画布的 loopback 端口。`127.0.0.1` 永远指执行进程所在的电脑；不能把开发者电脑的配置直接复制到另一台电脑，也不能把 API 网站填进这个本机地址。

## Codex 接入

1. 在运行 Codex 的电脑启动深白画布。进入“设置 → 外接智能体”，开启 MCP。
2. 选择“Codex · TOML”，复制配置到该用户的 `.codex/config.toml`。已有同名 `[mcp_servers.deepwhite-studio]` 时替换该段，保留其他配置。
3. 在画布点击“检查本机连接”。需要定位 Codex 的环境问题时，复制“客户端检查命令”，在运行 Codex 的同一 Windows 环境执行。
4. 重启 Codex 中的 MCP 连接，确认可发现 `list_projects`、`get_canvas` 等工具。画布检查成功只证明画布进程环境可用，仍需在客户端调用一个读取工具。

Windows 原生画布需要 Windows 原生桥接。WSL、容器和远程主机里的 `127.0.0.1` 不一定是 Windows 宿主机；本版本不会自动开放局域网端口，也不会把控制凭证发到远程服务。

Claude 和其他支持 stdio 的客户端可复制“Claude / 通用 · JSON”。界面位置、Skill 加载方式和兼容性因客户端而异；尚未实测的客户端不能视为已适配。

## 便携版升级

设置会在 `userdata/integrations/deepwhite-mcp.ps1` 写入固定启动入口。配置只指向这个入口和安装根目录；每次启动读取 `current.json`，选择当前版本的内置 Python 与桥接程序，因此普通版本更新不需要重新配置 MCP。

脚本继承标准输入输出，不把 JSON-RPC 交给 PowerShell 转码；桥接仍会校验服务身份、安装目录和本机控制凭证。移动整个安装目录或切换电脑后，应从新的画布重新复制配置。若数据目录不可写，界面会明确提示当前暂用版本路径，升级后需要重新复制。

启动入口沿用便携版 `Start.cmd` 的单进程 `-ExecutionPolicy Bypass`，使默认 Restricted 环境能运行程序生成的本地脚本；不会调用 `Set-ExecutionPolicy`，也不会修改计算机、用户或组织策略。组织强制策略仍优先，阻止执行时应由管理员处理，不会自动绕过组织限制。本地源码运行采用当前 Python 和 `app/studio_mcp.py`，不依赖便携版引导。

## 连接检查

界面和 `studio_mcp.py --check --json` 分别检查：本机地址、服务与安装、控制配置、授权读取、工具定义。检查只读取画布列表，不写节点，不生成内容。

常见 `code`：

| code | 含义与下一步 |
|---|---|
| `connection_refused` | 画布未启动或端口不一致。启动本机画布并重新复制配置。 |
| `connection_permission_denied` | 执行进程无权访问本机端口。检查客户端所在环境或组织权限策略。 |
| `connection_timeout` | 本机服务超时。确认画布没有卡住、退出或更新。 |
| `wrong_service` / `wrong_installation` | 地址指向其他应用或另一个副本。使用当前画布生成的配置。 |
| `control_config_missing` / `control_disabled` | 当前数据目录没有控制配置，或未启用 MCP。 |
| `control_unauthorized` | 控制凭证与服务不匹配，常见于配置混用另一副本的数据目录。 |
| `script_policy_blocked` | Windows 阻止启动脚本；按组织和系统规则检查此文件。 |

“导出检查结果”只导出检查步骤、错误类别和版本等诊断信息，不导出 API Key、MCP token、节点提示词或素材。不要把登录密码贴进排错消息。

## 安装和修改 Skill

源文件为 `integrations/skills/deepwhite-canvas/SKILL.md`；设置中可以下载同一文件。将整个 `deepwhite-canvas` 目录放到客户端可发现的 Skill 目录。例如 Codex 项目技能可放入 `.agents/skills/deepwhite-canvas/SKILL.md`；也可使用客户端支持的用户技能目录。之后在客户端调用 `$deepwhite-canvas`。

修改 Skill 的“提示词规则”即可改变写作风格、镜头模板、角色规范；不需要修改画布代码。保留读取实时 schema、使用 revision 和稳定 operation_id 的步骤，可避免覆盖手动编辑及重复创建。Skill 是客户端读取的规则文件，不会自动上传或执行到 API 网站。

执行路径：用户需求 → 外接智能体读取 Skill → 编写提示词与参数 → MCP 写入画布 → 按画布授权生成 → 保存结果。Skill 文件本身不含模型凭证，生成仍使用画布已配置的渠道。

## 后续开发入口

- `app/studio_models.py`：可用模型目录，不依赖内置聊天。
- `app/studio_canvas_services.py`：公共 revision、共享编辑锁、项目资产与生成节点校验。
- `app/studio_graph.py`：结构编辑、同一画布文件内原子保存的幂等记录与撤销。
- `app/studio_control.py`：本机授权、工具路由、受控生成和诊断。
- `app/studio_mcp.py`：stdio 协议、参数校验、错误分层和只读预检。
- `app/studio_mcp_config.py` / `app/studio_mcp_bootstrap.ps1`：客户端格式与便携版固定入口。

旧 `studio_agent*` 模块仅保留源码兼容和历史测试，运行时不注册内置助手会话、计划或内置 Agent 路由。既有会话文件原样保留。扩展外接工具时应使用以上公共服务，不能重新依赖旧助手模块。

参考：[Codex MCP](https://developers.openai.com/codex/mcp/)、[Codex Skills](https://developers.openai.com/codex/skills/)。
