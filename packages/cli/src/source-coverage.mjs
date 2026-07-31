import fs from "node:fs/promises";
import sharp from "sharp";

const EDGE_THRESHOLD = 48;
const COLOR_THRESHOLD = 24;
const OBSERVATION_TOLERANCE_PX = 3;

function sobel(gray, width, height) {
  const edges = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const gx = -gray[index - width - 1] + gray[index - width + 1]
        - 2 * gray[index - 1] + 2 * gray[index + 1]
        - gray[index + width - 1] + gray[index + width + 1];
      const gy = -gray[index - width - 1] - 2 * gray[index - width] - gray[index - width + 1]
        + gray[index + width - 1] + 2 * gray[index + width] + gray[index + width + 1];
      edges[index] = Math.min(255, Math.round(Math.hypot(gx, gy) / 4));
    }
  }
  return edges;
}

function contains(box, x, y) {
  return x >= box.x - OBSERVATION_TOLERANCE_PX && y >= box.y - OBSERVATION_TOLERANCE_PX
    && x < box.x + box.width + OBSERVATION_TOLERANCE_PX
    && y < box.y + box.height + OBSERVATION_TOLERANCE_PX;
}

function observationCovers(item, x, y, edge) {
  if (!contains(item.box, x, y)) return false;
  if (item.kind === "spacing") return false;
  if (item.kind === "edge") return edge;
  if (item.kind === "image" && item.rasterRole === "source-derived-composite") return false;
  return true;
}

function cornerBackground(data, width, height, channels) {
  // The center sample prevents a full-width footer or header from splitting the
  // four-corner median between two unrelated colors.
  const points = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1], [Math.floor(width / 2), Math.floor(height / 2)]];
  return [0, 1, 2].map((channel) => {
    const values = points.map(([x, y]) => data[(y * width + x) * channels + channel]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  });
}

export async function probeSourceCoverage(bundle, sourcePath, { reportPath, overlayPath } = {}) {
  const sourcePlane = bundle.artifacts.find((artifact) => artifact.artifactType === "source-plane");
  const observationPlane = bundle.artifacts.find((artifact) => artifact.artifactType === "observation-plane");
  const ownershipPlane = bundle.artifacts.find((artifact) => artifact.artifactType === "ownership-plane");
  const contract = bundle.artifacts.find((artifact) => artifact.artifactType === "conversion-contract");
  if (!sourcePlane || !observationPlane || !ownershipPlane || !contract) throw new Error("源覆盖探针缺少 Source/Observation/Ownership/Contract Plane");
  const page = sourcePlane.body.pages[0];
  const { data, info } = await sharp(sourcePath).rotate().flatten({ background: "#FFFFFF" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== page.canvas.width || info.height !== page.canvas.height) {
    throw new Error(`源图片尺寸与 Source Plane 不一致: ${info.width}x${info.height} != ${page.canvas.width}x${page.canvas.height}`);
  }
  const background = cornerBackground(data, info.width, info.height, info.channels);
  const gray = new Uint8Array(info.width * info.height);
  for (let pixel = 0; pixel < gray.length; pixel += 1) {
    const offset = pixel * info.channels;
    gray[pixel] = Math.round(data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114);
  }
  const edges = sobel(gray, info.width, info.height);
  const ownedObservationIds = new Set(ownershipPlane.body.assignments.filter((item) => item.responsibility === 1).map((item) => item.observationId));
  const ownedObservations = observationPlane.body.observations.filter((item) => ownedObservationIds.has(item.observationId));
  const overlay = Buffer.alloc(info.width * info.height * 4);
  let salientPixels = 0;
  let salientEdges = 0;
  let coveredPixels = 0;
  let coveredEdges = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const pixel = y * info.width + x;
      const offset = pixel * info.channels;
      const colorDistance = Math.max(Math.abs(data[offset] - background[0]), Math.abs(data[offset + 1] - background[1]), Math.abs(data[offset + 2] - background[2]));
      const edge = edges[pixel] >= EDGE_THRESHOLD;
      const salient = edge || colorDistance >= COLOR_THRESHOLD;
      if (!salient) continue;
      salientPixels += 1;
      if (edge) salientEdges += 1;
      const covered = ownedObservations.some((item) => observationCovers(item, x, y, edge));
      const visualOffset = pixel * 4;
      if (covered) {
        coveredPixels += 1;
        if (edge) coveredEdges += 1;
        overlay[visualOffset] = 30;
        overlay[visualOffset + 1] = 190;
        overlay[visualOffset + 2] = 90;
        overlay[visualOffset + 3] = 150;
      } else {
        overlay[visualOffset] = 225;
        overlay[visualOffset + 1] = 30;
        overlay[visualOffset + 2] = 55;
        overlay[visualOffset + 3] = 220;
      }
    }
  }
  const sourcePixelCoverage = salientPixels ? coveredPixels / salientPixels : 1;
  const sourceEdgeCoverage = salientEdges ? coveredEdges / salientEdges : 1;
  const thresholds = {
    sourcePixelCoverage: Math.max(0.98, contract.body.acceptance.coverage.sourcePixelCoverage),
    sourceEdgeCoverage: 0.96,
  };
  const status = sourcePixelCoverage >= thresholds.sourcePixelCoverage && sourceEdgeCoverage >= thresholds.sourceEdgeCoverage ? "passed" : "failed-quality-gate";
  const report = { algorithm: "img2ppt-source-coverage-vnext-1", status, dimensions: { width: info.width, height: info.height }, thresholds: { ...thresholds, observationTolerancePx: OBSERVATION_TOLERANCE_PX }, salientPixels, salientEdges, coveredPixels, coveredEdges, sourcePixelCoverage, sourceEdgeCoverage };
  if (reportPath) await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (overlayPath) {
    const mask = await sharp(overlay, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
    await sharp(sourcePath).composite([{ input: mask }]).png().toFile(overlayPath);
  }
  return report;
}
