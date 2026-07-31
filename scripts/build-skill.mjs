#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(projectRoot, "dist", "convert-image-to-ppt");
const scriptsDir = path.join(outputRoot, "scripts");

async function copy(source, target) {
  await fs.cp(source, target, { recursive: true });
}

async function filesUnder(directory, prefix = "") {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = path.join(prefix, entry.name);
    if (relative === "build-manifest.json") continue;
    if (entry.isDirectory()) result.push(...await filesUnder(path.join(directory, entry.name), relative));
    else result.push(relative);
  }
  return result;
}

async function main() {
  await fs.rm(outputRoot, { recursive: true, force: true });
  await fs.mkdir(scriptsDir, { recursive: true });
  await Promise.all([
    copy(path.join(projectRoot, "skill-src"), outputRoot),
    copy(path.join(projectRoot, "packages", "core", "schema"), path.join(outputRoot, "schema")),
    copy(path.join(projectRoot, "packages", "core", "examples"), path.join(outputRoot, "examples")),
  ]);

  const entries = {
    image2ppt: path.join(projectRoot, "packages", "cli", "src", "image2ppt.mjs"),
    preflight: path.join(projectRoot, "packages", "cli", "src", "preflight.mjs"),
    "task-checkpoint": path.join(projectRoot, "packages", "cli", "src", "task-checkpoint.mjs"),
  };
  await build({
    entryPoints: entries,
    outdir: scriptsDir,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    external: ["sharp", "@oai/artifact-tool"],
    logLevel: "warning",
  });
  await Promise.all([
    copy(path.join(projectRoot, "skill-runtime", "package.json"), path.join(scriptsDir, "package.json")),
    copy(path.join(projectRoot, "skill-runtime", "package-lock.json"), path.join(scriptsDir, "package-lock.json")),
    copy(path.join(projectRoot, ".npmrc"), path.join(scriptsDir, ".npmrc")),
  ]);

  const manifest = { buildVersion: 1, projectVersion: "0.1.0", files: [] };
  for (const relative of await filesUnder(outputRoot)) {
    const bytes = await fs.readFile(path.join(outputRoot, relative));
    manifest.files.push({ path: relative.split(path.sep).join("/"), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
  }
  await fs.writeFile(path.join(outputRoot, "build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ status: "built", output: outputRoot, files: manifest.files.length }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
