# 模型选择调研

获取日期：2026-09-17。只读公开资料，无用户密钥。

- DeepWhite 模型类型、厂商与真实 ID：https://api.deepwhiteai.com/api/pricing
- Fisher 节点选择器：https://github.com/Work-Fisher/AIFISHER/blob/main/src/stable/nodes/canvasModelSelector.tsx
- Fisher 分组选择菜单：https://github.com/Work-Fisher/AIFISHER/blob/main/src/stable/generation/modelPicker.ts
- Fisher 模型目录策略：https://github.com/Work-Fisher/AIFISHER/blob/main/src/stable/generation/canvasModelCatalogPolicy.ts
- Fisher 自动参考图模式：https://github.com/Work-Fisher/AIFISHER/blob/main/src/stable/generation/imageMode.ts

采用的交互：可搜索模型列表、可读名称、厂商与能力信息、当前选择标记、浏览器顶层弹层。DeepWhite 的目录及 API ID 独立维护，不复制 Fisher 服务商地址或模型 ID。Fisher 的固定常用模型白名单不套用到本项目；按用户要求默认启用获取的四类模型，并保存用户删减偏好。
