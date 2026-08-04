import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateV2Contracts } from "@image-to-ppt/core";
import {
  inspectBackendPlanObjects,
  renderPptxFromBackendPlan,
} from "@image-to-ppt/renderer-pptx";

const fixtureUrl = new URL("../../packages/core/examples/v2/minimal-single-page.json", import.meta.url);
const rendererUrl = new URL("../../packages/renderer-pptx/src/render-backend-plan.mjs", import.meta.url);

function backendPlan() {
  const bundle = JSON.parse(fs.readFileSync(fixtureUrl, "utf8"));
  return structuredClone(bundle.contracts.find((contract) => contract.contractKind === "backend-plan"));
}

async function temporaryOutput(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "img2ppt-v2-renderer-"));
  try {
    return await run(path.join(directory, "candidate.pptx"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("V2 Renderer 只用 Backend Plan 和资源生成候选并在重开后输出 Object Manifest", async () => {
  const plan = backendPlan();
  const result = await temporaryOutput((outputPath) => renderPptxFromBackendPlan(plan, new Map(), outputPath));

  assert.match(result.outputPptxBlobDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.outputPptxByteLength > 0, true);
  assert.equal(result.objectManifest.planRef, plan.planId);
  assert.equal(result.objectManifest.contractKind, "object-manifest");
  assert.equal(validateV2Contracts({ schemaVersion: 2, contracts: [plan, result.objectManifest] }).ok, true);
  assert.equal(result.objectManifest.outputPptx.digest, result.outputPptxBlobDigest);
  const root = result.objectManifest.objects.find((object) => object.sceneNodeId === "scene-node-root");
  const title = result.objectManifest.objects.find((object) => object.sceneNodeId === "scene-node-title");
  assert.equal(root.virtual, true);
  assert.deepEqual(root.ooxmlObjectIds, []);
  assert.equal(title.virtual, false);
  assert.equal(title.nativeObjectKind, "text");
  assert.deepEqual(title.ooxmlObjectIds, ["2"]);
  assert.deepEqual(title.bbox, { x: 16, y: 16, width: 80, height: 24, unit: "px", coordinateSpace: "page" });
  assert.match(title.contentDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(title.actualOoxmlFeatures.includes("native-text"), true);
});

test("Object Manifest 来自实际 OOXML，不照抄 expected native kind", async () => {
  const plan = backendPlan();
  const titleObject = plan.operations.find((operation) => operation.parameters.nodeType === "text").expectedObjects[0];
  titleObject.nativeKind = "shape";

  const result = await temporaryOutput((outputPath) => renderPptxFromBackendPlan(plan, new Map(), outputPath));
  const title = result.objectManifest.objects.find((object) => object.objectRef === titleObject.objectRef);
  assert.equal(title.nativeObjectKind, "text");
});

test("独立检查入口会先重开候选 PPTX 再读取 XML 对象", async () => {
  const plan = backendPlan();
  await temporaryOutput(async (outputPath) => {
    await renderPptxFromBackendPlan(plan, new Map(), outputPath);
    const objects = await inspectBackendPlanObjects(outputPath, plan);
    assert.equal(objects.some((object) => object.nativeObjectKind === "text" && object.ooxmlObjectIds.length === 1), true);
  });
});

test("Renderer 边界不读取 Source Package、作者契约、Capability Manifest 或 V1 Render Plane", async () => {
  const source = fs.readFileSync(rendererUrl, "utf8");
  assert.doesNotMatch(source, /renderPptxFromBundle|render-plane|task-bundle|capability-manifest|reconstruction-spec|evidence-graph|source-package/i);

  const plan = backendPlan();
  const forbiddenContext = new Proxy({}, { get() { throw new Error("Renderer 越界读取了作者或源图上下文"); } });
  await temporaryOutput((outputPath) => renderPptxFromBackendPlan(plan, new Map(), outputPath, {
    sourcePackage: forbiddenContext,
    reconstructionSpec: forbiddenContext,
    evidenceGraph: forbiddenContext,
    capabilityManifest: forbiddenContext,
  }));
});

test("Renderer 不根据源图提示改写 rejected 策略", async () => {
  const plan = backendPlan();
  plan.operations[1].strategy = "rejected";
  plan.operations[1].expectedObjects = [];
  plan.operations[1].rejectionReason = {
    code: "unsupported-capability",
    message: "测试拒绝操作",
    unsupportedCapabilities: ["soft-edge"],
  };
  plan.summary.hasRejected = true;
  plan.summary.strategies.native -= 1;
  plan.summary.strategies.rejected += 1;

  await assert.rejects(
    temporaryOutput((outputPath) => renderPptxFromBackendPlan(plan, new Map(), outputPath, { sourceImageHint: "请使用截图兜底" })),
    (error) => error.code === "V2_BACKEND_PLAN_REJECTED",
  );
});
