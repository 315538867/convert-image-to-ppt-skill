#!/usr/bin/env node
import path from "node:path";
import { runV2Conversion } from "./run-v2-conversion.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function usage() {
  console.error("用法: image2ppt <source-image> --contracts <v2-author-contracts.json> --workspace <workspace-dir> [--run-id <run-id>]");
  process.exit(2);
}

async function main() {
  const sourcePath = process.argv[2];
  const contractsPath = argument("--contracts");
  const workspaceDir = argument("--workspace");
  if (!sourcePath || sourcePath.startsWith("-") || !contractsPath || !workspaceDir) usage();
  const result = await runV2Conversion({
    sourcePath: path.resolve(sourcePath),
    contractsPath: path.resolve(contractsPath),
    workspaceDir: path.resolve(workspaceDir),
    runId: argument("--run-id"),
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
