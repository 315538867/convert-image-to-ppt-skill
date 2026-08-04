#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { sha256BytesDigest } from "@image-to-ppt/core/canonical";
import { normalizeSource } from "./source-normalizer.mjs";
import { readCurrentPublication } from "./transactional-publisher.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function pathsFor(workspace) {
  return {
    workspace,
    workDir: path.join(workspace, "work"),
    sourcesDir: path.join(workspace, "sources"),
    runsDir: path.join(workspace, "runs"),
    statePath: path.join(workspace, "work", "task-state.json"),
    sourcePackagePath: path.join(workspace, "sources", "source-package.json"),
    sourceBlobDir: path.join(workspace, "sources", "blobs"),
    authorContractsPath: path.join(workspace, "work", "v2-author-contracts.json"),
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

function box(width, height) {
  return { x: 0, y: 0, width, height, unit: "px", coordinateSpace: "source-canvas" };
}

function emptyGroupRoot(width, height) {
  const bounds = box(width, height);
  return {
    id: "root",
    type: "group",
    geometry: {
      frame: bounds,
      transform: { kind: "affine-2d", matrix: [1, 0, 0, 1, 0, 0] },
      bounds: { layout: bounds, content: bounds, ink: bounds, effect: bounds },
      clipStack: [],
      maskStack: [],
    },
    appearance: { fills: [], strokes: [], effects: [], opacity: 1, blendMode: "normal", isolation: false },
    content: { kind: "group", semantics: [] },
    editability: { required: false, requiredAspects: [], allowedFallbacks: [] },
    evidenceRefs: [],
    children: [],
  };
}

function authorContractsScaffold(sourcePackage) {
  const page = sourcePackage.pages[0];
  return {
    schemaVersion: 2,
    contracts: [
      {
        schemaVersion: 2,
        contractKind: "reconstruction-spec",
        documentId: "document-1",
        sourcePackageRefs: [sourcePackage.sourceId],
        assetRefs: [],
        pages: [{ pageId: page.pageId, sourcePageRef: page.pageId, rootNode: emptyGroupRoot(page.canvas.width, page.canvas.height) }],
        targetIntent: {
          format: "pptx",
          editableTextRequired: true,
          simpleIconsEditableRequired: true,
          editableStructuresRequired: true,
          allowApprovedOriginalRaster: false,
        },
      },
      {
        schemaVersion: 2,
        contractKind: "evidence-graph",
        graphId: "evidence-graph-1",
        documentRef: "document-1",
        sourcePackageRefs: [sourcePackage.sourceId],
        evidence: [],
      },
    ],
  };
}

async function initialize(sourcePath, workspace) {
  const files = pathsFor(workspace);
  const sourceBytes = await fs.readFile(sourcePath);
  const sourceDigest = sha256BytesDigest(sourceBytes);
  await Promise.all([
    fs.mkdir(files.workDir, { recursive: true }),
    fs.mkdir(files.sourcesDir, { recursive: true }),
    fs.mkdir(files.runsDir, { recursive: true }),
  ]);
  if (await exists(files.statePath)) {
    const current = await readJson(files.statePath);
    if (current.source.digest !== sourceDigest) throw new Error("当前工作区已绑定另一张源图片；请使用新的任务目录，禁止覆盖检查点");
    return { checkpoint: "resumed", ...current, files };
  }
  const normalized = await normalizeSource({ sourcePath, sourcePackagePath: files.sourcePackagePath, blobDir: files.sourceBlobDir });
  await fs.writeFile(files.authorContractsPath, JSON.stringify(authorContractsScaffold(normalized.sourcePackage), null, 2) + "\n");
  const state = {
    stateVersion: 2,
    status: "initialized",
    source: { path: path.resolve(sourcePath), digest: sourceDigest, sourcePackagePath: files.sourcePackagePath },
    authorContractsPath: files.authorContractsPath,
    workspaceDir: workspace,
    requiredOutputs: ["current", "runs/<run-id>/delivery-manifest.json", "runs/<run-id>/verification-result.json", "runs/<run-id>/output.pptx"],
  };
  await fs.writeFile(files.statePath, JSON.stringify(state, null, 2) + "\n");
  return { checkpoint: "created", ...state, files };
}

async function status(workspace, requireComplete = false) {
  const files = pathsFor(workspace);
  if (!(await exists(files.statePath))) throw new Error("任务尚未初始化；先运行 task-checkpoint.mjs init");
  const state = await readJson(files.statePath);
  const current = await readCurrentPublication({ workspaceDir: workspace });
  const result = {
    status: current ? "complete" : "in-progress",
    sourceDigest: state.source.digest,
    authorContractsPath: state.authorContractsPath,
    current: current?.target ?? null,
    deliveryManifestPath: current?.manifestPath ?? null,
    runId: current?.manifest?.runId ?? null,
  };
  if (requireComplete && !current) {
    const error = new Error("任务未完成: " + JSON.stringify(result));
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
    if (!sourcePath || sourcePath.startsWith("--")) throw new Error("用法: task-checkpoint.mjs init <source-image> [--workspace <dir>]");
    console.log(JSON.stringify(await initialize(path.resolve(sourcePath), workspace), null, 2));
    return;
  }
  if (command === "status" || command === "complete") {
    console.log(JSON.stringify(await status(workspace, command === "complete"), null, 2));
    return;
  }
  throw new Error("用法: task-checkpoint.mjs <init|status|complete> [source-image] [--workspace <dir>]");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
