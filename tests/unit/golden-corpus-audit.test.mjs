import assert from "node:assert/strict";
import test from "node:test";
import { checkGoldenCorpus } from "../../scripts/check-golden-corpus.mjs";

test("golden corpus 审计提供快速与全量两种检查", async () => {
  const [quick, full] = await Promise.all([checkGoldenCorpus(), checkGoldenCorpus({ full: true })]);
  assert.deepEqual(quick.sampleIds, ["text-dense", "table-grid", "flowchart-structure"]);
  assert.equal(full.sampleIds.length, 9);
});
