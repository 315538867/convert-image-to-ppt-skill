import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const SHEET_WIDTH = 920;
const CROP_WIDTH = 420;
const CROP_HEIGHT = 180;
const ROW_HEIGHT = 224;
const MAX_REGIONS = 6;

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('\"', "&quot;");
}

function normalizedCrop(box, width, height, padding = 8) {
  const x = Math.max(0, Math.floor((box?.x ?? 0) - padding));
  const y = Math.max(0, Math.floor((box?.y ?? 0) - padding));
  const right = Math.min(width, Math.ceil((box?.x ?? 0) + (box?.width ?? width) + padding));
  const bottom = Math.min(height, Math.ceil((box?.y ?? 0) + (box?.height ?? height) + padding));
  return { left: x, top: y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

function selectedRegions(visual) {
  const failed = new Set(visual.hardFailures.filter((item) => item.scope !== "global").map((item) => item.scope));
  const ranked = [...visual.regions].sort((left, right) => {
    const leftFailed = failed.has(left.regionId) ? 1 : 0;
    const rightFailed = failed.has(right.regionId) ? 1 : 0;
    if (leftFailed !== rightFailed) return rightFailed - leftFailed;
    return Math.min(left.pixelSimilarity, left.edgeSimilarity) - Math.min(right.pixelSimilarity, right.edgeSimilarity);
  });
  if (ranked.length) return ranked.slice(0, MAX_REGIONS);
  return [{ regionId: "global", category: "global", bbox: { x: 0, y: 0, width: visual.dimensions.width, height: visual.dimensions.height }, pixelSimilarity: visual.global.pixelSimilarity, edgeSimilarity: visual.global.edgeSimilarity }];
}

function labelSvg(region, width = SHEET_WIDTH, height = 36) {
  const score = `pixel ${region.pixelSimilarity.toFixed(4)}  edge ${region.edgeSimilarity.toFixed(4)}`;
  const text = `${region.regionId}  [${region.category}]  ${score}`;
  return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#F3F5F7"/><text x="16" y="24" font-family="Arial, sans-serif" font-size="14" fill="#172B3A">${escapeXml(text)}</text></svg>`);
}

async function cropBuffer(imagePath, crop) {
  return sharp(imagePath)
    .extract(crop)
    .flatten({ background: "#FFFFFF" })
    .resize({ width: CROP_WIDTH, height: CROP_HEIGHT, fit: "contain", background: "#FFFFFF", withoutEnlargement: true })
    .png()
    .toBuffer();
}

export async function createReviewSheet({ sourcePath, renderedPath, visual, outputPath }) {
  const regions = selectedRegions(visual);
  const height = 44 + regions.length * ROW_HEIGHT;
  const composites = [{
    input: Buffer.from(`<svg width="${SHEET_WIDTH}" height="44" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#172B3A"/><text x="20" y="29" font-family="Arial, sans-serif" font-size="16" fill="#FFFFFF">SOURCE</text><text x="480" y="29" font-family="Arial, sans-serif" font-size="16" fill="#FFFFFF">RENDERED</text></svg>`),
    left: 0,
    top: 0,
  }];
  for (let index = 0; index < regions.length; index += 1) {
    const region = regions[index];
    const crop = normalizedCrop(region.bbox, visual.dimensions.width, visual.dimensions.height);
    const [source, rendered] = await Promise.all([cropBuffer(sourcePath, crop), cropBuffer(renderedPath, crop)]);
    const y = 44 + index * ROW_HEIGHT;
    composites.push({ input: labelSvg(region), left: 0, top: y });
    composites.push({ input: source, left: 20, top: y + 38 });
    composites.push({ input: rendered, left: 480, top: y + 38 });
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await sharp({ create: { width: SHEET_WIDTH, height, channels: 3, background: "#E5E9ED" } })
    .composite(composites)
    .png()
    .toFile(outputPath);
  return { path: outputPath, regionIds: regions.map((item) => item.regionId), width: SHEET_WIDTH, height };
}
