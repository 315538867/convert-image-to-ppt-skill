import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { validateV2Contracts } from "@image-to-ppt/core";

const singlePageFixture = new URL("../../packages/core/examples/v2/minimal-single-page.json", import.meta.url);
const multiPageFixture = new URL("../../packages/core/examples/v2/minimal-multi-page.json", import.meta.url);
const comprehensiveFixture = new URL("../../packages/core/examples/v2/authoring-comprehensive.json", import.meta.url);

function readFixture(url) {
  return JSON.parse(fs.readFileSync(url, "utf8"));
}

function codes(result) {
  return new Set(result.errors.map((error) => error.code));
}

function findNode(node, nodeId) {
  if (node.id === nodeId) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, nodeId);
    if (found) return found;
  }
  return null;
}

test("V2 单页最小契约集合通过 schema 和跨契约校验", () => {
  const result = validateV2Contracts(readFixture(singlePageFixture));
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
});

test("V2 多页最小契约集合要求每页都有验证结果", () => {
  const bundle = readFixture(multiPageFixture);
  const result = validateV2Contracts(bundle);
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));

  const verification = bundle.contracts.find((contract) => contract.contractKind === "verification-result");
  verification.pageResults = verification.pageResults.filter((item) => item.subjectRef !== "page-2");
  const failed = validateV2Contracts(bundle);
  assert.equal(failed.ok, false);
  assert.equal(codes(failed).has("V2_VERIFICATION_PAGE_MISSING"), true, JSON.stringify(failed.errors, null, 2));
});

test("V2 Evidence Graph 不能引用未知 Reconstruction node", () => {
  const bundle = readFixture(singlePageFixture);
  const evidence = bundle.contracts.find((contract) => contract.contractKind === "evidence-graph");
  evidence.evidence[0].subjects[0].nodeRef = "missing-node";
  const result = validateV2Contracts(bundle);
  assert.equal(result.ok, false);
  assert.equal(codes(result).has("V2_EVIDENCE_SUBJECT_REF_MISSING"), true, JSON.stringify(result.errors, null, 2));
});

test("V2 Blob digest 必须符合内容寻址格式", () => {
  const bundle = readFixture(singlePageFixture);
  const source = bundle.contracts.find((contract) => contract.contractKind === "source-package");
  source.rawBlob.digest = "sha256:not-a-digest";
  const result = validateV2Contracts(bundle);
  assert.equal(result.ok, false);
  assert.equal(codes(result).has("V2_SCHEMA_INVALID"), true, JSON.stringify(result.errors, null, 2));
});

test("V2 必填契约字段缺失会失败", () => {
  const bundle = readFixture(singlePageFixture);
  const source = bundle.contracts.find((contract) => contract.contractKind === "source-package");
  delete source.canonicalPixels;
  const result = validateV2Contracts(bundle);
  assert.equal(result.ok, false);
  assert.equal(codes(result).has("V2_SCHEMA_INVALID"), true, JSON.stringify(result.errors, null, 2));
});

test("V2 作者契约禁止写入运行成功状态", () => {
  const bundle = readFixture(singlePageFixture);
  const reconstruction = bundle.contracts.find((contract) => contract.contractKind === "reconstruction-spec");
  reconstruction.pages[0].rootNode.children[0].success = true;
  const result = validateV2Contracts(bundle);
  assert.equal(result.ok, false);
  assert.equal(codes(result).has("V2_AUTHOR_RUNTIME_STATE_FORBIDDEN"), true, JSON.stringify(result.errors, null, 2));
});

test("V2 完整作者样例覆盖文字度量、渐变、蒙版、连接线、表格、图表和批准图片", () => {
  const bundle = readFixture(comprehensiveFixture);
  const result = validateV2Contracts(bundle);
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));

  const reconstruction = bundle.contracts.find((contract) => contract.contractKind === "reconstruction-spec");
  const root = reconstruction.pages[0].rootNode;
  assert.equal(findNode(root, "title").content.measurements.visualLines.length, 1);
  assert.equal(findNode(root, "gradient-card").appearance.fills[0].gradient.stops.length, 3);
  assert.equal(findNode(root, "gradient-card").geometry.maskStack[0].source.kind, "blob");
  assert.equal(findNode(root, "connector").content.start.kind, "node-anchor");
  assert.equal(findNode(root, "cell-a").content.kind, "table-cell");
  assert.equal(findNode(root, "chart").content.dataSemantics, "unknown");
  assert.equal(findNode(root, "photo").content.rasterApproval.status, "approved-original-raster");
});

test("V2 节点 content 必须与节点 type 匹配", () => {
  const bundle = readFixture(singlePageFixture);
  const reconstruction = bundle.contracts.find((contract) => contract.contractKind === "reconstruction-spec");
  const title = reconstruction.pages[0].rootNode.children[0];
  title.content = { kind: "shape", shapeKind: "rectangle" };

  const result = validateV2Contracts(bundle);
  assert.equal(result.ok, false);
  assert.equal(codes(result).has("V2_SCHEMA_INVALID"), true, JSON.stringify(result.errors, null, 2));
});

test("V2 Evidence measurement 必须与 evidence kind 匹配", () => {
  const bundle = readFixture(singlePageFixture);
  const evidence = bundle.contracts.find((contract) => contract.contractKind === "evidence-graph");
  evidence.evidence[0].measurement = {
    kind: "spacing",
    axis: "horizontal",
    distance: { value: 12, unit: "px" },
    fromEdge: "right",
    toEdge: "left",
  };

  const result = validateV2Contracts(bundle);
  assert.equal(result.ok, false);
  assert.equal(codes(result).has("V2_SCHEMA_INVALID"), true, JSON.stringify(result.errors, null, 2));
});

test("V2 节点、连接线和蒙版引用必须闭合", () => {
  const bundle = readFixture(comprehensiveFixture);
  const reconstruction = bundle.contracts.find((contract) => contract.contractKind === "reconstruction-spec");
  const root = reconstruction.pages[0].rootNode;
  findNode(root, "connector").content.end.nodeRef = "missing-endpoint";
  findNode(root, "gradient-card").geometry.maskStack[0].source.blobDigest = `sha256:${"e".repeat(64)}`;
  findNode(root, "photo").evidenceRefs = ["missing-evidence"];

  const result = validateV2Contracts(bundle);
  const errorCodes = codes(result);
  assert.equal(result.ok, false);
  assert.equal(errorCodes.has("V2_CONNECTOR_NODE_REF_MISSING"), true, JSON.stringify(result.errors, null, 2));
  assert.equal(errorCodes.has("V2_MASK_BLOB_REF_MISSING"), true, JSON.stringify(result.errors, null, 2));
  assert.equal(errorCodes.has("V2_NODE_EVIDENCE_REF_MISSING"), true, JSON.stringify(result.errors, null, 2));
});

test("V2 不批准文字和源图复合图作为 original raster", () => {
  const bundle = readFixture(comprehensiveFixture);
  const reconstruction = bundle.contracts.find((contract) => contract.contractKind === "reconstruction-spec");
  const photo = findNode(reconstruction.pages[0].rootNode, "photo");
  photo.content.contentKind = "source-derived-composite";
  photo.content.derivation = "source-derived-composite";

  const result = validateV2Contracts(bundle);
  assert.equal(result.ok, false);
  assert.equal(codes(result).has("V2_SCHEMA_INVALID"), true, JSON.stringify(result.errors, null, 2));
});
