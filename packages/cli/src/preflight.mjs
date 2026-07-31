#!/usr/bin/env node

function assertNodeVersion() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const supported = major > 20 || (major === 20 && minor >= 9);
  if (!supported) {
    throw new Error(`Node.js ${process.versions.node} 不受支持；需要 >=20.9.0`);
  }
}

async function main() {
  assertNodeVersion();
  await import("sharp");
  const artifactTool = await import("@image-to-ppt/renderer-pptx/artifact-tool");
  console.log(JSON.stringify({
    status: "passed",
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    artifactToolSource: artifactTool.artifactToolSource,
  }, null, 2));
}

main().catch((error) => {
  console.error(`运行前检查失败: ${error.message}`);
  process.exitCode = 1;
});
