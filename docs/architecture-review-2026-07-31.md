# 架构审查记录（2026-07-31）

## 审查结论

当前三包依赖方向基本合理：Core 不依赖 PPTX 后端或图片库，Renderer 依赖 Core，CLI 负责转换编排与验收。主要风险集中在产物发布事务、多页验收、验证证据可信度和运行契约完整性。

这些问题尚未实施修复。本文件用于保留审查结论和后续整改依据。

## 问题清单

### P1：失败重跑会破坏上一次成功产物

严格模式在新候选通过验证前删除现有正式 PPTX 和最终任务束。候选晋升又逐文件删除、重命名；任一步失败都可能留下新旧混合或不完整的产物集合。

证据：

- `packages/cli/src/run-conversion.mjs:170` 的 `promoteCandidate` 逐文件替换正式产物。
- `packages/cli/src/run-conversion.mjs:185` 在候选创建前删除正式 PPTX 和最终任务束。

建议：在独立版本目录内生成并验证完整产物集合，通过后使用目录级切换或单一发布指针完成原子发布；失败运行不得影响上一版成功结果。

### P1：协议允许多页，但视觉验收只覆盖第一页

Schema、Core 编译器和 Renderer 都接受多个页面，CLI 的尺寸检查、源覆盖率、视觉差异以及 Renderer 输出的 preview/layout 却只处理第一页。未被视觉验证的后续页面仍可进入最终任务束。

证据：

- `packages/core/schema/task-bundle.schema.json:780` 允许 `pages` 包含多个元素，没有单页上限。
- `packages/cli/src/run-conversion.mjs:197` 只读取 `pages[0]`。
- `packages/cli/src/source-coverage.mjs:54` 只探测 `pages[0]`。
- `packages/renderer-pptx/src/render-pptx.mjs:380` 只导出第一张幻灯片的 layout 和 preview。
- 审查时复制第二页并重建 Artifact DAG，`validateTaskBundle` 返回 `ok: true`。

建议：短期在 Schema 和执行器中明确限制单页；如果目标是多页任务，则将源输入、preview、layout、diff、覆盖率和验证报告全部改为逐页集合，并要求所有页面通过后才能进入 `final`。

### P1：验证平面仍可由 authoring 数据自证

源覆盖探针根据作者填写的 Observation 框判断显著像素是否已覆盖。Core 只校验 Observation 与 Ownership 的基数和页面归属，没有执行重建契约要求的观测粒度约束。一个覆盖全画布的 `shape` 或 `color` Observation 可以覆盖所有显著像素。

此外，只要聚合验证和覆盖门槛通过，执行器会把所有 `semantic-equivalence-proof` 直接标记为 `proved`，没有根据 `proofKind`、`subjectRef` 和 `premiseRefs` 分别求证。

证据：

- `packages/cli/src/source-coverage.mjs:30` 将 Observation 框内像素直接视为已覆盖。
- `packages/cli/src/source-coverage.mjs:83` 使用 authored Observation 计算覆盖率。
- `packages/core/src/validate-task-bundle.mjs:264` 仅检查 Observation/Ownership 闭包和责任基数。
- `packages/core/src/materialize-task-output.mjs:99` 无条件将全部证明写为 `proved`。

建议：把源覆盖拆成“观测覆盖”和“渲染覆盖”，增加 Observation 类型、区域粒度、证据摘要和语义所有者的一致性约束；每种 proof 必须由对应验证器根据其前提生成，不允许统一改状态。

### P2：EXIF 方向处理使用了两套坐标事实

输入尺寸检查读取原始 metadata，源覆盖解码却调用 `rotate()` 应用 EXIF 方向。带方向标记的照片或扫描件会在两个阶段获得不同宽高和坐标系。

证据：

- `packages/cli/src/run-conversion.mjs:191` 使用未自动定向的 metadata。
- `packages/cli/src/source-coverage.mjs:55` 使用自动旋转后的像素。
- 审查用 orientation=6 的 JPEG 验证：metadata 为 `10x20`，覆盖探针解码结果为 `20x10`。

建议：在输入绑定阶段统一完成方向规范化，固定规范化像素、画布尺寸和 decoded pixel digest；后续所有分析、渲染与验证只消费该规范化事实。

### P2：分析缓存没有参与转换复用

当前转换链只在运行结束时写入分析缓存，没有在转换开始时读取、校验并恢复分析，也没有生成重建契约所述的局部复查裁图。因此“源图未变化时复用分析且不重新加载完整图片”尚未实现。

证据：

- `packages/cli/src/source-analysis-cache.mjs:37` 提供独立的缓存检查函数。
- `packages/cli/src/run-conversion.mjs:233` 只调用 `writeSourceAnalysisCache`。
- `skill-src/references/reconstruction-contract.md:41` 要求按内容摘要复用分析并生成紧凑复查裁图。

建议：在 checkpoint/转换入口增加缓存命中决策，明确可复用的数据平面和失效条件；生成由区域摘要索引的复查裁图，并对缓存命中、失效和部分复用增加测试。

### P2：Renderer 的输入边界不完全自足

`renderPptxFromBundle` 除 Render Plane 外还读取 `capability-manifest`，并据此决定 OOXML 文字和路径后处理。后端行为没有完全由 Render Plane 或显式后端配置决定，与“Renderer 只消费 Render Plane”的约束不一致。

证据：

- `packages/renderer-pptx/src/render-pptx.mjs:336` 从完整任务束读取 Render Plane 和 Capability Manifest。

建议：CLI/Core 在渲染前完成能力协商，把已确定的后端执行选项作为显式调用参数，或将必要的已解析能力写入 Render Plane；Renderer 不应重新解释任务级能力声明。

### P2：集成测试使用循环自证源图

集成测试先通过当前 Renderer 生成源图，再用同一 Renderer 和同一示例任务束重建并比较。该测试可以验证打包和执行链，但难以发现相对于独立参考图的布局、文字度量或视觉回归。

证据：

- `tests/integration/smoke.mjs:35` 使用 `renderPptxFromBundle` 生成测试源图。
- `scripts/test-built-skill.mjs:34` 使用同一方式生成构建产物测试源图。

建议：保留当前 smoke test，同时增加独立固定参考图、已审核 authoring bundle、预期对象清单和阈值报告；补充失败发布保持旧产物、多页拒绝或逐页验收、EXIF 方向和覆盖作弊的负向测试。

## 建议整改顺序

1. 修复正式产物的事务化发布，确保失败运行不破坏上一版结果。
2. 明确单页或多页产品边界，并让 Schema、CLI、Renderer 和验证产物保持一致。
3. 重构覆盖率与 proof 生成，建立不可由 authoring 状态直接晋升的验证信任边界。
4. 统一源图片方向和解码事实。
5. 落实分析缓存复用，收紧 Renderer 输入边界。
6. 用独立参考图和负向用例补齐回归测试。

## 本次验证

- `npm test`：通过。
- `npm run audit`：通过，0 个已知漏洞。
- 两页任务束诊断：Core 校验通过，确认单页执行器与多页协议不一致。
- EXIF orientation=6 诊断：确认 metadata 与覆盖探针解码宽高相反。
