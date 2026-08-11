import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { applyOptimizerCandidates, runBoundedOptimization, runV2Conversion } from "@image-to-ppt/cli";

const fixtureUrl = new URL("../../packages/core/examples/v2/minimal-single-page.json", import.meta.url);

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
  "simple-icon": { pixel: 0, edge: 0 },
};

async function writeBlankSource(filePath) {
  await sharp({
    create: {
      width: 160,
      height: 90,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  }).png().toFile(filePath);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function solidColorRectContracts() {
  const fixture = JSON.parse(fs.readFileSync(fixtureUrl, "utf8"));
  const reconstructionSpec = clone(fixture.contracts.find((contract) => contract.contractKind === "reconstruction-spec"));
  const evidenceGraph = clone(fixture.contracts.find((contract) => contract.contractKind === "evidence-graph"));
  const rectBox = { x: 20, y: 20, width: 60, height: 30, unit: "px", coordinateSpace: "source-canvas" };
  const rectNode = {
    id: "blue-rect",
    type: "shape",
    geometry: {
      frame: rectBox,
      transform: { kind: "affine-2d", matrix: [1, 0, 0, 1, 0, 0] },
      bounds: { layout: rectBox, content: rectBox, ink: rectBox, effect: rectBox },
      clipStack: [],
      maskStack: [],
    },
    appearance: {
      opacity: 1,
      fills: [{ kind: "solid", color: { space: "srgb", components: [47 / 255, 128 / 255, 237 / 255], alpha: 1 } }],
      strokes: [],
      effects: [],
      blendMode: "normal",
      isolation: false,
    },
    content: { kind: "shape", shapeKind: "rectangle" },
    editability: { required: true, requiredAspects: ["geometry", "appearance"], allowedFallbacks: ["native"] },
    evidenceRefs: ["ev-blue-rect-color"],
    children: [],
  };
  reconstructionSpec.documentId = "document-independent-reference";
  reconstructionSpec.pages[0].rootNode.children = [rectNode];
  evidenceGraph.graphId = "evidence-independent-reference";
  evidenceGraph.documentRef = reconstructionSpec.documentId;
  evidenceGraph.evidence = [{
    id: "ev-blue-rect-color",
    kind: "color",
    subjects: [{ nodeRef: "blue-rect", role: "primary" }],
    sourceRegions: [{ pageId: "page-1", box: rectBox, purpose: "protected-region" }],
    measurement: {
      kind: "color",
      samples: [{
        point: { x: 50, y: 35, unit: "px", coordinateSpace: "source-canvas" },
        color: { space: "srgb", components: [47 / 255, 128 / 255, 237 / 255], alpha: 1 },
      }],
      aggregation: "exact-samples",
    },
    tolerances: [{ mode: "color-delta", value: 1, formula: "delta-e-76" }],
    provenance: { method: "image-analysis", producer: { name: "sharp-svg-reference" }, evidenceBlobRefs: [] },
    confidence: { score: 1, basis: "direct-pixel-measurement" },
  }];
  return { schemaVersion: 2, contracts: [reconstructionSpec, evidenceGraph] };
}

async function writeIndependentReferenceSource(filePath) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90" viewBox="0 0 160 90">
    <rect x="0" y="0" width="160" height="90" fill="#ffffff"/>
    <rect x="20" y="20" width="60" height="30" fill="#2f80ed"/>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(filePath);
}

test("V2 runner 生成运行目录、Verification Result、Delivery Manifest 和 current 指针", async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "img2ppt-v2-runner-"));
  try {
    const sourcePath = path.join(directory, "source.png");
    await writeBlankSource(sourcePath);

    const workspaceDir = path.join(directory, "workspace");
    const conversion = await runV2Conversion({
      sourcePath,
      contractsPath: fileURLToPath(fixtureUrl),
      workspaceDir,
      runId: "run-v2-smoke",
      visualThresholds: zeroThresholds,
      allowLoweredThresholds: true,
    });

    assert.equal(conversion.status, "passed");
    assert.equal(conversion.current, "runs/run-v2-smoke/delivery-manifest.json");
    assert.equal(fs.existsSync(path.join(workspaceDir, "current")), true);
    assert.equal(fs.existsSync(conversion.pptxPath), true);
    assert.equal(fs.existsSync(conversion.verificationResultPath), true);
    assert.equal(fs.existsSync(conversion.deliveryManifest), true);
    assert.equal(fs.existsSync(conversion.sourceOverlayPath), true);
    assert.equal(fs.existsSync(conversion.reviewSheetPath), true);
    const sourcePackage = JSON.parse(await fsp.readFile(conversion.sourcePackagePath, "utf8"));
    assert.equal(sourcePackage.analysisDerivatives.some((derivative) => derivative.kind === "edge-map"), true);
    assert.equal(sourcePackage.analysisDerivatives.some((derivative) => derivative.kind === "ocr-tokens"), true);
    assert.equal(sourcePackage.localizedAssets.some((asset) => asset.purpose === "review-crop"), true);
    const manifest = JSON.parse(await fsp.readFile(conversion.deliveryManifest, "utf8"));
    assert.equal(manifest.status, "published");
    assert.equal(manifest.outputs.some((output) => output.role === "pptx-output"), true);
    assert.equal(manifest.outputs.some((output) => output.role === "verification-result"), true);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("V2 runner 通过非渲染器生成的独立参考图验收", async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "img2ppt-v2-independent-"));
  try {
    const sourcePath = path.join(directory, "source.png");
    await writeIndependentReferenceSource(sourcePath);
    const contractsPath = path.join(directory, "v2-author-contracts.json");
    await fsp.writeFile(contractsPath, JSON.stringify(solidColorRectContracts(), null, 2) + "\n");

    const workspaceDir = path.join(directory, "workspace");
    const conversion = await runV2Conversion({
      sourcePath,
      contractsPath,
      workspaceDir,
      runId: "run-independent-reference",
    });

    assert.equal(conversion.status, "passed");
    const verification = JSON.parse(await fsp.readFile(conversion.verificationResultPath, "utf8"));
    assert.equal(verification.status, "passed");
    assert.equal(verification.pageResults.every((item) => item.status === "passed"), true);
    assert.equal(verification.evidenceResults.some((item) => item.subjectRef === "ev-blue-rect-color" && item.status === "passed"), true);
    assert.equal(verification.objectResults.some((item) => item.status === "passed"), true);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("V2 conversion 与 bounded optimizer 端到端闭环失败诊断、patch 迭代和最终发布", async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "img2ppt-v2-optimizer-e2e-"));
  try {
    const sourcePath = path.join(directory, "source.png");
    await writeIndependentReferenceSource(sourcePath);
    const initial = solidColorRectContracts();
    const reconstructionSpec = initial.contracts.find((contract) => contract.contractKind === "reconstruction-spec");
    const evidenceGraph = initial.contracts.find((contract) => contract.contractKind === "evidence-graph");
    const rect = reconstructionSpec.pages[0].rootNode.children[0];
    rect.appearance.fills[0].color.components = [1, 0, 0];
    const contractsPath = path.join(directory, "v2-author-contracts.json");
    const workspaceDir = path.join(directory, "workspace");
    let firstFailure;
    let runNumber = 0;
    const result = await runBoundedOptimization({
      initialState: { reconstructionSpec, evidenceGraph },
      maxIterations: 2,
      maxCandidates: 3,
      verify: async (state) => {
        const currentContractsPath = path.join(directory, `contracts-${runNumber}.json`);
        runNumber += 1;
        await fsp.writeFile(currentContractsPath, JSON.stringify({ schemaVersion: 2, contracts: [state.reconstructionSpec, state.evidenceGraph] }) + "\n");
        try {
          const conversion = await runV2Conversion({ sourcePath, contractsPath: currentContractsPath, workspaceDir, runId: `optimizer-e2e-${runNumber}` });
          return JSON.parse(await fsp.readFile(conversion.verificationResultPath, "utf8"));
        } catch (error) {
          if (!error.verificationResult) throw error;
          firstFailure ??= error.verificationResult;
          return error.verificationResult;
        }
      },
      generateCandidates: async () => [47 / 255, 128 / 255, 237 / 255].map((newValue, index) => ({
        candidateId: `fix-blue-fill-${index}`,
        componentRef: "component-scene-node-blue-rect",
        confidence: 1 - index / 10,
        metricsBefore: [{ name: "color-delta-e", value: 100, threshold: 1, unit: "delta-e", direction: "lower-is-better" }],
        patch: {
          targetNodeRef: "blue-rect",
          parameterPath: `/appearance/fills/0/color/components/${index}`,
          oldValue: [1, 0, 0][index],
          newValue,
          evidenceRefs: ["ev-blue-rect-color"],
          diagnosticRefs: ["visual-color-failure"],
          generator: "e2e-test-optimizer",
          risk: "low",
        },
      })),
      applyCandidates: async ({ state, candidates, iteration }) => {
        const applied = applyOptimizerCandidates({ reconstructionSpec: state.reconstructionSpec, candidates, iteration });
        return {
          state: { ...state, reconstructionSpec: applied.reconstructionSpec },
          candidates: applied.candidates,
          appliedPatchRefs: applied.appliedPatchRefs,
        };
      },
    });
    assert.equal(firstFailure.status, "failed-quality-gate");
    assert.ok(firstFailure.failures.length > 0);
    assert.equal(result.status, "passed");
    assert.equal(result.stopReason, "successful-iteration");
    assert.equal(result.history.length, 1);
    assert.equal(result.history[0].candidates.every((candidate) => candidate.status === "applied"), true);
    assert.equal(result.verificationResult.status, "passed");
    await fsp.writeFile(contractsPath, JSON.stringify({ schemaVersion: 2, contracts: [result.state.reconstructionSpec, result.state.evidenceGraph] }) + "\n");
    assert.equal(result.state.reconstructionSpec.optimizerPatches.length, 3);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});
