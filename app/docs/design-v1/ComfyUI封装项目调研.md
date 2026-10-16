# ComfyUI 封装项目初筛

2026-09-20。依据项目官方仓库与说明；未安装、编译或实测，不认定其中任何项目就是用户记忆中的项目。

## 候选与适用位置

| 项目 | 官方说明确认的能力 | 边界 | 对 DeepWhite 的初步判断 |
|---|---|---|---|
| [MagicPot-Terrarium](https://github.com/MagicPotTeam/MagicPot-Terrarium) | 有 embedded 模式，将 Python 与 ComfyUI 随桌面应用打包 | 公开源码需自行准备运行环境资源；模型不随 embedded 包完整分发 | 优先研究 Windows 桌面交付方式，不直接替换现有画布 |
| [WorkflowUI](https://github.com/jimpi-dev/WorkflowUI) | 导入工作流，制作表单应用，管理队列与结果 | 仍需运行中的 ComfyUI 后端 | 参考工作流转工具面板的方式 |
| [ComfyUI-Windows-Portable](https://github.com/YanWenKun/ComfyUI-Windows-Portable/blob/main/README.zh.adoc) | 提供自动构建便携整合包的脚本 | 主要解决环境分发，不自动制作 DeepWhite 操作界面 | 作为本地运行包的候选基础 |
| [comfy-pack](https://github.com/bentoml/comfy-pack) | 记录依赖、节点版本和模型哈希，恢复工作流环境，也支持 API 服务化 | .cpack.zip 不是含全部模型的离线安装包；仓库显示 2026-06-10 归档只读 | 参考版本锁定设计，暂不作为新产品的首选核心依赖 |
| [官方 App Mode / App Builder](https://blog.comfy.org/p/from-workflow-to-app-introducing) | 将工作流转换为简化应用界面 | 应用界面简化与 Windows 完整运行环境打包是两件事 | 参考交互，不能据此承诺独立离线 EXE |

## 建议

优先研究 MagicPot 的 embedded 交付与 Portable 的构建方式。DeepWhite 保留自己的画布、素材和任务接口；本地运行包在后台服务这些工具。WorkflowUI 用于研究参数表单映射，避免引入第二套用户工作区。

下一步验证应使用已选定的一个高清工作流：干净 Windows 环境安装、中文/空格路径、模型准备、后台启动、一次处理、结果回传、退出与更新。完成这些后才能决定打包选型。当前没有下载模型、执行生成或消耗额度。

尚需识别：若用户记得原项目的名称片段、图标或介绍页面，可进一步锁定，不能把本轮候选当成唯一答案。
