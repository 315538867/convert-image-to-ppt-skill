---
name: convert-image-to-ppt
description: 使用绑定源图的六平面任务束，将演示文稿截图、导出幻灯片图片、设计稿或扫描页面转换为可编辑 PowerPoint。适用于图片转 PPT、截图转 PPT、可编辑重建，以及需要精确还原文字、字素间距、局部颜色、图标、表格、边框、路径、连接线、裁切和视觉验证的任务。输出 PPTX、最终任务束、对象清单、预览图、差异图、源覆盖图和验证报告。不适用于没有图片参考的演示文稿创作。
---

# 图片转可编辑 PPT

将源图片像素视为不可变事实。只使用本技能内置的六平面任务束运行时。不得编写或接受 Visual IR 4.x、旧版 Scene JSON 或依赖渲染器猜测的布局数据。

编辑 authoring 任务束前，必须完整阅读 `references/reconstruction-contract.md`。该文件是汇总全部还原规则的强制契约。只有在需要查询 Schema 字段或处理失败门槛时，才按需阅读 `references/task-bundle.md`、`references/task-bundle-types.md`、`references/accuracy-rules.md` 和 `references/layout-rules.md`，不要一次性全部加载。

## 运行前置条件

本技能由 `image-to-ppt` 源码项目编译生成，面向 Codex 工作区运行，不是独立的通用图片转换 CLI。运行环境必须提供 Node.js 20.9 或更高版本和 `@oai/artifact-tool`。默认从 Codex 工作区依赖缓存加载 PPTX 运行库；若安装位置不同，必须通过 `CODEX_ARTIFACT_TOOL_PATH` 指向包目录或入口文件。缺少该运行库时必须明确失败，不得降级为截图式 PPT。

首次安装或 `scripts/node_modules` 不存在时，先按 lockfile 安装公开依赖并执行中文预检：

```bash
SKILL_DIR="${CODEX_HOME:-$HOME/.codex}/skills/convert-image-to-ppt"
npm ci --prefix "$SKILL_DIR/scripts"
npm run preflight --prefix "$SKILL_DIR/scripts"
```

发布或安装 Skill 时不得从其他机器复制 `scripts/node_modules`；其中包含目标平台的原生图片处理二进制，必须在当前环境重新安装。转换运行期间禁止安装或更新依赖。不得直接修改已安装 Skill；所有变更必须回到源码项目重新构建。

## 工作流程

1. 检查每一页源图，盘点所有显著文字、图形、形状、图片、连接线、边框、间距和颜色。
2. 初始化任务工作区，由检查点命令复制当前构建版本的 authoring 模板：

   ```bash
   node "$SKILL_DIR/scripts/task-checkpoint.mjs" init source.png --workspace task-workspace
   ```

   后续只编辑 `task-workspace/work/authoring-task-bundle.json`。
3. 用源图事实替换 Source、Observation、Ownership 和 Semantic Plane 数据。所有框均使用源图像素坐标，语义根节点必须与源画布完全一致。
4. 写入重建契约要求的完整测量数据，包括精确 run、局部颜色、文字墨迹与安全间距、纯色或渐变填充、逐边边框、圆角、可编辑图标路径和间距。禁止依据字符数量等启发式公式推算排版。
5. 使用递归语义节点表达表格、列表、行、单元格、图标文字组合和未知组件。`custom` 只表示未知语义；可见内容仍必须编译为 text、path、image、connector 和 group 原语。简单图标必须编译为 path/group 子节点，不得使用源图裁切。
6. 执行内置命令。在绑定源图前，命令会确定性重建样式证明、Render Plane、依赖闭包和 ArtifactId。
7. 检查验证报告；修改 JSON 前，先将失败归类为 authoring 数据、渲染器或验证器问题。大量同类失败、检查结果被截断，或报告与 OOXML 对象矛盾，都属于运行时缺陷；应修复运行时，不得扭曲源图事实。禁止为了提高分数而删除已测量的圆角、渐变、边框、颜色或间距。
8. 只修正责任层并重新执行，直到严格命令通过。运行时会自动管理源图分析缓存和局部复查图；源图未变化时不得反复加载完整图片。
9. 仅在严格验证成功后交付全部产物。失败运行只保留诊断证据，不发布 PPTX 或最终任务束。明确说明所有不支持的能力；不得用截图替代文字、简单图标或整页内容。

## 命令

```bash
SKILL_DIR="${CODEX_HOME:-$HOME/.codex}/skills/convert-image-to-ppt"
node "$SKILL_DIR/scripts/image2ppt.mjs" source.png \
  --bundle authored-task-bundle.json \
  --output outputs/result.pptx
```

如果包含本地图片资源，提供一个 JSON 对象，将每个已声明的 Blob 摘要映射到文件路径：

```bash
node "$SKILL_DIR/scripts/image2ppt.mjs" source.png \
  --bundle authored-task-bundle.json \
  --asset-map asset-map.json \
  --output outputs/result.pptx
```

命令始终使用严格模式。它会绑定真实源图摘要、校验任务束、渲染可编辑对象、独立探测源覆盖率、比较全页与受保护区域、重新打开 PPTX、修改可编辑对象、写入实测证据、重算 Artifact DAG，并校验最终清单。任何门槛失败都会返回非零退出码，且不能生成成功的最终任务束。

## 必需产物

`result.pptx` 必须同时包含以下配套产物：

- `result.task-bundle.json`
- `result.object-manifest.json`
- `result.preview.png`
- `result.diff.png`
- `result.source-coverage.json`
- `result.source-coverage-overlay.png`
- `result.verification.json`
- `result.layout.json`
- `result.build-log.json`
- `result.environment.json`

未实际查看 `preview`、`diff` 和 `source-coverage-overlay` 前，不得声称任务完成。不得把栅格内容称为可编辑对象。

## 技能验证

修改源码项目后，在项目根执行：

```bash
npm test
npm run audit
npm run build:skill
npm run test:skill
```
