# 登录后自动连接 API

本说明对应 2026-10-20 测试反馈的账户、模型初始化和 G2 提示词校验改动。网站账户仍然不是本地画布编辑的前提；用户也可以独立配置其他供应商。

## 用户操作

1. 在画布右上角点击“登录 / 注册”，使用 API 网站账户登录；启用两步验证的账户继续输入验证码。
2. 画布为该账户创建或复用一个名为 `DeepWhite Studio <本机编号>` 的生成令牌，自动保存官方渠道并同步该令牌可以读取的模型列表。成功后显示“官方 API 已连接”。
3. 生成调用按 API 网站账户余额和账单计费。连接过程只读取模型，不提交生成。
4. 网站限制授权接口或模型同步失败时，登录状态保留，并显示原因和“重新连接”入口。也可在“设置 → 账户与 API”新增自己的渠道。
5. 保存自选 API 的有效地址和密钥后自动同步模型。同步失败保留连接设置、旧模型和停用选择，点击“同步模型”可重试。

未连接时，设置中的模型页展示**不可选择、不可生成的模型示例**。实际可用模型以账户授权后的列表为准。同步成功不代表所有第三方模型协议均已适配。

## 会话与凭证边界

- 网站登录密码不保存，网站 Cookie 和自动取得的生成 Key 仅在后台进程内存中保留。
- 官方渠道 ID 按账户确定，不会把 A 账户的任务改用 B 账户的凭证。退出、切换账户、会话到期或关闭后台后，本机不再返回旧凭证。下次登录会重新取得同一令牌。
- 退出登录不会删除 API 网站的令牌；可在网站令牌管理中主动撤销。用户在网站停用的令牌不会被画布自动启用或替换。
- 本机 `data/studio_account_link.json` 只保存随机安装编号、令牌 ID 和创建状态，不保存 Key、密码或网站 Cookie。此文件使用刷新到磁盘后再原子替换的方式写入。
- 凭证读取集中在 `main.provider_env_key_value()`。保留前缀 `deepwhite-account-` 的渠道只能使用当前有效账户的内存授权，绝不回退到 `.env`。旧项目引用的账户渠道缺失、停用或过期时，经典与智能画布都明确拒绝调用，不会改用当前首选渠道或另一账户。
- 新版设置禁止编辑受管渠道；旧版批量设置仅允许选择默认渠道，不能删除、创建受管 ID、替换 Key、修改地址或自定义端口。手动配置的其他供应商仍可编辑。模型的启用和停用通过“模型管理”调整。
- 官方渠道固定使用 `https://api.deepwhiteai.com/v1`、OpenAI 协议和标准端口。凭证解析、实际请求头和端口解析同时检查当前存储与传入的配置快照；即使导入了被修改的配置，也不会向其他地址发送账户 Key。重新连接会清除遗留的自定义端口与模型协议覆盖，同时保留模型停用选择。
- 同一套本地数据同时只连接一个 API 网站账户。跨标签页重新登录会替换先前网站会话；手动配置的其他供应商仍然保留。
- 已经发给上游的生成请求不能通过退出本机账户撤回，费用与结果需以 API 网站记录为准。

## 接口和扩展位置

| 接口 | 行为 |
| --- | --- |
| `POST /api/studio/account/login` | 网站登录，非两步验证账户随后自动连接 API；返回 `generation` 状态。 |
| `POST /api/studio/account/verify` | 完成两步验证，随后自动连接 API。 |
| `GET /api/studio/account` | 账户余额与 `generation` 状态，不返回凭证。 |
| `POST /api/studio/account/provision` | 重新校验网站会话、取得该账户令牌并同步模型；用于失败重试和主动刷新。 |
| `POST /api/studio/account/logout` | 先清理本机生成授权，再尝试网站退出。 |
| `PUT /api/studio/settings/provider` | 保存自选 API 后自动同步；`sync.status` 为 `ready`、`retryable` 或 `not_connected`。 |
| `GET /api/studio/model-catalog` | `providers` 为实际配置；单独的 `preview` 仅供未连接状态展示，不能写入生成配置。 |

`generation.status` 分为：

- `ready`：已经取得生成授权并同步模型。
- `models_pending`：授权已取得，模型同步失败；保留登录并允许重试。
- `action_required`：自动授权尚未完成、授权被停用或本机记录无法保存；保留网站登录，给出可恢复的提示。

主要代码：

- `app/studio_account.py`：登录、两步验证、退出及账户流程锁。账户刷新与登录/重试共用锁，避免旧响应影响新凭证。
- `app/studio_account_provision.py`：账户专属令牌、凭证生命周期、重试与创建结果核对。
- `app/studio_account_extension.py`：脱敏上游调用、注册和余额扩展。
- `app/studio_settings.py`、`app/studio_catalog.py`：保存后同步、模型分组和偏好保留。
- `app/static/studio-account-skills.js`、`app/static/studio-settings.js`：连接结果、重试、跨页面刷新和只读官方渠道。
- `app/studio_capabilities.py`：G2 的 `5–2000` 字符提示词范围。`studio_catalog.py` 同时拦截旧的图片生成入口，避免旧界面绕过校验。

## New API 对接契约与验证边界

以登录会话 Cookie 和 `New-Api-User` 请求头调用用户范围内的：

- `GET /api/token/search`：按本机令牌名称查询；只接受名称完全相同、账户匹配的记录。
- `POST /api/token/`：首次创建生成令牌；不使用管理账户或管理 API Token。
- `POST /api/token/{id}/key`：取得完整生成 Key。老版本缺少此接口时，仅在 `404/405` 后尝试 `GET /api/token/{id}`；若仍是掩码则明确失败。
- `GET /v1/models`：使用生成 Key 查询可用模型，不携带网站 Cookie。

接口依据：[New API 官方路由](https://github.com/QuantumNous/new-api/blob/main/router/api-router.go)、[令牌控制器](https://github.com/QuantumNous/new-api/blob/main/controller/token.go)。

创建请求发出前先持久化“结果待确认”记录。如果请求超时或上游返回不确定结果，下次重试先查找同名令牌，**不会直接重复创建**。查不到记录时保留状态，提示用户到 API 网站检查。不要为了消除错误提示自动清除这条记录，否则会丢失防重复保护。

已使用模拟上游验证登录、两步验证、并发切换、退出/过期、创建超时、磁盘写入失败、旧接口回退、模型同步及 G2 校验，并回归验证旧项目缺失账户渠道、旧版设置改端口、替换密钥、导入配置和重新连接清理的边界。浏览器测试使用真实本地后端和模拟 API 网站，未使用真实用户密码、未创建真实网站令牌、未发起付费生成。公开 `/api/status` 可确认网站支持密码登录，但不能证明该网站所有私有授权接口已经与当前实现联调通过。
