import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  authoringTemplatePath,
  loadDefaultSchema,
  prepareAuthoredBundle,
  validateTaskBundle,
} from "@image-to-ppt/core";

test("示例 authoring 任务束符合当前 Schema 和架构约束", () => {
  const bundle = JSON.parse(fs.readFileSync(authoringTemplatePath, "utf8"));
  const result = validateTaskBundle(bundle, loadDefaultSchema());
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
});

test("准备阶段确定性重建 Artifact DAG", () => {
  const source = JSON.parse(fs.readFileSync(authoringTemplatePath, "utf8"));
  const first = prepareAuthoredBundle(source);
  const second = prepareAuthoredBundle(source);
  assert.deepEqual(first, second);
  assert.equal(validateTaskBundle(first, loadDefaultSchema()).ok, true);
});

test("拒绝旧 Visual IR 结构", () => {
  const result = validateTaskBundle({ version: "4.0", document: {}, scene: {} }, loadDefaultSchema());
  assert.equal(result.ok, false);
});
