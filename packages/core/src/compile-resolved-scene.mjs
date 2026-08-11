import { sha256Digest } from "./canonical.mjs";
import { resolveTextMetrics } from "./text-metrics-resolver.mjs";
import { validateV2Contracts } from "./validate-v2-contracts.mjs";

const IDENTITY_2D = [1, 0, 0, 1, 0, 0];
const NODE_TYPES = new Set([
  "group",
  "shape",
  "text",
  "path",
  "image",
  "icon",
  "connector",
  "table",
  "table-row",
  "table-cell",
  "list",
  "list-item",
  "chart",
  "custom-semantic",
]);

function compileError(code, message, pointer = "/") {
  const error = new Error(message);
  error.code = code;
  error.pointer = pointer;
  return error;
}

function assertAuthorContracts(sourcePackages, reconstructionSpec, evidenceGraph) {
  const result = validateV2Contracts({
    schemaVersion: 2,
    contracts: [...sourcePackages, reconstructionSpec, evidenceGraph],
  });
  if (!result.ok) {
    const first = result.errors[0];
    throw compileError(first.code, first.message, first.pointer);
  }
}

function multiply2d(left, right) {
  const [a1, b1, c1, d1, e1, f1] = left;
  const [a2, b2, c2, d2, e2, f2] = right;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

function to4x4(matrix) {
  if (matrix.kind === "perspective-3d") return matrix.matrix;
  const [a, b, c, d, e, f] = matrix.matrix;
  return [a, c, 0, e, b, d, 0, f, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiply4x4(left, right) {
  const output = Array(16).fill(0);
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      for (let index = 0; index < 4; index += 1) {
        output[row * 4 + column] += left[row * 4 + index] * right[index * 4 + column];
      }
    }
  }
  return output;
}

function composeTransforms(parent, local) {
  if (parent.kind === "affine-2d" && local.kind === "affine-2d") {
    return { kind: "affine-2d", matrix: multiply2d(parent.matrix, local.matrix) };
  }
  return { kind: "perspective-3d", matrix: multiply4x4(to4x4(parent), to4x4(local)) };
}

function placementTransform(geometry) {
  const frame = geometry.frame;
  if (!["local", "parent"].includes(frame.coordinateSpace)) return geometry.transform;
  const translation = { kind: "affine-2d", matrix: [1, 0, 0, 1, frame.x, frame.y] };
  return composeTransforms(translation, geometry.transform);
}

function transformPoint(transform, x, y) {
  if (transform.kind === "affine-2d") {
    const [a, b, c, d, e, f] = transform.matrix;
    return { x: a * x + c * y + e, y: b * x + d * y + f };
  }
  const matrix = transform.matrix;
  const tx = matrix[0] * x + matrix[1] * y + matrix[3];
  const ty = matrix[4] * x + matrix[5] * y + matrix[7];
  const tw = matrix[12] * x + matrix[13] * y + matrix[15];
  if (Math.abs(tw) < 1e-12) throw compileError("V2_SCENE_PERSPECTIVE_SINGULAR", "透视变换把可见点映射到了无穷远");
  return { x: tx / tw, y: ty / tw };
}

function worldBox(box, transform) {
  const points = [
    transformPoint(transform, box.x, box.y),
    transformPoint(transform, box.x + box.width, box.y),
    transformPoint(transform, box.x + box.width, box.y + box.height),
    transformPoint(transform, box.x, box.y + box.height),
  ];
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    unit: box.unit,
    coordinateSpace: "page",
  };
}

function resolveAppearance(parentAppearance, appearance) {
  return {
    ...structuredClone(appearance),
    opacity: (parentAppearance?.opacity ?? 1) * appearance.opacity,
  };
}

function resolveEditability(parentEditability, editability) {
  if (!parentEditability) return structuredClone(editability);
  const requiredAspects = [...new Set([
    ...parentEditability.requiredAspects,
    ...editability.requiredAspects,
  ])].sort();
  return {
    required: parentEditability.required || editability.required,
    requiredAspects,
    allowedFallbacks: [...editability.allowedFallbacks],
  };
}

function resourceDigestsIn(value, output = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => resourceDigestsIn(item, output));
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, child] of Object.entries(value)) {
    if (["resourceDigest", "blobDigest", "fontBlobDigest", "maskBlobDigest"].includes(key) && typeof child === "string") {
      output.add(child);
    } else {
      resourceDigestsIn(child, output);
    }
  }
  return output;
}

function pointerSegments(pointer) {
  if (pointer === "") return [];
  return pointer.slice(1).split("/").map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function setValueAtPointer(value, pointer, nextValue) {
  const segments = pointerSegments(pointer);
  if (!segments.length) throw compileError("V2_SCENE_PATCH_ROOT_FORBIDDEN", "optimizer patch 不能替换整个节点", pointer || "/");

  let current = value;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(current) && Number.isInteger(Number(segment)) && Number(segment) >= 0) current = current[Number(segment)];
    else if (current && typeof current === "object") current = current[segment];
    else throw compileError("V2_SCENE_PATCH_PATH_MISSING", `optimizer patch 引用未知参数: ${pointer}`, pointer);
    if (current === undefined) throw compileError("V2_SCENE_PATCH_PATH_MISSING", `optimizer patch 引用未知参数: ${pointer}`, pointer);
  }

  const leaf = segments.at(-1);
  if (Array.isArray(current) && Number.isInteger(Number(leaf)) && Number(leaf) >= 0) {
    if (current[Number(leaf)] === undefined) throw compileError("V2_SCENE_PATCH_PATH_MISSING", `optimizer patch 引用未知参数: ${pointer}`, pointer);
    current[Number(leaf)] = structuredClone(nextValue);
    return;
  }
  if (!current || typeof current !== "object" || current[leaf] === undefined) {
    throw compileError("V2_SCENE_PATCH_PATH_MISSING", `optimizer patch 引用未知参数: ${pointer}`, pointer);
  }
  current[leaf] = structuredClone(nextValue);
}

function patchProvenance(patch) {
  return Object.fromEntries(Object.entries({
    patchId: patch.patchId,
    targetNodeRef: patch.targetNodeRef,
    parameterPath: patch.parameterPath,
    oldValue: structuredClone(patch.oldValue),
    newValue: structuredClone(patch.newValue),
    evidenceRefs: patch.evidenceRefs ? [...patch.evidenceRefs].sort() : undefined,
    diagnosticRefs: [...patch.diagnosticRefs].sort(),
    iteration: patch.iteration,
    generator: patch.generator,
    risk: patch.risk,
  }).filter(([, value]) => value !== undefined));
}

function optimizerPatchesByNode(reconstructionSpec) {
  const patches = new Map();
  for (const patch of reconstructionSpec.optimizerPatches ?? []) {
    const items = patches.get(patch.targetNodeRef) ?? [];
    items.push(patch);
    patches.set(patch.targetNodeRef, items);
  }
  for (const items of patches.values()) {
    items.sort((left, right) => left.iteration - right.iteration || left.patchId.localeCompare(right.patchId));
  }
  return patches;
}

function applyOptimizerPatchOverlay(node, patchesByNode) {
  const resolvedNode = structuredClone(node);
  const applied = patchesByNode.get(node.id) ?? [];
  for (const patch of applied) {
    setValueAtPointer(resolvedNode, patch.parameterPath, patch.newValue);
  }
  return {
    node: resolvedNode,
    provenance: applied.map(patchProvenance),
  };
}

function leafPointers(value, pointer, output = []) {
  if (Array.isArray(value)) {
    if (!value.length) output.push(pointer);
    value.forEach((item, index) => leafPointers(item, `${pointer}/${index}`, output));
    return output;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) output.push(pointer);
    entries.forEach(([key, child]) => leafPointers(child, `${pointer}/${key}`, output));
    return output;
  }
  output.push(pointer);
  return output;
}

function textStrategyCandidates(node, effectiveEditability) {
  if (node.type !== "text") return [];
  const candidates = node.content.layout.mode === "positioned-clusters"
    ? ["positioned-clusters", "editable-runs"]
    : ["native-flow", "editable-runs"];
  if (!effectiveEditability.required || !effectiveEditability.requiredAspects.includes("content")) {
    candidates.push("vector-outline");
  }
  return candidates;
}

function evidenceIndex(evidenceGraph) {
  const byNode = new Map();
  const byId = new Map();
  for (const evidence of evidenceGraph.evidence) {
    byId.set(evidence.id, evidence);
    for (const subject of evidence.subjects) {
      const items = byNode.get(subject.nodeRef) ?? [];
      items.push({ evidenceRef: evidence.id, role: subject.role });
      byNode.set(subject.nodeRef, items);
    }
  }
  return { byNode, byId };
}

function canvasByPage(sourcePackages) {
  return new Map(sourcePackages.flatMap((source) => source.pages.map((page) => [page.pageId, page.canvas])));
}

function resourcesByDigest(sourcePackages, reconstructionSpec, evidenceGraph) {
  const resources = new Map();
  const conflicts = (left, right) => ["digest", "mediaType", "byteLength", "width", "height", "channels"]
    .some((key) => left[key] !== undefined && right[key] !== undefined && left[key] !== right[key]);
  const add = (blob) => {
    if (!blob?.digest) return;
    const existing = resources.get(blob.digest);
    if (existing && conflicts(existing, blob)) {
      throw compileError("V2_SCENE_RESOURCE_CONFLICT", `相同 digest 的 Blob 元数据不一致: ${blob.digest}`);
    }
    if (!existing) resources.set(blob.digest, structuredClone(blob));
  };
  for (const source of sourcePackages) {
    add(source.rawBlob);
    add(source.canonicalPixels);
    source.derivedBlobs.forEach(add);
  }
  reconstructionSpec.assetRefs?.forEach(add);
  evidenceGraph.evidence.flatMap((item) => item.provenance.evidenceBlobRefs).forEach(add);
  return resources;
}

function stableSceneId(sourcePackages, reconstructionSpec, evidenceGraph) {
  const digest = sha256Digest({
    sourcePackageRefs: sourcePackages.map((source) => source.sourceId).sort(),
    reconstructionSpec,
    evidenceGraph,
  });
  return `scene-${digest.slice("sha256:".length, "sha256:".length + 24)}`;
}

export function compileResolvedScene({
  sourcePackages,
  reconstructionSpec,
  evidenceGraph,
  sceneId,
}) {
  const sources = Array.isArray(sourcePackages) ? sourcePackages : [sourcePackages];
  assertAuthorContracts(sources, reconstructionSpec, evidenceGraph);

  const canvases = canvasByPage(sources);
  const resourceMap = resourcesByDigest(sources, reconstructionSpec, evidenceGraph);
  const evidence = evidenceIndex(evidenceGraph);
  const patchesByNode = optimizerPatchesByNode(reconstructionSpec);
  const usedResources = new Set();
  const globalSceneNodeIds = new Set();

  const pages = reconstructionSpec.pages.map((page, pageIndex) => {
    const canvas = canvases.get(page.sourcePageRef);
    if (!canvas) throw compileError("V2_SCENE_SOURCE_PAGE_MISSING", `缺少源页面画布: ${page.sourcePageRef}`);
    const nodes = [];
    const drawOrder = [];
    let nextDrawOrder = 0;

    function compileNode(authorNode, parent, nodePointer) {
      const { node, provenance } = applyOptimizerPatchOverlay(authorNode, patchesByNode);
      if (!NODE_TYPES.has(node.type)) {
        throw compileError("V2_SCENE_NODE_TYPE_UNCONSUMED", `Core 没有消费节点类型 ${node.type}`, `${nodePointer}/type`);
      }
      if (node.type === "custom-semantic" && node.content.metadataOnly !== true) {
        throw compileError("V2_SCENE_CUSTOM_METADATA_VISIBLE", `custom-semantic ${node.id} 必须明确 metadataOnly`, `${nodePointer}/content/metadataOnly`);
      }

      const sceneNodeId = `scene-node-${node.id}`;
      if (globalSceneNodeIds.has(sceneNodeId)) throw compileError("V2_SCENE_NODE_ID_DUPLICATE", `Resolved Scene node id 重复: ${sceneNodeId}`);
      globalSceneNodeIds.add(sceneNodeId);

      const worldTransform = composeTransforms(
        parent?.worldTransform ?? { kind: "affine-2d", matrix: IDENTITY_2D },
        placementTransform(node.geometry),
      );
      const effectiveAppearance = resolveAppearance(parent?.effectiveAppearance, node.appearance);
      const effectiveEditability = resolveEditability(parent?.effectiveEditability, node.editability);
      const subjectRoles = evidence.byNode.get(node.id) ?? [];
      const directEvidenceRefs = [...node.evidenceRefs].sort();
      const subjectEvidenceRefs = [...new Set(subjectRoles.map((item) => item.evidenceRef))].sort();
      const allEvidenceRefs = [...new Set([...directEvidenceRefs, ...subjectEvidenceRefs])].sort();
      for (const evidenceRef of allEvidenceRefs) {
        if (!evidence.byId.has(evidenceRef)) {
          throw compileError("V2_SCENE_EVIDENCE_REF_MISSING", `节点 ${node.id} 引用未知 Evidence: ${evidenceRef}`, `${nodePointer}/evidenceRefs`);
        }
      }

      const resourceRefs = [...resourceDigestsIn({
        geometry: node.geometry,
        appearance: node.appearance,
        content: node.content,
      })].sort();
      for (const digest of resourceRefs) {
        if (!resourceMap.has(digest)) {
          throw compileError("V2_SCENE_RESOURCE_MISSING", `节点 ${node.id} 引用未知资源: ${digest}`, nodePointer);
        }
        usedResources.add(digest);
      }

      const consumedAuthorFields = [
        ...leafPointers(node.geometry, `${nodePointer}/geometry`),
        ...leafPointers(node.appearance, `${nodePointer}/appearance`),
        ...leafPointers(node.content, `${nodePointer}/content`),
        ...leafPointers(node.editability, `${nodePointer}/editability`),
        ...leafPointers(node.evidenceRefs, `${nodePointer}/evidenceRefs`),
        ...leafPointers(node.fitConstraints ?? [], `${nodePointer}/fitConstraints`),
        ...leafPointers(node.lockedFields ?? [], `${nodePointer}/lockedFields`),
        `${nodePointer}/type`,
        `${nodePointer}/id`,
      ].sort();
      if (!consumedAuthorFields.length) {
        throw compileError("V2_SCENE_VISIBLE_FIELD_UNCONSUMED", `节点 ${node.id} 没有字段消费记录`, nodePointer);
      }
      const textMetrics = node.type === "text"
        ? resolveTextMetrics({ content: node.content, sourceNodeRef: node.id, evidenceGraph })
        : undefined;

      const resolved = {
        sceneNodeId,
        type: node.type,
        sourceNodeRefs: [node.id],
        ...(parent ? { parentSceneNodeRef: parent.sceneNodeId } : {}),
        localGeometry: structuredClone(node.geometry),
        worldTransform,
        worldBounds: Object.fromEntries(Object.entries(node.geometry.bounds).map(([key, box]) => [key, worldBox(box, worldTransform)])),
        effectiveAppearance,
        resolvedContent: structuredClone(node.content),
        effectiveEditability,
        drawOrder: nextDrawOrder,
        childSceneNodeRefs: node.children.map((child) => `scene-node-${child.id}`),
        resourceRefs,
        textStrategyCandidates: textStrategyCandidates(node, effectiveEditability),
        evidenceClosure: {
          directEvidenceRefs,
          subjectEvidenceRefs,
          allEvidenceRefs,
          subjectRoles: subjectRoles
            .map((item) => ({ ...item }))
            .sort((left, right) => `${left.evidenceRef}:${left.role}`.localeCompare(`${right.evidenceRef}:${right.role}`)),
        },
        ...(node.type === "text" ? {
          ...(node.fitConstraints?.length ? { fitConstraints: structuredClone(node.fitConstraints) } : {}),
          ...(textMetrics ? { textMetrics } : {}),
        } : {}),
        ...(provenance.length ? { patchProvenance: provenance } : {}),
        consumedAuthorFields,
      };
      nextDrawOrder += 1;
      drawOrder.push(sceneNodeId);
      nodes.push(resolved);
      node.children.forEach((child, childIndex) => compileNode(child, resolved, `${nodePointer}/children/${childIndex}`));
      return resolved;
    }

    const root = compileNode(page.rootNode, null, `/pages/${pageIndex}/rootNode`);
    return {
      pageId: page.pageId,
      sourcePageRef: page.sourcePageRef,
      canvas: structuredClone(canvas),
      rootSceneNodeRef: root.sceneNodeId,
      drawOrder,
      nodes,
    };
  });

  return {
    schemaVersion: 2,
    contractKind: "resolved-scene",
    sceneId: sceneId ?? stableSceneId(sources, reconstructionSpec, evidenceGraph),
    documentRef: reconstructionSpec.documentId,
    sourcePackageRefs: [...reconstructionSpec.sourcePackageRefs],
    resources: [...usedResources].sort().map((digest) => resourceMap.get(digest)),
    pages,
  };
}
