# 深白片场 DeepWhite Studio

本仓库是 `344996/deepwhite-studio-collab` 的开发副本，来源于 [aslancootl/deepwhite-studio-collab](https://github.com/aslancootl/deepwhite-studio-collab)，原始导入提交为 `d59a0225f5a0329e5dee7e888b96cbab71b0621e`。原仓库保持不变。

当前版本为 **0.10.2-studio.14**。原交接源码的 1,774 个跟踪文件、许可证及此前修复已完整保留在本账号仓库。本版新增 MCP 新建普通画布、文字编辑、移动和连线，保留第一批修复、工作台和画廊入口。独立网站前后端在 [344996/deepwhite-gallery](https://github.com/344996/deepwhite-gallery)，已完成本地模拟账号验收，尚未部署公网。

- [需求与进度](docs/requirements-2026-10.md)
- [完整迁移核对与本轮 MCP 开发测试](docs/项目完整迁移与MCP开发.md)
- [公共画廊接入与本轮测试](docs/公共画廊接入与测试.md)
- [上一轮工作台修改与测试](docs/本轮修改与测试.md)
- [源码启动与 AI 开发指南](docs/AI开发指南.md)
- [微信登录、画廊、更新和 MCP 评估](docs/扩展功能评估.md)
- [第一批可复查测试摘要](docs/phase1-verification.json)
- [第一批修改说明](第一批修复说明.md)
- [当前累计功能与缺口](app/docs/releases/0.10.2-studio.14-status.md)
- [开发步骤](tasks/plan.md)

源码启动：准备 Python 3.12，安装根目录 `requirements.txt`，运行 `python -B app/studio_server.py`，浏览器打开 `http://127.0.0.1:3848/`。建议使用独立虚拟环境，完整 PowerShell 步骤见开发指南。

这是源码仓库，测试数据、账号凭据、运行日志和本机 Python 不随源码上传。原许可证及第三方署名完整保留，使用范围见 [app/LICENSE](app/LICENSE)。

以下保留原始交接背景，历史状态不代表当前交付状态。

# 深白片场源码交接副本

本目录是从 Git 当前跟踪源码生成的源码交接副本，不包含 Git 历史、运行数据、密钥和备份。它供技术评估、整理和修复使用。

程序采用本地浏览器界面与 Python 服务结构。入口位于 `启动深白片场.cmd`；运行方式参照 `app/launch.py` 和 `app/README.md`。本交接副本不包含本机 Python 运行环境，也不承诺在新电脑上开箱可用。首次正常启动时，空的工作区会由程序按需创建。仓库没有随附 `requirements.txt`；具体 Python 环境需要技术评估后确认。

本机浏览器测试如需指定 Playwright 或 Chromium 路径，请通过测试支持的环境变量单独配置，不依赖随附的电脑绝对路径。

`app/` 中保留的第三方资源、许可证、署名和来源文件应按其原有许可使用。部分随附设计文档及运行说明保留了指向未随附历史文档的相对链接；此类链接用于追溯背景，不代表目标文件也包含在本副本内。

当前源码记录的隔离测试或模拟服务结果不等于真实服务验收。真实供应商调用、GPU、完整 Windows 安装发行和目标机器运行仍需单独验证。

`SOURCE_EXPORT.json` 记录源提交标识、输出文件清单及 SHA-256。它不包含源电脑的完整路径或凭据。
