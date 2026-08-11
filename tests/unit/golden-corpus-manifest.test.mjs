import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";

const projectRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const manifestPath = path.join(projectRoot, "golden-corpus", "manifest.json");

test("Independent golden corpus manifest 与 renderer 自举样例隔离", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.referencePolicy.independentReferenceRequired, true);
  assert.equal(manifest.referencePolicy.rendererGeneratedReferencesAllowed, false);
  assert.equal(manifest.qualityGates.independentReferenceRequired, true);
  assert.deepEqual(manifest.qualityGates.required, ["editability", "object-manifest", "package-safety"]);
  assert.equal(manifest.qualityGates.component.maxFailedComponents, 0);
  assert.equal(manifest.samples.length >= 9, true);
  const ids = new Set();
  for (const sample of manifest.samples) {
    assert.equal(ids.has(sample.sampleId), false);
    ids.add(sample.sampleId);
    assert.equal(sample.independentReference, true);
    assert.ok(sample.thresholds.pixel >= 0.7 && sample.thresholds.pixel <= 1);
    assert.ok(sample.thresholds.edge >= 0.7 && sample.thresholds.edge <= 1);
    for (const field of ["sourcePath", "referencePath", "contractsPath"]) {
      assert.equal(sample[field].startsWith("golden-corpus/"), true);
      assert.equal(manifest.referencePolicy.forbiddenPathFragments.some((fragment) => sample[field].includes(fragment)), false);
    }
  }
  assert.equal(manifest.samples.some((sample) => sample.sampleKind === "text"), true);
  assert.equal(manifest.samples.some((sample) => sample.sampleKind === "multi-page"), true);
});

test("golden corpus 覆盖并生成独立输入图", async () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const expectedKinds = new Set(["text", "table", "flowchart", "chart", "transparent", "gradient", "shadow", "multi-page", "low-clarity"]);
  assert.deepEqual(new Set(manifest.samples.map((sample) => sample.sampleKind)), expectedKinds);
  for (const sample of manifest.samples) {
    const assetPath = path.join(projectRoot, sample.sourcePath);
    const metadata = await sharp(assetPath).metadata();
    assert.equal(metadata.format, "png");
    assert.ok(metadata.width >= 480);
    assert.ok(metadata.height >= 270);
  }
});
