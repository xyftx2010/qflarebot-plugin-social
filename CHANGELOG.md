# Changelog

## [0.11.0] - 2026-11-27

### Added
- **独立 Social Agent Engine（完全接管原生 Agent 群聊职责）**：
  - 移除对 `qflarebot-plugin-agent` 的依赖，改为 `depends: { llm: '*', 'core.tools': 'optional' }`，支持在停用原生 Agent 后独立完成全部群聊与工具任务。
  - 建立「快通道 / ReAct Agent Loop」双通道引擎（`src/agent/loop.ts`）：普通非 `@` 插话保持零工具快通道；`@机器人`、`/ask`（别名 `/问`）及可选单聊按需进入多步 Function Calling 循环，支持思考签名透传、步数/次数/软超时预算控制与重复工具调用死循环防护。
  - 新增消息去重守卫与短期上下文 Token 预算自动压缩（`context_max_tokens`）。
- **内置工具与 SDK v5 `core.tools` 统一接入**：
  - 内置 8 个娱乐与日常查询工具（`src/agent/builtin-tools.ts`）：`social.get_time`、`social.weather`、`social.search_memory`、`social.search_memes`、`social.remember_fact`、`social.roll`、`social.web_search`（Tavily/Bocha）、`social.web_fetch`（SSRF 安全网页读取）。
  - 完整接入框架 `core.tools`（`src/agent/external-tools.ts`）：严格遵循 `capture / list / describe / invoke` 官方契约，默认关闭外部工具、支持管理页白名单勾选与工具图片附件（`artifacts`）直接发送。
- **生态兼容与管理后台升级**：
  - 对外导出兼容的 `services.agent` 提示词服务（`registerPrompt / disablePrompt / clearPrompt / listPrompts`，不含已弃用的 `registerTool`）。
  - 新增 Migration v4（`{tool_policy}`、`{prompt_fragments}`、`{tool_stats}`、`{tool_logs}`、`{llm_usage_stats}`），无损保留所有既有数据。
  - 管理页（`/p/social/ui/`）新增「Social Agent 工具中心、7 日模型用量与工具执行日志」真实面板；新增 `/ask` 与 `/social tools` 命令、[`AGENTS.md`](./AGENTS.md) 与 [迁移报告](./docs/v0.11.0-migration-report.md)。

## [0.10.0] - 2026-11-27

### Added
- **QQ 原生 AI 语音互动**：
  - 第一阶段实测验证通过：基于 QFlareBot 官方 SDK（`media.type = 'voice'`、`file_type = 3`、`msg_type = 7`）直接发送标准 WAV 音频，手机 QQ 原生语音条可正常播放，无需 SILK 转码、无需 FFmpeg 或 VPS。
  - **统一 TTS Provider 接口**（`src/voice/providers.ts`）：支持 MiniMax Speech、阿里千问 TTS（DashScope）、OpenAI Compatible TTS，按各供应商真实能力适配参数；`tts_api_key` 强制 `writeOnly: true` 脱敏存储。
  - **四种智能语音触发模式**（`src/voice/decision.ts`）：`manual` / `probability` / `ai`（同一次主对话 LLM 请求输出 `[[voice:情绪]]` 决定语音与情绪，零额外判断模型调用）/ `always`；语音与文字/表情包严格互斥不重复发送，失败自动降级文字。
  - **资源与成本优化**（`src/voice/service.ts`、`src/store/voice-db.ts`）：短音频（≤ 350KB）直接 `base64` 上传，大音频走临时 R2 + `/p/social/voice/:cacheKey` 短期流式路由；支持相同文本与音色参数的短期缓存复用与过期自动清理、每群每日次数上限与单次字符数上限。
  - **数据库 Migration v3**（`{group_voice_settings}`、`{voice_cache}`、`{voice_logs}`）：支持每群独立语音配置、费用预估统计与发送日志。
  - **管理后台与命令扩展**：`/p/social/ui/` 新增 AI 语音互动统计、在线语音试听（`POST /api/voice/preview`）与最近发送日志；新增 `/social say`（别名 `/说`）与 `/social voicetest`。
- **表情包跨群共享**：新增 `share_memes_across_groups` 配置（默认开启），所有群共享表情包素材库，同时保持群聊长期记忆与上下文的严格群级隔离。

## [0.5.0] - 2026-11-27

### Added
- **图片理解（Vision）**：
  - 支持解析 QQ 消息图片附件与引用消息中的图片附件（`src/vision/media.ts`）。
  - 逐跳 SSRF 校验、流式体积限制、过期链接（403/404/410）识别与降级。
  - 支持独立 `vision_model_alias` 配置、模型 `image` 能力前置校验、每群每分钟频控与按 SHA-256 哈希复用的 D1 图片分析缓存（`{image_cache}`）。
  - 图片语义仅写入短期上下文并参与当前语境回复/接梗，不向长期记忆写入模型猜测的敏感个人属性。
- **表情包素材库（R2 + D1）**：
  - 新增 `/social collect`（别名 `/收藏表情`）与 `/social memes`（别名 `/表情库`），仅响应群友主动授权收藏，绝不自动永久保存群友私人照片。
  - R2 保存原图、D1（`{memes}`）保存元数据、支持 SHA-256 去重、视觉自动提取含义/情绪/标签/场景、群独立素材库与全局素材库隔离、保存期限（TTL）与 R2 同步删除。
  - 新增公开流式图片路由 `GET /p/social/meme/:id`，优先通过 `ctx.publicUrl` 向 QQ 交付图片，缺失时自动回退 base64。
- **智能表情包回复**：
  - 规则优先语义匹配器（`src/meme/selector.ts`），支持纯文本、纯表情包、文本+表情包与不回复决策。
  - 支持表情包发送概率、重复表情包冷却、最大连续表情包次数、防机器人互回/斗图死循环保护与发送失败自动降级纯文本。
- **可追踪数据库迁移与管理后台增强**：
  - 新增 `{schema_migrations}` 迁移追踪表（v1 基础表 + v2 多模态表），无损兼容已有长期记忆数据。
  - 管理页（`/p/social/ui/`）新增近 7 天多模态调用统计面板与表情包素材库搜索/预览/启停/删除功能。

## [0.1.0] - 2026-11-27

### Added
- 初始版本：自然群聊、人格设定、滑窗上下文、智能触发、冷却与频控、群级隔离长期记忆与隐私保护、Agent 协同与 SDK v5 只读工具、D1 合批读取与 `waitUntil` 异步落库。
