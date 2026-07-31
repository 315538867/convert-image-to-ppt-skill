import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileBlob, PresentationFile } from "./artifact-tool-loader.mjs";
import { unzipSync } from "fflate";
import { DOMParser } from "@xmldom/xmldom";

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const INSPECTION_MAX_CHARS = 2_000_000;

function parseNdjson(ndjson) {
  return ndjson.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export async function inspectPptx(pptxPath, expectedManifest = [], options = {}) {
  const presentation = await PresentationFile.importPptx(await FileBlob.load(pptxPath));
  const snapshot = await presentation.inspect({
    kind: "slide,textbox,shape,image,table,layout",
    maxChars: options.maxChars ?? INSPECTION_MAX_CHARS,
  });
  const records = parseNdjson(snapshot.ndjson);
  const layouts = await Promise.all(presentation.slides.items.map(async (slide) => JSON.parse(await (await slide.export({ format: "layout" })).text())));
  const layout = layouts[0];
  const objects = records.filter((record) => ["textbox", "shape", "image", "table"].includes(record.kind));
  const errors = [];
  for (const notice of records.filter((record) => record.kind === "notice")) {
    errors.push({ code: "INSPECTION_INCOMPLETE", message: notice.message });
  }
  const byName = new Map(objects.filter((record) => record.name).map((record) => [record.name, record]));
  const expectedNative = expectedManifest.filter((item) => !item.virtual);
  const expectedNames = new Set(expectedNative.map((item) => item.primitiveId));
  const expectedKinds = { text: "textbox", path: "shape", connector: "shape", image: "image" };
  for (const actual of objects.filter((item) => item.name?.startsWith("primitive-"))) {
    if (!expectedNames.has(actual.name)) errors.push({ code: "UNDECLARED_NATIVE_OBJECT", name: actual.name, kind: actual.kind });
  }
  for (const expected of expectedNative) {
    const actual = byName.get(expected.primitiveId);
    if (!actual) {
      errors.push({ code: "MISSING_NATIVE_OBJECT", primitiveId: expected.primitiveId });
      continue;
    }
    if (expectedKinds[expected.kind] && actual.kind !== expectedKinds[expected.kind]) {
      errors.push({ code: "OBJECT_KIND_MISMATCH", primitiveId: expected.primitiveId, expected: expectedKinds[expected.kind], actual: actual.kind });
    }
    const actualBox = actual.bbox ?? [];
    const expectedBox = [expected.bbox.left, expected.bbox.top, expected.bbox.width, expected.bbox.height];
    if (actualBox.length !== 4 || expectedBox.some((value, index) => Math.abs(value - actualBox[index]) > 0.01)) {
      errors.push({ code: "BBOX_MISMATCH", primitiveId: expected.primitiveId, expected: expectedBox, actual: actualBox });
    }
  }
  const textExpected = expectedManifest.filter((item) => item.kind === "text" && !item.virtual);
  for (const expected of textExpected) {
    const actual = byName.get(expected.primitiveId);
    const sourceText = options.textByPrimitiveId?.[expected.primitiveId];
    if (sourceText !== undefined && actual?.text !== sourceText) {
      errors.push({ code: "TEXT_MISMATCH", primitiveId: expected.primitiveId, expected: sourceText, actual: actual?.text });
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    ndjson: snapshot.ndjson,
    records,
    objects,
    layout,
    layouts,
    pptxPath,
  };
}

export async function inspectPptxImageCrops(pptxPath) {
  const archive = unzipSync(new Uint8Array(await fs.readFile(pptxPath)));
  const result = {};
  for (const name of Object.keys(archive)) {
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue;
    const document = new DOMParser().parseFromString(new TextDecoder().decode(archive[name]), "application/xml");
    for (const picture of Array.from(document.getElementsByTagNameNS(P_NS, "pic"))) {
      const nameNode = Array.from(picture.getElementsByTagNameNS(P_NS, "cNvPr"))[0];
      const srcRect = Array.from(picture.getElementsByTagNameNS(A_NS, "srcRect"))[0];
      if (!nameNode || !srcRect) continue;
      result[nameNode.getAttribute("name")] = {
        left: Number(srcRect.getAttribute("l") || 0),
        top: Number(srcRect.getAttribute("t") || 0),
        right: Number(srcRect.getAttribute("r") || 0),
        bottom: Number(srcRect.getAttribute("b") || 0),
      };
    }
  }
  return result;
}

export async function inspectPptxPathCommands(pptxPath) {
  const archive = unzipSync(new Uint8Array(await fs.readFile(pptxPath)));
  const result = {};
  for (const name of Object.keys(archive)) {
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue;
    const document = new DOMParser().parseFromString(new TextDecoder().decode(archive[name]), "application/xml");
    for (const shape of Array.from(document.getElementsByTagNameNS(P_NS, "sp"))) {
      const nameNode = Array.from(shape.getElementsByTagNameNS(P_NS, "cNvPr"))[0];
      const pathNode = Array.from(shape.getElementsByTagNameNS(A_NS, "path"))[0];
      if (!nameNode || !pathNode) continue;
      result[nameNode.getAttribute("name")] = Array.from(pathNode.childNodes)
        .filter((node) => node.nodeType === 1)
        .map((node) => ({
          kind: node.localName,
          ...(node.localName === "arcTo" ? {
            radiusX: Number(node.getAttribute("wR")),
            radiusY: Number(node.getAttribute("hR")),
            startAngle: Number(node.getAttribute("stAng")),
            sweepAngle: Number(node.getAttribute("swAng")),
          } : {}),
        }));
    }
  }
  return result;
}

export async function probePptxEditability(pptxPath, expectedManifest = []) {
  const presentation = await PresentationFile.importPptx(await FileBlob.load(pptxPath));
  const snapshot = await presentation.inspect({ kind: "textbox,shape,image,table", maxChars: INSPECTION_MAX_CHARS });
  const records = parseNdjson(snapshot.ndjson);
  const byName = new Map(records.filter((record) => record.name).map((record) => [record.name, record]));
  const mutations = [];
  const missing = [];
  for (const expected of expectedManifest.filter((item) => !item.virtual)) {
    const record = byName.get(expected.primitiveId);
    if (!record) {
      missing.push({
        primitiveId: expected.primitiveId,
        objectFound: false,
        geometryPersisted: false,
        contentPersisted: false,
        passed: false,
      });
      continue;
    }
    const object = presentation.resolve(record.id);
    if (expected.kind === "image") {
      object.frame = { ...object.frame, left: object.frame.left + 1 };
    } else {
      object.position = { ...object.position, left: object.position.left + 1 };
    }
    let expectedText;
    if (expected.kind === "text") {
      expectedText = `${record.text}\u25A1`;
      object.text.set(expectedText);
    }
    mutations.push({ primitiveId: expected.primitiveId, objectFound: true, originalLeft: record.bbox[0], expectedText });
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "img2ppt-editability-"));
  const derivedPath = path.join(directory, "mutated.pptx");
  try {
    await (await PresentationFile.exportPptx(presentation)).save(derivedPath);
    const reopened = await PresentationFile.importPptx(await FileBlob.load(derivedPath));
    const reopenedSnapshot = await reopened.inspect({ kind: "textbox,shape,image,table", maxChars: INSPECTION_MAX_CHARS });
    const reopenedRecords = parseNdjson(reopenedSnapshot.ndjson);
    const reopenedByName = new Map(reopenedRecords.filter((record) => record.name).map((record) => [record.name, record]));
    const results = [...missing, ...mutations.map((mutation) => {
      const actual = reopenedByName.get(mutation.primitiveId);
      const geometryPersisted = Boolean(actual) && Math.abs(actual.bbox[0] - (mutation.originalLeft + 1)) < 0.01;
      const contentPersisted = mutation.expectedText === undefined || actual?.text === mutation.expectedText;
      return { ...mutation, actualLeft: actual?.bbox?.[0], actualText: actual?.text, geometryPersisted, contentPersisted, passed: geometryPersisted && contentPersisted };
    })];
    const expectedCount = expectedManifest.filter((item) => !item.virtual).length;
    return {
      status: results.length === expectedCount && results.length > 0 && results.every((item) => item.passed) ? "passed" : "failed-quality-gate",
      expectedCount,
      probedCount: mutations.length,
      results,
    };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith("inspect-pptx.mjs")) {
  const report = await inspectPptx(process.argv[2]);
  console.log(JSON.stringify({ ok: report.ok, errors: report.errors, objects: report.objects.length }, null, 2));
  if (!report.ok) process.exitCode = 1;
}
