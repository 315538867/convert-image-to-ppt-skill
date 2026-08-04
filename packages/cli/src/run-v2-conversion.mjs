import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { compileResolvedScene, validateV2Contracts } from "@image-to-ppt/core";
import { FileBlob, PresentationFile, generateBackendPlan, renderPptxFromBackendPlan } from "@image-to-ppt/renderer-pptx";
import { normalizeSource } from "./source-normalizer.mjs";
import { verifyV2Candidate } from "./verify-v2-candidate.mjs";
import { createRunWorkspace, publishRun, writeFailedRunDiagnostics } from "./transactional-publisher.mjs";

function contractOf(contracts, kind) {
  const matches = contracts.filter((contract) => contract.contractKind === kind);
  if (matches.length !== 1) throw new Error(`V2 转换要求恰好一个 ${kind} 契约，实际 ${matches.length}`);
  return matches[0];
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function exportPreviews(pptxPath, pageIds, outputDir) {
  const presentation = await PresentationFile.importPptx(await FileBlob.load(pptxPath));
  const renderedPagePaths = {};
  await fs.mkdir(outputDir, { recursive: true });
  for (const [index, pageId] of pageIds.entries()) {
    const blob = await presentation.export({ slide: presentation.slides.items[index], format: "png", scale: 1 });
    const previewPath = path.join(outputDir, `${pageId}.preview.png`);
    await fs.writeFile(previewPath, new Uint8Array(await blob.arrayBuffer()));
    renderedPagePaths[pageId] = previewPath;
  }
  return renderedPagePaths;
}

function boxAttrs(box) {
  return `x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}"`;
}

async function writeSourceOverlay({ sourcePackage, canonicalPreviewPath, evidenceGraph, resolvedScene, outputPath }) {
  const page = sourcePackage.pages[0];
  const evidenceRects = (evidenceGraph.evidence ?? []).flatMap((item) => (item.sourceRegions ?? [])
    .filter((region) => region.pageId === page.pageId)
    .map((region) => `<rect ${boxAttrs(region.box)} fill="none" stroke="#00A86B" stroke-width="2" vector-effect="non-scaling-stroke"/>`));
  const sceneRects = (resolvedScene.pages.find((candidate) => candidate.sourcePageRef === page.pageId)?.nodes ?? [])
    .filter((node) => node.worldBounds?.effect)
    .map((node) => `<rect ${boxAttrs(node.worldBounds.effect)} fill="none" stroke="#D0021B" stroke-width="1.5" stroke-dasharray="5 3" vector-effect="non-scaling-stroke"/>`);
  const svg = Buffer.from([
    `<svg xmlns="http://www.w3.org/2000/svg" width="${page.canvas.width}" height="${page.canvas.height}" viewBox="0 0 ${page.canvas.width} ${page.canvas.height}">`,
    ...evidenceRects,
    ...sceneRects,
    "</svg>",
  ].join(""));
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await sharp(canonicalPreviewPath).composite([{ input: svg, left: 0, top: 0 }]).png().toFile(outputPath);
}

async function writeReviewSheet({ canonicalPreviewPath, renderedPagePaths, diffPaths, sourceOverlayPath, outputPath }) {
  const firstPreview = Object.values(renderedPagePaths)[0];
  const firstDiff = Object.values(diffPaths)[0];
  const inputs = [canonicalPreviewPath, firstPreview, firstDiff, sourceOverlayPath].filter(Boolean);
  const images = await Promise.all(inputs.map(async (filePath) => {
    const image = sharp(filePath).flatten({ background: "#FFFFFF" }).png();
    const metadata = await image.metadata();
    return { filePath, width: metadata.width, height: metadata.height, buffer: await image.toBuffer() };
  }));
  if (!images.length) throw new Error("Review Sheet 缺少可组合图片");
  const gap = 24;
  const labelHeight = 32;
  const cellWidth = Math.max(...images.map((image) => image.width));
  const cellHeight = Math.max(...images.map((image) => image.height));
  const width = images.length * cellWidth + (images.length - 1) * gap;
  const height = cellHeight + labelHeight;
  const labels = ["source", "rendered", "diff", "source-overlay"];
  const labelSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <style>text{font-family:Arial,sans-serif;font-size:16px;fill:#222}</style>
    ${labels.slice(0, images.length).map((label, index) => `<text x="${index * (cellWidth + gap)}" y="22">${label}</text>`).join("")}
  </svg>`);
  const composites = images.map((image, index) => ({
    input: image.buffer,
    left: index * (cellWidth + gap),
    top: labelHeight,
  }));
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await sharp({ create: { width, height, channels: 4, background: "#FFFFFF" } })
    .composite([{ input: labelSvg, left: 0, top: 0 }, ...composites])
    .png()
    .toFile(outputPath);
}

function sourceBlobPathMap(sourcePackage, normalized) {
  return {
    rawBlobPaths: { [sourcePackage.rawBlob.digest]: normalized.rawBlobPath },
    canonicalPixelPaths: { [sourcePackage.canonicalPixels.digest]: normalized.canonicalPixelsPath },
  };
}

function outputSpecs(runDir, renderedPagePaths, diffPaths) {
  return [
    { filePath: path.join(runDir, "output.pptx"), mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", role: "pptx-output" },
    { filePath: path.join(runDir, "source-package.json"), mediaType: "application/json", role: "source-package" },
    { filePath: path.join(runDir, "resolved-scene.json"), mediaType: "application/json", role: "resolved-scene" },
    { filePath: path.join(runDir, "backend-plan.json"), mediaType: "application/json", role: "backend-plan" },
    { filePath: path.join(runDir, "object-manifest.json"), mediaType: "application/json", role: "object-manifest" },
    { filePath: path.join(runDir, "verification-result.json"), mediaType: "application/json", role: "verification-result" },
    { filePath: path.join(runDir, "source-overlay.png"), mediaType: "image/png", role: "source-overlay" },
    { filePath: path.join(runDir, "review-sheet.png"), mediaType: "image/png", role: "review-sheet" },
    ...Object.values(renderedPagePaths).map((filePath) => ({ filePath, mediaType: "image/png", role: "preview" })),
    ...Object.values(diffPaths).map((filePath) => ({ filePath, mediaType: "image/png", role: "visual-diff" })),
  ];
}

export async function runV2Conversion({
  sourcePath,
  contractsPath,
  workspaceDir,
  runId,
  visualThresholds,
}) {
  if (!sourcePath || !contractsPath || !workspaceDir) throw new Error("V2 转换需要 sourcePath、contractsPath 和 workspaceDir");
  const run = await createRunWorkspace({ workspaceDir, runId });
  const sourcePackagePath = path.join(run.runDir, "source-package.json");
  const normalized = await normalizeSource({
    sourcePath,
    sourcePackagePath,
    blobDir: path.join(run.runDir, "blobs"),
  });
  const sourcePackage = normalized.sourcePackage;
  const input = JSON.parse(await fs.readFile(contractsPath, "utf8"));
  const contracts = Array.isArray(input.contracts) ? input.contracts : [input];
  const reconstructionSpec = contractOf(contracts, "reconstruction-spec");
  const evidenceGraph = contractOf(contracts, "evidence-graph");
  const authorValidation = validateV2Contracts({ schemaVersion: 2, contracts: [sourcePackage, reconstructionSpec, evidenceGraph] });
  if (!authorValidation.ok) {
    const error = new Error(`V2 作者契约校验失败:\n${authorValidation.errors.map((item) => `${item.code}: ${item.message}`).join("\n")}`);
    error.validationErrors = authorValidation.errors;
    throw error;
  }

  const resolvedScene = compileResolvedScene({ sourcePackages: [sourcePackage], reconstructionSpec, evidenceGraph });
  const backendPlan = generateBackendPlan(resolvedScene);
  const pptxPath = path.join(run.runDir, "output.pptx");
  const manifestPath = path.join(run.runDir, "object-manifest.json");
  const rendered = await renderPptxFromBackendPlan(backendPlan, new Map(), pptxPath, { manifestPath });
  const renderedPagePaths = await exportPreviews(pptxPath, sourcePackage.pages.map((page) => page.pageId), path.join(run.runDir, "previews"));
  const diffDir = path.join(run.runDir, "diffs");
  await fs.mkdir(diffDir, { recursive: true });
  const diffPaths = Object.fromEntries(sourcePackage.pages.map((page) => [page.pageId, path.join(diffDir, `${page.pageId}.diff.png`)]));
  await writeJson(path.join(run.runDir, "resolved-scene.json"), resolvedScene);
  await writeJson(path.join(run.runDir, "backend-plan.json"), backendPlan);

  const verificationResult = await verifyV2Candidate({
    sourcePackages: [sourcePackage],
    reconstructionSpec,
    evidenceGraph,
    resolvedScene,
    backendPlan,
    objectManifest: rendered.objectManifest,
    pptxPath,
    ...sourceBlobPathMap(sourcePackage, normalized),
    renderedPagePaths,
    visualThresholds,
    diffDir,
    reportPath: path.join(run.runDir, "verification-result.json"),
  });

  const sourceOverlayPath = path.join(run.runDir, "source-overlay.png");
  await writeSourceOverlay({ sourcePackage, canonicalPreviewPath: normalized.canonicalPreviewPath, evidenceGraph, resolvedScene, outputPath: sourceOverlayPath });
  const reviewSheetPath = path.join(run.runDir, "review-sheet.png");
  await writeReviewSheet({ canonicalPreviewPath: normalized.canonicalPreviewPath, renderedPagePaths, diffPaths, sourceOverlayPath, outputPath: reviewSheetPath });

  if (verificationResult.status !== "passed") {
    await writeFailedRunDiagnostics({
      workspaceDir,
      runId: run.runId,
      verificationResult,
      diagnostics: { status: { message: "质量门槛失败，未发布 Delivery Manifest" } },
    });
    const error = new Error(`质量门槛失败，运行已保留但未发布: ${run.runId}`);
    error.verificationResult = verificationResult;
    error.runDir = run.runDir;
    throw error;
  }

  const publication = await publishRun({
    workspaceDir,
    runId: run.runId,
    sourcePackages: [sourcePackage],
    verificationResult,
    validationContracts: [reconstructionSpec, evidenceGraph, resolvedScene, backendPlan, rendered.objectManifest],
    outputs: outputSpecs(run.runDir, renderedPagePaths, diffPaths),
  });
  return {
    status: "passed",
    workspaceDir,
    runId: run.runId,
    runDir: run.runDir,
    current: publication.relativeDeliveryManifestPath,
    deliveryManifest: publication.deliveryManifestPath,
    sourcePackagePath,
    resolvedScenePath: path.join(run.runDir, "resolved-scene.json"),
    backendPlanPath: path.join(run.runDir, "backend-plan.json"),
    objectManifestPath: manifestPath,
    verificationResultPath: path.join(run.runDir, "verification-result.json"),
    pptxPath,
    renderedPagePaths,
    diffPaths,
    sourceOverlayPath,
    reviewSheetPath,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sourcePath, contractsPath, workspaceDir] = process.argv.slice(2);
  if (!sourcePath || !contractsPath || !workspaceDir) {
    console.error("用法: node packages/cli/src/run-v2-conversion.mjs <source-image> <v2-author-contracts.json> <workspace-dir>");
    process.exit(2);
  }
  const result = await runV2Conversion({
    sourcePath: path.resolve(sourcePath),
    contractsPath: path.resolve(contractsPath),
    workspaceDir: path.resolve(workspaceDir),
  });
  console.log(JSON.stringify(result, null, 2));
}
