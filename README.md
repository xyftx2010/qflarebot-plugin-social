# qflarebot-plugin-social

基于 QFlareBot 官方插件框架（SDK 契约 v5）开发的 QQ 群聊拟人化娱乐互动插件。

## 核心特性

- **自然群聊与权限诊断**：同时监听 `qq.group.at_message` 与 `qq.group.message`，严格过滤 `session.addressedToOthers`，提供 `/social status` 实时验证群主是否已开启「获取群内全部消息」权限。
- **零重复回复协同**：默认开启 `yield_at_to_agent`，与 `qflarebot-plugin-agent` 同群共装时由 Agent 统一接管 `@机器人` 与 `/ask` 复杂任务，本插件负责非 `@` 自然插话，并通过 `ctx.service('agent').registerPrompt()` 与 SDK v5 `tools` 向 Agent 共享人格基调与群聊记忆。
- **零 LLM 成本智能触发与冷却**：先经前置守卫与启发式评分器判断再调用 `ctx.service('llm')`，支持群级冷却与每分钟回复上限。
- **群级隔离记忆与隐私保护**：全量基于 D1（`WITHOUT ROWID` + 单群单行滑窗状态 + 节流过期清理），支持敏感信息脱敏、保存期限（TTL）、成员自助 `/social forgetme` 与 `/social privacy off`。
- **专属管理页**：提供 `/p/social/ui/` 管理页面（接入 `/tokens.css` 与 `/bridge.js`），支持群模式/人格调整与记忆管理。

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

- [需求规格说明书](./docs/requirements.md)
- [系统架构设计](./docs/architecture.md)
- [开发计划](./docs/development-plan.md)
