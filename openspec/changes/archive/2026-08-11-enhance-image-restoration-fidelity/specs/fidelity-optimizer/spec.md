## Purpose

Fidelity Optimizer 将独立验证失败转化为可追踪、受约束、可回放的修正候选，用于在不伪造源图事实、不放宽质量门槛的前提下提升图片到可编辑 PPT 的视觉还原度。

## ADDED Requirements

### Requirement: Optimizer consumes only runtime proof and bounded author intent
系统 SHALL 从 Verification Result、Source Package 派生物、Evidence Graph、Resolved Scene、Backend Plan 和 Object Manifest 生成修正候选。系统 MUST NOT 把优化器输出写回作者成功状态，MUST NOT 修改源图事实，MUST NOT 降低验证阈值。

#### Scenario: Verification failure becomes patch candidates
- **WHEN** 验证结果包含文字、几何、颜色或结构组件失败
- **THEN** Optimizer 输出带来源诊断、目标对象、参数范围、置信度和预计影响的修正候选

#### Scenario: Optimizer tries to hide failure
- **WHEN** 候选要求降低阈值、裁掉源图细节、替换为整页截图或修改 Source Package canonical facts
- **THEN** 系统拒绝该候选并记录 rejected-optimizer-patch 原因

### Requirement: Optimization runs are deterministic and bounded
系统 SHALL 为每次优化记录输入摘要、候选排序、应用补丁、渲染输出、验证结果和停止原因。系统 MUST 支持最大轮次、最大补丁数量和组件级风险限制，超限时返回可诊断失败而非无限迭代。

#### Scenario: Iteration reaches success
- **WHEN** 某一轮补丁应用后所有必需质量门通过
- **THEN** Optimizer 停止迭代并记录 successful-iteration、应用补丁列表和最终 Verification Result 引用

#### Scenario: Iteration limit is reached
- **WHEN** 已达到最大迭代轮次但仍存在失败门
- **THEN** Optimizer 停止并记录 exhausted-iteration-budget、剩余失败组件和最佳候选结果

### Requirement: Optimizer preserves editability contracts
系统 SHALL 只生成不会破坏目标节点 editability contract 的补丁。若高保真修正需要降低可编辑性，系统 MUST 显式标记为 rejected 或需要人工批准的 approved-original-raster，不得静默降级。

#### Scenario: Text fitting would rasterize text
- **WHEN** 文字拟合候选要求把可编辑文本替换为文字截图
- **THEN** 系统拒绝该候选并保留原文字对象的失败诊断

#### Scenario: Shape lowering adds editable primitives
- **WHEN** 形状效果无法由单个 PPTX 形状表达但可由多个可编辑 primitive 表达
- **THEN** Optimizer 可生成 primitive-lowering 补丁并保持对象 Manifest 的可编辑责任链

### Requirement: Optimizer produces component-level improvement evidence
系统 SHALL 对每个应用补丁记录补丁前后组件级指标变化，包括像素差异、边缘差异、文本盒偏差、颜色偏差、结构匹配和对象映射完整性。系统 MUST 在全局指标改善但关键组件退化时标记风险。

#### Scenario: Global score improves but text worsens
- **WHEN** 全局像素相似度提升但关键标题文本的字符框、baseline 或边缘指标退化
- **THEN** Optimizer 标记 component-regression 并不得把该候选作为默认成功候选

#### Scenario: Patch has no measurable effect
- **WHEN** 应用补丁后相关组件指标变化低于最小有效阈值
- **THEN** Optimizer 记录 ineffective-patch 并降低同类候选排序
