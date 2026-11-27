# AGENTS.md — `qflarebot-plugin-social` 开发与维护规范

## 项目定位
- QFlareBot 独立多模态拟人 Social Agent 插件，仅用于 QQ 群聊娱乐互动（自然对话、人格设定、短期上下文、长期记忆、图片理解、表情包库、AI 原生语音与日常娱乐工具调用）。
- 不开发 SEO、网站管理、代码执行或业务自动化功能。

## 架构与 SDK 约束
1. **不修改 QFlareBot 核心源码**，所有能力通过 `@qqbot/sdk`（`apiVersion: 5`）、`ctx.service('llm')` 与 `ctx.service('core.tools')` 获取。
2. **零外部运行时依赖 & 零 Durable Objects**：保持 `package.json` 无第三方 `dependencies`、不引入 DO / VPS / DSH / Containers / FFmpeg。
3. **D1 SQL 规范**：所有表名与索引名必须使用 `{占位符}`；非整数主键使用 `WITHOUT ROWID`；禁用 `PRAGMA` / `ATTACH` / `sqlite_master` / `json_each`；所有表变更通过 `src/store/schema.ts` 的 `SCHEMA_MIGRATIONS` 版本化追踪。
4. **免费版配额纪律**：不写 `middleware`；不在消息热路径写 `ctx.kv`；普通非 `@` 插话走快通道（不传工具 Schema）；非关键写库通过 `ctx.waitUntil()` 后置。
5. **隐私与安全**：API Key 必须标记 `writeOnly: true` 且绝不在管理 API 返回明文；外部 `core.tools` 默认关闭、按管理员白名单放行；不向公开仓库提交群聊记录、私人图片或密钥。

## 变更必跑校验
```bash
npm run typecheck
npm test
npm run sync
```
每次修改导出命令、事件、路由或工具后必须运行 `npm run sync` 同步根目录 `manifest.json`。
