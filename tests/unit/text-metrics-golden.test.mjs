import assert from "node:assert/strict";
import test from "node:test";
import { fitTextMetrics, resolveTextMetrics } from "@image-to-ppt/core";

function textContent(text, { alignment = "left", lineCount = 1 } = {}) {
  const boundaries = Array.from({ length: text.length + 1 }, (_, index) => index);
  return {
    kind: "text",
    text,
    indexing: { utf16Boundaries: boundaries },
    runs: [{
      range: { start: 0, end: text.length },
      style: {
        fontFamilies: ["Author Sans", "Fallback Sans"],
        fontSize: { value: 28, unit: "px" },
        tracking: { value: 0, unit: "px" },
        baselineShift: { value: 0, unit: "px" },
      },
    }],
    paragraphs: Array.from({ length: lineCount }, (_, index) => ({
      range: { start: index === 0 ? 0 : Math.floor(text.length / lineCount), end: index === lineCount - 1 ? text.length : Math.floor(text.length / lineCount) },
      alignment,
      spacingBefore: { value: 0, unit: "px" },
      spacingAfter: { value: 0, unit: "px" },
      lineSpacing: { mode: "exact", value: 34 },
    })),
    layout: { mode: "native-flow" },
  };
}

function textMetricsEvidence(text, { observedText = text, confidence = 0.98 } = {}) {
  return {
    evidence: [{
      id: "ev-golden-text",
      subjects: [{ nodeRef: "golden-text", role: "primary" }],
      measurement: {
        kind: "text-metrics",
        tokens: [{
          text: observedText,
          range: { start: 0, end: text.length },
          box: { x: 0, y: 0, width: 500, height: 40, unit: "px", coordinateSpace: "source-canvas" },
          script: "Hans-Latn",
          confidence,
        }],
        baselines: [{
          from: { x: 0, y: 30, unit: "px", coordinateSpace: "source-canvas" },
          to: { x: 500, y: 30, unit: "px", coordinateSpace: "source-canvas" },
        }],
        lineBoxes: [{ x: 0, y: 0, width: 500, height: 40, unit: "px", coordinateSpace: "source-canvas" }],
        tracking: { value: 0.5, unit: "px" },
        lineHeight: { value: 34, unit: "px" },
        fontCandidates: [{ family: "Noto Sans CJK SC", score: 0.99 }],
      },
    }],
  };
}

const goldens = [
  { name: "CJK、英文与数字混排", text: "第 2 章 AI 2026", alignment: "left" },
  { name: "长文本", text: "高保真图片转演示文稿需要在保留文本可编辑性的前提下精确恢复排版与度量。", alignment: "left" },
  { name: "居中文本", text: "Centered Title 2026", alignment: "center" },
  { name: "右对齐多行文本", text: "Right aligned line one\nRight aligned line two", alignment: "right", lineCount: 2 },
  { name: "低清晰 OCR", text: "低清晰文字 A1", observedText: "低清晰文字 Al", confidence: 0.42, alignment: "left" },
];

for (const golden of goldens) {
  test(`文字拟合 golden: ${golden.name}`, () => {
    const content = textContent(golden.text, golden);
    const metrics = resolveTextMetrics({
      content,
      sourceNodeRef: "golden-text",
      evidenceGraph: textMetricsEvidence(golden.text, golden),
    });
    const decision = fitTextMetrics({ resolvedContent: content, textMetrics: metrics });

    assert.deepEqual(decision.fontFamilies, ["Noto Sans CJK SC"]);
    assert.deepEqual(decision.fallbackFontFamilies, ["Author Sans", "Fallback Sans"]);
    assert.deepEqual(decision.tracking, { value: 0.5, unit: "px" });
    assert.deepEqual(decision.lineHeight, { value: 34, unit: "px" });
    assert.equal(decision.anchor, "baseline");
    assert.equal(decision.textBoxStrategy, "fixed-bounds");
    assert.equal(metrics.runs[0].authorText, golden.text);
    assert.equal(metrics.runs[0].ocrConflict, golden.observedText !== undefined);
  });
}
