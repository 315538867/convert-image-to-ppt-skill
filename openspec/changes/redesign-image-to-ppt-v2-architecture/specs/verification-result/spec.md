## ADDED Requirements

### Requirement: Verification Result is generated only by independent verification
The system SHALL generate Verification Result from verifier execution after rendering. Authors, Core compilation, Backend Planner, and Renderer MUST NOT directly mark proof, coverage, or final success.

#### Scenario: Verification fails
- **WHEN** visual, object, editability, source, or package checks fail
- **THEN** Verification Result records failed-quality-gate with failure categories and Publisher does not create a successful Delivery Manifest

### Requirement: Verification Result covers every page and responsibility chain
The system SHALL record results per page, per Evidence item, per Scene Node, per Backend Plan operation, per native object, and per protected source region.

#### Scenario: Second page is not rendered
- **WHEN** a document has two source pages but only the first page has preview and object results
- **THEN** Verification Result fails the document and identifies the missing second-page verification artifacts

#### Scenario: Object manifest has undeclared object
- **WHEN** the rendered PPTX contains an object not mapped from Backend Plan
- **THEN** Verification Result fails object verification and records the object identity

### Requirement: Verification Result proves editability through real modification
The system SHALL verify editability by opening the candidate PPTX, modifying representative objects according to their editability contract, saving, reopening, and inspecting the modified file.

#### Scenario: Text object is declared editable
- **WHEN** Backend Plan declares a text object editable
- **THEN** verification modifies text content or style, saves and reopens the file, and records whether the object remains editable

### Requirement: Verification Result checks package safety
The system SHALL verify PPTX package safety, including macro absence, OLE absence, active content absence, undeclared external relationship absence, ZIP/OOXML structure validity, and output blob digest consistency.

#### Scenario: External relationship is undeclared
- **WHEN** a candidate PPTX contains an external relationship not declared by Backend Plan or Publisher
- **THEN** Verification Result fails package-security
