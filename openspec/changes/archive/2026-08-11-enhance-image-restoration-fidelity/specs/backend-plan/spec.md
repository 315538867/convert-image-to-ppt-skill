## ADDED Requirements

### Requirement: Backend Plan carries high fidelity lowering strategies
系统 SHALL 为非对称圆角、多重描边、复杂渐变、阴影、发光、mask/clip、路径、连接线、表格边框和图表 primitive 选择明确 lowering 策略。每个策略 MUST 声明可编辑对象、OOXML postprocess、允许损失、对象映射和验证责任。

#### Scenario: Rectangle has asymmetric corners
- **WHEN** Resolved Scene 中矩形四角半径不同且 PPTX 单形状无法表达
- **THEN** Backend Plan 使用可编辑 primitive 或 OOXML postprocess 策略，并记录每个输出对象的责任

#### Scenario: Radial gradient is approximated
- **WHEN** 目标后端无法原生表达所需径向渐变
- **THEN** Backend Plan 只可选择声明误差界限的 primitive approximation、OOXML postprocess 或 rejected，不得静默改为纯色

### Requirement: Backend Plan embeds text fitting decisions
系统 SHALL 将文字拟合所需的最终字体族、fallback 字体、字号、tracking、line-height、baseline shift、paragraph spacing、anchor 和 text box strategy 写入 Backend Plan。Renderer MUST 仅消费这些决策，不得重新从源图或作者契约猜测。

#### Scenario: Text requires baseline correction
- **WHEN** Resolved Scene 为文本节点提供 baseline 修正
- **THEN** Backend Plan 包含明确 baseline shift、line spacing 和 textbox bounds 操作

#### Scenario: Font fallback is selected
- **WHEN** 首选字体不可用或无法达到验证容差
- **THEN** Backend Plan 记录 fallback 字体、选择原因和关联 text metric evidence

### Requirement: Backend Plan supports optimizer patch application trace
系统 SHALL 记录哪些 Resolved Scene 字段来自作者契约，哪些来自 Optimizer patch。每个被 patch 影响的 operation MUST 记录 patch id、原值、新值和验证诊断引用。

#### Scenario: Color patch changes fill
- **WHEN** Optimizer patch 调整某个 shape fill color
- **THEN** Backend Plan 对应 operation 记录 patch provenance，并保持原作者节点映射

#### Scenario: Patch conflicts with target capability
- **WHEN** patch 后的 visual requirement 超出 Target Profile 能力且没有 approved fallback
- **THEN** Backend Plan 将相关节点标记 rejected 并阻止 Renderer 输出候选
