import fs from "node:fs/promises";
import path from "node:path";

const REQUIRED_GATES = new Map([
  ["editability", "editabilityResults"],
  ["object-manifest", "objectResults"],
  ["package-safety", "packageSecurity"],
]);

function metric(name, value, threshold, direction = "higher-is-better") {
  return { name, value, unit: "score", threshold, direction };
}

function allPassed(results) {
  return Array.isArray(results) && results.length > 0 && results.every((item) => item.status === "passed");
}

function averagePageMetric(verificationResult, name) {
  const values = (verificationResult?.pageResults ?? [])
    .map((item) => item.metrics?.[name])
    .filter((value) => typeof value === "number");
  if (values.length) return values.reduce((sum, value) => sum + value, 0) / values.length;
  return verificationResult?.summary?.weightedVisualScore ?? 0;
}

function gateFailure(reason, details) {
  return { status: "failed", failureCode: reason, details };
}

function corpusResultFor({ sample, qualityGates, verificationResult, assetFailure }) {
  if (assetFailure) {
    return {
      sampleId: sample.sampleId,
      sampleKind: sample.sampleKind,
      independentReference: Boolean(sample.independentReference),
      metrics: [],
      ...assetFailure,
    };
  }
  const global = verificationResult?.summary ?? {};
  const thresholds = { ...qualityGates.global, ...sample.thresholds };
  const metrics = [
    metric("pixel-similarity", averagePageMetric(verificationResult, "globalPixelSimilarity"), thresholds.pixel),
    metric("edge-similarity", averagePageMetric(verificationResult, "globalEdgeSimilarity"), thresholds.edge),
    metric("weighted-visual-score", global.weightedVisualScore ?? 0, qualityGates.global.weightedVisualScore),
    { name: "failed-components", value: (verificationResult?.componentResults ?? []).filter((item) => item.status === "failed").length, unit: "count", threshold: qualityGates.component.maxFailedComponents, direction: "lower-is-better" },
  ];
  const requiredGateFailures = [...REQUIRED_GATES].filter(([gate, property]) => {
    const value = verificationResult?.[property];
    return property === "packageSecurity" ? value?.status !== "passed" : !allPassed(value);
  }).map(([gate]) => gate);
  const failedMetric = metrics.some((item) => item.direction === "lower-is-better" ? item.value > item.threshold : item.value < item.threshold);
  const status = verificationResult?.status !== "passed" || failedMetric || requiredGateFailures.length ? "failed" : "passed";
  return {
    sampleId: sample.sampleId,
    sampleKind: sample.sampleKind,
    independentReference: true,
    status,
    metrics,
    ...(status === "failed" ? { failureCode: "corpus-failure", details: { requiredGateFailures } } : {}),
  };
}

export function attachGoldenCorpusResult(verificationResult, corpusResult) {
  const { details, ...schemaCorpusResult } = corpusResult;
  const goldenCorpusResults = [...(verificationResult.goldenCorpusResults ?? []), schemaCorpusResult];
  if (corpusResult.status === "passed") return { ...verificationResult, goldenCorpusResults };
  const failure = {
    category: "golden-corpus",
    subjectRef: corpusResult.sampleId,
    code: corpusResult.failureCode ?? "corpus-failure",
    message: `Golden corpus 样例未通过: ${corpusResult.sampleId}`,
    ...(details ? { details } : {}),
  };
  const failures = [...(verificationResult.failures ?? []), failure];
  return {
    ...verificationResult,
    status: "failed-quality-gate",
    goldenCorpusResults,
    summary: {
      ...verificationResult.summary,
      totalChecks: (verificationResult.summary?.totalChecks ?? 0) + 1,
      failedChecks: Math.max((verificationResult.summary?.failedChecks ?? 0) + 1, failures.length),
      gateStatus: "failed-quality-gate",
    },
    failures,
  };
}

async function assetFailureFor(rootDir, sample, referencePolicy) {
  if (!sample.independentReference || sample.referencePath !== sample.sourcePath) {
    return gateFailure("renderer-generated-only", { message: "样例必须声明独立参考图，且 source/reference 绑定同一独立输入" });
  }
  for (const filePath of [sample.sourcePath, sample.referencePath]) {
    if (!filePath.startsWith(referencePolicy.pathPrefix) || referencePolicy.forbiddenPathFragments.some((fragment) => filePath.includes(fragment))) {
      return gateFailure("renderer-generated-only", { filePath, message: "样例路径违反独立参考图策略" });
    }
    try {
      await fs.access(path.resolve(rootDir, filePath));
    } catch {
      return gateFailure("missing-reference", { filePath, message: "Golden corpus 输入图不存在" });
    }
  }
  return undefined;
}

export async function runGoldenCorpus({ manifestPath, sampleIds, runSample, reportPath } = {}) {
  if (typeof runSample !== "function") throw new TypeError("Golden corpus runner 需要 runSample 转换执行函数");
  const resolvedManifestPath = path.resolve(manifestPath ?? "golden-corpus/manifest.json");
  const rootDir = path.resolve(path.dirname(resolvedManifestPath), "..");
  const manifest = JSON.parse(await fs.readFile(resolvedManifestPath, "utf8"));
  const selected = manifest.samples.filter((sample) => !sampleIds || sampleIds.includes(sample.sampleId));
  if (!selected.length) throw new Error("Golden corpus 没有匹配的样例");
  const results = [];
  for (const sample of selected) {
    const assetFailure = await assetFailureFor(rootDir, sample, manifest.referencePolicy);
    const verificationResult = assetFailure ? undefined : await runSample({
      sample,
      sourcePath: path.resolve(rootDir, sample.sourcePath),
      referencePath: path.resolve(rootDir, sample.referencePath),
      visualThresholds: { global: manifest.qualityGates.global, [sample.sampleKind]: sample.thresholds },
      requiredGates: manifest.qualityGates.required,
    });
    const corpusResult = corpusResultFor({ sample, qualityGates: manifest.qualityGates, verificationResult, assetFailure });
    results.push({ sampleId: sample.sampleId, corpusResult, verificationResult: verificationResult && attachGoldenCorpusResult(verificationResult, corpusResult) });
  }
  const status = results.every((item) => item.corpusResult.status === "passed") ? "passed" : "failed-quality-gate";
  const report = { corpusId: manifest.corpusId, status, results };
  if (reportPath) {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}
