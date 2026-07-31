import fs from "node:fs/promises";
import { artifactIdFor, collectArtifactRefs, rewriteArtifactRefs, sha256BytesDigest } from "./canonical.mjs";

async function descriptor(filePath, mediaType, storageKey) {
  const bytes = await fs.readFile(filePath);
  return {
    blobDigest: sha256BytesDigest(bytes),
    mediaType,
    byteLength: bytes.length,
    storageKey,
  };
}

export function topologicalOrder(artifacts) {
  const byId = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
  const state = new Map();
  const ordered = [];
  function visit(artifact) {
    if (state.get(artifact.artifactId) === "done") return;
    if (state.get(artifact.artifactId) === "active") throw new Error(`Artifact 依赖存在环: ${artifact.artifactId}`);
    state.set(artifact.artifactId, "active");
    for (const input of artifact.inputs) {
      const dependency = byId.get(input);
      if (!dependency) throw new Error(`Artifact 缺少依赖: ${artifact.artifactId} -> ${input}`);
      visit(dependency);
    }
    state.set(artifact.artifactId, "done");
    ordered.push(artifact);
  }
  for (const artifact of artifacts) visit(artifact);
  return ordered;
}

function rewriteDigests(value, digestMap) {
  if (typeof value === "string") return digestMap.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => rewriteDigests(item, digestMap));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteDigests(item, digestMap)]));
  return value;
}

export function rebuildArtifactGraph(bundle, schema, digestMap = new Map()) {
  const nextBundle = structuredClone(bundle);
  for (const artifact of nextBundle.artifacts) artifact.body = rewriteDigests(artifact.body, digestMap);
  const oldToNew = new Map();
  const artifacts = [];
  for (const original of topologicalOrder(nextBundle.artifacts)) {
    const draft = rewriteArtifactRefs({ ...original, body: original.body }, schema, oldToNew);
    delete draft.artifactId;
    draft.inputs = collectArtifactRefs(draft, schema);
    const rebuilt = { artifactId: artifactIdFor(draft), ...draft };
    oldToNew.set(original.artifactId, rebuilt.artifactId);
    artifacts.push(rebuilt);
  }
  return {
    ...nextBundle,
    rootArtifactId: oldToNew.get(nextBundle.rootArtifactId) ?? nextBundle.rootArtifactId,
    artifacts,
  };
}

export async function bindSourceInput(bundle, sourcePath, mediaType, schema) {
  const bytes = await fs.readFile(sourcePath);
  const digest = sha256BytesDigest(bytes);
  const nextBundle = structuredClone(bundle);
  const sources = nextBundle.artifacts.filter((artifact) => artifact.artifactType === "resource" && artifact.body.resourceKind === "source-input");
  if (sources.length !== 1) throw new Error("当前执行器要求任务束恰好包含一个 source-input Resource");
  const source = sources[0];
  const previousDigest = source.body.descriptor.blobDigest;
  source.body.descriptor = {
    blobDigest: digest,
    mediaType,
    byteLength: bytes.length,
    storageKey: `inputs/${sourcePath.split("/").at(-1)}`,
  };
  return rebuildArtifactGraph(nextBundle, schema, new Map([[previousDigest, digest]]));
}

export function applyVerificationEvidence(bundle, verificationReport, sourceCoverageReport, schema) {
  if (verificationReport.status !== "passed" || sourceCoverageReport.status !== "passed") {
    throw new Error("只有通过真实验证和源覆盖探针的候选才能写入成功终态");
  }
  const nextBundle = structuredClone(bundle);
  nextBundle.bundlePhase = "final";
  const ownership = nextBundle.artifacts.find((artifact) => artifact.artifactType === "ownership-plane");
  if (ownership) {
    ownership.body.coverage.sourcePixelCoverage = sourceCoverageReport.sourcePixelCoverage;
    ownership.body.coverage.sourceEdgeCoverage = sourceCoverageReport.sourceEdgeCoverage;
  }
  const evidence = nextBundle.artifacts.find((artifact) => artifact.artifactType === "evidence-report");
  for (const claim of evidence?.body.claims ?? []) {
    if (claim.metric === "weighted-visual-similarity") claim.value = verificationReport.visual.weightedScore;
    if (claim.metric === "editable-object-coverage") {
      const results = verificationReport.editability.results;
      claim.value = results.length ? results.filter((item) => item.passed).length / results.length : 0;
    }
    if (claim.metric === "source-pixel-coverage") claim.value = sourceCoverageReport.sourcePixelCoverage;
    if (claim.metric === "source-edge-coverage") claim.value = sourceCoverageReport.sourceEdgeCoverage;
  }
  for (const proof of nextBundle.artifacts.filter((artifact) => artifact.artifactType === "semantic-equivalence-proof")) proof.body.status = "proved";
  const verification = nextBundle.artifacts.find((artifact) => artifact.artifactType === "verification-plane");
  if (verification) verification.body.verificationStatus = "verified";
  const selection = nextBundle.artifacts.find((artifact) => artifact.artifactType === "selection-decision");
  if (selection) selection.body.status = "selected";
  const terminal = nextBundle.artifacts.find((artifact) => artifact.artifactType === "task-terminal-decision");
  if (terminal) {
    terminal.body.status = "success";
    terminal.body.reasonCodes = [];
  }
  return rebuildArtifactGraph(nextBundle, schema);
}

export async function materializeTaskOutput(bundle, files, schema) {
  const nextBundle = structuredClone(bundle);
  const candidate = nextBundle.artifacts.find((artifact) => artifact.artifactType === "trial-candidate");
  if (!candidate) throw new Error("任务束缺少 trial-candidate Artifact");
  const originalDescriptors = {
    pptx: candidate.body.pptxBlob.blobDigest,
    preview: candidate.body.previewBlob.blobDigest,
    manifest: candidate.body.objectManifestBlob.blobDigest,
    layout: candidate.body.layoutBlob.blobDigest,
    diff: candidate.body.diffBlob.blobDigest,
    coverage: candidate.body.sourceCoverageReportBlob.blobDigest,
    coverageOverlay: candidate.body.sourceCoverageOverlayBlob.blobDigest,
    verification: candidate.body.verificationReportBlob.blobDigest,
    buildLog: candidate.body.buildLogBlob.blobDigest,
    environment: candidate.body.environmentSnapshotBlob.blobDigest,
  };
  candidate.body.pptxBlob = await descriptor(files.pptxPath, "application/vnd.openxmlformats-officedocument.presentationml.presentation", files.pptxStorageKey ?? "outputs/candidate.pptx");
  if (files.previewPath) candidate.body.previewBlob = await descriptor(files.previewPath, "image/png", files.previewStorageKey ?? "outputs/candidate-preview.png");
  if (files.manifestPath) candidate.body.objectManifestBlob = await descriptor(files.manifestPath, "application/json", files.manifestStorageKey ?? "outputs/object-manifest.json");
  if (files.layoutPath) candidate.body.layoutBlob = await descriptor(files.layoutPath, "application/json", files.layoutStorageKey ?? "outputs/layout.json");
  if (files.diffPath) candidate.body.diffBlob = await descriptor(files.diffPath, "image/png", files.diffStorageKey ?? "outputs/diff.png");
  if (files.coveragePath) candidate.body.sourceCoverageReportBlob = await descriptor(files.coveragePath, "application/json", files.coverageStorageKey ?? "outputs/source-coverage.json");
  if (files.coverageOverlayPath) candidate.body.sourceCoverageOverlayBlob = await descriptor(files.coverageOverlayPath, "image/png", files.coverageOverlayStorageKey ?? "outputs/source-coverage-overlay.png");
  if (files.verificationPath) candidate.body.verificationReportBlob = await descriptor(files.verificationPath, "application/json", files.verificationStorageKey ?? "outputs/verification.json");
  if (files.buildLogPath) candidate.body.buildLogBlob = await descriptor(files.buildLogPath, "application/json", files.buildLogStorageKey ?? "outputs/build-log.json");
  if (files.environmentSnapshotPath) candidate.body.environmentSnapshotBlob = await descriptor(files.environmentSnapshotPath, "application/json", files.environmentSnapshotStorageKey ?? "outputs/environment-snapshot.json");

  const digestMap = new Map([
    [originalDescriptors.pptx, candidate.body.pptxBlob.blobDigest],
    [originalDescriptors.preview, candidate.body.previewBlob.blobDigest],
    [originalDescriptors.manifest, candidate.body.objectManifestBlob.blobDigest],
    [originalDescriptors.layout, candidate.body.layoutBlob.blobDigest],
    [originalDescriptors.diff, candidate.body.diffBlob.blobDigest],
    [originalDescriptors.coverage, candidate.body.sourceCoverageReportBlob.blobDigest],
    [originalDescriptors.coverageOverlay, candidate.body.sourceCoverageOverlayBlob.blobDigest],
    [originalDescriptors.verification, candidate.body.verificationReportBlob.blobDigest],
    [originalDescriptors.buildLog, candidate.body.buildLogBlob.blobDigest],
    [originalDescriptors.environment, candidate.body.environmentSnapshotBlob.blobDigest],
  ]);
  return rebuildArtifactGraph(nextBundle, schema, digestMap);
}
