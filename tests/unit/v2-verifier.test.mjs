import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { unzipSync, zipSync } from "fflate";
import { validateV2Contracts } from "@image-to-ppt/core";
import { FileBlob, PresentationFile, renderPptxFromBackendPlan } from "@image-to-ppt/renderer-pptx";
import { compareVisuals, normalizeSource, verifyV2Candidate } from "@image-to-ppt/cli";

const singleFixtureUrl = new URL("../../packages/core/examples/v2/minimal-single-page.json", import.meta.url);
const multiFixtureUrl = new URL("../../packages/core/examples/v2/minimal-multi-page.json", import.meta.url);

const zeroThresholds = {
  global: { pixel: 0, edge: 0 },
  text: { pixel: 0, edge: 0 },
  generic: { pixel: 0, edge: 0 },
  shape: { pixel: 0, edge: 0 },
  image: { pixel: 0, edge: 0 },
  connector: { pixel: 0, edge: 0 },
  border: { pixel: 0, edge: 0 },
  color: { pixel: 0, edge: 0 },
  spacing: { pixel: 0, edge: 0 },
  "simple-icon": { pixel: 0, edge: 0 }
};

function contractsFrom(fileUrl) {
  const bundle = JSON.parse(fs.readFileSync(fileUrl, "utf8"));
  return Object.fromEntries(bundle.contracts.map((contract) => [contract.contractKind, structuredClone(contract)]));
}

async function writeBlankPng(filePath, width, height) {
  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  }).png().toFile(filePath);
}

async function exportPreviews(pptxPath, pageIds, outputDir, { omit = [] } = {}) {
  const presentation = await PresentationFile.importPptx(await FileBlob.load(pptxPath));
  const renderedPagePaths = {};
  for (const [index, pageId] of pageIds.entries()) {
    if (omit.includes(pageId)) continue;
    const blob = await presentation.export({ slide: presentation.slides.items[index], format: "png", scale: 1 });
    const previewPath = path.join(outputDir, pageId + ".preview.png");
    await fsp.writeFile(previewPath, new Uint8Array(await blob.arrayBuffer()));
    renderedPagePaths[pageId] = previewPath;
  }
  return renderedPagePaths;
}

async function buildCandidate({ fixtureUrl = singleFixtureUrl, width = 160, height = 90, mutateSourcePackage, omitPreviews = [] } = {}) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "img2ppt-v2-verifier-"));
  const sourcePath = path.join(directory, "source.png");
  await writeBlankPng(sourcePath, width, height);
  const normalized = await normalizeSource({
    sourcePath,
    sourcePackagePath: path.join(directory, "source-package.json"),
    blobDir: path.join(directory, "blobs")
  });
  const contracts = contractsFrom(fixtureUrl);
  const sourcePackage = mutateSourcePackage ? mutateSourcePackage(normalized.sourcePackage, contracts["source-package"]) : normalized.sourcePackage;
  const pptxPath = path.join(directory, "candidate.pptx");
  const rendered = await renderPptxFromBackendPlan(contracts["backend-plan"], new Map(), pptxPath);
  const pageIds = sourcePackage.pages.map((page) => page.pageId);
  const renderedPagePaths = await exportPreviews(pptxPath, pageIds, directory, { omit: omitPreviews });
  return {
    directory,
    sourcePath,
    sourcePackage,
    contracts,
    pptxPath,
    objectManifest: rendered.objectManifest,
    renderedPagePaths,
    rawBlobPaths: { [sourcePackage.rawBlob.digest]: normalized.rawBlobPath },
    canonicalPixelPaths: { [sourcePackage.canonicalPixels.digest]: normalized.canonicalPixelsPath }
  };
}

test("V2 verifier 生成通过状态 Verification Result 并写入报告", async () => {
  const candidate = await buildCandidate();
  try {
    const reportPath = path.join(candidate.directory, "verification-result.json");
    const verification = await verifyV2Candidate({
      sourcePackages: [candidate.sourcePackage],
      reconstructionSpec: candidate.contracts["reconstruction-spec"],
      evidenceGraph: candidate.contracts["evidence-graph"],
      resolvedScene: candidate.contracts["resolved-scene"],
      backendPlan: candidate.contracts["backend-plan"],
      objectManifest: candidate.objectManifest,
      pptxPath: candidate.pptxPath,
      rawBlobPaths: candidate.rawBlobPaths,
      canonicalPixelPaths: candidate.canonicalPixelPaths,
      renderedPagePaths: candidate.renderedPagePaths,
      visualThresholds: zeroThresholds,
      allowLoweredThresholds: true,
      reportPath
    });

    assert.equal(verification.status, "passed");
    assert.equal(verification.contractKind, "verification-result");
    assert.equal(verification.objectManifestRef, candidate.objectManifest.manifestId);
    assert.equal(verification.sourceResults[0].status, "passed");
    assert.equal(verification.pageResults[0].status, "passed");
    const titleComponent = verification.componentResults.find((item) => item.componentRef === "component-scene-node-title");
    assert.equal(verification.componentResults.some((item) => item.componentRef === "component-page-page-1" && item.componentType === "page"), true);
    assert.equal(titleComponent.status, "passed");
    assert.equal(titleComponent.metrics.some((metric) => metric.name === "pixel-similarity" && metric.threshold === 0), true);
    assert.equal(titleComponent.metrics.some((metric) => metric.name === "character-box-width-error" && metric.value === 0 && metric.threshold === 0), true);
    assert.equal(titleComponent.metrics.some((metric) => metric.name === "baseline-shift-error" && metric.value === 0 && metric.threshold === 0.5), true);
    assert.equal(titleComponent.metrics.some((metric) => metric.name === "text-ink-edge-similarity" && metric.threshold === 0), true);
    assert.equal(titleComponent.metrics.some((metric) => metric.name === "font-size-error" && metric.value === 0), true);
    assert.equal(titleComponent.metrics.some((metric) => metric.name === "tracking-error" && metric.value === 0), true);
    assert.equal(titleComponent.metrics.some((metric) => metric.name === "line-height-error" && metric.value === 0), true);
    assert.equal(titleComponent.metrics.some((metric) => metric.name === "expected-object-count-error" && metric.value === 0), true);
    assert.equal(titleComponent.metrics.some((metric) => metric.name === "object-hierarchy-error" && metric.value === 0), true);
    assert.equal(titleComponent.metrics.some((metric) => metric.name === "primary-object-missing" && metric.value === 0), true);
    assert.deepEqual(titleComponent.responsibility.sceneNodeRefs, ["scene-node-title"]);
    assert.equal(titleComponent.responsibility.operationRefs.includes("operation-scene-node-title"), true);
    assert.equal(titleComponent.responsibility.objectRefs.includes("object-scene-node-title-primary"), true);
    assert.equal(verification.objectResults.some((item) => item.status === "passed"), true);
    assert.equal(verification.editabilityResults.some((item) => item.status === "passed"), true);
    assert.equal(verification.packageSecurity.status, "passed");
    assert.equal(verification.antiCheatResults.every((item) => item.status === "passed"), true);
    assert.equal(validateV2Contracts({ schemaVersion: 2, contracts: [candidate.sourcePackage, candidate.contracts["reconstruction-spec"], candidate.contracts["evidence-graph"], candidate.contracts["resolved-scene"], candidate.contracts["backend-plan"], candidate.objectManifest, verification] }).ok, true);
    assert.deepEqual(JSON.parse(await fsp.readFile(reportPath, "utf8")), verification);
  } finally {
    await fsp.rm(candidate.directory, { recursive: true, force: true });
  }
});

test("visual diff 为局部颜色比较输出 Delta E", async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "img2ppt-visual-delta-e-"));
  try {
    const sourcePath = path.join(directory, "source.png");
    const renderedPath = path.join(directory, "rendered.png");
    await sharp({ create: { width: 8, height: 8, channels: 4, background: "#ffffff" } }).png().toFile(sourcePath);
    await sharp({ create: { width: 8, height: 8, channels: 4, background: "#ff0000" } }).png().toFile(renderedPath);
    const visual = await compareVisuals({
      sourcePath,
      renderedPath,
      regions: [{ regionId: "color-region", category: "color", bbox: { x: 0, y: 0, width: 8, height: 8 } }],
      thresholds: { global: { pixel: 0, edge: 0 }, color: { pixel: 0, edge: 0 } },
    });
    assert.equal(visual.global.meanColorDeltaE > 0, true);
    assert.equal(visual.regions[0].meanColorDeltaE > 0, true);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("V2 verifier 缺少第二页预览时失败并指出 page-2", async () => {
  const candidate = await buildCandidate({
    fixtureUrl: multiFixtureUrl,
    width: 160,
    height: 180,
    omitPreviews: ["page-2"],
    mutateSourcePackage(sourcePackage, fixtureSourcePackage) {
      return { ...sourcePackage, pages: fixtureSourcePackage.pages };
    }
  });
  try {
    const verification = await verifyV2Candidate({
      sourcePackages: [candidate.sourcePackage],
      reconstructionSpec: candidate.contracts["reconstruction-spec"],
      evidenceGraph: candidate.contracts["evidence-graph"],
      resolvedScene: candidate.contracts["resolved-scene"],
      backendPlan: candidate.contracts["backend-plan"],
      objectManifest: candidate.objectManifest,
      pptxPath: candidate.pptxPath,
      rawBlobPaths: candidate.rawBlobPaths,
      canonicalPixelPaths: candidate.canonicalPixelPaths,
      renderedPagePaths: candidate.renderedPagePaths,
      visualThresholds: zeroThresholds,
      allowLoweredThresholds: true
    });

    assert.equal(verification.status, "failed-quality-gate");
    assert.equal(verification.pageResults.some((item) => item.subjectRef === "page-2" && item.status === "failed"), true);
    assert.equal(verification.failures.some((item) => item.code === "rendered-page-missing" && item.subjectRef === "page-2"), true);
  } finally {
    await fsp.rm(candidate.directory, { recursive: true, force: true });
  }
});

test("V2 verifier 检出 PPTX 外部关系和输出摘要不匹配", async () => {
  const candidate = await buildCandidate();
  try {
    const archive = unzipSync(new Uint8Array(await fsp.readFile(candidate.pptxPath)));
    archive["ppt/slides/_rels/slide1.xml.rels"] = new TextEncoder().encode([
      "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
      "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
      "  <Relationship Id=\"rIdExternal\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink\" Target=\"https://example.com\" TargetMode=\"External\"/>",
      "</Relationships>"
    ].join("\n"));
    await fsp.writeFile(candidate.pptxPath, zipSync(archive, { level: 6 }));

    const verification = await verifyV2Candidate({
      sourcePackages: [candidate.sourcePackage],
      reconstructionSpec: candidate.contracts["reconstruction-spec"],
      evidenceGraph: candidate.contracts["evidence-graph"],
      resolvedScene: candidate.contracts["resolved-scene"],
      backendPlan: candidate.contracts["backend-plan"],
      objectManifest: candidate.objectManifest,
      pptxPath: candidate.pptxPath,
      rawBlobPaths: candidate.rawBlobPaths,
      canonicalPixelPaths: candidate.canonicalPixelPaths,
      renderedPagePaths: candidate.renderedPagePaths,
      visualThresholds: zeroThresholds,
      allowLoweredThresholds: true
    });

    assert.equal(verification.status, "failed-quality-gate");
    assert.equal(verification.packageSecurity.status, "failed");
    assert.equal(verification.failures.some((item) => item.code === "external-relationship-present"), true);
    assert.equal(verification.failures.some((item) => item.code === "output-digest-mismatch"), true);
  } finally {
    await fsp.rm(candidate.directory, { recursive: true, force: true });
  }
});

test("V2 verifier 拒绝未明确允许的视觉阈值放宽", async () => {
  const candidate = await buildCandidate();
  try {
    const verification = await verifyV2Candidate({
      sourcePackages: [candidate.sourcePackage],
      reconstructionSpec: candidate.contracts["reconstruction-spec"],
      evidenceGraph: candidate.contracts["evidence-graph"],
      resolvedScene: candidate.contracts["resolved-scene"],
      backendPlan: candidate.contracts["backend-plan"],
      objectManifest: candidate.objectManifest,
      pptxPath: candidate.pptxPath,
      rawBlobPaths: candidate.rawBlobPaths,
      canonicalPixelPaths: candidate.canonicalPixelPaths,
      renderedPagePaths: candidate.renderedPagePaths,
      visualThresholds: zeroThresholds,
    });
    assert.equal(verification.status, "failed-quality-gate");
    assert.equal(verification.antiCheatResults.some((item) => item.check === "threshold-lowered" && item.status === "failed"), true);
  } finally {
    await fsp.rm(candidate.directory, { recursive: true, force: true });
  }
});

test("V2 verifier 将尺寸不一致的预览标为裁剪失败区域", async () => {
  const candidate = await buildCandidate();
  try {
    await writeBlankPng(candidate.renderedPagePaths["page-1"], 80, 45);
    const verification = await verifyV2Candidate({
      sourcePackages: [candidate.sourcePackage],
      reconstructionSpec: candidate.contracts["reconstruction-spec"],
      evidenceGraph: candidate.contracts["evidence-graph"],
      resolvedScene: candidate.contracts["resolved-scene"],
      backendPlan: candidate.contracts["backend-plan"],
      objectManifest: candidate.objectManifest,
      pptxPath: candidate.pptxPath,
      rawBlobPaths: candidate.rawBlobPaths,
      canonicalPixelPaths: candidate.canonicalPixelPaths,
      renderedPagePaths: candidate.renderedPagePaths,
      visualThresholds: zeroThresholds,
      allowLoweredThresholds: true,
    });
    assert.equal(verification.antiCheatResults.some((item) => item.check === "cropped-failure-region" && item.status === "failed"), true);
  } finally {
    await fsp.rm(candidate.directory, { recursive: true, force: true });
  }
});
