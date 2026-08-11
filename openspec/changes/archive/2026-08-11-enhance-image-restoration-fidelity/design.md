## Context

当前 V2 已把作者意图、源图事实、编译后的场景、后端计划、对象清单和验证结果拆开，但还原度仍主要依赖一次性作者输入。独立验证能指出失败，却还没有把失败区域稳定转化成可执行修正；文字度量、复杂外观、结构化组件和 golden corpus 也还不足以支撑高保真迭代。

项目边界保持不变：

- packages/core 只处理 schema、契约校验和后端无关的 Resolved Scene，不依赖 PPTX 后端、图片处理库或宿主运行库。
- packages/renderer-pptx 只消费 Backend Plan 和已解析资源，不从源图、作者契约或验证结果猜测布局。
- packages/cli 负责编排、缓存、分析派生物生成、优化循环和验收发布，不得修改源图事实来绕过验证。
- skill-src 只描述作者与运行时契约，dist/convert-image-to-ppt 仍是生成物，不直接修改。

## Goals / Non-Goals

**Goals:**

- 将“验证失败”变成可诊断、可排序、可回放、可拒绝的 optimizer patch。
- 补强文字、结构、颜色、透明、渐变、阴影、路径和表格/图表等高保真 evidence 表达。
- 支持组件级指标和 golden corpus，避免只凭全局像素分或 renderer 自举样例判断成功。
- 保持可编辑优先：文字、简单图标、表格、连接线和常规形状不得用截图代理作为成功路径。
- 允许直接面向 V2 重构，不保留 V1 兼容入口作为前置约束。

**Non-Goals:**

- 不引入端到端机器学习黑盒来直接输出 PPTX。
- 不把源图事实、验证结果或发布状态写回作者 Reconstruction Spec。
- 不用降低阈值、裁剪失败区域、遮盖细节或整页截图来提高通过率。
- 不承诺一次变更覆盖所有 PPTX 不支持的视觉效果；不支持项必须显式 rejected 或 approved fallback。

## Decisions

### Decision 1: Optimizer patch 是独立运行时输入

Optimizer patch 不覆盖作者 Reconstruction Spec，而是作为独立 runtime input 叠加。patch 引用节点、参数路径、原值、新值、证据、失败诊断和迭代轮次。

Rationale:

- 作者意图保持可审计，优化过程保持可回放。
- 失败候选、回退候选和成功候选都能被验证结果引用。
- 避免把运行时“成功/证明”状态污染到作者契约。

Alternatives considered:

- 直接改写 Reconstruction Spec：实现简单，但会混淆作者输入和运行时搜索结果。
- 只在 Backend Plan 内临时改值：不会污染作者文件，但丢失跨轮次复现和人工审阅能力。

### Decision 2: Source Package 增加派生物，但 canonical facts 不可变

OCR、边缘、连通域、颜色采样、轮廓、表格网格、图表 primitive 和局部 crop 都作为派生物引用记录，绑定 canonical pixel digest、源区域、生成器版本和参数摘要。

Rationale:

- 提供文字拟合、结构恢复和局部优化所需的事实输入。
- 派生物可缓存、可复查、可替换，不改变源图身份。
- CLI 可依赖图片处理库生成派生物，Core 仍只消费 JSON 契约。

Alternatives considered:

- 每次验证即时重新分析源图：减少缓存结构，但无法保证跨轮次一致性。
- 把分析结果直接塞进 Evidence Graph：会混淆“观测事实”和“可重用中间资产”。

### Decision 3: 组件级验证优先于单一全局分数

Verification Result 必须按组件类型、源区域、Evidence、Scene Node、Backend Plan operation 和输出对象记录指标。全局分数仍保留，但不能掩盖关键组件退化。

Rationale:

- 图片转 PPT 的失败通常是局部文字、颜色、边框或结构失败，而不是整页均匀误差。
- Optimizer 需要知道“调什么”和“为什么调”，组件级诊断比全局 diff 更有用。
- 组件回归检测能阻止为了整体分数牺牲标题、表格或关键标识。

Alternatives considered:

- 只保留全局 pixel/edge similarity：简单，但无法驱动可操作修正。
- 由人工报告局部失败：可读性强，但不能形成自动迭代闭环。

### Decision 4: 文字拟合拆成 evidence、约束、plan 三层

文字还原度由三层共同完成：

- Evidence Graph 记录 token、字符框、baseline、字体候选、字距和行距等测量。
- Reconstruction Spec 记录可调参数范围、锁定字段、优先级和禁止降级规则。
- Backend Plan 写入最终字体、fallback、字号、tracking、line-height、baseline shift 和 text box strategy。

Rationale:

- Core 不需要图片库，也不需要知道 PPTX 文字实现细节。
- Renderer 不再猜测字体或文本盒，只执行 plan。
- Optimizer 可以在参数范围内搜索，不破坏作者锁定字段和可编辑性。

Alternatives considered:

- Renderer 根据源图或作者契约自行拟合文字：还原度可能提升，但破坏后端边界。
- 只靠作者手写精确文字参数：可审计但成本高，难以覆盖真实截图。

### Decision 5: 复杂视觉效果先以可编辑 lowering 为默认方向

非对称圆角、多重描边、复杂渐变、阴影、发光、mask/clip、连接线、表格边框和图表 primitive 优先通过可编辑 primitive 或 OOXML postprocess 表达。只有源图原始图片区域不可避免且经过批准时，才能走 approved-original-raster。

Rationale:

- 满足“不把截图作为可编辑重建成功结果”的项目约束。
- Object Manifest 能映射每个 primitive 的责任链。
- 复杂效果即使近似，也必须有误差界限和验证责任。

Alternatives considered:

- 对复杂组件直接 raster fallback：视觉上容易接近，但失去可编辑性。
- 全部 rejected：严格但无法推进实际还原度。

### Decision 6: golden corpus 必须独立于 renderer 自举样例

新增参考图 corpus 覆盖文字混排、表格、流程图、图表、透明/渐变/阴影、多页模板和低清晰输入。renderer 自己生成的样例只能验证一致性，不能证明真实图片还原能力。

Rationale:

- 防止只在自生成样例上通过。
- 为后续还原度优化提供稳定回归基线。
- corpus 失败能直接映射到能力声明，不会被总体测试通过掩盖。

Alternatives considered:

- 只用单元测试验证 schema 和 renderer：开发速度快，但无法代表真实图片输入。
- 用少量手工截图临时验证：可补充调试，但不适合作为长期质量门。

## Data Flow

1. CLI 规范化源图并生成 Source Package canonical facts。
2. CLI 分析源图并写入派生物引用：OCR、边缘、mask、颜色采样、轮廓、结构候选和局部 crops。
3. 作者或自动辅助流程生成 Reconstruction Spec 和 Evidence Graph，声明节点、证据、可调参数和结构候选。
4. Core 校验契约并编译 Resolved Scene；任何可见字段无消费者即失败。
5. Backend Planner 根据 Target Profile 生成 Backend Plan，包含 lowering、文字拟合和 patch provenance。
6. Renderer 只消费 Backend Plan 和资源，输出 PPTX。
7. CLI 独立验证 preview、对象清单、editability、source coverage、package safety 和组件级指标。
8. 若失败，Fidelity Optimizer 基于验证诊断生成 bounded patches，重新进入第 4 步，直到成功、回归、超限或无有效候选。
9. Publisher 只在最终 Verification Result 通过所有门槛时发布 Delivery Manifest。

## Implementation Shape

- packages/core
  - 扩展 V2 schema：analysis derivatives refs、fit constraints、style tokens、structure candidates、optimizer patch input、component diagnostics references。
  - 扩展 validate-v2-contracts：不可变源事实、patch 目标路径、可调参数范围、style token 冲突、evidence quality 诊断。
  - 扩展 compile-resolved-scene：消费 optimizer patch overlay，输出 patch provenance 和最终 resolved values。

- packages/cli
  - 新增派生物生成与缓存编排：OCR/token、edge/mask、connected components、color sampler、grid/vector candidates、localized crops。
  - 新增 fidelity-optimizer 编排：候选生成、排序、应用、回退、迭代上限、组件回归检测。
  - 扩展 verifier：组件级 diff、文字 metrics、结构匹配、anti-cheat 检测、optimization history。
  - 新增 golden corpus runner，与常规 unit/smoke 分开输出。

- packages/renderer-pptx
  - 扩展 Backend Planner lowering：多 primitive 边框/圆角、渐变近似、阴影/发光 postprocess、mask/clip/path/connector/table/chart primitive。
  - 扩展 Renderer plan 执行：应用 plan 内文本参数和 OOXML postprocess，不读取源图或作者契约。
  - 扩展 PPTX inspection：确认 postprocess、对象映射、外部关系和 editability 仍符合 Manifest。

- skill-src
  - 更新作者说明：要求为关键文字和结构提供可调约束与 evidence，不把 optimizer 输出当作者成功状态。
  - 更新准确性规则：明确 golden corpus、组件诊断和 anti-cheat 规则。

## Risks / Trade-offs

- [Risk] 优化循环可能变慢 → Mitigation: 使用组件级局部 crops、缓存派生物、限制最大轮次和最大候选数。
- [Risk] OCR/字体候选不稳定 → Mitigation: 记录生成器版本、置信度和冲突诊断；低置信度不得静默成为成功依据。
- [Risk] primitive lowering 造成对象数量膨胀 → Mitigation: Target Profile 继续声明对象/路径限制，Backend Plan 超限即 rejected。
- [Risk] 组件指标过多导致验收复杂 → Mitigation: Verification Result 保留统一 gate summary，并把明细挂在可追踪组件节点上。
- [Risk] golden corpus 建设成本高 → Mitigation: 先覆盖最影响还原度的文字、表格、渐变/阴影和多页样例，再逐步扩展。
- [Risk] OOXML postprocess 破坏 PowerPoint 兼容性 → Mitigation: 每个 postprocess 结果必须经过 package safety、save/reopen 和 object manifest 验证。

## Migration Plan

1. 先落 schema 和契约校验，保证 V2 数据模型能表达 optimizer、派生物和组件诊断。
2. 增加最小可用派生物与文字 fitting 链路，用 golden text corpus 建立首个闭环。
3. 扩展 verifier 输出组件级诊断和 optimization history。
4. 接入 Optimizer 的 bounded patch loop，默认关闭高风险 patch 类型，只启用文字/颜色/几何微调。
5. 分批增加结构恢复和复杂视觉 lowering，并用 golden corpus 逐项打开 gate。
6. 更新 skill 模板、准确性规则和审计脚本。

Rollback 策略：所有 optimizer patch 都是独立 runtime input；如任一阶段不稳定，可以关闭 optimizer loop，保留 V2 基础转换和独立验证，不需要回滚作者契约文件。
