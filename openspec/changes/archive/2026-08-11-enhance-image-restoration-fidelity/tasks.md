## 1. Schema 与契约基础

- [x] 1.1 扩展 Source Package schema，支持 analysis derivatives、localized tiles/crops、生成器版本、参数摘要和 canonical digest 绑定
- [x] 1.2 扩展 Evidence Graph schema，支持文字度量、结构 primitive、高保真外观和 evidence quality diagnostics
- [x] 1.3 扩展 Reconstruction Spec schema，支持 fit constraints、locked fields、style tokens、structure candidates 和 optimizer patch overlay
- [x] 1.4 扩展 Backend Plan schema，支持 high fidelity lowering、text fitting decisions 和 optimizer patch provenance
- [x] 1.5 扩展 Verification Result schema，支持 component diagnostics、optimization history、golden corpus gates 和 anti-cheat categories
- [x] 1.6 更新 Core 契约导出与 schema fixtures，确保所有新增字段可被测试和文档引用

## 2. Core 校验与编译

- [x] 2.1 在 validate-v2-contracts 中校验 Source Package 派生物的 digest、source region、purpose 和 immutable facts
- [x] 2.2 校验 Evidence Graph 的 subjects、measurement units、confidence、tolerance、过宽区域和缺失关键 evidence
- [x] 2.3 校验 Reconstruction Spec 的 fit constraints 边界、locked fields、style token 冲突和 structure candidate 语义
- [x] 2.4 校验 optimizer patch 的目标节点、参数路径、原值匹配、类型兼容和禁止降级规则
- [x] 2.5 在 compile-resolved-scene 中应用 optimizer patch overlay，并输出 resolved values 与 patch provenance
- [x] 2.6 增加 Core 单元测试覆盖合法/非法 patch、style token、text constraints 和 structure candidate

## 3. Source 派生物与缓存

- [x] 3.1 在 CLI 新增分析派生物生成入口，复用 Source Package canonical canvas 和 blob store
- [x] 3.2 生成并缓存 OCR/token、文字 ink mask、baseline candidates 和 text crop 派生物
- [x] 3.3 生成并缓存 edge map、connected components、contours、mask/clip candidates 和 localized failure crops
- [x] 3.4 生成并缓存 color samples、gradient samples、alpha estimates 和 shadow/effect crops
- [x] 3.5 生成并缓存 table grid、chart primitive、connector/path/vectorization candidates
- [x] 3.6 为派生物缓存增加 digest mismatch、stale generator version 和 missing provenance 负面测试

## 4. 文字拟合链路

- [x] 4.1 新增 Text Metrics Resolver，将 OCR/token evidence、字体候选和作者文本映射为可拟合 text runs
- [x] 4.2 新增 Text Fitter，在允许范围内搜索 font family、fallback、字号、tracking、line-height、baseline shift 和 textbox strategy
- [x] 4.3 在 Backend Planner 中写入最终 text fitting decisions，Renderer 只执行 plan 内参数
- [x] 4.4 扩展 PPTX text metrics postprocess，覆盖 baseline、line spacing、paragraph spacing 和 text box anchors
- [x] 4.5 增加 CJK/英文/数字混排、长文本、居中/右对齐、多行文本和低清晰文字 golden tests

## 5. 结构恢复与复杂外观 lowering

- [x] 5.1 扩展 Backend Planner 对非对称圆角、多重描边、per-side border 和 dashed border 的 primitive lowering
- [x] 5.2 扩展渐变策略，支持线性/径向渐变近似、误差界限和 rejected fallback
- [x] 5.3 扩展阴影、发光、透明度、mask/clip 和 blend 的 OOXML postprocess 或 primitive lowering
- [x] 5.4 扩展路径、图标轮廓、连接线、箭头和流程图节点的 editable primitive lowering
- [x] 5.5 扩展表格网格、合并单元格、边框和单元格文本的结构化 lowering
- [x] 5.6 扩展图表 primitive lowering，保留未知数据语义并禁止伪造 chart source data
- [x] 5.7 更新 Object Manifest 映射，覆盖 virtual containers、多 primitive 输出、postprocess 对象和 editability contracts

## 6. 组件级验证

- [x] 6.1 扩展 visual verifier 输出 per-page、per-component、per-node、per-operation 和 per-object 指标
- [x] 6.2 增加文字组件验证：字符框、baseline、text ink、edge similarity、字体/字号/间距偏差
- [x] 6.3 增加形状与外观验证：颜色 delta、透明度、渐变采样、边框、圆角、阴影和 mask/clip
- [x] 6.4 增加结构验证：表格网格、连接线端点、图表 primitive、路径轮廓和对象层级
- [x] 6.5 增加 anti-cheat 检测：整页截图、文字截图、未声明 raster fallback、遮盖细节、裁剪失败区域和降低阈值
- [x] 6.6 扩展 Verification Result 报告，输出失败 crop、误差、阈值、责任链和可操作修正建议

## 7. Fidelity Optimizer

- [x] 7.1 新增 Optimizer patch 数据结构、候选排序、应用记录和停止原因
- [x] 7.2 实现文字修正候选：font fallback、字号、tracking、line-height、baseline 和 textbox bounds
- [x] 7.3 实现几何修正候选：位置、尺寸、圆角、线宽、连接点和局部 transform 微调
- [x] 7.4 实现颜色与效果修正候选：fill/stroke、opacity、gradient stops、shadow offsets 和 blur
- [x] 7.5 实现结构修正候选：表格网格 snapping、路径控制点、连接线端点和 primitive 拆分
- [x] 7.6 实现 bounded iteration loop：最大轮次、最大候选数、组件回归检测、回退和 exhausted diagnostics
- [x] 7.7 增加 Optimizer 与验证器集成测试，覆盖成功、回归、无效 patch、超限和禁止降级

## 8. Golden Corpus 与质量门

- [x] 8.1 建立 independent golden corpus 目录结构和 manifest，不与 renderer 自举样例混用
- [x] 8.2 加入文字密集、表格、流程图、图表、渐变/透明/阴影、多页模板和低清晰输入样例
- [x] 8.3 为 corpus 定义组件级阈值、全局阈值、editability gate、object manifest gate 和 package safety gate
- [x] 8.4 增加 corpus runner，并把结果写入 Verification Result 的 corpus-failure / corpus-pass 区域
- [x] 8.5 在 audit 中纳入 golden corpus 的快速子集，并保留完整 corpus 的显式命令

## 9. Skill 模板与文档

- [x] 9.1 更新 skill-src/SKILL.md，说明 V2 高保真闭环、optimizer patch 和成功发布边界
- [x] 9.2 更新 accuracy-rules，明确组件级验证、golden corpus、anti-cheat 和禁止截图代理
- [x] 9.3 更新 v2-authoring-contract，说明 fit constraints、style tokens、structure candidates 和 evidence quality
- [x] 9.4 更新 layout-rules，补充文字拟合、表格/图表/连接线和复杂外观的作者要求
- [x] 9.5 重新构建 Skill，并确认 dist/convert-image-to-ppt 只由构建脚本生成

## 10. 验证、审计与收口

- [x] 10.1 为新增 schema、Core 校验、Renderer lowering、Verifier 和 Optimizer 补齐单元测试
- [x] 10.2 增加端到端 V2 conversion fixture，覆盖失败诊断、patch 迭代和最终通过发布
- [x] 10.3 运行 npm test，修复新增或回归失败
- [x] 10.4 运行 npm run audit，确保架构边界和安全检查通过
- [x] 10.5 运行 openspec validate --strict，确保变更规格、设计和任务可归档
- [x] 10.6 检查 git diff --check，确保无空白错误和无 dist/已安装 Skill 直接修改
