# delivery-manifest Specification

## Purpose
TBD - created by archiving change redesign-image-to-ppt-v2-architecture. Update Purpose after archive.
## Requirements
### Requirement: Publisher writes immutable run directories
The system SHALL write each conversion attempt to an immutable run directory containing candidate PPTX, object manifest, previews, diffs, coverage, verification result, build log, environment snapshot, and all referenced blobs.

#### Scenario: New run starts
- **WHEN** conversion begins
- **THEN** Publisher allocates a unique run directory and no existing successful run files are deleted or overwritten

### Requirement: Delivery Manifest is the only success publication fact
The system SHALL create a Delivery Manifest only after Verification Result passes every required gate. Delivery Manifest MUST record run id, produced artifact references, blob digests, source package references, verification result reference, tool versions, and publication time.

#### Scenario: Verification passes
- **WHEN** all verification gates pass
- **THEN** Publisher writes Delivery Manifest and updates the current successful publication pointer atomically

#### Scenario: Verification fails
- **WHEN** any verification gate fails
- **THEN** Publisher preserves diagnostics for that run and leaves the previous successful publication pointer unchanged

### Requirement: Publication is atomic and recoverable
The system SHALL publish by directory-level switch, manifest pointer, or equivalent atomic mechanism. It MUST NOT publish by deleting and renaming individual final artifacts as the success boundary.

#### Scenario: Process crashes during publication
- **WHEN** the process crashes while updating the current publication pointer
- **THEN** recovery can identify either the previous successful Delivery Manifest or the new complete Delivery Manifest, never a mixed set of artifacts
