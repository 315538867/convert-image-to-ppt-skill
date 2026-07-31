#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderPptxFromBundle } from "@image-to-ppt/renderer-pptx";

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

async function main() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "image-to-ppt-built-skill-"));
  const skill = path.join(workspace, "convert-image-to-ppt");
  await fs.cp(builtSkill, skill, { recursive: true });
  const install = await run("npm", ["ci", "--prefix", path.join(skill, "scripts")]);
  assert.equal(install.code, 0, install.stderr);
  const preflight = await run(process.execPath, [path.join(skill, "scripts", "preflight.mjs")]);
  assert.equal(preflight.code, 0, preflight.stderr);

  const bundle = JSON.parse(await fs.readFile(path.join(skill, "examples", "task-bundle-example.json"), "utf8"));
  const source = path.join(workspace, "source.png");
  await renderPptxFromBundle(bundle, path.join(workspace, "bootstrap.pptx"), { previewPath: source });
  const taskWorkspace = path.join(workspace, "task");
  const checkpoint = await run(process.execPath, [path.join(skill, "scripts", "task-checkpoint.mjs"), "init", source, "--workspace", taskWorkspace]);
  assert.equal(checkpoint.code, 0, checkpoint.stderr);
  const output = path.join(taskWorkspace, "outputs", "result.pptx");
  const conversion = await run(process.execPath, [
    path.join(skill, "scripts", "image2ppt.mjs"),
    source,
    "--bundle", path.join(taskWorkspace, "work", "authoring-task-bundle.json"),
    "--output", output,
  ]);
  assert.equal(conversion.code, 0, conversion.stderr);
  const finalBundle = JSON.parse(await fs.readFile(output.replace(/\.pptx$/, ".task-bundle.json"), "utf8"));
  const verification = JSON.parse(await fs.readFile(output.replace(/\.pptx$/, ".verification.json"), "utf8"));
  assert.equal(finalBundle.bundlePhase, "final");
  assert.equal(verification.status, "passed");
  console.log(JSON.stringify({ status: "passed", skill, artifactCount: finalBundle.artifacts.length }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
