function overlaps(left, right) {
  return left.start < right.end && right.start < left.end;
}

function textSlice(content, range) {
  const boundaries = content.indexing.utf16Boundaries;
  return content.text.slice(boundaries[range.start], boundaries[range.end]);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function textMetricEvidence(evidenceGraph, sourceNodeRef) {
  return evidenceGraph.evidence
    .filter((evidence) => evidence.measurement.kind === "text-metrics")
    .filter((evidence) => evidence.subjects.some((subject) => subject.nodeRef === sourceNodeRef))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function constraintFor(constraints, suffix) {
  return constraints
    .filter((constraint) => constraint.parameterPath.endsWith(suffix))
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))[0];
}

function clampLength(length, constraint) {
  if (!constraint || constraint.locked || constraint.unit !== length.unit) return structuredClone(length);
  return {
    ...structuredClone(length),
    value: Math.max(constraint.range.min, Math.min(constraint.range.max, length.value)),
  };
}

function authorLineHeight(content, fontSize) {
  const spacing = content.paragraphs[0]?.lineSpacing;
  if (!spacing) return structuredClone(fontSize);
  if (spacing.mode === "exact") return { value: spacing.value, unit: fontSize.unit };
  return { value: spacing.value * fontSize.value, unit: fontSize.unit };
}

/**
 * 将可审计的文字度量 evidence 关联到作者声明的 runs。OCR 观测只作为观测保留，
 * 永远不替换作者文本。
 */
export function resolveTextMetrics({ content, sourceNodeRef, evidenceGraph }) {
  if (content?.kind !== "text") throw new TypeError("Text Metrics Resolver 只接受 text content");
  const evidence = textMetricEvidence(evidenceGraph, sourceNodeRef);
  if (!evidence.length) return undefined;

  return {
    evidenceRefs: evidence.map((item) => item.id),
    runs: content.runs.map((run) => {
      const observations = evidence.flatMap((item) => item.measurement.tokens
        .filter((token) => overlaps(token.range, run.range))
        .map((token) => ({ ...structuredClone(token), evidenceRef: item.id })));
      const authorText = textSlice(content, run.range);
      const observedText = observations.map((token) => token.text).join("");
      return {
        range: structuredClone(run.range),
        authorText,
        observedTokens: observations,
        ocrConflict: observations.length > 0 && observedText !== authorText,
      };
    }),
    measurements: evidence.map((item) => ({
      evidenceRef: item.id,
      measurement: structuredClone(item.measurement),
    })),
  };
}

/**
 * 依据 Core 已解析的度量和作者约束生成最终执行决策。没有 evidence 时仍产生
 * 作者值决策，确保渲染端不需要访问作者契约或源图来补全默认值。
 */
export function fitTextMetrics({ resolvedContent, textMetrics, fitConstraints = [] }) {
  if (resolvedContent?.kind !== "text") throw new TypeError("Text Fitter 只接受已解析 text content");
  const firstRun = resolvedContent.runs[0];
  const firstParagraph = resolvedContent.paragraphs[0];
  const measurements = textMetrics?.measurements ?? [];
  const metricValues = measurements.map((item) => item.measurement);
  const candidateFamilies = metricValues
    .flatMap((measurement) => measurement.fontCandidates)
    .sort((left, right) => right.score - left.score || left.family.localeCompare(right.family))
    .map((candidate) => candidate.family);
  const families = unique([...candidateFamilies, ...firstRun.style.fontFamilies]);
  const trackingMetric = metricValues.find((measurement) => measurement.tracking)?.tracking;
  const lineHeightMetric = metricValues.find((measurement) => measurement.lineHeight)?.lineHeight;
  const fontSize = clampLength(firstRun.style.fontSize, constraintFor(fitConstraints, "/fontSize/value"));
  const tracking = clampLength(trackingMetric ?? firstRun.style.tracking, constraintFor(fitConstraints, "/tracking/value"));
  const lineHeight = clampLength(lineHeightMetric ?? authorLineHeight(resolvedContent, fontSize), constraintFor(fitConstraints, "/lineSpacing"));
  const baselineShift = clampLength(firstRun.style.baselineShift, constraintFor(fitConstraints, "/baselineShift/value"));
  const hasBaselines = metricValues.some((measurement) => measurement.baselines.length > 0);
  const hasLineBoxes = metricValues.some((measurement) => measurement.lineBoxes?.length > 0);

  return {
    fontFamilies: [families[0]],
    ...(families.length > 1 ? { fallbackFontFamilies: families.slice(1) } : {}),
    fontSize,
    tracking,
    lineHeight,
    baselineShift,
    ...(firstParagraph.spacingBefore.value !== 0 ? { paragraphSpacingBefore: structuredClone(firstParagraph.spacingBefore) } : {}),
    ...(firstParagraph.spacingAfter.value !== 0 ? { paragraphSpacingAfter: structuredClone(firstParagraph.spacingAfter) } : {}),
    anchor: hasBaselines ? "baseline" : "top-left",
    textBoxStrategy: hasLineBoxes ? "fixed-bounds" : resolvedContent.layout.mode === "positioned-clusters" ? "positioned-clusters" : "native-flow",
    evidenceRefs: textMetrics?.evidenceRefs ?? [],
    selectionReason: measurements.length
      ? "依据文字度量 evidence 与作者约束生成。"
      : "未提供文字度量 evidence，执行作者声明的文字参数。",
  };
}
