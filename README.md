# Image to PPT

将演示文稿截图、导出图片、设计稿或扫描页面重建为高还原度、可编辑的 PowerPoint。项目正在按 OpenSpec 将 V1 六平面任务束整体替换为 V2 契约流水线，不建立 V1 兼容或迁移模式。V2 把源图事实、作者意图、证据、场景编译、后端计划、验证结果和发布清单分离，禁止由渲染器猜测布局或用整页截图伪装可编辑对象。

## 项目结构

```text
packages/core/           V2 契约 Schema、校验器和 Resolved Scene 编译器
packages/renderer-pptx/  PPTX Backend Planner、Backend Plan Renderer 和 OOXML 检查
packages/cli/            Source Package、转换编排、验证、事务化发布和命令行
skill-src/               Codex Skill 的说明、元数据和契约源码
scripts/                 Skill 构建、验证和安装脚本
dist/                    构建生成的 Skill，不纳入版本控制
tests/                   核心与端到端回归测试
submission/              插件提交测试材料
```

## 本地运行

```bash
npm ci
npm run preflight
npm run validate:contracts
npm test
```

## OpenSpec 方案

V2 架构重构从 OpenSpec change 推进，当前入口是：

```text
openspec/changes/redesign-image-to-ppt-v2-architecture/
```

架构文档索引见 `docs/architecture-index.md`。更新 proposal、design、specs 或 tasks 后运行：

```bash
openspec validate redesign-image-to-ppt-v2-architecture --strict
```

## 构建 Skill

```bash
npm run build:skill
npm run test:skill
```

构建结果位于 `dist/convert-image-to-ppt`。该目录中的 `SKILL.md`、Schema、authoring 示例和运行脚本全部由项目源码生成，不得手工修改。

验证通过后安装到当前用户的 Codex：

```bash
npm run install:skill
```

转换命令：

```bash
npm exec image2ppt -- source.png \
  --contracts v2-author-contracts.json \
  --workspace outputs/task-workspace
```

源码模式使用 workspace 包运行；构建 Skill 时，Core、CLI、验证器和 PPTX 适配层会编译为 Skill 内的 ESM 脚本。`sharp` 仍按目标平台安装，`@oai/artifact-tool` 由 Codex 工作区提供。非默认位置通过 `CODEX_ARTIFACT_TOOL_PATH` 指向包目录或入口文件。

## 质量边界

- 作者只编写 Reconstruction Spec 与 Evidence Graph；Source Package、Resolved Scene、Backend Plan、Object Manifest、Verification Result 和 Delivery Manifest 均由运行时生成。
- 作者契约不能伪造测量通过、覆盖率、最终成功状态、候选输出或发布状态。
- 文字、简单图标、形状、边框、连接线、表格、列表和可证明图表原语默认必须可编辑。
- 任何不支持能力必须由 Backend Planner 明确拒绝、批准栅格或降级为可编辑原语，不得由 Renderer 静默近似。
- 成功结果必须在不可变 run 目录中生成 PPTX、Object Manifest、逐页预览、diff、source overlay、review sheet、Verification Result 和 Delivery Manifest。
