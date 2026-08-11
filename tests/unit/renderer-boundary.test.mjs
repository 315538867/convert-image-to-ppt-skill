import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { unzipSync } from "fflate";
import { validateV2Contracts } from "@image-to-ppt/core";
import { sha256BytesDigest } from "@image-to-ppt/core/canonical";
import {
  inspectBackendPlanObjects,
  renderPptxFromBackendPlan,
} from "@image-to-ppt/renderer-pptx";

const fixtureUrl = new URL("../../packages/core/examples/v2/minimal-single-page.json", import.meta.url);
const authoringFixtureUrl = new URL("../../packages/core/examples/v2/authoring-comprehensive.json", import.meta.url);
const rendererUrl = new URL("../../packages/renderer-pptx/src/render-backend-plan.mjs", import.meta.url);

function backendPlan() {
  const bundle = JSON.parse(fs.readFileSync(fixtureUrl, "utf8"));
  return structuredClone(bundle.contracts.find((contract) => contract.contractKind === "backend-plan"));
}

async function temporaryOutput(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "img2ppt-v2-renderer-"));
  try {
    return await run(path.join(directory, "candidate.pptx"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("V2 Renderer 只用 Backend Plan 和资源生成候选并在重开后输出 Object Manifest", async () => {
  const plan = backendPlan();
  const result = await temporaryOutput((outputPath) => renderPptxFromBackendPlan(plan, new Map(), outputPath));

  assert.match(result.outputPptxBlobDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.outputPptxByteLength > 0, true);
  assert.equal(result.objectManifest.planRef, plan.planId);
  assert.equal(result.objectManifest.contractKind, "object-manifest");
  assert.equal(validateV2Contracts({ schemaVersion: 2, contracts: [plan, result.objectManifest] }).ok, true);
  assert.equal(result.objectManifest.outputPptx.digest, result.outputPptxBlobDigest);
  const root = result.objectManifest.objects.find((object) => object.sceneNodeId === "scene-node-root");
  const title = result.objectManifest.objects.find((object) => object.sceneNodeId === "scene-node-title");
  assert.equal(root.virtual, true);
  assert.deepEqual(root.ooxmlObjectIds, []);
  assert.equal(title.virtual, false);
  assert.equal(title.nativeObjectKind, "text");
  assert.equal(title.expectedRole, "primary");
  assert.equal(title.containerObjectRef, "object-scene-node-root-primary");
  assert.deepEqual(title.loweringStrategyIds, []);
  assert.deepEqual(title.ooxmlObjectIds, ["2"]);
  assert.deepEqual(title.bbox, { x: 16, y: 16, width: 80, height: 24, unit: "px", coordinateSpace: "page" });
  assert.match(title.contentDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(title.actualOoxmlFeatures.includes("native-text"), true);

  const invalidManifest = structuredClone(result.objectManifest);
  const invalidTitle = invalidManifest.objects.find((object) => object.objectRef === title.objectRef);
  invalidTitle.expectedRole = "effect";
  invalidTitle.containerObjectRef = null;
  invalidTitle.loweringStrategyIds = ["invented-strategy"];
  const invalidValidation = validateV2Contracts({ schemaVersion: 2, contracts: [plan, invalidManifest] });
  assert.equal(invalidValidation.ok, false);
  assert.equal(invalidValidation.errors.some((error) => error.code === "V2_OBJECT_MANIFEST_ROLE_MISMATCH"), true);
  assert.equal(invalidValidation.errors.some((error) => error.code === "V2_OBJECT_MANIFEST_CONTAINER_MISMATCH"), true);
  assert.equal(invalidValidation.errors.some((error) => error.code === "V2_OBJECT_MANIFEST_LOWERING_MISMATCH"), true);
});

test("Object Manifest 来自实际 OOXML，不照抄 expected native kind", async () => {
  const plan = backendPlan();
  const titleObject = plan.operations.find((operation) => operation.parameters.nodeType === "text").expectedObjects[0];
  titleObject.nativeKind = "shape";

  const result = await temporaryOutput((outputPath) => renderPptxFromBackendPlan(plan, new Map(), outputPath));
  const title = result.objectManifest.objects.find((object) => object.objectRef === titleObject.objectRef);
  assert.equal(title.nativeObjectKind, "text");
});

test("Renderer 仅执行 Backend Plan 的文字拟合与 OOXML 后处理", async () => {
  const plan = backendPlan();
  const textOperation = plan.operations.find((operation) => operation.parameters.nodeType === "text");
  textOperation.textFitting = {
    fontFamilies: ["Noto Sans CJK SC"],
    fallbackFontFamilies: ["Microsoft YaHei"],
    fontSize: { value: 20, unit: "px" },
    tracking: { value: 1, unit: "px" },
    lineHeight: { value: 28, unit: "px" },
    baselineShift: { value: 2, unit: "px" },
    paragraphSpacingBefore: { value: 3, unit: "px" },
    paragraphSpacingAfter: { value: 4, unit: "px" },
    anchor: "baseline",
    textBoxStrategy: "fixed-bounds",
    evidenceRefs: [],
    selectionReason: "测试执行计划。",
  };
  await temporaryOutput(async (outputPath) => {
    await renderPptxFromBackendPlan(plan, new Map(), outputPath);
    const archive = unzipSync(new Uint8Array(fs.readFileSync(outputPath)));
    const slide = new TextDecoder().decode(archive["ppt/slides/slide1.xml"]);
    assert.match(slide, /baseline="10000"/);
    assert.match(slide, /spc="750"/);
    assert.match(slide, /anchor="t"/);
  });
});

test("Renderer 通过 OOXML 后处理保留外阴影、发光和效果透明度", async () => {
  const plan = backendPlan();
  const textOperation = plan.operations.find((operation) => operation.parameters.nodeType === "text");
  textOperation.parameters.appearance.effects = [
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
  textOperation.parameters.appearance.opacity = 0.5;
  textOperation.expectedObjects[0].expectedOoxmlFeatures.push("effect-list");

  await temporaryOutput(async (outputPath) => {
    const result = await renderPptxFromBackendPlan(plan, new Map(), outputPath);
    const title = result.objectManifest.objects.find((object) => object.operationId === textOperation.operationId);
    assert.equal(title.actualOoxmlFeatures.includes("effect-list"), true);

    const archive = unzipSync(new Uint8Array(fs.readFileSync(outputPath)));
    const slide = new TextDecoder().decode(archive["ppt/slides/slide1.xml"]);
    assert.match(slide, /<a:outerShdw[^>]*blurRad="57150"[^>]*dist="42597"/);
    assert.match(slide, /<a:glow[^>]*rad="28575"/);
    assert.match(slide, /<a:alpha val="20000"\/>/);
    assert.match(slide, /<a:alpha val="30000"\/>/);
  });
});

test("Renderer 为图片节点写入透明度 OOXML，而不是忽略 appearance.opacity", async () => {
  const plan = backendPlan();
  const authoring = JSON.parse(fs.readFileSync(authoringFixtureUrl, "utf8"));
  const reconstruction = authoring.contracts.find((contract) => contract.contractKind === "reconstruction-spec");
  const photo = reconstruction.pages[0].rootNode.children.find((node) => node.id === "photo");
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9oB4UAAAAASUVORK5CYII=", "base64");
  const digest = sha256BytesDigest(bytes);
  const operation = plan.operations.find((item) => item.parameters.nodeType === "text");
  operation.operationId = "operation-scene-node-photo";
  operation.strategy = "approved-original-raster";
  operation.requiredCapabilities = ["approved-original-raster", "image"];
  operation.parameters.nodeType = "image";
  operation.parameters.content = { ...structuredClone(photo.content), resourceDigest: digest };
  operation.parameters.appearance = { ...structuredClone(photo.appearance), opacity: 0.37 };
  operation.resourceRefs = [digest];
  plan.resources = [{
    digest,
    mediaType: "image/png",
    byteLength: bytes.length,
    storageKey: "tests/one-pixel.png",
    role: "approved-original-image",
    width: 1,
    height: 1,
  }];
  operation.expectedObjects[0] = {
    ...operation.expectedObjects[0],
    objectRef: "object-scene-node-photo-primary",
    nativeKind: "image",
    expectedOoxmlFeatures: ["picture-crop", "picture-opacity"],
  };
  plan.summary.strategies.native -= 1;
  plan.summary.strategies.approvedOriginalRaster += 1;

  await temporaryOutput(async (outputPath) => {
    const result = await renderPptxFromBackendPlan(plan, new Map([[digest, { bytes, contentType: "image/png" }]]), outputPath);
    const image = result.objectManifest.objects.find((object) => object.operationId === operation.operationId);
    assert.equal(image.actualOoxmlFeatures.includes("picture-opacity"), true);

    const archive = unzipSync(new Uint8Array(fs.readFileSync(outputPath)));
    const slide = new TextDecoder().decode(archive["ppt/slides/slide1.xml"]);
    assert.match(slide, /<a:alphaModFix amt="37000"\/>/);
  });
});

test("Renderer 通过 OOXML 后处理保留连接线箭头", async () => {
  const plan = backendPlan();
  const authoring = JSON.parse(fs.readFileSync(authoringFixtureUrl, "utf8"));
  const reconstruction = authoring.contracts.find((contract) => contract.contractKind === "reconstruction-spec");
  const connector = reconstruction.pages[0].rootNode.children.find((node) => node.id === "connector");
  const operation = plan.operations.find((item) => item.parameters.nodeType === "text");
  operation.operationId = "operation-scene-node-connector";
  operation.strategy = "ooxml-postprocess";
  operation.requiredCapabilities = ["connector", "connector-arrow"];
  operation.parameters.nodeType = "connector";
  operation.parameters.appearance = structuredClone(connector.appearance);
  operation.parameters.content = {
    kind: "connector",
    routing: "straight",
    start: { kind: "point", point: { x: 16, y: 28, unit: "px", coordinateSpace: "page" } },
    end: { kind: "point", point: { x: 96, y: 28, unit: "px", coordinateSpace: "page" } },
    waypoints: [],
  };
  operation.expectedObjects[0] = {
    ...operation.expectedObjects[0],
    objectRef: "object-scene-node-connector-primary",
    nativeKind: "connector",
    expectedOoxmlFeatures: ["connector-arrows", "custom-geometry"],
  };
  operation.loweringStrategies = [{
    strategyId: "postprocess-scene-node-connector-arrows",
    kind: "ooxml-postprocess",
    editable: true,
    ooxmlPostprocess: { feature: "connector-arrow", parameters: { startMarker: "none", endMarker: "triangle" } },
    allowedLosses: [],
    verificationResponsibilities: ["visual", "editability", "object-mapping", "component-diagnostic"],
  }];
  plan.summary.strategies.native -= 1;
  plan.summary.strategies.ooxmlPostprocess += 1;

  await temporaryOutput(async (outputPath) => {
    const result = await renderPptxFromBackendPlan(plan, new Map(), outputPath);
    const line = result.objectManifest.objects.find((object) => object.operationId === operation.operationId);
    assert.equal(line.actualOoxmlFeatures.includes("connector-arrows"), true);
    assert.deepEqual(line.loweringStrategyIds, ["postprocess-scene-node-connector-arrows"]);

    const archive = unzipSync(new Uint8Array(fs.readFileSync(outputPath)));
    const slide = new TextDecoder().decode(archive["ppt/slides/slide1.xml"]);
    assert.match(slide, /<a:tailEnd type="triangle"\/>/);
  });
});

test("Renderer 将表格单元格、边框和单元格文字物化，并跳过合并从属单元格", async () => {
  const plan = backendPlan();
  const textOperation = plan.operations.find((item) => item.parameters.nodeType === "text");
  const rootOperation = plan.operations.find((item) => item.parameters.nodeType === "group");
  const cellOperation = structuredClone(textOperation);
  const cellBox = structuredClone(textOperation.expectedObjects[0].bbox);
  const cellTransform = structuredClone(textOperation.expectedObjects[0].transform);
  const cellAppearance = {
    opacity: 1,
    fills: [{ kind: "solid", color: { space: "srgb", components: [0.94, 0.96, 1], alpha: 1 } }],
    strokes: [{
      paint: { kind: "solid", color: { space: "srgb", components: [0.2, 0.3, 0.5], alpha: 1 } },
      width: { value: 1, unit: "px" },
      alignment: "inside",
      side: "all",
      dash: { pattern: [], offset: 0 },
      lineCap: "butt",
      lineJoin: "miter",
    }],
    effects: [],
    blendMode: "normal",
    isolation: false,
  };
  cellOperation.operationId = "operation-scene-node-table-cell-master";
  cellOperation.sceneNodeRef = "scene-node-table-cell-master";
  cellOperation.parentSceneNodeRef = "scene-node-root";
  cellOperation.childSceneNodeRefs = ["scene-node-title", "scene-node-table-cell-follower"];
  cellOperation.strategy = "lower-to-primitives";
  cellOperation.requiredCapabilities = ["solid-fill", "table"];
  cellOperation.parameters = {
    ...cellOperation.parameters,
    nodeType: "table-cell",
    appearance: cellAppearance,
    content: {
      kind: "table-cell",
      cellId: "table-cell-master",
      rowIndex: 0,
      columnIndex: 0,
      rowSpan: 1,
      columnSpan: 2,
      padding: { top: 4, right: 4, bottom: 4, left: 4, unit: "px" },
      verticalAlign: "middle",
      horizontalAlign: "left",
    },
  };
  cellOperation.expectedObjects = [{
    objectRef: "object-scene-node-table-cell-master-primary",
    slideId: "page-1",
    nativeKind: "shape",
    role: "primary",
    virtual: false,
    bbox: cellBox,
    transform: cellTransform,
    editableAspects: ["table-structure", "appearance"],
    expectedOoxmlFeatures: ["native-shape"],
  }];
  cellOperation.editabilityContract = {
    required: true,
    requiredAspects: ["table-structure", "appearance"],
    verificationActions: ["modify-appearance", "modify-geometry", "save-reopen-inspect"],
  };
  cellOperation.loweringStrategies = [{
    strategyId: "lower-table-grid",
    kind: "primitive-split",
    editable: true,
    allowedLosses: [],
    verificationResponsibilities: ["visual", "editability", "object-mapping", "component-diagnostic"],
  }];

  const followerOperation = structuredClone(cellOperation);
  followerOperation.operationId = "operation-scene-node-table-cell-follower";
  followerOperation.sceneNodeRef = "scene-node-table-cell-follower";
  followerOperation.parentSceneNodeRef = "scene-node-table-cell-master";
  followerOperation.childSceneNodeRefs = [];
  followerOperation.parameters.content = {
    ...followerOperation.parameters.content,
    cellId: "table-cell-follower",
    columnIndex: 1,
    columnSpan: 1,
    mergeMasterRef: "table-cell-master",
  };
  followerOperation.expectedObjects[0] = {
    ...followerOperation.expectedObjects[0],
    objectRef: "object-scene-node-table-cell-follower-primary",
    virtual: true,
    expectedOoxmlFeatures: [],
  };

  textOperation.parentSceneNodeRef = cellOperation.sceneNodeRef;
  rootOperation.childSceneNodeRefs = [cellOperation.sceneNodeRef];
  plan.operations.push(cellOperation, followerOperation);
  plan.summary.nodeCount += 2;
  plan.summary.objectCount += 2;
  plan.summary.strategies.lowerToPrimitives += 2;

  await temporaryOutput(async (outputPath) => {
    const result = await renderPptxFromBackendPlan(plan, new Map(), outputPath);
    const master = result.objectManifest.objects.find((object) => object.operationId === cellOperation.operationId);
    const follower = result.objectManifest.objects.find((object) => object.operationId === followerOperation.operationId);
    const text = result.objectManifest.objects.find((object) => object.operationId === textOperation.operationId);
    assert.equal(master.nativeObjectKind, "shape");
    assert.equal(master.actualOoxmlFeatures.includes("native-shape"), true);
    assert.equal(follower.virtual, true);
    assert.equal(follower.containerObjectRef, "object-scene-node-table-cell-master-primary");
    assert.equal(follower.expectedRole, "primary");
    assert.equal(text.nativeObjectKind, "text");
  });
});

test("Renderer 只接受 virtual chart container 与显式 primitive，不伪造未知数据 series", async () => {
  const plan = backendPlan();
  const chartOperation = plan.operations.find((item) => item.parameters.nodeType === "text");
  chartOperation.operationId = "operation-scene-node-chart";
  chartOperation.sceneNodeRef = "scene-node-chart";
  chartOperation.strategy = "lower-to-primitives";
  chartOperation.requiredCapabilities = ["chart-primitive-lowering"];
  chartOperation.parameters.nodeType = "chart";
  chartOperation.parameters.content = {
    kind: "chart",
    chartType: "bar",
    dataSemantics: "unknown",
    axes: [{ axisId: "axis-y", role: "y", scale: "unknown" }],
    legend: { visible: false, position: "none" },
    series: [],
  };
  chartOperation.expectedObjects[0] = {
    ...chartOperation.expectedObjects[0],
    objectRef: "object-scene-node-chart-primary",
    nativeKind: "chart",
    virtual: true,
    editableAspects: ["chart-primitives"],
    expectedOoxmlFeatures: [],
  };
  chartOperation.editabilityContract = {
    required: true,
    requiredAspects: ["chart-primitives"],
    verificationActions: ["modify-chart-primitives", "save-reopen-inspect"],
  };
  chartOperation.loweringStrategies = [{
    strategyId: "lower-chart-primitives",
    kind: "primitive-split",
    editable: true,
    allowedLosses: [],
    verificationResponsibilities: ["visual", "editability", "object-mapping", "component-diagnostic"],
  }];
  plan.operations.find((item) => item.parameters.nodeType === "group").childSceneNodeRefs = [chartOperation.sceneNodeRef];
  plan.summary.strategies.native -= 1;
  plan.summary.strategies.lowerToPrimitives += 1;

  await temporaryOutput(async (outputPath) => {
    const result = await renderPptxFromBackendPlan(plan, new Map(), outputPath);
    const chart = result.objectManifest.objects.find((object) => object.operationId === chartOperation.operationId);
    assert.equal(chart.virtual, true);
    assert.equal(chart.nativeObjectKind, "virtual");

    const archive = unzipSync(new Uint8Array(fs.readFileSync(outputPath)));
    assert.equal(Object.keys(archive).some((name) => name.startsWith("ppt/charts/")), false);
  });

  chartOperation.parameters.content.series = [{ seriesId: "fabricated", name: "禁止伪造", values: [1] }];
  await temporaryOutput(async (outputPath) => {
    await assert.rejects(
      () => renderPptxFromBackendPlan(plan, new Map(), outputPath),
      /未知图表数据伪造成 series/,
    );
  });
});

test("Renderer 将二次贝塞尔和椭圆弧 lower 为可编辑三次路径", async () => {
  const plan = backendPlan();
  const operation = plan.operations.find((item) => item.parameters.nodeType === "text");
  operation.operationId = "operation-scene-node-curved-path";
  operation.strategy = "native";
  operation.requiredCapabilities = ["path"];
  operation.parameters.nodeType = "path";
  operation.parameters.content = {
    kind: "path",
    fillRule: "nonzero",
    commands: [
      { command: "move-to", to: { x: 16, y: 28, unit: "px", coordinateSpace: "page" } },
      { command: "quadratic-to", control: { x: 36, y: 8, unit: "px", coordinateSpace: "page" }, to: { x: 56, y: 28, unit: "px", coordinateSpace: "page" } },
      { command: "arc-to", rx: { value: 20, unit: "px" }, ry: { value: 20, unit: "px" }, rotationDeg: 0, largeArc: false, sweep: true, to: { x: 96, y: 28, unit: "px", coordinateSpace: "page" } },
    ],
  };
  operation.expectedObjects[0] = {
    ...operation.expectedObjects[0],
    objectRef: "object-scene-node-curved-path-primary",
    nativeKind: "path",
    expectedOoxmlFeatures: ["custom-geometry"],
  };

  await temporaryOutput(async (outputPath) => {
    const result = await renderPptxFromBackendPlan(plan, new Map(), outputPath);
    const pathObject = result.objectManifest.objects.find((object) => object.operationId === operation.operationId);
    assert.equal(pathObject.nativeObjectKind, "path");
    assert.equal(pathObject.actualOoxmlFeatures.includes("custom-geometry"), true);

    const archive = unzipSync(new Uint8Array(fs.readFileSync(outputPath)));
    const slide = new TextDecoder().decode(archive["ppt/slides/slide1.xml"]);
    assert.match(slide, /<a:quadBezTo>/);
    assert.match(slide, /<a:cubicBezTo>/);
  });
});

test("Renderer 物化非对称圆角、多重描边与逐边虚线 primitive", async () => {
  const plan = backendPlan();
  const authoring = JSON.parse(fs.readFileSync(authoringFixtureUrl, "utf8"));
  const reconstruction = authoring.contracts.find((contract) => contract.contractKind === "reconstruction-spec");
  const card = reconstruction.pages[0].rootNode.children.find((node) => node.id === "gradient-card");
  const content = structuredClone(card.content);
  content.cornerRadii = {
    topLeft: { value: 8, unit: "px" },
    topRight: { value: 16, unit: "px" },
    bottomRight: { value: 24, unit: "px" },
    bottomLeft: { value: 4, unit: "px" },
  };
  const radialFill = structuredClone(card.appearance.fills[0]);
  radialFill.gradient = {
    type: "radial",
    center: { x: 60, y: 30, unit: "px", coordinateSpace: "local" },
    radiusX: { value: 60, unit: "px" },
    radiusY: { value: 30, unit: "px" },
    stops: radialFill.gradient.stops,
  };
  const baseStroke = structuredClone(card.appearance.strokes[0]);
  const appearance = {
    ...structuredClone(card.appearance),
    fills: [radialFill],
    effects: [],
    strokes: [
      { ...structuredClone(baseStroke), side: "all", dash: { pattern: [], offset: 0 } },
      { ...structuredClone(baseStroke), side: "all", dash: { pattern: [4, 2], offset: 0 } },
      { ...structuredClone(baseStroke), side: "top", dash: { pattern: [2, 1], offset: 0 } },
    ],
  };
  const bbox = { x: 20, y: 40, width: 120, height: 60, unit: "px", coordinateSpace: "page" };
  const operation = {
    operationId: "operation-scene-node-card",
    sceneNodeRef: "scene-node-card",
    pageId: "page-1",
    parentSceneNodeRef: "scene-node-root",
    childSceneNodeRefs: [],
    strategy: "lower-to-primitives",
    requiredCapabilities: ["affine-transform", "multi-stroke", "per-side-border", "primitive-rounded-corner", "shape", "solid-fill"],
    parameters: {
      nodeType: "shape",
      localGeometry: card.geometry,
      worldTransform: card.geometry.transform,
      worldBounds: { layout: bbox, content: bbox, ink: bbox, effect: bbox },
      appearance,
      content,
      drawOrder: 2,
      evidenceRefs: [],
    },
    resourceRefs: [],
    expectedObjects: [
      { objectRef: "object-scene-node-card-primary", slideId: "page-1", nativeKind: "shape", role: "primary", virtual: false, bbox, transform: card.geometry.transform, editableAspects: ["geometry", "appearance"], expectedOoxmlFeatures: ["native-shape"] },
      { objectRef: "object-scene-node-card-border-top", slideId: "page-1", nativeKind: "path", role: "border-top", virtual: false, bbox, transform: card.geometry.transform, editableAspects: ["geometry", "appearance"], expectedOoxmlFeatures: ["custom-geometry"] },
      { objectRef: "object-scene-node-card-stroke-1", slideId: "page-1", nativeKind: "shape", role: "stroke-primitive", virtual: false, bbox, transform: card.geometry.transform, editableAspects: ["geometry", "appearance"], expectedOoxmlFeatures: ["native-shape"] },
    ],
    editabilityContract: { required: true, requiredAspects: ["geometry", "appearance"], verificationActions: ["modify-appearance", "modify-geometry", "save-reopen-inspect"] },
    declaredLosses: [],
    loweringStrategies: [
      { strategyId: "lower-card-asymmetric-corners", kind: "primitive-approximation", editable: true, allowedLosses: [{ code: "asymmetric-corner-radius-approximation", category: "visual", description: "PPTX 使用最小圆角近似非对称圆角。", approved: false, affectedAspects: ["appearance", "geometry"] }], verificationResponsibilities: ["visual"] },
      { strategyId: "lower-card-multi-stroke", kind: "primitive-split", editable: true, allowedLosses: [], verificationResponsibilities: ["visual"] },
      { strategyId: "lower-card-per-side-border", kind: "primitive-split", editable: true, allowedLosses: [], verificationResponsibilities: ["visual"] },
    ],
  };
  plan.targetProfile.primitiveLoweringCapabilities.push("primitive-rounded-corner", "multi-stroke");
  plan.operations.push(operation);
  plan.summary.nodeCount += 1;
  plan.summary.objectCount += operation.expectedObjects.length;
  plan.summary.strategies.lowerToPrimitives += 1;

  const result = await temporaryOutput((outputPath) => renderPptxFromBackendPlan(plan, new Map(), outputPath));
  const primitives = result.objectManifest.objects.filter((object) => object.operationId === operation.operationId);
  assert.equal(primitives.length, 3);
  assert.equal(primitives.every((object) => object.virtual === false), true);
  assert.deepEqual(primitives.map((object) => object.expectedRole).sort(), ["border-top", "primary", "stroke-primitive"]);
  assert.equal(primitives.every((object) => object.loweringStrategyIds.length === 3), true);
});

test("独立检查入口会先重开候选 PPTX 再读取 XML 对象", async () => {
  const plan = backendPlan();
  await temporaryOutput(async (outputPath) => {
    await renderPptxFromBackendPlan(plan, new Map(), outputPath);
    const objects = await inspectBackendPlanObjects(outputPath, plan);
    assert.equal(objects.some((object) => object.nativeObjectKind === "text" && object.ooxmlObjectIds.length === 1), true);
  });
});

test("Renderer 边界不读取 Source Package、作者契约、Capability Manifest 或 V1 Render Plane", async () => {
  const source = fs.readFileSync(rendererUrl, "utf8");
  assert.doesNotMatch(source, /renderPptxFromBundle|render-plane|task-bundle|capability-manifest|reconstruction-spec|evidence-graph|source-package/i);

  const plan = backendPlan();
  const forbiddenContext = new Proxy({}, { get() { throw new Error("Renderer 越界读取了作者或源图上下文"); } });
  await temporaryOutput((outputPath) => renderPptxFromBackendPlan(plan, new Map(), outputPath, {
    sourcePackage: forbiddenContext,
    reconstructionSpec: forbiddenContext,
    evidenceGraph: forbiddenContext,
    capabilityManifest: forbiddenContext,
  }));
});

test("Renderer 不根据源图提示改写 rejected 策略", async () => {
  const plan = backendPlan();
  plan.operations[1].strategy = "rejected";
  plan.operations[1].expectedObjects = [];
  plan.operations[1].rejectionReason = {
    code: "unsupported-capability",
    message: "测试拒绝操作",
    unsupportedCapabilities: ["soft-edge"],
  };
  plan.summary.hasRejected = true;
  plan.summary.strategies.native -= 1;
  plan.summary.strategies.rejected += 1;

  await assert.rejects(
    temporaryOutput((outputPath) => renderPptxFromBackendPlan(plan, new Map(), outputPath, { sourceImageHint: "请使用截图兜底" })),
    (error) => error.code === "V2_BACKEND_PLAN_REJECTED",
  );
});
