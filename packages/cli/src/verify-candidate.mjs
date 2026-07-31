import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { inspectPptx, probePptxEditability } from "@image-to-ppt/renderer-pptx/inspect";
import { compareVisuals } from "./visual-diff.mjs";

export async function verifyCandidate({ sourcePath, previewPath, pptxPath, manifestPath, regions = [], thresholds = {}, diffPath, reportPath }) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const [visual, inspection, editability] = await Promise.all([
    compareVisuals({ sourcePath, renderedPath: previewPath, regions, thresholds, diffPath }),
    inspectPptx(pptxPath, manifest),
    probePptxEditability(pptxPath, manifest),
  ]);
  const failures = [
    ...(visual.status === "passed" ? [] : [{ gate: "visual", details: visual.hardFailures }]),
    ...(inspection.ok ? [] : [{ gate: "object-inspection", details: inspection.errors }]),
    ...(editability.status === "passed" ? [] : [{ gate: "editability", details: editability.results.filter((item) => !item.passed) }]),
  ];
  const report = {
    verifier: "img2ppt-candidate-verifier-v1",
    status: failures.length ? "failed-quality-gate" : "passed",
    visual,
    objectInspection: { ok: inspection.ok, errors: inspection.errors, objectCount: inspection.objects.length, slideCount: inspection.layouts.length },
    editability,
    failures,
  };
  if (reportPath) await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sourcePath, previewPath, pptxPath, manifestPath, reportPath, diffPath] = process.argv.slice(2);
  if (!sourcePath || !previewPath || !pptxPath || !manifestPath || !reportPath) {
    console.error("用法: node packages/cli/src/verify-candidate.mjs <source.png> <preview.png> <deck.pptx> <object-manifest.json> <report.json> [diff.png]");
    process.exit(2);
  }
  const report = await verifyCandidate({ sourcePath, previewPath, pptxPath, manifestPath, reportPath, diffPath });
  if (report.status !== "passed") process.exitCode = 1;
}
