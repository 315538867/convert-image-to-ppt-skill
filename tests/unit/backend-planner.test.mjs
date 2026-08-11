import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { compileResolvedScene, validateV2Contracts } from "@image-to-ppt/core";
import {
  assertBackendPlanExecutable,
  defaultPptxTargetProfile,
  generateBackendPlan,
} from "@image-to-ppt/renderer-pptx";

const fixtureUrl = new URL("../../packages/core/examples/v2/authoring-comprehensive.json", import.meta.url);

function fixture() {
  return JSON.parse(fs.readFileSync(fixtureUrl, "utf8"));
}

function compile(bundle = fixture(), { preserveMasks = false } = {}) {
  const sourcePackages = bundle.contracts.filter((contract) => contract.contractKind === "source-package");
  const reconstructionSpec = bundle.contracts.find((contract) => contract.contractKind === "reconstruction-spec");
  const evidenceGraph = bundle.contracts.find((contract) => contract.contractKind === "evidence-graph");
  const scene = compileResolvedScene({ sourcePackages, reconstructionSpec, evidenceGraph });
  if (!preserveMasks) {
    scene.pages.flatMap((page) => page.nodes).forEach((node) => {
      node.localGeometry.maskStack = [];
    });
  }
  return scene;
}

function sceneNode(scene, sourceNodeId) {
  return scene.pages.flatMap((page) => page.nodes).find((node) => node.sourceNodeRefs.includes(sourceNodeId));
}

function operation(plan, sourceNodeId) {
  const node = sceneNode({ pages: [{ nodes: plan.operations.map((item) => ({ sceneNodeId: item.sceneNodeRef, sourceNodeRefs: [item.sceneNodeRef.replace("scene-node-", "")] })) }] }, sourceNodeId);
  return plan.operations.find((item) => item.sceneNodeRef === node.sceneNodeId);
}

function profile(overrides = {}) {
  return {
    ...structuredClone(defaultPptxTargetProfile),
    ...overrides,
    limits: { ...defaultPptxTargetProfile.limits, ...(overrides.limits ?? {}) },
  };
}

function addTextMetrics(bundle) {
  const reconstruction = bundle.contracts.find((contract) => contract.contractKind === "reconstruction-spec");
  const evidenceGraph = bundle.contracts.find((contract) => contract.contractKind === "evidence-graph");
  const title = reconstruction.pages[0].rootNode.children.find((node) => node.id === "title");
  title.evidenceRefs.push("ev-title-metrics");
  title.fitConstraints = [{
    parameterPath: "/content/runs/0/style/tracking/value",
    defaultValue: 0.8,
    range: { min: 0.5, max: 1 },
    unit: "px",
    evidenceRefs: ["ev-title-metrics"],
    editabilityAspects: ["text-style"],
  }];
  evidenceGraph.evidence.push({
    id: "ev-title-metrics",
    kind: "text-metrics",
    subjects: [{ nodeRef: "title", role: "primary" }],
    sourceRegions: [{
      pageId: "page-authoring",
      box: { x: 120, y: 144, width: 420, height: 76, unit: "px", coordinateSpace: "source-canvas" },
      purpose: "measurement",
    }],
    measurement: {
      kind: "text-metrics",
      tokens: [{
        text: "可编辑标题",
        range: { start: 0, end: 5 },
        box: { x: 126, y: 151, width: 318, height: 46, unit: "px", coordinateSpace: "source-canvas" },
        script: "Hans",
        confidence: 0.96,
      }],
      baselines: [{
        from: { x: 126, y: 196, unit: "px", coordinateSpace: "source-canvas" },
        to: { x: 444, y: 196, unit: "px", coordinateSpace: "source-canvas" },
      }],
      lineBoxes: [{ x: 120, y: 144, width: 330, height: 54, unit: "px", coordinateSpace: "source-canvas" }],
      tracking: { value: 0.75, unit: "px" },
      lineHeight: { value: 50, unit: "px" },
      fontCandidates: [{ family: "Noto Sans CJK SC", score: 0.99 }],
    },
    tolerances: [{ mode: "edge-distance", value: { value: 1, unit: "px" } }],
    provenance: { method: "manual-measurement", producer: { name: "test" }, evidenceBlobRefs: [] },
    confidence: { score: 0.96, basis: "author-judgment" },
  });
}

test("PPTX Target Profile 明确划分 native、OOXML、lowering、批准栅格和 unsupported 能力", () => {
  const target = defaultPptxTargetProfile;
  assert.equal(target.nativeCapabilities.includes("shape"), true);
  assert.equal(target.ooxmlPostprocessCapabilities.includes("rich-text-run-metrics"), true);
  assert.equal(target.primitiveLoweringCapabilities.includes("per-side-border"), true);
  assert.deepEqual(target.approvedRasterCapabilities, ["approved-original-raster"]);
  assert.equal(target.unsupportedCapabilities.includes("soft-edge"), true);
});

test("Backend Plan 为逐边边框生成 lowering 策略和每边预期对象", () => {
  const scene = compile();
  const card = sceneNode(scene, "gradient-card");
  const template = structuredClone(card.effectiveAppearance.strokes[0]);
  card.effectiveAppearance.strokes = ["top", "right", "bottom", "left"].map((side) => ({ ...structuredClone(template), side }));

  const plan = generateBackendPlan(scene);
  const cardOperation = plan.operations.find((item) => item.sceneNodeRef === card.sceneNodeId);
  assert.equal(cardOperation.strategy, "lower-to-primitives");
  assert.deepEqual(cardOperation.expectedObjects.map((item) => item.role), ["primary", "border-top", "border-right", "border-bottom", "border-left"]);
});

test("Backend Plan 为径向渐变声明路径近似误差边界，并在 Profile 不支持时拒绝", () => {
  const scene = compile();
  const card = sceneNode(scene, "gradient-card");
  card.effectiveAppearance.fills[0].gradient.type = "radial";

  const plan = generateBackendPlan(scene);
  const operation = plan.operations.find((item) => item.sceneNodeRef === card.sceneNodeId);
  const radial = operation.loweringStrategies.find((item) => item.strategyId.endsWith("radial-gradient"));
  assert.equal(operation.strategy, "lower-to-primitives");
  assert.deepEqual(radial.approximationErrorBound, {
    name: "radial-gradient-path-error",
    value: 0.02,
    unit: "score",
    threshold: 0.02,
    direction: "lower-is-better",
  });

  const unsupported = profile({ primitiveLoweringCapabilities: defaultPptxTargetProfile.primitiveLoweringCapabilities.filter((item) => item !== "radial-gradient") });
  const rejectedPlan = generateBackendPlan(scene, unsupported, { allowRejected: true });
  const rejected = rejectedPlan.operations.find((item) => item.sceneNodeRef === card.sceneNodeId);
  assert.equal(rejected.strategy, "rejected");
  assert.deepEqual(rejected.rejectionReason.unsupportedCapabilities, ["radial-gradient"]);
});

test("Backend Plan 将非对称圆角、多重描边和虚线拆为可编辑 primitive", () => {
  const scene = compile();
  const card = sceneNode(scene, "gradient-card");
  card.resolvedContent.cornerRadii = {
    topLeft: { value: 8, unit: "px" },
    topRight: { value: 16, unit: "px" },
    bottomRight: { value: 24, unit: "px" },
    bottomLeft: { value: 4, unit: "px" },
  };
  const baseStroke = structuredClone(card.effectiveAppearance.strokes[0]);
  card.effectiveAppearance.strokes = [
    { ...structuredClone(baseStroke), side: "all", dash: { pattern: [], offset: 0 } },
    { ...structuredClone(baseStroke), side: "all", dash: { pattern: [4, 2], offset: 0 } },
    { ...structuredClone(baseStroke), side: "top", dash: { pattern: [2, 1], offset: 0 } },
  ];

  const plan = generateBackendPlan(scene);
  const operation = plan.operations.find((item) => item.sceneNodeRef === card.sceneNodeId);
  assert.equal(operation.strategy, "lower-to-primitives");
  assert.deepEqual(operation.requiredCapabilities.filter((item) => ["primitive-rounded-corner", "multi-stroke", "per-side-border"].includes(item)), ["multi-stroke", "per-side-border", "primitive-rounded-corner"]);
  assert.equal(operation.loweringStrategies.length, 3);
  assert.equal(operation.expectedObjects.filter((item) => item.role === "stroke-primitive").length, 1);
  assert.equal(operation.expectedObjects.some((item) => item.role === "border-top"), true);
  assert.equal(validateV2Contracts({ schemaVersion: 2, contracts: [...fixture().contracts, scene, plan] }).ok, true);
});

test("Backend Plan 对超出路径复杂度限制的节点显式 rejected 并阻止候选规划", () => {
  const scene = compile();
  const bar = sceneNode(scene, "chart-bar-1");
  bar.type = "path";
  bar.resolvedContent = {
    kind: "path",
    fillRule: "nonzero",
    commands: [
      { command: "move-to", to: { x: 0, y: 0, unit: "px", coordinateSpace: "local" } },
      { command: "line-to", to: { x: 10, y: 0, unit: "px", coordinateSpace: "local" } },
      { command: "line-to", to: { x: 10, y: 10, unit: "px", coordinateSpace: "local" } },
      { command: "close" },
    ],
  };
  const limited = profile({ limits: { maxPathCommandsPerObject: 2 } });

  assert.throws(() => generateBackendPlan(scene, limited), (error) => error.code === "V2_BACKEND_PLAN_REJECTED");
  const diagnostic = generateBackendPlan(scene, limited, { allowRejected: true });
  const rejected = diagnostic.operations.find((item) => item.sceneNodeRef === bar.sceneNodeId);
  assert.equal(rejected.strategy, "rejected");
  assert.equal(rejected.rejectionReason.code, "path-limit-exceeded");
  assert.equal(diagnostic.summary.hasRejected, true);
});

test("Backend Plan 为精确文字度量选择 OOXML 后处理并保留完整参数", () => {
  const scene = compile();
  const title = sceneNode(scene, "title");
  const plan = generateBackendPlan(scene);
  const textOperation = plan.operations.find((item) => item.sceneNodeRef === title.sceneNodeId);

  assert.equal(textOperation.strategy, "ooxml-postprocess");
  assert.equal(textOperation.requiredCapabilities.includes("positioned-cluster-text"), true);
  assert.equal(textOperation.expectedObjects[0].expectedOoxmlFeatures.includes("manual-text-metrics"), true);
  assert.equal(textOperation.parameters.content.text, "可编辑标题");
});

test("Backend Plan 为外阴影和发光声明可编辑 OOXML 后处理", () => {
  const scene = compile();
  const title = sceneNode(scene, "title");
  title.effectiveAppearance.effects = [
    {
      kind: "outer-shadow",
      color: { space: "srgb", components: [0, 0, 0], alpha: 0.4 },
      offsetX: { value: 2, unit: "px" },
      offsetY: { value: 4, unit: "px" },
      blurRadius: { value: 6, unit: "px" },
      spread: { value: 0, unit: "px" },
    },
    {
      kind: "glow",
      color: { space: "srgb", components: [1, 1, 1], alpha: 0.6 },
      radius: { value: 3, unit: "px" },
    },
  ];

  const plan = generateBackendPlan(scene);
  const operation = plan.operations.find((item) => item.sceneNodeRef === title.sceneNodeId);
  assert.equal(operation.strategy, "ooxml-postprocess");
  assert.deepEqual(operation.loweringStrategies.map((item) => item.ooxmlPostprocess.feature), ["shadow", "glow"]);
  assert.equal(operation.expectedObjects[0].expectedOoxmlFeatures.includes("effect-list"), true);
});

test("Backend Plan 将图标容器 lower 为虚拟对象，并为连接线箭头声明 OOXML 后处理", () => {
  const scene = compile();
  const icon = sceneNode(scene, "chart-bar-1");
  icon.type = "icon";
  icon.resolvedContent = {
    kind: "icon",
    semanticName: "测试图标",
    representation: "editable-vector",
    sourceRegion: { x: 0, y: 0, width: 10, height: 10, unit: "px", coordinateSpace: "source-canvas" },
  };
  const connector = sceneNode(scene, "connector");

  const plan = generateBackendPlan(scene);
  const iconOperation = plan.operations.find((item) => item.sceneNodeRef === icon.sceneNodeId);
  const connectorOperation = plan.operations.find((item) => item.sceneNodeRef === connector.sceneNodeId);
  assert.equal(iconOperation.strategy, "lower-to-primitives");
  assert.equal(iconOperation.expectedObjects[0].virtual, true);
  assert.equal(iconOperation.loweringStrategies.some((item) => item.strategyId.endsWith("icon-outline")), true);
  assert.equal(connectorOperation.strategy, "ooxml-postprocess");
  assert.equal(connectorOperation.expectedObjects[0].expectedOoxmlFeatures.includes("connector-arrows"), true);
  assert.equal(connectorOperation.loweringStrategies.some((item) => item.ooxmlPostprocess?.feature === "connector-arrow"), true);
});

test("Backend Plan 将表格网格 lower 为单元格 primitive，并跳过合并从属单元格", () => {
  const scene = compile();
  const table = sceneNode(scene, "table");
  const master = sceneNode(scene, "cell-a");
  const follower = sceneNode(scene, "cell-b");
  master.resolvedContent.columnSpan = 2;
  follower.resolvedContent.mergeMasterRef = "cell-a";

  const plan = generateBackendPlan(scene);
  const tableOperation = plan.operations.find((item) => item.sceneNodeRef === table.sceneNodeId);
  const masterOperation = plan.operations.find((item) => item.sceneNodeRef === master.sceneNodeId);
  const followerOperation = plan.operations.find((item) => item.sceneNodeRef === follower.sceneNodeId);

  assert.equal(tableOperation.strategy, "lower-to-primitives");
  assert.equal(tableOperation.loweringStrategies.some((item) => item.strategyId.endsWith("table-grid")), true);
  assert.equal(masterOperation.expectedObjects[0].virtual, false);
  assert.equal(masterOperation.expectedObjects[0].nativeKind, "shape");
  assert.equal(followerOperation.expectedObjects[0].virtual, true);
  assert.deepEqual(followerOperation.expectedObjects[0].expectedOoxmlFeatures, []);
});

test("Backend Plan 将未知数据图表 lower 为已声明 primitive，而不生成 native chart", () => {
  const scene = compile();
  const chart = sceneNode(scene, "chart");
  const bar = sceneNode(scene, "chart-bar-1");
  const plan = generateBackendPlan(scene);
  const chartOperation = plan.operations.find((item) => item.sceneNodeRef === chart.sceneNodeId);
  const barOperation = plan.operations.find((item) => item.sceneNodeRef === bar.sceneNodeId);

  assert.equal(chartOperation.strategy, "lower-to-primitives");
  assert.equal(chartOperation.expectedObjects[0].virtual, true);
  assert.equal(chartOperation.expectedObjects[0].nativeKind, "chart");
  assert.equal(chartOperation.loweringStrategies.some((item) => item.strategyId.endsWith("chart-primitives")), true);
  assert.equal(chartOperation.parameters.content.dataSemantics, "unknown");
  assert.deepEqual(chartOperation.parameters.content.series, []);
  assert.equal(barOperation.expectedObjects[0].role, "chart-primitive");
  assert.equal(chartOperation.expectedObjects[0].expectedOoxmlFeatures.includes("native-chart"), false);

  const unsupported = profile({
    primitiveLoweringCapabilities: defaultPptxTargetProfile.primitiveLoweringCapabilities.filter((item) => item !== "chart-primitive-lowering"),
  });
  const rejected = generateBackendPlan(scene, unsupported, { allowRejected: true })
    .operations.find((item) => item.sceneNodeRef === chart.sceneNodeId);
  assert.equal(rejected.strategy, "rejected");
  assert.deepEqual(rejected.rejectionReason.unsupportedCapabilities, ["chart-primitive-lowering"]);
});

test("Backend Plan 固化文字拟合决策与 optimizer patch provenance", () => {
  const bundle = fixture();
  addTextMetrics(bundle);
  const reconstruction = bundle.contracts.find((contract) => contract.contractKind === "reconstruction-spec");
  reconstruction.optimizerPatches = [{
    patchId: "patch-title-tracking",
    targetNodeRef: "title",
    parameterPath: "/content/runs/0/style/tracking/value",
    oldValue: 1.5,
    newValue: 0.8,
    evidenceRefs: ["ev-title-metrics"],
    diagnosticRefs: ["diag-title-tracking"],
    iteration: 1,
  }];
  const scene = compile(bundle);
  const title = sceneNode(scene, "title");
  const plan = generateBackendPlan(scene);
  const textOperation = plan.operations.find((item) => item.sceneNodeRef === title.sceneNodeId);

  assert.equal(title.textMetrics.runs[0].authorText, "可编辑标题");
  assert.deepEqual(textOperation.textFitting.fontFamilies, ["Noto Sans CJK SC"]);
  assert.deepEqual(textOperation.textFitting.tracking, { value: 0.75, unit: "px" });
  assert.equal(textOperation.textFitting.anchor, "baseline");
  assert.equal(textOperation.textFitting.textBoxStrategy, "fixed-bounds");
  assert.equal(textOperation.patchProvenance[0].patchId, "patch-title-tracking");
  assert.equal(validateV2Contracts({ schemaVersion: 2, contracts: [...bundle.contracts, scene, plan] }).ok, true);
});

test("Backend Plan 只允许已批准的原始图片使用 approved-original-raster", () => {
  const scene = compile();
  const photo = sceneNode(scene, "photo");
  const plan = generateBackendPlan(scene);
  const photoOperation = plan.operations.find((item) => item.sceneNodeRef === photo.sceneNodeId);

  assert.equal(photoOperation.strategy, "approved-original-raster");
  assert.deepEqual(photoOperation.resourceRefs, [photo.resolvedContent.resourceDigest]);

  photo.resolvedContent.rasterApproval.status = "not-approved";
  const noApprovalPlan = generateBackendPlan(scene);
  const noApprovalOperation = noApprovalPlan.operations.find((item) => item.sceneNodeRef === photo.sceneNodeId);
  assert.equal(noApprovalOperation.strategy, "native");

  photo.effectiveAppearance.opacity = 0.37;
  const transparentPlan = generateBackendPlan(scene);
  const transparentOperation = transparentPlan.operations.find((item) => item.sceneNodeRef === photo.sceneNodeId);
  assert.equal(transparentOperation.loweringStrategies.some((item) => item.ooxmlPostprocess?.feature === "opacity"), true);
  assert.equal(transparentOperation.expectedObjects[0].expectedOoxmlFeatures.includes("picture-opacity"), true);
});

test("Backend Plan 对不支持的 soft-edge 明确拒绝且不生成预期对象", () => {
  const scene = compile();
  const card = sceneNode(scene, "gradient-card");
  card.effectiveAppearance.effects.push({ kind: "soft-edge", radius: { value: 8, unit: "px" } });

  const diagnostic = generateBackendPlan(scene, defaultPptxTargetProfile, { allowRejected: true });
  const rejected = diagnostic.operations.find((item) => item.sceneNodeRef === card.sceneNodeId);
  assert.equal(rejected.strategy, "rejected");
  assert.deepEqual(rejected.expectedObjects, []);
  assert.deepEqual(rejected.rejectionReason.unsupportedCapabilities, ["soft-edge"]);
  assert.throws(() => generateBackendPlan(scene), (error) => error.code === "V2_BACKEND_PLAN_REJECTED");
});

test("Backend Plan 对 clip 和非普通 blend 明确拒绝，不允许静默丢弃", () => {
  const maskedScene = compile(fixture(), { preserveMasks: true });
  const masked = sceneNode(maskedScene, "gradient-card");
  const maskedPlan = generateBackendPlan(maskedScene, defaultPptxTargetProfile, { allowRejected: true });
  const maskedOperation = maskedPlan.operations.find((item) => item.sceneNodeRef === masked.sceneNodeId);
  assert.equal(maskedOperation.strategy, "rejected");
  assert.deepEqual(maskedOperation.rejectionReason.unsupportedCapabilities, ["alpha-mask"]);

  const clippedScene = compile();
  const clipped = sceneNode(clippedScene, "title");
  clipped.localGeometry.clipStack = [{ clipNodeRef: clipped.sceneNodeId, operation: "intersect" }];
  const clippedPlan = generateBackendPlan(clippedScene, defaultPptxTargetProfile, { allowRejected: true });
  const clippedOperation = clippedPlan.operations.find((item) => item.sceneNodeRef === clipped.sceneNodeId);
  assert.equal(clippedOperation.strategy, "rejected");
  assert.deepEqual(clippedOperation.rejectionReason.unsupportedCapabilities, ["clip-stack"]);

  const blendedScene = compile();
  const blended = sceneNode(blendedScene, "title");
  blended.effectiveAppearance.blendMode = "multiply";
  const blendedPlan = generateBackendPlan(blendedScene, defaultPptxTargetProfile, { allowRejected: true });
  const blendedOperation = blendedPlan.operations.find((item) => item.sceneNodeRef === blended.sceneNodeId);
  assert.equal(blendedOperation.strategy, "rejected");
  assert.deepEqual(blendedOperation.rejectionReason.unsupportedCapabilities, ["blend-mode"]);
});

test("Backend Plan 完整输出通过 Schema 和跨契约闭包校验", () => {
  const bundle = fixture();
  const scene = compile(bundle);
  const plan = generateBackendPlan(scene);
  const result = validateV2Contracts({ schemaVersion: 2, contracts: [...bundle.contracts, scene, plan] });

  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  assert.equal(plan.summary.nodeCount, scene.pages[0].nodes.length);
  assert.equal(plan.summary.hasRejected, false);
  assert.equal(plan.summary.hasUnapprovedLoss, false);
});

test("Backend Plan 可执行性检查阻止未批准损失但允许显式批准损失", () => {
  const plan = generateBackendPlan(compile());
  const operation = plan.operations[0];
  operation.declaredLosses.push({
    code: "minor-shadow-difference",
    category: "visual",
    description: "阴影栅格化存在已批准的微小差异。",
    approved: false,
    affectedAspects: ["appearance"],
  });
  assert.throws(() => assertBackendPlanExecutable(plan), (error) => error.code === "V2_BACKEND_PLAN_UNAPPROVED_LOSS");

  operation.declaredLosses[0].approved = true;
  assert.equal(assertBackendPlanExecutable(plan), plan);
});
