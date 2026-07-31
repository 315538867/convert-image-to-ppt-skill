#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(projectRoot, "dist", "convert-image-to-ppt");
const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const skillsRoot = path.join(codexHome, "skills");
const target = path.join(skillsRoot, "convert-image-to-ppt");
const staging = path.join(skillsRoot, `.convert-image-to-ppt-staging-${process.pid}`);
const backup = path.join(skillsRoot, `.convert-image-to-ppt-backup-${process.pid}`);

async function exists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function verifyBuild(root) {
  const manifest = JSON.parse(await fs.readFile(path.join(root, "build-manifest.json"), "utf8"));
  for (const entry of manifest.files) {
    const bytes = await fs.readFile(path.join(root, entry.path));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== entry.sha256 || bytes.length !== entry.bytes) {
      throw new Error(`构建产物摘要不一致: ${entry.path}`);
    }
  }
}

async function run(command, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`)));
  });
}

async function main() {
  await verifyBuild(source);
  await fs.mkdir(skillsRoot, { recursive: true });
  await fs.rm(staging, { recursive: true, force: true });
  await fs.cp(source, staging, { recursive: true });
  await run("npm", ["ci", "--prefix", path.join(staging, "scripts")]);
  await verifyBuild(staging);
  const hadTarget = await exists(target);
  if (hadTarget) await fs.rename(target, backup);
  try {
    await fs.rename(staging, target);
    if (hadTarget) await fs.rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (hadTarget && !(await exists(target))) await fs.rename(backup, target);
    throw error;
  }
  console.log(JSON.stringify({ status: "installed", source, target }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
