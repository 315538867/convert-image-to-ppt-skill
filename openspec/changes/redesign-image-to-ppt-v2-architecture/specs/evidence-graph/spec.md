## ADDED Requirements

### Requirement: Evidence Graph records claims, not conclusions
The system SHALL use Evidence Graph to record source-backed measurement claims, provenance, subjects, source regions, tolerances, confidence, and evidence blob references. It MUST NOT record passed, proved, selected, success, or final verification conclusions.

#### Scenario: Evidence is authored for title spacing
- **WHEN** an author measures spacing between a title and subtitle
- **THEN** Evidence Graph records the source region, measured distance, axis, tolerance, subjects, provenance method, and confidence without recording that the spacing has passed verification

### Requirement: Evidence Graph supports responsibility closure
The system SHALL allow verification to derive responsibility closure from Evidence subjects, Reconstruction Spec evidenceRefs, Resolved Scene source mappings, Backend Plan operations, and Object Manifest objects.

#### Scenario: Source pixel is covered by declared responsibility
- **WHEN** a salient source pixel is inside an evidence-backed node region and that node maps through scene, plan, and manifest objects
- **THEN** the verifier may count it as covered only after comparing rendered output and closure consistency

#### Scenario: Oversized evidence cannot self-prove
- **WHEN** an author creates a single oversized evidence region covering unrelated visible content
- **THEN** validation or verification fails unless the region has valid typed measurements and subjects for each covered responsibility

### Requirement: Evidence Graph covers multiple evidence kinds
The system SHALL support evidence kinds for text content, text ink, geometry, edge, color, gradient, spacing, alignment, containment, overlap, occlusion, mask, image region, reading order, and editability intent.

#### Scenario: Gradient evidence is required
- **WHEN** a source element uses a visible gradient
- **THEN** Evidence Graph records gradient stops, direction or geometry, source region, and tolerance sufficient for the verifier to evaluate it

#### Scenario: Reading order is relevant
- **WHEN** a reconstructed page contains multiple text blocks
- **THEN** Evidence Graph can record reading-order evidence that Core and verification use to preserve accessibility and edit ordering
