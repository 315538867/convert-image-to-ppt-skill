import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { compileResolvedScene, validateV2Contracts } from "@image-to-ppt/core";
import {
  assertBackendPlanExecutable,
  defaultPptxTargetProfile,
  generateBackendPlan,
} from "@image-to-ppt/renderer-pptx";

const fixtureUrl = new URL("../../packages/core/examples/v2/authoring-comprehensive.json", import.meta.url);

function fixture() {
  return JSON.parse(fs.readFileSync(fixtureUrl, "utf8"));
}

function compile(bundle = fixture()) {
  const sourcePackages = bundle.contracts.filter((contract) => contract.contractKind === "source-package");
  const reconstructionSpec = bundle.contracts.find((contract) => contract.contractKind === "reconstruction-spec");
  const evidenceGraph = bundle.contracts.find((contract) => contract.contractKind === "evidence-graph");
  return compileResolvedScene({ sourcePackages, reconstructionSpec, evidenceGraph });
}

function sceneNode(scene, sourceNodeId) {
  return scene.pages.flatMap((page) => page.nodes).find((node) => node.sourceNodeRefs.includes(sourceNodeId));
}

function operation(plan, sourceNodeId) {
  const node = sceneNode({ pages: [{ nodes: plan.operations.map((item) => ({ sceneNodeId: item.sceneNodeRef, sourceNodeRefs: [item.sceneNodeRef.replace("scene-node-", "")] })) }] }, sourceNodeId);
  return plan.operations.find((item) => item.sceneNodeRef === node.sceneNodeId);
}

function profile(overrides = {}) {
  return {
    ...structuredClone(defaultPptxTargetProfile),
    ...overrides,
    limits: { ...defaultPptxTargetProfile.limits, ...(overrides.limits ?? {}) },
  };
}

test("PPTX Target Profile 明确划分 native、OOXML、lowering、批准栅格和 unsupported 能力", () => {
  const target = defaultPptxTargetProfile;
  assert.equal(target.nativeCapabilities.includes("shape"), true);
  assert.equal(target.ooxmlPostprocessCapabilities.includes("rich-text-run-metrics"), true);
  assert.equal(target.primitiveLoweringCapabilities.includes("per-side-border"), true);
  assert.deepEqual(target.approvedRasterCapabilities, ["approved-original-raster"]);
  assert.equal(target.unsupportedCapabilities.includes("soft-edge"), true);
});

test("Backend Plan 为逐边边框生成 lowering 策略和每边预期对象", () => {
  const scene = compile();
  const card = sceneNode(scene, "gradient-card");
  const template = structuredClone(card.effectiveAppearance.strokes[0]);
  card.effectiveAppearance.strokes = ["top", "right", "bottom", "left"].map((side) => ({ ...structuredClone(template), side }));

  const plan = generateBackendPlan(scene);
  const cardOperation = plan.operations.find((item) => item.sceneNodeRef === card.sceneNodeId);
  assert.equal(cardOperation.strategy, "lower-to-primitives");
  assert.deepEqual(cardOperation.expectedObjects.map((item) => item.role), ["primary", "border-top", "border-right", "border-bottom", "border-left"]);
});

test("Backend Plan 对超出路径复杂度限制的节点显式 rejected 并阻止候选规划", () => {
  const scene = compile();
  const bar = sceneNode(scene, "chart-bar-1");
  bar.type = "path";
  bar.resolvedContent = {
    kind: "path",
    fillRule: "nonzero",
    commands: [
      { command: "move-to", to: { x: 0, y: 0, unit: "px", coordinateSpace: "local" } },
      { command: "line-to", to: { x: 10, y: 0, unit: "px", coordinateSpace: "local" } },
      { command: "line-to", to: { x: 10, y: 10, unit: "px", coordinateSpace: "local" } },
      { command: "close" },
    ],
  };
  const limited = profile({ limits: { maxPathCommandsPerObject: 2 } });

  assert.throws(() => generateBackendPlan(scene, limited), (error) => error.code === "V2_BACKEND_PLAN_REJECTED");
  const diagnostic = generateBackendPlan(scene, limited, { allowRejected: true });
  const rejected = diagnostic.operations.find((item) => item.sceneNodeRef === bar.sceneNodeId);
  assert.equal(rejected.strategy, "rejected");
  assert.equal(rejected.rejectionReason.code, "path-limit-exceeded");
  assert.equal(diagnostic.summary.hasRejected, true);
});

test("Backend Plan 为精确文字度量选择 OOXML 后处理并保留完整参数", () => {
  const scene = compile();
  const title = sceneNode(scene, "title");
  const plan = generateBackendPlan(scene);
  const textOperation = plan.operations.find((item) => item.sceneNodeRef === title.sceneNodeId);

  assert.equal(textOperation.strategy, "ooxml-postprocess");
  assert.equal(textOperation.requiredCapabilities.includes("positioned-cluster-text"), true);
  assert.equal(textOperation.expectedObjects[0].expectedOoxmlFeatures.includes("manual-text-metrics"), true);
  assert.equal(textOperation.parameters.content.text, "可编辑标题");
});

test("Backend Plan 只允许已批准的原始图片使用 approved-original-raster", () => {
  const scene = compile();
  const photo = sceneNode(scene, "photo");
  const plan = generateBackendPlan(scene);
  const photoOperation = plan.operations.find((item) => item.sceneNodeRef === photo.sceneNodeId);

  assert.equal(photoOperation.strategy, "approved-original-raster");
  assert.deepEqual(photoOperation.resourceRefs, [photo.resolvedContent.resourceDigest]);

  photo.resolvedContent.rasterApproval.status = "not-approved";
  const noApprovalPlan = generateBackendPlan(scene);
  const noApprovalOperation = noApprovalPlan.operations.find((item) => item.sceneNodeRef === photo.sceneNodeId);
  assert.equal(noApprovalOperation.strategy, "native");
});

test("Backend Plan 对不支持的 soft-edge 明确拒绝且不生成预期对象", () => {
  const scene = compile();
  const card = sceneNode(scene, "gradient-card");
  card.effectiveAppearance.effects.push({ kind: "soft-edge", radius: { value: 8, unit: "px" } });

  const diagnostic = generateBackendPlan(scene, defaultPptxTargetProfile, { allowRejected: true });
  const rejected = diagnostic.operations.find((item) => item.sceneNodeRef === card.sceneNodeId);
  assert.equal(rejected.strategy, "rejected");
  assert.deepEqual(rejected.expectedObjects, []);
  assert.deepEqual(rejected.rejectionReason.unsupportedCapabilities, ["soft-edge"]);
  assert.throws(() => generateBackendPlan(scene), (error) => error.code === "V2_BACKEND_PLAN_REJECTED");
});

test("Backend Plan 完整输出通过 Schema 和跨契约闭包校验", () => {
  const bundle = fixture();
  const scene = compile(bundle);
  const plan = generateBackendPlan(scene);
  const result = validateV2Contracts({ schemaVersion: 2, contracts: [...bundle.contracts, scene, plan] });

  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  assert.equal(plan.summary.nodeCount, scene.pages[0].nodes.length);
  assert.equal(plan.summary.hasRejected, false);
  assert.equal(plan.summary.hasUnapprovedLoss, false);
});

test("Backend Plan 可执行性检查阻止未批准损失但允许显式批准损失", () => {
  const plan = generateBackendPlan(compile());
  const operation = plan.operations[0];
  operation.declaredLosses.push({
    code: "minor-shadow-difference",
    category: "visual",
    description: "阴影栅格化存在已批准的微小差异。",
    approved: false,
    affectedAspects: ["appearance"],
  });
  assert.throws(() => assertBackendPlanExecutable(plan), (error) => error.code === "V2_BACKEND_PLAN_UNAPPROVED_LOSS");

  operation.declaredLosses[0].approved = true;
  assert.equal(assertBackendPlanExecutable(plan), plan);
});
