# 系统架构设计（`qflarebot-plugin-social`）

## 1. 总体架构

`qflarebot-plugin-social` 作为独立 QFlareBot 插件运行在 Cloudflare Workers 同 isolate 环境中，通过框架官方服务与存储接口完成能力编排：

- **上游模型**：`depends: { llm: '*' }`，内联声明 `LLMService`（`contractVersion: 1`），按模型别名调用 `ctx.service<LLMService>('llm').chat()`。
- **Agent 协同（可选）**：`depends: { agent: 'optional' }`，内联声明 `AgentPromptService`，显式同步人设提示词片段；并通过 SDK 契约 v5 的 `definePlugin.tools` 对外公开只读记忆/上下文查询工具（由框架 `core.tools` 统一托管与鉴权）。
- **持久化存储**：完全基于 `ctx.db`（D1，强制 `{表名}` 作用域占位符），第一阶段不引入 Durable Objects（规避主模块静态求值与跳过 `/healthz` 预览检查的风险，同时避免免费版 13,000 GB-s/天 DO 配额压力）。

## 2. 防重复调用与防重复回复机制

基于 `QFlareBot/packages/runtime/src/dispatcher.ts` 源码事实：
1. 命令（`tier = 0`，默认 `block: true`）在同优先级下恒定先于事件（`tier = 1`）执行；因此 `/ask`、`/skill`、`/social` 等显式命令被命中后不会落入聊天事件。
2. `qflarebot-plugin-agent` 的群聊事件处理器在 `session.atMe === true` 时固定唤醒，且 `event` 的 `block` 为静态属性。
3. 因此本插件采用**零顺序依赖的显式协同模式**：
   - `yield_at_to_agent: true`（推荐同群共装 Agent 时开启）：`social` 仅处理非 `@` 普通群聊的自然插话与上下文/记忆采集；遇到 `session.atMe === true` 时仅轻量记录上下文并直接返回，由 `agent` 统一响应（并借助 `social` 注册的人格提示词片段与 v5 记忆工具保持人设与语境一致）。
   - `yield_at_to_agent: false`（纯娱乐群、面板禁用 Agent 时使用）：`social` 同时接管 `@机器人` 与非 `@` 群聊，全部直连 `ctx.service('llm')`。

## 3. 模块职责划分

| 目录 / 文件 | 职责 |
| --- | --- |
| `src/index.ts` | `definePlugin` 入口：配置、依赖、钩子、命令、事件、服务、v5 工具、路由与管理页声明 |
| `src/types.ts` | 领域模型定义 + 内联 `LLMService` / `AgentPromptService` 契约 |
| `src/config.ts` | `configSchema` 与 `defaultConfig` |
| `src/store/schema.ts` | D1 表结构 DDL（`WITHOUT ROWID`）与 `onInstall`/`onBoot` 惰性建表及补列迁移 |
| `src/store/db.ts` | D1 数据访问层（群设置、群状态滑窗与冷却、长期记忆、成员隐私偏好） |
| `src/trigger/gate.ts` | 前置零成本守卫（自回过滤、`addressedToOthers`、群模式、Agent 让渡、冷却与每分钟频控） |
| `src/trigger/scorer.ts` | 启发式发言评分器（呼唤词、问句、活跃间隔、概率抽样） |
| `src/persona/presets.ts` | 内置娱乐人格预设 |
| `src/persona/manager.ts` | 人格解析、System Prompt 拼装、Agent 提示词片段显式同步 |
| `src/memory/context.ts` | 群级短期滑窗上下文构建与裁剪 |
| `src/memory/privacy.ts` | 敏感信息正则脱敏、成员 Opt-out 检查与自助清除 |
| `src/memory/store.ts` | 群级隔离记忆 CRUD、TTL 过滤、节流过期清理与启发式记忆提取 |
| `src/chat/pipeline.ts` | 对话管线编排、LLM 调用、超时与降级处理、回复记录回写 |
| `src/chat/tools.ts` | SDK v5 工具实现（`get_recent_context`、`search_memory`） |
| `src/admin/routes.ts` | `/p/social/ui/*` 与 `/p/social/api/*` 管理员鉴权路由 |
| `src/admin/page.ts` | 单文件内联管理页（接入 `/tokens.css` 与 `/bridge.js`） |

## 4. D1 表结构与写入预算优化

所有 SQL 严格使用 `{表名}` 占位符，非整数主键均使用 `WITHOUT ROWID` 减少隐藏主键索引写入行数：

1. `{group_settings}`：按 `group_id` 存储群级模式（`auto | at | off`）、人格 ID、冷却秒数、插话概率、记忆 TTL。
2. `{group_state}`：按 `group_id` 单行聚合存储 `recent_messages_json`（滑窗上下文）、`last_reply_at`、`window_start_at`、`window_reply_count`、`last_non_at_seen_at`（用于诊断全量群消息权限）、`last_prune_at`。每次更新仅计 **1 行写入**。
3. `{group_memories}`：按 `id` 主键、`{group_memories_grp}` 复合索引 `(group_id, expires_at)` 存储群公共记忆与成员偏好记忆，支持群级隔离查询与按 `(group_id, user_id)` 精准删除。
4. `{member_privacy}`：复合主键 `(group_id, user_id)` 记录成员 `opt_out` 状态。

## 5. 管理页面与安全边界

- 管理页挂在 `/p/social/ui/`（`auth: 'admin'`），在面板 `sandbox` iframe 中运行，采用单文件内联 HTML/CSS/JS，避免静态资源丢失桥接令牌。
- 所有数据接口挂在 `/p/social/api/*`（`auth: 'admin'`），前端通过 `bridge.fetch()` 自动附带令牌。
- 前端渲染所有用户/群数据一律使用 `textContent` / DOM API，禁止 `innerHTML` 拼接，防止 XSS。
