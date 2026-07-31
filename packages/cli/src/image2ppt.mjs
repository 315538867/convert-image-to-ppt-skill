#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function usage() {
  console.error("用法: image2ppt <source.png> --bundle <authored-task-bundle.json> --output <result.pptx> [--asset-map <digest-path-map.json>] [--analysis-cache <source-analysis-cache.json>]");
  process.exit(2);
}

async function main() {
  const sourcePath = process.argv[2];
  const bundlePath = argument("--bundle");
  const outputPath = argument("--output");
  if (!sourcePath || sourcePath.startsWith("-") || !bundlePath || !outputPath) usage();
  const [{ prepareAuthoredBundle }, { runConversion }, { loadDefaultSchema }] = await Promise.all([
    import("@image-to-ppt/core/prepare"),
    import("./run-conversion.mjs"),
    import("@image-to-ppt/core/validate"),
  ]);
  const authored = JSON.parse(await fs.readFile(bundlePath, "utf8"));
  const prepared = prepareAuthoredBundle(authored, loadDefaultSchema());
  const preparedPath = outputPath.replace(/\.pptx$/i, ".prepared-task-bundle.json");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(preparedPath, `${JSON.stringify(prepared, null, 2)}\n`);
  const result = await runConversion({
    sourcePath: path.resolve(sourcePath),
    bundlePath: preparedPath,
    outputPath: path.resolve(outputPath),
    assetMapPath: argument("--asset-map"),
    analysisCachePath: argument("--analysis-cache"),
    strict: true,
  });
  console.log(JSON.stringify({
    pptx: result.outputPath,
    taskBundle: result.files.finalBundlePath,
    preview: result.files.previewPath,
    diff: result.files.diffPath,
    reviewSheet: result.files.reviewSheetPath,
    sourceAnalysisCache: result.files.sourceAnalysisCachePath,
    analysisCacheStatus: result.analysisCache.status,
    sourceCoverage: result.files.coveragePath,
    sourceCoverageOverlay: result.files.coverageOverlayPath,
    verification: result.files.verificationPath,
    status: "passed",
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
