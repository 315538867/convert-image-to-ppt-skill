# 架构文档索引

## 当前权威入口

- `openspec/changes/redesign-image-to-ppt-v2-architecture/proposal.md`：V2 重构的动机、能力范围和影响面。
- `openspec/changes/redesign-image-to-ppt-v2-architecture/design.md`：V2 目标架构、当前转换流程、JSON 表达力判断、决策、迁移计划和实施决策。
- `openspec/changes/redesign-image-to-ppt-v2-architecture/specs/**/spec.md`：V2 能力规格，是实现和测试的行为契约。
- `openspec/changes/redesign-image-to-ppt-v2-architecture/tasks.md`：V2 实施清单，后续任务按该文件推进并勾选。

## 历史背景

- `docs/architecture.md`：V1 六平面架构说明，保留为当前实现背景，不再作为 V2 新能力扩展入口。
- `docs/architecture-review-2026-07-31.md`：V1 架构审查记录，保留问题证据和整改依据。
- `docs/architecture-v2.md`：OpenSpec 初始化前的 V2 方案草稿，内容已被 OpenSpec change 吸收；后续以 OpenSpec 文档为准。

## 使用规则

- 新增或修改 V2 行为时，先更新对应 OpenSpec capability 和 tasks，再实施代码。
- 修改 Schema、编译器、渲染器或 Skill 模板后必须运行 `npm test` 和 `npm run audit`。
- 每次更新 OpenSpec 方案后运行：

```bash
openspec validate redesign-image-to-ppt-v2-architecture --strict
```

## V1 删除边界

V1 六平面不提供兼容输入、自动迁移或双栈运行模式。V2 闭环完成后删除 V1 Schema、编译器、CLI、Skill 模板和测试；V1 只保留在 Git 历史与历史架构文档中。V2 的目标契约拆为 Source Package、Reconstruction Spec、Evidence Graph、Resolved Scene、Backend Plan、Verification Result 和 Delivery Manifest。
