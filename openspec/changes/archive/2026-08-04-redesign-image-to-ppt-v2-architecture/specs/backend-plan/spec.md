## ADDED Requirements

### Requirement: Target Profile declares backend capabilities
The system SHALL provide a runtime-owned Target Profile that declares native backend capabilities, OOXML postprocess capabilities, primitive-lowering capabilities, unsupported capabilities, object limits, path limits, and file-size limits. Authors MUST NOT edit Target Profile.

#### Scenario: PPTX backend lacks native effect
- **WHEN** Resolved Scene contains a soft-edge effect
- **THEN** Target Profile identifies whether PPTX can express it natively, by OOXML postprocess, by primitive lowering, by approved raster, or not at all

### Requirement: Backend Plan chooses explicit execution strategy
The system SHALL generate a Backend Plan that maps every Resolved Scene node to explicit operations using strategies native, ooxml-postprocess, lower-to-primitives, approved-original-raster, or rejected.

Backend Plan SHALL carry every execution fact needed by Renderer, including page canvas, parent/child operation structure, local geometry, world transform, world bounds, appearance, content, draw order, resources, and whether an expected object is virtual or must exist in OOXML. Renderer MUST NOT reconstruct any of these facts from author contracts or source pixels.

#### Scenario: Border requires primitive lowering
- **WHEN** a rectangle has per-side borders that PowerPoint cannot represent as one native shape
- **THEN** Backend Plan emits primitive line operations and records expected objects for each border side

#### Scenario: Unsupported loss is present
- **WHEN** planning would require an undeclared visual or editability loss
- **THEN** Backend Plan marks the node rejected and candidate rendering does not proceed

#### Scenario: Nested transform reaches Renderer
- **WHEN** a Resolved Scene node belongs to a nested group or has a non-identity transform
- **THEN** Backend Plan preserves the parent/child structure, local geometry, decomposable transform, and exact expected object contract so Renderer does not infer them

#### Scenario: Semantic container has no native OOXML object
- **WHEN** a semantic group is intentionally represented only by its editable child objects
- **THEN** Backend Plan marks its expected object virtual and does not claim that an OOXML object id will exist

### Requirement: Renderer consumes only Backend Plan
The system SHALL make PPTX Renderer consume Backend Plan and resolved resources only. Renderer MUST NOT read Reconstruction Spec, Evidence Graph, Source Package, Capability Manifest, or source images to infer layout, style, or fallback strategy.

#### Scenario: Renderer needs text metrics
- **WHEN** text metrics require OOXML postprocessing
- **THEN** Backend Plan includes the exact operation and parameters, and Renderer applies them without consulting author input
