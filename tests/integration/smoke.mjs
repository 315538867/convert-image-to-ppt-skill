import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "../..");
const renderer = path.join(projectRoot, "packages", "cli", "src", "image2ppt.mjs");
const example = path.join(projectRoot, "packages", "core", "examples", "task-bundle-example.json");
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "img2ppt-vnext-skill-"));

async function run(args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [renderer, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

const source = path.join(dir, "source.png");
const bootstrapPptx = path.join(dir, "bootstrap.pptx");
const bootstrapBundle = JSON.parse(await fs.readFile(example, "utf8"));
const semantic = bootstrapBundle.artifacts.find((artifact) => artifact.artifactType === "semantic-plane");
const authoredText = semantic.body.slides[0].root.children[0].text;
assert(authoredText.inkBox);
assert(authoredText.boundaryPolicy?.minimumClearance);
const { protectedRegions } = await import("@image-to-ppt/cli");
assert(protectedRegions(bootstrapBundle).some((item) => item.regionId.endsWith(":text-1:text-ink") && item.category === "text"));
const { renderPptxFromBundle } = await import("@image-to-ppt/renderer-pptx");
await renderPptxFromBundle(bootstrapBundle, bootstrapPptx, { previewPath: source });
const checkpoint = path.join(projectRoot, "packages", "cli", "src", "task-checkpoint.mjs");
const initialized = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [checkpoint, "init", source, "--workspace", dir], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("exit", (code) => resolve({ code, stderr }));
});
assert.equal(initialized.code, 0, initialized.stderr);

const output = path.join(dir, "outputs", "result.pptx");
const analysisCachePath = path.join(dir, "outputs", "source-analysis-cache.json");
const result = await run([source, "--bundle", example, "--analysis-cache", analysisCachePath, "--output", output]);
assert.equal(result.code, 0, result.stderr);
await fs.access(output);
const verification = JSON.parse(await fs.readFile(output.replace(/\.pptx$/, ".verification.json"), "utf8"));
assert.equal(verification.status, "passed");
const coverage = JSON.parse(await fs.readFile(output.replace(/\.pptx$/, ".source-coverage.json"), "utf8"));
assert.equal(coverage.status, "passed");
await fs.access(output.replace(/\.pptx$/, ".review-sheet.png"));
const analysisCache = JSON.parse(await fs.readFile(analysisCachePath, "utf8"));
assert.equal(analysisCache.verificationStatus, "passed");
const { inspectSourceAnalysisCache } = await import("@image-to-ppt/cli");
const cacheStatus = await inspectSourceAnalysisCache({ sourcePath: source, cachePath: analysisCachePath });
assert.equal(cacheStatus.status, "hit");
assert.equal("analysis" in cacheStatus, false);
const finalBundle = JSON.parse(await fs.readFile(output.replace(/\.pptx$/, ".task-bundle.json"), "utf8"));
const { loadDefaultSchema, validateTaskBundle } = await import("@image-to-ppt/core");
assert.equal(validateTaskBundle(finalBundle, loadDefaultSchema()).ok, true);
assert.equal(finalBundle.bundlePhase, "final");
const manifest = JSON.parse(await fs.readFile(output.replace(/\.pptx$/, ".object-manifest.json"), "utf8"));
assert.equal(manifest.filter((item) => item.kind === "text" && !item.virtual).length, 9);
const completed = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [checkpoint, "complete", "--workspace", dir], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("exit", (code) => resolve({ code, stdout, stderr }));
});
assert.equal(completed.code, 0, completed.stderr);
assert.equal(JSON.parse(completed.stdout).status, "complete");

const oldIr = path.join(dir, "old-visual-ir.json");
await fs.writeFile(oldIr, JSON.stringify({ version: "4.0", document: {}, scene: {} }));
const rejected = await run([source, "--bundle", oldIr, "--output", path.join(dir, "old.pptx")]);
assert.notEqual(rejected.code, 0, "旧 Visual IR 4.0 必须被新技能拒绝");

console.log(JSON.stringify({ status: "passed", output, finalArtifactCount: finalBundle.artifacts.length }, null, 2));
