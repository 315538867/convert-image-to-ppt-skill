import { sha256Digest } from "@image-to-ppt/core";

function clone(value) {
  return structuredClone(value);
}

function pointerSegments(pointer) {
  if (!pointer.startsWith("/")) throw new TypeError(`Optimizer patch parameterPath 必须是 JSON Pointer: ${pointer}`);
  return pointer.slice(1).split("/").map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function valueAtPointer(value, pointer) {
  let current = value;
  for (const segment of pointerSegments(pointer)) {
    if (current === null || typeof current !== "object" || !(segment in current)) return { found: false };
    current = current[segment];
  }
  return { found: true, value: current };
}

function pointersOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function findNode(root, nodeId) {
  if (root.id === nodeId) return root;
  for (const child of root.children ?? []) {
    const found = findNode(child, nodeId);
    if (found) return found;
  }
  return undefined;
}

function authorNodeBySceneNode(resolvedScene, reconstructionSpec, sceneNodeRef) {
  const sceneNode = resolvedScene?.pages?.flatMap((page) => page.nodes).find((node) => node.sceneNodeId === sceneNodeRef);
  const sourceNodeRef = sceneNode?.sourceNodeRefs?.[0];
  if (!sourceNodeRef) return undefined;
  return reconstructionSpec.pages.flatMap((page) => [page.rootNode]).map((root) => findNode(root, sourceNodeRef)).find(Boolean);
}

function constraintFor(node, suffix) {
  return (node.fitConstraints ?? []).find((constraint) => constraint.parameterPath.endsWith(suffix));
}

function boundedValue(current, constraint, direction) {
  const step = Math.max(0.25, Math.abs(current) * 0.05);
  const candidate = current + (direction === "increase" ? step : -step);
  if (!constraint) return candidate;
  return Math.max(constraint.range.min, Math.min(constraint.range.max, candidate));
}

function textCandidate({ candidateId, targetNodeRef, parameterPath, oldValue, newValue, metricsBefore, evidenceRefs, diagnosticRefs, kind, confidence = 0.7 }) {
  return {
    candidateId,
    confidence,
    metricsBefore,
    patch: {
      targetNodeRef,
      parameterPath,
      oldValue,
      newValue,
      evidenceRefs,
      diagnosticRefs,
      generator: "text-fidelity-optimizer",
      risk: "low",
    },
    metadata: { kind },
  };
}

export function generateTextFittingCandidates({ reconstructionSpec, resolvedScene, backendPlan, componentResults = [] }) {
  const candidates = [];
  for (const component of componentResults.filter((item) => item.componentType === "text" && item.status === "failed")) {
    const sceneNodeRef = component.responsibility.sceneNodeRefs[0];
    const node = authorNodeBySceneNode(resolvedScene, reconstructionSpec, sceneNodeRef);
    const operation = backendPlan.operations.find((item) => item.sceneNodeRef === sceneNodeRef);
    const fitting = operation?.textFitting;
    const run = node?.content?.runs?.[0];
    if (!node || !run || !fitting) continue;
    const metricsBefore = component.metrics;
    const evidenceRefs = component.responsibility.evidenceRefs;
    const diagnosticRefs = [];
    const target = node.id;
    const fallback = fitting.fallbackFontFamilies?.[0];
    if (fallback && !run.style.fontFamilies.includes(fallback)) candidates.push(textCandidate({
      candidateId: `${component.componentRef}-font-fallback`, targetNodeRef: target,
      parameterPath: "/content/runs/0/style/fontFamilies", oldValue: run.style.fontFamilies,
      newValue: [fallback, ...run.style.fontFamilies], metricsBefore, evidenceRefs, diagnosticRefs, kind: "font-fallback",
    }));
    const values = [
      ["font-size", "/content/runs/0/style/fontSize/value", run.style.fontSize.value, constraintFor(node, "/fontSize/value"), fitting.fontSize?.value],
      ["tracking", "/content/runs/0/style/tracking/value", run.style.tracking.value, constraintFor(node, "/tracking/value"), fitting.tracking?.value],
      ["baseline", "/content/runs/0/style/baselineShift/value", run.style.baselineShift.value, constraintFor(node, "/baselineShift/value"), fitting.baselineShift?.value],
      ["line-height", "/content/paragraphs/0/lineSpacing/value", node.content.paragraphs[0].lineSpacing.value, constraintFor(node, "/lineSpacing"), fitting.lineHeight?.value],
    ];
    for (const [kind, parameterPath, current, constraint, planned] of values) {
      if (planned === undefined || planned === current) continue;
      const direction = planned > current ? "increase" : "decrease";
      const next = boundedValue(current, constraint, direction);
      if (next === current) continue;
      candidates.push(textCandidate({
        candidateId: `${component.componentRef}-${kind}`, targetNodeRef: target, parameterPath,
        oldValue: current, newValue: next, metricsBefore, evidenceRefs, diagnosticRefs, kind,
      }));
    }
    for (const [kind, parameterPath, current] of [["textbox-width", "/geometry/box/width", node.geometry.box.width], ["textbox-height", "/geometry/box/height", node.geometry.box.height]]) {
      const constraint = constraintFor(node, parameterPath);
      const next = boundedValue(current, constraint, "increase");
      if (next !== current) candidates.push(textCandidate({
        candidateId: `${component.componentRef}-${kind}`, targetNodeRef: target, parameterPath,
        oldValue: current, newValue: next, metricsBefore, evidenceRefs, diagnosticRefs, kind,
      }));
    }
  }
  return rankOptimizerCandidates(candidates);
}

export function generateGeometryCandidates({ reconstructionSpec, resolvedScene, componentResults = [] }) {
  const candidates = [];
  for (const component of componentResults.filter((item) => item.status === "failed" && item.componentType !== "text" && item.componentType !== "page")) {
    const sceneNodeRef = component.responsibility.sceneNodeRefs[0];
    const node = authorNodeBySceneNode(resolvedScene, reconstructionSpec, sceneNodeRef);
    if (!node?.geometry?.box) continue;
    const metrics = component.metrics;
    const evidenceRefs = component.responsibility.evidenceRefs;
    const targetNodeRef = node.id;
    const fields = [
      ["x", "/geometry/box/x"],
      ["y", "/geometry/box/y"],
      ["width", "/geometry/box/width"],
      ["height", "/geometry/box/height"],
    ];
    for (const [kind, parameterPath] of fields) {
      const current = node.geometry.box[kind];
      const metric = metrics.find((item) => item.name === `character-box-${kind}-error` || item.name === `${kind}-error`);
      if (!metric || metric.value <= (metric.threshold ?? 0)) continue;
      const direction = metric.value > 0 ? "increase" : "decrease";
      candidates.push({
        candidateId: `${component.componentRef}-geometry-${kind}`,
        confidence: 0.65,
        metricsBefore: metrics,
        metadata: { kind: `geometry-${kind}` },
        patch: { targetNodeRef, parameterPath, oldValue: current, newValue: boundedValue(current, constraintFor(node, parameterPath), direction), evidenceRefs, diagnosticRefs: [], generator: "geometry-fidelity-optimizer", risk: "low" },
      });
    }
    if (node.geometry.transform?.rotationDeg !== undefined) {
      candidates.push({
        candidateId: `${component.componentRef}-local-rotation`, confidence: 0.55, metricsBefore: metrics, metadata: { kind: "local-transform" },
        patch: { targetNodeRef, parameterPath: "/geometry/transform/rotationDeg", oldValue: node.geometry.transform.rotationDeg, newValue: node.geometry.transform.rotationDeg + 0.5, evidenceRefs, diagnosticRefs: [], generator: "geometry-fidelity-optimizer", risk: "low" },
      });
    }
    const firstStroke = node.appearance.strokes?.[0];
    if (firstStroke?.width?.value !== undefined && metrics.some((item) => item.name === "stroke-width-error" && item.value > (item.threshold ?? 0))) {
      candidates.push({
        candidateId: `${component.componentRef}-stroke-width`, confidence: 0.62, metricsBefore: metrics, metadata: { kind: "stroke-width" },
        patch: { targetNodeRef, parameterPath: "/appearance/strokes/0/width/value", oldValue: firstStroke.width.value, newValue: firstStroke.width.value + 0.25, evidenceRefs, diagnosticRefs: [], generator: "geometry-fidelity-optimizer", risk: "low" },
      });
    }
    if (node.content?.kind === "connector") {
      for (const endpoint of ["start", "end"]) {
        if (node.content[endpoint]?.kind !== "point") continue;
        candidates.push({
          candidateId: `${component.componentRef}-${endpoint}-point`, confidence: 0.58, metricsBefore: metrics, metadata: { kind: `connector-${endpoint}` },
          patch: { targetNodeRef, parameterPath: `/content/${endpoint}/point/x`, oldValue: node.content[endpoint].point.x, newValue: node.content[endpoint].point.x + 0.5, evidenceRefs, diagnosticRefs: [], generator: "geometry-fidelity-optimizer", risk: "low" },
        });
      }
    }
  }
  return rankOptimizerCandidates(candidates);
}

export function generateAppearanceCandidates({ reconstructionSpec, resolvedScene, componentResults = [] }) {
  const candidates = [];
  for (const component of componentResults.filter((item) => item.status === "failed" && ["shape", "image", "icon", "effect"].includes(item.componentType))) {
    const sceneNodeRef = component.responsibility.sceneNodeRefs[0];
    const node = authorNodeBySceneNode(resolvedScene, reconstructionSpec, sceneNodeRef);
    if (!node) continue;
    const metrics = component.metrics;
    const evidenceRefs = component.responsibility.evidenceRefs;
    const targetNodeRef = node.id;
    const add = (kind, parameterPath, oldValue, newValue, confidence = 0.6) => candidates.push({
      candidateId: `${component.componentRef}-${kind}`,
      confidence,
      metricsBefore: metrics,
      metadata: { kind },
      patch: { targetNodeRef, parameterPath, oldValue, newValue, evidenceRefs, diagnosticRefs: [], generator: "appearance-fidelity-optimizer", risk: "low" },
    });
    if (metrics.some((item) => item.name === "opacity-error" && item.value > (item.threshold ?? 0))) {
      add("opacity", "/appearance/opacity", node.appearance.opacity, Math.max(0, Math.min(1, node.appearance.opacity - 0.05)));
    }
    const fill = node.appearance.fills?.[0];
    if (fill?.color?.components?.length && metrics.some((item) => item.name === "color-delta-e" && item.value > (item.threshold ?? 0))) {
      const next = [...fill.color.components];
      next[0] = Math.max(0, Math.min(1, next[0] + 0.02));
      add("fill-color", "/appearance/fills/0/color/components", fill.color.components, next, 0.58);
    }
    const stop = fill?.gradient?.stops?.[0];
    if (stop?.position !== undefined && metrics.some((item) => item.name === "gradient-stop-count-error" && item.value > (item.threshold ?? 0))) {
      add("gradient-stop", "/appearance/fills/0/gradient/stops/0/position", stop.position, Math.max(0, Math.min(1, stop.position + 0.01)), 0.55);
    }
    const stroke = node.appearance.strokes?.[0];
    if (stroke?.color?.components?.length && metrics.some((item) => item.name === "stroke-color-error" && item.value > (item.threshold ?? 0))) {
      const next = [...stroke.color.components];
      next[0] = Math.max(0, Math.min(1, next[0] + 0.02));
      add("stroke-color", "/appearance/strokes/0/color/components", stroke.color.components, next, 0.58);
    }
    const effect = node.appearance.effects?.find((item) => ["outer-shadow", "inner-shadow", "glow"].includes(item.kind));
    if (effect) {
      if (effect.offsetX?.value !== undefined) add("shadow-offset-x", `/appearance/effects/${node.appearance.effects.indexOf(effect)}/offsetX/value`, effect.offsetX.value, effect.offsetX.value + 0.5, 0.52);
      if (effect.blurRadius?.value !== undefined) add("shadow-blur", `/appearance/effects/${node.appearance.effects.indexOf(effect)}/blurRadius/value`, effect.blurRadius.value, Math.max(0, effect.blurRadius.value - 0.5), 0.52);
    }
  }
  return rankOptimizerCandidates(candidates);
}

function firstPathPoint(content) {
  for (const [index, command] of (content.commands ?? []).entries()) {
    if (command.to?.x !== undefined) return { parameterPath: `/content/commands/${index}/to/x`, value: command.to.x };
    if (command.control?.x !== undefined) return { parameterPath: `/content/commands/${index}/control/x`, value: command.control.x };
  }
  return undefined;
}

export function generateStructureCandidates({ reconstructionSpec, resolvedScene, componentResults = [] }) {
  const candidates = [];
  for (const component of componentResults.filter((item) => item.status === "failed" && !["text", "page"].includes(item.componentType))) {
    const sceneNodeRef = component.responsibility.sceneNodeRefs[0];
    const node = authorNodeBySceneNode(resolvedScene, reconstructionSpec, sceneNodeRef);
    if (!node) continue;
    const metrics = component.metrics;
    const evidenceRefs = component.responsibility.evidenceRefs;
    const targetNodeRef = node.id;
    const add = (kind, parameterPath, oldValue, newValue, confidence = 0.58) => candidates.push({
      candidateId: `${component.componentRef}-${kind}`,
      confidence,
      metricsBefore: metrics,
      metadata: { kind },
      patch: { targetNodeRef, parameterPath, oldValue, newValue, evidenceRefs, diagnosticRefs: [], generator: "structure-fidelity-optimizer", risk: "medium" },
    });
    if (["table", "table-row", "table-cell"].includes(node.type) && node.geometry.box) {
      for (const field of ["x", "y", "width", "height"]) {
        const value = node.geometry.box[field];
        const snapped = Math.round(value);
        if (value !== snapped) add(`table-grid-snap-${field}`, `/geometry/box/${field}`, value, snapped, 0.64);
      }
    }
    if (node.type === "path") {
      const point = firstPathPoint(node.content);
      if (point && metrics.some((metric) => metric.name === "path-command-count-error" || metric.name === "path-outline-error")) {
        add("path-control-point", point.parameterPath, point.value, point.value + 0.5, 0.6);
      }
    }
    if (node.type === "connector") {
      for (const endpoint of ["start", "end"]) {
        const point = node.content?.[endpoint]?.point;
        if (!point) continue;
        add(`connector-${endpoint}-x`, `/content/${endpoint}/point/x`, point.x, point.x + 0.5, 0.62);
        add(`connector-${endpoint}-y`, `/content/${endpoint}/point/y`, point.y, point.y + 0.5, 0.62);
      }
    }
    if (node.structureCandidates?.[0]?.fallbackLimit && node.structureCandidates[0].fallbackLimit !== "editable-only"
      && metrics.some((metric) => metric.name === "expected-object-count-error" && metric.value > (metric.threshold ?? 0))) {
      add("primitive-split", "/structureCandidates/0/fallbackLimit", node.structureCandidates[0].fallbackLimit, "editable-only", 0.5);
    }
  }
  return rankOptimizerCandidates(candidates);
}

function metricScore(metrics = []) {
  return metrics.reduce((score, metric) => {
    if (metric.threshold === undefined) return score;
    if (metric.direction === "higher-is-better") return score + Math.max(0, metric.threshold - metric.value);
    if (metric.direction === "lower-is-better") return score + Math.max(0, metric.value - metric.threshold);
    return score;
  }, 0);
}

function patchId(candidate, iteration) {
  return candidate.patch.patchId ?? `patch-${sha256Digest({ candidateId: candidate.candidateId, iteration, target: candidate.patch.targetNodeRef, path: candidate.patch.parameterPath }).slice(7, 31)}`;
}

export function rankOptimizerCandidates(candidates = []) {
  return candidates
    .map((candidate) => ({
      ...clone(candidate),
      confidence: candidate.confidence ?? 0,
      componentError: metricScore(candidate.metricsBefore),
    }))
    .sort((left, right) => right.confidence - left.confidence
      || right.componentError - left.componentError
      || left.candidateId.localeCompare(right.candidateId))
    .map((candidate, index) => ({ ...candidate, rank: index, status: candidate.status ?? "proposed" }));
}

export function applyOptimizerCandidates({ reconstructionSpec, candidates = [], iteration = 0 }) {
  const output = clone(reconstructionSpec);
  const ranked = rankOptimizerCandidates(candidates);
  output.optimizerPatches ??= [];
  const appliedPatchRefs = [];
  const updates = ranked.map((candidate) => {
    const patch = candidate.patch;
    const node = output.pages.flatMap((page) => [page.rootNode]).map((root) => findNode(root, patch.targetNodeRef)).find(Boolean);
    if (!node) return { ...candidate, status: "rejected", rejectionReason: "invalid-patch", metricsAfter: candidate.metricsBefore ?? [] };
    const current = valueAtPointer(node, patch.parameterPath);
    if (!current.found || JSON.stringify(current.value) !== JSON.stringify(patch.oldValue)) {
      return { ...candidate, status: "rejected", rejectionReason: "invalid-patch", metricsAfter: candidate.metricsBefore ?? [] };
    }
    if ((node.lockedFields ?? []).some((field) => pointersOverlap(field, patch.parameterPath))) {
      return { ...candidate, status: "rejected", rejectionReason: "editability-regression", metricsAfter: candidate.metricsBefore ?? [] };
    }
    const constraint = (node.fitConstraints ?? []).find((item) => item.parameterPath === patch.parameterPath);
    if (constraint?.locked || (constraint?.forbiddenFallbacks ?? []).includes(patch.newValue)) {
      return { ...candidate, status: "rejected", rejectionReason: "editability-regression", metricsAfter: candidate.metricsBefore ?? [] };
    }
    if (typeof current.value !== typeof patch.newValue || (current.value === null) !== (patch.newValue === null)) {
      return { ...candidate, status: "rejected", rejectionReason: "invalid-patch", metricsAfter: candidate.metricsBefore ?? [] };
    }
    // 保持作者契约不变；编译器会在 Resolved Scene 上叠加 runtime patch。
    const id = patchId(candidate, iteration);
    output.optimizerPatches.push({
      patchId: id,
      targetNodeRef: patch.targetNodeRef,
      parameterPath: patch.parameterPath,
      oldValue: clone(patch.oldValue),
      newValue: clone(patch.newValue),
      evidenceRefs: [...new Set(patch.evidenceRefs ?? [])],
      diagnosticRefs: [...new Set(patch.diagnosticRefs ?? [])],
      iteration,
      generator: patch.generator ?? "fidelity-optimizer",
      risk: patch.risk ?? "low",
    });
    appliedPatchRefs.push(id);
    return { ...candidate, status: "applied", patchRef: id, metricsAfter: candidate.metricsAfter ?? [] };
  });
  return { reconstructionSpec: output, candidates: updates, appliedPatchRefs };
}

export function optimizerStopReason(verificationResult, { hasCandidates = true, iteration, maxIterations } = {}) {
  if (verificationResult?.status === "passed") return "successful-iteration";
  if (!hasCandidates) return "no-effective-candidates";
  if (iteration >= maxIterations) return "exhausted-iteration-budget";
  return "not-stopped";
}

export function createOptimizationIteration({ verificationResult, candidates, appliedPatchRefs, iteration, maxIterations }) {
  const ranked = rankOptimizerCandidates(candidates);
  const stopReason = optimizerStopReason(verificationResult, { hasCandidates: ranked.length > 0, iteration, maxIterations });
  return {
    iteration,
    inputDigest: sha256Digest({ verificationId: verificationResult?.verificationId, candidates: ranked.map((candidate) => candidate.candidateId) }),
    candidates: ranked.map((candidate) => ({
      candidateId: candidate.candidateId,
      rank: candidate.rank,
      status: candidate.status,
      ...(candidate.rejectionReason ? { rejectionReason: candidate.rejectionReason } : {}),
      metricsBefore: candidate.metricsBefore ?? [],
      metricsAfter: candidate.metricsAfter ?? [],
    })),
    appliedPatchRefs: [...new Set(appliedPatchRefs)],
    status: stopReason === "successful-iteration" ? "passed" : stopReason === "not-stopped" ? "failed" : "exhausted",
    stopReason,
    ...(verificationResult?.verificationId ? { verificationResultRef: verificationResult.verificationId } : {}),
  };
}

function componentRegression(before, after) {
  const beforeByRef = new Map((before?.componentResults ?? []).map((item) => [item.componentRef, item]));
  return (after?.componentResults ?? []).some((item) => beforeByRef.get(item.componentRef)?.status === "passed" && item.status === "failed");
}

export async function runBoundedOptimization({ initialState, maxIterations = 3, maxCandidates = 8, verify, generateCandidates, applyCandidates, regressionDetector = componentRegression }) {
  let state = initialState;
  const history = [];
  let verificationResult = await verify(state);
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (verificationResult.status === "passed") return { state, verificationResult, history, status: "passed", stopReason: "successful-iteration" };
    const proposed = rankOptimizerCandidates(await generateCandidates({ state, verificationResult }));
    const candidates = proposed.slice(0, maxCandidates);
    if (!candidates.length) {
      history.push(createOptimizationIteration({ verificationResult, candidates: [], appliedPatchRefs: [], iteration, maxIterations }));
      return { state, verificationResult, history, status: "exhausted", stopReason: "no-effective-candidates" };
    }
    const applied = await applyCandidates({ state, candidates, iteration });
    const nextVerification = await verify(applied.state);
    const regressed = regressionDetector(verificationResult, nextVerification);
    const iterationCandidates = applied.candidates.map((candidate) => ({
      ...candidate,
      status: regressed && candidate.status === "applied" ? "reverted" : candidate.status,
      ...(regressed && candidate.status === "applied" ? { rejectionReason: "component-regression" } : {}),
      metricsAfter: nextVerification.componentResults?.find((item) => item.componentRef === candidate.componentRef)?.metrics ?? candidate.metricsAfter ?? [],
    }));
    history.push(createOptimizationIteration({ verificationResult, candidates: iterationCandidates, appliedPatchRefs: regressed ? [] : applied.appliedPatchRefs, iteration, maxIterations }));
    if (regressed) return { state, verificationResult, history, status: "reverted", stopReason: "component-regression" };
    state = applied.state;
    verificationResult = nextVerification;
  }
  return { state, verificationResult, history, status: "exhausted", stopReason: "exhausted-iteration-budget" };
}
