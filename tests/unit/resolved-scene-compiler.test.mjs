import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  compileResolvedScene,
  validateV2Contracts,
} from "@image-to-ppt/core";

const fixtureUrl = new URL("../../packages/core/examples/v2/authoring-comprehensive.json", import.meta.url);
const corePackageUrl = new URL("../../packages/core/package.json", import.meta.url);
const coreSourceUrl = new URL("../../packages/core/src/", import.meta.url);

function readFixture() {
  return JSON.parse(fs.readFileSync(fixtureUrl, "utf8"));
}

function contracts(bundle) {
  return {
    sources: bundle.contracts.filter((contract) => contract.contractKind === "source-package"),
    reconstruction: bundle.contracts.find((contract) => contract.contractKind === "reconstruction-spec"),
    evidence: bundle.contracts.find((contract) => contract.contractKind === "evidence-graph"),
  };
}

function compile(bundle) {
  const { sources, reconstruction, evidence } = contracts(bundle);
  return compileResolvedScene({
    sourcePackages: sources,
    reconstructionSpec: reconstruction,
    evidenceGraph: evidence,
  });
}

function findAuthorNode(node, nodeId) {
  if (node.id === nodeId) return node;
  for (const child of node.children ?? []) {
    const found = findAuthorNode(child, nodeId);
    if (found) return found;
  }
  return null;
}

function findSceneNode(scene, nodeId) {
  return scene.pages.flatMap((page) => page.nodes).find((node) => node.sourceNodeRefs.includes(nodeId));
}

test("Resolved Scene 编译完整作者契约并通过四契约闭包校验", () => {
  const bundle = readFixture();
  const scene = compile(bundle);
  const result = validateV2Contracts({ schemaVersion: 2, contracts: [...bundle.contracts, scene] });

  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  assert.equal(scene.pages.length, 1);
  assert.equal(scene.pages[0].nodes.length, 11);
  assert.equal(scene.resources.length, 2);
  assert.match(scene.sceneId, /^scene-[0-9a-f]{24}$/);
});

test("Resolved Scene 确定性组合嵌套变换并展开四类世界边界", () => {
  const bundle = readFixture();
  const { reconstruction } = contracts(bundle);
  const root = reconstruction.pages[0].rootNode;
  const title = findAuthorNode(root, "title");
  root.geometry.transform.matrix = [1, 0, 0, 1, 10, 20];
  title.geometry.transform.matrix = [1, 0, 0, 1, 5, 6];

  const scene = compile(bundle);
  const resolvedTitle = findSceneNode(scene, "title");
  assert.deepEqual(resolvedTitle.worldTransform, { kind: "affine-2d", matrix: [1, 0, 0, 1, 15, 26] });
  assert.equal(resolvedTitle.worldBounds.ink.x, 141);
  assert.equal(resolvedTitle.worldBounds.ink.y, 177);
  assert.equal(resolvedTitle.worldBounds.effect.coordinateSpace, "page");
});

test("Resolved Scene 使用稳定前序 drawOrder 保留遮挡关系", () => {
  const scene = compile(readFixture());
  const page = scene.pages[0];
  const card = findSceneNode(scene, "gradient-card");
  const title = findSceneNode(scene, "title");
  const photo = findSceneNode(scene, "photo");

  assert.equal(card.drawOrder < title.drawOrder, true);
  assert.equal(title.drawOrder < photo.drawOrder, true);
  assert.deepEqual(page.drawOrder, page.nodes.map((node) => node.sceneNodeId));
  assert.equal(new Set(page.drawOrder).size, page.nodes.length);
});

test("Resolved Scene 拒绝 Schema 未定义的可见作者字段", () => {
  const bundle = readFixture();
  const { reconstruction } = contracts(bundle);
  findAuthorNode(reconstruction.pages[0].rootNode, "gradient-card").appearance.unconsumedGlowHint = 12;

  assert.throws(
    () => compile(bundle),
    (error) => error.code === "V2_SCHEMA_INVALID" && /unconsumedGlowHint|additional properties/.test(error.message),
  );
});

test("Resolved Scene 绑定所有使用中的内容寻址资源并拒绝未知资源", () => {
  const bundle = readFixture();
  const scene = compile(bundle);
  const photo = findSceneNode(scene, "photo");
  const card = findSceneNode(scene, "gradient-card");

  assert.deepEqual(photo.resourceRefs, ["sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"]);
  assert.deepEqual(card.resourceRefs, ["sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"]);

  const { reconstruction } = contracts(bundle);
  findAuthorNode(reconstruction.pages[0].rootNode, "photo").content.resourceDigest = `sha256:${"f".repeat(64)}`;
  assert.throws(() => compile(bundle), (error) => error.code === "V2_IMAGE_BLOB_REF_MISSING");
});

test("Resolved Scene 合并节点直接 Evidence 与 subjects 反向 Evidence", () => {
  const bundle = readFixture();
  const { reconstruction, evidence } = contracts(bundle);
  findAuthorNode(reconstruction.pages[0].rootNode, "gradient-card").evidenceRefs = ["ev-gradient"];
  evidence.evidence.find((item) => item.id === "ev-mask").subjects.push({ nodeRef: "gradient-card", role: "reference" });

  const card = findSceneNode(compile(bundle), "gradient-card");
  assert.deepEqual(card.evidenceClosure.directEvidenceRefs, ["ev-gradient"]);
  assert.deepEqual(card.evidenceClosure.subjectEvidenceRefs, ["ev-connector", "ev-gradient", "ev-mask"]);
  assert.deepEqual(card.evidenceClosure.allEvidenceRefs, ["ev-connector", "ev-gradient", "ev-mask"]);
  assert.equal(card.evidenceClosure.subjectRoles.some((item) => item.evidenceRef === "ev-mask" && item.role === "reference"), true);
});

test("Resolved Scene 为文字保留策略候选并记录每个作者叶子字段的消费路径", () => {
  const title = findSceneNode(compile(readFixture()), "title");
  assert.deepEqual(title.textStrategyCandidates, ["positioned-clusters", "editable-runs"]);
  assert.equal(title.consumedAuthorFields.includes("/pages/0/rootNode/children/1/content/text"), true);
  assert.equal(title.consumedAuthorFields.some((pointer) => pointer.endsWith("/appearance/opacity")), true);
  assert.equal(title.resolvedContent.text, "可编辑标题");
});

test("Core 包不依赖 PPTX 后端、图片解码库或 Codex 宿主运行库", () => {
  const packageJson = JSON.parse(fs.readFileSync(corePackageUrl, "utf8"));
  const dependencies = Object.keys(packageJson.dependencies ?? {});
  assert.deepEqual(dependencies.sort(), ["ajv", "canonicalize"]);
  assert.equal(dependencies.some((name) => /pptx|sharp|artifact|codex|ooxml/i.test(name)), false);

  for (const entry of fs.readdirSync(coreSourceUrl, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
    const source = fs.readFileSync(new URL(entry.name, coreSourceUrl), "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*(?:renderer-pptx|sharp|artifact-tool|codex|pptxgenjs)[^"']*["']/i, entry.name);
  }
});
