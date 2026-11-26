# 需求规格说明书（`qflarebot-plugin-social`）

## 1. 项目定位与范围

- **项目目标**：基于 QFlareBot 官方插件框架，构建面向 QQ 群聊的拟人化娱乐互动插件 `qflarebot-plugin-social`。
- **架构组合**：`QFlareBot` + `qflarebot-plugin-llm`（`llm` 服务）+ `qflarebot-plugin-agent`（可选协同）+ `qflarebot-plugin-social`。
- **明确边界**：仅用于 QQ 群聊娱乐互动，不涉及 SEO、网站开发、业务自动化功能；严格遵守官方 `@qqbot/sdk` 契约，不修改 QFlareBot 核心源码。

## 2. 核心功能需求

### 2.1 群消息接收与权限诊断（阶段 0 优先验证）
- 同时订阅 `qq.group.at_message` 与 `qq.group.message` 群聊消息事件。
- 严格遵循框架收件人字段：优先过滤机器人自身消息与 `session.addressedToOthers === true` 的消息（开头 `@` 别人或 `@全体` 且未单独 `@` 本机器人）。
- 提供 `/social status` 诊断命令，展示当前群的发言模式、绑定人格、近期是否收到过非 `@` 普通群消息（用于快速验证群主是否已开启「获取群内全部消息」权限）、冷却状态及 LLM 连通性提示。

### 2.2 自然对话与拟人化回复
- 优先使用 `session.displayContent ?? session.content` 作为模型输入，保留群内 `@` 提及与 QQ 表情语义。
- 说话人称呼优先使用 `session.groupNickname ?? session.userName`，区分同群不同成员。
- 结合引用消息（`session.quote`）提供自然语境，但绝不因「有引用」盲目唤醒，防止误插嘴。
- 全部群聊回复通过被动回复 `session.reply()` 发出，不依赖主动消息权限。

### 2.3 人格设定（Persona）
- 内置多套娱乐向群聊人格模板（如活泼群友、幽默吐槽役、温柔陪伴等），并支持通过配置或管理页自定义人格。
- 支持群级独立绑定人格，群管理员可通过 `/social persona [名称|off]` 随时切换或还原。

### 2.4 上下文管理
- 按群（`session.targetId`）维护独立短期滑窗上下文，控制最大条数与时间有效期，防止超长上下文消耗 Token 与 CPU。
- 仅记录有效文本/图文描述摘要，不把二进制大附件塞入 D1。

### 2.5 智能发言判断与回复冷却
- **双层零 LLM 成本触发**：
  1. 前置守卫：跳过自身消息、`addressedToOthers`、关闭的群、Agent 让渡场景及冷却期内消息。
  2. 启发式打分器：结合是否 `@` 机器人、是否命中呼唤词/昵称、是否疑问句/互动语境、群内消息活跃间隔与基础概率决定是否自然插话。
- **回复冷却与频控**：支持群级最小回复冷却秒数与每分钟最大回复次数限制，杜绝刷屏与超预算调用。

### 2.6 群聊记忆与隐私保护
- **群级强隔离**：所有短期上下文与长期记忆按 `group_id` 严格隔离，严禁跨群读取或串味。
- **保存期限（TTL）**：支持配置长期记忆保留天数（默认 30 天），过期自动失效并在节流清理中删除。
- **成员隐私保护**：
  - 写入记忆前自动脱敏手机号、邮箱、身份证号、长链接凭据等敏感文本。
  - 成员可通过 `/social forgetme` 一键删除本人在当前群的所有记忆。
  - 成员可通过 `/social privacy off|on` 自主退出或重新开启记忆收集（Opt-out）。
  - 群管理员可通过 `/social memory list|clear` 或管理页查看/删除群记忆。

### 2.7 与 `qflarebot-plugin-agent` 的协同与防重复回复
- 普通日常群聊直接调用 `ctx.service('llm')`，低延迟、零 DO 开销。
- 复杂工具任务通过 `/ask`、`/skill`、`/schedule`（或模式 A 下的 `@机器人`）交由 Agent 处理。
- 默认开启 `yield_at_to_agent`（同群共装 Agent 时，`social` 对 `@机器人` 仅记录上下文不重复回复），同时支持通过 `ctx.service('agent').registerPrompt()` 同步人格基调，并通过 SDK v5 `definePlugin.tools` 向 Agent 公开只读群记忆/上下文工具。

## 3. 非功能与平台约束（Workers 免费版）
- 单事件 CPU 预算 ≤ 10 ms（全机共享）：不声明 `middleware`，避免每个事件强制加载。
- 子请求预算 ≤ 50 / 事件：单次触发控制在 3–6 次内。
- KV 写/删/列 ≤ 1,000 次/天：消息热路径禁止写 KV。
- D1 写 ≤ 100,000 行/天：采用 `WITHOUT ROWID`、单群单行 JSON 状态、节流清理策略。
- 单事件硬超时 30 秒：`llm.chat` 超时控制在 12–15 秒内。
