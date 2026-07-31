# 任务束类型参考

以构建产物 `schema/task-bundle.schema.json` 中可执行的 JSON Schema 为权威。本文件只是紧凑的 authoring 导航，不是第二套 Schema。

## 任务束

```ts
type TaskBundle = {
  schemaVersion: 1
  bundlePhase: "authoring" | "final"
  rootArtifactId: ArtifactId
  artifacts: Artifact[]
}
```

`authoring` 可以包含源图 Observation 和语义重建，但所有实测声明都必须为零，所有证明、选择、验证和终止决策都必须处于 pending 状态。只有生产执行器可以生成 `final`。

## Artifact 封装

```ts
type Artifact = {
  artifactId: `art_${string}`
  artifactType:
    | "core-safety-profile"
    | "source-plane" | "observation-plane" | "ownership-plane"
    | "semantic-plane" | "render-plane" | "verification-plane"
    | "resource" | "policy" | "capability-manifest" | "conversion-contract"
    | "evidence-report" | "trial-candidate" | "semantic-equivalence-proof"
    | "selection-decision" | "task-terminal-decision" | "final-task-manifest"
  namespace: "img2ppt"
  schemaRef: string
  scope: ArtifactScope
  semanticRole: string
  inputs: ArtifactId[]
  createdBy: CreatedBy
  body: object
}
```

Artifact ID 是除 `artifactId` 字段外完整封装的内容地址。引用是 Schema 中标记为 `x-artifact-ref` 的字段。不得手工修改 `artifactId` 或 `inputs`。

## 六个平面

```ts
type SourcePlane = {
  pages: Array<{
    pageId: string
    sourceInputRefs: ArtifactId[]
    canvas: Box
    sourceBlobDigests: BlobDigest[]
    provenance: JsonValue
  }>
}

type ObservationPlane = {
  sourcePlaneRef: ArtifactId
  observations: Observation[]
}

type OwnershipPlane = {
  observationPlaneRef: ArtifactId
  assignments: Array<{
    observationId: string
    pageId: string
    ownerNodeId: string
    responsibility: 1
  }>
  coverage: {
    sourcePixelCoverage: number
    sourceEdgeCoverage: number
    objectResponsibility: number
  }
}

type SemanticPlane = {
  ownershipPlaneRef: ArtifactId
  slides: Array<{ slideId: string; root: SemanticNode }>
  relationGraph: Relation[]
  styleResolutionProofs: StyleResolutionProof[]
}

type RenderPlane = {
  semanticPlaneRef: ArtifactId
  slides: Array<{
    slideId: string
    renderRoot: RenderPrimitive
    globalPaintOrder: string[]
    editabilityMap: EditabilityEntry[]
    fallbacks: Fallback[]
  }>
}

type VerificationPlane = {
  selectedCandidateRef: ArtifactId
  evidenceReportRefs: ArtifactId[]
  proofRefs: ArtifactId[]
  verificationStatus: "pending" | "verified" | "rejected"
}
```

每个 Observation 必须恰好出现在一个 responsibility 为 `1` 的 Ownership 归属中。`sourcePixelCoverage` 和 `sourceEdgeCoverage` 只能由独立源探测器写入，authoring 端不得填写。

## 语义节点

```ts
type SemanticNode = {
  nodeId: string
  kind:
    | "group" | "box" | "text" | "shape" | "image" | "icon" | "connector"
    | "table" | "table-row" | "table-cell" | "list" | "list-item" | "custom"
  box: Box
  declaredStyle: Style
  computedStyle: Style
  paintOrder: number
  children: SemanticNode[]
  text?: TextModel
  path?: PathModel
  connector?: ConnectorModel
  sourceBlobDigest?: BlobDigest
  crop?: EdgeLengths
  imageUsage?: {
    contentKind:
      | "photograph" | "texture" | "brand-mark" | "complex-illustration"
      | "diagram-fragment" | "source-derived-composite"
    derivation: "original-asset" | "source-crop" | "source-derived-composite"
    textRemoved: boolean
    sourceRegion?: Box
  }
  customType?: string
  properties?: JsonValue
}
```

`custom` 是开放的语义扩展节点。它与预设节点具有相同的盒模型、样式、绘制顺序和递归子节点。它必须提供 `customType` 与 `properties`，并包含足够的可见可编辑子节点才能编译，不能授权截图降级。Observation 归属不写在语义节点上，而由 Ownership Plane 的 `ownerNodeId` 单向绑定。

`image` 节点必须提供 `sourceBlobDigest`、`crop` 和 `imageUsage`。`icon` 可以使用同一套图片来源字段，也可以由可编辑子节点表达。

表格和列表都是递归语义结构。其可见单元格、边框、填充、标签、图标和图片均编译为通用原语。PPT 后端不得根据 table、list 或 custom 业务类型增加分支。

## 盒模型与样式

```ts
type Box = {
  x: number; y: number; width: number; height: number
  unit: "px" | "pt" | "emu"
  coordinateSpace: "source-canvas" | "slide" | "parent-content-box"
}

type Style = {
  opacity: number
  padding: EdgeLengths
  margin: EdgeLengths
  borders: { top: Border; right: Border; bottom: Border; left: Border }
  cornerRadii: { topLeft: Length; topRight: Length; bottomRight: Length; bottomLeft: Length }
  clip: "none" | "content-box" | "padding-box" | "border-box"
  fill:
    | { kind: "none" }
    | { kind: "solid"; color: Color }
    | {
        kind: "gradient"
        gradientType: "linear" | "radial"
        angleDeg?: number
        stops: Array<{ offset: number; color: Color }>
      }
}
```

四条边和四个角相互独立。渐变偏移归一化为 `0..1`；线性渐变必须提供 `angleDeg`。渲染器不得推断统一边框、统一圆角或替代纯色填充。

## 文字模型

```ts
type TextModel = {
  content: string
  inkBox: Box
  boundaryPolicy: {
    normalization: "NFC" | "NFD" | "none"
    segmentation: "unicode-grapheme-cluster"
  }
  indexMap: { mode: "explicit-grapheme-boundaries"; utf16Boundaries: number[] }
  hardBreakRanges: TextRange[]
  runs: TextRun[]
  paragraphs: Paragraph[]
  visualLines: VisualLine[]
  layoutMode: "native-flow" | "positioned-clusters"
  positionedClusters: PositionedCluster[]
  wrapMode: "none" | "source-visual-lines" | "native"
  overflow: "visible" | "clip" | "ellipsis" | "shrink-to-fit"
}
```

所有文字范围都通过 `utf16Boundaries` 使用字素索引。run 携带完整字体、颜色、字距、字偶距、基线偏移和可选字形 advance。定位簇携带精确框、墨迹框、基线、advance、行索引、塑形隔离和绘制模式。

只有每个簇都能独立塑形时才使用 `positioned-clusters`。依赖上下文的文字必须保留在 `native-flow` 中；把上下文塑形文字拆成孤立字符属于无效数据。

## Render 原语

编译器只生成五种原语：

```ts
type RenderPrimitive =
  | GroupPrimitive
  | TextPrimitive
  | PathPrimitive
  | ImagePrimitive
  | ConnectorPrimitive
```

后端只消费这些原语。预设形状、图标、边框、表格、列表和 custom 节点必须已由编译器完成降级。

## 证据生命周期

在 `authoring` 阶段：

- Evidence claim 数值为 `0`。
- Proof 状态为 `pending`。
- Selection 状态为 `pending`。
- Verification 状态为 `pending`。
- Terminal 状态为 `pending-verification`。

在 `final` 阶段：

- Claim 包含实测值，并通过对应运算符和阈值。
- Proof 状态为 `proved`。
- Selection 状态为 `selected`。
- Verification 状态为 `verified`。
- Terminal 状态为 `success`。
- Candidate 和 Final Manifest 摘要绑定真实源字节、PPTX、预览图、布局、对象清单、差异图、源覆盖报告、覆盖图、验证报告、构建日志和环境快照。

验证器拒绝其他任何状态组合。
