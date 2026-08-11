import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runGoldenCorpus } from "@image-to-ppt/cli";

const projectRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const manifestPath = path.join(projectRoot, "golden-corpus", "manifest.json");

function passingVerification() {
  return {
    status: "passed",
    componentResults: [],
    editabilityResults: [{ status: "passed" }],
    objectResults: [{ status: "passed" }],
    packageSecurity: { status: "passed" },
    pageResults: [{ status: "passed", metrics: { globalPixelSimilarity: 1, globalEdgeSimilarity: 1 } }],
    summary: { totalChecks: 5, passedChecks: 5, failedChecks: 0, skippedChecks: 0, gateStatus: "passed", weightedVisualScore: 1 },
    failures: [],
  };
}

test("golden corpus runner 写入 corpus-pass 到 Verification Result", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "img2ppt-golden-pass-"));
  try {
    const report = await runGoldenCorpus({
      manifestPath,
      sampleIds: ["text-dense"],
      reportPath: path.join(directory, "report.json"),
      runSample: async ({ sample, sourcePath, referencePath, visualThresholds }) => {
        assert.equal(sample.sampleId, "text-dense");
        assert.equal(sourcePath, referencePath);
        assert.equal(visualThresholds.text.pixel, 0.94);
        return passingVerification();
      },
    });
    assert.equal(report.status, "passed");
    assert.equal(report.results[0].verificationResult.goldenCorpusResults[0].status, "passed");
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, "report.json"), "utf8")).status, "passed");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("golden corpus runner 将门槛失败写入 corpus-failure", async () => {
  const report = await runGoldenCorpus({
    manifestPath,
    sampleIds: ["text-dense"],
    runSample: async () => ({ ...passingVerification(), pageResults: [{ status: "passed", metrics: { globalPixelSimilarity: 0.1, globalEdgeSimilarity: 0.1 } }] }),
  });
  assert.equal(report.status, "failed-quality-gate");
  const verification = report.results[0].verificationResult;
  assert.equal(verification.status, "failed-quality-gate");
  assert.equal(verification.goldenCorpusResults[0].failureCode, "corpus-failure");
  assert.equal(verification.failures.some((item) => item.category === "golden-corpus"), true);
});
