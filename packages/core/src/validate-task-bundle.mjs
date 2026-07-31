import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { defaultSchemaPath } from "./resources.mjs";
import {
  artifactIdFor,
  artifactProjection,
  collectArtifactRefs,
} from "./canonical.mjs";
import { explicitTextIndexErrors, sliceIndexedText, textIndexLength } from "./text-index.mjs";

const BOOTSTRAP_RESOURCE_KINDS = new Set(["tool-build", "environment"]);
const FORBIDDEN_FINAL_INPUT_TYPES = new Set(["verification-plane", "semantic-equivalence-proof", "evidence-report"]);

function fail(errors, code, message, artifactId) {
  errors.push({ code, message, ...(artifactId ? { artifactId } : {}) });
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function claimPasses(claim) {
  if (claim.operator === ">=") return claim.value >= claim.threshold;
  if (claim.operator === "<=") return claim.value <= claim.threshold;
  if (claim.operator === ">") return claim.value > claim.threshold;
  if (claim.operator === "<") return claim.value < claim.threshold;
  return claim.value === claim.threshold;
}

function scopeCanReference(source, target) {
  const a = source.scope;
  const b = target.scope;
  if (a.kind === "global") return b.kind === "global";
  if (a.kind === "task-input") return b.kind === "global" || (b.kind === "task-input" && a.taskId === b.taskId);
  if (a.kind === "task-contract") {
    return b.kind === "global" || (["task-input", "task-contract"].includes(b.kind) && a.taskId === b.taskId);
  }
  if (b.kind === "global") return true;
  if (a.taskId !== b.taskId) return false;
  if (b.kind === "task") return a.contractRef === b.contractRef;
  return b.kind === "task-input" || b.kind === "task-contract";
}

function checkRanges(errors, artifact, model) {
  const indexErrors = explicitTextIndexErrors(model);
  for (const message of indexErrors) {
    fail(errors, "TEXT_INDEX_MAP_INVALID", message, artifact.artifactId);
  }
  const length = textIndexLength(model);
  const check = (items, label, requirePartition) => {
    let cursor = 0;
    for (const item of items) {
      if (item.start > item.end || item.end > length) {
        fail(errors, "TEXT_RANGE_INVALID", `${label} 范围 ${item.start}..${item.end} 超出文本长度 ${length}`, artifact.artifactId);
      }
      if (requirePartition && item.start !== cursor) {
        fail(errors, "TEXT_RANGE_GAP", `${label} 必须无缝覆盖文本，期望起点 ${cursor}，实际 ${item.start}`, artifact.artifactId);
      }
      cursor = item.end;
    }
    if (requirePartition && cursor !== length) {
      fail(errors, "TEXT_RANGE_COVERAGE", `${label} 只覆盖到 ${cursor}，文本长度为 ${length}`, artifact.artifactId);
    }
  };
  check(model.runs, "runs", true);
  check(model.paragraphs, "paragraphs", true);
  check(model.visualLines, "visualLines", true);
  check(model.hardBreakRanges, "hardBreakRanges", false);
  for (const run of model.runs) {
    if (run.glyphAdvances && run.glyphAdvances.length !== run.end - run.start) {
      fail(errors, "GLYPH_ADVANCE_COUNT", "glyphAdvances 数量必须与 run 的字符跨度一致", artifact.artifactId);
    }
  }
  if (indexErrors.length) return;
  const clusters = model.positionedClusters ?? [];
  if (model.layoutMode === "native-flow" && clusters.length) {
    fail(errors, "TEXT_POSITIONED_CLUSTER_FORBIDDEN", "native-flow 文字不能携带 positionedClusters", artifact.artifactId);
  }
  if (model.layoutMode === "positioned-clusters" && !clusters.length) {
    fail(errors, "TEXT_POSITIONED_CLUSTER_REQUIRED", "positioned-clusters 文字必须携带定位单元", artifact.artifactId);
  }
  if (model.layoutMode !== "positioned-clusters") return;

  const hardBreakIndices = new Set();
  for (const range of model.hardBreakRanges) {
    for (let index = range.start; index < range.end; index += 1) hardBreakIndices.add(index);
  }
  const clusterIds = new Set();
  let cursor = 0;
  for (const cluster of clusters) {
    while (hardBreakIndices.has(cursor)) cursor += 1;
    if (clusterIds.has(cluster.clusterId)) fail(errors, "TEXT_CLUSTER_ID_DUPLICATE", `重复 clusterId: ${cluster.clusterId}`, artifact.artifactId);
    clusterIds.add(cluster.clusterId);
    if (cluster.start !== cursor || cluster.end <= cluster.start || cluster.end > length) {
      fail(errors, "TEXT_CLUSTER_PARTITION_INVALID", `定位单元 ${cluster.clusterId} 未按顺序完整覆盖非换行 grapheme`, artifact.artifactId);
    }
    if (Array.from({ length: Math.max(0, cluster.end - cluster.start) }, (_, index) => cluster.start + index).some((index) => hardBreakIndices.has(index))) {
      fail(errors, "TEXT_CLUSTER_CONTAINS_HARD_BREAK", `定位单元 ${cluster.clusterId} 不能包含硬换行`, artifact.artifactId);
    }
    const line = model.visualLines[cluster.lineIndex];
    if (!line || cluster.start < line.start || cluster.end > line.end) {
      fail(errors, "TEXT_CLUSTER_LINE_MISMATCH", `定位单元 ${cluster.clusterId} 不在声明的视觉行范围内`, artifact.artifactId);
    }
    const run = model.runs.find((item) => item.start <= cluster.start && item.end >= cluster.end);
    const paragraph = model.paragraphs.find((item) => item.start <= cluster.start && item.end >= cluster.end);
    if (!run || !paragraph) {
      fail(errors, "TEXT_CLUSTER_STYLE_SPLIT", `定位单元 ${cluster.clusterId} 跨越了 run 或 paragraph 边界`, artifact.artifactId);
    }
    const sameSpace = line && [cluster.frame, cluster.inkBox].every((box) => box.unit === line.box.unit && box.coordinateSpace === line.box.coordinateSpace);
    if (!sameSpace) fail(errors, "TEXT_CLUSTER_COORDINATE_MISMATCH", `定位单元 ${cluster.clusterId} 与视觉行不在同一坐标空间`, artifact.artifactId);
    if (sameSpace) {
      const contains = (outer, inner) => inner.x >= outer.x && inner.y >= outer.y
        && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
      if (!contains(line.box, cluster.frame)) fail(errors, "TEXT_CLUSTER_OUTSIDE_LINE", `定位单元 ${cluster.clusterId} 超出视觉行`, artifact.artifactId);
      if (!contains(cluster.frame, cluster.inkBox)) fail(errors, "TEXT_CLUSTER_INK_OUTSIDE_FRAME", `定位单元 ${cluster.clusterId} 的 inkBox 超出 frame`, artifact.artifactId);
    }
    if (run?.glyphAdvances) {
      const advances = run.glyphAdvances.slice(cluster.start - run.start, cluster.end - run.start);
      const sameUnit = advances.every((advance) => advance.unit === cluster.advance.unit);
      const total = advances.reduce((sum, advance) => sum + advance.value, 0);
      if (!sameUnit || Math.abs(total - cluster.advance.value) > 1e-6) {
        fail(errors, "TEXT_CLUSTER_ADVANCE_MISMATCH", `定位单元 ${cluster.clusterId} 的 advance 与逐 grapheme advance 不一致`, artifact.artifactId);
      }
    }
    const clusterText = sliceIndexedText(model, cluster.start, cluster.end);
    if (cluster.paintMode === "advance-only" && (!/^\s+$/u.test(clusterText) || cluster.inkBox.width !== 0 || cluster.inkBox.height !== 0)) {
      fail(errors, "TEXT_CLUSTER_ADVANCE_ONLY_INVALID", `advance-only 定位单元 ${cluster.clusterId} 必须是无墨迹空白`, artifact.artifactId);
    }
    if (cluster.paintMode === "glyph" && (cluster.inkBox.width <= 0 || cluster.inkBox.height <= 0)) {
      fail(errors, "TEXT_CLUSTER_GLYPH_INK_MISSING", `glyph 定位单元 ${cluster.clusterId} 必须有非空 inkBox`, artifact.artifactId);
    }
    cursor = cluster.end;
  }
  while (hardBreakIndices.has(cursor)) cursor += 1;
  if (cursor !== length) fail(errors, "TEXT_CLUSTER_COVERAGE", `定位单元只覆盖到 ${cursor}，文本长度为 ${length}`, artifact.artifactId);

  for (let index = 1; index < clusters.length; index += 1) {
    const previous = clusters[index - 1];
    const current = clusters[index];
    if (previous.lineIndex !== current.lineIndex) continue;
    const paragraph = model.paragraphs.find((item) => item.start <= previous.start && item.end >= current.end);
    const direction = paragraph?.writingDirection ?? "ltr";
    if (direction === "ltr" && current.frame.x < previous.frame.x) {
      fail(errors, "TEXT_CLUSTER_DIRECTION_MISMATCH", `LTR 定位单元 ${current.clusterId} 的物理顺序反向`, artifact.artifactId);
    }
    if (direction === "rtl" && current.frame.x > previous.frame.x) {
      fail(errors, "TEXT_CLUSTER_DIRECTION_MISMATCH", `RTL 定位单元 ${current.clusterId} 的物理顺序反向`, artifact.artifactId);
    }
  }
}

function walkSemantic(node, visit) {
  visit(node);
  node.children.forEach((child) => walkSemantic(child, visit));
}

function sameBoxSpace(left, right) {
  return left.unit === right.unit && left.coordinateSpace === right.coordinateSpace;
}

function containsBox(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

function intersectsBox(left, right) {
  return left.x < right.x + right.width && left.x + left.width > right.x
    && left.y < right.y + right.height && left.y + left.height > right.y;
}

function borderInnerWidth(border) {
  if (border.style === "none" || border.width.value <= 0 || border.color.alpha <= 0) return 0;
  if (border.alignment === "inside") return border.width.value;
  if (border.alignment === "center") return border.width.value / 2;
  return 0;
}

function contentBox(node) {
  const style = node.computedStyle;
  const box = node.box;
  const left = borderInnerWidth(style.borders.left) + style.padding.left.value;
  const right = borderInnerWidth(style.borders.right) + style.padding.right.value;
  const top = borderInnerWidth(style.borders.top) + style.padding.top.value;
  const bottom = borderInnerWidth(style.borders.bottom) + style.padding.bottom.value;
  return {
    ...box,
    x: box.x + left,
    y: box.y + top,
    width: Math.max(0, box.width - left - right),
    height: Math.max(0, box.height - top - bottom),
  };
}

function clearanceBox(text) {
  const ink = text.inkBox;
  const clearance = text.boundaryPolicy.minimumClearance;
  return {
    ...ink,
    x: ink.x - clearance.left.value,
    y: ink.y - clearance.top.value,
    width: ink.width + clearance.left.value + clearance.right.value,
    height: ink.height + clearance.top.value + clearance.bottom.value,
  };
}

function checkSemanticGeometry(errors, artifact, slide, observations) {
  const edgeObservations = observations.filter((item) => item.pageId === slide.slideId && item.kind === "edge");
  function visit(node, ancestors) {
    if (node.kind === "text") {
      const ink = node.text.inkBox;
      const clearance = node.text.boundaryPolicy.minimumClearance;
      const lengths = Object.values(clearance);
      if (!sameBoxSpace(node.box, ink) || lengths.some((item) => item.unit !== ink.unit)) {
        fail(errors, "TEXT_INK_COORDINATE_MISMATCH", `文字节点 ${node.nodeId} 的 inkBox、minimumClearance 与节点 box 必须使用同一坐标和单位`, artifact.artifactId);
      } else {
        const protectedInk = clearanceBox(node.text);
        if (!containsBox(contentBox(node), protectedInk)) {
          fail(errors, "TEXT_INK_OUTSIDE_FRAME", `文字节点 ${node.nodeId} 的墨迹和最小留白侵入自身边框、内边距或超出文本框`, artifact.artifactId);
        }
        for (const ancestor of ancestors) {
          if (!sameBoxSpace(ancestor.box, protectedInk)) {
            fail(errors, "TEXT_PARENT_COORDINATE_MISMATCH", `文字节点 ${node.nodeId} 与父容器 ${ancestor.nodeId} 坐标空间不一致`, artifact.artifactId);
            continue;
          }
          const inner = contentBox(ancestor);
          if (!containsBox(inner, protectedInk)) {
            fail(errors, "TEXT_PARENT_CONTENT_OVERFLOW", `文字节点 ${node.nodeId} 的墨迹侵入父容器 ${ancestor.nodeId} 的边框或内边距`, artifact.artifactId);
          }
        }
        const allowed = new Set(node.text.boundaryPolicy.allowOverlapObservationRefs);
        for (const edge of edgeObservations) {
          if (!allowed.has(edge.observationId) && sameBoxSpace(edge.box, protectedInk) && intersectsBox(edge.box, protectedInk)) {
            fail(errors, "TEXT_EDGE_OVERLAP", `文字节点 ${node.nodeId} 的墨迹与边框证据 ${edge.observationId} 重叠`, artifact.artifactId);
          }
        }
      }
    }
    node.children.forEach((child) => visit(child, [...ancestors, node]));
  }
  visit(slide.root, []);
}

function walkRender(node, visit) {
  visit(node);
  (node.children ?? []).forEach((child) => walkRender(child, visit));
}

function checkPageClosure(errors, artifacts) {
  const source = artifacts.find((artifact) => artifact.artifactType === "source-plane");
  const observation = artifacts.find((artifact) => artifact.artifactType === "observation-plane");
  const ownership = artifacts.find((artifact) => artifact.artifactType === "ownership-plane");
  const semantic = artifacts.find((artifact) => artifact.artifactType === "semantic-plane");
  const render = artifacts.find((artifact) => artifact.artifactType === "render-plane");
  if (!source || !observation || !ownership || !semantic || !render) return;
  const sourcePageIds = source.body.pages.map((page) => page.pageId);
  if (new Set(sourcePageIds).size !== sourcePageIds.length) fail(errors, "SOURCE_PAGE_DUPLICATE", "Source Plane 的 pageId 必须唯一", source.artifactId);
  const semanticPageIds = semantic.body.slides.map((slide) => slide.slideId);
  const renderPageIds = render.body.slides.map((slide) => slide.slideId);
  if (!sameArray([...semanticPageIds].sort(), [...sourcePageIds].sort())) fail(errors, "SEMANTIC_PAGE_CLOSURE", "Semantic Plane slides 必须精确覆盖 Source Plane pages", semantic.artifactId);
  if (!sameArray([...renderPageIds].sort(), [...semanticPageIds].sort())) fail(errors, "RENDER_PAGE_CLOSURE", "Render Plane slides 必须精确覆盖 Semantic Plane slides", render.artifactId);

  const observationById = new Map();
  for (const item of observation.body.observations) {
    if (observationById.has(item.observationId)) fail(errors, "OBSERVATION_DUPLICATE", `重复 observationId: ${item.observationId}`, observation.artifactId);
    observationById.set(item.observationId, item);
    if (!sourcePageIds.includes(item.pageId)) fail(errors, "OBSERVATION_PAGE_UNKNOWN", `Observation ${item.observationId} 引用了未知 pageId`, observation.artifactId);
  }
  const nodePage = new Map();
  for (const slide of semantic.body.slides) walkSemantic(slide.root, (node) => nodePage.set(node.nodeId, slide.slideId));
  const assignmentCounts = new Map();
  for (const assignment of ownership.body.assignments) {
    assignmentCounts.set(assignment.observationId, (assignmentCounts.get(assignment.observationId) ?? 0) + 1);
    const observed = observationById.get(assignment.observationId);
    if (!observed) fail(errors, "OWNERSHIP_OBSERVATION_UNKNOWN", `Ownership 引用了未知 observation ${assignment.observationId}`, ownership.artifactId);
    if (observed && observed.pageId !== assignment.pageId) fail(errors, "OWNERSHIP_PAGE_MISMATCH", `Ownership ${assignment.observationId} 的 pageId 与 Observation 不一致`, ownership.artifactId);
    if (nodePage.get(assignment.ownerNodeId) !== assignment.pageId) fail(errors, "OWNERSHIP_NODE_PAGE_MISMATCH", `Ownership ${assignment.observationId} 的 ownerNode 不在同一页`, ownership.artifactId);
    if (assignment.responsibility !== 1) fail(errors, "OWNERSHIP_RESPONSIBILITY_NOT_TOTAL", `Ownership ${assignment.observationId} 的责任必须精确为 1`, ownership.artifactId);
  }
  for (const observationId of observationById.keys()) {
    if (assignmentCounts.get(observationId) !== 1) {
      fail(errors, "OWNERSHIP_CARDINALITY", `Observation ${observationId} 必须恰好有一个 Ownership assignment`, ownership.artifactId);
    }
  }
  const responsibilityCoverage = observationById.size === 0
    ? 1
    : [...observationById.keys()].filter((id) => assignmentCounts.get(id) === 1).length / observationById.size;
  if (ownership.body.coverage.objectResponsibility !== responsibilityCoverage) {
    fail(errors, "OWNERSHIP_COVERAGE_MISMATCH", `objectResponsibility 应为 ${responsibilityCoverage}`, ownership.artifactId);
  }
}

function checkSemanticAndRender(errors, artifacts) {
  checkPageClosure(errors, artifacts);
  const observations = artifacts.find((artifact) => artifact.artifactType === "observation-plane")?.body.observations ?? [];
  for (const artifact of artifacts) {
    if (artifact.artifactType === "semantic-plane") {
      const ids = new Set();
      for (const slide of artifact.body.slides) {
        checkSemanticGeometry(errors, artifact, slide, observations);
        const paintOrders = new Set();
        walkSemantic(slide.root, (node) => {
          if (ids.has(node.nodeId)) fail(errors, "SEMANTIC_NODE_DUPLICATE", `重复 nodeId: ${node.nodeId}`, artifact.artifactId);
          ids.add(node.nodeId);
          if (paintOrders.has(node.paintOrder)) fail(errors, "SEMANTIC_PAINT_ORDER_DUPLICATE", `slide ${slide.slideId} 重复 paintOrder: ${node.paintOrder}`, artifact.artifactId);
          paintOrders.add(node.paintOrder);
          if (node.kind === "text") checkRanges(errors, artifact, node.text);
        });
      }
    }
    if (artifact.artifactType === "render-plane") {
      const allPrimitiveIds = new Set();
      for (const slide of artifact.body.slides) {
        const primitiveIds = [];
        const visiblePrimitiveIds = [];
        const sourceCoverage = new Map();
        walkRender(slide.renderRoot, (primitive) => {
          primitiveIds.push(primitive.primitiveId);
          if (primitive.kind !== "group") visiblePrimitiveIds.push(primitive.primitiveId);
          if (allPrimitiveIds.has(primitive.primitiveId)) fail(errors, "RENDER_PRIMITIVE_DUPLICATE", `render primitiveId 必须跨 slide 全局唯一: ${primitive.primitiveId}`, artifact.artifactId);
          allPrimitiveIds.add(primitive.primitiveId);
          for (const nodeId of primitive.sourceNodeRefs) sourceCoverage.set(nodeId, (sourceCoverage.get(nodeId) ?? 0) + 1);
          if (primitive.kind === "text") checkRanges(errors, artifact, primitive.text);
        });
        if (!sameArray(slide.globalPaintOrder, visiblePrimitiveIds)) {
          fail(errors, "GLOBAL_PAINT_ORDER_MISMATCH", `slide ${slide.slideId} 的 globalPaintOrder 必须精确等于可见原语的前序序列`, artifact.artifactId);
        }
        for (const entry of slide.editabilityMap) {
          if (!entry.primitiveIds.every((id) => primitiveIds.includes(id))) fail(errors, "EDITABILITY_UNKNOWN_PRIMITIVE", `slide ${slide.slideId} 节点 ${entry.nodeId} 引用了不存在的 primitive`, artifact.artifactId);
          if (!sourceCoverage.has(entry.nodeId)) fail(errors, "EDITABILITY_UNBOUND_NODE", `slide ${slide.slideId} 节点 ${entry.nodeId} 没有对应渲染原语`, artifact.artifactId);
        }
        for (const fallback of slide.fallbacks) {
          if (fallback.strategy === "raster" && !fallback.approved) {
            fail(errors, "UNAPPROVED_RASTER_FALLBACK", `节点 ${fallback.nodeId} 的位图降级未获批准`, artifact.artifactId);
          }
        }
      }
    }
  }
}

function checkDAG(errors, byId, rootArtifactId) {
  const state = new Map();
  const reachable = new Set();
  const stack = [];

  function visit(id) {
    const mark = state.get(id);
    if (mark === "done") return;
    if (mark === "active") {
      fail(errors, "ARTIFACT_CYCLE", `Artifact DAG 存在环: ${[...stack, id].join(" -> ")}`, id);
      return;
    }
    state.set(id, "active");
    stack.push(id);
    reachable.add(id);
    const artifact = byId.get(id);
    if (artifact) artifact.inputs.forEach(visit);
    stack.pop();
    state.set(id, "done");
  }

  visit(rootArtifactId);
  for (const id of byId.keys()) {
    if (!reachable.has(id)) fail(errors, "UNREACHABLE_ARTIFACT", "Artifact 不在最终任务清单的依赖闭包中", id);
  }
}

function checkArchitectureSemantics(errors, bundle, byId, schema) {
  const roots = bundle.artifacts.filter((artifact) => artifact.artifactType === "final-task-manifest");
  if (roots.length !== 1 || roots[0]?.artifactId !== bundle.rootArtifactId) {
    fail(errors, "FINAL_ROOT_CARDINALITY", "rootArtifactId 必须指向任务束中唯一的 Final Task Manifest");
  }

  for (const artifact of bundle.artifacts) {
    const expectedId = artifactIdFor(artifactProjection(artifact));
    if (expectedId !== artifact.artifactId) {
      fail(errors, "ARTIFACT_ID_MISMATCH", `ArtifactId 应为 ${expectedId}`, artifact.artifactId);
    }
    const expectedInputs = collectArtifactRefs(artifact, schema);
    if (!sameArray(artifact.inputs, expectedInputs)) {
      fail(errors, "INPUT_CLOSURE_MISMATCH", `inputs 应精确为 [${expectedInputs.join(", ")}]`, artifact.artifactId);
    }
    if (!sameArray(artifact.inputs, [...artifact.inputs].sort())) {
      fail(errors, "INPUTS_NOT_SORTED", "inputs 必须按字典序排列", artifact.artifactId);
    }
    for (const inputId of artifact.inputs) {
      const input = byId.get(inputId);
      if (!input) {
        fail(errors, "INPUT_MISSING", `缺少输入 Artifact ${inputId}`, artifact.artifactId);
      } else if (!scopeCanReference(artifact, input)) {
        fail(errors, "SCOPE_VIOLATION", `作用域 ${artifact.scope.kind} 不能引用 ${input.scope.kind}`, artifact.artifactId);
      }
    }

    const createdByBootstrap = artifact.createdBy.kind === "system-bootstrap";
    const bootstrapAllowed = artifact.artifactType === "core-safety-profile"
      || (artifact.artifactType === "resource" && artifact.scope.kind === "global" && BOOTSTRAP_RESOURCE_KINDS.has(artifact.body.resourceKind));
    if (createdByBootstrap !== bootstrapAllowed) {
      fail(errors, "CREATED_BY_BOOTSTRAP_RULE", "system-bootstrap 只能创建核心安全配置及全局 tool/environment 资源，其他 Artifact 必须有工具与环境来源", artifact.artifactId);
    }
    if (artifact.createdBy.kind === "artifact-provenance") {
      const tool = byId.get(artifact.createdBy.toolBuildRef);
      const environment = byId.get(artifact.createdBy.environmentRef);
      if (tool?.artifactType !== "resource" || tool.body.resourceKind !== "tool-build") {
        fail(errors, "TOOL_BUILD_REF_INVALID", "toolBuildRef 必须指向 tool-build Resource", artifact.artifactId);
      }
      if (environment?.artifactType !== "resource" || environment.body.resourceKind !== "environment") {
        fail(errors, "ENVIRONMENT_REF_INVALID", "environmentRef 必须指向 environment Resource", artifact.artifactId);
      }
    }

    if (artifact.scope.kind === "global" && !["core-safety-profile", "policy", "capability-manifest", "resource"].includes(artifact.artifactType)) {
      fail(errors, "GLOBAL_TYPE_FORBIDDEN", `${artifact.artifactType} 不允许使用 global scope`, artifact.artifactId);
    }
    if (artifact.artifactType === "conversion-contract" && artifact.scope.kind !== "task-contract") {
      fail(errors, "CONTRACT_SCOPE_INVALID", "Conversion Contract 必须使用 task-contract scope", artifact.artifactId);
    }
    if (artifact.artifactType === "resource" && artifact.body.resourceKind === "source-input" && artifact.scope.kind !== "task-input") {
      fail(errors, "SOURCE_SCOPE_INVALID", "source-input Resource 必须使用 task-input scope", artifact.artifactId);
    }
    if (FORBIDDEN_FINAL_INPUT_TYPES.has(artifact.artifactType)) {
      const finalRef = artifact.inputs.find((id) => byId.get(id)?.artifactType === "final-task-manifest");
      if (finalRef) fail(errors, "TEMPORAL_FINAL_CYCLE", "验证、证据和证明 Artifact 不得引用 Final Task Manifest", artifact.artifactId);
    }
  }

  const contracts = bundle.artifacts.filter((artifact) => artifact.artifactType === "conversion-contract");
  if (contracts.length !== 1) fail(errors, "CONTRACT_CARDINALITY", "任务束必须恰好包含一个 Conversion Contract");
  const contract = contracts[0];
  if (contract) {
    const contractBody = contract.body;
    const safety = byId.get(contractBody.coreSafetyProfileRef);
    if (safety?.artifactType !== "core-safety-profile") {
      fail(errors, "CONTRACT_SAFETY_TYPE", "coreSafetyProfileRef 必须指向 core-safety-profile Artifact", contract.artifactId);
    } else if (safety.body.networkPolicy !== "deny" || safety.body.undeclaredDependencyPolicy !== "deny" || safety.body.activeContentPolicy !== "deny") {
      fail(errors, "SAFETY_PROFILE_WEAK", "Core Safety Profile 的强制拒绝策略不能被放宽", safety.artifactId);
    }
    for (const policyRef of contractBody.policyRefs) {
      const policy = byId.get(policyRef);
      if (policy?.artifactType !== "policy") fail(errors, "CONTRACT_POLICY_TYPE", "policyRefs 必须全部指向 policy Artifact", contract.artifactId);
      if (policy?.body.macrosAllowed || policy?.body.oleAllowed || policy?.body.externalRelationshipsAllowed) {
        fail(errors, "POLICY_PACKAGE_WEAK", "Policy 不得放宽宏、OLE 或外部关系禁用策略", policy.artifactId);
      }
    }
    for (const capabilityRef of contractBody.capabilityManifestRefs) {
      const capability = byId.get(capabilityRef);
      if (capability?.artifactType !== "capability-manifest") fail(errors, "CONTRACT_CAPABILITY_TYPE", "capabilityManifestRefs 必须全部指向 capability-manifest Artifact", contract.artifactId);
      if (capability && (!capability.body.customAdapterIndependent || !capability.body.deterministicBuild)) {
        fail(errors, "CAPABILITY_NOT_DETERMINISTIC", "Capability Manifest 必须声明 custom adapter 独立且构建确定", capability.artifactId);
      }
      if (capability?.artifactType === "capability-manifest") {
        const metrics = capability.body.textMetricCapabilities;
        const textAcceptance = contractBody.acceptance?.text ?? {};
        if (textAcceptance.preserveHardBreaks && metrics["hard-breaks"] === "unsupported") {
          fail(errors, "CAPABILITY_TEXT_METRIC_MISSING", "契约要求保留硬换行，但 Capability Manifest 未提供硬换行能力", capability.artifactId);
        }
        if (textAcceptance.preserveRunColors && (metrics.color === "unsupported" || metrics.alpha === "unsupported")) {
          fail(errors, "CAPABILITY_TEXT_METRIC_MISSING", "契约要求保留文字颜色，但 Capability Manifest 未提供颜色能力", capability.artifactId);
        }
        if (textAcceptance.preserveGlyphMetrics
          && ["letter-spacing", "kerning", "baseline-shift", "glyph-advances"].some((metric) => metrics[metric] === "unsupported")) {
          fail(errors, "CAPABILITY_TEXT_METRIC_MISSING", "契约要求保留文字度量，但 Capability Manifest 的度量能力不完整", capability.artifactId);
        }
      }
    }
    const capabilities = contractBody.capabilityManifestRefs.map((ref) => byId.get(ref)).filter((item) => item?.artifactType === "capability-manifest");
    const supportsSemantic = (kind) => capabilities.some((item) => item.body.supportedSemanticNodes.includes(kind));
    const supportsPrimitive = (kind) => capabilities.some((item) => item.body.supportedRenderPrimitives.includes(kind));
    const supportsGeometry = (name) => capabilities.some((item) => item.body.geometryCapabilities[name] !== "unsupported");
    const supportsPaint = (name) => capabilities.some((item) => item.body.paintCapabilities[name] !== "unsupported");
    const rasterFallbackAllowed = contractBody.policyRefs.some((ref) => byId.get(ref)?.body.rasterFallbackAllowed === true);
    const simpleIconMustBeEditable = contractBody.policyRefs.some((ref) => byId.get(ref)?.body.simpleIconMustBeEditable === true);
    const checkFillCapability = (style, subject, artifactId) => {
      if (style.fill.kind === "none") return;
      const capabilityName = style.fill.kind === "solid"
        ? "solid-fill"
        : style.fill.gradientType === "linear"
          ? "linear-gradient-fill"
          : "radial-gradient-fill";
      if (!supportsPaint(capabilityName)) {
        fail(errors, "CAPABILITY_PAINT_UNSUPPORTED", `${subject} 的填充能力 ${capabilityName} 不受支持`, artifactId);
      }
    };
    for (const plane of bundle.artifacts.filter((item) => item.artifactType === "semantic-plane")) {
      for (const slide of plane.body.slides) walkSemantic(slide.root, (node) => {
        if (!supportsSemantic(node.kind)) fail(errors, "CAPABILITY_SEMANTIC_NODE_UNSUPPORTED", `Semantic 节点 ${node.kind} 未被 Capability Manifest 支持`, plane.artifactId);
        checkFillCapability(node.computedStyle, `Semantic 节点 ${node.nodeId}`, plane.artifactId);
        if (node.kind === "icon" && node.sourceBlobDigest && simpleIconMustBeEditable) {
          fail(errors, "RASTER_SIMPLE_ICON_FORBIDDEN", `Icon 节点 ${node.nodeId} 使用位图裁切，违反 simpleIconMustBeEditable；应以 path/group 子节点表达`, plane.artifactId);
        }
        if (["image", "icon"].includes(node.kind) && node.sourceBlobDigest) {
          const usage = node.imageUsage;
          if (!rasterFallbackAllowed && (usage.textRemoved || usage.derivation === "source-derived-composite" || usage.contentKind === "source-derived-composite")) {
            fail(errors, "SOURCE_DERIVED_COMPOSITE_FORBIDDEN", `位图节点 ${node.nodeId} 是擦字或拼接后的源图复合层，不能代替背景、边框和图形重建`, plane.artifactId);
          }
          const pageArea = slide.root.box.width * slide.root.box.height;
          const imageArea = node.box.width * node.box.height;
          const hasEditableText = (() => {
            let found = false;
            walkSemantic(slide.root, (candidate) => { if (candidate.kind === "text") found = true; });
            return found;
          })();
          const allowedBackdrop = ["photograph", "texture", "complex-illustration"].includes(usage.contentKind)
            && usage.derivation !== "source-derived-composite" && !usage.textRemoved;
          if (!rasterFallbackAllowed && hasEditableText && pageArea > 0 && imageArea / pageArea >= 0.8 && !allowedBackdrop) {
            fail(errors, "PAGE_RASTER_PROXY_FORBIDDEN", `大面积位图节点 ${node.nodeId} 不能代理可编辑文字之外的整页视觉结构`, plane.artifactId);
          }
        }
        if (node.kind === "connector") {
          const connectorCapability = node.connector.routing === "straight" ? "connector-straight" : "connector-routed";
          if (!supportsGeometry(connectorCapability)) {
            fail(errors, "CAPABILITY_CONNECTOR_UNSUPPORTED", `Semantic connector ${node.nodeId} 的 ${node.connector.routing} 路由不受支持`, plane.artifactId);
          }
          if ((node.connector.startArrow.kind !== "none" || node.connector.endArrow.kind !== "none")
            && !supportsGeometry("arrow-canonical-path")) {
            fail(errors, "CAPABILITY_ARROW_UNSUPPORTED", `Semantic connector ${node.nodeId} 的 canonical 箭头不受支持`, plane.artifactId);
          }
        }
        if (["group", "shape", "box", "custom", "table", "table-row", "table-cell", "list", "list-item", "text", "image", "icon"].includes(node.kind)) {
          const borders = Object.values(node.computedStyle.borders);
          const visible = borders.filter((border) => border.style !== "none" && border.width.value > 0 && border.color.alpha > 0);
          const first = borders[0];
          const needsLowering = visible.length > 0 && (!borders.every((border) => border.style === first.style
            && border.width.value === first.width.value
            && border.width.unit === first.width.unit
            && border.alignment === first.alignment
            && JSON.stringify(border.color) === JSON.stringify(first.color))
            || first.alignment !== "center");
          if (needsLowering) {
            const hasPattern = visible.some((border) => border.style !== "solid");
            const hasRadius = Object.values(node.computedStyle.cornerRadii).some((radius) => radius.value !== 0);
            const borderCapability = hasPattern
              ? "path-per-edge-pattern-border"
              : hasRadius
                ? "path-rounded-per-edge-border"
                : "path-per-edge-solid-border";
            if (!supportsGeometry(borderCapability)) {
              fail(errors, "CAPABILITY_PER_EDGE_BORDER_UNSUPPORTED", `Semantic 节点 ${node.nodeId} 的逐边边框能力 ${borderCapability} 不受支持`, plane.artifactId);
            }
          }
        }
      });
    }
    for (const plane of bundle.artifacts.filter((item) => item.artifactType === "render-plane")) {
      for (const slide of plane.body.slides) walkRender(slide.renderRoot, (primitive) => {
        if (!supportsPrimitive(primitive.kind)) fail(errors, "CAPABILITY_RENDER_PRIMITIVE_UNSUPPORTED", `Render 原语 ${primitive.kind} 未被 Capability Manifest 支持`, plane.artifactId);
        checkFillCapability(primitive.style, `Render 原语 ${primitive.primitiveId}`, plane.artifactId);
        if (primitive.kind === "path" || primitive.kind === "connector") {
          const path = primitive.kind === "path" ? primitive.path : primitive.connector.path;
          if (path.fillRule === "evenodd" && !supportsGeometry("path-evenodd")) {
            fail(errors, "CAPABILITY_PATH_EVENODD_UNSUPPORTED", `path ${primitive.primitiveId} 使用后端不支持的 evenodd fillRule`, plane.artifactId);
          }
          for (const command of path.commands) {
            const capabilityName = command.kind === "cubicTo"
              ? "path-cubic"
              : command.kind === "arcTo" && command.rotation === 0
                ? "path-axis-aligned-arc"
                : command.kind === "arcTo"
                  ? "path-rotated-arc"
                  : null;
            if (capabilityName && !supportsGeometry(capabilityName)) {
              fail(errors, "CAPABILITY_PATH_CURVE_UNSUPPORTED", `path ${primitive.primitiveId} 的 ${command.kind} 命令不受支持`, plane.artifactId);
            }
          }
        }
        if (primitive.kind === "connector") {
          const capabilityName = primitive.connector.routing === "straight" ? "connector-straight" : "connector-routed";
          if (!supportsGeometry(capabilityName)) fail(errors, "CAPABILITY_CONNECTOR_UNSUPPORTED", `connector ${primitive.primitiveId} 的 ${primitive.connector.routing} 路由不受支持`, plane.artifactId);
          if ((primitive.connector.startArrow.kind !== "none" || primitive.connector.endArrow.kind !== "none") && !supportsGeometry("arrow-canonical-path")) {
            fail(errors, "CAPABILITY_ARROW_UNSUPPORTED", `connector ${primitive.primitiveId} 的箭头尺寸无法精确表达`, plane.artifactId);
          }
        }
      });
    }
    const expectedSources = bundle.artifacts
      .filter((artifact) => artifact.artifactType === "resource" && artifact.body.resourceKind === "source-input")
      .map((artifact) => artifact.artifactId)
      .sort();
    if (!sameArray([...(contractBody.sourceInputRefs ?? [])].sort(), expectedSources)) {
      fail(errors, "CONTRACT_SOURCE_CLOSURE", "Conversion Contract 必须精确绑定所有 source-input Artifact", contract.artifactId);
    }
    for (const artifact of bundle.artifacts.filter((item) => item.scope.kind === "task")) {
      if (artifact.scope.contractRef !== contract.artifactId) {
        fail(errors, "TASK_CONTRACT_MISMATCH", "任务 Artifact 必须绑定唯一 Conversion Contract", artifact.artifactId);
      }
    }
    const ownership = bundle.artifacts.find((artifact) => artifact.artifactType === "ownership-plane");
    if (ownership && bundle.bundlePhase === "final") {
      const thresholds = contractBody.acceptance?.coverage;
      if (thresholds && (ownership.body.coverage.sourcePixelCoverage < thresholds.sourcePixelCoverage
        || ownership.body.coverage.sourceEdgeCoverage < thresholds.sourceEdgeCoverage
        || ownership.body.coverage.objectResponsibility < thresholds.objectResponsibility)) {
        fail(errors, "COVERAGE_BELOW_CONTRACT", "Ownership Plane 覆盖率低于 Conversion Contract", ownership.artifactId);
      }
    }
  }

  const final = roots[0];
  if (final && bundle.bundlePhase === "final") {
    const verification = byId.get(final.body.verificationPlaneRef);
    const terminal = byId.get(final.body.taskTerminalDecisionRef);
    const candidate = byId.get(final.body.selectedCandidateRef);
    const selection = byId.get(final.body.selectionDecisionRef);
    if (verification?.body.verificationStatus !== "verified") fail(errors, "FINAL_NOT_VERIFIED", "Final Manifest 只能引用 verified 的 Verification Plane", final.artifactId);
    if (verification?.body.verificationStatus === "verified") {
      for (const reportRef of verification.body.evidenceReportRefs) {
        const report = byId.get(reportRef);
        if (report?.artifactType !== "evidence-report") {
          fail(errors, "VERIFICATION_EVIDENCE_TYPE", "Verification Plane 只能引用 evidence-report", verification.artifactId);
          continue;
        }
        for (const claim of report.body.claims) {
          if (!claimPasses(claim)) fail(errors, "VERIFICATION_CLAIM_FAILED", `Evidence Claim ${claim.claimId} 未达到阈值`, report.artifactId);
        }
      }
      for (const proofRef of verification.body.proofRefs) {
        const proof = byId.get(proofRef);
        if (proof?.artifactType !== "semantic-equivalence-proof" || proof.body.status !== "proved") {
          fail(errors, "VERIFICATION_PROOF_FAILED", "Verification Plane 引用的 Proof 必须为 proved", verification.artifactId);
        }
      }
    }
    if (terminal?.body.status !== "success") fail(errors, "FINAL_TERMINAL_NOT_SUCCESS", "Final Manifest 只能引用 success 的终态决定", final.artifactId);
    if (selection?.body.status !== "selected") fail(errors, "FINAL_CANDIDATE_NOT_SELECTED", "Final Manifest 只能引用 selected 的候选选择决定", final.artifactId);
    if (candidate?.body.pptxBlob.blobDigest !== final.body.outputPptxBlobDigest
      || candidate?.body.previewBlob.blobDigest !== final.body.previewBlobDigest) {
      fail(errors, "FINAL_BLOB_BINDING_MISMATCH", "Final Manifest 输出摘要必须与选中候选一致", final.artifactId);
    }
  }
  if (final && bundle.bundlePhase === "authoring") {
    const verification = byId.get(final.body.verificationPlaneRef);
    const terminal = byId.get(final.body.taskTerminalDecisionRef);
    const selection = byId.get(final.body.selectionDecisionRef);
    if (verification?.body.verificationStatus !== "pending") {
      fail(errors, "AUTHORING_VERIFICATION_NOT_PENDING", "authoring 任务束的验证状态必须为 pending", verification?.artifactId);
    }
    if (terminal?.body.status !== "pending-verification") {
      fail(errors, "AUTHORING_TERMINAL_NOT_PENDING", "authoring 任务束的终态必须为 pending-verification", terminal?.artifactId);
    }
    if (selection?.body.status !== "pending") {
      fail(errors, "AUTHORING_SELECTION_NOT_PENDING", "authoring 任务束的选择状态必须为 pending", selection?.artifactId);
    }
    for (const reportRef of final.body.evidenceReportRefs) {
      const report = byId.get(reportRef);
      if (report?.artifactType === "evidence-report" && report.body.claims.some((claim) => claim.value !== 0)) {
        fail(errors, "AUTHORING_EVIDENCE_NONZERO", "authoring 任务束不能携带非零的测量证据", report.artifactId);
      }
    }
    for (const proofRef of final.body.proofRefs) {
      const proof = byId.get(proofRef);
      if (proof?.artifactType === "semantic-equivalence-proof" && proof.body.status !== "pending") {
        fail(errors, "AUTHORING_PROOF_NOT_PENDING", "authoring 任务束的证明状态必须为 pending", proof.artifactId);
      }
    }
  }
}

export function validateTaskBundle(bundle, schema) {
  const errors = [];
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, formats: { "date-time": true } });
  ajv.addKeyword({ keyword: "x-artifact-ref", schemaType: "boolean" });
  const validate = ajv.compile(schema);
  if (!validate(bundle)) {
    for (const item of validate.errors ?? []) {
      fail(errors, "SCHEMA_INVALID", `${item.instancePath || "/"} ${item.message}`);
    }
    return { ok: false, errors };
  }

  const byId = new Map();
  for (const artifact of bundle.artifacts) {
    if (byId.has(artifact.artifactId)) fail(errors, "ARTIFACT_ID_DUPLICATE", "ArtifactId 重复", artifact.artifactId);
    byId.set(artifact.artifactId, artifact);
  }
  checkArchitectureSemantics(errors, bundle, byId, schema);
  checkDAG(errors, byId, bundle.rootArtifactId);
  checkSemanticAndRender(errors, bundle.artifacts);
  return { ok: errors.length === 0, errors };
}

export function loadDefaultSchema() {
  return JSON.parse(fs.readFileSync(defaultSchemaPath, "utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bundlePath = process.argv[2];
  if (!bundlePath) {
    console.error("用法: node packages/core/src/validate-task-bundle.mjs <task-bundle.json>");
    process.exit(2);
  }
  const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  const result = validateTaskBundle(bundle, loadDefaultSchema());
  if (!result.ok) {
    for (const error of result.errors) console.error(`${error.code}: ${error.message}${error.artifactId ? ` (${error.artifactId})` : ""}`);
    process.exit(1);
  }
  console.log(`验证通过: ${bundle.artifacts.length} 个 Artifact，根 ${bundle.rootArtifactId}`);
}
