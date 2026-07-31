#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { sha256BytesDigest } from "@image-to-ppt/core/canonical";
import { authoringTemplatePath } from "@image-to-ppt/core/resources";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function pathsFor(workspace) {
  return {
    workspace,
    workDir: path.join(workspace, "work"),
    outputsDir: path.join(workspace, "outputs"),
    statePath: path.join(workspace, "work", "task-state.json"),
    authoringBundlePath: path.join(workspace, "work", "authoring-task-bundle.json"),
    analysisCachePath: path.join(workspace, "outputs", "source-analysis-cache.json"),
    outputPptxPath: path.join(workspace, "outputs", "result.pptx"),
  };
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function initialize(sourcePath, workspace) {
  const files = pathsFor(workspace);
  const sourceBytes = await fs.readFile(sourcePath);
  const sourceDigest = sha256BytesDigest(sourceBytes);
  const metadata = await sharp(sourcePath).metadata();
  if (!metadata.width || !metadata.height) throw new Error("源图片缺少有效尺寸");
  await Promise.all([
    fs.mkdir(files.workDir, { recursive: true }),
    fs.mkdir(files.outputsDir, { recursive: true }),
  ]);

  if (await exists(files.statePath)) {
    const current = await readJson(files.statePath);
    if (current.source.digest !== sourceDigest) {
      throw new Error("当前工作区已绑定另一张源图片；请使用新的任务目录，禁止覆盖检查点");
    }
    return { checkpoint: "resumed", ...current, files };
  }

  await fs.copyFile(authoringTemplatePath, files.authoringBundlePath);
  const state = {
    stateVersion: 1,
    status: "initialized",
    source: {
      path: path.resolve(sourcePath),
      digest: sourceDigest,
      width: metadata.width,
      height: metadata.height,
    },
    authoringBundlePath: files.authoringBundlePath,
    analysisCachePath: files.analysisCachePath,
    outputPptxPath: files.outputPptxPath,
    requiredOutputs: [
      "result.pptx",
      "result.task-bundle.json",
      "result.object-manifest.json",
      "result.preview.png",
      "result.diff.png",
      "result.review-sheet.png",
      "result.source-coverage.json",
      "result.source-coverage-overlay.png",
      "result.verification.json",
      "result.layout.json",
      "result.build-log.json",
      "result.environment.json",
      "source-analysis-cache.json",
    ],
  };
  await fs.writeFile(files.statePath, `${JSON.stringify(state, null, 2)}\n`);
  return { checkpoint: "created", ...state, files };
}

async function status(workspace, requireComplete = false) {
  const files = pathsFor(workspace);
  if (!(await exists(files.statePath))) throw new Error("任务尚未初始化；先运行 task-checkpoint.mjs init");
  const state = await readJson(files.statePath);
  const present = [];
  const missing = [];
  for (const name of state.requiredOutputs) {
    if (await exists(path.join(files.outputsDir, name))) present.push(name);
    else missing.push(name);
  }
  let verificationStatus = "missing";
  let bundlePhase = "missing";
  if (await exists(path.join(files.outputsDir, "result.verification.json"))) {
    verificationStatus = (await readJson(path.join(files.outputsDir, "result.verification.json"))).status;
  }
  if (await exists(path.join(files.outputsDir, "result.task-bundle.json"))) {
    bundlePhase = (await readJson(path.join(files.outputsDir, "result.task-bundle.json"))).bundlePhase;
  }
  const complete = missing.length === 0 && verificationStatus === "passed" && bundlePhase === "final";
  const result = {
    status: complete ? "complete" : "in-progress",
    sourceDigest: state.source.digest,
    presentCount: present.length,
    requiredCount: state.requiredOutputs.length,
    missing,
    verificationStatus,
    bundlePhase,
  };
  if (requireComplete && !complete) {
    const error = new Error(`任务未完成: ${JSON.stringify(result)}`);
    error.result = result;
    throw error;
  }
  return result;
}

async function main() {
  const command = process.argv[2];
  const workspace = path.resolve(argument("--workspace") ?? process.cwd());
  if (command === "init") {
    const sourcePath = process.argv[3];
    if (!sourcePath || sourcePath.startsWith("--")) throw new Error("用法: task-checkpoint.mjs init <source.png> [--workspace <dir>]");
    console.log(JSON.stringify(await initialize(path.resolve(sourcePath), workspace), null, 2));
    return;
  }
  if (command === "status" || command === "complete") {
    console.log(JSON.stringify(await status(workspace, command === "complete"), null, 2));
    return;
  }
  throw new Error("用法: task-checkpoint.mjs <init|status|complete> [source.png] [--workspace <dir>]");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
