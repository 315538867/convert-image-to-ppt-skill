## Why

当前图片转 PPT 流程已经具备“作者任务束 -> Core 校验/编译 -> PPTX Renderer -> 视觉验收 -> 最终产物”的雏形，但现有 V1 六平面 JSON 同时承载作者意图、源图观察、渲染输入、验证证明和发布状态，导致边界不够可信：作者可写数据可以参与自证，Renderer 仍能读取任务级能力并做后端判断，多页协议与单页验收不一致，失败重跑也可能破坏上一版成功产物。

图片细节还原的上限已经不再取决于“继续给当前 JSON 加字段”，而取决于是否把源图事实、作者意图、证据、后端无关场景、后端执行计划、验证结果和发布清单拆成独立契约。为了支持高保真、可编辑、可验证的图片转 PPT，需要将 V2 作为目标架构重构，而不是以保留当前六平面为前提做局部修补。

## What Changes

- **BREAKING**：引入 V2 数据契约，拆分当前单体 Task Bundle，禁止作者填写运行生成的证明、覆盖率、验证状态和最终状态。
- **BREAKING**：Renderer 输入从完整任务束收敛为后端执行计划，不再读取 Reconstruction Spec、Evidence Graph、Capability Manifest 或源图事实来临场推断布局。
- 新增 Source Package，统一 EXIF、色彩空间、Alpha、规范化像素摘要、画布尺寸和派生预览/裁图引用。
- 新增 Reconstruction Spec，用强类型节点树表达可编辑重建意图，包括几何、外观、文字、图片、路径、连接线、表格、列表和图表。
- 新增 Evidence Graph，用待验证的测量声明连接源图区域、重建节点和责任闭包，但不保存验证结论。
- 新增 Resolved Scene，由 Core 生成后端无关的已解析视觉场景，展开继承、变换、边界、资源、文字策略和证据闭包。
- 新增 Target Profile 与 Backend Plan，由后端规划器明确选择 native、OOXML 后处理、降低为原语、批准栅格或拒绝策略。
- 新增独立 Verification Result，按源绑定、逐页视觉、逐 Evidence、逐节点、逐对象、编辑性和包安全维度生成不可由作者修改的验收结果。
- 新增 Delivery Manifest 与事务化发布机制，所有运行写入独立目录，只有完整通过验收后才原子发布，失败运行不得覆盖上一版成功结果。
- 将大图像、蒙版、像素证据、字体、预览、裁图和导出物迁移为内容寻址 Blob，JSON 只保存摘要、尺寸、用途和引用。
- **BREAKING**：V2 切换后删除 V1 Schema、六平面转换入口、authoring 模板和 V1 验收链；不提供 V1 兼容输入、自动迁移命令或双栈运行模式。

## Capabilities

### New Capabilities
- `source-package`: 规范化源图事实、内容摘要、页面/帧、色彩、方向、Alpha、派生 Blob 与坐标基准。
- `reconstruction-spec`: 表达作者可编辑重建意图、节点树、几何、外观、文字、图片、路径、连接线、表格、列表和图表语义。
- `evidence-graph`: 表达源图测量声明、证据来源、节点责任关系和待验证闭包。
- `resolved-scene`: 表达 Core 生成的后端无关、已解析、不可作者修改的视觉场景。
- `backend-plan`: 表达目标后端能力、PPTX 执行策略、对象预期、降级损失和拒绝原因。
- `verification-result`: 表达独立验证器生成的源绑定、视觉、对象、编辑性、包安全和失败分类结果。
- `delivery-manifest`: 表达事务化发布结果、最终产物集合、运行目录、摘要和成功状态。

### Modified Capabilities
- 无；当前仓库尚无既有 OpenSpec capability，本次为首次初始化并建立 V2 能力基线。

## Impact

- `packages/core`: 新增 V2 schema、契约校验、Resolved Scene 编译、闭包校验和强制不变量，并在 V2 闭环完成后删除 V1 Task Bundle 运行时；继续保持不依赖 PPTX 后端、图片处理库或 Codex 宿主运行库。
- `packages/renderer-pptx`: 输入改为 PPTX Backend Plan 与资源 Blob，输出 Object Manifest；不得从图片猜测布局，也不得读取作者契约来决定降级策略。
- `packages/cli`: 负责 Source Normalizer、运行目录、缓存、后端规划、渲染调度、独立验证、事务化发布和验收报告；不得修改源图事实来绕过验证。
- `skill-src`: Skill 模板需要改成按 V2 契约产出 Reconstruction Spec 与 Evidence Graph，并把运行结果留给工具链生成。
- `tests`: 需要覆盖 V2 schema、源图规范化、覆盖作弊、多页逐页验收、失败发布保持旧产物、Renderer 边界、独立参考图和编辑性验证；V1 测试随 V1 运行时删除。
- `docs`: 现有架构审查和 V2 方案应迁入或引用 OpenSpec，后续实现以 OpenSpec change 为入口推进。
