---
name: convert-image-to-ppt
description: 使用 V2 源图事实与作者契约，将演示文稿截图、导出幻灯片图片、设计稿或扫描页面重建为可编辑 PowerPoint。适用于图片转 PPT、截图转 PPT、可编辑重建，以及需要精确还原文字、字素度量、局部颜色、渐变、蒙版、图标、表格、路径、连接线、裁切和视觉验证的任务。作者只生成 Reconstruction Spec 与 Evidence Graph；运行时负责场景编译、后端规划、渲染、验证和发布。
---

# 图片转可编辑 PPT V2

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
11. 根据 Verification Result 修正对应责任层。若大量同类对象失败、报告与 OOXML 对象矛盾，或编译器丢字段，应修运行时，不得扭曲源图事实。
12. 只有 Delivery Manifest 发布成功后才能交付，并且必须实际查看逐页 preview、diff、source overlay 和 review sheet。

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

## 技能验证

修改 Schema、Core、Renderer、CLI 或 Skill 模板后，在项目根执行：

```bash
openspec validate redesign-image-to-ppt-v2-architecture --strict
npm test
npm run audit
```
