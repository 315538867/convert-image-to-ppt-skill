#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FileBlob, PresentationFile, renderPptxFromBackendPlan } from "@image-to-ppt/renderer-pptx";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builtSkill = path.join(projectRoot, "dist", "convert-image-to-ppt");

async function run(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
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

async function writeReferenceSourceFromV2Plan({ contractsPath, outputPath }) {
  const bundle = JSON.parse(await fs.readFile(contractsPath, "utf8"));
  const backendPlan = bundle.contracts.find((contract) => contract.contractKind === "backend-plan");
  assert(backendPlan, "V2 built-skill fixture 缺少 Backend Plan");
  const pptxPath = path.join(path.dirname(outputPath), "reference.pptx");
  await renderPptxFromBackendPlan(backendPlan, new Map(), pptxPath);
  const presentation = await PresentationFile.importPptx(await FileBlob.load(pptxPath));
  const preview = await presentation.export({ slide: presentation.slides.items[0], format: "png", scale: 1 });
  await fs.writeFile(outputPath, new Uint8Array(await preview.arrayBuffer()));
}

async function main() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "image-to-ppt-built-skill-"));
  const skill = path.join(workspace, "convert-image-to-ppt");
  await fs.cp(builtSkill, skill, { recursive: true });
  const install = await run("npm", ["ci", "--prefix", path.join(skill, "scripts")]);
  assert.equal(install.code, 0, install.stderr);
  const preflight = await run(process.execPath, [path.join(skill, "scripts", "preflight.mjs")]);
  assert.equal(preflight.code, 0, preflight.stderr);

  const contractsPath = path.join(skill, "examples", "v2", "minimal-single-page.json");
  const source = path.join(workspace, "source.png");
  await writeReferenceSourceFromV2Plan({ contractsPath, outputPath: source });

  const taskWorkspace = path.join(workspace, "task");
  const checkpoint = await run(process.execPath, [path.join(skill, "scripts", "task-checkpoint.mjs"), "init", source, "--workspace", taskWorkspace]);
  assert.equal(checkpoint.code, 0, checkpoint.stderr);
  assert.equal(parseJsonTail(checkpoint.stdout).stateVersion, 2);

  const conversion = await run(process.execPath, [
    path.join(skill, "scripts", "image2ppt.mjs"),
    source,
    "--contracts", contractsPath,
    "--workspace", taskWorkspace,
    "--run-id", "built-skill-smoke",
  ]);
  assert.equal(conversion.code, 0, conversion.stderr);
  const result = parseJsonTail(conversion.stdout);
  assert.equal(result.status, "passed");
  assert.equal(result.current, "runs/built-skill-smoke/delivery-manifest.json");

  const verification = JSON.parse(await fs.readFile(result.verificationResultPath, "utf8"));
  const delivery = JSON.parse(await fs.readFile(result.deliveryManifest, "utf8"));
  assert.equal(verification.status, "passed");
  assert.equal(delivery.status, "published");

  const completed = await run(process.execPath, [path.join(skill, "scripts", "task-checkpoint.mjs"), "complete", "--workspace", taskWorkspace]);
  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(parseJsonTail(completed.stdout).status, "complete");
  console.log(JSON.stringify({ status: "passed", skill, runId: result.runId, deliveryManifest: result.deliveryManifest }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
