# reconstruction-spec Specification

## Purpose
TBD - created by archiving change redesign-image-to-ppt-v2-architecture. Update Purpose after archive.
## Requirements
### Requirement: Reconstruction Spec contains only author-editable intent
The system SHALL use Reconstruction Spec as the author-editable contract for visual reconstruction intent. It MUST NOT contain verification status, coverage metrics, proof status, candidate output descriptors, selected state, terminal success, or publisher state.

#### Scenario: Author attempts to write success state
- **WHEN** a Reconstruction Spec includes passed, proved, selected, success, coverage, or final output fields
- **THEN** schema validation fails and reports that runtime-generated state is not allowed in author input

### Requirement: Reconstruction Spec uses typed page node trees
The system SHALL represent each page as a typed node tree with one root node. Nodes MUST use explicit type discriminators and typed fields for geometry, appearance, content, editability, evidence references, and children.

#### Scenario: Text node is authored
- **WHEN** a page contains editable text
- **THEN** the text node records Unicode content, text runs, paragraph structure, visual measurements, editability requirements, and evidence references

#### Scenario: Unknown semantic component is authored
- **WHEN** a component has useful semantic grouping but no native type
- **THEN** it may use custom-semantic only if all visible content is represented by typed child nodes

### Requirement: Reconstruction Spec supports high-fidelity geometry and appearance
The system SHALL support local frames, transforms, explicit bounds, clip references, mask references, fill stacks, stroke stacks, effect stacks, blend mode, opacity, and group isolation in Reconstruction Spec.

#### Scenario: Node has rotation and mask
- **WHEN** a source element is rotated and clipped by a mask
- **THEN** the node records the transform, clip or mask reference, layout bounds, ink bounds, and effect bounds without relying on Renderer inference

#### Scenario: Unsupported perspective is detected
- **WHEN** a node requires perspective transformation that the target backend cannot express
- **THEN** the later Backend Plan marks the node rejected or uses an explicitly approved fallback; Reconstruction Spec does not hide the requirement

### Requirement: Reconstruction Spec preserves editable semantics without fabricating data
The system SHALL preserve tables, lists, charts, connectors, icons, images, and paths as typed editable structures when evidence supports them. The system MUST NOT fabricate chart source data or replace text/simple icons with screenshots as a success path.

#### Scenario: Chart data cannot be recovered
- **WHEN** a chart's visible geometry can be reconstructed but its underlying data cannot be proven from source evidence
- **THEN** the chart is represented as editable graphic primitives with declared unknown data semantics
