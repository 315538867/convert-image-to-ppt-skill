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
        metrics: { weightedScore: visual.weightedScore, globalPixelSimilarity: visual.global.pixelSimilarity, globalEdgeSimilarity: visual.global.edgeSimilarity },
        ...(visual.status === "passed" ? {} : { message: "页面视觉验证失败" }),
      }));
      for (const region of visual.regions) {
        const status = region.pixelSimilarity >= region.thresholds.pixel && region.edgeSimilarity >= region.thresholds.edge ? "passed" : "failed";
        protectedRegionResults.push(result(region.regionId, "protected-region", status, {
          metrics: {
            pixelSimilarity: region.pixelSimilarity,
            edgeSimilarity: region.edgeSimilarity,
            pixelThreshold: region.thresholds.pixel,
            edgeThreshold: region.thresholds.edge,
          },
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
  const failures = [...source.failures, ...visual.failures, ...closure.failures, ...editability.failures, ...packageSafety.failures];
  const summary = summarize([
    source.sourceResults,
    visual.pageResults,
    visual.evidenceResults,
    visual.sceneNodeResults,
    closure.operationResults,
    closure.objectResults,
    visual.protectedRegionResults,
    editability.editabilityResults,
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
    editabilityResults: editability.editabilityResults,
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
