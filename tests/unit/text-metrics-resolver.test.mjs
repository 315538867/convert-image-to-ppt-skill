import assert from "node:assert/strict";
import test from "node:test";
import { fitTextMetrics, resolveTextMetrics } from "@image-to-ppt/core";

const content = {
  kind: "text",
  text: "标题 A1",
  indexing: { utf16Boundaries: [0, 1, 2, 3, 4, 5] },
  runs: [{
    range: { start: 0, end: 5 },
    style: {
      fontFamilies: ["Author Font", "Fallback Font"],
      fontSize: { value: 42, unit: "px" },
      tracking: { value: 1.5, unit: "px" },
      baselineShift: { value: 0, unit: "px" },
    },
  }],
  paragraphs: [{
    range: { start: 0, end: 5 },
    spacingBefore: { value: 2, unit: "px" },
    spacingAfter: { value: 3, unit: "px" },
    lineSpacing: { mode: "exact", value: 52 },
  }],
  layout: { mode: "native-flow" },
};

const evidenceGraph = {
  evidence: [{
    id: "ev-text-metrics",
    subjects: [{ nodeRef: "title", role: "primary" }],
    measurement: {
      kind: "text-metrics",
      tokens: [{
        text: "标题 Al",
        range: { start: 0, end: 5 },
        box: { x: 10, y: 20, width: 120, height: 36, unit: "px", coordinateSpace: "source-canvas" },
        script: "Hans-Latn",
        confidence: 0.74,
      }],
      baselines: [{
        from: { x: 10, y: 50, unit: "px", coordinateSpace: "source-canvas" },
        to: { x: 130, y: 50, unit: "px", coordinateSpace: "source-canvas" },
      }],
      lineBoxes: [{ x: 10, y: 20, width: 120, height: 36, unit: "px", coordinateSpace: "source-canvas" }],
      tracking: { value: 0.75, unit: "px" },
      lineHeight: { value: 48, unit: "px" },
      fontCandidates: [
        { family: "Measured Font", score: 0.95 },
        { family: "Author Font", score: 0.8 },
      ],
    },
  }],
};

test("Text Metrics Resolver 保留作者文本并记录 OCR 冲突", () => {
  const metrics = resolveTextMetrics({ content, sourceNodeRef: "title", evidenceGraph });

  assert.equal(metrics.runs[0].authorText, "标题 A1");
  assert.equal(metrics.runs[0].observedTokens[0].text, "标题 Al");
  assert.equal(metrics.runs[0].ocrConflict, true);
  assert.deepEqual(metrics.evidenceRefs, ["ev-text-metrics"]);
});

test("Text Fitter 在约束范围内选择字体、间距、基线和文本框策略", () => {
  const metrics = resolveTextMetrics({ content, sourceNodeRef: "title", evidenceGraph });
  const decision = fitTextMetrics({
    resolvedContent: content,
    textMetrics: metrics,
    fitConstraints: [{
      parameterPath: "/content/runs/0/style/tracking/value",
      defaultValue: 1.5,
      range: { min: 1, max: 2 },
      unit: "px",
      evidenceRefs: ["ev-text-metrics"],
      editabilityAspects: ["text-style"],
    }],
  });

  assert.deepEqual(decision.fontFamilies, ["Measured Font"]);
  assert.deepEqual(decision.fallbackFontFamilies, ["Author Font", "Fallback Font"]);
  assert.deepEqual(decision.tracking, { value: 1, unit: "px" });
  assert.deepEqual(decision.lineHeight, { value: 48, unit: "px" });
  assert.equal(decision.anchor, "baseline");
  assert.equal(decision.textBoxStrategy, "fixed-bounds");
});
