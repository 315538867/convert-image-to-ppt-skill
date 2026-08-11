#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
const manifestPath = path.join(projectRoot, "golden-corpus", "manifest.json");
const QUICK_SAMPLE_IDS = new Set(["text-dense", "table-grid", "flowchart-structure"]);

export async function checkGoldenCorpus({ full = false } = {}) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const samples = full ? manifest.samples : manifest.samples.filter((sample) => QUICK_SAMPLE_IDS.has(sample.sampleId));
  assert.equal(samples.length, full ? manifest.samples.length : QUICK_SAMPLE_IDS.size, "Golden corpus 快速子集不完整");
  assert.equal(manifest.referencePolicy.independentReferenceRequired, true);
  assert.equal(manifest.referencePolicy.rendererGeneratedReferencesAllowed, false);
  assert.equal(manifest.qualityGates.component.maxFailedComponents, 0);
  for (const sample of samples) {
    assert.equal(sample.independentReference, true, `${sample.sampleId} 必须是独立参考图`);
    assert.equal(sample.status, "asset-ready", `${sample.sampleId} 尚未准备好`);
    assert.ok(sample.thresholds.pixel > 0 && sample.thresholds.edge > 0, `${sample.sampleId} 缺少组件阈值`);
    for (const filePath of [sample.sourcePath, sample.referencePath]) {
      assert.ok(filePath.startsWith(manifest.referencePolicy.pathPrefix), `${sample.sampleId} 路径不在 corpus 内`);
      assert.equal(manifest.referencePolicy.forbiddenPathFragments.some((fragment) => filePath.includes(fragment)), false, `${sample.sampleId} 使用了受禁路径`);
      const metadata = await sharp(path.join(projectRoot, filePath)).metadata();
      assert.equal(metadata.format, "png", `${sample.sampleId} 输入必须是 PNG`);
      assert.ok(metadata.width > 0 && metadata.height > 0, `${sample.sampleId} 输入图无有效尺寸`);
    }
  }
  return { status: "passed", mode: full ? "full" : "quick", sampleIds: samples.map((sample) => sample.sampleId) };
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const result = await checkGoldenCorpus({ full: process.argv.includes("--full") });
  console.log(JSON.stringify(result, null, 2));
}
