# qflarebot-plugin-social (v0.11.1)

基于 QFlareBot 官方插件框架（SDK 契约 v5）开发的 **自适应多模态拟人 Social Agent 插件**（自然群聊 + 自适应三通道路由 + 无感工具调用 + `core.tools` 生态接入 + 图片理解 + 表情包素材库 + AI 原生语音互动 + 长期记忆），可在停用官方 `qflarebot-plugin-agent` 后完全独立运行。

## 核心特性

- **自适应三通道路由（Fast / Smart Tool / Full Agent）**：普通闲聊走零工具 Fast Chat（支持模型自主 `[[escalate]]` 升级与 `[[silence]]` 静默）；非 `@` 群聊中出现天气、时间、联网搜索、模糊追问等自然意图时自动进入 Smart Tool Chat（精选 ≤ 3 个候选工具）；多工具协作与 `/ask` 进入 Full Agent，严格遵守既有冷却与每日自动工具上限。
- **内置工具 + SDK v5 `core.tools`**：内置时间、实时天气、联网搜索（Tavily/Bocha）、网页读取、抽签掷骰、群记忆/表情检索等 8 个低风险工具；自动发现其他插件公开的 `core.tools` 工具（默认白名单关闭）并支持工具图片附件直接交付。
- **AI 原生语音回复**：优先支持阿里云百炼千问 TTS（含 `qwen-audio-3.1-tts-plus` 自动路由 `SpeechSynthesizer` 与 `qwen3-tts-flash`）、MiniMax Speech、OpenAI Compatible TTS；支持 `manual / probability / ai / always` 四种模式，失败自动降级文字，避免语音和文字重复发送。
- **按需图片理解（Vision）与表情包库（R2 + D1）**：解析当前及引用图片、SHA-256 缓存复用、主动授权收藏（`/收藏表情`）、默认跨群共享表情库与智能表情包回复。
- **群级隔离长期记忆与隐私保护**：TTL 过期、敏感脱敏、反讽/猜测过滤、成员自助 `/social forgetme` 与 `/social privacy off`。
- **生态兼容与全功能管理后台**：对外导出兼容 `services.agent` 提示词服务；`/p/social/ui/` 提供群状态、记忆管理、表情包管理、在线语音试听与费用统计、Agent 工具白名单、7 日模型用量与真实工具执行日志。

## 群聊常用命令

| 命令（别名） | 权限 | 说明 |
| --- | --- | --- |
| `/ask <问题>`（`/问`） | 所有人 | 向 Social Agent 提问（支持工具调用） |
| `/social status`（`/社交 状态`） | 所有人 | 查看本群状态、权限、模型用量与多模态/语音诊断 |
| `/social tools`（`/工具列表`） | 群管理员 | 查看启用的内置工具与外部 `core.tools` 白名单 |
| `/social say <文本>`（`/说`） | 所有人 | 手动合成并发送 QQ 原生语音消息 |
| `/social voicetest <wav-b64\|wav-url\|url>` | 群管理员 | 实测 QQ 原生语音发送回执 |
| `/social persona [ID\|off]` | 群管理员 | 查看或切换本群人格（`lively`/`witty`/`warm`） |
| `/social mode <auto\|at\|off>` | 群管理员 | 切换本群发言模式 |
| `/social collect [标签] [分类:xxx]`（`/收藏表情`） | 所有人（`global` 需管理员） | 收藏当前或引用消息中的表情包 |
| `/social memes [关键词\|disable\|enable\|del]`（`/表情库`） | 查询所有人 / 管理需管理员 | 搜索或管理本群表情包 |
| `/social memory [list\|add\|clear]` | 群管理员 | 查看、添加或清空本群长期记忆 |
| `/social forgetme`（`/忘掉我`） | 所有人 | 删除本人在本群的全部个人记忆 |
| `/social privacy <on\|off>` | 所有人 | 开关本人在本群的记忆收集 |
| `/social sync`（`/同步人格`） | 群管理员 | 同步本群人格基调到 Agent 插件 |

## 开发与构建

将本仓库与 `QFlareBot` 并排放置后执行：

```bash
# 1. 构建官方 SDK 与 CLI（首次）
(cd ../QFlareBot && pnpm install --filter '@qqbot/plugin-cli...' && pnpm --filter '@qqbot/plugin-cli...' build)

# 2. 安装依赖并校验
npm install
npm run typecheck
npm test
npm run build
npm run sync
```

## 文档

- [更新日志](./CHANGELOG.md)
- [需求规格说明书](./docs/requirements.md)
- [系统架构设计](./docs/architecture.md)
- [开发计划](./docs/development-plan.md)
