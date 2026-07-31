import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { bodyDigestFor } from "./canonical.mjs";
import { compileRenderPlane } from "./compile-render-plane.mjs";
import { rebuildArtifactGraph } from "./materialize-task-output.mjs";
import { loadDefaultSchema, validateTaskBundle } from "./validate-task-bundle.mjs";

function walk(node, visit) {
  visit(node);
  node.children.forEach((child) => walk(child, visit));
}

export function prepareAuthoredBundle(bundle, schema = loadDefaultSchema()) {
  const nextBundle = structuredClone(bundle);
  nextBundle.bundlePhase = "authoring";
  const semantic = nextBundle.artifacts.find((artifact) => artifact.artifactType === "semantic-plane");
  const render = nextBundle.artifacts.find((artifact) => artifact.artifactType === "render-plane");
  if (!semantic || !render) throw new Error("作者任务束缺少 Semantic Plane 或 Render Plane");
  semantic.body.styleResolutionProofs = [];
  for (const slide of semantic.body.slides) walk(slide.root, (node) => {
    semantic.body.styleResolutionProofs.push({
      nodeId: node.nodeId,
      declaredStyleDigest: bodyDigestFor(node.declaredStyle),
      computedStyleDigest: bodyDigestFor(node.computedStyle),
    });
  });
  render.body = compileRenderPlane(semantic, { scaleX: 0.75, scaleY: 0.75 });
  const ownership = nextBundle.artifacts.find((artifact) => artifact.artifactType === "ownership-plane");
  if (ownership) {
    ownership.body.coverage.sourcePixelCoverage = 0;
    ownership.body.coverage.sourceEdgeCoverage = 0;
  }
  for (const report of nextBundle.artifacts.filter((artifact) => artifact.artifactType === "evidence-report")) {
    for (const claim of report.body.claims) claim.value = 0;
  }
  for (const proof of nextBundle.artifacts.filter((artifact) => artifact.artifactType === "semantic-equivalence-proof")) {
    proof.body.status = "pending";
  }
  const verification = nextBundle.artifacts.find((artifact) => artifact.artifactType === "verification-plane");
  if (verification) verification.body.verificationStatus = "pending";
  const selection = nextBundle.artifacts.find((artifact) => artifact.artifactType === "selection-decision");
  if (selection) selection.body.status = "pending";
  const terminal = nextBundle.artifacts.find((artifact) => artifact.artifactType === "task-terminal-decision");
  if (terminal) {
    terminal.body.status = "pending-verification";
    terminal.body.reasonCodes = ["awaiting-measured-evidence"];
  }
  return rebuildArtifactGraph(nextBundle, schema);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) {
    console.error("用法: node prepare-authored-bundle.mjs <authored.json> <prepared.json>");
    process.exit(2);
  }
  const prepared = prepareAuthoredBundle(JSON.parse(await fs.readFile(inputPath, "utf8")));
  const validation = validateTaskBundle(prepared, loadDefaultSchema());
  if (!validation.ok) throw new Error(JSON.stringify(validation.errors, null, 2));
  await fs.writeFile(outputPath, `${JSON.stringify(prepared, null, 2)}\n`);
  console.log(outputPath);
}
