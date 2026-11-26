# 开发计划（`qflarebot-plugin-social`）

## 阶段 0：工程初始化与群消息权限验证

- **目标**：初始化官方规范插件工程，构建 `@qqbot/sdk` 与 `@qqbot/plugin-cli`，实现群消息权限诊断能力。
- **交付物**：
  - `package.json`、`tsconfig.json`、`vitest.config.ts`、`.gitignore`、`manifest.json`
  - `/social status` 诊断命令与 `last_non_at_seen_at` 观测机制
- **验收**：`npm run typecheck`、`npm test`、`npm run build`、`npm run sync` 全部通过。

## 阶段 1：核心拟人对话 MVP

- **目标**：完成自然对话、人格设定、滑窗上下文、智能发言判断、冷却控制、群聊记忆与隐私保护的完整闭环。
- **交付物**：
  - `src/store/`：D1 建表、惰性补列迁移、群状态与记忆访问层
  - `src/trigger/`：`gate.ts` 零成本前置守卫 + `scorer.ts` 启发式发言评分器
  - `src/persona/`：内置人格预设、群级人格绑定与 Prompt 拼装
  - `src/memory/`：滑窗上下文、TTL 记忆存取、节流清理、敏感信息脱敏、成员 `/social forgetme` 与 `/social privacy`
  - `src/chat/pipeline.ts`：`ctx.service('llm')` 调用、超时与异常降级、被动回复
- **验收**：全套 Vitest 单元测试覆盖触发、冷却、群隔离、TTL、隐私脱敏、LLM 降级与命令权限；非触发群消息 0 次 LLM 调用。

## 阶段 2：Agent 协同与管理页面扩展

- **目标**：支持与 `qflarebot-plugin-agent` 零冲突协作，并提供面板专属管理页。
- **交付物**：
  - `yield_at_to_agent` 协同策略与 `ctx.service('agent').registerPrompt()` 显式同步（`/social sync-agent` 或管理页触发）
  - SDK v5 `definePlugin.tools` 只读工具（`get_recent_context`、`search_memory`）
  - `src/admin/`：`/p/social/ui/` 管理页面与 `/p/social/api/*` 接口（人格、群配置、记忆查看与删除、隐私管理）
- **验收**：管理页路由鉴权与 CRUD 测试通过；`manifest.json` 正确导出 `tools` 与 `ui` 字段。

## 阶段 3：限额审计与交付收尾

- **目标**：对照官方《发布前自查》核验 D1/KV/CPU/子请求预算，完善测试与文档。
- **交付物**：
  - 边界与异常场景回归测试
  - `README.md` 与完整 `docs/`
  - 最终 `npm run typecheck && npm test && npm run build && npm run sync` 校验通过
