import fs from "node:fs/promises";
import { unzipSync, zipSync } from "fflate";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { indexedTextSegment, sliceIndexedText, textIndexAtUtf16Offset, textIndexLength, utf16OffsetAt } from "@image-to-ppt/core/text-index";

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";

function elementsByTag(node, namespace, localName) {
  return Array.from(node.getElementsByTagNameNS(namespace, localName));
}

function setOrRemove(element, name, value) {
  if (value === undefined || value === null) element.removeAttribute(name);
  else element.setAttribute(name, String(value));
}

function setColorAlpha(document, owner, alpha) {
  const solidFill = elementsByTag(owner, A_NS, "solidFill")[0];
  const color = solidFill ? Array.from(solidFill.childNodes).find((node) => node.nodeType === 1) : undefined;
  if (!color) return false;
  let alphaNode = Array.from(color.childNodes).find((node) => node.nodeType === 1 && node.localName === "alpha");
  if (alpha >= 1) {
    if (alphaNode) color.removeChild(alphaNode);
    return true;
  }
  if (!alphaNode) {
    alphaNode = document.createElementNS(A_NS, "a:alpha");
    color.appendChild(alphaNode);
  }
  alphaNode.setAttribute("val", String(Math.round(Math.max(0, alpha) * 100000)));
  return true;
}

function textRunMetrics(textRun) {
  const metrics = {};
  if (textRun.letterSpacing?.unit === "pt") metrics.spc = Math.round(textRun.letterSpacing.value * 100);
  if (textRun.baselineShift?.unit === "pt" && textRun.font?.size?.unit === "pt" && textRun.font.size.value !== 0) {
    metrics.baseline = Math.round((textRun.baselineShift.value / textRun.font.size.value) * 100000);
  }
  if (textRun.kerning === true) metrics.kern = 0;
  if (textRun.kerning === false) metrics.kern = 400000;
  return metrics;
}

function pathCoordinate(value, unit) {
  if (unit === "pt") return Math.round(value * 12700);
  if (unit === "px") return Math.round(value * 9525);
  throw new Error(`不支持的 path 单位 ${unit}`);
}

function vectorAngle(ux, uy, vx, vy) {
  const denominator = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  if (denominator === 0) return 0;
  const cosine = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / denominator));
  const sign = ux * vy - uy * vx < 0 ? -1 : 1;
  return sign * Math.acos(cosine);
}

function svgArcToDrawingMl(current, command) {
  if (command.rotation !== 0) throw new Error("DrawingML arcTo 不支持旋转椭圆，rotation 必须为 0");
  let radiusX = Math.abs(command.radiusX);
  let radiusY = Math.abs(command.radiusY);
  const target = command.point;
  if (radiusX === 0 || radiusY === 0 || (current.x === target.x && current.y === target.y)) return null;
  const xPrime = (current.x - target.x) / 2;
  const yPrime = (current.y - target.y) / 2;
  const scale = Math.sqrt((xPrime * xPrime) / (radiusX * radiusX) + (yPrime * yPrime) / (radiusY * radiusY));
  if (scale > 1) {
    radiusX *= scale;
    radiusY *= scale;
  }
  const numerator = Math.max(0, radiusX * radiusX * radiusY * radiusY
    - radiusX * radiusX * yPrime * yPrime
    - radiusY * radiusY * xPrime * xPrime);
  const denominator = radiusX * radiusX * yPrime * yPrime + radiusY * radiusY * xPrime * xPrime;
  const sign = command.largeArc === command.sweep ? -1 : 1;
  const coefficient = denominator === 0 ? 0 : sign * Math.sqrt(numerator / denominator);
  const centerPrimeX = coefficient * radiusX * yPrime / radiusY;
  const centerPrimeY = coefficient * -radiusY * xPrime / radiusX;
  const startX = (xPrime - centerPrimeX) / radiusX;
  const startY = (yPrime - centerPrimeY) / radiusY;
  const endX = (-xPrime - centerPrimeX) / radiusX;
  const endY = (-yPrime - centerPrimeY) / radiusY;
  const startAngle = vectorAngle(1, 0, startX, startY);
  let sweepAngle = vectorAngle(startX, startY, endX, endY);
  if (!command.sweep && sweepAngle > 0) sweepAngle -= 2 * Math.PI;
  if (command.sweep && sweepAngle < 0) sweepAngle += 2 * Math.PI;
  return {
    radiusX,
    radiusY,
    startAngle: Math.round(startAngle * 180 / Math.PI * 60000),
    sweepAngle: Math.round(sweepAngle * 180 / Math.PI * 60000),
  };
}

function pointElement(document, point, unit) {
  const element = document.createElementNS(A_NS, "a:pt");
  element.setAttribute("x", String(pathCoordinate(point.x, unit)));
  element.setAttribute("y", String(pathCoordinate(point.y, unit)));
  return element;
}

function patchPathGeometry(document, shape, pathModel) {
  if (pathModel.fillRule !== "nonzero") throw new Error("当前 DrawingML 后端不支持 evenodd fillRule");
  const customGeometry = elementsByTag(shape, A_NS, "custGeom")[0];
  const pathList = customGeometry ? elementsByTag(customGeometry, A_NS, "pathLst")[0] : undefined;
  if (!pathList) throw new Error("目标形状缺少 a:custGeom/a:pathLst");
  while (pathList.firstChild) pathList.removeChild(pathList.firstChild);
  const path = document.createElementNS(A_NS, "a:path");
  path.setAttribute("w", String(pathCoordinate(pathModel.viewBox.width, pathModel.unit)));
  path.setAttribute("h", String(pathCoordinate(pathModel.viewBox.height, pathModel.unit)));
  if (!pathModel.commands.some((command) => command.kind === "close")) path.setAttribute("fill", "none");
  let current = { x: 0, y: 0 };
  let subpathStart = current;
  for (const command of pathModel.commands) {
    let element;
    if (command.kind === "moveTo" || command.kind === "lineTo") {
      element = document.createElementNS(A_NS, command.kind === "moveTo" ? "a:moveTo" : "a:lnTo");
      element.appendChild(pointElement(document, command.point, pathModel.unit));
      current = command.point;
      if (command.kind === "moveTo") subpathStart = command.point;
    } else if (command.kind === "cubicTo") {
      element = document.createElementNS(A_NS, "a:cubicBezTo");
      element.appendChild(pointElement(document, command.control1, pathModel.unit));
      element.appendChild(pointElement(document, command.control2, pathModel.unit));
      element.appendChild(pointElement(document, command.point, pathModel.unit));
      current = command.point;
    } else if (command.kind === "arcTo") {
      const arc = svgArcToDrawingMl(current, command);
      if (!arc) {
        element = document.createElementNS(A_NS, "a:lnTo");
        element.appendChild(pointElement(document, command.point, pathModel.unit));
      } else {
        element = document.createElementNS(A_NS, "a:arcTo");
        element.setAttribute("wR", String(pathCoordinate(arc.radiusX, pathModel.unit)));
        element.setAttribute("hR", String(pathCoordinate(arc.radiusY, pathModel.unit)));
        element.setAttribute("stAng", String(arc.startAngle));
        element.setAttribute("swAng", String(arc.sweepAngle));
      }
      current = command.point;
    } else if (command.kind === "close") {
      element = document.createElementNS(A_NS, "a:close");
      current = subpathStart;
    } else {
      throw new Error(`未知 path command ${command.kind}`);
    }
    path.appendChild(element);
  }
  pathList.appendChild(path);
}

function patchSlideXml(xml, textByShapeName, imageCropsByShapeName, pathsByShapeName, textOpacityByShapeName, imageOpacityByShapeName) {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  const shapeNames = elementsByTag(document, P_NS, "cNvPr");
  let patchedRuns = 0;
  let patchedParagraphs = 0;
  for (const cNvPr of shapeNames) {
    const shapeName = cNvPr.getAttribute("name");
    const model = textByShapeName.get(shapeName);
    if (!model) continue;
    let shape = cNvPr.parentNode;
    while (shape && shape.localName !== "sp") shape = shape.parentNode;
    if (!shape) continue;
    const xmlRuns = elementsByTag(shape, A_NS, "r");
    const sourceRuns = model.runs;
    let cursor = 0;
    const hardBreaks = new Set((model.hardBreakRanges ?? []).filter((range) => range.end === range.start + 1).map((range) => range.start));
    for (const xmlRun of xmlRuns) {
      const textNode = elementsByTag(xmlRun, A_NS, "t")[0];
      const runProperties = elementsByTag(xmlRun, A_NS, "rPr")[0];
      if (!textNode || !runProperties) continue;
      const text = textNode.textContent ?? "";
      while (cursor < textIndexLength(model) && (indexedTextSegment(model, cursor) === "\n" || hardBreaks.has(cursor))) cursor += 1;
      const start = cursor;
      const startOffset = utf16OffsetAt(model, start);
      const end = textIndexAtUtf16Offset(model, startOffset + text.length);
      if (sliceIndexedText(model, start, end) !== text) throw new Error(`PPTX run 文字与显式索引表不一致: ${shapeName}`);
      cursor = end;
      const sourceRun = sourceRuns.find((candidate) => candidate.start <= start && candidate.end >= end) ?? sourceRuns.find((candidate) => candidate.start < end && candidate.end > start);
      if (!sourceRun) continue;
      const metrics = textRunMetrics(sourceRun);
      setOrRemove(runProperties, "spc", metrics.spc === 0 ? undefined : metrics.spc);
      setOrRemove(runProperties, "baseline", metrics.baseline === 0 ? undefined : metrics.baseline);
      setOrRemove(runProperties, "kern", metrics.kern);
      setColorAlpha(document, runProperties, (sourceRun.color?.alpha ?? 1) * (textOpacityByShapeName.get(shapeName) ?? 1));
      patchedRuns += 1;
    }
    const xmlParagraphs = elementsByTag(shape, A_NS, "p");
    for (let index = 0; index < Math.min(xmlParagraphs.length, model.paragraphs.length); index += 1) {
      const xmlParagraph = xmlParagraphs[index];
      const sourceParagraph = model.paragraphs[index];
      let paragraphProperties = Array.from(xmlParagraph.childNodes).find((node) => node.nodeType === 1 && node.localName === "pPr");
      if (!paragraphProperties) {
        paragraphProperties = document.createElementNS(A_NS, "a:pPr");
        xmlParagraph.insertBefore(paragraphProperties, xmlParagraph.firstChild);
      }
      if (sourceParagraph.writingDirection === "rtl") paragraphProperties.setAttribute("rtl", "1");
      else paragraphProperties.removeAttribute("rtl");
      patchedParagraphs += 1;
    }
  }
  for (const picture of elementsByTag(document, P_NS, "pic")) {
    const cNvPr = elementsByTag(picture, P_NS, "cNvPr")[0];
    const shapeName = cNvPr?.getAttribute("name");
    const crop = shapeName ? imageCropsByShapeName.get(shapeName) : undefined;
    const opacity = shapeName ? imageOpacityByShapeName.get(shapeName) : undefined;
    const blipFill = elementsByTag(picture, P_NS, "blipFill")[0] ?? elementsByTag(picture, A_NS, "blipFill")[0];
    if (!blipFill) continue;
    if (crop) {
      let srcRect = elementsByTag(blipFill, A_NS, "srcRect")[0];
      if (!srcRect) {
        srcRect = document.createElementNS(A_NS, "a:srcRect");
        const stretch = elementsByTag(blipFill, A_NS, "stretch")[0];
        if (stretch) blipFill.insertBefore(srcRect, stretch);
        else blipFill.appendChild(srcRect);
      }
      for (const [key, value] of Object.entries({ l: crop.left, t: crop.top, r: crop.right, b: crop.bottom })) {
        if (value > 0) srcRect.setAttribute(key, String(Math.round(value * 100000)));
        else srcRect.removeAttribute(key);
      }
    }
    if (opacity !== undefined) {
      const blip = elementsByTag(blipFill, A_NS, "blip")[0];
      if (blip) {
        let alpha = Array.from(blip.childNodes).find((node) => node.nodeType === 1 && node.localName === "alphaModFix");
        if (opacity >= 1) {
          if (alpha) blip.removeChild(alpha);
        } else {
          if (!alpha) {
            alpha = document.createElementNS(A_NS, "a:alphaModFix");
            blip.appendChild(alpha);
          }
          alpha.setAttribute("amt", String(Math.round(Math.max(0, opacity) * 100000)));
        }
      }
    }
  }
  let patchedPaths = 0;
  for (const cNvPr of shapeNames) {
    const shapeName = cNvPr.getAttribute("name");
    const pathModel = pathsByShapeName.get(shapeName);
    if (!pathModel) continue;
    let shape = cNvPr.parentNode;
    while (shape && shape.localName !== "sp") shape = shape.parentNode;
    if (!shape) continue;
    patchPathGeometry(document, shape, pathModel);
    patchedPaths += 1;
  }
  return { xml: new XMLSerializer().serializeToString(document), patchedRuns, patchedParagraphs, patchedPaths };
}

export async function patchPptxTextMetrics(inputPath, outputPath, textByShapeName, imageCropsByShapeName = new Map(), pathsByShapeName = new Map(), textOpacityByShapeName = new Map(), imageOpacityByShapeName = new Map()) {
  const archive = unzipSync(new Uint8Array(await fs.readFile(inputPath)));
  let patchedRuns = 0;
  let patchedParagraphs = 0;
  let patchedPaths = 0;
  for (const name of Object.keys(archive)) {
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue;
    const result = patchSlideXml(new TextDecoder().decode(archive[name]), textByShapeName, imageCropsByShapeName, pathsByShapeName, textOpacityByShapeName, imageOpacityByShapeName);
    archive[name] = new TextEncoder().encode(result.xml);
    patchedRuns += result.patchedRuns;
    patchedParagraphs += result.patchedParagraphs;
    patchedPaths += result.patchedPaths;
  }
  await fs.writeFile(outputPath, zipSync(archive, { level: 6 }));
  return { patchedRuns, patchedParagraphs, patchedPaths };
}

export async function inspectPptxTextMetrics(pptxPath) {
  const archive = unzipSync(new Uint8Array(await fs.readFile(pptxPath)));
  const result = {};
  for (const name of Object.keys(archive)) {
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue;
    const document = new DOMParser().parseFromString(new TextDecoder().decode(archive[name]), "application/xml");
    for (const cNvPr of elementsByTag(document, P_NS, "cNvPr")) {
      const shapeName = cNvPr.getAttribute("name");
      let shape = cNvPr.parentNode;
      while (shape && shape.localName !== "sp") shape = shape.parentNode;
      if (!shape) continue;
      const values = elementsByTag(shape, A_NS, "rPr").map((runProperties) => ({
        ...(runProperties.hasAttribute("spc") ? { spc: Number(runProperties.getAttribute("spc")) } : {}),
        ...(runProperties.hasAttribute("baseline") ? { baseline: Number(runProperties.getAttribute("baseline")) } : {}),
        ...(runProperties.hasAttribute("kern") ? { kern: Number(runProperties.getAttribute("kern")) } : {}),
      }));
      if (values.length) result[shapeName] = values;
    }
  }
  return result;
}

export async function inspectPptxParagraphDirections(pptxPath) {
  const archive = unzipSync(new Uint8Array(await fs.readFile(pptxPath)));
  const result = {};
  for (const name of Object.keys(archive)) {
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue;
    const document = new DOMParser().parseFromString(new TextDecoder().decode(archive[name]), "application/xml");
    for (const cNvPr of elementsByTag(document, P_NS, "cNvPr")) {
      const shapeName = cNvPr.getAttribute("name");
      let shape = cNvPr.parentNode;
      while (shape && shape.localName !== "sp") shape = shape.parentNode;
      if (!shape) continue;
      const directions = elementsByTag(shape, A_NS, "p").map((paragraph) => {
        const properties = Array.from(paragraph.childNodes).find((node) => node.nodeType === 1 && node.localName === "pPr");
        return properties?.getAttribute("rtl") === "1" ? "rtl" : "ltr";
      });
      if (directions.length) result[shapeName] = directions;
    }
  }
  return result;
}

export async function inspectPptxAlphas(pptxPath) {
  const archive = unzipSync(new Uint8Array(await fs.readFile(pptxPath)));
  const result = {};
  for (const name of Object.keys(archive)) {
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue;
    const document = new DOMParser().parseFromString(new TextDecoder().decode(archive[name]), "application/xml");
    for (const cNvPr of elementsByTag(document, P_NS, "cNvPr")) {
      const shapeName = cNvPr.getAttribute("name");
      let owner = cNvPr.parentNode;
      while (owner && !["sp", "pic"].includes(owner.localName)) owner = owner.parentNode;
      if (!owner) continue;
      if (owner.localName === "pic") {
        const alpha = elementsByTag(owner, A_NS, "alphaModFix")[0];
        result[shapeName] = { image: alpha ? Number(alpha.getAttribute("amt")) : 100000 };
      } else {
        const shapeProperties = Array.from(owner.childNodes).find((node) => node.nodeType === 1 && node.localName === "spPr");
        const shapeFill = shapeProperties ? Array.from(shapeProperties.childNodes).find((node) => node.nodeType === 1 && node.localName === "solidFill") : undefined;
        const shapeAlpha = shapeFill ? elementsByTag(shapeFill, A_NS, "alpha")[0] : undefined;
        const line = shapeProperties ? Array.from(shapeProperties.childNodes).find((node) => node.nodeType === 1 && node.localName === "ln") : undefined;
        const lineAlpha = line ? elementsByTag(line, A_NS, "alpha")[0] : undefined;
        const runs = elementsByTag(owner, A_NS, "rPr").map((runProperties) => {
          const alpha = elementsByTag(runProperties, A_NS, "alpha")[0];
          return alpha ? Number(alpha.getAttribute("val")) : 100000;
        });
        if (runs.length || shapeFill || line) result[shapeName] = {
          ...(runs.length ? { runs } : {}),
          ...(shapeFill ? { shapeFill: shapeAlpha ? Number(shapeAlpha.getAttribute("val")) : 100000 } : {}),
          ...(line ? { line: lineAlpha ? Number(lineAlpha.getAttribute("val")) : 100000 } : {}),
        };
      }
    }
  }
  return result;
}
