## ADDED Requirements

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
