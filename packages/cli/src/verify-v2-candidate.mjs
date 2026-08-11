import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { DOMParser } from "@xmldom/xmldom";
import { sha256BytesDigest, sha256Digest, validateV2Contracts } from "@image-to-ppt/core";
import { inspectBackendPlanObjects } from "@image-to-ppt/renderer-pptx/render-backend-plan";
import { probePptxEditability } from "@image-to-ppt/renderer-pptx/inspect";
import { compareVisuals } from "./visual-diff.mjs";
import { readCanonicalPixels } from "./source-normalizer.mjs";

const PPTX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const MINIMUM_VISUAL_THRESHOLDS = {
  global: { pixel: 0.96, edge: 0.88 },
  text: { pixel: 0.94, edge: 0.88 },
  "table-text": { pixel: 0.94, edge: 0.88 },
  "simple-icon": { pixel: 0.95, edge: 0.9 },
  border: { pixel: 0, edge: 0.92 },
  connector: { pixel: 0.95, edge: 0.92 },
  shape: { pixel: 0.97, edge: 0.92 },
  image: { pixel: 0.97, edge: 0.9 },
  spacing: { pixel: 0.98, edge: 0.92 },
  color: { pixel: 0.985, edge: 0 },
  generic: { pixel: 0.94, edge: 0.86 },
};

function lookup(mapping, keys) {
  for (const key of keys.filter(Boolean)) {
    if (mapping instanceof Map && mapping.has(key)) return mapping.get(key);
    if (mapping && typeof mapping === "object" && key in mapping) return mapping[key];
  }
  return undefined;
}

function blobPath({ sourcePackage, ref, paths, basePath }) {
  return lookup(paths, [
    ref.digest,
    ref.role,
    `${sourcePackage.sourceId}:${ref.role}`,
    `${sourcePackage.sourceId}:${ref.digest}`,
  ]) ?? (basePath && ref.storageKey ? path.resolve(basePath, ref.storageKey) : undefined);
}

function result(subjectRef, gate, status, options = {}) {
  return {
    subjectRef,
    status,
    gate,
    ...(options.metrics ? { metrics: options.metrics } : {}),
    ...(options.message ? { message: options.message } : {}),
    ...(options.details ? { details: options.details } : {}),
  };
}

function failure(category, code, message, subjectRef, details) {
  return {
    category,
    code,
    message,
    ...(subjectRef ? { subjectRef } : {}),
    ...(details ? { details } : {}),
  };
}

function pageSourcePackage(sourcePackages, pageId) {
  return sourcePackages.find((sourcePackage) => sourcePackage.pages.some((page) => page.pageId === pageId));
}

function sourcePageIds(sourcePackages) {
  return sourcePackages.flatMap((sourcePackage) => sourcePackage.pages.map((page) => page.pageId));
}

function pageCanvas(sourcePackages, pageId) {
  return pageSourcePackage(sourcePackages, pageId)?.pages.find((page) => page.pageId === pageId)?.canvas;
}

function boxCoverage(box, canvas) {
  if (!box || !canvas || canvas.width <= 0 || canvas.height <= 0) return 0;
  return Math.max(0, Math.min(box.width * box.height, canvas.width * canvas.height)) / (canvas.width * canvas.height);
}

function antiCheatResult(check, status, options = {}) {
  return {
    check,
    status,
    ...(options.subjectRef ? { subjectRef: options.subjectRef } : {}),
    ...(options.message ? { message: options.message } : {}),
    ...(options.details ? { details: options.details } : {}),
  };
}

function antiCheatFailure(result) {
  return failure("anti-cheat", result.check, result.message ?? `检测到 ${result.check}`, result.subjectRef, result.details);
}

function loweredThresholds(visualThresholds) {
  const lowered = [];
  for (const [category, values] of Object.entries(visualThresholds ?? {})) {
    const minimum = MINIMUM_VISUAL_THRESHOLDS[category];
    if (!minimum) continue;
    for (const metric of ["pixel", "edge"]) {
      if (typeof values?.[metric] === "number" && values[metric] < minimum[metric]) {
        lowered.push({ category, metric, requested: values[metric], minimum: minimum[metric] });
      }
    }
  }
  return lowered;
}

function evidenceCategory(evidence) {
  const kind = evidence.measurement?.kind ?? evidence.kind;
  if (kind === "text-content" || kind === "text-ink") return "text";
  if (kind === "edge") return "border";
  if (kind === "image-region") return "image";
  if (kind === "spacing") return "spacing";
  if (kind === "color" || kind === "gradient") return "color";
  return "generic";
}

function nodeCategory(node) {
  if (node.type === "text") return "text";
  if (node.type === "image") return "image";
  if (node.type === "connector") return "connector";
  if (node.type === "path" || node.type === "icon") return "simple-icon";
  if (["shape", "table-cell", "chart"].includes(node.type)) return "shape";
  return "generic";
}

function componentType(node) {
  return node.type === "custom-semantic" ? "custom-semantic" : node.type;
}

function visualMetric(name, value, threshold) {
  return {
    name,
    value,
    unit: "score",
    ...(threshold === undefined ? {} : { threshold }),
    direction: "higher-is-better",
  };
}

function lowerIsBetterMetric(name, value, unit, threshold) {
  return {
    name,
    value,
    unit,
    ...(threshold === undefined ? {} : { threshold }),
    direction: "lower-is-better",
  };
}

function componentMetrics(metrics) {
  if (!metrics) return [];
  return [
    visualMetric("pixel-similarity", metrics.pixelSimilarity, metrics.pixelThreshold),
    visualMetric("edge-similarity", metrics.edgeSimilarity, metrics.edgeThreshold),
  ];
}

function metricDelta(name, actual, expected, threshold, unit = "px") {
  return {
    name,
    value: Math.abs((actual ?? 0) - (expected ?? 0)),
    unit,
    ...(threshold === undefined ? {} : { threshold }),
    direction: "lower-is-better",
  };
}

function textComponentMetrics({ node, operations, regionMetrics }) {
  const operation = operations.find((item) => item.parameters.nodeType === "text");
  const content = node.resolvedContent;
  const firstRun = content.runs?.[0];
  const firstParagraph = content.paragraphs?.[0];
  const fitting = operation?.textFitting;
  if (!operation || !firstRun || !firstParagraph) return componentMetrics(regionMetrics);
  const plannedContentBox = operation.parameters.worldBounds?.content;
  const expectedContentBox = node.worldBounds.content;
  const plannedFont = fitting?.fontFamilies?.[0] ?? firstRun.style.fontFamilies[0];
  const expectedFont = firstRun.style.fontFamilies[0];
  const plannedFontSize = fitting?.fontSize?.value ?? firstRun.style.fontSize.value;
  const plannedTracking = fitting?.tracking?.value ?? firstRun.style.tracking.value;
  const plannedBaselineShift = fitting?.baselineShift?.value ?? firstRun.style.baselineShift.value;
  const expectedLineHeight = firstParagraph.lineSpacing.mode === "exact"
    ? firstParagraph.lineSpacing.value
    : firstParagraph.lineSpacing.value * firstRun.style.fontSize.value;
  const plannedLineHeight = fitting?.lineHeight?.value ?? expectedLineHeight;
  return [
    ...componentMetrics(regionMetrics),
    visualMetric("text-ink-pixel-similarity", regionMetrics?.pixelSimilarity ?? 1, regionMetrics?.pixelThreshold),
    visualMetric("text-ink-edge-similarity", regionMetrics?.edgeSimilarity ?? 1, regionMetrics?.edgeThreshold),
    metricDelta("character-box-x-error", plannedContentBox?.x, expectedContentBox.x, 0),
    metricDelta("character-box-y-error", plannedContentBox?.y, expectedContentBox.y, 0),
    metricDelta("character-box-width-error", plannedContentBox?.width, expectedContentBox.width, 0),
    metricDelta("character-box-height-error", plannedContentBox?.height, expectedContentBox.height, 0),
    metricDelta("baseline-shift-error", plannedBaselineShift, firstRun.style.baselineShift.value, 0.5),
    metricDelta("font-family-mismatch", plannedFont === expectedFont ? 0 : 1, 0, 0, "count"),
    metricDelta("font-size-error", plannedFontSize, firstRun.style.fontSize.value, 0.5),
    metricDelta("tracking-error", plannedTracking, firstRun.style.tracking.value, 0.25),
    metricDelta("line-height-error", plannedLineHeight, expectedLineHeight, 0.5),
  ];
}

function lengthValue(value) {
  return value?.value ?? 0;
}

function shapeComponentMetrics({ node, operations, objects, regionMetrics }) {
  const operation = operations[0];
  if (!operation) return componentMetrics(regionMetrics);
  const plannedAppearance = operation.parameters.appearance ?? {};
  const sceneAppearance = node.effectiveAppearance ?? {};
  const plannedContent = operation.parameters.content ?? {};
  const sceneContent = node.resolvedContent ?? {};
  const plannedRadii = Object.values(plannedContent.cornerRadii ?? {});
  const sceneRadii = Object.values(sceneContent.cornerRadii ?? {});
  const radiusError = plannedRadii.reduce((sum, radius, index) => sum + Math.abs(lengthValue(radius) - lengthValue(sceneRadii[index])), 0);
  const declaredFeatures = new Set(objects.flatMap((object) => object.actualOoxmlFeatures));
  return [
    ...componentMetrics(regionMetrics),
    lowerIsBetterMetric("color-delta-e", regionMetrics?.meanColorDeltaE ?? 0, "delta-e", regionMetrics?.colorDeltaEThreshold),
    metricDelta("opacity-error", plannedAppearance.opacity, sceneAppearance.opacity, 0),
    metricDelta("gradient-stop-count-error", plannedAppearance.fills?.flatMap((fill) => fill.gradient?.stops ?? []).length, sceneAppearance.fills?.flatMap((fill) => fill.gradient?.stops ?? []).length, 0, "count"),
    metricDelta("stroke-count-error", plannedAppearance.strokes?.length, sceneAppearance.strokes?.length, 0, "count"),
    metricDelta("corner-radius-error", radiusError, 0, 0),
    metricDelta("effect-count-error", plannedAppearance.effects?.length, sceneAppearance.effects?.length, 0, "count"),
    metricDelta("mask-clip-count-error", operation.parameters.localGeometry?.maskStack?.length, node.localGeometry?.maskStack?.length, 0, "count"),
    metricDelta("effect-feature-missing", sceneAppearance.effects?.length > 0 && !declaredFeatures.has("effect-list") ? 1 : 0, 0, 0, "count"),
  ];
}

function pointDistance(left, right) {
  if (!left || !right || left.kind !== "point" || right.kind !== "point") return 0;
  return Math.hypot(left.point.x - right.point.x, left.point.y - right.point.y);
}

function structuralComponentMetrics({ node, operations, objects, operationByNode }) {
  const operation = operations[0];
  if (!operation) return [];
  const expectedObjects = operation.expectedObjects ?? [];
  const expectedPrimary = expectedObjects.find((item) => item.role === "primary")?.objectRef ?? null;
  const parentOperation = operation.parentSceneNodeRef ? operationByNode.get(operation.parentSceneNodeRef)?.[0] : undefined;
  const parentPrimary = parentOperation?.expectedObjects.find((item) => item.role === "primary")?.objectRef ?? null;
  const content = operation.parameters.content ?? {};
  const resolvedContent = node.resolvedContent ?? {};
  const hierarchyMismatch = objects.filter((object) => object.containerObjectRef !== parentPrimary).length;
  const metrics = [
    metricDelta("expected-object-count-error", objects.length, expectedObjects.length, 0, "count"),
    metricDelta("object-hierarchy-error", hierarchyMismatch, 0, 0, "count"),
    metricDelta("child-node-count-error", operation.childSceneNodeRefs.length, node.childSceneNodeRefs.length, 0, "count"),
    metricDelta("primary-object-missing", expectedPrimary && !objects.some((object) => object.objectRef === expectedPrimary) ? 1 : 0, 0, 0, "count"),
  ];
  if (node.type === "table-cell") {
    metrics.push(
      metricDelta("table-row-span-error", content.rowSpan, resolvedContent.rowSpan, 0, "count"),
      metricDelta("table-column-span-error", content.columnSpan, resolvedContent.columnSpan, 0, "count"),
      metricDelta("table-merge-master-error", content.mergeMasterRef === resolvedContent.mergeMasterRef ? 0 : 1, 0, 0, "count"),
    );
  }
  if (node.type === "connector") {
    metrics.push(
      lowerIsBetterMetric("connector-start-point-error", pointDistance(content.start, resolvedContent.start), "px", 0),
      lowerIsBetterMetric("connector-end-point-error", pointDistance(content.end, resolvedContent.end), "px", 0),
      metricDelta("connector-waypoint-count-error", content.waypoints?.length, resolvedContent.waypoints?.length, 0, "count"),
    );
  }
  if (node.type === "path") {
    metrics.push(metricDelta("path-command-count-error", content.commands?.length, resolvedContent.commands?.length, 0, "count"));
  }
  if (node.type === "chart") {
    metrics.push(
      metricDelta("chart-primitive-count-error", objects.filter((object) => object.expectedRole === "chart-primitive").length, expectedObjects.filter((object) => object.role === "chart-primitive").length, 0, "count"),
      metricDelta("chart-series-count-error", content.series?.length, resolvedContent.series?.length, 0, "count"),
    );
  }
  return metrics;
}

function structuralStatus(metrics) {
  return metrics.some((metric) => metric.value > (metric.threshold ?? 0)) ? "failed" : "passed";
}

function componentFailureRegions({ pageId, box, metrics }) {
  if (!metrics || (metrics.pixelSimilarity >= metrics.pixelThreshold && metrics.edgeSimilarity >= metrics.edgeThreshold)) return [];
  const regions = [];
  if (metrics.pixelSimilarity < metrics.pixelThreshold) regions.push({ pageId, box, category: "pixel" });
  if (metrics.edgeSimilarity < metrics.edgeThreshold) regions.push({ pageId, box, category: "edge" });
  return regions;
}

function overlapRatio(left, right) {
  const x0 = Math.max(left.x, right.x);
  const y0 = Math.max(left.y, right.y);
  const x1 = Math.min(left.x + left.width, right.x + right.width);
  const y1 = Math.min(left.y + left.height, right.y + right.height);
  const intersection = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return intersection / Math.max(1, left.width * left.height);
}

function failureCropFor({ sourcePackages, pageId, box }) {
  for (const sourcePackage of sourcePackages) {
    const asset = (sourcePackage.localizedAssets ?? []).find((candidate) => candidate.purpose === "failure-crop"
      && candidate.sourcePageRef === pageId
      && overlapRatio(candidate.sourceRegion.box, box) > 0);
    if (asset) return { pageId, box: asset.sourceRegion.box, cropDigest: asset.blobRef };
  }
  return { pageId, box };
}

function suggestedPatchesFor({ componentRef, componentType, metrics }) {
  const failed = metrics.filter((metric) => metric.threshold !== undefined && metric.direction === "lower-is-better"
    ? metric.value > metric.threshold
    : metric.threshold !== undefined && metric.direction === "higher-is-better" && metric.value < metric.threshold);
  if (!failed.length) return [];
  const first = failed[0];
  if (componentType === "text") return [{
    patchKind: "text-fitting",
    targetRef: componentRef.replace(/^component-/, ""),
    parameterPath: "/content/runs/0/style/fontSize/value",
    direction: "replace",
    confidence: 0.72,
    expectedMetricImpact: [first],
  }];
  if (["shape", "image", "icon"].includes(componentType)) return [{
    patchKind: first.name === "color-delta-e" ? "color" : "effect",
    targetRef: componentRef.replace(/^component-/, ""),
    parameterPath: first.name === "color-delta-e" ? "/appearance/fills/0/color/components" : "/appearance/opacity",
    direction: "replace",
    confidence: 0.68,
    expectedMetricImpact: [first],
  }];
  return [{
    patchKind: "structure",
    targetRef: componentRef.replace(/^component-/, ""),
    parameterPath: "/content",
    direction: "snap",
    confidence: 0.6,
    expectedMetricImpact: [first],
  }];
}

function componentResultsForVerification({ sourcePackages, evidenceGraph, resolvedScene, backendPlan, objectManifest, pageResults, protectedRegionResults }) {
  const regionBySubject = new Map(protectedRegionResults.map((item) => [item.subjectRef, item]));
  const pageResultById = new Map(pageResults.map((item) => [item.subjectRef, item]));
  const operationsByNode = new Map();
  for (const operation of backendPlan.operations) {
    const operations = operationsByNode.get(operation.sceneNodeRef) ?? [];
    operations.push(operation);
    operationsByNode.set(operation.sceneNodeRef, operations);
  }
  const objectsByNode = new Map();
  for (const object of objectManifest.objects) {
    const objects = objectsByNode.get(object.sceneNodeId) ?? [];
    objects.push(object);
    objectsByNode.set(object.sceneNodeId, objects);
  }

  const components = [];
  for (const page of resolvedScene?.pages ?? []) {
    const pageResult = pageResultById.get(page.pageId);
    const pageEvidenceRefs = (evidenceGraph?.evidence ?? [])
      .filter((item) => item.sourceRegions?.some((region) => region.pageId === page.pageId))
      .map((item) => item.id);
    const pageOperations = backendPlan.operations.filter((operation) => operation.pageId === page.pageId);
    const pageObjects = objectManifest.objects.filter((object) => object.slideId === page.pageId);
    components.push({
      componentRef: `component-page-${page.pageId}`,
      componentType: "page",
      status: pageResult?.status ?? "skipped",
      metrics: pageResult?.metrics ? [
        visualMetric("weighted-visual-score", pageResult.metrics.weightedScore),
        visualMetric("pixel-similarity", pageResult.metrics.globalPixelSimilarity, pageResult.metrics.globalPixelThreshold),
        visualMetric("edge-similarity", pageResult.metrics.globalEdgeSimilarity, pageResult.metrics.globalEdgeThreshold),
      ] : [],
      ...(pageResult?.status === "failed" ? {
        failureRegions: [{
          ...failureCropFor({
            sourcePackages,
            pageId: page.pageId,
            box: { x: 0, y: 0, width: page.canvas.width, height: page.canvas.height, unit: "px", coordinateSpace: "source-canvas" },
          }),
          category: "geometry",
        }],
        suggestedPatches: [{ patchKind: "structure", targetRef: page.pageId, parameterPath: "/pages", direction: "replace", confidence: 0.5 }],
      } : {}),
      responsibility: {
        evidenceRefs: pageEvidenceRefs,
        sceneNodeRefs: page.nodes.map((node) => node.sceneNodeId),
        operationRefs: pageOperations.map((operation) => operation.operationId),
        objectRefs: pageObjects.map((object) => object.objectRef),
      },
    });

    for (const node of page.nodes) {
      const region = regionBySubject.get(`scene:${node.sceneNodeId}:effect`);
      const operations = operationsByNode.get(node.sceneNodeId) ?? [];
      const objects = objectsByNode.get(node.sceneNodeId) ?? [];
      const structuralMetrics = structuralComponentMetrics({ node, operations, objects, operationByNode: operationsByNode });
      const visualStatus = region?.status ?? "skipped";
      const structuralComponentStatus = structuralMetrics.length ? structuralStatus(structuralMetrics) : "skipped";
      components.push({
        componentRef: `component-${node.sceneNodeId}`,
        componentType: componentType(node),
        status: visualStatus === "failed" || structuralComponentStatus === "failed"
          ? "failed"
          : visualStatus === "passed" || structuralComponentStatus === "passed" ? "passed" : "skipped",
        metrics: [
          ...(node.type === "text"
          ? textComponentMetrics({ node, operations, regionMetrics: region?.metrics })
          : ["shape", "table-cell", "chart", "image", "path", "icon", "connector"].includes(node.type)
            ? shapeComponentMetrics({ node, operations, objects, regionMetrics: region?.metrics })
            : componentMetrics(region?.metrics)),
          ...structuralMetrics,
        ],
        ...(region?.status === "failed" || structuralComponentStatus === "failed" ? {
          failureRegions: [
            ...componentFailureRegions({ pageId: page.pageId, box: node.worldBounds.effect, metrics: region?.metrics })
              .map((failureRegion) => ({ ...failureCropFor({ sourcePackages, pageId: failureRegion.pageId, box: failureRegion.box }), category: failureRegion.category })),
            ...(structuralComponentStatus === "failed" ? [{ ...failureCropFor({ sourcePackages, pageId: page.pageId, box: node.worldBounds.effect }), category: "structure" }] : []),
          ],
          suggestedPatches: suggestedPatchesFor({
            componentRef: `component-${node.sceneNodeId}`,
            componentType: componentType(node),
            metrics: [...(node.type === "text" ? textComponentMetrics({ node, operations, regionMetrics: region?.metrics }) : componentMetrics(region?.metrics)), ...structuralMetrics],
          }),
        } : {}),
        responsibility: {
          evidenceRefs: node.evidenceClosure.allEvidenceRefs,
          sceneNodeRefs: [node.sceneNodeId],
          operationRefs: operations.map((operation) => operation.operationId),
          objectRefs: objects.map((object) => object.objectRef),
        },
      });
    }
  }
  return components;
}

function regionsForPage({ evidenceGraph, resolvedScene, pageId }) {
  const evidenceRegions = (evidenceGraph?.evidence ?? []).flatMap((item) => (item.sourceRegions ?? [])
    .filter((region) => region.pageId === pageId)
    .map((region, index) => ({
      regionId: `evidence:${item.id}:${index}`,
      category: evidenceCategory(item),
      bbox: region.box,
    })));
  const scenePage = resolvedScene?.pages?.find((page) => page.pageId === pageId);
  const sceneRegions = (scenePage?.nodes ?? [])
    .filter((node) => node.worldBounds?.effect?.width > 0 && node.worldBounds?.effect?.height > 0)
    .map((node) => ({
      regionId: `scene:${node.sceneNodeId}:effect`,
      category: nodeCategory(node),
      bbox: node.worldBounds.effect,
    }));
  return [...evidenceRegions, ...sceneRegions];
}

async function verifySourceBinding({ sourcePackages, rawBlobPaths, canonicalPixelPaths, blobBasePath }) {
  const sourceResults = [];
  const failures = [];
  for (const sourcePackage of sourcePackages) {
    const subjectRef = sourcePackage.sourceId;
    const rawPath = blobPath({ sourcePackage, ref: sourcePackage.rawBlob, paths: rawBlobPaths, basePath: blobBasePath });
    const canonicalPath = blobPath({ sourcePackage, ref: sourcePackage.canonicalPixels, paths: canonicalPixelPaths, basePath: blobBasePath });
    const metrics = {
      pageCount: sourcePackage.pages.length,
      workingSpace: sourcePackage.color.workingSpace,
      orientationApplied: sourcePackage.pages.some((page) => page.orientation.applied),
    };
    const localFailures = [];
    if (!rawPath) {
      localFailures.push(failure("source-normalization", "raw-blob-missing", "缺少原始源图 Blob 路径", subjectRef));
    } else {
      const raw = await fs.readFile(rawPath);
      const digest = sha256BytesDigest(raw);
      metrics.rawByteLength = raw.length;
      if (digest !== sourcePackage.rawBlob.digest) {
        localFailures.push(failure("source-normalization", "raw-digest-mismatch", `原始源图摘要不匹配: ${digest}`, subjectRef, { expected: sourcePackage.rawBlob.digest, actual: digest }));
      }
      if (raw.length !== sourcePackage.rawBlob.byteLength) {
        localFailures.push(failure("source-normalization", "raw-byte-length-mismatch", "原始源图字节数不匹配", subjectRef, { expected: sourcePackage.rawBlob.byteLength, actual: raw.length }));
      }
    }
    if (!canonicalPath) {
      localFailures.push(failure("source-normalization", "canonical-pixels-missing", "缺少规范化像素 Blob 路径", subjectRef));
    } else {
      try {
        const canonical = await readCanonicalPixels({ sourcePackage, canonicalPixelsPath: canonicalPath });
        metrics.canonicalWidth = canonical.width;
        metrics.canonicalHeight = canonical.height;
        metrics.canonicalChannels = canonical.channels;
      } catch (error) {
        localFailures.push(failure("source-normalization", "canonical-pixels-invalid", error.message, subjectRef));
      }
    }
    if (sourcePackage.color.workingSpace !== "srgb") {
      localFailures.push(failure("source-normalization", "unsupported-working-space", "当前验证器只接受 sRGB 工作空间", subjectRef, { workingSpace: sourcePackage.color.workingSpace }));
    }
    for (const page of sourcePackage.pages) {
      if (page.canvas.unit !== "px" || page.canvas.width <= 0 || page.canvas.height <= 0) {
        localFailures.push(failure("source-normalization", "invalid-page-canvas", `页面 ${page.pageId} canvas 无效`, page.pageId, { canvas: page.canvas }));
      }
      if (page.orientation.applied && page.orientation.original === null) {
        localFailures.push(failure("source-normalization", "orientation-applied-without-original", `页面 ${page.pageId} 记录了已应用方向但缺少原始方向`, page.pageId));
      }
    }
    failures.push(...localFailures);
    sourceResults.push(result(subjectRef, "source", localFailures.length ? "failed" : "passed", {
      metrics,
      ...(localFailures.length ? { message: "源绑定检查失败" } : { message: "源绑定、规范化像素、画布、方向和色彩空间通过" }),
    }));
  }
  return { sourceResults, failures };
}

async function verifyVisuals({ sourcePackages, evidenceGraph, resolvedScene, renderedPagePaths, rawBlobPaths, canonicalPixelPaths, blobBasePath, visualThresholds, diffDir }) {
  const pageResults = [];
  const protectedRegionResults = [];
  const evidenceResults = [];
  const sceneNodeResults = [];
  const failures = [];
  const visualScores = [];
  for (const pageId of sourcePageIds(sourcePackages)) {
    const sourcePackage = pageSourcePackage(sourcePackages, pageId);
    const renderedPath = lookup(renderedPagePaths, [pageId]);
    const canonicalPath = blobPath({ sourcePackage, ref: sourcePackage.canonicalPixels, paths: canonicalPixelPaths, basePath: blobBasePath });
    const sourcePath = blobPath({ sourcePackage, ref: sourcePackage.rawBlob, paths: rawBlobPaths, basePath: blobBasePath });
    if (!renderedPath) {
      const item = failure("visual-verifier", "rendered-page-missing", `缺少页面 ${pageId} 的渲染预览`, pageId);
      failures.push(item);
      pageResults.push(result(pageId, "visual", "failed", { message: item.message }));
      continue;
    }
    const regions = regionsForPage({ evidenceGraph, resolvedScene, pageId });
    try {
      const visual = await compareVisuals({
        sourcePath,
        sourcePackage,
        canonicalPixelsPath: canonicalPath,
        renderedPath,
        regions,
        thresholds: visualThresholds,
        ...(diffDir ? { diffPath: path.join(diffDir, `${pageId}.diff.png`) } : {}),
      });
      visualScores.push(visual.weightedScore);
      pageResults.push(result(pageId, "visual", visual.status === "passed" ? "passed" : "failed", {
        metrics: {
          weightedScore: visual.weightedScore,
          globalPixelSimilarity: visual.global.pixelSimilarity,
          globalEdgeSimilarity: visual.global.edgeSimilarity,
          globalPixelThreshold: visual.global.thresholds.pixel,
          globalEdgeThreshold: visual.global.thresholds.edge,
        },
        ...(visual.status === "passed" ? {} : { message: "页面视觉验证失败" }),
      }));
      for (const region of visual.regions) {
        const status = region.pixelSimilarity >= region.thresholds.pixel && region.edgeSimilarity >= region.thresholds.edge ? "passed" : "failed";
        protectedRegionResults.push(result(region.regionId, "protected-region", status, {
          metrics: {
            pixelSimilarity: region.pixelSimilarity,
            edgeSimilarity: region.edgeSimilarity,
            meanColorDeltaE: region.meanColorDeltaE,
            pixelThreshold: region.thresholds.pixel,
            edgeThreshold: region.thresholds.edge,
            ...(region.thresholds.deltaE === undefined ? {} : { colorDeltaEThreshold: region.thresholds.deltaE }),
          },
          details: { bbox: region.bbox, excludeBboxes: region.excludeBboxes },
        }));
      }
      for (const hardFailure of visual.hardFailures) {
        failures.push(failure("visual-verifier", `visual-${hardFailure.metric}`, `视觉区域 ${hardFailure.scope} 未达标`, hardFailure.scope, hardFailure));
      }
    } catch (error) {
      failures.push(failure("visual-verifier", "visual-comparison-error", error.message, pageId));
      pageResults.push(result(pageId, "visual", "failed", { message: error.message }));
    }
  }

  const regionBySubject = new Map(protectedRegionResults.map((item) => [item.subjectRef, item]));
  for (const item of evidenceGraph?.evidence ?? []) {
    const subjects = [...regionBySubject.entries()].filter(([key]) => key.startsWith(`evidence:${item.id}:`)).map(([, value]) => value);
    if (!subjects.length) {
      evidenceResults.push(result(item.id, "evidence", "skipped", { message: "Evidence 没有可直接比较的保护区域" }));
    } else {
      evidenceResults.push(result(item.id, "evidence", subjects.some((subject) => subject.status === "failed") ? "failed" : "passed"));
    }
  }
  for (const page of resolvedScene?.pages ?? []) {
    for (const node of page.nodes) {
      const subject = regionBySubject.get(`scene:${node.sceneNodeId}:effect`);
      sceneNodeResults.push(result(node.sceneNodeId, "scene", subject?.status ?? "skipped", subject ? { metrics: subject.metrics } : { message: "Scene Node 没有可直接比较的保护区域" }));
    }
  }
  return { pageResults, protectedRegionResults, evidenceResults, sceneNodeResults, failures, weightedVisualScore: visualScores.length ? visualScores.reduce((sum, value) => sum + value, 0) / visualScores.length : undefined };
}

function boxClose(left, right) {
  return ["x", "y", "width", "height"].every((key) => Math.abs((left?.[key] ?? Number.NaN) - (right?.[key] ?? Number.NaN)) <= 0.02);
}

async function verifyObjectClosure({ sourcePackages, reconstructionSpec, evidenceGraph, resolvedScene, backendPlan, objectManifest, pptxPath }) {
  const failures = [];
  const operationResults = [];
  const objectResults = [];
  const validation = validateV2Contracts({ schemaVersion: 2, contracts: [...sourcePackages, reconstructionSpec, evidenceGraph, resolvedScene, backendPlan, objectManifest].filter(Boolean) });
  if (!validation.ok) {
    failures.push(...validation.errors.map((error) => failure("object-verifier", "contract-closure-invalid", error.message, error.pointer?.replace(/^\//, "").replaceAll("/", ":") || "contracts", { code: error.code, pointer: error.pointer })));
  }
  let actualObjects = [];
  if (pptxPath) {
    try {
      actualObjects = await inspectBackendPlanObjects(pptxPath, backendPlan);
    } catch (error) {
      failures.push(failure("object-verifier", "actual-object-inspection-failed", error.message, "pptx-package"));
    }
  }
  const actualByRef = new Map(actualObjects.map((object) => [object.objectRef, object]));
  const manifestByRef = new Map(objectManifest.objects.map((object) => [object.objectRef, object]));
  for (const operation of backendPlan.operations) {
    const expectedRefs = operation.expectedObjects.map((object) => object.objectRef);
    const missing = expectedRefs.filter((objectRef) => !manifestByRef.has(objectRef));
    operationResults.push(result(operation.operationId, "operation", missing.length ? "failed" : "passed", {
      metrics: { expectedObjects: expectedRefs.length, manifestedObjects: expectedRefs.length - missing.length },
      ...(missing.length ? { message: "Backend Operation 缺少 Object Manifest 对象", details: { missing } } : {}),
    }));
    if (missing.length) failures.push(failure("object-verifier", "operation-object-missing", `操作 ${operation.operationId} 缺少对象`, operation.operationId, { missing }));
  }
  for (const object of objectManifest.objects) {
    const actual = actualByRef.get(object.objectRef);
    if (object.virtual) {
      objectResults.push(result(object.objectRef, "object", object.ooxmlObjectIds.length === 0 ? "passed" : "failed", { message: "virtual 对象不应有 OOXML id" }));
      continue;
    }
    if (!actual) {
      objectResults.push(result(object.objectRef, "object", "failed", { message: "候选 PPTX 中缺少对象" }));
      failures.push(failure("object-verifier", "actual-object-missing", "候选 PPTX 中缺少 Object Manifest 声明对象", object.objectRef));
      continue;
    }
    const mismatches = [];
    if (actual.nativeObjectKind !== object.nativeObjectKind) mismatches.push("nativeObjectKind");
    if (!boxClose(actual.bbox, object.bbox)) mismatches.push("bbox");
    if (actual.contentDigest !== object.contentDigest) mismatches.push("contentDigest");
    if (JSON.stringify(actual.actualOoxmlFeatures) !== JSON.stringify(object.actualOoxmlFeatures)) mismatches.push("actualOoxmlFeatures");
    objectResults.push(result(object.objectRef, "object", mismatches.length ? "failed" : "passed", {
      metrics: { ooxmlObjectIdCount: object.ooxmlObjectIds.length, featureCount: object.actualOoxmlFeatures.length },
      ...(mismatches.length ? { message: "Object Manifest 与实际 OOXML 不一致", details: { mismatches } } : {}),
    }));
    if (mismatches.length) failures.push(failure("object-verifier", "object-ooxml-mismatch", `对象 ${object.objectRef} 与实际 OOXML 不一致`, object.objectRef, { mismatches }));
  }
  return { operationResults, objectResults, failures };
}

async function verifyEditability({ pptxPath, objectManifest }) {
  const required = objectManifest.objects.filter((object) => !object.virtual && object.editability.required);
  if (!required.length) return {
    editabilityResults: objectManifest.objects.map((object) => result(object.objectRef, "editability", "skipped", { message: "对象未声明必需编辑性" })),
    failures: [],
  };
  const expected = required.map((object) => ({
    primitiveId: object.objectRef,
    kind: object.nativeObjectKind,
    virtual: false,
    bbox: { left: object.bbox.x, top: object.bbox.y, width: object.bbox.width, height: object.bbox.height },
  }));
  let probe;
  try {
    probe = await probePptxEditability(pptxPath, expected);
  } catch (error) {
    const editabilityResults = objectManifest.objects.map((object) => result(object.objectRef, "editability", object.editability.required ? "failed" : "skipped", {
      message: object.editability.required ? "编辑性探针无法打开或修改候选 PPTX" : "对象未声明必需编辑性",
      details: object.editability.required ? { error: error.message } : undefined,
    }));
    return {
      editabilityResults,
      failures: editabilityResults
        .filter((item) => item.status === "failed")
        .map((item) => failure("editability", "editability-probe-error", item.message, item.subjectRef, item.details)),
    };
  }
  const byRef = new Map(probe.results.map((item) => [item.primitiveId, item]));
  const editabilityResults = objectManifest.objects.map((object) => {
    const item = byRef.get(object.objectRef);
    if (!item) return result(object.objectRef, "editability", object.editability.required ? "failed" : "skipped", { message: object.editability.required ? "编辑性探针未覆盖必需对象" : "对象未声明必需编辑性" });
    return result(object.objectRef, "editability", item.passed ? "passed" : "failed", {
      metrics: { geometryPersisted: item.geometryPersisted ? 1 : 0, contentPersisted: item.contentPersisted ? 1 : 0 },
      details: item,
    });
  });
  const failures = editabilityResults
    .filter((item) => item.status === "failed")
    .map((item) => failure("editability", "editability-probe-failed", item.message ?? "编辑性探针失败", item.subjectRef, item.details));
  return { editabilityResults, failures };
}

function verifyAntiCheat({ sourcePackages, resolvedScene, backendPlan, objectManifest, visualThresholds, allowLoweredThresholds, sourceFailures, visualFailures, protectedRegionResults }) {
  const antiCheatResults = [];
  const failures = [];
  const lowered = loweredThresholds(visualThresholds);
  const thresholdResult = antiCheatResult(
    "threshold-lowered",
    lowered.length && !allowLoweredThresholds ? "failed" : "passed",
    lowered.length
      ? { message: allowLoweredThresholds ? "测试模式明确允许放宽视觉阈值" : "视觉阈值低于质量门禁最小值", details: { lowered } }
      : { message: "视觉阈值未被放宽" },
  );
  antiCheatResults.push(thresholdResult);

  const hiddenRegions = protectedRegionResults
    .filter((item) => (item.details?.excludeBboxes ?? []).length > 0)
    .map((item) => item.subjectRef);
  antiCheatResults.push(antiCheatResult(
    "hidden-source-detail",
    hiddenRegions.length ? "failed" : "passed",
    { message: hiddenRegions.length ? "保护区域排除了可见源图细节" : "保护区域未排除源图细节", details: { regionRefs: hiddenRegions } },
  ));
  const croppedPages = visualFailures
    .filter((item) => item.code === "visual-comparison-error" && item.message.includes("像素尺寸一致"))
    .map((item) => item.subjectRef);
  antiCheatResults.push(antiCheatResult(
    "cropped-failure-region",
    croppedPages.length ? "failed" : "passed",
    { message: croppedPages.length ? "渲染预览尺寸与规范化源图不一致，可能裁剪失败区域" : "渲染预览未裁剪失败区域", details: { pageIds: croppedPages } },
  ));
  const modifiedSources = sourceFailures
    .filter((item) => ["raw-digest-mismatch", "raw-byte-length-mismatch", "canonical-pixels-invalid"].includes(item.code))
    .map((item) => item.subjectRef);
  antiCheatResults.push(antiCheatResult(
    "source-fact-modified",
    modifiedSources.length ? "failed" : "passed",
    { message: modifiedSources.length ? "Source Package 的不可变事实未通过摘要绑定检查" : "Source Package 的不可变事实完整", details: { sourceRefs: modifiedSources } },
  ));

  const operationByNode = new Map(backendPlan.operations.map((operation) => [operation.sceneNodeRef, operation]));
  const objectsByNode = new Map();
  for (const object of objectManifest.objects) {
    const objects = objectsByNode.get(object.sceneNodeId) ?? [];
    objects.push(object);
    objectsByNode.set(object.sceneNodeId, objects);
  }
  for (const page of resolvedScene?.pages ?? []) {
    for (const node of page.nodes) {
      const operation = operationByNode.get(node.sceneNodeId);
      const objects = objectsByNode.get(node.sceneNodeId) ?? [];
      const canvas = pageCanvas(sourcePackages, page.sourcePageRef);
      if (node.type === "image") {
        const approval = node.resolvedContent.rasterApproval?.status === "approved-original-raster";
        const fullPage = boxCoverage(node.worldBounds.effect, canvas) >= 0.95;
        const rasterResult = antiCheatResult(
          fullPage ? "whole-page-raster" : "undeclared-raster-fallback",
          approval ? "passed" : "failed",
          {
            subjectRef: node.sceneNodeId,
            message: approval ? "图片节点具有显式 approved-original-raster 批准" : "图片节点缺少 approved-original-raster 批准",
            details: { coverage: boxCoverage(node.worldBounds.effect, canvas), strategy: operation?.strategy },
          },
        );
        antiCheatResults.push(rasterResult);
      }
      if (node.type === "text") {
        const rasterObjects = objects.filter((object) => !object.virtual && object.nativeObjectKind === "image");
        const textResult = antiCheatResult(
          "text-raster",
          rasterObjects.length ? "failed" : "passed",
          {
            subjectRef: node.sceneNodeId,
            message: rasterObjects.length ? "要求可编辑的文字被物化为图片" : "可编辑文字未使用图片代理",
            details: { objectRefs: rasterObjects.map((object) => object.objectRef) },
          },
        );
        antiCheatResults.push(textResult);
      }
      const expectedObjectRefs = new Set(operation?.expectedObjects.map((object) => object.objectRef) ?? []);
      const missingObjects = [...expectedObjectRefs].filter((objectRef) => !objects.some((object) => object.objectRef === objectRef));
      const deletedResult = antiCheatResult(
        "deleted-object",
        missingObjects.length ? "failed" : "passed",
        { subjectRef: node.sceneNodeId, message: missingObjects.length ? "计划对象被删除或未写入 Object Manifest" : "计划对象未被删除", details: { missingObjects } },
      );
      antiCheatResults.push(deletedResult);
    }
  }

  for (const item of antiCheatResults.filter((item) => item.status === "failed")) failures.push(antiCheatFailure(item));
  return { antiCheatResults, failures };
}

function relationshipRecords(document) {
  return Array.from(document.getElementsByTagNameNS(REL_NS, "Relationship")).map((node) => ({
    id: node.getAttribute("Id"),
    type: node.getAttribute("Type"),
    target: node.getAttribute("Target"),
    targetMode: node.getAttribute("TargetMode"),
  }));
}

async function verifyPackageSafety({ pptxPath, objectManifest }) {
  const bytes = await fs.readFile(pptxPath);
  const failures = [];
  let archive;
  try {
    archive = unzipSync(new Uint8Array(bytes));
  } catch (error) {
    failures.push(failure("package-security", "zip-invalid", error.message, "pptx-package"));
    return { packageSecurity: result("pptx-package", "package-security", "failed", { message: error.message }), failures };
  }
  const names = Object.keys(archive);
  for (const required of ["[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml"]) {
    if (!names.includes(required)) failures.push(failure("package-security", "ooxml-required-part-missing", `PPTX 缺少必要部件 ${required}`, "pptx-package"));
  }
  const banned = names.filter((name) => /(?:vbaProject\.bin|^ppt\/embeddings\/|^ppt\/activeX\/|oleObject|\.exe$|\.js$)/i.test(name));
  for (const name of banned) failures.push(failure("package-security", "active-content-present", `PPTX 包含禁止的活动内容或 OLE: ${name}`, "pptx-package", { part: name }));
  const externalRelationships = [];
  for (const name of names.filter((item) => item.endsWith(".rels"))) {
    const document = new DOMParser().parseFromString(new TextDecoder().decode(archive[name]), "application/xml");
    for (const relationship of relationshipRecords(document)) {
      if (relationship.targetMode === "External") externalRelationships.push({ part: name, ...relationship });
    }
  }
  if (externalRelationships.length) {
    failures.push(failure("package-security", "external-relationship-present", "PPTX 包含未声明外部关系", "pptx-package", { externalRelationships }));
  }
  const digest = sha256BytesDigest(bytes);
  if (objectManifest.outputPptx.digest !== digest || objectManifest.outputPptx.byteLength !== bytes.length || objectManifest.outputPptx.mediaType !== PPTX_MEDIA_TYPE) {
    failures.push(failure("package-security", "output-digest-mismatch", "PPTX 输出摘要或媒体类型与 Object Manifest 不一致", "pptx-package", {
      expected: objectManifest.outputPptx,
      actual: { digest, byteLength: bytes.length, mediaType: PPTX_MEDIA_TYPE },
    }));
  }
  return {
    packageSecurity: result("pptx-package", "package-security", failures.length ? "failed" : "passed", {
      metrics: { partCount: names.length, externalRelationshipCount: externalRelationships.length, bannedPartCount: banned.length },
      ...(failures.length ? { message: "PPTX 包安全检查失败" } : { message: "PPTX 包安全检查通过" }),
    }),
    failures,
  };
}

function summarize(groups, weightedVisualScore) {
  const all = groups.flat();
  const passedChecks = all.filter((item) => item.status === "passed").length;
  const failedChecks = all.filter((item) => item.status === "failed").length;
  const skippedChecks = all.filter((item) => item.status === "skipped").length;
  return {
    totalChecks: all.length,
    passedChecks,
    failedChecks,
    skippedChecks,
    gateStatus: failedChecks ? "failed-quality-gate" : "passed",
    ...(weightedVisualScore !== undefined ? { weightedVisualScore } : {}),
  };
}

export async function verifyV2Candidate({
  sourcePackages = [],
  reconstructionSpec,
  evidenceGraph,
  resolvedScene,
  backendPlan,
  objectManifest,
  pptxPath,
  rawBlobPaths = {},
  canonicalPixelPaths = {},
  blobBasePath,
  renderedPagePaths = {},
  visualThresholds = {},
  diffDir,
  reportPath,
  verificationId,
  allowLoweredThresholds = false,
} = {}) {
  if (!backendPlan || backendPlan.contractKind !== "backend-plan") throw new TypeError("V2 verifier requires Backend Plan");
  if (!objectManifest || objectManifest.contractKind !== "object-manifest") throw new TypeError("V2 verifier requires Object Manifest");
  if ((evidenceGraph || resolvedScene) && (!reconstructionSpec || reconstructionSpec.contractKind !== "reconstruction-spec")) {
    throw new TypeError("V2 verifier requires Reconstruction Spec for evidence and scene closure");
  }
  const source = await verifySourceBinding({ sourcePackages, rawBlobPaths, canonicalPixelPaths, blobBasePath });
  const visual = await verifyVisuals({ sourcePackages, evidenceGraph, resolvedScene, renderedPagePaths, rawBlobPaths, canonicalPixelPaths, blobBasePath, visualThresholds, diffDir });
  const closure = await verifyObjectClosure({ sourcePackages, reconstructionSpec, evidenceGraph, resolvedScene, backendPlan, objectManifest, pptxPath });
  const editability = await verifyEditability({ pptxPath, objectManifest });
  const packageSafety = await verifyPackageSafety({ pptxPath, objectManifest });
  const antiCheat = verifyAntiCheat({
    sourcePackages,
    resolvedScene,
    backendPlan,
    objectManifest,
    visualThresholds,
    allowLoweredThresholds,
    sourceFailures: source.failures,
    visualFailures: visual.failures,
    protectedRegionResults: visual.protectedRegionResults,
  });
  const componentResults = componentResultsForVerification({
    sourcePackages,
    evidenceGraph,
    resolvedScene,
    backendPlan,
    objectManifest,
    pageResults: visual.pageResults,
    protectedRegionResults: visual.protectedRegionResults,
  });
  const failures = [...source.failures, ...visual.failures, ...closure.failures, ...editability.failures, ...packageSafety.failures, ...antiCheat.failures];
  const summary = summarize([
    source.sourceResults,
    visual.pageResults,
    visual.evidenceResults,
    visual.sceneNodeResults,
    componentResults,
    closure.operationResults,
    closure.objectResults,
    visual.protectedRegionResults,
    editability.editabilityResults,
    antiCheat.antiCheatResults,
    [packageSafety.packageSecurity],
  ], visual.weightedVisualScore);
  const verificationResult = {
    schemaVersion: 2,
    contractKind: "verification-result",
    verificationId: verificationId ?? `verification-${sha256Digest({ planRef: backendPlan.planId, manifestRef: objectManifest.manifestId, output: objectManifest.outputPptx.digest }).slice(7, 31)}`,
    planRef: backendPlan.planId,
    objectManifestRef: objectManifest.manifestId,
    sourcePackageRefs: sourcePackages.map((sourcePackage) => sourcePackage.sourceId),
    status: failures.length ? "failed-quality-gate" : "passed",
    sourceResults: source.sourceResults,
    pageResults: visual.pageResults,
    evidenceResults: visual.evidenceResults,
    sceneNodeResults: visual.sceneNodeResults,
    operationResults: closure.operationResults,
    objectResults: closure.objectResults,
    protectedRegionResults: visual.protectedRegionResults,
    componentResults,
    editabilityResults: editability.editabilityResults,
    antiCheatResults: antiCheat.antiCheatResults,
    packageSecurity: packageSafety.packageSecurity,
    summary: { ...summary, gateStatus: failures.length ? "failed-quality-gate" : summary.gateStatus, failedChecks: Math.max(summary.failedChecks, failures.length) },
    failures,
  };
  const validation = validateV2Contracts({ schemaVersion: 2, contracts: [...sourcePackages, reconstructionSpec, evidenceGraph, resolvedScene, backendPlan, objectManifest, verificationResult].filter(Boolean) });
  if (!validation.ok) {
    const error = new Error(`Verification Result 校验失败:\n${validation.errors.map((item) => `${item.code}: ${item.message}`).join("\n")}`);
    error.code = "V2_VERIFICATION_RESULT_INVALID";
    error.validationErrors = validation.errors;
    throw error;
  }
  if (reportPath) {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(verificationResult, null, 2)}\n`);
  }
  return verificationResult;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [contractsPath, pptxPath, reportPath] = process.argv.slice(2);
  if (!contractsPath || !pptxPath || !reportPath) {
    console.error("用法: node packages/cli/src/verify-v2-candidate.mjs <contracts.json> <candidate.pptx> <verification-result.json>");
    process.exit(2);
  }
  const bundle = JSON.parse(await fs.readFile(contractsPath, "utf8"));
  const contracts = Array.isArray(bundle.contracts) ? bundle.contracts : [bundle];
  const verification = await verifyV2Candidate({
    sourcePackages: contracts.filter((contract) => contract.contractKind === "source-package"),
    reconstructionSpec: contracts.find((contract) => contract.contractKind === "reconstruction-spec"),
    evidenceGraph: contracts.find((contract) => contract.contractKind === "evidence-graph"),
    resolvedScene: contracts.find((contract) => contract.contractKind === "resolved-scene"),
    backendPlan: contracts.find((contract) => contract.contractKind === "backend-plan"),
    objectManifest: contracts.find((contract) => contract.contractKind === "object-manifest"),
    pptxPath,
    reportPath,
  });
  if (verification.status !== "passed") process.exitCode = 1;
}
