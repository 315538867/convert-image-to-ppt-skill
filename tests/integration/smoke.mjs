import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateV2Contracts } from "@image-to-ppt/core";
import { FileBlob, PresentationFile, renderPptxFromBackendPlan } from "@image-to-ppt/renderer-pptx";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "../..");
const renderer = path.join(projectRoot, "packages", "cli", "src", "image2ppt.mjs");
const checkpoint = path.join(projectRoot, "packages", "cli", "src", "task-checkpoint.mjs");
const contractsPath = path.join(projectRoot, "packages", "core", "examples", "v2", "minimal-single-page.json");
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "img2ppt-v2-skill-"));

async function run(command, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseJsonTail(stdout) {
  const start = stdout.lastIndexOf("\n{");
  return JSON.parse(stdout.slice(start >= 0 ? start + 1 : stdout.indexOf("{")));
}

async function writeReferenceSourceFromV2Plan({ contractsPath: inputPath, outputPath }) {
  const bundle = JSON.parse(await fsp.readFile(inputPath, "utf8"));
  const backendPlan = bundle.contracts.find((contract) => contract.contractKind === "backend-plan");
  assert(backendPlan, "V2 smoke fixture 缺少 Backend Plan");
  const pptxPath = path.join(path.dirname(outputPath), "reference.pptx");
  await renderPptxFromBackendPlan(backendPlan, new Map(), pptxPath);
  const presentation = await PresentationFile.importPptx(await FileBlob.load(pptxPath));
  const preview = await presentation.export({ slide: presentation.slides.items[0], format: "png", scale: 1 });
  await fsp.writeFile(outputPath, new Uint8Array(await preview.arrayBuffer()));
}

try {
  const source = path.join(dir, "source.png");
  await writeReferenceSourceFromV2Plan({ contractsPath, outputPath: source });

  const workspaceDir = path.join(dir, "workspace");
  const initialized = await run(process.execPath, [checkpoint, "init", source, "--workspace", workspaceDir]);
  assert.equal(initialized.code, 0, initialized.stderr);
  const initializedPayload = parseJsonTail(initialized.stdout);
  assert.equal(initializedPayload.stateVersion, 2);
  assert.equal(initializedPayload.authorContractsPath.endsWith("v2-author-contracts.json"), true);

  const result = await run(process.execPath, [
    renderer,
    source,
    "--contracts", contractsPath,
    "--workspace", workspaceDir,
    "--run-id", "integration-smoke",
  ]);
  assert.equal(result.code, 0, result.stderr);
  const conversion = parseJsonTail(result.stdout);
  assert.equal(conversion.status, "passed");
  assert.equal(conversion.current, "runs/integration-smoke/delivery-manifest.json");

  for (const filePath of [
    conversion.pptxPath,
    conversion.sourcePackagePath,
    conversion.resolvedScenePath,
    conversion.backendPlanPath,
    conversion.objectManifestPath,
    conversion.verificationResultPath,
    conversion.deliveryManifest,
    conversion.sourceOverlayPath,
    conversion.reviewSheetPath,
    conversion.renderedPagePaths["page-1"],
    conversion.diffPaths["page-1"],
  ]) {
    await fsp.access(filePath);
  }

  const authorBundle = JSON.parse(await fsp.readFile(contractsPath, "utf8"));
  const authorContracts = authorBundle.contracts.filter((contract) => ["reconstruction-spec", "evidence-graph"].includes(contract.contractKind));
  const runtimeContracts = await Promise.all([
    "sourcePackagePath",
    "resolvedScenePath",
    "backendPlanPath",
    "objectManifestPath",
    "verificationResultPath",
    "deliveryManifest",
  ].map(async (key) => JSON.parse(await fsp.readFile(conversion[key], "utf8"))));
  const contracts = [...runtimeContracts.slice(0, 1), ...authorContracts, ...runtimeContracts.slice(1)];
  const validation = validateV2Contracts({ schemaVersion: 2, contracts });
  assert.equal(validation.ok, true, JSON.stringify(validation.errors, null, 2));
  assert.equal(contracts.find((contract) => contract.contractKind === "verification-result").status, "passed");
  assert.equal(contracts.find((contract) => contract.contractKind === "delivery-manifest").status, "published");

  const completed = await run(process.execPath, [checkpoint, "complete", "--workspace", workspaceDir]);
  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(parseJsonTail(completed.stdout).status, "complete");

  const rejected = await run(process.execPath, [
    renderer,
    source,
    "--bundle", contractsPath,
    "--output", path.join(dir, "old.pptx"),
  ]);
  assert.notEqual(rejected.code, 0, "V1 --bundle/--output 公共入口必须被拒绝");

  assert.equal(fs.existsSync(path.join(workspaceDir, "outputs", "result.task-bundle.json")), false);
  console.log(JSON.stringify({ status: "passed", runId: conversion.runId, deliveryManifest: conversion.deliveryManifest }, null, 2));
} finally {
  await fsp.rm(dir, { recursive: true, force: true });
}
