import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256BytesDigest, sha256Digest } from "@image-to-ppt/core/canonical";

function artifactBody(bundle, artifactType) {
  return bundle.artifacts.find((artifact) => artifact.artifactType === artifactType)?.body;
}

export function sourceAnalysisProjection(bundle) {
  const source = artifactBody(bundle, "source-plane");
  const observation = artifactBody(bundle, "observation-plane");
  const ownership = artifactBody(bundle, "ownership-plane");
  const semantic = artifactBody(bundle, "semantic-plane");
  if (!source || !observation || !ownership || !semantic) {
    throw new Error("分析缓存要求完整的 Source、Observation、Ownership 和 Semantic Plane");
  }
  return {
    pages: source.pages,
    observations: observation.observations,
    ownershipAssignments: ownership.assignments,
    semanticSlides: semantic.slides,
    relationGraph: semantic.relationGraph,
    styleResolutionProofs: semantic.styleResolutionProofs,
  };
}

async function readCache(cachePath) {
  try {
    return JSON.parse(await fs.readFile(cachePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function inspectSourceAnalysisCache({ sourcePath, cachePath, includeAnalysis = false }) {
  const [sourceBytes, cache] = await Promise.all([fs.readFile(sourcePath), readCache(cachePath)]);
  const sourceDigest = sha256BytesDigest(sourceBytes);
  if (!cache) return { status: "miss", sourceDigest, cachePath };
  if (cache.cacheVersion !== 1) return { status: "unsupported-version", sourceDigest, cachePath, cacheVersion: cache.cacheVersion };
  if (cache.sourceDigest !== sourceDigest) return { status: "source-changed", sourceDigest, cachedSourceDigest: cache.sourceDigest, cachePath };
  const result = {
    status: "hit",
    sourceDigest,
    analysisDigest: cache.analysisDigest,
    verificationStatus: cache.verificationStatus,
    cachePath,
    analysisSummary: {
      pageCount: cache.analysis.pages.length,
      observationCount: cache.analysis.observations.length,
      semanticSlideCount: cache.analysis.semanticSlides.length,
    },
  };
  if (includeAnalysis) result.analysis = cache.analysis;
  return result;
}

export async function writeSourceAnalysisCache({ bundle, sourcePath, cachePath, verificationStatus = "not-run" }) {
  const sourceBytes = await fs.readFile(sourcePath);
  const sourceDigest = sha256BytesDigest(sourceBytes);
  const analysis = sourceAnalysisProjection(bundle);
  const analysisDigest = sha256Digest(analysis);
  const previous = await readCache(cachePath);
  let status = "created";
  if (previous?.sourceDigest === sourceDigest && previous?.analysisDigest === analysisDigest) status = "hit";
  else if (previous?.sourceDigest === sourceDigest) status = "refreshed-analysis";
  else if (previous) status = "replaced-source";

  const cache = {
    cacheVersion: 1,
    sourceDigest,
    analysisDigest,
    verificationStatus,
    analysis,
  };
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`);
  await fs.rename(temporaryPath, cachePath);
  return { path: cachePath, status, sourceDigest, analysisDigest, verificationStatus };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sourcePath, cachePath] = process.argv.slice(2);
  if (!sourcePath || !cachePath) {
    console.error("用法: node source-analysis-cache.mjs <source.png> <source-analysis-cache.json>");
    process.exit(2);
  }
  const result = await inspectSourceAnalysisCache({ sourcePath, cachePath });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "hit") process.exitCode = 1;
}
