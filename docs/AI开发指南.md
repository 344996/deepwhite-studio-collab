# 深白片场 AI 开发指南

适用仓库：`344996/deepwhite-studio-collab`。文档日期：2026-10-18。当前开发版本：`0.10.2-studio.14`。

本项目是浏览器界面加本机 Python 服务，使用原生 JavaScript、HTML 和 CSS，保留经典画布与智能画布两套引擎。继续开发时，应在现有业务模块中扩展，避免以新演示页替换正式画布，或重写已有保存、撤销和生成生命周期。

## 从源码启动

准备 Python 3.12。在仓库根目录用 PowerShell 运行：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -B app\studio_server.py
```

浏览器打开 `http://127.0.0.1:3848/`；`/api/studio/health` 应返回当前版本。默认数据在 `app/workspace/`。如端口已占用，设置 `$env:DEEPWHITE_STUDIO_PORT='3850'`，再用对应端口打开。终端按 Ctrl+C 停止。

根目录旧 `.cmd` 启动器仍依赖完整发行包的 `app/python/python.exe`；源码用户使用上述入口。基础依赖不包含 ComfyUI、GPU 模型、ffmpeg 或各平台专用工具，不应在启动画布时自动安装它们。

测试应先设置独立的 `DEEPWHITE_STUDIO_RUNTIME_DIR`。`app/launch.py` 是原打包启动器，会使用自己的工作区，因此隔离测试不要通过它启动。

## 架构和目录

```text
浏览器（本机）
  ├─ canvas-list.html → 项目和画布管理
  ├─ canvas.html → 经典画布引擎
  └─ smart-canvas.html → 智能画布引擎
         ↓ 同源 HTTP / WebSocket
  studio_server.py → main.py + install(...) 业务扩展
         ├─ 本机画布 JSON、项目索引、资产数据库及媒体
         ├─ studio_account → 固定 API 网站的账号桥接
         ├─ studio_settings / generation → 用户选择的生成服务
         └─ studio_control ← studio_mcp.py ← 获授权的 MCP 客户端
```

| 文件或目录 | 职责 | 修改建议 |
| --- | --- | --- |
| `app/main.py` | 原引擎后端、项目/画布、原供应商接口、本机边界 | 只做必要的兼容修复，避免继续堆大型新功能 |
| `app/studio_server.py` | 正式服务入口、扩展安装、页面路由、health | 新后端模块沿用 `install(app)` 或 `install(core)` |
| `app/static/js/canvas-list.js` | 原项目与画布增删改查 | 不绕开项目索引保护与恢复机制 |
| `app/static/js/canvas.js` | 经典画布节点、连线、选择、撤销 | 编辑前记录历史；不要复制运行中的任务身份 |
| `app/static/js/smart-canvas.js` | 智能画布与保存状态 | 保留修改版本、排队保存、草稿及返回等待 |
| `app/static/studio-*-v2.*` | 各正式页面的展示与交互适配 | 与原引擎共用数据，不建立第二套节点状态 |
| `app/static/studio-workspace.*` | 本版工作台导航、快捷入口、工具收纳与响应式 | 只管展示和入口；原 DOM 事件、保存和账号仍由原模块负责 |
| `app/static/studio-v2-theme.css` | 主题颜色、焦点、减少动态效果 | 使用语义变量，避免各页面硬编码另一套颜色 |
| `app/studio_settings.py`、`studio_catalog.py` | 平台设置、地址密钥绑定、模型能力 | 不将一个供应商的密钥传给另一个地址；不要猜模型协议 |
| `app/studio_generation.py`、`studio_native_tasks.py` | 生成适配、任务状态和回执 | 新模型先明确能力、费用、轮询与结果归属 |
| `app/studio_account.py`、`studio_account_extension.py` | API 网站登录、注册能力和账号会话 | 网站账户与模型 API 密钥是不同概念 |
| `app/studio_assets.py`、`studio_storage.py` | 版本化资产、文件与目录管理 | 保留原件、校验结果和失败原因 |
| `app/studio_control.py`、`studio_mcp.py` | 本地控制、审批和 stdio 桥接 | 保留权限边界、revision、operation_id 和付费审批 |
| `app/studio_graph.py`、`studio_graph_tools.json` | 项目/schema、新建画布、文字和连线编辑 | HTTP/stdin 共用校验；编辑日志随画布原子写，复制时隔离；不可重放未知创建 |
| `app/tests/` | 后端与浏览器回归 | 使用临时数据和模拟上游，禁止默认消耗生成额度 |
| `app/docs/releases/` | 版本说明与累计功能缺口 | 每次版本更新同步维护，历史未完成项不能消失 |

## 已有接口与数据约束

| 接口 | 用途 | 必须保留的约束 |
| --- | --- | --- |
| `GET /api/studio/health` | 确认实际运行版本 | 不用源码 VERSION 代替运行验证 |
| `GET/POST /api/projects` | 列出和创建项目 | 项目索引损坏时应提示，不覆盖成空数据 |
| `POST /api/projects/recovery/restore` | 显式恢复项目索引 | 只对损坏或缺失索引恢复；健康索引拒绝回退；保留损坏原件 |
| `GET/POST /api/canvases` | 画布列表和创建 | 本地编辑不要求网站登录 |
| `GET/PUT /api/canvases/{id}` | 读取和保存画布 | PUT 使用读取结果的 `base_updated_at`；冲突先读回并处理，不能无条件覆盖 |
| `PUT /api/studio/settings/provider` | 保存平台配置 | 改地址时要求新密钥或显式清除，不能自动复用旧密钥 |
| `POST /api/studio/settings/test` | 只读连接测试 | 不自动发起付费生成 |
| `POST /api/studio/settings/sync-models` | 同步模型列表 | 保留用户启停、删除偏好和模型能力信息 |
| `POST /api/studio/account/login`、`/verify`、`/logout` | 账号会话 | 密码不落盘，上游会话与本地临时会话分离 |
| `GET /api/studio/account/capabilities`、`POST /api/studio/account/register` | 注册能力与注册 | 按站点安全验证、邮件验证和条款能力显示，不绕过验证 |
| `GET /api/studio/assets?project_id=…` | 项目资产 | 复用资产版本，不接受任意文件路径写入 |
| `POST /api/studio/control/call` | 获授权的控制操作 | 调用受支持工具并保留令牌、版本冲突和审批检查 |

接口的精确请求字段以 Pydantic 模型、`app/studio_mcp_tools.json`、`app/studio_graph_tools.json` 与对应测试为准。经典和智能画布节点结构不相同，不能只改 `kind` 字段就转换整个画布。MCP 新编辑参数、重试语义、备份限制见[本轮开发报告](项目完整迁移与MCP开发.md)。

运行数据默认分为 `data/canvases/`、`data/projects.json`、资产与生成目录，以及 `API/.env`。项目索引备份不是媒体备份。SQLite 连接必须关闭；JSON 修改使用已有原子写入函数；浏览器草稿不能替代服务端备份。

## 公共画廊边界（0.10.2-studio.13）

`app/studio_gallery.py` 仅保存本地网站入口（GET/PUT `/api/studio/gallery`），数据文件为运行目录下 `data/studio_gallery.json`。界面在共享 `studio-workspace.js` 中接入三页。弹窗阻止输入与滚轮传播到画布，开启新标签页时不携带本地凭据或素材。

网站代码单独位于 [344996/deepwhite-gallery](https://github.com/344996/deepwhite-gallery)，其 README、开发和部署文档是网站的维护入口。不要把公共上传或登录接口装进本地画布服务，也不要为网站部署取消画布现有的本机 Host/Origin 限制。用户尚未确定画廊域名，不应硬编码未经确认的正式域名。微信继续暂缓。

## 推荐扩展步骤

1. 读取 `app/AGENTS.md`、当前版本状态和相关测试，写清本次操作及验收条件。
2. 后端新增独立模块，在正式入口安装；前端优先扩展已有适配模块。需要新增脚本时检查三页实际加载顺序。
3. 先写能暴露问题或验证需求的用例，再做最小实现。复用已有节点和事件，不通过批量替换 HTML 重建画布。
4. 保存、任务和模型变更必须检查晚响应归属：画布 ID、节点 ID、revision 或 request_id。撤销、复制和草稿恢复不应重新提交旧任务。
5. 界面动效只用于按钮、菜单和对话框反馈。不要给世界坐标容器或正在拖动的节点套过渡动画；尊重 `prefers-reduced-motion`。
6. 未登录创建画布、现有 API 密钥、自选供应商和本地资产必须继续可用。新页面不应自动请求所有上游服务。
7. 复测后更新 VERSION、CHANGELOG、版本索引和累计状态。把“模拟通过”“真实服务通过”“未实现”分开记录。

需要新增模型时，先核对供应商官方协议，再更新目录和适配器。不能仅因为模型名相似就共用 URL、计费或轮询规则。无法确定的型号明确显示未支持。

## 测试入口

```powershell
.\.venv\Scripts\python.exe -B app/tests/run-phase1-backend.py
```

浏览器测试需 Playwright 与对应浏览器。可以使用外部工具环境，设置 `PLAYWRIGHT_MODULE`、`CHROMIUM_EXECUTABLE`、`PYTHON_EXECUTABLE` 后运行：

```powershell
node app/tests/check-workspace-requirements.cjs
node app/tests/check-phase1-interactions.cjs
node app/tests/check-phase1-save.cjs --browser
node app/tests/check-mcp-graph.cjs
node app/tests/check-studio-account-registration.cjs
```

已有五个画布回归：`check-canvas-v2.cjs`、`check-canvas-pointer-safety.cjs`、`check-canvas-save-safety.cjs`、`check-canvas-drafts.cjs`、`check-canvas-history-safety.cjs`。旧测试中仍有导出时的 `data/local-path` 占位符，不能声称这些历史测试全部可运行；本轮涉及的入口已适配环境变量。

测试日志及运行目录不上传 Git。每次检查至少覆盖修改后的真实页面、失败路径、保存重开和跨画布晚响应。本轮未执行真实账号、付费生成、GPU 或物理断电验收。

## 给后续 AI 的任务模板

> 目标仓库是 344996/deepwhite-studio-collab。先读取 app/AGENTS.md、docs/AI开发指南.md 和当前版本状态。只实现以下功能：[具体功能]。保留经典/智能画布、未登录本地编辑和自选 API；不替换核心引擎，不上传用户数据，不自动调用付费接口。先列修改点及验收条件，分步实现和回归。完成后同步累计功能状态，报告实际测试和未验证项。
