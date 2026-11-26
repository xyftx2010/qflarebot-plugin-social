# qflarebot-plugin-social (v0.5.0)

基于 QFlareBot 官方插件框架（SDK 契约 v5）开发的 QQ 群聊多模态拟人娱乐互动插件。

## 核心特性

- **自然群聊与权限诊断**：同时监听 `qq.group.at_message` 与 `qq.group.message`，严格过滤 `session.addressedToOthers` 与其他机器人发言，提供 `/social status` 实时诊断群全量消息权限、对话/视觉模型状态与今日多模态统计。
- **按需图片理解（Vision）**：解析当前消息与引用消息中的图片附件，支持独立视觉模型别名（`vision_model_alias`）、按 SHA-256 哈希复用分析结果、每群每分钟频控与下载/过期/无视觉能力降级。
- **表情包素材库（R2 + D1）**：仅响应群友主动授权收藏（`/收藏表情`），按 SHA-256 去重，R2 保存原图、D1 保存元数据与 TTL 期限，自动提取含义/情绪/标签/适用场景，支持群独立素材库与全局素材库隔离。
- **智能表情包回复**：规则优先语义匹配，支持纯文本、纯表情包、文本+表情包及不回复决策，内置发送概率、重复表情包冷却、最大连续次数与防斗图死循环保护。
- **群级隔离长期记忆与隐私保护**：支持 TTL 过期、敏感信息正则脱敏、拒绝将玩笑/反讽及视觉推测写入长期记忆、成员自助 `/social forgetme` 与 `/social privacy off`。
- **零重复回复 Agent 协同**：支持 `yield_at_to_agent` 协同策略、`ctx.service('agent').registerPrompt()` 显式人格同步与 SDK v5 只读工具。
- **专属管理后台**：`/p/social/ui/` 提供群状态诊断、人格与模式管理、群记忆管理、近 7 天多模态调用统计及表情包素材库预览/启停/删除。

## 群聊常用命令

| 命令（别名） | 权限 | 说明 |
| --- | --- | --- |
| `/social status`（`/社交 状态`） | 所有人 | 查看本群状态、权限与多模态诊断 |
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
