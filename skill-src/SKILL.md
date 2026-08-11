---
name: convert-image-to-ppt
description: 使用 V2 源图事实与作者契约，将演示文稿截图、导出幻灯片图片、设计稿或扫描页面重建为可编辑 PowerPoint。适用于图片转 PPT、截图转 PPT、可编辑重建，以及需要精确还原文字、字素度量、局部颜色、渐变、蒙版、图标、表格、路径、连接线、裁切和视觉验证的任务。作者只生成 Reconstruction Spec 与 Evidence Graph；运行时负责场景编译、后端规划、渲染、验证和发布。
---

# 图片转可编辑 PPT V2

## 功能介绍

本 Skill 将演示文稿截图、导出幻灯片图片、设计稿或扫描页面重建为可编辑的 PowerPoint。它适合需要保留文字内容、字素度量、布局几何、颜色、透明度、渐变、阴影、蒙版、图标轮廓、表格、图表原语、路径和连接线的图片转 PPT 任务。

输入是源图以及作者编写的 V2 `Reconstruction Spec` 和 `Evidence Graph`；运行时依次完成 Source Package 规范化、场景编译、Backend Plan 规划、PPTX 渲染、逐页视觉验证、对象清单检查、编辑性检查、包安全检查和事务化发布。输出包括可编辑 PPTX、Object Manifest、Verification Result、逐页 preview/diff、source overlay、review sheet 和 Delivery Manifest。

本 Skill 优先保留可编辑文字、形状、路径、表格、连接线和图表视觉原语。它不会把整页截图、文字截图或简单图标截图冒充为可编辑重建结果；无法证明的图表数据保持 `dataSemantics: "unknown"`，不支持的视觉能力必须显式拒绝或使用已批准的原始图片降级。

## 使用说明

### 前置条件

- Node.js `>=20.9.0`。
- 一张源图，支持 PNG、JPEG 等由运行时解码的图片格式。
- 一个作者契约 JSON，至少包含 `Reconstruction Spec` 和 `Evidence Graph`；作者契约不得写入运行状态或验证结论。

### 标准运行

在已安装 Skill 的目录中执行：

```bash
node scripts/preflight.mjs
node scripts/image2ppt.mjs <source-image> \
  --contracts <v2-author-contracts.json> \
  --workspace <workspace-dir> \
  --run-id <run-id>
```

源码项目中也可以从项目根执行同一流程：

```bash
node packages/cli/src/image2ppt.mjs <source-image> \
  --contracts <v2-author-contracts.json> \
  --workspace <workspace-dir> \
  --run-id <run-id>
```

命令成功时会返回 `runDir`、PPTX、Verification Result 和 Delivery Manifest 路径；只有 `Verification Result.status` 为 `passed` 且 `current` 指向已发布 Delivery Manifest 时，才可以交付 PPTX。失败时命令返回非零状态，保留运行目录和诊断，不生成成功发布指针。

### 结果检查

交付前必须查看 `runs/<run-id>/previews/`、`diffs/`、`source-overlay.png`、`review-sheet.png` 和 `verification-result.json`。重点确认文字换行与基线、局部颜色与效果、表格/连接线结构、对象映射和编辑性门均通过；不能只看 PPTX 文件是否生成。

### 契约与质量规则

作者开始编写前必须阅读 `references/v2-authoring-contract.md`；涉及精度验收时阅读 `references/accuracy-rules.md` 和 `references/layout-rules.md`。修改契约后先运行：

```bash
node packages/core/src/validate-v2-contracts.mjs authoring-contracts.json
```

运行时可在作者声明的范围内使用独立 optimizer patch，但不会修改源图事实或作者成功状态。独立 golden corpus 只用于额外质量门，renderer 自举样例不能证明真实图片还原能力。

将 Source Package 记录的规范化像素视为唯一源图事实。开始编写前，必须完整阅读 `references/v2-authoring-contract.md`。JSON Schema 是字段结构的最终权威：

- `schema/v2/reconstruction-spec.schema.json`
- `schema/v2/evidence-graph.schema.json`
- `schema/v2/shared.schema.json`

不得编写或输出 V1 六平面 Task Bundle、Visual IR、Render Plane、Backend Plan、Verification Result 或 Delivery Manifest。作者只有两个可写契约：

- Reconstruction Spec：重建目标、强类型节点、几何、外观、内容和编辑性要求。
- Evidence Graph：待验证的源图测量声明、主体、源区域、容差、来源和置信度。

## 强制边界

- 不得写入 `passed`、`proved`、`selected`、`success`、`coverage`、`verificationStatus`、`terminalStatus`、候选输出或发布状态。
- 不得让 Evidence Graph 自己宣告声明成立。Evidence 是待验证输入，不是证明结果。
- 不得让 Renderer 猜测布局、字体、裁切、降级或对象类型。所有可见意图必须在作者契约中明确，所有后端策略由运行时规划。
- 不得使用整页截图、文字截图、简单图标截图或擦字背景作为可编辑重建结果。
- `approved-original-raster` 只允许源内容本身为照片、纹理、品牌标识或复杂插画，并且必须有 image-region Evidence。
- 图表数据无法从源图证明时，必须声明 `dataSemantics: "unknown"`，并用可编辑子原语重建可见图形；不得伪造数据。
- `custom-semantic` 只能保存元数据和语义分组；全部可见内容必须由强类型子节点表达。

## 作者工作流

1. 运行 Source Normalizer，取得 Source Package、规范化页面尺寸、色彩空间、Alpha、原始摘要、规范化像素摘要和内容寻址 Blob。
2. 逐页检查源图，盘点文字、形状、路径、图片、图标、连接线、表格、列表、图表、裁切、蒙版、效果、颜色和空间关系。
3. 为每页建立一个 `group` 根节点，根节点的 frame 和 bounds 与 Source Package 的规范化画布一致。
4. 用强类型节点树表达全部内容：`group`、`shape`、`text`、`path`、`image`、`icon`、`connector`、`table`、`table-row`、`table-cell`、`list`、`list-item`、`chart`、`custom-semantic`。
5. 精确填写 geometry：局部 frame、二维或透视变换、layout/content/ink/effect bounds、clip stack 和 mask stack。不能表达的透视仍要如实记录，交给 Backend Planner 明确拒绝或降级。
6. 精确填写 appearance：多层 fill、stroke、effect、透明度、混合模式和 group isolation。不得用平均纯色替代可见渐变，不得删除难以渲染的边框或效果。
7. 精确填写内容子模型。文字保留 Unicode、字素边界、run、段落、视觉行、墨迹框和可选定位簇；图片保留原始资源、源区域、裁切、焦点和批准理由；结构组件保留行列、单元格、列表级别或可编辑图表原语。
8. 为所有显著事实建立 Evidence。大范围区域不能替代具体测量；每条 Evidence 必须有类型化 measurement、明确 subjects、一个或多个 sourceRegions、容差、来源和置信度。
9. 运行 V2 契约校验。Schema 或跨契约引用失败时，只修正作者数据；不得写入运行状态绕过校验。
10. 将 Source Package、Reconstruction Spec 和 Evidence Graph 交给 V2 流水线。Core、Backend Planner、Renderer、Verifier 和 Publisher 生成其余契约与产物。
11. 根据 Verification Result 修正对应责任层。若运行时启用 Fidelity Optimizer，它只能以独立 runtime patch 在作者声明的可调范围内迭代；不得回写作者契约、源图事实或质量阈值。
12. 优化每轮必须保留候选、应用 patch、组件指标变化、回退原因和停止原因。标题、文字、表格、连接线或对象映射退化时，即使全局分数提高也不得视为成功。
13. 只有所有组件级视觉门、editability、Object Manifest、package safety 和独立 golden corpus 门通过，且 Delivery Manifest 发布成功后才能交付；并且必须实际查看逐页 preview、diff、source overlay 和 review sheet。

## 作者输出

作者工作区只应包含：

- `source-package.json`：运行时生成，只读。
- `reconstruction-spec.json`：作者生成和修改。
- `evidence-graph.json`：作者生成和修改。
- `blobs/`：按摘要寻址的图片、字体、蒙版、裁图和证据资源。

运行时输出的 Resolved Scene、Backend Plan、Object Manifest、Verification Result、Delivery Manifest、PPTX、预览图和诊断报告不得回写为作者输入。

## 本地契约校验

在源码项目中可执行：

```bash
node packages/core/src/validate-v2-contracts.mjs authoring-contracts.json
```

`authoring-contracts.json` 可以只包含 Source Package、Reconstruction Spec 和 Evidence Graph。完整字段示例见 `examples/v2/authoring-comprehensive.json`。

## 交付要求

一次成功交付必须由运行时产生不可变 run 目录和 Delivery Manifest，并至少包含：

- 候选 PPTX 与 Object Manifest
- 每页 preview、diff、source coverage overlay 和 review sheet
- Verification Result
- build log 与 environment snapshot
- 所有被引用 Blob 的摘要与位置

任何页面、Evidence、Scene Node、Backend Plan operation、原生对象、编辑性或包安全门槛失败，都不能生成成功 Delivery Manifest。

独立 golden corpus 的快速检查由 `npm run test:golden-corpus` 执行；全量输入检查使用 `npm run test:golden-corpus:full`。renderer 自举样例只能用于 smoke，不可作为真实图片还原能力的成功证明。

## 技能验证

修改 Schema、Core、Renderer、CLI 或 Skill 模板后，在项目根执行：

```bash
openspec validate enhance-image-restoration-fidelity --strict
npm test
npm run audit
```
