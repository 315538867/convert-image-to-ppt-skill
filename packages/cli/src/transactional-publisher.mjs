import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sha256BytesDigest, sha256Digest, validateV2Contracts } from "@image-to-ppt/core";

const DELIVERY_MANIFEST_NAME = "delivery-manifest.json";
const CURRENT_POINTER_NAME = "current";

function assertIdentifier(value, label) {
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`${label} 不是合法 V2 identifier: ${value}`);
  }
}

function relativeStorageKey(workspaceDir, filePath) {
  const relative = path.relative(workspaceDir, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`输出文件必须位于发布工作区内: ${filePath}`);
  }
  return relative.split(path.sep).join("/");
}

export function createRunId(seed = randomUUID()) {
  return `run-${sha256Digest({ seed, createdBy: "img2ppt-v2-publisher" }).slice(7, 31)}`;
}

export async function createRunWorkspace({ workspaceDir, runId = createRunId() }) {
  assertIdentifier(runId, "runId");
  const runDir = path.join(workspaceDir, "runs", runId);
  await fs.mkdir(path.join(runDir, "diagnostics"), { recursive: true });
  return {
    runId,
    runDir,
    diagnosticsDir: path.join(runDir, "diagnostics"),
    deliveryManifestPath: path.join(runDir, DELIVERY_MANIFEST_NAME),
    relativeDeliveryManifestPath: `runs/${runId}/${DELIVERY_MANIFEST_NAME}`,
  };
}

export async function outputBlobRef({ workspaceDir, filePath, mediaType, role, storageKey }) {
  assertIdentifier(role, "role");
  const bytes = await fs.readFile(filePath);
  return {
    digest: sha256BytesDigest(bytes),
    mediaType,
    byteLength: bytes.length,
    storageKey: storageKey ?? relativeStorageKey(workspaceDir, filePath),
    role,
  };
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tempPath, filePath);
}

async function writePointerAtomic(workspaceDir, target, { simulateCrashBeforePointerCommit = false } = {}) {
  const pointerPath = path.join(workspaceDir, CURRENT_POINTER_NAME);
  const tempPath = path.join(workspaceDir, `.${CURRENT_POINTER_NAME}.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(tempPath, `${target}\n`);
  if (simulateCrashBeforePointerCommit) {
    throw new Error(`模拟发布指针提交前崩溃: ${tempPath}`);
  }
  await fs.rename(tempPath, pointerPath);
}

function sourcePackageRefs(sourcePackages) {
  const refs = sourcePackages.map((sourcePackage) => sourcePackage.sourceId).filter(Boolean);
  if (!refs.length) throw new Error("Delivery Manifest 至少需要一个 Source Package 引用");
  return refs;
}

export async function createDeliveryManifest({
  workspaceDir,
  runId,
  sourcePackages,
  verificationResult,
  outputs,
  validationContracts = [],
  publishedAt = new Date().toISOString(),
}) {
  if (verificationResult?.contractKind !== "verification-result") throw new Error("Delivery Manifest 需要 Verification Result");
  if (verificationResult.status !== "passed") {
    throw new Error(`Verification Result 未通过，禁止生成 Delivery Manifest: ${verificationResult.status}`);
  }
  const outputRefs = [];
  for (const output of outputs) {
    outputRefs.push(output.digest ? output : await outputBlobRef({ workspaceDir, ...output }));
  }
  if (!outputRefs.length) throw new Error("Delivery Manifest 至少需要一个输出 Blob");
  const manifest = {
    schemaVersion: 2,
    contractKind: "delivery-manifest",
    manifestId: `delivery-${sha256Digest({ runId, verificationId: verificationResult.verificationId, outputs: outputRefs }).slice(7, 31)}`,
    runId,
    status: "published",
    sourcePackageRefs: sourcePackageRefs(sourcePackages),
    verificationResultRef: verificationResult.verificationId,
    outputs: outputRefs,
    publishedAt,
  };
  const validation = validateV2Contracts({
    schemaVersion: 2,
    contracts: [...sourcePackages, ...validationContracts, verificationResult, manifest],
  });
  if (!validation.ok) {
    const error = new Error(`Delivery Manifest 校验失败:\n${validation.errors.map((item) => `${item.code}: ${item.message}`).join("\n")}`);
    error.code = "V2_DELIVERY_MANIFEST_INVALID";
    error.validationErrors = validation.errors;
    throw error;
  }
  return manifest;
}

export async function publishRun({
  workspaceDir,
  runId,
  sourcePackages,
  verificationResult,
  outputs,
  validationContracts = [],
  publishedAt,
  simulateCrashBeforePointerCommit = false,
}) {
  const run = await createRunWorkspace({ workspaceDir, runId });
  const manifest = await createDeliveryManifest({
    workspaceDir,
    runId: run.runId,
    sourcePackages,
    verificationResult,
    outputs,
    validationContracts,
    publishedAt,
  });
  await writeJsonAtomic(run.deliveryManifestPath, manifest);
  await writePointerAtomic(workspaceDir, run.relativeDeliveryManifestPath, { simulateCrashBeforePointerCommit });
  return { ...run, manifest };
}

export async function writeFailedRunDiagnostics({ workspaceDir, runId, verificationResult, diagnostics = {} }) {
  const run = await createRunWorkspace({ workspaceDir, runId });
  await writeJsonAtomic(path.join(run.diagnosticsDir, "verification-result.json"), verificationResult);
  for (const [name, value] of Object.entries(diagnostics)) {
    await writeJsonAtomic(path.join(run.diagnosticsDir, name.endsWith(".json") ? name : `${name}.json`), value);
  }
  return run;
}

export async function readCurrentPublication({ workspaceDir }) {
  const pointerPath = path.join(workspaceDir, CURRENT_POINTER_NAME);
  let target;
  try {
    target = (await fs.readFile(pointerPath, "utf8")).trim();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!target) return null;
  const manifestPath = path.join(workspaceDir, target);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  return { pointerPath, target, manifestPath, manifest };
}
