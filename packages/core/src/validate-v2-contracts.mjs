import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const v2SchemaDir = path.join(packageRoot, "schema", "v2");

const SCHEMA_FILES = {
  shared: "shared.schema.json",
  "source-package": "source-package.schema.json",
  "reconstruction-spec": "reconstruction-spec.schema.json",
  "evidence-graph": "evidence-graph.schema.json",
  "resolved-scene": "resolved-scene.schema.json",
  "backend-plan": "backend-plan.schema.json",
  "object-manifest": "object-manifest.schema.json",
  "verification-result": "verification-result.schema.json",
  "delivery-manifest": "delivery-manifest.schema.json",
};

const AUTHOR_CONTRACTS = new Set(["reconstruction-spec", "evidence-graph"]);
const FORBIDDEN_AUTHOR_KEYS = new Set([
  "passed",
  "proved",
  "selected",
  "success",
  "coverage",
  "sourcePixelCoverage",
  "sourceEdgeCoverage",
  "verificationStatus",
  "terminalStatus",
  "deliveryManifestRef",
  "candidateOutput",
]);

function fail(errors, code, message, pointer = "/") {
  errors.push({ code, message, pointer });
}

export function loadV2Schemas(schemaDir = v2SchemaDir) {
  return Object.fromEntries(Object.entries(SCHEMA_FILES).map(([key, file]) => [
    key,
    JSON.parse(fs.readFileSync(path.join(schemaDir, file), "utf8")),
  ]));
}

function makeAjv(schemas) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  for (const schema of Object.values(schemas)) ajv.addSchema(schema);
  return ajv;
}

function contractsOf(input) {
  if (Array.isArray(input?.contracts)) return input.contracts;
  return [input];
}

function checkForbiddenAuthorState(value, errors, pointer = "") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkForbiddenAuthorState(item, errors, `${pointer}/${index}`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childPointer = `${pointer}/${key}`;
    if (FORBIDDEN_AUTHOR_KEYS.has(key)) {
      fail(errors, "V2_AUTHOR_RUNTIME_STATE_FORBIDDEN", `作者契约不能包含运行生成状态字段: ${key}`, childPointer || "/");
    }
    checkForbiddenAuthorState(child, errors, childPointer);
  }
}

function uniqueBy(items, key, errors, code, label) {
  const seen = new Set();
  for (const item of items) {
    const value = item?.[key];
    if (!value) continue;
    if (seen.has(value)) fail(errors, code, `${label} 重复: ${value}`);
    seen.add(value);
  }
  return seen;
}

function walkNodes(node, visit) {
  if (!node) return;
  visit(node);
  for (const child of node.children ?? []) walkNodes(child, visit);
}

function blobDigestsOf(refs = []) {
  return new Set(refs.map((ref) => ref?.digest).filter(Boolean));
}

function measurementNodeRefs(measurement) {
  if (!measurement || typeof measurement !== "object") return [];
  switch (measurement.kind) {
    case "occlusion":
      return [measurement.frontNodeRef, measurement.backNodeRef];
    case "reading-order":
      return measurement.orderedNodeRefs ?? [];
    default:
      return [];
  }
}

function checkCrossContractSemantics(contracts, errors) {
  const byKind = new Map();
  for (const contract of contracts) {
    if (!contract?.contractKind) continue;
    const items = byKind.get(contract.contractKind) ?? [];
    items.push(contract);
    byKind.set(contract.contractKind, items);
  }
  const sources = byKind.get("source-package") ?? [];
  const one = (kind) => {
    const items = byKind.get(kind) ?? [];
    if (items.length > 1) fail(errors, "V2_CONTRACT_KIND_DUPLICATE", `V2 契约集合只能包含一个 ${kind}`);
    return items[0];
  };
  const reconstruction = one("reconstruction-spec");
  const evidence = one("evidence-graph");
  const scene = one("resolved-scene");
  const plan = one("backend-plan");
  const objectManifest = one("object-manifest");
  const verification = one("verification-result");
  const delivery = one("delivery-manifest");

  const sourceIds = uniqueBy(sources, "sourceId", errors, "V2_SOURCE_ID_DUPLICATE", "Source Package sourceId");
  const sourcePages = sources.flatMap((source) => source.pages ?? []);
  const sourcePageIds = uniqueBy(sourcePages, "pageId", errors, "V2_SOURCE_PAGE_ID_DUPLICATE", "Source Package pageId");
  const knownBlobDigests = new Set([
    ...blobDigestsOf(sources.flatMap((source) => [source.rawBlob, source.canonicalPixels, ...(source.derivedBlobs ?? [])])),
    ...blobDigestsOf(reconstruction?.assetRefs),
  ]);
  const reconstructionPages = reconstruction?.pages ?? [];
  const reconstructionPageIds = uniqueBy(reconstructionPages, "pageId", errors, "V2_RECONSTRUCTION_PAGE_ID_DUPLICATE", "Reconstruction Spec pageId");

  if (reconstruction) {
    for (const sourceRef of reconstruction.sourcePackageRefs) {
      if (!sourceIds.has(sourceRef)) fail(errors, "V2_SOURCE_REF_MISSING", `Reconstruction Spec 引用未知 Source Package: ${sourceRef}`);
    }
    for (const page of reconstructionPages) {
      if (!sourcePageIds.has(page.sourcePageRef)) fail(errors, "V2_SOURCE_PAGE_REF_MISSING", `页面 ${page.pageId} 引用未知源页面: ${page.sourcePageRef}`);
    }
  }

  const reconstructionNodeIds = new Set();
  const reconstructionNodes = [];
  for (const page of reconstructionPages) {
    walkNodes(page.rootNode, (node) => {
      if (reconstructionNodeIds.has(node.id)) fail(errors, "V2_NODE_ID_DUPLICATE", `Reconstruction node id 重复: ${node.id}`);
      reconstructionNodeIds.add(node.id);
      reconstructionNodes.push(node);
    });
  }

  const evidenceIds = new Set();
  if (evidence) {
    if (reconstruction && evidence.documentRef !== reconstruction.documentId) {
      fail(errors, "V2_EVIDENCE_DOCUMENT_REF_MISMATCH", `Evidence Graph documentRef 不匹配: ${evidence.documentRef}`);
    }
    for (const sourceRef of evidence.sourcePackageRefs) {
      if (!sourceIds.has(sourceRef)) fail(errors, "V2_EVIDENCE_SOURCE_REF_MISSING", `Evidence Graph 引用未知 Source Package: ${sourceRef}`);
    }
    for (const id of uniqueBy(evidence.evidence ?? [], "id", errors, "V2_EVIDENCE_ID_DUPLICATE", "Evidence id")) evidenceIds.add(id);
    for (const item of evidence.evidence ?? []) {
      for (const region of item.sourceRegions ?? []) {
        if (!sourcePageIds.has(region.pageId)) fail(errors, "V2_EVIDENCE_PAGE_REF_MISSING", `Evidence ${item.id} 引用未知源页面: ${region.pageId}`);
      }
      for (const subject of item.subjects ?? []) {
        if (!reconstructionNodeIds.has(subject.nodeRef)) fail(errors, "V2_EVIDENCE_SUBJECT_REF_MISSING", `Evidence ${item.id} 引用未知节点: ${subject.nodeRef}`);
      }
      for (const nodeRef of measurementNodeRefs(item.measurement)) {
        if (!reconstructionNodeIds.has(nodeRef)) fail(errors, "V2_EVIDENCE_MEASUREMENT_NODE_REF_MISSING", `Evidence ${item.id} 的 measurement 引用未知节点: ${nodeRef}`);
      }
      const measurementBlobDigest = item.measurement?.maskBlobDigest ?? item.measurement?.resourceDigest;
      if (measurementBlobDigest && !knownBlobDigests.has(measurementBlobDigest)) {
        fail(errors, "V2_EVIDENCE_BLOB_REF_MISSING", `Evidence ${item.id} 引用未知 Blob: ${measurementBlobDigest}`);
      }
      for (const ref of item.provenance?.evidenceBlobRefs ?? []) knownBlobDigests.add(ref.digest);
    }
  }

  for (const node of reconstructionNodes) {
    for (const evidenceRef of node.evidenceRefs ?? []) {
      if (!evidenceIds.has(evidenceRef)) fail(errors, "V2_NODE_EVIDENCE_REF_MISSING", `节点 ${node.id} 引用未知 Evidence: ${evidenceRef}`);
    }
    for (const clip of node.geometry?.clipStack ?? []) {
      if (!reconstructionNodeIds.has(clip.clipNodeRef)) fail(errors, "V2_CLIP_NODE_REF_MISSING", `节点 ${node.id} 引用未知 clip 节点: ${clip.clipNodeRef}`);
    }
    for (const mask of node.geometry?.maskStack ?? []) {
      if (mask.source?.kind === "node" && !reconstructionNodeIds.has(mask.source.nodeRef)) {
        fail(errors, "V2_MASK_NODE_REF_MISSING", `节点 ${node.id} 引用未知 mask 节点: ${mask.source.nodeRef}`);
      }
      if (mask.source?.kind === "blob" && !knownBlobDigests.has(mask.source.blobDigest)) {
        fail(errors, "V2_MASK_BLOB_REF_MISSING", `节点 ${node.id} 引用未知 mask Blob: ${mask.source.blobDigest}`);
      }
    }
    if (node.type === "image" && node.content?.resourceDigest && !knownBlobDigests.has(node.content.resourceDigest)) {
      fail(errors, "V2_IMAGE_BLOB_REF_MISSING", `图片节点 ${node.id} 引用未知 Blob: ${node.content.resourceDigest}`);
    }
    if (node.type === "connector") {
      for (const endpoint of [node.content?.start, node.content?.end]) {
        if (endpoint?.kind === "node-anchor" && !reconstructionNodeIds.has(endpoint.nodeRef)) {
          fail(errors, "V2_CONNECTOR_NODE_REF_MISSING", `连接线 ${node.id} 引用未知端点节点: ${endpoint.nodeRef}`);
        }
      }
    }
    for (const evidenceRef of node.content?.dataProvenanceEvidenceRefs ?? []) {
      if (!evidenceIds.has(evidenceRef)) fail(errors, "V2_CHART_EVIDENCE_REF_MISSING", `图表 ${node.id} 引用未知数据 Evidence: ${evidenceRef}`);
    }
  }

  const sceneNodeIds = new Set();
  if (scene) {
    if (reconstruction && scene.documentRef !== reconstruction.documentId) fail(errors, "V2_SCENE_DOCUMENT_REF_MISMATCH", `Resolved Scene documentRef 不匹配: ${scene.documentRef}`);
    const sceneResourceDigests = blobDigestsOf(scene.resources ?? []);
    for (const page of scene.pages ?? []) {
      if (!reconstructionPageIds.has(page.pageId)) fail(errors, "V2_SCENE_PAGE_REF_MISSING", `Resolved Scene 引用未知重建页面: ${page.pageId}`);
      if (!sourcePageIds.has(page.sourcePageRef)) fail(errors, "V2_SCENE_SOURCE_PAGE_REF_MISSING", `Resolved Scene 页面 ${page.pageId} 引用未知源页面: ${page.sourcePageRef}`);
      const pageSceneNodeIds = uniqueBy(page.nodes ?? [], "sceneNodeId", errors, "V2_SCENE_NODE_ID_DUPLICATE", `Resolved Scene 页面 ${page.pageId} sceneNodeId`);
      if (!pageSceneNodeIds.has(page.rootSceneNodeRef)) fail(errors, "V2_SCENE_ROOT_NODE_REF_MISSING", `Resolved Scene 页面 ${page.pageId} 根节点不存在: ${page.rootSceneNodeRef}`);
      if ((page.drawOrder?.length ?? 0) !== pageSceneNodeIds.size || (page.drawOrder ?? []).some((nodeId) => !pageSceneNodeIds.has(nodeId))) {
        fail(errors, "V2_SCENE_DRAW_ORDER_CLOSURE", `Resolved Scene 页面 ${page.pageId} drawOrder 必须精确覆盖所有节点`);
      }
      for (const node of page.nodes ?? []) {
        if (sceneNodeIds.has(node.sceneNodeId)) fail(errors, "V2_SCENE_NODE_ID_DUPLICATE", `Scene node id 重复: ${node.sceneNodeId}`);
        sceneNodeIds.add(node.sceneNodeId);
        for (const sourceNodeRef of node.sourceNodeRefs ?? []) {
          if (!reconstructionNodeIds.has(sourceNodeRef)) fail(errors, "V2_SCENE_SOURCE_NODE_REF_MISSING", `Scene node ${node.sceneNodeId} 引用未知 Reconstruction node: ${sourceNodeRef}`);
        }
        if (node.parentSceneNodeRef && !pageSceneNodeIds.has(node.parentSceneNodeRef)) {
          fail(errors, "V2_SCENE_PARENT_NODE_REF_MISSING", `Scene node ${node.sceneNodeId} 引用未知父节点: ${node.parentSceneNodeRef}`);
        }
        for (const childRef of node.childSceneNodeRefs ?? []) {
          if (!pageSceneNodeIds.has(childRef)) fail(errors, "V2_SCENE_CHILD_NODE_REF_MISSING", `Scene node ${node.sceneNodeId} 引用未知子节点: ${childRef}`);
        }
        for (const resourceRef of node.resourceRefs ?? []) {
          if (!sceneResourceDigests.has(resourceRef)) fail(errors, "V2_SCENE_RESOURCE_REF_MISSING", `Scene node ${node.sceneNodeId} 引用未绑定资源: ${resourceRef}`);
        }
        for (const evidenceRef of node.evidenceClosure?.allEvidenceRefs ?? []) {
          if (!evidenceIds.has(evidenceRef)) fail(errors, "V2_SCENE_EVIDENCE_REF_MISSING", `Scene node ${node.sceneNodeId} 引用未知 Evidence: ${evidenceRef}`);
        }
      }
    }
  }

  if (plan) {
    if (scene && plan.sceneRef !== scene.sceneId) fail(errors, "V2_PLAN_SCENE_REF_MISMATCH", `Backend Plan sceneRef 不匹配: ${plan.sceneRef}`);
    const planPageIds = uniqueBy(plan.pages ?? [], "pageId", errors, "V2_PLAN_PAGE_ID_DUPLICATE", "Backend pageId");
    uniqueBy(plan.operations, "operationId", errors, "V2_PLAN_OPERATION_ID_DUPLICATE", "Backend operationId");
    const operationSceneNodeIds = new Set(plan.operations.map((operation) => operation.sceneNodeRef));
    const planResourceDigests = blobDigestsOf(plan.resources ?? []);
    const objectRefs = new Set();
    if (scene) {
      const scenePages = new Map(scene.pages.map((page) => [page.pageId, page]));
      for (const page of plan.pages ?? []) {
        const scenePage = scenePages.get(page.pageId);
        if (!scenePage) fail(errors, "V2_PLAN_PAGE_REF_MISSING", `Backend Plan 引用未知 Scene 页面: ${page.pageId}`);
        else if (JSON.stringify(page.canvas) !== JSON.stringify(scenePage.canvas)) fail(errors, "V2_PLAN_CANVAS_MISMATCH", `Backend Plan 页面画布与 Scene 不一致: ${page.pageId}`);
      }
    }
    for (const operation of plan.operations) {
      if (scene && !sceneNodeIds.has(operation.sceneNodeRef)) fail(errors, "V2_PLAN_SCENE_NODE_REF_MISSING", `Backend operation ${operation.operationId} 引用未知 Scene node: ${operation.sceneNodeRef}`);
      if (!planPageIds.has(operation.pageId)) fail(errors, "V2_PLAN_OPERATION_PAGE_REF_MISSING", `Backend operation ${operation.operationId} 引用未知页面: ${operation.pageId}`);
      if (operation.parentSceneNodeRef && !operationSceneNodeIds.has(operation.parentSceneNodeRef)) fail(errors, "V2_PLAN_PARENT_NODE_REF_MISSING", `Backend operation ${operation.operationId} 引用未知父节点: ${operation.parentSceneNodeRef}`);
      for (const childRef of operation.childSceneNodeRefs ?? []) {
        if (!operationSceneNodeIds.has(childRef)) fail(errors, "V2_PLAN_CHILD_NODE_REF_MISSING", `Backend operation ${operation.operationId} 引用未知子节点: ${childRef}`);
      }
      for (const resourceRef of operation.resourceRefs ?? []) {
        if (!planResourceDigests.has(resourceRef)) fail(errors, "V2_PLAN_RESOURCE_REF_MISSING", `Backend operation ${operation.operationId} 引用未绑定资源: ${resourceRef}`);
      }
      for (const expected of operation.expectedObjects ?? []) {
        if (objectRefs.has(expected.objectRef)) fail(errors, "V2_PLAN_OBJECT_REF_DUPLICATE", `Backend expected objectRef 重复: ${expected.objectRef}`);
        objectRefs.add(expected.objectRef);
        if (expected.slideId !== operation.pageId) fail(errors, "V2_PLAN_OBJECT_PAGE_MISMATCH", `Backend expected object ${expected.objectRef} 页面与 operation 不一致`);
        if (expected.virtual && expected.expectedOoxmlFeatures.length) fail(errors, "V2_PLAN_VIRTUAL_OBJECT_FEATURES", `virtual expected object 不能声明真实 OOXML 特征: ${expected.objectRef}`);
      }
      if (operation.strategy === "rejected" && !operation.rejectionReason) fail(errors, "V2_PLAN_REJECTION_REASON_REQUIRED", `rejected 操作必须说明原因: ${operation.operationId}`);
      if (operation.declaredLosses.some((loss) => !loss.approved)) fail(errors, "V2_PLAN_UNAPPROVED_LOSS", `Backend operation 携带未批准损失: ${operation.operationId}`);
    }
  }

  if (objectManifest) {
    if (plan && objectManifest.planRef !== plan.planId) fail(errors, "V2_OBJECT_MANIFEST_PLAN_REF_MISMATCH", `Object Manifest planRef 不匹配: ${objectManifest.planRef}`);
    const manifestPageIds = uniqueBy(objectManifest.pages ?? [], "pageId", errors, "V2_OBJECT_MANIFEST_PAGE_ID_DUPLICATE", "Object Manifest pageId");
    const manifestObjectRefs = uniqueBy(objectManifest.objects ?? [], "objectRef", errors, "V2_OBJECT_MANIFEST_OBJECT_REF_DUPLICATE", "Object Manifest objectRef");
    const expectedByRef = new Map((plan?.operations ?? []).flatMap((operation) => operation.expectedObjects.map((expected) => [expected.objectRef, { operation, expected }])));
    for (const page of objectManifest.pages ?? []) {
      if (plan && !(plan.pages ?? []).some((candidate) => candidate.pageId === page.pageId)) fail(errors, "V2_OBJECT_MANIFEST_PAGE_REF_MISSING", `Object Manifest 引用未知计划页面: ${page.pageId}`);
      for (const objectRef of page.objectRefs ?? []) {
        if (!manifestObjectRefs.has(objectRef)) fail(errors, "V2_OBJECT_MANIFEST_PAGE_OBJECT_REF_MISSING", `Object Manifest 页面 ${page.pageId} 引用未知对象: ${objectRef}`);
      }
    }
    for (const object of objectManifest.objects ?? []) {
      if (!manifestPageIds.has(object.slideId)) fail(errors, "V2_OBJECT_MANIFEST_OBJECT_PAGE_REF_MISSING", `Object Manifest 对象 ${object.objectRef} 引用未知页面: ${object.slideId}`);
      const planned = expectedByRef.get(object.objectRef);
      if (plan && !planned) {
        fail(errors, "V2_OBJECT_MANIFEST_UNDECLARED_OBJECT", `Object Manifest 包含 Backend Plan 未声明对象: ${object.objectRef}`);
        continue;
      }
      if (!planned) continue;
      if (object.operationId !== planned.operation.operationId || object.sceneNodeId !== planned.operation.sceneNodeRef) fail(errors, "V2_OBJECT_MANIFEST_PROVENANCE_MISMATCH", `Object Manifest 对象 ${object.objectRef} 来源闭包不匹配`);
      if (object.slideId !== planned.expected.slideId || object.virtual !== planned.expected.virtual) fail(errors, "V2_OBJECT_MANIFEST_EXPECTATION_MISMATCH", `Object Manifest 对象 ${object.objectRef} 与 expected object 不匹配`);
    }
    if (plan) {
      for (const objectRef of expectedByRef.keys()) {
        if (!manifestObjectRefs.has(objectRef)) fail(errors, "V2_OBJECT_MANIFEST_EXPECTED_OBJECT_MISSING", `Object Manifest 缺少计划对象: ${objectRef}`);
      }
    }
  }

  if (verification) {
    if (plan && verification.planRef !== plan.planId) fail(errors, "V2_VERIFICATION_PLAN_REF_MISMATCH", `Verification Result planRef 不匹配: ${verification.planRef}`);
    if (objectManifest && verification.objectManifestRef && verification.objectManifestRef !== objectManifest.manifestId) {
      fail(errors, "V2_VERIFICATION_OBJECT_MANIFEST_REF_MISMATCH", `Verification Result objectManifestRef 不匹配: ${verification.objectManifestRef}`);
    }
    for (const sourceRef of verification.sourcePackageRefs ?? []) {
      if (!sourceIds.has(sourceRef)) fail(errors, "V2_VERIFICATION_SOURCE_REF_MISSING", `Verification Result 引用未知 Source Package: ${sourceRef}`);
    }
    if (plan) {
      const planOperationIds = new Set(plan.operations.map((operation) => operation.operationId));
      for (const result of verification.operationResults ?? []) {
        if (!planOperationIds.has(result.subjectRef)) fail(errors, "V2_VERIFICATION_OPERATION_REF_MISSING", `Verification Result 引用未知 Backend Operation: ${result.subjectRef}`);
      }
    }
    if (objectManifest) {
      const objectRefs = new Set(objectManifest.objects.map((object) => object.objectRef));
      for (const result of verification.objectResults ?? []) {
        if (!objectRefs.has(result.subjectRef)) fail(errors, "V2_VERIFICATION_OBJECT_REF_MISSING", `Verification Result 引用未知 Object Manifest 对象: ${result.subjectRef}`);
      }
      for (const result of verification.editabilityResults ?? []) {
        if (!objectRefs.has(result.subjectRef)) fail(errors, "V2_VERIFICATION_EDITABILITY_OBJECT_REF_MISSING", `编辑性结果引用未知对象: ${result.subjectRef}`);
      }
    }
    const verifiedPages = new Set(verification.pageResults.map((item) => item.subjectRef));
    for (const pageId of sourcePageIds) {
      if (!verifiedPages.has(pageId)) fail(errors, "V2_VERIFICATION_PAGE_MISSING", `Verification Result 缺少页面结果: ${pageId}`);
    }
    if (verification.status === "passed" && verification.failures.length) fail(errors, "V2_VERIFICATION_PASSED_WITH_FAILURES", "passed 的 Verification Result 不能包含 failures");
    if (verification.summary?.gateStatus !== verification.status) fail(errors, "V2_VERIFICATION_SUMMARY_STATUS_MISMATCH", "Verification Result summary.gateStatus 必须与 status 一致");
    if (verification.summary && verification.summary.failedChecks > 0 && verification.status === "passed") fail(errors, "V2_VERIFICATION_SUMMARY_FAILED_CHECKS", "passed 的 Verification Result 不能有 failedChecks");
  }

  if (delivery) {
    if (verification && delivery.verificationResultRef !== verification.verificationId) fail(errors, "V2_DELIVERY_VERIFICATION_REF_MISMATCH", `Delivery Manifest verificationResultRef 不匹配: ${delivery.verificationResultRef}`);
    if (verification && verification.status !== "passed") fail(errors, "V2_DELIVERY_REQUIRES_PASSED_VERIFICATION", "Delivery Manifest 只能引用 passed 的 Verification Result");
    for (const sourceRef of delivery.sourcePackageRefs) {
      if (!sourceIds.has(sourceRef)) fail(errors, "V2_DELIVERY_SOURCE_REF_MISSING", `Delivery Manifest 引用未知 Source Package: ${sourceRef}`);
    }
  }
}

export function validateV2Contracts(input, schemas = loadV2Schemas()) {
  const errors = [];
  const contracts = contractsOf(input);
  const ajv = makeAjv(schemas);

  for (const [index, contract] of contracts.entries()) {
    const kind = contract?.contractKind;
    if (!kind || !schemas[kind]) {
      fail(errors, "V2_CONTRACT_KIND_UNKNOWN", `未知 V2 contractKind: ${kind ?? "<missing>"}`, `/contracts/${index}`);
      continue;
    }
    const validate = ajv.getSchema(schemas[kind].$id) ?? ajv.compile(schemas[kind]);
    if (!validate(contract)) {
      for (const item of validate.errors ?? []) {
        fail(errors, "V2_SCHEMA_INVALID", `${kind}${item.instancePath || "/"} ${item.message}`, `/contracts/${index}${item.instancePath || ""}`);
      }
    }
    if (AUTHOR_CONTRACTS.has(kind)) checkForbiddenAuthorState(contract, errors, `/contracts/${index}`);
  }

  checkCrossContractSemantics(contracts, errors);
  return { ok: errors.length === 0, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("用法: node packages/core/src/validate-v2-contracts.mjs <v2-contracts.json>");
    process.exit(2);
  }
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const result = validateV2Contracts(input);
  if (!result.ok) {
    for (const error of result.errors) console.error(`${error.code}: ${error.message} (${error.pointer})`);
    process.exit(1);
  }
  console.log(`V2 契约验证通过: ${contractsOf(input).length} 个契约`);
}
