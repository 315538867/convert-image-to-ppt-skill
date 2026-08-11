import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { validateV2Contracts } from "@image-to-ppt/core";
import {
  assertFreshAnalysisDerivativeCache,
  normalizeSource,
  readCanonicalPixels,
} from "../../packages/cli/src/source-normalizer.mjs";

async function withTemporaryDirectory(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "img2ppt-source-normalizer-"));
  try {
    return await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("Source Normalizer 只应用一次 EXIF 方向并生成内容寻址派生资源", async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = path.join(directory, "orientation.jpg");
    const maskPath = path.join(directory, "mask.png");
    const packagePath = path.join(directory, "source-package.json");
    await sharp({ create: { width: 10, height: 20, channels: 3, background: "#336699" } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toFile(sourcePath);
    await sharp({ create: { width: 4, height: 4, channels: 3, background: "#FFFFFF" } }).png().toFile(maskPath);

    const result = await normalizeSource({
      sourcePath,
      sourcePackagePath: packagePath,
      tileSize: 8,
      reviewRegions: [{ id: "title", x: 1, y: 1, width: 5, height: 5 }],
      maskPaths: [{ id: "alpha", path: maskPath }],
      analysisDerivatives: true,
    });
    const sourcePackage = result.sourcePackage;
    const derivativeKinds = new Set(sourcePackage.analysisDerivatives.map((derivative) => derivative.kind));

    assert.deepEqual(sourcePackage.pages[0].canvas, { width: 20, height: 10, unit: "px" });
    assert.deepEqual(sourcePackage.pages[0].orientation, { original: 6, applied: true });
    assert.equal(sourcePackage.color.workingSpace, "srgb");
    assert.match(sourcePackage.rawBlob.storageKey, new RegExp(sourcePackage.rawBlob.digest.slice(7)));
    assert.match(sourcePackage.canonicalPixels.storageKey, new RegExp(sourcePackage.canonicalPixels.digest.slice(7)));
    assert.equal(sourcePackage.derivedBlobs.some((blob) => blob.role === "canonical-preview"), true);
    assert.equal(sourcePackage.derivedBlobs.some((blob) => blob.role.startsWith("source-tile-")), true);
    assert.equal(sourcePackage.derivedBlobs.some((blob) => blob.role === "review-crop-title" && blob.sourceRegion?.pageId === "page-1"), true);
    assert.equal(sourcePackage.derivedBlobs.some((blob) => blob.role === "mask-alpha"), true);
    assert.deepEqual(derivativeKinds, new Set([
      "ocr-tokens",
      "text-ink-mask",
      "baseline-candidates",
      "edge-map",
      "connected-components",
      "contours",
      "color-samples",
      "gradient-samples",
      "alpha-estimates",
      "shadow-candidates",
      "table-grid-candidates",
      "chart-primitive-candidates",
      "vectorization-candidates",
      "localized-crops",
    ]));
    assert.equal(sourcePackage.localizedAssets.some((asset) => asset.purpose === "review-crop" && asset.parentDerivativeRef.endsWith("localized-crops")), true);
    assert.equal(sourcePackage.localizedAssets.some((asset) => asset.purpose === "optimization-tile"), true);
    assert.doesNotThrow(() => assertFreshAnalysisDerivativeCache(sourcePackage));
    const validation = validateV2Contracts(sourcePackage);
    assert.equal(validation.ok, true, JSON.stringify(validation.errors, null, 2));
  });
});

test("Source Normalizer 记录 Alpha 事实和非透明像素数", async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = path.join(directory, "alpha.png");
    const packagePath = path.join(directory, "source-package.json");
    const pixels = Buffer.from([
      255, 0, 0, 255,
      0, 0, 255, 0,
    ]);
    await sharp(pixels, { raw: { width: 2, height: 1, channels: 4 } }).png().toFile(sourcePath);
    const result = await normalizeSource({ sourcePath, sourcePackagePath: packagePath });
    assert.deepEqual(result.sourcePackage.alpha, { present: true, nonOpaquePixelCount: 1 });
    const canonical = await readCanonicalPixels(result);
    assert.equal(canonical.width, 2);
    assert.equal(canonical.height, 1);
    assert.equal(canonical.channels, 4);
  });
});

test("Source Package canonicalPixels 摘要破坏时拒绝读取", async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = path.join(directory, "source.png");
    const packagePath = path.join(directory, "source-package.json");
    await sharp({ create: { width: 2, height: 2, channels: 3, background: "#FFFFFF" } }).png().toFile(sourcePath);
    const result = await normalizeSource({ sourcePath, sourcePackagePath: packagePath });
    await fs.writeFile(result.canonicalPixelsPath, Buffer.alloc(16));
    await assert.rejects(() => readCanonicalPixels(result), /摘要与文件内容不一致/);
  });
});

test("Source Package canonicalPixels 与页面画布不一致时拒绝读取", async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = path.join(directory, "source.png");
    const packagePath = path.join(directory, "source-package.json");
    await sharp({ create: { width: 2, height: 2, channels: 3, background: "#FFFFFF" } }).png().toFile(sourcePath);
    const result = await normalizeSource({ sourcePath, sourcePackagePath: packagePath });
    result.sourcePackage.pages[0].canvas.width = 3;
    await assert.rejects(() => readCanonicalPixels(result), /规范化像素尺寸与页面画布不一致/);
  });
});

test("Source analysis derivative cache 拒绝 digest mismatch、stale generator 和缺失 provenance", async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = path.join(directory, "source.png");
    const packagePath = path.join(directory, "source-package.json");
    await sharp({ create: { width: 12, height: 8, channels: 3, background: "#ABCDEF" } }).png().toFile(sourcePath);
    const result = await normalizeSource({
      sourcePath,
      sourcePackagePath: packagePath,
      analysisDerivatives: true,
    });

    const digestMismatch = JSON.parse(JSON.stringify(result.sourcePackage));
    digestMismatch.analysisDerivatives[0].canonicalPixelDigest = "sha256:" + "f".repeat(64);
    assert.throws(() => assertFreshAnalysisDerivativeCache(digestMismatch), /canonical digest 不匹配/);

    const staleGenerator = JSON.parse(JSON.stringify(result.sourcePackage));
    staleGenerator.analysisDerivatives[0].generator.version = "0.0.0";
    assert.throws(() => assertFreshAnalysisDerivativeCache(staleGenerator), /generator version 已过期/);

    const missingProvenance = JSON.parse(JSON.stringify(result.sourcePackage));
    delete missingProvenance.analysisDerivatives[0].generator.parametersDigest;
    assert.throws(() => assertFreshAnalysisDerivativeCache(missingProvenance), /缺少参数摘要/);
  });
});
