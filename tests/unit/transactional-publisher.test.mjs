import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateV2Contracts } from "@image-to-ppt/core";
import { createRunWorkspace, publishRun, readCurrentPublication, writeFailedRunDiagnostics } from "@image-to-ppt/cli";

const fixtureUrl = new URL("../../packages/core/examples/v2/minimal-single-page.json", import.meta.url);

function readFixture() {
  return JSON.parse(fs.readFileSync(fixtureUrl, "utf8"));
}

function contractsForPublication() {
  const bundle = readFixture();
  const sourcePackages = bundle.contracts.filter((contract) => contract.contractKind === "source-package");
  const verificationResult = structuredClone(bundle.contracts.find((contract) => contract.contractKind === "verification-result"));
  const validationContracts = bundle.contracts.filter((contract) => !["source-package", "verification-result", "delivery-manifest"].includes(contract.contractKind));
  return { sourcePackages, verificationResult, validationContracts };
}

async function writeOutput(runDir, name, content) {
  const filePath = path.join(runDir, name);
  await fsp.writeFile(filePath, content);
  return filePath;
}

test("V2 Publisher 在 runs/<run-id>/ 中生成 Delivery Manifest 并原子更新 current 指针", async () => {
  const workspaceDir = await fsp.mkdtemp(path.join(os.tmpdir(), "img2ppt-publish-"));
  try {
    const { sourcePackages, verificationResult, validationContracts } = contractsForPublication();
    const run = await createRunWorkspace({ workspaceDir, runId: "run-success-1" });
    const pptxPath = await writeOutput(run.runDir, "output.pptx", "pptx-bytes");
    const reportPath = await writeOutput(run.runDir, "verification-result.json", JSON.stringify(verificationResult));

    const publication = await publishRun({
      workspaceDir,
      runId: run.runId,
      sourcePackages,
      verificationResult,
      validationContracts,
      publishedAt: "2026-08-04T00:00:00.000Z",
      outputs: [
        { filePath: pptxPath, mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", role: "pptx-output" },
        { filePath: reportPath, mediaType: "application/json", role: "verification-result" },
      ],
    });

    assert.equal(publication.relativeDeliveryManifestPath, "runs/run-success-1/delivery-manifest.json");
    const current = await readCurrentPublication({ workspaceDir });
    assert.equal(current.target, "runs/run-success-1/delivery-manifest.json");
    assert.deepEqual(current.manifest, publication.manifest);
    assert.equal(current.manifest.outputs.every((output) => output.storageKey.startsWith("runs/run-success-1/")), true);
    assert.equal(validateV2Contracts({
      schemaVersion: 2,
      contracts: [...sourcePackages, ...validationContracts, verificationResult, current.manifest],
    }).ok, true);
  } finally {
    await fsp.rm(workspaceDir, { recursive: true, force: true });
  }
});
test("V2 Publisher 拒绝失败 Verification Result 且保留旧成功发布不变", async () => {
  const workspaceDir = await fsp.mkdtemp(path.join(os.tmpdir(), "img2ppt-publish-"));
  try {
    const { sourcePackages, verificationResult, validationContracts } = contractsForPublication();
    const oldRun = await createRunWorkspace({ workspaceDir, runId: "run-success-old" });
    const oldOutput = await writeOutput(oldRun.runDir, "output.pptx", "old-pptx");
    await publishRun({
      workspaceDir,
      runId: oldRun.runId,
      sourcePackages,
      verificationResult,
      validationContracts,
      outputs: [{ filePath: oldOutput, mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", role: "pptx-output" }],
    });

    const failedVerification = structuredClone(verificationResult);
    failedVerification.status = "failed-quality-gate";
    failedVerification.failures = [{ category: "visual-verifier", code: "visual-page-failed", message: "页面视觉验证失败", subjectRef: "page-1" }];
    failedVerification.summary = { ...failedVerification.summary, gateStatus: "failed-quality-gate", failedChecks: 1 };
    const failedRun = await writeFailedRunDiagnostics({
      workspaceDir,
      runId: "run-failed-1",
      verificationResult: failedVerification,
      diagnostics: { visual: { status: "failed" } },
    });

    await assert.rejects(
      publishRun({
        workspaceDir,
        runId: "run-failed-1",
        sourcePackages,
        verificationResult: failedVerification,
        validationContracts,
        outputs: [{ filePath: path.join(failedRun.runDir, "output.pptx"), mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", role: "pptx-output" }],
      }),
      /禁止生成 Delivery Manifest/
    );

    const current = await readCurrentPublication({ workspaceDir });
    assert.equal(current.target, "runs/run-success-old/delivery-manifest.json");
    assert.equal(fs.existsSync(path.join(failedRun.diagnosticsDir, "verification-result.json")), true);
    assert.equal(fs.existsSync(path.join(failedRun.runDir, "delivery-manifest.json")), false);
  } finally {
    await fsp.rm(workspaceDir, { recursive: true, force: true });
  }
});

test("V2 Publisher 指针提交前崩溃时 recovery 只能看到上一版完整发布", async () => {
  const workspaceDir = await fsp.mkdtemp(path.join(os.tmpdir(), "img2ppt-publish-"));
  try {
    const { sourcePackages, verificationResult, validationContracts } = contractsForPublication();
    const firstRun = await createRunWorkspace({ workspaceDir, runId: "run-success-a" });
    const firstOutput = await writeOutput(firstRun.runDir, "output.pptx", "first-pptx");
    await publishRun({
      workspaceDir,
      runId: firstRun.runId,
      sourcePackages,
      verificationResult,
      validationContracts,
      outputs: [{ filePath: firstOutput, mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", role: "pptx-output" }],
    });

    const secondRun = await createRunWorkspace({ workspaceDir, runId: "run-success-b" });
    const secondOutput = await writeOutput(secondRun.runDir, "output.pptx", "second-pptx");
    await assert.rejects(
      publishRun({
        workspaceDir,
        runId: secondRun.runId,
        sourcePackages,
        verificationResult,
        validationContracts,
        outputs: [{ filePath: secondOutput, mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", role: "pptx-output" }],
        simulateCrashBeforePointerCommit: true,
      }),
      /模拟发布指针提交前崩溃/
    );

    const recovered = await readCurrentPublication({ workspaceDir });
    assert.equal(recovered.target, "runs/run-success-a/delivery-manifest.json");
    assert.equal(fs.existsSync(path.join(secondRun.runDir, "delivery-manifest.json")), true);
    assert.equal(fs.existsSync(path.join(workspaceDir, "output.pptx")), false);

    await publishRun({
      workspaceDir,
      runId: secondRun.runId,
      sourcePackages,
      verificationResult,
      validationContracts,
      outputs: [{ filePath: secondOutput, mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", role: "pptx-output" }],
    });
    const current = await readCurrentPublication({ workspaceDir });
    assert.equal(current.target, "runs/run-success-b/delivery-manifest.json");
  } finally {
    await fsp.rm(workspaceDir, { recursive: true, force: true });
  }
});
