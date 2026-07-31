import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_EXPORTS = ["FileBlob", "Presentation", "PresentationFile"];

function defaultArtifactToolPath() {
  return path.join(
    os.homedir(),
    ".cache",
    "codex-runtimes",
    "codex-primary-runtime",
    "dependencies",
    "node",
    "node_modules",
    "@oai",
    "artifact-tool",
  );
}

async function entryPath(candidate) {
  const stats = await fs.stat(candidate);
  if (stats.isFile()) return candidate;
  if (!stats.isDirectory()) throw new Error("路径既不是文件也不是目录");
  const manifest = JSON.parse(await fs.readFile(path.join(candidate, "package.json"), "utf8"));
  const exported = typeof manifest.exports?.["."] === "string" ? manifest.exports["."] : undefined;
  const entry = exported ?? manifest.module ?? manifest.main;
  if (!entry) throw new Error("package.json 未声明入口");
  return path.join(candidate, entry);
}

function assertExports(module, source) {
  const missing = REQUIRED_EXPORTS.filter((name) => !(name in module));
  if (missing.length) throw new Error(`${source} 缺少导出: ${missing.join(", ")}`);
  return module;
}

async function loadArtifactTool() {
  const failures = [];
  try {
    return {
      module: assertExports(await import("@oai/artifact-tool"), "@oai/artifact-tool"),
      source: "node-resolution:@oai/artifact-tool",
    };
  } catch (error) {
    failures.push(`Node 模块解析: ${error.message}`);
  }

  const candidates = [process.env.CODEX_ARTIFACT_TOOL_PATH, defaultArtifactToolPath()].filter(Boolean);
  for (const candidate of [...new Set(candidates.map((value) => path.resolve(value)))]) {
    try {
      const entry = await entryPath(candidate);
      return {
        module: assertExports(await import(pathToFileURL(entry).href), candidate),
        source: candidate,
      };
    } catch (error) {
      failures.push(`${candidate}: ${error.message}`);
    }
  }

  throw new Error(
    "缺少 PPTX 运行依赖 @oai/artifact-tool。请在 Codex 工作区中运行，"
    + "或通过 CODEX_ARTIFACT_TOOL_PATH 指向包目录或入口文件。\n"
    + failures.map((item) => `- ${item}`).join("\n"),
  );
}

const loaded = await loadArtifactTool();

export const artifactToolSource = loaded.source;
export const FileBlob = loaded.module.FileBlob;
export const Presentation = loaded.module.Presentation;
export const PresentationFile = loaded.module.PresentationFile;
