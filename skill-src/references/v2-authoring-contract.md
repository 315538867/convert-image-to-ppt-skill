# V2 作者契约

本文定义 Codex 编写 Reconstruction Spec 与 Evidence Graph 时必须遵守的边界。Schema 是字段结构权威，本文解释字段为何存在以及何时使用。

## 1. 权属

Source Package 由 Source Normalizer 生成，作者只读。作者只写 Reconstruction Spec 和 Evidence Graph。Resolved Scene、Backend Plan、Object Manifest、Verification Result 与 Delivery Manifest 都由运行时生成。

作者契约只能表达意图与待验证声明，不能表达成功。任何覆盖率、证明状态、候选选择、终止状态和发布结果都属于运行时事实。

## 2. Reconstruction Spec

每页只有一个 `group` 根节点。所有可见内容都必须位于强类型节点树中：

- `group`：分组、叠放和继承边界。
- `shape`：矩形、圆角矩形、椭圆、多边形、星形、标注和自由形状。
- `text`：Unicode 内容、字体、run、段落、视觉行、墨迹和定位簇。
- `path`：move、line、quadratic、cubic、arc 和 close 命令。
- `image`：原始栅格资源、源区域、裁切、焦点、主体和颜色调整。
- `icon`：有语义名称的可编辑矢量组，至少包含一个 shape/path/group 子节点。
- `connector`：端点、节点锚点、路由、路径和箭头。
- `table/table-row/table-cell`：表格结构、行列尺寸、合并、内边距和对齐。
- `list/list-item`：列表类型、级别、标记和可编辑内容。
- `chart`：图表类型、数据语义、坐标轴、图例、序列或可编辑视觉原语。
- `custom-semantic`：只有元数据和强类型可见子节点的未知语义组件。

## 3. 几何

`geometry.frame` 是节点局部框。`transform` 明确记录二维仿射矩阵或无法忽略的透视矩阵。`bounds` 分别记录：

- layout：布局占位范围。
- content：子内容可用范围。
- ink：可见像素或字形墨迹范围。
- effect：阴影、发光、模糊等效果后的完整范围。

clip 与 mask 是有序堆栈。mask 可以引用强类型节点或内容寻址 Blob。不得把蒙版烘焙进整块源图裁片来规避可编辑性要求。

## 4. 外观

fill、stroke 和 effect 都是有序数组，顺序就是合成顺序。渐变必须保存类型、几何和有序色标。逐边边框用独立 stroke 表达，不得假设四边相同。效果必须保存实际参数，不能只写一个模糊的样式名称。

blend mode、opacity 与 isolation 必须显式保存。即使 PPTX 后端不能原生表达，也应如实记录，由 Backend Planner 决定 OOXML 后处理、原语降低、批准栅格或拒绝。

## 5. 文字

文字必须保留源图中的 Unicode 内容和换行。`indexing.utf16Boundaries` 保存字素边界，所有 run 和 paragraph range 都使用字素索引。每个 run 必须保存字体候选、字号、字重、样式、颜色、字距、基线偏移、OpenType feature 和变量字体轴。

视觉测量至少包含 inkBounds 和 visualLines。只有每个字素簇可独立塑形时才使用 positioned-clusters；阿拉伯文、连字和其他上下文塑形内容不能拆成孤立字符。

不得用字符数乘平均字宽、OCR 框宽或空格填充来推导排版。

## 6. 图片与批准栅格

image 节点只能引用已声明 Blob。必须记录 contentKind、derivation、sourceRegion、fitMode、crop、focalPoint、颜色调整和 rasterApproval。

`approved-original-raster` 只允许：

- photograph
- texture
- brand-mark
- complex-illustration

文字、简单图标、整页截图、擦字背景、源图派生复合背景默认不得批准。批准图片必须有 image-region Evidence，将资源摘要、源区域、裁切和主体边界绑定在一起。

## 7. 表格、列表与图表

表格必须保留 table -> table-row -> table-cell 结构。单元格的填充、边框和文字是独立可编辑事实。

列表必须保留列表类型、层级和 marker，不能只把项目符号拼进普通文本。

图表数据只有在 Evidence 能证明来源时才能声明 `dataSemantics: "known"`。无法证明时必须使用 `unknown`，series 为空，并用 shape/path/text/group 子节点重建可编辑的可见原语。

## 8. Evidence Graph

每条 Evidence 包含：

- `kind`：声明种类。
- `subjects`：涉及的节点及其角色。
- `sourceRegions`：一个或多个规范化源图区域及用途。
- `measurement`：与 kind 匹配的强类型测量。
- `tolerances`：允许的空间、比例、颜色或边缘误差。
- `provenance`：测量方法、生产者和证据 Blob。
- `confidence`：置信分数及其依据。

支持的 kind 包括 text-content、text-ink、geometry、edge、color、gradient、spacing、alignment、containment、overlap、occlusion、mask、image-region、reading-order 和 editability-intent。

Evidence 不能包含 passed、proved 或 success。一个覆盖很大的 sourceRegion 也不能证明所有内容；验证器只在类型化测量、subjects、渲染结果和对象闭包一致时计算责任覆盖。

## 9. 编辑性

`editability.requiredAspects` 逐项声明必须保留的编辑能力，包括 content、geometry、appearance、text-style、crop、path-points、connector-endpoints、table-structure、list-structure、chart-primitives 和 group-membership。

`allowedFallbacks` 是允许规划器评估的策略集合，不代表这些策略已通过。是否可执行及是否通过验证，只能由 Backend Plan 和 Verification Result 决定。

## 10. 禁止事项

- 禁止作者写运行状态或验证结论。
- 禁止整页、近整页、文字和简单图标的截图代理。
- 禁止为了通过视觉分数删除渐变、圆角、边框、蒙版、局部颜色或间距。
- 禁止伪造图表数据或语义。
- 禁止让 custom-semantic 承载不可见的后端指令。
- 禁止让 Renderer 读取作者契约后自行猜测降级。
