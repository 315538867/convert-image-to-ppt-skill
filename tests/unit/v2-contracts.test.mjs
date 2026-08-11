import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { validateV2Contracts } from "@image-to-ppt/core";

const singlePageFixture = new URL("../../packages/core/examples/v2/minimal-single-page.json", import.meta.url);
const multiPageFixture = new URL("../../packages/core/examples/v2/minimal-multi-page.json", import.meta.url);
const comprehensiveFixture = new URL("../../packages/core/examples/v2/authoring-comprehensive.json", import.meta.url);

function readFixture(url) {
  return JSON.parse(fs.readFileSync(url, "utf8"));
}

function codes(result) {
  return new Set(result.errors.map((error) => error.code));
}

function findNode(node, nodeId) {
  if (node.id === nodeId) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, nodeId);
    if (found) return found;
  }
  return null;
}

test("V2 单页最小契约集合通过 schema 和跨契约校验", () => {
  const result = validateV2Contracts(readFixture(singlePageFixture));
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
});

test("V2 多页最小契约集合要求每页都有验证结果", () => {
  const bundle = readFixture(multiPageFixture);
  const result = validateV2Contracts(bundle);
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));

  const verification = bundle.contracts.find((contract) => contract.contractKind === "verification-result");
  verification.pageResults = verification.pageResults.filter((item) => item.subjectRef !== "page-2");
  const failed = validateV2Contracts(bundle);
  assert.equal(failed.ok, false);
  assert.equal(codes(failed).has("V2_VERIFICATION_PAGE_MISSING"), true, JSON.stringify(failed.errors, null, 2));
});

test("V2 Evidence Graph 不能引用未知 Reconstruction node", () => {
  const bundle = readFixture(singlePageFixture);
  const evidence = bundle.contracts.find((contract) => contract.contractKind === "evidence-graph");
  evidence.evidence[0].subjects[0].nodeRef = "missing-node";
  const result = validateV2Contracts(bundle);
  assert.equal(result.ok, false);
  assert.equal(codes(result).has("V2_EVIDENCE_SUBJECT_REF_MISSING"), true, JSON.stringify(result.errors, null, 2));
});

test("V2 Blob digest 必须符合内容寻址格式", () => {
  const bundle = readFixture(singlePageFixture);
  const source = bundle.contracts.find((contract) => contract.contractKind === "source-package");
  source.rawBlob.digest = "sha256:not-a-digest";
  const result = validateV2Contracts(bundle);
  assert.equal(result.ok, false);
  assert.equal(codes(result).has("V2_SCHEMA_INVALID"), true, JSON.stringify(result.errors, null, 2));
});

test("V2 必填契约字段缺失会失败", () => {
  const bundle = readFixture(singlePageFixture);
  const source = bundle.contracts.find((contract) => contract.contractKind === "source-package");
  delete source.canonicalPixels;
  const result = validateV2Contracts(bundle);
  assert.equal(result.ok, false);
  assert.equal(codes(result).has("V2_SCHEMA_INVALID"), true, JSON.stringify(result.errors, null, 2));
});

test("V2 作者契约禁止写入运行成功状态", () => {
  const bundle = readFixture(singlePageFixture);
  const reconstruction = bundle.contracts.find((contract) => contract.contractKind === "reconstruction-spec");
  reconstruction.pages[0].rootNode.children[0].success = true;
  const result = validateV2Contracts(bundle);
  assert.equal(result.ok, false);
  assert.equal(codes(result).has("V2_AUTHOR_RUNTIME_STATE_FORBIDDEN"), true, JSON.stringify(result.errors, null, 2));
});

test("V2 完整作者样例覆盖文字度量、渐变、蒙版、连接线、表格、图表和批准图片", () => {
  const bundle = readFixture(comprehensiveFixture);
  const result = validateV2Contracts(bundle);
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));

  const reconstruction = bundle.contracts.find((contract) => contract.contractKind === "reconstruction-spec");
  const root = reconstruction.pages[0].rootNode;
  assert.equal(findNode(root, "title").content.measurements.visualLines.length, 1);
  assert.equal(findNode(root, "gradient-card").appearance.fills[0].gradient.stops.length, 3);
  assert.equal(findNode(root, "gradient-card").geometry.maskStack[0].source.kind, "blob");
  assert.equal(findNode(root, "connector").content.start.kind, "node-anchor");
  assert.equal(findNode(root, "cell-a").content.kind, "table-cell");
  assert.equal(findNode(root, "chart").content.dataSemantics, "unknown");
  assert.equal(findNode(root, "photo").content.rasterApproval.status, "approved-original-raster");
});

test("V2 节点 content 必须与节点 type 匹配", () => {
  const bundle = readFixture(singlePageFixture);
  const reconstruction = bundle.contracts.find((contract) => contract.contractKind === "reconstruction-spec");
  const title = reconstruction.pages[0].rootNode.children[0];
  title.content = { kind: "shape", shapeKind: "rectangle" };

  const result = validateV2Contracts(bundle);
  assert.equal(result.ok, false);
  assert.equal(codes(result).has("V2_SCHEMA_INVALID"), true, JSON.stringify(result.errors, null, 2));
});

test("V2 Evidence measurement 必须与 evidence kind 匹配", () => {
  const bundle = readFixture(singlePageFixture);
  const evidence = bundle.contracts.find((contract) => contract.contractKind === "evidence-graph");
  evidence.evidence[0].measurement = {
    kind: "spacing",
    axis: "horizontal",
    distance: { value: 12, unit: "px" },
    fromEdge: "right",
    toEdge: "left",
  };

  const result = validateV2Contracts(bundle);
  assert.equal(result.ok, false);
  assert.equal(codes(result).has("V2_SCHEMA_INVALID"), true, JSON.stringify(result.errors, null, 2));
});

test("V2 节点、连接线和蒙版引用必须闭合", () => {
  const bundle = readFixture(comprehensiveFixture);
  const reconstruction = bundle.contracts.find((contract) => contract.contractKind === "reconstruction-spec");
  const root = reconstruction.pages[0].rootNode;
  findNode(root, "connector").content.end.nodeRef = "missing-endpoint";
  findNode(root, "gradient-card").geometry.maskStack[0].source.blobDigest = `sha256:${"e".repeat(64)}`;
  findNode(root, "photo").evidenceRefs = ["missing-evidence"];

  const result = validateV2Contracts(bundle);
  const errorCodes = codes(result);
  assert.equal(result.ok, false);
  assert.equal(errorCodes.has("V2_CONNECTOR_NODE_REF_MISSING"), true, JSON.stringify(result.errors, null, 2));
  assert.equal(errorCodes.has("V2_MASK_BLOB_REF_MISSING"), true, JSON.stringify(result.errors, null, 2));
  assert.equal(errorCodes.has("V2_NODE_EVIDENCE_REF_MISSING"), true, JSON.stringify(result.errors, null, 2));
});

test("V2 不批准文字和源图复合图作为 original raster", () => {
  const bundle = readFixture(comprehensiveFixture);
  const reconstruction = bundle.contracts.find((contract) => contract.contractKind === "reconstruction-spec");
  const photo = findNode(reconstruction.pages[0].rootNode, "photo");
  photo.content.contentKind = "source-derived-composite";
  photo.content.derivation = "source-derived-composite";

  const result = validateV2Contracts(bundle);
  assert.equal(result.ok, false);
  assert.equal(codes(result).has("V2_SCHEMA_INVALID"), true, JSON.stringify(result.errors, null, 2));
});

test("V2 schema 表达高保真派生物、拟合约束、patch、plan 和验证诊断", () => {
  const bundle = readFixture(comprehensiveFixture);
  const source = bundle.contracts.find((contract) => contract.contractKind === "source-package");
  const reconstruction = bundle.contracts.find((contract) => contract.contractKind === "reconstruction-spec");
  const evidence = bundle.contracts.find((contract) => contract.contractKind === "evidence-graph");
  const title = findNode(reconstruction.pages[0].rootNode, "title");
  const sourceId = source.sourceId;
  const sourcePageId = source.pages[0].pageId;
  const titleTracking = title.content.runs[0].style.tracking.value;

  source.analysisDerivatives = [
    {
      derivativeId: "derivative-text-1",
      kind: "ocr-tokens",
      sourcePageRef: sourcePageId,
      canonicalPixelDigest: source.canonicalPixels.digest,
      sourceRegions: [
        {
          pageId: sourcePageId,
          box: { x: 120, y: 150, width: 210, height: 42, unit: "px", coordinateSpace: "source-canvas" },
        },
      ],
      generator: {
        name: "fixture-text-analyzer",
        version: "1.0.0",
        parametersDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      },
      contentDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      hypothesis: true,
      confidence: 0.92,
      blobRefs: [source.canonicalPixels.digest],
      metadata: { tokenCount: 4 },
    },
  ];
  source.localizedAssets = [
    {
      assetId: "crop-title-1",
      purpose: "failure-crop",
      sourcePageRef: sourcePageId,
      sourceRegion: {
        pageId: sourcePageId,
        box: { x: 120, y: 150, width: 210, height: 42, unit: "px", coordinateSpace: "source-canvas" },
      },
      scale: 1,
      colorHandling: "canonical",
      blobRef: source.canonicalPixels.digest,
      parentDerivativeRef: "derivative-text-1",
    },
  ];

  evidence.evidence.push({
    id: "ev-title-metrics",
    kind: "text-metrics",
    subjects: [{ nodeRef: "title", role: "primary" }],
    sourceRegions: [
      {
        pageId: sourcePageId,
        box: { x: 120, y: 150, width: 210, height: 42, unit: "px", coordinateSpace: "source-canvas" },
        purpose: "measurement",
      },
    ],
    measurement: {
      kind: "text-metrics",
      tokens: [
        {
          text: "可编辑标题",
          range: { start: 0, end: 5 },
          box: { x: 130, y: 158, width: 88, height: 20, unit: "px", coordinateSpace: "source-canvas" },
          script: "Hans",
          confidence: 0.93,
        },
      ],
      baselines: [
        {
          from: { x: 130, y: 179, unit: "px", coordinateSpace: "source-canvas" },
          to: { x: 218, y: 179, unit: "px", coordinateSpace: "source-canvas" },
          xHeight: { value: 11, unit: "px" },
          capHeight: { value: 15, unit: "px" },
        },
      ],
      lineBoxes: [{ x: 128, y: 154, width: 92, height: 28, unit: "px", coordinateSpace: "source-canvas" }],
      tracking: { value: 0.2, unit: "px" },
      lineHeight: { value: 24, unit: "px" },
      fontCandidates: [{ family: "PingFang SC", score: 0.88, weight: 600, style: "normal" }],
    },
    tolerances: [{ mode: "absolute", value: { value: 1, unit: "px" } }],
    provenance: {
      method: "image-analysis",
      producer: { name: "fixture-text-analyzer", version: "1.0.0" },
      evidenceBlobRefs: [],
    },
    confidence: { score: 0.9, basis: "recognized-content" },
    qualityDiagnostics: [
      {
        code: "low-confidence",
        severity: "info",
        message: "fixture diagnostic",
        evidenceRef: "ev-title-metrics",
        nodeRef: "title",
      },
    ],
  });
  evidence.qualityDiagnostics = [
    {
      code: "missing-measurement",
      severity: "warning",
      message: "fixture graph-level diagnostic",
      evidenceRef: "ev-title-metrics",
      nodeRef: "title",
    },
  ];

  reconstruction.styleTokens = [
    {
      tokenId: "style-title",
      kind: "font-size",
      resolvedValue: { value: 24, unit: "pt" },
      evidenceRefs: ["ev-title-metrics"],
      scope: { pageRefs: [sourcePageId], nodeRefs: ["title"] },
      allowedDeviation: { name: "font-size-delta", value: 1, unit: "pt", threshold: 1, direction: "lower-is-better" },
    },
  ];
  title.styleTokenRefs = ["style-title"];
  title.fitConstraints = [
    {
      parameterPath: "/content/runs/0/style/fontSize/value",
      defaultValue: 24,
      range: { min: 22, max: 26, step: 0.5 },
      unit: "pt",
      priority: 10,
      locked: false,
      evidenceRefs: ["ev-title-metrics"],
      editabilityAspects: ["text-style"],
      forbiddenFallbacks: ["text-raster"],
    },
  ];
  title.lockedFields = ["/content/text"];
  title.structureCandidates = [
    {
      candidateId: "candidate-title-vector",
      kind: "complex-path",
      evidenceRefs: ["ev-title-metrics"],
      editableSemantics: ["text", "style"],
      unknownSemantics: [],
      visualPrimitiveRefs: ["title"],
      fallbackLimit: "reject-if-uneditable",
    },
  ];
  reconstruction.optimizerPatches = [
    {
      patchId: "patch-title-tracking",
      targetNodeRef: "title",
      parameterPath: "/content/runs/0/style/tracking/value",
      oldValue: titleTracking,
      newValue: 0.2,
      evidenceRefs: ["ev-title-metrics"],
      diagnosticRefs: ["diag-title-edge"],
      iteration: 1,
      generator: "fixture-optimizer",
      risk: "low",
    },
  ];

  const authorResult = validateV2Contracts(bundle);
  assert.equal(authorResult.ok, true, JSON.stringify(authorResult.errors, null, 2));

  const backendPlan = {
    schemaVersion: 2,
    contractKind: "backend-plan",
    planId: "plan-hi-fi",
    sceneRef: "scene-hi-fi",
    targetProfile: {
      profileId: "pptx-hi-fi",
      backend: "pptx",
      backendVersion: "fixture",
      nativeCapabilities: ["text", "shape"],
      ooxmlPostprocessCapabilities: ["text-fitting"],
      primitiveLoweringCapabilities: ["primitive-rounded-corner", "multi-stroke"],
      approvedRasterCapabilities: [],
      unsupportedCapabilities: [],
      limits: {
        maxSlides: 10,
        maxObjectsPerSlide: 200,
        maxPathCommandsPerObject: 200,
        maxTotalPathCommands: 1000,
        maxOutputBytes: 5000000,
      },
    },
    pages: [{ pageId: sourcePageId, canvas: { width: 960, height: 540, unit: "px" } }],
    resources: [],
    operations: [
      {
        operationId: "op-title",
        sceneNodeRef: "scene-node-title",
        pageId: sourcePageId,
        childSceneNodeRefs: [],
        strategy: "ooxml-postprocess",
        requiredCapabilities: ["text-fitting"],
        parameters: {
          nodeType: "text",
          localGeometry: title.geometry,
          worldTransform: { kind: "affine-2d", matrix: [1, 0, 0, 1, 0, 0] },
          worldBounds: {
            layout: title.geometry.bounds.layout,
            content: title.geometry.bounds.content,
            ink: title.geometry.bounds.ink,
            effect: title.geometry.bounds.effect,
          },
          appearance: title.appearance,
          content: title.content,
          drawOrder: 1,
          evidenceRefs: ["ev-title-metrics"],
        },
        resourceRefs: [],
        expectedObjects: [
          {
            objectRef: "obj-title",
            slideId: sourcePageId,
            nativeKind: "text",
            role: "primary",
            virtual: false,
            bbox: title.geometry.bounds.layout,
            transform: { kind: "affine-2d", matrix: [1, 0, 0, 1, 0, 0] },
            editableAspects: ["content", "text-style"],
            expectedOoxmlFeatures: ["native-text", "manual-text-metrics"],
          },
        ],
        editabilityContract: {
          required: true,
          requiredAspects: ["content", "text-style"],
          verificationActions: ["modify-content", "modify-text-style", "save-reopen-inspect"],
        },
        declaredLosses: [],
        loweringStrategies: [
          {
            strategyId: "lower-title-text",
            kind: "ooxml-postprocess",
            editable: true,
            ooxmlPostprocess: { feature: "text-metrics", parameters: { tracking: 0.2 } },
            allowedLosses: [],
            verificationResponsibilities: ["visual", "editability", "object-mapping"],
          },
        ],
        textFitting: {
          fontFamilies: ["PingFang SC"],
          fallbackFontFamilies: ["Arial Unicode MS"],
          fontSize: { value: 24, unit: "pt" },
          tracking: { value: 0.2, unit: "px" },
          lineHeight: { value: 24, unit: "px" },
          baselineShift: { value: 0, unit: "px" },
          anchor: "baseline",
          textBoxStrategy: "fixed-bounds",
          evidenceRefs: ["ev-title-metrics"],
          selectionReason: "fixture best fit",
        },
        patchProvenance: [
          {
            patchId: "patch-title-tracking",
            targetNodeRef: "title",
            parameterPath: "/content/runs/0/style/tracking/value",
            oldValue: titleTracking,
            newValue: 0.2,
            diagnosticRefs: ["diag-title-edge"],
          },
        ],
      },
    ],
    summary: {
      nodeCount: 1,
      objectCount: 1,
      strategies: {
        native: 0,
        ooxmlPostprocess: 1,
        lowerToPrimitives: 0,
        approvedOriginalRaster: 0,
        rejected: 0,
      },
      hasRejected: false,
      hasUnapprovedLoss: false,
    },
  };

  const verification = {
    schemaVersion: 2,
    contractKind: "verification-result",
    verificationId: "verification-hi-fi",
    planRef: "plan-hi-fi",
    sourcePackageRefs: [sourceId],
    status: "failed-quality-gate",
    sourceResults: [{ subjectRef: "source-1", status: "passed", gate: "source" }],
    pageResults: [{ subjectRef: sourcePageId, status: "failed", gate: "visual" }],
    evidenceResults: [{ subjectRef: "ev-title-metrics", status: "passed", gate: "evidence" }],
    sceneNodeResults: [{ subjectRef: "scene-node-title", status: "failed", gate: "component" }],
    operationResults: [{ subjectRef: "op-title", status: "failed", gate: "operation" }],
    objectResults: [{ subjectRef: "obj-title", status: "passed", gate: "object" }],
    protectedRegionResults: [],
    editabilityResults: [{ subjectRef: "obj-title", status: "passed", gate: "editability" }],
    componentResults: [
      {
        componentRef: "title",
        componentType: "text",
        status: "failed",
        metrics: [{ name: "baseline-delta", value: 2.1, unit: "px", threshold: 1, direction: "lower-is-better" }],
        failureRegions: [
          {
            pageId: sourcePageId,
            box: { x: 120, y: 150, width: 210, height: 42, unit: "px", coordinateSpace: "source-canvas" },
            category: "text-metrics",
            cropDigest: source.canonicalPixels.digest,
          },
        ],
        responsibility: {
          evidenceRefs: ["ev-title-metrics"],
          sceneNodeRefs: ["scene-node-title"],
          operationRefs: ["op-title"],
          objectRefs: ["obj-title"],
        },
        suggestedPatches: [
          {
            patchKind: "text-fitting",
            targetRef: "title",
            parameterPath: "/content/runs/0/style/tracking/value",
            direction: "increase",
            confidence: 0.7,
          },
        ],
      },
    ],
    optimizationHistory: [
      {
        iteration: 1,
        inputDigest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
        candidates: [
          {
            candidateId: "candidate-title-tracking",
            rank: 0,
            status: "applied",
            metricsBefore: [{ name: "baseline-delta", value: 2.1, unit: "px" }],
            metricsAfter: [{ name: "baseline-delta", value: 0.9, unit: "px" }],
          },
        ],
        appliedPatchRefs: ["patch-title-tracking"],
        status: "failed",
        stopReason: "not-stopped",
        verificationResultRef: "verification-hi-fi",
      },
    ],
    goldenCorpusResults: [
      {
        sampleId: "golden-text-1",
        sampleKind: "text",
        independentReference: true,
        status: "failed",
        metrics: [{ name: "text-edge-score", value: 0.92, unit: "score", threshold: 0.96, direction: "higher-is-better" }],
        failureCode: "corpus-failure",
      },
    ],
    antiCheatResults: [
      {
        check: "text-raster",
        status: "passed",
        subjectRef: "title",
        message: "editable text preserved",
      },
    ],
    packageSecurity: { subjectRef: "package", status: "passed", gate: "package-security" },
    summary: {
      totalChecks: 4,
      passedChecks: 3,
      failedChecks: 1,
      skippedChecks: 0,
      gateStatus: "failed-quality-gate",
      weightedVisualScore: 0.9,
    },
    failures: [
      {
        category: "component-diagnostic",
        subjectRef: "title",
        code: "diag-title-edge",
        message: "title baseline mismatch",
      },
    ],
  };

  const runtimeResult = validateV2Contracts({ schemaVersion: 2, contracts: [source, backendPlan, verification] });
  assert.equal(runtimeResult.ok, true, JSON.stringify(runtimeResult.errors, null, 2));
});

test("V2 高保真契约拒绝失真的派生物、evidence、fit constraint 与 optimizer patch", () => {
  const bundle = readFixture(comprehensiveFixture);
  const source = bundle.contracts.find((contract) => contract.contractKind === "source-package");
  const reconstruction = bundle.contracts.find((contract) => contract.contractKind === "reconstruction-spec");
  const evidence = bundle.contracts.find((contract) => contract.contractKind === "evidence-graph");
  const title = findNode(reconstruction.pages[0].rootNode, "title");
  const evidenceId = evidence.evidence[0].id;
  const sourcePageId = source.pages[0].pageId;
  const reconstructionPageId = reconstruction.pages[0].pageId;
  const sourceCanvas = source.pages[0].canvas;
  const titleTextEvidence = evidence.evidence.find((item) => item.id === "ev-title-ink");

  source.analysisDerivatives = [
    {
      derivativeId: "derivative-invalid",
      kind: "edge-map",
      sourcePageRef: sourcePageId,
      canonicalPixelDigest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      sourceRegions: [
        {
          pageId: sourcePageId,
          box: { x: 0, y: 0, width: 1, height: 1, unit: "px", coordinateSpace: "source-canvas" },
        },
      ],
      generator: { name: "fixture", version: "1.0.0" },
      contentDigest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      hypothesis: true,
      blobRefs: [source.canonicalPixels.digest],
    },
  ];
  evidence.evidence[0].sourceRegions[0].box = {
    x: 0,
    y: 0,
    width: sourceCanvas.width,
    height: sourceCanvas.height,
    unit: "px",
    coordinateSpace: "source-canvas",
  };
  title.evidenceRefs = [];
  titleTextEvidence.subjects = [];
  reconstruction.styleTokens = [
    {
      tokenId: "style-title-a",
      kind: "font-size",
      resolvedValue: { value: 24, unit: "pt" },
      evidenceRefs: [evidenceId],
      scope: { pageRefs: [reconstructionPageId], nodeRefs: ["title"] },
      allowedDeviation: { name: "font-size-delta", value: 1, unit: "pt" },
    },
    {
      tokenId: "style-title-b",
      kind: "font-size",
      resolvedValue: { value: 30, unit: "pt" },
      evidenceRefs: [evidenceId],
      scope: { pageRefs: [reconstructionPageId], nodeRefs: ["title"] },
      allowedDeviation: { name: "font-size-delta", value: 1, unit: "pt" },
    },
  ];
  title.styleTokenRefs = ["missing-style-token", "style-title-a", "style-title-b"];
  title.fitConstraints = [
    {
      parameterPath: "/content/missing",
      defaultValue: 1,
      range: { min: 0, max: 2 },
      unit: "px",
      evidenceRefs: [evidenceId],
      editabilityAspects: ["text-style"],
      forbiddenFallbacks: ["text-raster"],
    },
  ];
  title.lockedFields = ["/content/text"];
  reconstruction.optimizerPatches = [
    {
      patchId: "patch-locked-text",
      targetNodeRef: "title",
      parameterPath: "/content/text",
      oldValue: title.content.text,
      newValue: "changed",
      evidenceRefs: [evidenceId],
      diagnosticRefs: [],
      iteration: 1,
    },
    {
      patchId: "patch-text-raster-downgrade",
      targetNodeRef: "title",
      parameterPath: "/editability/allowedFallbacks/0",
      oldValue: title.editability.allowedFallbacks[0],
      newValue: "text-raster",
      evidenceRefs: [evidenceId],
      diagnosticRefs: [],
      iteration: 1,
    },
  ];
  evidence.qualityDiagnostics = [
    {
      code: "unusable",
      severity: "error",
      message: "fixture evidence must block optimization",
      evidenceRef: evidenceId,
      nodeRef: "title",
    },
  ];

  const result = validateV2Contracts(bundle);
  const errorCodes = codes(result);
  assert.equal(result.ok, false);
  assert.equal(errorCodes.has("V2_DERIVATIVE_CANONICAL_DIGEST_MISMATCH"), true, JSON.stringify(result.errors, null, 2));
  assert.equal(errorCodes.has("V2_EVIDENCE_REGION_TOO_BROAD"), true, JSON.stringify(result.errors, null, 2));
  assert.equal(errorCodes.has("V2_TEXT_METRIC_EVIDENCE_MISSING"), true, JSON.stringify(result.errors, null, 2));
  assert.equal(errorCodes.has("V2_NODE_STYLE_TOKEN_REF_MISSING"), true, JSON.stringify(result.errors, null, 2));
  assert.equal(errorCodes.has("V2_STYLE_TOKEN_CONFLICT"), true, JSON.stringify(result.errors, null, 2));
  assert.equal(errorCodes.has("V2_FIT_CONSTRAINT_PATH_MISSING"), true, JSON.stringify(result.errors, null, 2));
  assert.equal(errorCodes.has("V2_OPTIMIZER_PATCH_LOCKED_FIELD"), true, JSON.stringify(result.errors, null, 2));
  assert.equal(errorCodes.has("V2_OPTIMIZER_PATCH_FORBIDDEN_FALLBACK"), true, JSON.stringify(result.errors, null, 2));
  assert.equal(errorCodes.has("V2_EVIDENCE_QUALITY_ERROR"), true, JSON.stringify(result.errors, null, 2));
});
