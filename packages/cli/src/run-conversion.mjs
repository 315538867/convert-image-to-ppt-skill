import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { bindSourceInput, applyVerificationEvidence, materializeTaskOutput } from "@image-to-ppt/core/materialize";
import { loadDefaultSchema, validateTaskBundle } from "@image-to-ppt/core/validate";
import { renderPptxFromBundle } from "@image-to-ppt/renderer-pptx/render";
import { createReviewSheet } from "./review-sheet.mjs";
import { probeSourceCoverage } from "./source-coverage.mjs";
import { writeSourceAnalysisCache } from "./source-analysis-cache.mjs";
import { verifyCandidate } from "./verify-candidate.mjs";

function assertValid(bundle, schema, stage) {
  const result = validateTaskBundle(bundle, schema);
  if (!result.ok) throw new Error(`${stage}任务束无效:\n${JSON.stringify(result.errors, null, 2)}`);
}

function sourcePixels(length) {
  if (length.unit === "px") return length.value;
  if (length.unit === "pt") return length.value * (96 / 72);
  if (length.unit === "emu") return length.value / 9525;
  return null;
}

function visibleFill(style) {
  if (style.fill.kind === "none") return false;
  if (style.fill.kind === "solid") return style.fill.color.alpha * style.opacity > 0;
  return style.fill.stops.some((stop) => stop.color.alpha * style.opacity > 0);
}

function visibleBorder(border, style) {
  return border.style !== "none" && border.color.alpha * style.opacity > 0 && sourcePixels(border.width) > 0;
}

function expandBox(box, amount) {
  return { x: box.x - amount, y: box.y - amount, width: box.width + amount * 2, height: box.height + amount * 2 };
}

function intersects(left, right) {
  return left.x < right.x + right.width && left.x + left.width > right.x
    && left.y < right.y + right.height && left.y + left.height > right.y;
}

function borderRegion(node, side, border, tolerance = 3) {
  const width = sourcePixels(border.width);
  if (!(width > 0)) return null;
  const outer = border.alignment === "outside" ? width : border.alignment === "center" ? width / 2 : 0;
  const box = node.box;
  let result;
  if (side === "top") result = { x: box.x - outer, y: box.y - outer, width: box.width + outer * 2, height: width };
  else if (side === "right") result = { x: box.x + box.width - width + outer, y: box.y - outer, width, height: box.height + outer * 2 };
  else if (side === "bottom") result = { x: box.x - outer, y: box.y + box.height - width + outer, width: box.width + outer * 2, height: width };
  else result = { x: box.x - outer, y: box.y - outer, width, height: box.height + outer * 2 };
  return expandBox(result, tolerance);
}

function semanticRegions(bundle) {
  const semantic = bundle.artifacts.find((artifact) => artifact.artifactType === "semantic-plane");
  const regions = [];
  function flatten(node, result) {
    result.push(node);
    [...node.children].sort((left, right) => left.paintOrder - right.paintOrder).forEach((child) => flatten(child, result));
  }
  function occluderBox(node) {
    if (node.box.coordinateSpace !== "source-canvas") return null;
    if (node.kind === "text") return node.text.inkBox;
    if (["icon", "image", "connector"].includes(node.kind)) return node.box;
    if (visibleFill(node.computedStyle)) return node.box;
    return null;
  }
  function visit(node, slideId, laterNodes) {
    if (node.box.coordinateSpace === "source-canvas") {
      if (node.kind === "text") {
        regions.push({ regionId: `semantic:${slideId}:${node.nodeId}:text-ink`, category: "text", bbox: expandBox(node.text.inkBox, 2) });
      } else if (node.kind === "icon") {
        regions.push({ regionId: `semantic:${slideId}:${node.nodeId}:icon`, category: "simple-icon", bbox: node.box });
      } else if (node.kind === "image") {
        regions.push({ regionId: `semantic:${slideId}:${node.nodeId}:image`, category: "image", bbox: node.box });
      } else if (node.kind === "connector") {
        regions.push({ regionId: `semantic:${slideId}:${node.nodeId}:connector`, category: "connector", bbox: node.box });
      }
      if (visibleFill(node.computedStyle)) {
        const excludeBboxes = laterNodes.map(occluderBox).filter((box) => box && intersects(node.box, box));
        regions.push({
          regionId: `semantic:${slideId}:${node.nodeId}:fill`,
          category: "color",
          bbox: node.box,
          excludeBboxes,
          pixelMode: "flat-color",
        });
      }
      for (const [side, border] of Object.entries(node.computedStyle.borders)) {
        if (!visibleBorder(border, node.computedStyle)) continue;
        const bbox = borderRegion(node, side, border);
        if (bbox) regions.push({ regionId: `semantic:${slideId}:${node.nodeId}:border-${side}`, category: "border", bbox });
      }
    }
  }
  for (const slide of semantic?.body.slides ?? []) {
    const nodes = [];
    flatten(slide.root, nodes);
    nodes.forEach((node, index) => visit(node, slide.slideId, nodes.slice(index + 1)));
  }
  return regions;
}

export function protectedRegions(bundle) {
  const observation = bundle.artifacts.find((artifact) => artifact.artifactType === "observation-plane");
  const category = {
    text: "text",
    icon: "simple-icon",
    edge: "border",
    shape: "shape",
    image: "image",
    spacing: "spacing",
    color: "color",
  };
  const observed = (observation?.body.observations ?? []).map((item) => ({
    regionId: item.observationId,
    category: category[item.kind] ?? "generic",
    bbox: item.box,
    ...(item.kind === "color" ? { pixelMode: "flat-color" } : {}),
  }));
  return [...observed, ...semanticRegions(bundle)];
}

async function loadAssets(assetMapPath) {
  if (!assetMapPath) return { blobs: undefined, imageSizes: undefined };
  const map = JSON.parse(await fs.readFile(assetMapPath, "utf8"));
  const blobs = {};
  const imageSizes = {};
  for (const [digest, filePath] of Object.entries(map)) {
    blobs[digest] = await fs.readFile(filePath);
    const metadata = await sharp(filePath).metadata();
    imageSizes[digest] = { width: metadata.width, height: metadata.height };
  }
  return { blobs, imageSizes };
}

function outputFiles(stem, analysisCachePath) {
  return {
    manifestPath: `${stem}.object-manifest.json`,
    layoutPath: `${stem}.layout.json`,
    previewPath: `${stem}.preview.png`,
    diffPath: `${stem}.diff.png`,
    reviewSheetPath: `${stem}.review-sheet.png`,
    sourceAnalysisCachePath: analysisCachePath ?? `${stem}.source-analysis-cache.json`,
    verificationPath: `${stem}.verification.json`,
    coveragePath: `${stem}.source-coverage.json`,
    coverageOverlayPath: `${stem}.source-coverage-overlay.png`,
    buildLogPath: `${stem}.build-log.json`,
    environmentSnapshotPath: `${stem}.environment.json`,
    finalBundlePath: `${stem}.task-bundle.json`,
  };
}

async function copyDiagnostics(workingFiles, targetFiles) {
  const diagnosticKeys = [
    "manifestPath", "layoutPath", "previewPath", "diffPath", "reviewSheetPath", "verificationPath",
    "coveragePath", "coverageOverlayPath", "buildLogPath", "environmentSnapshotPath",
  ];
  for (const key of diagnosticKeys) {
    try {
      await fs.copyFile(workingFiles[key], targetFiles[key]);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function promoteCandidate(candidateOutputPath, outputPath, workingFiles, targetFiles) {
  await fs.rm(outputPath, { force: true });
  await fs.rename(candidateOutputPath, outputPath);
  for (const key of Object.keys(targetFiles)) {
    if (key === "sourceAnalysisCachePath") continue;
    if (workingFiles[key] === targetFiles[key]) continue;
    await fs.rm(targetFiles[key], { force: true });
    await fs.rename(workingFiles[key], targetFiles[key]);
  }
}

export async function runConversion({ sourcePath, bundlePath, outputPath, assetMapPath, analysisCachePath, strict = true }) {
  const schema = loadDefaultSchema();
  const outputDir = path.dirname(outputPath);
  await fs.mkdir(outputDir, { recursive: true });
  if (strict) {
    await Promise.all([
      fs.rm(outputPath, { force: true }),
      fs.rm(outputPath.replace(/\.pptx$/i, ".task-bundle.json"), { force: true }),
    ]);
  }
  const metadata = await sharp(sourcePath).metadata();
  if (!metadata.width || !metadata.height || !metadata.format) throw new Error("源图片缺少可验证的尺寸或格式");
  const mediaType = metadata.format === "jpeg" ? "image/jpeg" : `image/${metadata.format}`;
  const authored = JSON.parse(await fs.readFile(bundlePath, "utf8"));
  const bundle = await bindSourceInput(authored, sourcePath, mediaType, schema);
  assertValid(bundle, schema, "绑定源后的");
  const page = bundle.artifacts.find((artifact) => artifact.artifactType === "source-plane").body.pages[0];
  if (page.canvas.width !== metadata.width || page.canvas.height !== metadata.height) {
    throw new Error(`源图片尺寸与任务束不一致: ${metadata.width}x${metadata.height} != ${page.canvas.width}x${page.canvas.height}`);
  }

  const stem = outputPath.replace(/\.pptx$/i, "");
  const files = outputFiles(stem, analysisCachePath);
  const candidateDir = strict ? await fs.mkdtemp(path.join(outputDir, ".img2ppt-candidate-")) : null;
  const candidateOutputPath = candidateDir ? path.join(candidateDir, path.basename(outputPath)) : outputPath;
  const candidateStem = candidateOutputPath.replace(/\.pptx$/i, "");
  const workingFiles = candidateDir ? outputFiles(candidateStem, files.sourceAnalysisCachePath) : files;
  try {
    const assets = await loadAssets(assetMapPath);
    const rendered = await renderPptxFromBundle(bundle, candidateOutputPath, {
      ...assets,
      manifestPath: workingFiles.manifestPath,
      layoutPath: workingFiles.layoutPath,
      previewPath: workingFiles.previewPath,
      requireNativeTextMetrics: true,
    });
    const coverage = await probeSourceCoverage(bundle, sourcePath, { reportPath: workingFiles.coveragePath, overlayPath: workingFiles.coverageOverlayPath });
    const verification = await verifyCandidate({
      sourcePath,
      previewPath: workingFiles.previewPath,
      pptxPath: candidateOutputPath,
      manifestPath: workingFiles.manifestPath,
      regions: protectedRegions(bundle),
      diffPath: workingFiles.diffPath,
      reportPath: workingFiles.verificationPath,
    });
    const reviewSheet = await createReviewSheet({
      sourcePath,
      renderedPath: workingFiles.previewPath,
      visual: verification.visual,
      outputPath: workingFiles.reviewSheetPath,
    });
    const analysisCache = await writeSourceAnalysisCache({
      bundle,
      sourcePath,
      cachePath: files.sourceAnalysisCachePath,
      verificationStatus: verification.status,
    });
    await fs.writeFile(workingFiles.buildLogPath, `${JSON.stringify({ analysisCache, reviewSheet, sourceCoverage: coverage, verification, outputPptxBlobDigest: rendered.outputPptxBlobDigest }, null, 2)}\n`);
    await fs.writeFile(workingFiles.environmentSnapshotPath, `${JSON.stringify({ runtime: process.version, platform: process.platform, arch: process.arch, network: "disabled-by-core-policy" }, null, 2)}\n`);
    if (strict && (coverage.status !== "passed" || verification.status !== "passed")) {
      await copyDiagnostics(workingFiles, files);
      throw new Error(`质量门槛失败，候选 PPTX 未发布: sourceCoverage=${coverage.status}, verification=${verification.status}`);
    }
    const evidenced = applyVerificationEvidence(bundle, verification, coverage, schema);
    const finalBundle = await materializeTaskOutput(evidenced, {
      pptxPath: candidateOutputPath,
      previewPath: workingFiles.previewPath,
      manifestPath: workingFiles.manifestPath,
      layoutPath: workingFiles.layoutPath,
      diffPath: workingFiles.diffPath,
      coveragePath: workingFiles.coveragePath,
      coverageOverlayPath: workingFiles.coverageOverlayPath,
      verificationPath: workingFiles.verificationPath,
      buildLogPath: workingFiles.buildLogPath,
      environmentSnapshotPath: workingFiles.environmentSnapshotPath,
    }, schema);
    assertValid(finalBundle, schema, "最终");
    await fs.writeFile(workingFiles.finalBundlePath, `${JSON.stringify(finalBundle, null, 2)}\n`);
    if (candidateDir) await promoteCandidate(candidateOutputPath, outputPath, workingFiles, files);
    return { outputPath, files, analysisCache, reviewSheet, coverage, verification, finalBundle };
  } finally {
    if (candidateDir) await fs.rm(candidateDir, { recursive: true, force: true });
  }
}
