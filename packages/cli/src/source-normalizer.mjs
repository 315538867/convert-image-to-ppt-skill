import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { sha256BytesDigest } from "@image-to-ppt/core/canonical";

function mediaTypeFor(format) {
  if (format === "jpeg") return "image/jpeg";
  if (format === "svg") return "image/svg+xml";
  return `image/${format}`;
}

function extensionFor(mediaType) {
  if (mediaType === "image/jpeg") return ".jpg";
  if (mediaType === "image/svg+xml") return ".svg";
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
      role: `review-crop-${region.id ?? index}`,
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
  const [sourcePath, sourcePackagePath] = process.argv.slice(2);
  if (!sourcePath || !sourcePackagePath) {
    console.error("用法: node packages/cli/src/source-normalizer.mjs <source-image> <source-package.json>");
    process.exit(2);
  }
  const result = await normalizeSource({ sourcePath, sourcePackagePath });
  console.log(JSON.stringify({ sourcePackagePath: result.sourcePackagePath, sourceId: result.sourcePackage.sourceId }, null, 2));
}
