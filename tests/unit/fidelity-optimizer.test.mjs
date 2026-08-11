import assert from "node:assert/strict";
import test from "node:test";
import { applyOptimizerCandidates, createOptimizationIteration, generateAppearanceCandidates, generateGeometryCandidates, generateStructureCandidates, generateTextFittingCandidates, rankOptimizerCandidates, runBoundedOptimization } from "@image-to-ppt/cli";

function reconstructionSpec() {
  return {
    schemaVersion: 2,
    contractKind: "reconstruction-spec",
    documentId: "document-optimizer",
    sourcePackageRefs: ["source-1"],
    pages: [{
      pageId: "page-1",
      sourcePageRef: "page-1",
      canvas: { width: 100, height: 100, unit: "px" },
      rootNode: {
        id: "root",
        type: "group",
        geometry: { box: { x: 0, y: 0, width: 100, height: 100, unit: "px", coordinateSpace: "page" }, transform: { translateX: 0, translateY: 0, rotationDeg: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0, flipHorizontal: false, flipVertical: false }, maskStack: [] },
        appearance: { fills: [], strokes: [], effects: [], opacity: 1, blendMode: "normal", isolation: false },
        content: { kind: "group", semantics: [] },
        editability: { required: false, requiredAspects: [], allowedFallbacks: [] }, evidenceRefs: [], children: [{
          id: "title", type: "text",
          geometry: { box: { x: 10, y: 10, width: 80, height: 20, unit: "px", coordinateSpace: "page" }, transform: { translateX: 0, translateY: 0, rotationDeg: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0, flipHorizontal: false, flipVertical: false }, maskStack: [] },
          appearance: { fills: [], strokes: [], effects: [], opacity: 1, blendMode: "normal", isolation: false },
          content: { kind: "text", text: "Hi", normalization: "NFC", language: "en", direction: "ltr", writingMode: "horizontal-tb", indexing: { segmentation: "unicode-grapheme-cluster", utf16Boundaries: [0, 1, 2] }, runs: [{ range: { start: 0, end: 2 }, style: { fontFamilies: ["Arial"], fontSize: { value: 12, unit: "px" }, fontWeight: 400, fontStyle: "normal", color: { space: "srgb", components: [0, 0, 0], alpha: 1 }, tracking: { value: 0, unit: "px" }, baselineShift: { value: 0, unit: "px" }, features: [], variationAxes: {} } }], paragraphs: [{ range: { start: 0, end: 2 }, alignment: "left", direction: "ltr", indent: { left: { value: 0, unit: "px" }, right: { value: 0, unit: "px" }, firstLine: { value: 0, unit: "px" } }, spacingBefore: { value: 0, unit: "px" }, spacingAfter: { value: 0, unit: "px" }, lineSpacing: { mode: "exact", value: 12 } }], hardBreakRanges: [], layout: { mode: "native-flow", wrapMode: "none", overflow: "clip", verticalAlign: "top", padding: { top: 0, right: 0, bottom: 0, left: 0, unit: "px" } }, measurements: { inkBounds: { x: 10, y: 10, width: 20, height: 12, unit: "px", coordinateSpace: "source-canvas" }, visualLines: [], positionedClusters: [] } },
          editability: { required: true, requiredAspects: ["content", "text-style"], allowedFallbacks: ["native"] }, evidenceRefs: [], children: [],
        }],
      },
    }],
  };
}

test("Optimizer 稳定排序候选并只在运行时副本中记录 patch", () => {
  const candidates = [{ candidateId: "candidate-b", confidence: 0.5, metricsBefore: [{ name: "error", value: 2, threshold: 0, direction: "lower-is-better" }], patch: { targetNodeRef: "title", parameterPath: "/content/runs/0/style/fontSize/value", oldValue: 12, newValue: 13, evidenceRefs: [], diagnosticRefs: [] } }, { candidateId: "candidate-a", confidence: 0.8, metricsBefore: [], patch: { targetNodeRef: "title", parameterPath: "/content/runs/0/style/tracking/value", oldValue: 0, newValue: 0.5, evidenceRefs: [], diagnosticRefs: [] } }];
  const ranked = rankOptimizerCandidates(candidates);
  assert.deepEqual(ranked.map((candidate) => candidate.candidateId), ["candidate-a", "candidate-b"]);
  const source = reconstructionSpec();
  const applied = applyOptimizerCandidates({ reconstructionSpec: source, candidates: ranked, iteration: 1 });
  assert.equal(source.optimizerPatches, undefined);
  assert.equal(applied.reconstructionSpec.optimizerPatches.length, 2);
  assert.equal(applied.reconstructionSpec.pages[0].rootNode.children[0].content.runs[0].style.fontSize.value, 12);
  assert.equal(applied.reconstructionSpec.optimizerPatches.some((patch) => patch.newValue === 13), true);
  assert.equal(applied.appliedPatchRefs.length, 2);
  const history = createOptimizationIteration({ verificationResult: { verificationId: "verification-1", status: "failed-quality-gate" }, candidates: applied.candidates, appliedPatchRefs: applied.appliedPatchRefs, iteration: 1, maxIterations: 3 });
  assert.equal(history.stopReason, "not-stopped");
});

test("Optimizer 为文字拟合生成 fallback、字号、间距、baseline 和 textbox 候选", () => {
  const spec = reconstructionSpec();
  spec.pages[0].rootNode.children[0].fitConstraints = [{ parameterPath: "/content/runs/0/style/fontSize/value", range: { min: 10, max: 16 }, unit: "px", priority: 1, locked: false, evidenceRefs: [], editabilityAspects: ["text-style"], forbiddenFallbacks: [] }];
  const resolvedScene = { pages: [{ pageId: "page-1", nodes: [{ sceneNodeId: "scene-node-title", sourceNodeRefs: ["title"], type: "text" }] }] };
  const backendPlan = { operations: [{ sceneNodeRef: "scene-node-title", textFitting: { fontFamilies: ["Arial"], fallbackFontFamilies: ["Noto Sans"], fontSize: { value: 13, unit: "px" }, tracking: { value: 0.5, unit: "px" }, lineHeight: { value: 13, unit: "px" }, baselineShift: { value: 1, unit: "px" } } }] };
  const component = { componentRef: "component-scene-node-title", componentType: "text", status: "failed", metrics: [{ name: "font-size-error", value: 2, threshold: 0.5, direction: "lower-is-better" }], responsibility: { evidenceRefs: ["ev-title"], sceneNodeRefs: ["scene-node-title"], operationRefs: ["operation-scene-node-title"], objectRefs: [] } };
  const candidates = generateTextFittingCandidates({ reconstructionSpec: spec, resolvedScene, backendPlan, componentResults: [component] });
  assert.equal(candidates.some((candidate) => candidate.metadata.kind === "font-fallback"), true);
  assert.equal(candidates.some((candidate) => candidate.metadata.kind === "font-size"), true);
  assert.equal(candidates.some((candidate) => candidate.metadata.kind === "tracking"), true);
  assert.equal(candidates.some((candidate) => candidate.metadata.kind === "baseline"), true);
  assert.equal(candidates.some((candidate) => candidate.metadata.kind === "line-height"), true);
  assert.equal(candidates.some((candidate) => candidate.metadata.kind === "textbox-width"), true);
  assert.equal(candidates.every((candidate) => candidate.patch.targetNodeRef === "title"), true);
});

test("Optimizer 为几何失败生成位置、尺寸和局部 transform 候选", () => {
  const spec = reconstructionSpec();
  const resolvedScene = { pages: [{ pageId: "page-1", nodes: [{ sceneNodeId: "scene-node-title", sourceNodeRefs: ["title"], type: "shape" }] }] };
  const component = { componentRef: "component-scene-node-title", componentType: "shape", status: "failed", metrics: [{ name: "x-error", value: 2, threshold: 0, direction: "lower-is-better" }, { name: "width-error", value: 3, threshold: 0, direction: "lower-is-better" }], responsibility: { evidenceRefs: ["ev-shape"], sceneNodeRefs: ["scene-node-title"], operationRefs: [], objectRefs: [] } };
  const candidates = generateGeometryCandidates({ reconstructionSpec: spec, resolvedScene, componentResults: [component] });
  assert.equal(candidates.some((candidate) => candidate.metadata.kind === "geometry-x"), true);
  assert.equal(candidates.some((candidate) => candidate.metadata.kind === "geometry-width"), true);
  assert.equal(candidates.some((candidate) => candidate.metadata.kind === "local-transform"), true);
  assert.equal(candidates.every((candidate) => candidate.patch.targetNodeRef === "title"), true);
});

test("Optimizer 为外观失败生成 fill、stroke、opacity、gradient 和 shadow 候选", () => {
  const spec = reconstructionSpec();
  const node = spec.pages[0].rootNode.children[0];
  node.type = "shape";
  node.content = { kind: "shape", shapeKind: "rectangle", cornerRadii: { topLeft: { value: 2, unit: "px" }, topRight: { value: 2, unit: "px" }, bottomRight: { value: 2, unit: "px" }, bottomLeft: { value: 2, unit: "px" } } };
  node.appearance = {
    fills: [{ kind: "solid", color: { space: "srgb", components: [0.2, 0.3, 0.4], alpha: 1 } }],
    strokes: [{ side: "all", color: { space: "srgb", components: [0.1, 0.1, 0.1], alpha: 1 }, width: { value: 1, unit: "px" }, dash: { pattern: [], offset: 0 } }],
    effects: [{ kind: "outer-shadow", color: { space: "srgb", components: [0, 0, 0], alpha: 0.5 }, offsetX: { value: 2, unit: "px" }, offsetY: { value: 2, unit: "px" }, blurRadius: { value: 4, unit: "px" }, spread: { value: 0, unit: "px" } }], opacity: 0.8, blendMode: "normal", isolation: false,
  };
  const resolvedScene = { pages: [{ pageId: "page-1", nodes: [{ sceneNodeId: "scene-node-title", sourceNodeRefs: ["title"], type: "shape" }] }] };
  const component = { componentRef: "component-scene-node-title", componentType: "shape", status: "failed", metrics: [{ name: "color-delta-e", value: 4, threshold: 1, direction: "lower-is-better" }, { name: "opacity-error", value: 0.2, threshold: 0.01, direction: "lower-is-better" }, { name: "gradient-stop-count-error", value: 1, threshold: 0, direction: "lower-is-better" }], responsibility: { evidenceRefs: ["ev-shape"], sceneNodeRefs: ["scene-node-title"], operationRefs: [], objectRefs: [] } };
  const candidates = generateAppearanceCandidates({ reconstructionSpec: spec, resolvedScene, componentResults: [component] });
  assert.equal(candidates.some((candidate) => candidate.metadata.kind === "fill-color"), true);
  assert.equal(candidates.some((candidate) => candidate.metadata.kind === "opacity"), true);
  assert.equal(candidates.some((candidate) => candidate.metadata.kind === "shadow-offset-x"), true);
  assert.equal(candidates.some((candidate) => candidate.metadata.kind === "shadow-blur"), true);
});

test("Optimizer 为结构失败生成表格吸附、路径控制点和连接线端点候选", () => {
  const spec = reconstructionSpec();
  const node = spec.pages[0].rootNode.children[0];
  node.type = "path";
  node.content = { kind: "path", fillRule: "nonzero", commands: [{ command: "move-to", to: { x: 1.5, y: 2.5, unit: "px", coordinateSpace: "local" } }, { command: "line-to", to: { x: 10, y: 10, unit: "px", coordinateSpace: "local" } }] };
  node.geometry.box.x = 10.5;
  const resolvedScene = { pages: [{ pageId: "page-1", nodes: [{ sceneNodeId: "scene-node-title", sourceNodeRefs: ["title"], type: "path" }] }] };
  const component = { componentRef: "component-scene-node-title", componentType: "path", status: "failed", metrics: [{ name: "path-outline-error", value: 2, threshold: 0, direction: "lower-is-better" }], responsibility: { evidenceRefs: ["ev-path"], sceneNodeRefs: ["scene-node-title"], operationRefs: [], objectRefs: [] } };
  const candidates = generateStructureCandidates({ reconstructionSpec: spec, resolvedScene, componentResults: [component] });
  assert.equal(candidates.some((candidate) => candidate.metadata.kind === "path-control-point"), true);
  assert.equal(candidates.every((candidate) => candidate.patch.targetNodeRef === "title"), true);
});

test("Optimizer bounded loop 回退组件回归并记录 exhausted", async () => {
  let verificationRound = 0;
  const result = await runBoundedOptimization({
    initialState: { value: 0 },
    maxIterations: 1,
    maxCandidates: 1,
    verify: async (state) => ({ verificationId: `verification-${verificationRound++}`, status: "failed-quality-gate", componentResults: [{ componentRef: "component-title", status: state.value ? "failed" : "passed", metrics: [] }] }),
    generateCandidates: async () => [{ candidateId: "candidate-1", confidence: 1, metricsBefore: [], componentRef: "component-title", patch: { targetNodeRef: "title", parameterPath: "/value", oldValue: 0, newValue: 1, evidenceRefs: [], diagnosticRefs: [] } }],
    applyCandidates: async ({ candidates }) => ({ state: { value: 1 }, candidates: candidates.map((candidate) => ({ ...candidate, status: "applied" })), appliedPatchRefs: ["patch-1"] }),
  });
  assert.equal(result.status, "reverted");
  assert.equal(result.stopReason, "component-regression");
  assert.equal(result.history[0].candidates[0].status, "reverted");
});

test("Optimizer 拒绝无效 patch 和禁止的 editability downgrade", () => {
  const spec = reconstructionSpec();
  const node = spec.pages[0].rootNode.children[0];
  node.lockedFields = ["/content/text"];
  node.fitConstraints = [{ parameterPath: "/content/runs/0/style/fontSize/value", range: { min: 10, max: 16 }, unit: "px", priority: 1, locked: true, evidenceRefs: [], editabilityAspects: ["text-style"], forbiddenFallbacks: [] }];
  const result = applyOptimizerCandidates({ reconstructionSpec: spec, candidates: [
    { candidateId: "missing", confidence: 1, metricsBefore: [], patch: { targetNodeRef: "unknown", parameterPath: "/content/text", oldValue: "x", newValue: "y", evidenceRefs: [], diagnosticRefs: [] } },
    { candidateId: "locked", confidence: 1, metricsBefore: [], patch: { targetNodeRef: "title", parameterPath: "/content/runs/0/style/fontSize/value", oldValue: 12, newValue: 13, evidenceRefs: [], diagnosticRefs: [] } },
  ] });
  assert.equal(result.candidates.find((candidate) => candidate.candidateId === "missing").rejectionReason, "invalid-patch");
  assert.equal(result.candidates.find((candidate) => candidate.candidateId === "locked").rejectionReason, "editability-regression");
  assert.equal(result.appliedPatchRefs.length, 0);
});

test("Optimizer bounded loop 在初始通过时立即停止并限制候选数量", async () => {
  const result = await runBoundedOptimization({
    initialState: {}, maxIterations: 2, maxCandidates: 1,
    verify: async () => ({ verificationId: "verification-passed", status: "passed", componentResults: [] }),
    generateCandidates: async () => [{ candidateId: "unused", confidence: 1, metricsBefore: [], patch: {} }],
    applyCandidates: async () => { throw new Error("不应应用候选"); },
  });
  assert.equal(result.stopReason, "successful-iteration");
  assert.equal(result.history.length, 0);
});
