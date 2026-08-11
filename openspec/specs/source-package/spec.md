# source-package Specification

## Purpose
TBD - created by archiving change redesign-image-to-ppt-v2-architecture. Update Purpose after archive.
## Requirements
### Requirement: Source Package canonicalizes source facts
The system SHALL create a Source Package before authoring, compiling, rendering, or verifying any page. The Source Package MUST record raw blob digest, canonical pixel digest, media type, page/frame identity, canonical canvas size, orientation handling, color working space, alpha facts, and derived blob references.

#### Scenario: EXIF orientation is applied once
- **WHEN** a source image contains EXIF orientation metadata
- **THEN** Source Normalizer applies the orientation exactly once, records the original value, records that it was applied, and all downstream coordinates use the canonical canvas

#### Scenario: Source dimensions are stable
- **WHEN** CLI validates a task against a source image
- **THEN** validation compares task coordinates against the canonical Source Package canvas, not raw metadata from a later image decoder

### Requirement: Source Package owns pixel and color identity
The system SHALL use the Source Package as the only source of truth for normalized pixels, alpha, and color space. Downstream components MUST NOT independently reinterpret EXIF orientation, alpha flattening, or working color space.

#### Scenario: Coverage uses canonical pixels
- **WHEN** source coverage is calculated
- **THEN** the coverage probe reads canonical pixels or a verified canonical pixel reference from the Source Package

#### Scenario: Visual diff uses same source facts
- **WHEN** visual verification compares a rendered preview to the source
- **THEN** the verifier uses the same canonical canvas, pixel digest, and working color space recorded by Source Package

### Requirement: Source Package references large derived assets
The system SHALL store large pixels, previews, tiles, crops, masks, and frame images as content-addressed Blob resources. JSON MUST store references, digests, media type, size, and purpose rather than inline binary payloads.

#### Scenario: Large source has review crops
- **WHEN** a large source image needs localized review
- **THEN** Source Package references content-addressed crop blobs and records the source region each crop represents

#### Scenario: Blob digest mismatch blocks conversion
- **WHEN** a referenced source or derived blob digest does not match its bytes
- **THEN** conversion fails before authoring output is compiled

### Requirement: Source Package records reusable analysis derivatives
系统 SHALL 允许 Source Package 引用源图派生物，包括 OCR/token evidence、文字墨迹遮罩、边缘图、连通域、颜色采样、局部裁剪、轮廓、表格网格候选、图表 primitive 候选和矢量化候选。派生物 MUST 绑定 canonical canvas、源区域、生成器版本、参数摘要和内容摘要。

#### Scenario: Text analysis derivative is available
- **WHEN** 源图包含可见文字区域
- **THEN** Source Package 可引用 token、字符框、文本墨迹遮罩、baseline 候选和 OCR 置信度派生物

#### Scenario: Derived asset does not match source identity
- **WHEN** 派生物引用的 canonical pixel digest 或源区域与当前 Source Package 不一致
- **THEN** 系统拒绝该派生物并阻止其进入编译或优化流程

### Requirement: Source Package separates immutable facts from derived hypotheses
系统 SHALL 区分 canonical source facts 与 analysis hypotheses。派生物可以表达候选和置信度，但 MUST NOT 覆盖 raw blob digest、canonical pixel digest、canvas、orientation、alpha 或 color working space 等不可变事实。

#### Scenario: Color sampler suggests corrected palette
- **WHEN** 颜色采样派生物输出候选色板和透明度估计
- **THEN** Source Package 记录其为 derived hypothesis，并保留原始 canonical color identity 不变

#### Scenario: Analyzer attempts to rewrite canvas size
- **WHEN** 派生分析试图改变 canonical canvas size 或 orientation state
- **THEN** Source Package validation fails with immutable-source-fact violation

### Requirement: Source Package supports localized review and optimization tiles
系统 SHALL 支持按组件、失败区域和显著像素区域生成内容寻址的局部 tile/crop 引用。每个 tile/crop MUST 记录源区域、缩放策略、颜色处理、用途和父派生物关系。

#### Scenario: Verifier reports localized failure
- **WHEN** Verification Result 报告某一组件局部失败
- **THEN** Source Package 可提供对应源图 crop、边缘 crop、mask crop 和颜色样本，供 Optimizer 生成局部修正

#### Scenario: Crop lacks provenance
- **WHEN** 局部 crop 没有源区域、用途或 digest
- **THEN** 系统不得将该 crop 用于 evidence、optimization 或人工验收报告
