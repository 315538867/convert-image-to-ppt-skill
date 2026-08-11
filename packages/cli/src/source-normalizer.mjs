import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { sha256BytesDigest } from "@image-to-ppt/core/canonical";

export const SOURCE_ANALYSIS_GENERATOR = {
  name: "source-analysis-cache",
  version: "1.0.0",
};

function mediaTypeFor(format) {
  if (format === "jpeg") return "image/jpeg";
  if (format === "svg") return "image/svg+xml";
  return `image/${format}`;
}

function extensionFor(mediaType) {
  if (mediaType === "image/jpeg") return ".jpg";
  if (mediaType === "image/svg+xml") return ".svg";
  if (mediaType === "application/json") return ".json";
  if (mediaType.startsWith("image/")) return `.${mediaType.slice("image/".length)}`;
  return ".bin";
}

async function writeAtomic(filePath, bytes) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, bytes);
  await fs.rename(temporaryPath, filePath);
}

async function contentAddressedBlob({ bytes, mediaType, role, blobDir, packageDir, width, height, channels, sourceRegion }) {
  const digest = sha256BytesDigest(bytes);
  const filePath = path.join(blobDir, `${digest.slice("sha256:".length)}${extensionFor(mediaType)}`);
  await writeAtomic(filePath, bytes);
  return {
    ref: {
      digest,
      mediaType,
      byteLength: bytes.length,
      storageKey: path.relative(packageDir, filePath),
      role,
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(channels ? { channels } : {}),
      ...(sourceRegion ? { sourceRegion } : {}),
    },
    filePath,
  };
}

function boundedRegion(region, width, height) {
  const left = Math.max(0, Math.min(width - 1, Math.floor(region.x)));
  const top = Math.max(0, Math.min(height - 1, Math.floor(region.y)));
  const right = Math.max(left + 1, Math.min(width, Math.ceil(region.x + region.width)));
  const bottom = Math.max(top + 1, Math.min(height, Math.ceil(region.y + region.height)));
  return { left, top, width: right - left, height: bottom - top };
}

function fullPageRegion(pageId, width, height) {
  return {
    pageId,
    box: { x: 0, y: 0, width, height, unit: "px", coordinateSpace: "source-canvas" },
  };
}

function stableJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function stableDigest(value) {
  return sha256BytesDigest(stableJsonBytes(value));
}

function sanitizeIdentifierPart(value) {
  return String(value ?? "item")
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^[^A-Za-z]+/, "")
    .slice(0, 48) || "item";
}

function localizedAssetPurpose(value) {
  if (["failure-crop", "edge-crop", "mask-crop", "color-sample-crop", "optimization-tile"].includes(value)) return value;
  return "review-crop";
}

function pixelAt(canonical, x, y) {
  const offset = (y * canonical.info.width + x) * canonical.info.channels;
  return {
    point: { x, y, unit: "px", coordinateSpace: "source-canvas" },
    color: {
      space: "srgb",
      components: [
        canonical.data[offset] / 255,
        canonical.data[offset + 1] / 255,
        canonical.data[offset + 2] / 255,
      ],
      alpha: canonical.data[offset + 3] / 255,
    },
  };
}

function colorSamplesFor(canonical) {
  const { width, height } = canonical.info;
  const xs = [...new Set([0.25, 0.5, 0.75].map((ratio) => Math.max(0, Math.min(width - 1, Math.floor(width * ratio)))))];
  const ys = [...new Set([0.25, 0.5, 0.75].map((ratio) => Math.max(0, Math.min(height - 1, Math.floor(height * ratio)))))];
  return ys.flatMap((y) => xs.map((x) => pixelAt(canonical, x, y)));
}

function defaultAnalysisPayload({ kind, sourcePackage, canonical, metadata = {} }) {
  const page = sourcePackage.pages[0];
  if (kind === "ocr-tokens") {
    return {
      kind,
      status: "not-run",
      reason: "ocr-engine-not-configured",
      tokens: [],
      canonicalPixelDigest: sourcePackage.canonicalPixels.digest,
    };
  }
  if (kind === "baseline-candidates") {
    return { kind, baselines: [], canonicalPixelDigest: sourcePackage.canonicalPixels.digest };
  }
  if (kind === "connected-components") {
    return {
      kind,
      status: "summarized",
      components: [],
      sourceCanvas: page.canvas,
      note: "component extraction is cached as a deterministic placeholder until detector is enabled",
    };
  }
  if (kind === "contours") {
    return { kind, contours: [], sourceCanvas: page.canvas };
  }
  if (kind === "color-samples") {
    return { kind, samples: colorSamplesFor(canonical), sourceCanvas: page.canvas };
  }
  if (kind === "gradient-samples") {
    return { kind, candidates: [], samples: colorSamplesFor(canonical), sourceCanvas: page.canvas };
  }
  if (kind === "alpha-estimates") {
    return { kind, present: sourcePackage.alpha.present, nonOpaquePixelCount: sourcePackage.alpha.nonOpaquePixelCount };
  }
  if (kind === "shadow-candidates") {
    return { kind, candidates: [], sourceCanvas: page.canvas };
  }
  if (kind === "table-grid-candidates" || kind === "chart-primitive-candidates" || kind === "vectorization-candidates") {
    return { kind, candidates: [], sourceCanvas: page.canvas };
  }
  return { kind, ...metadata, sourceCanvas: page.canvas };
}

async function analysisJsonBlob({ payload, role, blobDir, packageDir }) {
  const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`);
  return contentAddressedBlob({
    bytes,
    mediaType: "application/json",
    role,
    blobDir,
    packageDir,
  });
}

async function analysisPngBlob({ bytes, role, blobDir, packageDir, width, height, sourceRegion }) {
  return contentAddressedBlob({
    bytes,
    mediaType: "image/png",
    role,
    blobDir,
    packageDir,
    width,
    height,
    channels: 4,
    sourceRegion,
  });
}

function analysisDerivativeRecord({ kind, derivativeId, sourcePackage, sourceRegions, blobRefs, contentDigest, confidence = 0.5, metadata = {} }) {
  return {
    derivativeId,
    kind,
    sourcePageRef: sourceRegions[0].pageId,
    canonicalPixelDigest: sourcePackage.canonicalPixels.digest,
    sourceRegions,
    generator: {
      ...SOURCE_ANALYSIS_GENERATOR,
      parametersDigest: stableDigest({
        kind,
        sourceRegions,
        canonicalPixelDigest: sourcePackage.canonicalPixels.digest,
        sourcePackageId: sourcePackage.sourceId,
      }),
    },
    contentDigest,
    hypothesis: true,
    confidence,
    blobRefs,
    metadata,
  };
}

async function generateSourceAnalysisDerivatives({
  sourcePackage,
  canonical,
  blobDir,
  packageDir,
  localizedEntries,
}) {
  const page = sourcePackage.pages[0];
  const pageRegion = fullPageRegion(page.pageId, canonical.info.width, canonical.info.height);
  const derivatives = [];
  const derivedBlobs = [];

  async function addJsonDerivative(kind, metadata = {}, confidence = 0.5) {
    const payload = defaultAnalysisPayload({ kind, sourcePackage, canonical, metadata });
    const blob = await analysisJsonBlob({
      payload,
      role: `analysis-${kind}`,
      blobDir,
      packageDir,
    });
    derivedBlobs.push(blob.ref);
    derivatives.push(analysisDerivativeRecord({
      kind,
      derivativeId: `analysis-${page.pageId}-${kind}`,
      sourcePackage,
      sourceRegions: [pageRegion],
      blobRefs: [blob.ref.digest],
      contentDigest: blob.ref.digest,
      confidence,
      metadata,
    }));
  }

  const canonicalImage = () => sharp(canonical.data, { raw: { width: canonical.info.width, height: canonical.info.height, channels: canonical.info.channels } });
  const textInkBytes = await canonicalImage()
    .removeAlpha()
    .greyscale()
    .threshold(245)
    .negate()
    .png()
    .toBuffer();
  const textInk = await analysisPngBlob({
    bytes: textInkBytes,
    role: "analysis-text-ink-mask",
    blobDir,
    packageDir,
    width: canonical.info.width,
    height: canonical.info.height,
    sourceRegion: pageRegion,
  });
  derivedBlobs.push(textInk.ref);
  derivatives.push(analysisDerivativeRecord({
    kind: "text-ink-mask",
    derivativeId: `analysis-${page.pageId}-text-ink-mask`,
    sourcePackage,
    sourceRegions: [pageRegion],
    blobRefs: [textInk.ref.digest],
    contentDigest: textInk.ref.digest,
    confidence: 0.55,
    metadata: { threshold: 245 },
  }));

  const edgeBytes = await canonicalImage()
    .removeAlpha()
    .greyscale()
    .convolve({ width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] })
    .png()
    .toBuffer();
  const edge = await analysisPngBlob({
    bytes: edgeBytes,
    role: "analysis-edge-map",
    blobDir,
    packageDir,
    width: canonical.info.width,
    height: canonical.info.height,
    sourceRegion: pageRegion,
  });
  derivedBlobs.push(edge.ref);
  derivatives.push(analysisDerivativeRecord({
    kind: "edge-map",
    derivativeId: `analysis-${page.pageId}-edge-map`,
    sourcePackage,
    sourceRegions: [pageRegion],
    blobRefs: [edge.ref.digest],
    contentDigest: edge.ref.digest,
    confidence: 0.7,
    metadata: { kernel: "laplacian-3x3" },
  }));

  for (const kind of [
    "ocr-tokens",
    "baseline-candidates",
    "connected-components",
    "contours",
    "color-samples",
    "gradient-samples",
    "alpha-estimates",
    "shadow-candidates",
    "table-grid-candidates",
    "chart-primitive-candidates",
    "vectorization-candidates",
  ]) {
    await addJsonDerivative(kind, {}, ["color-samples", "alpha-estimates"].includes(kind) ? 0.85 : 0.35);
  }

  const localizedDerivativeId = `analysis-${page.pageId}-localized-crops`;
  const localizedPayload = {
    kind: "localized-crops",
    assets: localizedEntries.map((entry) => ({
      role: entry.ref.role,
      digest: entry.ref.digest,
      purpose: entry.purpose,
      sourceRegion: entry.sourceRegion,
    })),
  };
  const localizedBlob = await analysisJsonBlob({
    payload: localizedPayload,
    role: "analysis-localized-crops",
    blobDir,
    packageDir,
  });
  derivedBlobs.push(localizedBlob.ref);
  derivatives.push(analysisDerivativeRecord({
    kind: "localized-crops",
    derivativeId: localizedDerivativeId,
    sourcePackage,
    sourceRegions: localizedEntries.length ? localizedEntries.map((entry) => entry.sourceRegion) : [pageRegion],
    blobRefs: [localizedBlob.ref.digest, ...localizedEntries.map((entry) => entry.ref.digest)],
    contentDigest: localizedBlob.ref.digest,
    confidence: localizedEntries.length ? 0.9 : 0.4,
    metadata: { assetCount: localizedEntries.length },
  }));

  const localizedAssets = localizedEntries.map((entry, index) => ({
    assetId: `asset-${page.pageId}-${sanitizeIdentifierPart(entry.ref.role)}-${index}`,
    purpose: entry.purpose,
    sourcePageRef: entry.sourceRegion.pageId,
    sourceRegion: entry.sourceRegion,
    scale: entry.scale ?? 1,
    colorHandling: entry.colorHandling,
    blobRef: entry.ref.digest,
    parentDerivativeRef: localizedDerivativeId,
  }));

  return { derivatives, derivedBlobs, localizedAssets };
}

export function assertFreshAnalysisDerivativeCache(sourcePackage, {
  expectedGenerator = SOURCE_ANALYSIS_GENERATOR,
} = {}) {
  const knownBlobDigests = new Set([
    sourcePackage.rawBlob?.digest,
    sourcePackage.canonicalPixels?.digest,
    ...(sourcePackage.derivedBlobs ?? []).map((blob) => blob.digest),
  ].filter(Boolean));
  for (const derivative of sourcePackage.analysisDerivatives ?? []) {
    if (derivative.canonicalPixelDigest !== sourcePackage.canonicalPixels.digest) {
      throw new Error(`派生物缓存 canonical digest 不匹配: ${derivative.derivativeId}`);
    }
    if (derivative.generator?.name !== expectedGenerator.name || derivative.generator?.version !== expectedGenerator.version) {
      throw new Error(`派生物缓存 generator version 已过期: ${derivative.derivativeId}`);
    }
    if (!derivative.generator?.parametersDigest) {
      throw new Error(`派生物缓存缺少参数摘要: ${derivative.derivativeId}`);
    }
    if (!knownBlobDigests.has(derivative.contentDigest)) {
      throw new Error(`派生物缓存 content digest 未绑定 Blob: ${derivative.derivativeId}`);
    }
    for (const digest of derivative.blobRefs ?? []) {
      if (!knownBlobDigests.has(digest)) throw new Error(`派生物缓存引用未知 Blob: ${derivative.derivativeId}`);
    }
  }
}

export async function normalizeSource({
  sourcePath,
  sourcePackagePath,
  blobDir = `${sourcePackagePath}.blobs`,
  sourceId = "source-1",
  pageId = "page-1",
  workingSpace = "srgb",
  tileSize = 1024,
  reviewRegions = [],
  maskPaths = [],
  analysisDerivatives = false,
}) {
  const [rawBytes, metadata] = await Promise.all([fs.readFile(sourcePath), sharp(sourcePath).metadata()]);
  if (!metadata.format || !metadata.width || !metadata.height) throw new Error("源图片缺少可验证的格式或尺寸");
  const mediaType = mediaTypeFor(metadata.format);
  const packageDir = path.dirname(sourcePackagePath);
  const orientationApplied = Boolean(metadata.orientation && metadata.orientation !== 1);
  const canonical = await sharp(sourcePath)
    .rotate()
    .toColourspace(workingSpace)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = canonical.info;
  if (channels !== 4) throw new Error(`规范化像素必须为 RGBA，实际 channels=${channels}`);

  let nonOpaquePixelCount = 0;
  for (let offset = 3; offset < canonical.data.length; offset += channels) {
    if (canonical.data[offset] !== 255) nonOpaquePixelCount += 1;
  }

  const raw = await contentAddressedBlob({
    bytes: rawBytes,
    mediaType,
    role: "raw-source",
    blobDir,
    packageDir,
    width: metadata.width,
    height: metadata.height,
  });
  const canonicalPixels = await contentAddressedBlob({
    bytes: canonical.data,
    mediaType: "application/octet-stream",
    role: "canonical-pixels",
    blobDir,
    packageDir,
    width,
    height,
    channels,
  });

  const derived = [];
  const localizedEntries = [];
  const previewBytes = await sharp(canonical.data, { raw: { width, height, channels } }).png().toBuffer();
  const preview = await contentAddressedBlob({
    bytes: previewBytes,
    mediaType: "image/png",
    role: "canonical-preview",
    blobDir,
    packageDir,
    width,
    height,
    channels: 4,
  });
  derived.push(preview.ref);

  if (width > tileSize || height > tileSize) {
    let tileIndex = 0;
    for (let top = 0; top < height; top += tileSize) {
      for (let left = 0; left < width; left += tileSize) {
        const tileWidth = Math.min(tileSize, width - left);
        const tileHeight = Math.min(tileSize, height - top);
        const bytes = await sharp(canonical.data, { raw: { width, height, channels } })
          .extract({ left, top, width: tileWidth, height: tileHeight })
          .png()
          .toBuffer();
        const tile = await contentAddressedBlob({
          bytes,
          mediaType: "image/png",
          role: `source-tile-${tileIndex}`,
          blobDir,
          packageDir,
          width: tileWidth,
          height: tileHeight,
          channels: 4,
          sourceRegion: {
            pageId,
            box: { x: left, y: top, width: tileWidth, height: tileHeight, unit: "px", coordinateSpace: "source-canvas" },
          },
        });
        derived.push(tile.ref);
        localizedEntries.push({
          ref: tile.ref,
          purpose: "optimization-tile",
          sourceRegion: tile.ref.sourceRegion,
          colorHandling: "canonical",
          scale: 1,
        });
        tileIndex += 1;
      }
    }
  }

  for (const [index, region] of reviewRegions.entries()) {
    const box = boundedRegion(region, width, height);
    const bytes = await sharp(canonical.data, { raw: { width, height, channels } }).extract(box).png().toBuffer();
    const crop = await contentAddressedBlob({
      bytes,
      mediaType: "image/png",
      role: `review-crop-${sanitizeIdentifierPart(region.id ?? index)}`,
      blobDir,
      packageDir,
      width: box.width,
      height: box.height,
      channels: 4,
      sourceRegion: {
        pageId: region.pageId ?? pageId,
        box: { x: box.left, y: box.top, width: box.width, height: box.height, unit: "px", coordinateSpace: "source-canvas" },
      },
    });
    derived.push(crop.ref);
    localizedEntries.push({
      ref: crop.ref,
      purpose: localizedAssetPurpose(region.purpose),
      sourceRegion: crop.ref.sourceRegion,
      colorHandling: "canonical",
      scale: 1,
    });
  }

  for (const [index, maskInput] of maskPaths.entries()) {
    const maskPath = typeof maskInput === "string" ? maskInput : maskInput.path;
    const maskId = typeof maskInput === "string" ? index : maskInput.id ?? index;
    const [bytes, maskMetadata] = await Promise.all([fs.readFile(maskPath), sharp(maskPath).metadata()]);
    const mask = await contentAddressedBlob({
      bytes,
      mediaType: mediaTypeFor(maskMetadata.format),
      role: `mask-${maskId}`,
      blobDir,
      packageDir,
      width: maskMetadata.width,
      height: maskMetadata.height,
    });
    derived.push(mask.ref);
  }

  const sourcePackage = {
    schemaVersion: 2,
    contractKind: "source-package",
    sourceId,
    rawBlob: raw.ref,
    canonicalPixels: canonicalPixels.ref,
    mediaType,
    pages: [{
      pageId,
      canvas: { width, height, unit: "px" },
      orientation: { original: metadata.orientation ?? null, applied: orientationApplied },
    }],
    color: {
      ...(metadata.icc?.length ? { originalProfileDigest: sha256BytesDigest(metadata.icc) } : {}),
      workingSpace,
    },
    alpha: { present: Boolean(metadata.hasAlpha), nonOpaquePixelCount },
    derivedBlobs: derived,
  };
  if (analysisDerivatives) {
    const analysis = await generateSourceAnalysisDerivatives({
      sourcePackage,
      canonical,
      blobDir,
      packageDir,
      localizedEntries,
    });
    sourcePackage.derivedBlobs.push(...analysis.derivedBlobs);
    sourcePackage.analysisDerivatives = analysis.derivatives;
    sourcePackage.localizedAssets = analysis.localizedAssets;
    assertFreshAnalysisDerivativeCache(sourcePackage);
  }
  await writeAtomic(sourcePackagePath, `${JSON.stringify(sourcePackage, null, 2)}\n`);
  return {
    sourcePackage,
    sourcePackagePath,
    blobDir,
    rawBlobPath: raw.filePath,
    canonicalPixelsPath: canonicalPixels.filePath,
    canonicalPreviewPath: preview.filePath,
  };
}

export async function readCanonicalPixels({ sourcePackage, canonicalPixelsPath }) {
  const page = sourcePackage?.pages?.[0];
  const ref = sourcePackage?.canonicalPixels;
  if (!page || !ref) throw new Error("Source Package 缺少 canonicalPixels 或页面事实");
  if (ref.width !== page.canvas.width || ref.height !== page.canvas.height) {
    throw new Error(`Source Package 规范化像素尺寸与页面画布不一致: ${ref.width}x${ref.height} != ${page.canvas.width}x${page.canvas.height}`);
  }
  const channels = ref.channels ?? 4;
  const data = await fs.readFile(canonicalPixelsPath);
  if (sha256BytesDigest(data) !== ref.digest) throw new Error("Source Package canonicalPixels 摘要与文件内容不一致");
  const expectedLength = ref.width * ref.height * channels;
  if (data.length !== expectedLength) throw new Error(`Source Package canonicalPixels 字节数不一致: ${data.length} != ${expectedLength}`);
  return { data, width: ref.width, height: ref.height, channels };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const analysisDerivatives = args.includes("--analysis-derivatives");
  const [sourcePath, sourcePackagePath] = args.filter((arg) => arg !== "--analysis-derivatives");
  if (!sourcePath || !sourcePackagePath) {
    console.error("用法: node packages/cli/src/source-normalizer.mjs <source-image> <source-package.json> [--analysis-derivatives]");
    process.exit(2);
  }
  const result = await normalizeSource({ sourcePath, sourcePackagePath, analysisDerivatives });
  console.log(JSON.stringify({ sourcePackagePath: result.sourcePackagePath, sourceId: result.sourcePackage.sourceId }, null, 2));
}
