import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const DEFAULT_THRESHOLDS = {
  global: { pixel: 0.96, edge: 0.88 },
  text: { pixel: 0.94, edge: 0.88 },
  "table-text": { pixel: 0.94, edge: 0.88 },
  "simple-icon": { pixel: 0.95, edge: 0.9 },
  border: { pixel: 0, edge: 0.92 },
  connector: { pixel: 0.95, edge: 0.92 },
  shape: { pixel: 0.97, edge: 0.92 },
  image: { pixel: 0.97, edge: 0.9 },
  spacing: { pixel: 0.98, edge: 0.92 },
  color: { pixel: 0.985, edge: 0 },
  generic: { pixel: 0.94, edge: 0.86 },
};

const EDGE_THRESHOLD = 72;
const EDGE_TOLERANCE = {
  global: 2,
  text: 2,
  "table-text": 2,
  "simple-icon": 2,
  border: 2,
  connector: 2,
  shape: 2,
  image: 2,
  spacing: 1,
  color: 2,
  generic: 2,
};

const DEFAULT_WEIGHTS = {
  text: 4,
  "table-text": 4,
  "simple-icon": 3,
  border: 4,
  connector: 3,
  shape: 3,
  image: 2,
  spacing: 3,
  color: 3,
  generic: 1,
};

async function loadRgb(imagePath) {
  const { data, info } = await sharp(imagePath)
    .flatten({ background: "#FFFFFF" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function luminance(rgb, pixelIndex, channels) {
  const offset = pixelIndex * channels;
  return 0.2126 * rgb[offset] + 0.7152 * rgb[offset + 1] + 0.0722 * rgb[offset + 2];
}

function edgeMap(image) {
  const result = new Float32Array(image.width * image.height);
  for (let y = 1; y < image.height - 1; y += 1) {
    for (let x = 1; x < image.width - 1; x += 1) {
      const at = (dx, dy) => luminance(image.data, (y + dy) * image.width + x + dx, image.channels);
      const gx = -at(-1, -1) + at(1, -1) - 2 * at(-1, 0) + 2 * at(1, 0) - at(-1, 1) + at(1, 1);
      const gy = -at(-1, -1) - 2 * at(0, -1) - at(1, -1) + at(-1, 1) + 2 * at(0, 1) + at(1, 1);
      result[y * image.width + x] = Math.min(1020, Math.hypot(gx, gy));
    }
  }
  return result;
}

function boxBlur(image) {
  const data = Buffer.alloc(image.width * image.height * image.channels);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const sums = [0, 0, 0];
      let samples = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const sy = y + dy;
        if (sy < 0 || sy >= image.height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const sx = x + dx;
          if (sx < 0 || sx >= image.width) continue;
          const offset = (sy * image.width + sx) * image.channels;
          sums[0] += image.data[offset];
          sums[1] += image.data[offset + 1];
          sums[2] += image.data[offset + 2];
          samples += 1;
        }
      }
      const output = (y * image.width + x) * image.channels;
      data[output] = Math.round(sums[0] / samples);
      data[output + 1] = Math.round(sums[1] / samples);
      data[output + 2] = Math.round(sums[2] / samples);
    }
  }
  return { ...image, data };
}

function normalizedRegion(region, width, height) {
  const x0 = Math.max(0, Math.min(width, Math.floor(region?.x ?? 0)));
  const y0 = Math.max(0, Math.min(height, Math.floor(region?.y ?? 0)));
  const x1 = Math.max(x0, Math.min(width, Math.ceil((region?.x ?? 0) + (region?.width ?? width))));
  const y1 = Math.max(y0, Math.min(height, Math.ceil((region?.y ?? 0) + (region?.height ?? height))));
  if (x1 === x0 || y1 === y0) throw new Error("视觉差异区域不能为空");
  return { x0, y0, x1, y1 };
}

function normalizedExclusions(region, width, height) {
  return (region?.excludeBboxes ?? []).map((box) => normalizedRegion(box, width, height));
}

function isExcluded(x, y, exclusions) {
  return exclusions.some((box) => x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1);
}

function hasNearbyEdge(edges, width, height, x, y, bounds, exclusions, tolerance) {
  for (let dy = -tolerance; dy <= tolerance; dy += 1) {
    const sy = y + dy;
    if (sy < bounds.y0 || sy >= bounds.y1 || sy < 0 || sy >= height) continue;
    for (let dx = -tolerance; dx <= tolerance; dx += 1) {
      if (dx * dx + dy * dy > tolerance * tolerance) continue;
      const sx = x + dx;
      if (sx < bounds.x0 || sx >= bounds.x1 || sx < 0 || sx >= width || isExcluded(sx, sy, exclusions)) continue;
      if (edges[sy * width + sx] >= EDGE_THRESHOLD) return true;
    }
  }
  return false;
}

function tolerantEdgeF1(sourceEdges, renderedEdges, width, height, bounds, exclusions, tolerance) {
  let sourceCount = 0;
  let renderedCount = 0;
  let sourceMatched = 0;
  let renderedMatched = 0;
  for (let y = bounds.y0; y < bounds.y1; y += 1) {
    for (let x = bounds.x0; x < bounds.x1; x += 1) {
      if (isExcluded(x, y, exclusions)) continue;
      const index = y * width + x;
      if (sourceEdges[index] >= EDGE_THRESHOLD) {
        sourceCount += 1;
        if (hasNearbyEdge(renderedEdges, width, height, x, y, bounds, exclusions, tolerance)) sourceMatched += 1;
      }
      if (renderedEdges[index] >= EDGE_THRESHOLD) {
        renderedCount += 1;
        if (hasNearbyEdge(sourceEdges, width, height, x, y, bounds, exclusions, tolerance)) renderedMatched += 1;
      }
    }
  }
  if (sourceCount === 0 && renderedCount === 0) return { similarity: 1, sourceCount, renderedCount };
  if (sourceCount === 0 || renderedCount === 0) return { similarity: 0, sourceCount, renderedCount };
  const recall = sourceMatched / sourceCount;
  const precision = renderedMatched / renderedCount;
  return {
    similarity: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    sourceCount,
    renderedCount,
  };
}

function compareRegion(source, rendered, perceptualSource, perceptualRendered, sourceEdges, renderedEdges, region, category) {
  const bounds = normalizedRegion(region?.bbox ?? region, source.width, source.height);
  const exclusions = normalizedExclusions(region, source.width, source.height);
  let colorDifference = 0;
  let rawColorDifference = 0;
  let pixelCount = 0;
  const flatColor = region?.pixelMode === "flat-color" || category === "color";
  for (let y = bounds.y0; y < bounds.y1; y += 1) {
    for (let x = bounds.x0; x < bounds.x1; x += 1) {
      if (isExcluded(x, y, exclusions)) continue;
      const pixelIndex = y * source.width + x;
      if (flatColor && Math.max(sourceEdges[pixelIndex], renderedEdges[pixelIndex]) >= EDGE_THRESHOLD) continue;
      const sourceOffset = pixelIndex * source.channels;
      const renderedOffset = pixelIndex * rendered.channels;
      rawColorDifference += Math.abs(source.data[sourceOffset] - rendered.data[renderedOffset]);
      rawColorDifference += Math.abs(source.data[sourceOffset + 1] - rendered.data[renderedOffset + 1]);
      rawColorDifference += Math.abs(source.data[sourceOffset + 2] - rendered.data[renderedOffset + 2]);
      const comparisonSource = flatColor ? source : perceptualSource;
      const comparisonRendered = flatColor ? rendered : perceptualRendered;
      colorDifference += Math.abs(comparisonSource.data[sourceOffset] - comparisonRendered.data[renderedOffset]);
      colorDifference += Math.abs(comparisonSource.data[sourceOffset + 1] - comparisonRendered.data[renderedOffset + 1]);
      colorDifference += Math.abs(comparisonSource.data[sourceOffset + 2] - comparisonRendered.data[renderedOffset + 2]);
      pixelCount += 1;
    }
  }
  const tolerance = region?.edgeTolerancePx ?? EDGE_TOLERANCE[category] ?? EDGE_TOLERANCE.generic;
  const edge = tolerantEdgeF1(sourceEdges, renderedEdges, source.width, source.height, bounds, exclusions, tolerance);
  return {
    rawPixelSimilarity: pixelCount === 0 ? 1 : 1 - rawColorDifference / (pixelCount * 3 * 255),
    pixelSimilarity: pixelCount === 0 ? 1 : 1 - colorDifference / (pixelCount * 3 * 255),
    edgeSimilarity: edge.similarity,
    edgeSourcePixelCount: edge.sourceCount,
    edgeRenderedPixelCount: edge.renderedCount,
    edgeTolerancePx: tolerance,
    pixelMode: flatColor ? "flat-color" : "box-blur-3x3",
    pixelCount,
  };
}

function thresholdFor(category, overrides = {}) {
  return { ...(DEFAULT_THRESHOLDS[category] ?? DEFAULT_THRESHOLDS.generic), ...(overrides[category] ?? {}) };
}

export async function compareVisuals({ sourcePath, renderedPath, regions = [], thresholds = {}, diffPath }) {
  const [source, rendered] = await Promise.all([loadRgb(sourcePath), loadRgb(renderedPath)]);
  if (source.width !== rendered.width || source.height !== rendered.height) {
    throw new Error(`视觉比较要求像素尺寸一致: source=${source.width}x${source.height}, rendered=${rendered.width}x${rendered.height}`);
  }
  const [sourceEdges, renderedEdges] = [edgeMap(source), edgeMap(rendered)];
  const [perceptualSource, perceptualRendered] = [boxBlur(source), boxBlur(rendered)];
  const global = compareRegion(source, rendered, perceptualSource, perceptualRendered, sourceEdges, renderedEdges, null, "global");
  const globalThreshold = { ...DEFAULT_THRESHOLDS.global, ...(thresholds.global ?? {}) };
  const hardFailures = [];
  if (global.pixelSimilarity < globalThreshold.pixel) hardFailures.push({ scope: "global", metric: "pixel", actual: global.pixelSimilarity, threshold: globalThreshold.pixel });
  if (global.edgeSimilarity < globalThreshold.edge) hardFailures.push({ scope: "global", metric: "edge", actual: global.edgeSimilarity, threshold: globalThreshold.edge });

  const regionResults = regions.map((region) => {
    const metrics = compareRegion(source, rendered, perceptualSource, perceptualRendered, sourceEdges, renderedEdges, region, region.category);
    const required = { ...thresholdFor(region.category, thresholds), ...(region.thresholds ?? {}) };
    if (metrics.pixelSimilarity < required.pixel) hardFailures.push({ scope: region.regionId, category: region.category, metric: "pixel", actual: metrics.pixelSimilarity, threshold: required.pixel });
    if (metrics.edgeSimilarity < required.edge) hardFailures.push({ scope: region.regionId, category: region.category, metric: "edge", actual: metrics.edgeSimilarity, threshold: required.edge });
    return { regionId: region.regionId, category: region.category, bbox: region.bbox, excludeBboxes: region.excludeBboxes ?? [], thresholds: required, ...metrics };
  });

  const scoreEntries = [{ score: (global.pixelSimilarity + global.edgeSimilarity) / 2, weight: 1 }, ...regionResults.map((region, index) => ({
    score: (region.pixelSimilarity + region.edgeSimilarity) / 2,
    weight: regions[index].weight ?? DEFAULT_WEIGHTS[region.category] ?? 1,
  }))];
  const weightTotal = scoreEntries.reduce((sum, item) => sum + item.weight, 0);
  const weightedScore = scoreEntries.reduce((sum, item) => sum + item.score * item.weight, 0) / weightTotal;

  if (diffPath) {
    const heatmap = Buffer.alloc(source.width * source.height * 4);
    for (let index = 0; index < source.width * source.height; index += 1) {
      const sourceOffset = index * source.channels;
      const renderedOffset = index * rendered.channels;
      const difference = Math.max(
        Math.abs(source.data[sourceOffset] - rendered.data[renderedOffset]),
        Math.abs(source.data[sourceOffset + 1] - rendered.data[renderedOffset + 1]),
        Math.abs(source.data[sourceOffset + 2] - rendered.data[renderedOffset + 2]),
      );
      heatmap[index * 4] = difference;
      heatmap[index * 4 + 1] = 0;
      heatmap[index * 4 + 2] = 0;
      heatmap[index * 4 + 3] = 255;
    }
    await sharp(heatmap, { raw: { width: source.width, height: source.height, channels: 4 } }).png().toFile(diffPath);
  }

  return {
    algorithm: "img2ppt-spatially-tolerant-visual-diff-v2",
    dimensions: { width: source.width, height: source.height },
    global: { thresholds: globalThreshold, ...global },
    regions: regionResults,
    weightedScore,
    hardFailures,
    status: hardFailures.length ? "failed-quality-gate" : "passed",
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sourcePath, renderedPath, reportPath, diffPath] = process.argv.slice(2);
  if (!sourcePath || !renderedPath || !reportPath) {
    console.error("用法: node packages/cli/src/visual-diff.mjs <source.png> <rendered.png> <report.json> [diff.png]");
    process.exit(2);
  }
  const report = await compareVisuals({ sourcePath, renderedPath, diffPath });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "passed") process.exitCode = 1;
}
