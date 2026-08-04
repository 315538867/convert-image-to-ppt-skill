## 1. OpenSpec Baseline

- [x] 1.1 Review proposal, design, and specs with the user and resolve Open Questions.
- [x] 1.2 Add an architecture index in docs that points to this OpenSpec change and marks V1 docs as historical context.
- [x] 1.3 Add validation guidance to README or contributor docs for running `openspec validate redesign-image-to-ppt-v2-architecture --strict`.

## 2. V2 Schema Foundation

- [x] 2.1 Add V2 schema files for Source Package, Reconstruction Spec, Evidence Graph, Resolved Scene, Backend Plan, Verification Result, Delivery Manifest, and shared Blob references.
- [x] 2.2 Add Core validators for V2 schema loading, cross-contract references, digest formats, page ids, unit handling, and content-addressed blob references.
- [x] 2.3 Add validation failures for runtime-generated state appearing in Reconstruction Spec or Evidence Graph.
- [x] 2.4 Add fixture examples for a minimal single-page V2 conversion and a multi-page V2 conversion.
- [x] 2.5 Add unit tests for required fields, rejected extra fields, invalid references, invalid blob digests, and author-written success state.

## 3. Source Package

- [x] 3.1 Implement Source Normalizer in CLI to read raw source bytes, compute raw digest, apply EXIF orientation once, normalize color space, and record canonical canvas.
- [x] 3.2 Generate canonical pixel digest and alpha facts, including non-opaque pixel counts.
- [x] 3.3 Add content-addressed references for previews, tiles, local crops, masks, and original source bytes.
- [x] 3.4 Refactor source coverage and visual diff to consume Source Package facts instead of independently decoding source metadata.
- [x] 3.5 Add tests for EXIF orientation, alpha flattening, color-space recording, digest mismatch, and canonical canvas mismatch.

## 4. Author Contracts

- [x] 4.1 Implement Reconstruction Spec node definitions for group, shape, text, path, image, icon, connector, table, list, chart, and custom-semantic.
- [x] 4.2 Implement geometry, appearance, text, image, path, connector, table, list, and chart submodels.
- [x] 4.3 Implement Evidence Graph definitions for typed evidence claims, subjects, source regions, measurements, provenance, confidence, and evidence blobs.
- [x] 4.4 Update `skill-src` instructions so Codex authors only Reconstruction Spec and Evidence Graph, not final state.
- [x] 4.5 Add authoring fixtures that cover text metrics, gradients, masks, connectors, table cells, chart primitives, and approved image resources.

## 5. Core Compiler

- [x] 5.1 Implement Resolved Scene compiler that expands defaults, inheritance, transforms, bounds, draw order, resources, text strategy candidates, and evidence closure.
- [x] 5.2 Fail compilation when visible author fields have no compiler consumer or unsupported metadata-only declaration.
- [x] 5.3 Add scene-node provenance mapping from Reconstruction Spec nodes and Evidence Graph subjects.
- [x] 5.4 Keep `packages/core` free of PPTX backend, image decoder, and Codex runtime dependencies.
- [x] 5.5 Add unit tests for nested transforms, occlusion order, unsupported fields, resource binding, and evidence closure.

## 6. Backend Planning

- [x] 6.1 Add Target Profile definitions for PPTX backend native, OOXML postprocess, primitive-lowering, approved-raster, and unsupported capabilities.
- [x] 6.2 Implement Backend Plan generation from Resolved Scene and Target Profile.
- [x] 6.3 Encode explicit strategies, operations, expected objects, editability contracts, declared losses, and rejection reasons.
- [x] 6.4 Fail planning when an unapproved loss or rejected node is present.
- [x] 6.5 Add tests for per-side border lowering, complex path rejection, text OOXML postprocess, approved original raster, and unsupported effects.

## 7. PPTX Renderer Boundary

- [x] 7.1 Refactor Renderer entrypoint to consume Backend Plan and resources only.
- [x] 7.2 Remove Renderer reads of full Task Bundle, Reconstruction Spec, Evidence Graph, Source Package, and Capability Manifest.
- [x] 7.3 Generate Object Manifest with scene node id, plan operation id, slide id, OOXML object ids, native object kind, bbox, transform, content digest, editability, and actual OOXML features.
- [x] 7.4 Reopen candidate PPTX after saving and inspect actual generated objects before returning manifest.
- [x] 7.5 Add boundary tests proving Renderer cannot infer fallback strategy from source image or author contract.

## 8. Independent Verification

- [x] 8.1 Implement Verification Result schema and writer as a verifier-owned output.
- [x] 8.2 Verify source binding against Source Package raw digest, canonical pixel digest, canvas, orientation, and color space.
- [x] 8.3 Verify visual fidelity per page, Evidence item, Scene Node, protected region, and object category.
- [x] 8.4 Verify Resolved Scene -> Backend Plan -> Object Manifest -> actual OOXML closure.
- [x] 8.5 Verify editability by modifying representative text, shape, path, image, connector, and group objects, saving, reopening, and inspecting.
- [x] 8.6 Verify PPTX package safety for macros, OLE, active content, undeclared external relationships, ZIP/OOXML structure, and output digests.
- [x] 8.7 Remove any code path that bulk-promotes semantic proof status without verifier-specific evidence.

## 9. Transactional Publishing

- [x] 9.1 Implement immutable `runs/<run-id>/` output layout for every conversion attempt.
- [x] 9.2 Implement Delivery Manifest generation only after all required Verification Result gates pass.
- [x] 9.3 Publish by atomic pointer or directory-level switch instead of deleting and renaming individual final artifacts.
- [x] 9.4 Preserve diagnostics for failed runs while leaving the previous successful publication unchanged.
- [x] 9.5 Add crash/recovery tests for publication pointer update and mixed-artifact prevention.

## 10. V1 Removal and V2 Cutover

- [x] 10.1 Remove V1 Task Bundle schema, Artifact DAG validation, Render Plane compiler, final-state materialization, and V1 examples after V2 Core is complete.
- [x] 10.2 Remove V1 CLI bundle preparation, checkpoint, run-conversion orchestration, source-coverage fallback, and V1 output naming after the V2 CLI is complete.
- [x] 10.3 Remove V1 Renderer bundle entrypoint and any V2 dependency on Capability Manifest or Render Plane.
- [x] 10.4 Remove V1 Skill authoring instructions, references, generated examples, and V1 built-skill expectations.
- [x] 10.5 Remove V1 unit/integration tests and add boundary tests proving V2 packages cannot import V1 runtime modules.

## 11. Skill Template and CLI Integration

- [x] 11.1 Update `skill-src/SKILL.md` and references to teach the V2 authoring workflow and forbid runtime state in author outputs.
- [x] 11.2 Update CLI commands to accept V2 inputs and produce Source Package, run directory, Verification Result, Delivery Manifest, preview, diff, source overlay, and review sheet.
- [x] 11.3 Switch the public CLI and Skill to V2-only inputs and outputs with no V1 compatibility or migration mode.
- [x] 11.4 Rebuild generated Skill from `skill-src`; do not edit `dist` directly.
- [x] 11.5 Update submission or smoke materials after V2 output format stabilizes.

## 12. Verification and Audit

- [x] 12.1 Run `openspec validate redesign-image-to-ppt-v2-architecture --strict` after every spec or task update.
- [x] 12.2 Run `npm test` after Schema, compiler, renderer, CLI, or Skill template changes.
- [x] 12.3 Run `npm run audit` after Schema, compiler, renderer, CLI, or Skill template changes.
- [x] 12.4 Add independent reference-image tests, not only renderer-generated circular smoke tests.
- [x] 12.5 Add negative tests for source-coverage cheating, missing second-page verification, Renderer boundary violation, and failed publication preserving old success artifacts.
