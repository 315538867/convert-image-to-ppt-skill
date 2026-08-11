# evidence-graph Specification

## Purpose
TBD - created by archiving change redesign-image-to-ppt-v2-architecture. Update Purpose after archive.
## Requirements
### Requirement: Evidence Graph records claims, not conclusions
The system SHALL use Evidence Graph to record source-backed measurement claims, provenance, subjects, source regions, tolerances, confidence, and evidence blob references. It MUST NOT record passed, proved, selected, success, or final verification conclusions.

#### Scenario: Evidence is authored for title spacing
- **WHEN** an author measures spacing between a title and subtitle
- **THEN** Evidence Graph records the source region, measured distance, axis, tolerance, subjects, provenance method, and confidence without recording that the spacing has passed verification

### Requirement: Evidence Graph supports responsibility closure
The system SHALL allow verification to derive responsibility closure from Evidence subjects, Reconstruction Spec evidenceRefs, Resolved Scene source mappings, Backend Plan operations, and Object Manifest objects.

#### Scenario: Source pixel is covered by declared responsibility
- **WHEN** a salient source pixel is inside an evidence-backed node region and that node maps through scene, plan, and manifest objects
- **THEN** the verifier may count it as covered only after comparing rendered output and closure consistency

#### Scenario: Oversized evidence cannot self-prove
- **WHEN** an author creates a single oversized evidence region covering unrelated visible content
- **THEN** validation or verification fails unless the region has valid typed measurements and subjects for each covered responsibility

### Requirement: Evidence Graph covers multiple evidence kinds
The system SHALL support evidence kinds for text content, text ink, geometry, edge, color, gradient, spacing, alignment, containment, overlap, occlusion, mask, image region, reading order, and editability intent.

#### Scenario: Gradient evidence is required
- **WHEN** a source element uses a visible gradient
- **THEN** Evidence Graph records gradient stops, direction or geometry, source region, and tolerance sufficient for the verifier to evaluate it

#### Scenario: Reading order is relevant
- **WHEN** a reconstructed page contains multiple text blocks
- **THEN** Evidence Graph can record reading-order evidence that Core and verification use to preserve accessibility and edit ordering

### Requirement: Evidence Graph records text metric evidence
系统 SHALL 支持文字度量 evidence，包括 token、字符框、单词框、baseline、x-height、cap-height、行框、字距、段落间距、字体候选和脚本语言。每条 evidence MUST 关联源区域、置信度、测量方法、容忍度和目标文本节点。

#### Scenario: Mixed Chinese and Latin text is measured
- **WHEN** 源图文本包含中文、英文和数字混排
- **THEN** Evidence Graph 记录分 token 或分 run 的字符框、baseline、字体候选和 spacing evidence

#### Scenario: OCR text conflicts with author text
- **WHEN** OCR token 与作者声明文本不一致
- **THEN** Evidence Graph 记录冲突和置信度，但不得直接替换作者文本

### Requirement: Evidence Graph records structural primitive evidence
系统 SHALL 支持表格网格、图表 primitive、流程图节点、连接线、箭头、图标轮廓、路径控制点和连通域 evidence。结构 evidence MUST 标明语义确定程度、可编辑目标类型和未知字段。

#### Scenario: Flowchart connector is detected
- **WHEN** 源图包含连接两个形状的箭头线
- **THEN** Evidence Graph 记录线段端点、箭头样式、连接目标候选、遮挡关系和置信度

#### Scenario: Icon outline has no semantic identity
- **WHEN** 图标轮廓可见但无法证明其业务语义
- **THEN** Evidence Graph 记录路径/轮廓 evidence，并将语义标记为 unknown

### Requirement: Evidence Graph records high fidelity appearance evidence
系统 SHALL 支持颜色、透明度、渐变、阴影、发光、模糊、多重描边、非对称圆角、mask、clip 和 blend evidence。appearance evidence MUST 提供局部采样、参数候选、误差容忍度和适用 bounds。

#### Scenario: Gradient needs geometry fitting
- **WHEN** 源图元素使用非线性或径向渐变
- **THEN** Evidence Graph 记录渐变类型候选、颜色 stops、几何中心/半径或方向、采样点和误差容忍度

#### Scenario: Shadow overlaps neighboring content
- **WHEN** 阴影与相邻元素重叠
- **THEN** Evidence Graph 记录阴影 bounds、主体 bounds、重叠关系和可分离置信度

### Requirement: Evidence Graph supports evidence quality diagnostics
系统 SHALL 为 evidence 输出覆盖率、冲突、低置信度、过宽区域和缺失测量诊断。系统 MUST 允许验证器和 Optimizer 按诊断决定是否使用该 evidence。

#### Scenario: Evidence region is too broad
- **WHEN** 单条 evidence 区域覆盖多个无关组件且缺少分组件 subjects
- **THEN** Evidence Graph validation 标记 broad-evidence-region 并阻止其作为单一责任证明

#### Scenario: Required evidence is missing
- **WHEN** 可编辑文本节点没有足够文字墨迹、baseline 或字体候选 evidence
- **THEN** 系统报告 missing-text-metric-evidence，后续文字拟合不得静默使用默认值
