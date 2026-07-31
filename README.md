# Image to PPT

将演示文稿截图、导出图片、设计稿或扫描页面重建为高还原度、可编辑的 PowerPoint。项目使用绑定源图的六平面任务束，把图片理解、语义建模、渲染和验证分离，禁止由渲染器猜测布局或用整页截图伪装可编辑对象。

## 项目结构

```text
packages/core/           六平面协议、Schema、编译器和验证器
packages/renderer-pptx/  PPTX/OOXML 后端和 Codex artifact-tool 适配
packages/cli/            转换编排、缓存、视觉差异、覆盖率和命令行
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
npm test
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
  --bundle authored-task-bundle.json \
  --output outputs/result.pptx
```

源码模式使用 workspace 包运行；构建 Skill 时，Core、CLI、验证器和 PPTX 适配层会编译为 Skill 内的 ESM 脚本。`sharp` 仍按目标平台安装，`@oai/artifact-tool` 由 Codex 工作区提供。非默认位置通过 `CODEX_ARTIFACT_TOOL_PATH` 指向包目录或入口文件。

## 质量边界

- Source、Observation、Ownership、Semantic、Render、Verification 六个平面必须完整。
- 作者任务束不能伪造测量证据或最终成功状态。
- 文字、简单图标、形状、边框和连接线默认必须可编辑。
- 任何不支持能力必须明确拒绝，不得静默近似。
- 成功结果必须同时生成 PPTX、最终任务束、对象清单、预览、差异、源覆盖和验证报告。
