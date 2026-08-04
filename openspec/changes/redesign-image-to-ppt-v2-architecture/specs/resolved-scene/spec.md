## ADDED Requirements

### Requirement: Core compiles a backend-neutral Resolved Scene
The system SHALL compile Reconstruction Spec and Evidence Graph into a Resolved Scene that is independent of PowerPoint, OOXML, artifact-tool, image decoders, or Codex runtime APIs.

#### Scenario: Style inheritance is resolved
- **WHEN** a child node inherits style, opacity, transform, or editability from ancestors
- **THEN** Resolved Scene contains the fully resolved effective values and records source node mappings

### Requirement: Resolved Scene contains deterministic visual truth
The system SHALL resolve page order, draw order, world transforms, layout/content/ink/effect bounds, clip/mask/effect stacks, resource bindings, text strategy candidates, and evidence closure.

#### Scenario: Nested transform is compiled
- **WHEN** a page contains nested groups with local transforms
- **THEN** Resolved Scene records deterministic world transforms and bounds for each visible scene node

#### Scenario: Draw order affects verification
- **WHEN** nodes overlap or occlude each other
- **THEN** Resolved Scene records draw order and occlusion-relevant bounds for verification

### Requirement: Resolved Scene rejects unsupported or unconsumed visible fields
The system SHALL fail compilation when a visible author field cannot be resolved, has no consumer, or is not explicitly marked metadata-only.

#### Scenario: Appearance field has no compiler consumer
- **WHEN** Reconstruction Spec contains a visible appearance property that Core cannot compile
- **THEN** compilation fails with the property path and affected node id
