## ADDED Requirements

### Requirement: Reconstruction Spec exposes bounded fitting parameters
系统 SHALL 允许作者为文字、几何、颜色、效果和结构节点声明可调参数范围、锁定字段、优化优先级和禁止降级规则。可调参数 MUST 有单位、边界、默认值、证据引用和可编辑性约束。

#### Scenario: Title text can be fitted
- **WHEN** 作者声明标题文本允许微调字号、tracking、line-height 和 baseline
- **THEN** Reconstruction Spec 记录每个参数的范围、单位、默认值和相关文字 evidence

#### Scenario: Required field is locked
- **WHEN** 节点声明某个几何或文本字段 locked
- **THEN** Optimizer 和 Compiler 不得修改该字段，除非后续输入显式解除锁定

### Requirement: Reconstruction Spec preserves style tokens across pages
系统 SHALL 支持跨页 style token，用于记录字体族、字号层级、颜色、线宽、圆角、阴影、渐变和间距模式。style token MUST 保留具体解析值、来源 evidence、适用范围和允许偏差。

#### Scenario: Multiple pages share heading style
- **WHEN** 多页源图使用同一标题视觉样式
- **THEN** Reconstruction Spec 可用同一 style token 绑定这些标题节点并记录每页局部偏差

#### Scenario: Token conflicts with local evidence
- **WHEN** style token 的解析值与某页局部 evidence 超出允许偏差
- **THEN** 系统标记 token-conflict 并要求局部 override 或人工确认

### Requirement: Reconstruction Spec represents structure recovery candidates
系统 SHALL 能表达表格、图表、流程图、连接线、图标和复杂路径的结构恢复候选。候选 MUST 标明已证明的可编辑语义、未知语义、视觉 primitive、来源 evidence 和 fallback 限制。

#### Scenario: Table grid is recovered from image
- **WHEN** 源图存在可见表格网格和文本单元格
- **THEN** Reconstruction Spec 可记录表格候选的行列边界、单元格文本、边框样式、合并候选和证据引用

#### Scenario: Chart data remains unknown
- **WHEN** 图表视觉形状可恢复但底层数据不能从源图证明
- **THEN** Reconstruction Spec MUST 标记未知数据语义，并用可编辑 graphic primitives 表达可见图形

### Requirement: Reconstruction Spec accepts optimizer patches as separate runtime inputs
系统 SHALL 支持将 Optimizer patch 作为独立 runtime input 叠加到作者 Reconstruction Spec 上。patch MUST 引用原节点、参数路径、原值、新值、证据、验证诊断和生成轮次，不得覆盖原始作者契约文件。

#### Scenario: Patch adjusts text tracking
- **WHEN** Optimizer 为某个文本节点生成 tracking 修正
- **THEN** patch 记录目标节点、tracking 原值、新值、来源失败指标和应用轮次

#### Scenario: Patch references missing node
- **WHEN** patch 目标节点不存在或节点类型不支持该参数路径
- **THEN** 系统拒绝 patch 并记录 invalid-optimizer-patch
