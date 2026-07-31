# 六平面任务束

任务束是转换过程唯一的权威契约。它按内容寻址，包含一份不可变源图、一份语义重建、一份编译后的渲染程序、实测证据和最终决策。`bundlePhase=authoring` 是未经验证的输入；只有生产执行器可以生成 `bundlePhase=final`。

## 六个平面

- Source Plane：精确页面尺寸、源图摘要、方向和解码像素来源。
- Observation Plane：每个可见对象和间距关系的源图像素事实。
- Ownership Plane：每个 Observation 的唯一责任语义节点及实测源覆盖率。
- Semantic Plane：包含解析后盒模型、样式、文字、路径、资源和关系的递归类 HTML 节点。
- Render Plane：只包含编译器生成的 text、path、image、connector 和 group 原语。
- Verification Plane：实测视觉、对象、文件包和编辑性证据。

模型负责源图事实和语义结构，编译器负责 Render Plane，后端只执行 Render Plane，验证器独占成功证据和终止状态的写入权。

## 文字

使用显式 UTF-16 字素边界。所有范围引用字素索引，不得引用 JavaScript code unit。使用 run、段落和视觉行完整划分文字。

每个 TextModel 都必须在与节点框相同的坐标空间和单位中声明字形并集 `inkBox` 与 `boundaryPolicy.minimumClearance`。应用内边距和边框对齐后，墨迹并集及安全间距必须位于自身与所有祖先内容框内。只有 `allowOverlapObservationRefs` 中的精确边缘 Observation ID 才能表示有意重叠。

当源证据包含精确字素框和 advance 时，使用 `layoutMode=positioned-clusters`。每个定位簇必须声明 `frame`、`inkBox`、`baseline`、`advance`、`lineIndex`、`shapingIsolation` 和 `paintMode`。`advance-only` 只能用于没有墨迹的空白。无法独立塑形的上下文文字使用 `native-flow`。

源图中不得重排的行设置 `wrapMode=none`。每种局部颜色都必须保留为独立 run。

## 几何

用路径表达可见几何，直接保存三次贝塞尔和轴对齐圆弧命令，并为箭头提供规范路径与样式。分别保存四条边框和四个圆角。编译器可以把已支持的复合样式降为可编辑路径组；后端不得推断缺失几何。

## 结构

使用递归的 `table/table-row/table-cell`、`list/list-item`、`group`、`box` 和 `custom` 节点。结构节点不得要求渲染器增加专用分支；其可见背景、边框、文字、图标和连接线全部编译为通用原语。

## 证据

每个 Observation 必须恰好有一个 responsibility 为 `1` 的归属。源探测器独立测量显著像素和边缘覆盖率，固定下限分别为 `0.98` 和 `0.96`，并把实测值写入最终 Ownership Plane。候选验证器比较整页、每个受保护 Observation 区域，以及由 Semantic Plane 派生的文字墨迹、可见填充、每条边框、图标、图片和连接线区域。像素比较使用有界栅格化容差，边缘比较使用对称局部匹配；原始指标只用于诊断。平坦填充检查排除更高绘制顺序的内容。`color`、`spacing`、`shape` 和 `image` 始终是独立硬门槛类别。随后，验证器重新打开原生对象，并对清单中的每个非虚拟对象执行编辑、保存、重开探测。

只有实测且通过的证据才能把证明设为 `proved`、验证设为 `verified`、终止状态设为 `success`。每次绑定或更新证据后都要重新计算 Artifact ID 和输入输出摘要。

## Authoring 边界

从 `task-bundle-example.json` 的 `authoring` 模板开始。只编辑 Source、Observation、Ownership 归属和 Semantic Plane 主体。不得手工修改覆盖率、Render Plane、ArtifactId、`inputs`、证据数值、证明状态、验证状态或最终摘要；内置准备器和执行器会确定性生成这些内容。
