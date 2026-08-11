import { fitTextMetrics, sha256Digest } from "@image-to-ppt/core";

const NATIVE_NODE_CAPABILITY = {
  group: "group",
  shape: "shape",
  text: "text",
  path: "path",
  image: "image",
  icon: "icon",
  connector: "connector",
  table: "table",
  "table-row": "table",
  "table-cell": "table",
  list: "list",
  "list-item": "list",
  chart: "chart-primitive-lowering",
  "custom-semantic": "custom-semantic",
};

const STRATEGY_SUMMARY_KEY = {
  native: "native",
  "ooxml-postprocess": "ooxmlPostprocess",
  "lower-to-primitives": "lowerToPrimitives",
  "approved-original-raster": "approvedOriginalRaster",
  rejected: "rejected",
};

export const defaultPptxTargetProfile = Object.freeze({
  profileId: "pptx-v2-default",
  backend: "pptx",
  backendVersion: "v2",
  nativeCapabilities: [
    "group", "shape", "text", "path", "image", "connector", "solid-fill",
    "linear-gradient", "affine-transform", "native-flow-text", "connector-anchor",
  ],
  ooxmlPostprocessCapabilities: [
    "rich-text-run-metrics", "positioned-cluster-text", "outer-shadow", "glow", "reflection",
    "connector-arrow",
  ],
  primitiveLoweringCapabilities: [
    "icon", "table", "list", "chart-primitive-lowering", "custom-semantic", "per-side-border",
    "radial-gradient", "connector-custom-path", "primitive-rounded-corner", "multi-stroke",
  ],
  approvedRasterCapabilities: ["approved-original-raster"],
  unsupportedCapabilities: [
    "perspective-transform", "affine-shear", "conic-gradient", "alpha-mask", "luminance-mask", "inner-shadow", "blur",
    "soft-edge", "native-table", "native-chart", "blend-mode",
  ],
  limits: {
    maxSlides: 500,
    maxObjectsPerSlide: 10000,
    maxPathCommandsPerObject: 5000,
    maxTotalPathCommands: 100000,
    maxOutputBytes: 1073741824,
  },
});

function has(profile, group, capability) {
  return profile[group].includes(capability);
}

function capabilityForEffect(effect) {
  return effect.kind;
}

function requiredCapabilities(node) {
  const required = new Set([NATIVE_NODE_CAPABILITY[node.type]]);
  if (node.worldTransform.kind === "perspective-3d") required.add("perspective-transform");
  else {
    required.add("affine-transform");
    const [a, b, c, d] = node.worldTransform.matrix;
    const scaleProduct = Math.hypot(a, b) * Math.hypot(c, d);
    if (scaleProduct > 0 && Math.abs(a * c + b * d) / scaleProduct > 1e-8) required.add("affine-shear");
  }
  for (const fill of node.effectiveAppearance.fills) {
    if (fill.kind === "solid") required.add("solid-fill");
    if (fill.kind === "gradient") required.add(`${fill.gradient.type}-gradient`);
  }
  const sides = new Set(node.effectiveAppearance.strokes.map((stroke) => stroke.side).filter((side) => side !== "all"));
  if (sides.size) required.add("per-side-border");
  if (node.type === "shape" && node.resolvedContent.cornerRadii) {
    const radii = Object.values(node.resolvedContent.cornerRadii).map((radius) => `${radius.value}:${radius.unit}`);
    if (new Set(radii).size > 1) required.add("primitive-rounded-corner");
  }
  if (node.effectiveAppearance.strokes.filter((stroke) => stroke.side === "all").length > 1) required.add("multi-stroke");
  node.effectiveAppearance.effects.forEach((effect) => required.add(capabilityForEffect(effect)));
  for (const mask of node.localGeometry.maskStack) required.add(mask.mode === "alpha" ? "alpha-mask" : "luminance-mask");
  if (node.localGeometry.clipStack.length) required.add("clip-stack");
  if (node.effectiveAppearance.blendMode !== "normal") required.add("blend-mode");
  if (node.type === "text") {
    required.add(node.resolvedContent.layout.mode === "positioned-clusters" ? "positioned-cluster-text" : "native-flow-text");
    if (node.textMetrics || node.resolvedContent.runs.length > 1 || node.resolvedContent.runs.some((run) => run.style.tracking.value !== 0)) required.add("rich-text-run-metrics");
  }
  if (node.type === "connector") {
    if ([node.resolvedContent.start, node.resolvedContent.end].some((endpoint) => endpoint.kind === "node-anchor")) required.add("connector-anchor");
    if (node.resolvedContent.routing === "custom") required.add("connector-custom-path");
    if (node.effectiveAppearance.strokes.some((stroke) => stroke.startMarker !== "none" || stroke.endMarker !== "none")) required.add("connector-arrow");
  }
  if (node.type === "image" && node.resolvedContent.rasterApproval.status === "approved-original-raster") required.add("approved-original-raster");
  return [...required].filter(Boolean).sort();
}

function pathCommandCount(node) {
  if (node.type === "path") return node.resolvedContent.commands.length;
  return 0;
}

function chooseStrategy(node, capabilities, profile) {
  if (node.type === "image" && node.resolvedContent.rasterApproval.status === "approved-original-raster") {
    return has(profile, "approvedRasterCapabilities", "approved-original-raster")
      ? { strategy: "approved-original-raster" }
      : { strategy: "rejected", unsupported: ["approved-original-raster"] };
  }
  const unsupported = capabilities.filter((capability) => has(profile, "unsupportedCapabilities", capability));
  if (unsupported.length) return { strategy: "rejected", unsupported };
  const unknown = capabilities.filter((capability) => ![
    ...profile.nativeCapabilities,
    ...profile.ooxmlPostprocessCapabilities,
    ...profile.primitiveLoweringCapabilities,
    ...profile.approvedRasterCapabilities,
    ...profile.unsupportedCapabilities,
  ].includes(capability));
  if (unknown.length) return { strategy: "rejected", unsupported: unknown };
  if (capabilities.some((capability) => has(profile, "primitiveLoweringCapabilities", capability))) return { strategy: "lower-to-primitives" };
  if (capabilities.some((capability) => has(profile, "ooxmlPostprocessCapabilities", capability))) return { strategy: "ooxml-postprocess" };
  return { strategy: "native" };
}

function nativeKind(node, strategy) {
  if (strategy === "approved-original-raster") return "image";
  if (node.type === "text") return "text";
  if (node.type === "path") return "path";
  if (node.type === "icon") return "group";
  if (node.type === "connector") return "connector";
  if (node.type === "image") return "image";
  if (node.type === "table") return "table";
  if (node.type === "chart") return "chart";
  if (node.type === "table-cell") return "shape";
  if (["group", "list", "list-item", "custom-semantic", "table-row"].includes(node.type)) return "group";
  return "shape";
}

function objectFrame(node) {
  if (node.worldTransform.kind !== "affine-2d") return structuredClone(node.worldBounds.layout);
  const frame = node.localGeometry.frame;
  const localX = ["local", "parent"].includes(frame.coordinateSpace) ? 0 : frame.x;
  const localY = ["local", "parent"].includes(frame.coordinateSpace) ? 0 : frame.y;
  const [a, b, c, d, e, f] = node.worldTransform.matrix;
  const centerX = localX + frame.width / 2;
  const centerY = localY + frame.height / 2;
  const transformedCenterX = a * centerX + c * centerY + e;
  const transformedCenterY = b * centerX + d * centerY + f;
  const width = frame.width * Math.hypot(a, b);
  const height = frame.height * Math.hypot(c, d);
  return {
    x: transformedCenterX - width / 2,
    y: transformedCenterY - height / 2,
    width,
    height,
    unit: frame.unit,
    coordinateSpace: "page",
  };
}

function ooxmlFeatures(node, strategy) {
  const features = [];
  if (node.type === "text") features.push("native-text", "rich-text-runs");
  if (node.type === "shape") features.push("native-shape");
  if (node.type === "path" || node.type === "icon") features.push("custom-geometry");
  if (node.type === "image") {
    features.push("picture-crop");
    if (node.effectiveAppearance.opacity < 1) features.push("picture-opacity");
  }
  if (node.type === "connector") {
    features.push("connector-binding");
    if (node.effectiveAppearance.strokes.some((stroke) => stroke.startMarker !== "none" || stroke.endMarker !== "none")) features.push("connector-arrows");
  }
  if (["group", "list", "list-item", "custom-semantic"].includes(node.type)) features.push("grouping");
  if (strategy === "ooxml-postprocess" && node.type === "text") features.push("manual-text-metrics");
  if (node.localGeometry.maskStack.some((mask) => mask.mode === "alpha")) features.push("alpha-mask");
  if (node.effectiveAppearance.effects.length) features.push("effect-list");
  return [...new Set(features)].sort();
}

function expectedObjects(node, pageId, strategy, parentNode) {
  if (strategy === "rejected") return [];
  const mergedTableFollower = node.type === "table-cell" && Boolean(node.resolvedContent.mergeMasterRef);
  const virtual = mergedTableFollower || ["group", "icon", "list", "list-item", "custom-semantic", "table-row", "table", "chart"].includes(node.type);
  const base = {
    slideId: pageId,
    bbox: objectFrame(node),
    transform: node.worldTransform,
    editableAspects: node.effectiveEditability.requiredAspects,
    expectedOoxmlFeatures: virtual ? [] : ooxmlFeatures(node, strategy),
  };
  const objects = [{
    objectRef: `object-${node.sceneNodeId}-primary`,
    nativeKind: nativeKind(node, strategy),
    role: parentNode?.type === "chart" ? "chart-primitive" : "primary",
    virtual,
    ...base,
  }];
  if (strategy === "lower-to-primitives") {
    for (const side of ["top", "right", "bottom", "left"]) {
      if (node.effectiveAppearance.strokes.some((stroke) => stroke.side === side)) {
        objects.push({
          objectRef: `object-${node.sceneNodeId}-border-${side}`,
          nativeKind: "path",
          role: `border-${side}`,
          virtual: false,
          ...base,
          editableAspects: ["geometry", "appearance"],
          expectedOoxmlFeatures: ["custom-geometry"],
        });
      }
    }
    node.effectiveAppearance.strokes
      .filter((stroke) => stroke.side === "all")
      .slice(1)
      .forEach((stroke, index) => {
        objects.push({
          objectRef: `object-${node.sceneNodeId}-stroke-${index + 1}`,
          nativeKind: "shape",
          role: "stroke-primitive",
          virtual: false,
          ...base,
          editableAspects: ["geometry", "appearance"],
          expectedOoxmlFeatures: ["native-shape"],
        });
      });
  }
  return objects;
}

function loweringStrategies(node, strategy) {
  const strategies = [];
  if (node.type === "chart" && strategy === "lower-to-primitives") strategies.push({
    strategyId: `lower-${node.sceneNodeId}-chart-primitives`,
    kind: "primitive-split",
    editable: true,
    allowedLosses: [],
    verificationResponsibilities: ["visual", "editability", "object-mapping", "component-diagnostic"],
  });
  if (node.type === "table" && strategy === "lower-to-primitives") strategies.push({
    strategyId: `lower-${node.sceneNodeId}-table-grid`,
    kind: "primitive-split",
    editable: true,
    allowedLosses: [],
    verificationResponsibilities: ["visual", "editability", "object-mapping", "component-diagnostic"],
  });
  if (node.type === "icon" && strategy === "lower-to-primitives") strategies.push({
    strategyId: `lower-${node.sceneNodeId}-icon-outline`,
    kind: "primitive-split",
    editable: true,
    allowedLosses: [],
    verificationResponsibilities: ["visual", "editability", "object-mapping", "component-diagnostic"],
  });
  const arrowStroke = node.effectiveAppearance.strokes.find((stroke) => stroke.startMarker !== "none" || stroke.endMarker !== "none");
  if (node.type === "connector" && strategy !== "rejected" && arrowStroke) strategies.push({
    strategyId: `postprocess-${node.sceneNodeId}-connector-arrows`,
    kind: "ooxml-postprocess",
    editable: true,
    ooxmlPostprocess: {
      feature: "connector-arrow",
      parameters: {
        startMarker: arrowStroke.startMarker,
        endMarker: arrowStroke.endMarker,
      },
    },
    allowedLosses: [],
    verificationResponsibilities: ["visual", "editability", "object-mapping", "component-diagnostic"],
  });
  if (node.type === "image" && node.effectiveAppearance.opacity < 1) strategies.push({
    strategyId: `postprocess-${node.sceneNodeId}-picture-opacity`,
    kind: "ooxml-postprocess",
    editable: true,
    ooxmlPostprocess: {
      feature: "opacity",
      parameters: { opacity: node.effectiveAppearance.opacity },
    },
    allowedLosses: [],
    verificationResponsibilities: ["visual", "editability", "object-mapping", "component-diagnostic"],
  });
  if (strategy === "ooxml-postprocess") {
    for (const effect of node.effectiveAppearance.effects) {
      if (effect.kind !== "outer-shadow" && effect.kind !== "glow") continue;
      strategies.push({
        strategyId: `postprocess-${node.sceneNodeId}-${effect.kind}`,
        kind: "ooxml-postprocess",
        editable: true,
        ooxmlPostprocess: {
          feature: effect.kind === "outer-shadow" ? "shadow" : "glow",
          parameters: structuredClone(effect),
        },
        allowedLosses: [],
        verificationResponsibilities: ["visual", "editability", "object-mapping", "component-diagnostic"],
      });
    }
  }
  const radialGradients = node.effectiveAppearance.fills.filter((fill) => fill.kind === "gradient" && fill.gradient.type === "radial");
  if (radialGradients.length && strategy === "lower-to-primitives") strategies.push({
    strategyId: `lower-${node.sceneNodeId}-radial-gradient`,
    kind: "primitive-approximation",
    editable: true,
    approximationErrorBound: {
      name: "radial-gradient-path-error",
      value: 0.02,
      unit: "score",
      threshold: 0.02,
      direction: "lower-is-better",
    },
    allowedLosses: [],
    verificationResponsibilities: ["visual", "editability", "object-mapping", "component-diagnostic"],
  });
  if (strategy !== "lower-to-primitives") return strategies.length ? strategies : undefined;
  const hasAsymmetricCorners = node.type === "shape" && node.resolvedContent.cornerRadii
    && new Set(Object.values(node.resolvedContent.cornerRadii).map((radius) => `${radius.value}:${radius.unit}`)).size > 1;
  if (hasAsymmetricCorners) strategies.push({
    strategyId: `lower-${node.sceneNodeId}-asymmetric-corners`,
    kind: "primitive-approximation",
    editable: true,
    allowedLosses: [{
      code: "asymmetric-corner-radius-approximation",
      category: "visual",
      description: "PPTX 使用最小圆角近似非对称圆角。",
      approved: false,
      affectedAspects: ["appearance", "geometry"],
    }],
    verificationResponsibilities: ["visual", "editability", "object-mapping", "component-diagnostic"],
  });
  if (node.effectiveAppearance.strokes.filter((stroke) => stroke.side === "all").length > 1) strategies.push({
    strategyId: `lower-${node.sceneNodeId}-multi-stroke`,
    kind: "primitive-split",
    editable: true,
    allowedLosses: [],
    verificationResponsibilities: ["visual", "editability", "object-mapping", "component-diagnostic"],
  });
  if (node.effectiveAppearance.strokes.some((stroke) => stroke.side !== "all")) strategies.push({
    strategyId: `lower-${node.sceneNodeId}-per-side-border`,
    kind: "primitive-split",
    editable: true,
    allowedLosses: [],
    verificationResponsibilities: ["visual", "editability", "object-mapping", "component-diagnostic"],
  });
  return strategies.length ? strategies : undefined;
}

function verificationActions(editability) {
  const actions = editability.requiredAspects.map((aspect) => `modify-${aspect}`);
  if (editability.required) actions.push("save-reopen-inspect");
  return [...new Set(actions)].sort();
}

function backendContent(node, page) {
  const content = structuredClone(node.resolvedContent);
  if (node.type !== "connector") return content;
  const sceneNodeBySourceNode = new Map(page.nodes.flatMap((candidate) => candidate.sourceNodeRefs.map((sourceNodeRef) => [sourceNodeRef, candidate.sceneNodeId])));
  for (const endpoint of [content.start, content.end]) {
    if (endpoint.kind !== "node-anchor") continue;
    const sceneNodeRef = sceneNodeBySourceNode.get(endpoint.nodeRef);
    if (!sceneNodeRef) throw new Error(`连接线 ${node.sceneNodeId} 的端点未解析到 Scene Node: ${endpoint.nodeRef}`);
    endpoint.nodeRef = sceneNodeRef;
  }
  return content;
}

function planId(scene, profile) {
  return `plan-${sha256Digest({ sceneId: scene.sceneId, profile }).slice(7, 31)}`;
}

export function assertBackendPlanExecutable(plan) {
  const rejected = plan.operations.filter((operation) => operation.strategy === "rejected");
  if (rejected.length) {
    const error = new Error(rejected.map((operation) => operation.rejectionReason.message).join("；"));
    error.code = "V2_BACKEND_PLAN_REJECTED";
    error.operations = rejected;
    throw error;
  }
  const unapprovedLosses = plan.operations.flatMap((operation) => operation.declaredLosses).filter((loss) => !loss.approved);
  if (unapprovedLosses.length) {
    const error = new Error("Backend Plan 包含未批准损失");
    error.code = "V2_BACKEND_PLAN_UNAPPROVED_LOSS";
    error.losses = unapprovedLosses;
    throw error;
  }
  return plan;
}

export function generateBackendPlan(resolvedScene, targetProfile = defaultPptxTargetProfile, { allowRejected = false, planId: explicitPlanId } = {}) {
  if (resolvedScene.contractKind !== "resolved-scene") throw new TypeError("PPTX Backend Planner 只接受 Resolved Scene");
  if (resolvedScene.pages.length > targetProfile.limits.maxSlides) throw new Error("页面数超过 Target Profile 限制");
  const operations = [];
  let totalPathCommands = 0;
  for (const page of resolvedScene.pages) {
    if (page.nodes.length > targetProfile.limits.maxObjectsPerSlide) throw new Error(`页面 ${page.pageId} 节点数超过 Target Profile 限制`);
    const nodesBySceneNodeId = new Map(page.nodes.map((node) => [node.sceneNodeId, node]));
    for (const node of page.nodes) {
      const pathCommands = pathCommandCount(node);
      totalPathCommands += pathCommands;
      const capabilities = requiredCapabilities(node);
      const textFitting = node.type === "text"
        ? fitTextMetrics({
          resolvedContent: node.resolvedContent,
          textMetrics: node.textMetrics,
          fitConstraints: node.fitConstraints,
        })
        : undefined;
      let decision = chooseStrategy(node, capabilities, targetProfile);
      if (pathCommands > targetProfile.limits.maxPathCommandsPerObject) decision = { strategy: "rejected", unsupported: ["path"] };
      const plannedLoweringStrategies = loweringStrategies(node, decision.strategy);
      const operation = {
        operationId: `operation-${node.sceneNodeId}`,
        sceneNodeRef: node.sceneNodeId,
        pageId: page.pageId,
        ...(node.parentSceneNodeRef ? { parentSceneNodeRef: node.parentSceneNodeRef } : {}),
        childSceneNodeRefs: structuredClone(node.childSceneNodeRefs),
        strategy: decision.strategy,
        requiredCapabilities: capabilities,
        parameters: {
          nodeType: node.type,
          localGeometry: structuredClone(node.localGeometry),
          worldTransform: node.worldTransform,
          worldBounds: node.worldBounds,
          appearance: node.effectiveAppearance,
          content: backendContent(node, page),
          drawOrder: node.drawOrder,
          evidenceRefs: node.evidenceClosure.allEvidenceRefs,
        },
        resourceRefs: node.resourceRefs,
        expectedObjects: expectedObjects(node, page.pageId, decision.strategy, nodesBySceneNodeId.get(node.parentSceneNodeRef)),
        editabilityContract: {
          required: node.effectiveEditability.required,
          requiredAspects: node.effectiveEditability.requiredAspects,
          verificationActions: verificationActions(node.effectiveEditability),
        },
        declaredLosses: [],
        ...(plannedLoweringStrategies ? { loweringStrategies: plannedLoweringStrategies } : {}),
        ...(textFitting ? { textFitting } : {}),
        ...(node.patchProvenance?.length ? { patchProvenance: structuredClone(node.patchProvenance) } : {}),
        ...(decision.strategy === "rejected" ? {
          rejectionReason: {
            code: pathCommands > targetProfile.limits.maxPathCommandsPerObject ? "path-limit-exceeded" : "unsupported-capability",
            message: `节点 ${node.sceneNodeId} 包含目标 PPTX 后端无法执行的能力: ${decision.unsupported.join(", ")}`,
            unsupportedCapabilities: decision.unsupported,
          },
        } : {}),
      };
      operations.push(operation);
    }
  }
  if (totalPathCommands > targetProfile.limits.maxTotalPathCommands) throw new Error("路径命令总数超过 Target Profile 限制");
  const rejected = operations.filter((operation) => operation.strategy === "rejected");
  const unapprovedLosses = operations.flatMap((operation) => operation.declaredLosses).filter((loss) => !loss.approved);
  const strategies = { native: 0, ooxmlPostprocess: 0, lowerToPrimitives: 0, approvedOriginalRaster: 0, rejected: 0 };
  operations.forEach((operation) => { strategies[STRATEGY_SUMMARY_KEY[operation.strategy]] += 1; });
  const plan = {
    schemaVersion: 2,
    contractKind: "backend-plan",
    planId: explicitPlanId ?? planId(resolvedScene, targetProfile),
    sceneRef: resolvedScene.sceneId,
    targetProfile: structuredClone(targetProfile),
    pages: resolvedScene.pages.map((page) => ({ pageId: page.pageId, canvas: structuredClone(page.canvas) })),
    resources: structuredClone(resolvedScene.resources),
    operations,
    summary: {
      nodeCount: operations.length,
      objectCount: operations.reduce((sum, operation) => sum + operation.expectedObjects.length, 0),
      strategies,
      hasRejected: rejected.length > 0,
      hasUnapprovedLoss: unapprovedLosses.length > 0,
    },
  };
  return allowRejected ? plan : assertBackendPlanExecutable(plan);
}
