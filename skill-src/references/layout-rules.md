# 布局重建规则

## 语义树

将每页幻灯片构建为递归 Semantic Plane 树。图标文字组合、卡片、重复行、列表、表格、图例和步骤都应位于各自归属组件之下。`kind: custom` 只用于未知语义；custom 节点仍必须包含可编译为通用原语的可见可编辑子节点。

所有源图派生节点框都以 `source-canvas` 像素解析。只有父框和完整计算内边距均已明确时，子框才可以使用 `parent-content-box`。编译器只执行一次已声明的像素到点转换；PPT 后端不得重新计算布局。内边距、外边距、边框和圆角必须使用明确的上、右、下、左或四角值表达。

## 坐标与关系

同一个框内不得混用 `source-canvas`、`parent-content-box` 和 `slide` 坐标空间。渲染期间不得归一化位置或推断新的仿射变换。

在 `relationGraph` 中记录可测量关系：`contains`、`aligned`、`adjacent`、`overlaps`、`baseline-shared` 和 `icon-label`。关系只验证已解析几何，不得移动节点。重复间隔和外边距继续使用显式框或 spacing Observation 表达。

## 文字

一个语义标签或段落使用一个文字节点。其 TextModel 负责精确内容、字素索引映射、视觉行、基线、run、段落度量、硬换行和定位簇。

TextModel 同时负责字形并集 `inkBox` 和 `boundaryPolicy.minimumClearance`。应用内边距和边框对齐后，受保护墨迹框必须位于文字节点内容框及每个祖先内容框内。不得为了避免换行而把文字框扩展到边框之外；应依据源证据修正字形度量、框边界或容器内边距。

不得仅因共用基线而把无关标签合并到同一文字层，也不得把一句话按单词拆成多个文字层。不得用空格或制表符布局，不得用自动缩小或自动换行补偿错误测量。

文字拟合只能使用作者在 `fitConstraints` 中声明的字体候选、字号、tracking、line-height、baseline shift、段落间距和文本框策略。最终参数由 Backend Plan 固化，Renderer 只执行计划，不能重新测量源图或猜测换行。中英文数字混排、低清晰文字和多行段落都应保留 token、视觉行和 baseline Evidence。

## 重复行、列表与表格

每个重复项都表示为独立组件，其图标、标签、描述、分隔线和背景放在该组件下。通过框和约束保留重复间距。

列表使用包含可编辑子节点的 `list/list-item` 表达。表格使用 `table/table-row/table-cell` 表达，其子节点可以是边框、填充、文字、图标或图片。编译器把全部可见内容降为 `text`、`path`、`image`、`connector` 和结构性 `group`；后端不包含表格或列表专用布局规则。

流程图与连接线必须显式记录节点锚点、端点、路由、箭头和层叠关系，不得用相邻位置推断连接关系。图表必须表达可见的轴、网格、标签、序列和 primitive；底层数据无法证明时保持 `dataSemantics: "unknown"`。复杂渐变、透明、阴影、clip/mask 和多重边框需要以明确 appearance 参数和 effect bounds 表达，允许由后端选择可编辑 primitive lowering 或带误差界限的 OOXML postprocess，禁止静默纯色化或删除效果。

## 绘制顺序

使用节点 `paintOrder` 作为完整解析顺序。编译器写入 `globalPaintOrder`，验证器要求它与可见原语遍历顺序完全一致。不得根据语义类型推导绘制顺序。

## 验证

内置命令始终使用严格模式。在 Observation 或 Semantic Plane 数据中修复失败关系。禁止让 PPT 后端自动分配间距、自动对齐、自动换行或自动裁切节点。
