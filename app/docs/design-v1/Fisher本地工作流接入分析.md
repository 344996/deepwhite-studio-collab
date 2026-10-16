# Fisher 本地工作流接入分析

检查日期：2026-09-20。检查对象为 Work-Fisher/AIFISHER 公开源码，提交 `bdcf3bec054594fcab591952a8c5acef858d6de4`。只读研究，未安装或执行 Fisher，未对接本机 ComfyUI；不能据此判断私有版本和所有发行版行为。源码参考存于 references/fisher-comfy-review，不接入正式产品。

## 已确认的实现

1. **独立运行环境**：README 明确本地 ComfyUI 另行安装；公开源码不附带 ComfyUI 或模型权重。不是下载 Fisher 就自动获得完整本地模型环境。
2. **目录识别**：comfyDiscovery.js 在常见目录中做有界查找；comfyProcess.js 识别 main.py 和多种 Python 布局，也允许指定解释器。不是必须启动第三方整合包的 EXE。
3. **后台进程管理**：直接以 Python 启动 ComfyUI，限定本机地址，隐藏 Windows 控制台，检查端口、就绪与日志。自动启动取决于配置；已运行服务可以连接复用。停止前核验进程归属，避免误杀外部实例。
4. **工作流变成画布功能**：管理界面含选择工作流、运行环境、输入参数、试运行、输出结果等环节。选择需要外置的字段，保存显示名、控件、默认值及节点字段映射，再加入画布。本地路径允许配置后加入，不应误写为所有本地工具必须先通过真实试运行。
5. **后台执行与结果**：localComfyClient 使用节点信息、上传、任务提交、历史和队列接口，并有 WebSocket 实时通道；执行器组织参数与素材，输出归档后回到画布。中断观察不等于重新提交任务。

## 与 DeepWhite 要求的关键差别

Fisher 的进程控制器在自行启动服务并探测成功后主动调用 openBrowser，见 comfyProcess.js 约 535–548 行。隐藏控制台并不等于不弹浏览器。DeepWhite 应默认禁止自动打开 ComfyUI 网页，将其作为可选的高级入口。

Fisher 提供通用工作流导入与外置参数配置。DeepWhite 的普通用户不必执行这些步骤：产品制作方提前将已验证工作流配置成人设、高清、拆解重绘等工具，用户只上传素材和调整少量创作参数。

## 对我们的设计结论

- 暂不研究另一套封装软件，复用当前项目调用基础，补齐后台服务管理。
- D:\deep\2026wangyi-ComfyUI-V11 仅为当前非纯净工作环境，不作为正式下载包。
- 后期接入用户制作的纯净包，记录包版本、Python 路径、启动参数及工作流配置；不用猜测多套 Python 的优先级。
- 先开发不依赖完整分发包的适配边界：检查服务、工作流参数映射、任务/结果、错误提示；纯净包就绪后再做安装交付验收。
- 整合包下载是可选项；API 用户不需要下载。本地处理不自动转到 RH 或其他云端。

## 源码依据

- [README](https://github.com/Work-Fisher/AIFISHER/blob/bdcf3bec054594fcab591952a8c5acef858d6de4/README.md)
- [本地进程管理](https://github.com/Work-Fisher/AIFISHER/blob/bdcf3bec054594fcab591952a8c5acef858d6de4/server/local/comfyProcess.js)
- [工作流管理界面](https://github.com/Work-Fisher/AIFISHER/blob/bdcf3bec054594fcab591952a8c5acef858d6de4/src/stable/local/workflowManager.ts)
- [参数映射](https://github.com/Work-Fisher/AIFISHER/blob/bdcf3bec054594fcab591952a8c5acef858d6de4/server/workflowRuntime/workflowBindingCompiler.js)
- [本地执行器](https://github.com/Work-Fisher/AIFISHER/blob/bdcf3bec054594fcab591952a8c5acef858d6de4/server/workflowRuntime/localComfyExecutor.js)
