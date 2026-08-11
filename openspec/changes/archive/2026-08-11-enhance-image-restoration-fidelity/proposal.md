## Why

V2 架构已经完成可信边界、独立验证和 V1 删除，但真实图片转 PPT 的还原度仍受限于一次性作者契约和粗粒度视觉反馈。下一阶段需要把验证失败转化为可执行修正，把文字、图形、表格、图表和颜色等细节从“可描述”提升到“可自动拟合、可诊断、可迭代”。

## What Changes

- 新增 Fidelity Optimizer：基于 Verification Result 的失败区域、Evidence、Scene Node 和 Object Manifest，生成受控的自动修正候选，并最多迭代若干轮。
- 新增 Text Metrics Resolver / Text Fitter：对字体候选、字号、tracking、line-height、baseline、CJK/英文/数字混排进行源图驱动拟合。
- 增强 Source Package：允许记录分析派生物，例如 OCR/token evidence、边缘图、轮廓、连通域、颜色采样、表格网格候选和矢量化候选。
- 增强 Reconstruction Spec：支持 optimizer patch 目标、可调参数范围、文本拟合约束、结构恢复候选和跨页 style token。
- 增强 Evidence Graph：增加组件级测量与诊断所需 evidence，包括字体度量、baseline、轮廓、表格网格、图表 primitive、颜色/透明度/阴影/渐变拟合证据。
- 增强 Backend Plan：扩展可编辑 lowering 策略，包括非对称圆角、多重描边、径向渐变近似、阴影/发光 OOXML postprocess、矢量 clip/mask 和结构 primitive lowering。
- 增强 Verification Result：输出可操作诊断与修正建议，按组件类型记录失败原因、修正参数和迭代历史。
- 新增 golden corpus 要求：使用独立参考图覆盖文字、表格、流程图、图表、透明/渐变/阴影、多页模板和低清晰输入，避免只靠 renderer 自举验证。
- 不放宽质量门槛，不允许以截图代理、删除细节或降低阈值换取通过率。

## Capabilities

### New Capabilities
- `fidelity-optimizer`: 将独立验证失败转化为受控修正候选，驱动文字拟合、几何/颜色/结构微调和多轮验证闭环。

### Modified Capabilities
- `source-package`: 增加分析派生物和局部可复用事实，供文字拟合、矢量化、结构恢复和组件级验证使用。
- `reconstruction-spec`: 增加可调参数、拟合约束、跨页 style token 和结构恢复候选表达。
- `evidence-graph`: 增加字体、baseline、轮廓、表格、图表、颜色透明度、阴影和渐变等高精度 evidence。
- `backend-plan`: 增加更细的可编辑 lowering 与 OOXML postprocess 策略，减少 rejected 和粗糙近似。
- `verification-result`: 增加组件级指标、失败归因、修正建议和优化迭代历史。

## Impact

- `packages/cli`: 新增优化编排、分析派生物生成、失败诊断聚合、golden corpus 测试入口。
- `packages/core`: 扩展 V2 schema、跨契约校验、Resolved Scene 字段消费与 style token/fit constraint 校验。
- `packages/renderer-pptx`: 扩展 Backend Planner 和 Renderer 的 lowering/postprocess 策略，不允许 Renderer 越界读取作者契约或源图。
- `skill-src`: 更新作者说明，要求保留可拟合约束和高精度 evidence，不把 optimizer 输出写回作者成功状态。
- `tests`: 新增独立参考图 corpus、文字拟合验收、组件级 diff、自动修正迭代、结构恢复和 anti-cheat 负面测试。
