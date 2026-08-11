## ADDED Requirements

### Requirement: Verification Result reports component-level diagnostics
系统 SHALL 按页面、组件类型、Evidence、Scene Node、Backend Plan operation 和输出对象记录组件级验证指标。诊断 MUST 包含失败区域、失败类别、误差值、阈值、责任链和可操作修正建议。

#### Scenario: Text block fails similarity
- **WHEN** 某个文本块的边缘、字符框或 baseline 指标未达标
- **THEN** Verification Result 记录该文本节点、失败 crop、误差数值、相关 evidence 和建议调整参数

#### Scenario: Shape color fails tolerance
- **WHEN** 某个形状的局部颜色或透明度误差超出阈值
- **THEN** Verification Result 记录采样区域、目标颜色、实际颜色、delta、透明度估计和候选修正方向

### Requirement: Verification Result records optimization history
系统 SHALL 记录每轮优化的候选、应用补丁、渲染结果、组件指标变化、全局指标变化、回退原因和最终停止原因。历史 MUST 能复现成功或失败路径。

#### Scenario: Candidate is superseded
- **WHEN** 某个候选改善局部指标但后续候选整体结果更优
- **THEN** Verification Result 保留被替代候选的指标和 superseded reason

#### Scenario: Optimization stops on regression
- **WHEN** 新补丁导致关键组件退化
- **THEN** Verification Result 记录 regression、回退到上一候选和被回退补丁 id

### Requirement: Verification Result enforces independent golden corpus gates
系统 SHALL 支持使用独立参考图 golden corpus 验证文字、表格、流程图、图表、透明、渐变、阴影、多页模板和低清晰输入等场景。golden corpus 结果 MUST 与 renderer 自举样例分开记录。

#### Scenario: Golden text sample fails
- **WHEN** 文字 golden 样例未达到组件级阈值
- **THEN** Verification Result 标记 corpus-failure，并禁止将该能力声明为通过

#### Scenario: Renderer-generated sample passes
- **WHEN** 仅 renderer 自己生成的参考样例通过验证
- **THEN** 系统不得把该结果等同于独立图片还原能力通过

### Requirement: Verification Result detects fidelity anti-cheat behavior
系统 SHALL 检测并报告降低阈值、遮盖源图细节、裁剪失败区域、整页截图代理、文字截图代理、未声明 raster fallback、删除对象和修改源事实等 anti-cheat 行为。

#### Scenario: Candidate hides failed region
- **WHEN** 候选通过遮盖或裁剪源图可见内容减少 diff
- **THEN** Verification Result 失败并记录 hidden-source-detail

#### Scenario: Editable text becomes image
- **WHEN** 需要可编辑的文字节点被替换为图片且没有明确 approved fallback
- **THEN** Verification Result 失败 editability-regression
