import fs from "node:fs/promises";
import path from "node:path";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { unzipSync, zipSync } from "fflate";
import { sha256BytesDigest, sha256Digest } from "@image-to-ppt/core/canonical";
import { validateV2Contracts } from "@image-to-ppt/core";
import { FileBlob, Presentation, PresentationFile } from "./artifact-tool-loader.mjs";
import { assertBackendPlanExecutable } from "./backend-planner.mjs";

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const EMU_PER_PX = 9525;
const PT_TO_PX = 96 / 72;

function toPx(length) {
  if (!length || typeof length.value !== "number") throw new TypeError("Backend Plan 包含无效长度");
  if (length.unit === "px") return length.value;
  if (length.unit === "pt") return length.value * PT_TO_PX;
  throw new Error(`Renderer 不支持绝对长度单位 ${length.unit}`);
}

function boxToPosition(box) {
  const unit = box.unit ?? "px";
  const factor = unit === "px" ? 1 : unit === "pt" ? PT_TO_PX : null;
  if (factor === null) throw new Error(`Renderer 不支持对象边界单位 ${unit}`);
  return {
    left: box.x * factor,
    top: box.y * factor,
    width: box.width * factor,
    height: box.height * factor,
  };
}

function rgb(color) {
  if (!color || color.space !== "srgb" || color.components?.length !== 3) throw new Error("Renderer 仅执行已规划的 sRGB 颜色");
  const channel = (value) => Math.max(0, Math.min(255, Math.round(value * 255))).toString(16).padStart(2, "0");
  return `#${color.components.map(channel).join("")}`.toUpperCase();
}

function colorConfig(color, inheritedOpacity = 1) {
  const opacity = (color.alpha ?? 1) * inheritedOpacity;
  return {
    type: "rgb",
    value: rgb(color),
    ...(opacity < 1 ? { transform: { opacity } } : {}),
  };
}

function fillConfig(appearance, operationId) {
  if (!appearance.fills.length) return { type: "none" };
  if (appearance.fills.length > 1) throw new Error(`操作 ${operationId} 的多层填充未被 Backend Plan lower`);
  const fill = appearance.fills[0];
  if (fill.kind === "solid") return { type: "solid", color: colorConfig(fill.color, appearance.opacity) };
  if (fill.kind === "gradient") {
    if (!['linear', 'radial'].includes(fill.gradient.type)) throw new Error(`操作 ${operationId} 的 ${fill.gradient.type} 渐变不可执行`);
    return {
      type: "gradient",
      gradientKind: fill.gradient.type === "radial" ? "path" : "linear",
      ...(fill.gradient.type === "linear" ? { angleDeg: fill.gradient.angleDeg } : {}),
      stops: fill.gradient.stops.map((stop) => ({
        offset: Math.round(stop.offset * 100000),
        color: colorConfig(stop.color, appearance.opacity),
      })),
    };
  }
  throw new Error(`操作 ${operationId} 的图片图案填充未被 Backend Plan lower`);
}

function strokeConfig(appearance, operationId, { primary = true } = {}) {
  const strokes = appearance.strokes.filter((stroke) => !primary || stroke.side === "all");
  if (!strokes.length) return { style: "solid", fill: "none", width: 0 };
  if (strokes.length > 1) throw new Error(`操作 ${operationId} 的多重描边未被 Backend Plan lower`);
  const stroke = strokes[0];
  if (stroke.paint.kind !== "solid") throw new Error(`操作 ${operationId} 的渐变描边未被 Backend Plan lower`);
  const pattern = stroke.dash.pattern;
  return {
    style: pattern.length ? "dashed" : "solid",
    fill: colorConfig(stroke.paint.color, appearance.opacity),
    width: toPx(stroke.width),
  };
}

function shadowConfig(appearance, operationId) {
  if (!appearance.effects.length) return undefined;
  if (appearance.effects.length > 1 || appearance.effects[0].kind !== "outer-shadow") {
    throw new Error(`操作 ${operationId} 的效果栈没有完整的 Renderer 执行器`);
  }
  const effect = appearance.effects[0];
  const offsetX = toPx(effect.offsetX);
  const offsetY = toPx(effect.offsetY);
  return {
    type: "outer",
    color: rgb(effect.color),
    opacity: effect.color.alpha ?? 1,
    blur: toPx(effect.blurRadius),
    distance: Math.hypot(offsetX, offsetY),
    angle: Math.atan2(offsetY, offsetX) * 180 / Math.PI,
  };
}

function geometryName(content) {
  const names = {
    rectangle: "rect",
    "rounded-rectangle": "roundRect",
    ellipse: "ellipse",
    line: "line",
    star: "star5",
    callout: "wedgeRectCallout",
  };
  const geometry = names[content.shapeKind];
  if (!geometry) throw new Error(`Backend Plan 未将 ${content.shapeKind} shape lower 为可执行路径`);
  return geometry;
}

function cornerRadius(content) {
  if (!content.cornerRadii) return undefined;
  const values = Object.values(content.cornerRadii).map(toPx);
  if (!values.every((value) => Math.abs(value - values[0]) < 1e-8)) throw new Error("非对称圆角必须在 Backend Plan 中 lower 为 path");
  return values[0];
}

function textSlice(content, range) {
  const boundaries = content.indexing.utf16Boundaries;
  return content.text.slice(boundaries[range.start], boundaries[range.end]);
}

function runStyle(run) {
  const style = run.style;
  return {
    fontSize: `${toPx(style.fontSize)}px`,
    typeface: style.fontFamilies[0],
    bold: style.fontWeight >= 600,
    italic: style.fontStyle === "italic",
    color: rgb(style.color),
  };
}

function textValue(content) {
  return content.paragraphs.map((paragraph) => ({
    runs: content.runs
      .filter((run) => run.range.end > paragraph.range.start && run.range.start < paragraph.range.end)
      .map((run) => {
        const range = {
          start: Math.max(run.range.start, paragraph.range.start),
          end: Math.min(run.range.end, paragraph.range.end),
        };
        return { run: textSlice(content, range), textStyle: runStyle(run) };
      }),
    paragraphStyle: { alignment: paragraph.alignment },
    spaceBefore: toPx(paragraph.spacingBefore),
    spaceAfter: toPx(paragraph.spacingAfter),
  }));
}

function applyTextStyle(shape, content) {
  const firstRun = content.runs[0];
  const firstParagraph = content.paragraphs[0];
  const lineSpacing = firstParagraph.lineSpacing.mode === "exact"
    ? firstParagraph.lineSpacing.value / toPx(firstRun.style.fontSize)
    : firstParagraph.lineSpacing.value;
  shape.text.style = {
    fontSize: toPx(firstRun.style.fontSize),
    typeface: firstRun.style.fontFamilies[0],
    alignment: firstParagraph.alignment,
    verticalAlignment: { top: "top", middle: "middle", bottom: "bottom" }[content.layout.verticalAlign],
    wrap: content.layout.wrapMode === "none" ? "none" : "square",
    autoFit: content.layout.overflow === "shrink-to-fit" ? "shrinkText" : "none",
    lineSpacing,
    insets: Object.fromEntries(["top", "right", "bottom", "left"].map((side) => [side, content.layout.padding.unit === "px"
      ? content.layout.padding[side]
      : toPx({ value: content.layout.padding[side], unit: content.layout.padding.unit })])),
  };
}

function pointToLocal(point, frame) {
  if (point.unit !== frame.unit) throw new Error("path point 与 local frame 单位不一致");
  if (["local", "parent"].includes(point.coordinateSpace)) return { x: point.x, y: point.y };
  return { x: point.x - frame.x, y: point.y - frame.y };
}

function pathCommands(content, frame) {
  return content.commands.map((command) => {
    if (command.command === "move-to") return { moveTo: pointToLocal(command.to, frame) };
    if (command.command === "line-to") return { lineTo: pointToLocal(command.to, frame) };
    if (command.command === "cubic-to") return {
      cubicBezierTo: {
        control1: pointToLocal(command.control1, frame),
        control2: pointToLocal(command.control2, frame),
        end: pointToLocal(command.to, frame),
      },
    };
    if (command.command === "close") return { close: {} };
    throw new Error(`path 命令 ${command.command} 尚未由 Backend Plan lower`);
  });
}

function resourceEntry(resources, digest) {
  const entry = resources?.get?.(digest) ?? resources?.[digest];
  if (!entry) throw new Error(`缺少 Backend Plan 声明的资源 Blob ${digest}`);
  const bytes = entry.bytes ?? entry.data ?? entry;
  const actualDigest = sha256BytesDigest(bytes);
  if (actualDigest !== digest) throw new Error(`资源 Blob 摘要不匹配: 期望 ${digest}，实际 ${actualDigest}`);
  return { bytes, contentType: entry.contentType ?? entry.mediaType };
}

function primaryObject(operation) {
  return operation.expectedObjects.find((object) => object.role === "primary");
}

function anchorPoint(box, anchor) {
  const position = boxToPosition(box);
  const points = {
    top: [position.left + position.width / 2, position.top],
    right: [position.left + position.width, position.top + position.height / 2],
    bottom: [position.left + position.width / 2, position.top + position.height],
    left: [position.left, position.top + position.height / 2],
    center: [position.left + position.width / 2, position.top + position.height / 2],
  };
  return points[anchor] ?? points.center;
}

function connectorPoints(operation, operationBySceneNode) {
  const content = operation.parameters.content;
  const resolve = (endpoint) => {
    if (endpoint.kind === "point") return [endpoint.point.x, endpoint.point.y];
    const target = operationBySceneNode.get(endpoint.nodeRef);
    if (!target) throw new Error(`连接线 ${operation.operationId} 引用未知计划节点 ${endpoint.nodeRef}`);
    if (endpoint.anchor === "custom") return [endpoint.anchorPoint.x, endpoint.anchorPoint.y];
    return anchorPoint(primaryObject(target).bbox, endpoint.anchor);
  };
  return [resolve(content.start), ...content.waypoints.map((point) => [point.x, point.y]), resolve(content.end)];
}

function renderOperation(slide, operation, resources, operationBySceneNode) {
  const expected = primaryObject(operation);
  if (!expected || expected.virtual) return;
  const position = boxToPosition(expected.bbox);
  const appearance = operation.parameters.appearance;
  const content = operation.parameters.content;
  const common = {
    name: expected.objectRef,
    position,
    fill: fillConfig(appearance, operation.operationId),
    line: strokeConfig(appearance, operation.operationId),
    ...(shadowConfig(appearance, operation.operationId) ? { shadow: shadowConfig(appearance, operation.operationId) } : {}),
  };

  if (operation.parameters.nodeType === "shape" || operation.parameters.nodeType === "table-cell") {
    const shape = slide.shapes.add({
      ...common,
      geometry: operation.parameters.nodeType === "table-cell" ? "rect" : geometryName(content),
      ...(operation.parameters.nodeType === "shape" && cornerRadius(content) !== undefined ? { borderRadius: cornerRadius(content) } : {}),
    });
    shape.name = expected.objectRef;
  } else if (operation.parameters.nodeType === "text") {
    const shape = slide.shapes.add({ ...common, geometry: "textbox" });
    shape.name = expected.objectRef;
    shape.text.set(textValue(content));
    applyTextStyle(shape, content);
  } else if (["path", "icon"].includes(operation.parameters.nodeType)) {
    if (operation.parameters.nodeType === "icon") throw new Error(`操作 ${operation.operationId} 的 icon 未携带已 lower 的 path`);
    const frame = operation.parameters.localGeometry.frame;
    const shape = slide.shapes.add({
      ...common,
      geometry: "custom",
      customPaths: [{ width: frame.width, height: frame.height, commands: pathCommands(content, frame) }],
    });
    shape.name = expected.objectRef;
  } else if (operation.parameters.nodeType === "image") {
    const entry = resourceEntry(resources, content.resourceDigest);
    const crop = content.crop.unit === "ratio"
      ? { left: content.crop.left, top: content.crop.top, right: content.crop.right, bottom: content.crop.bottom }
      : undefined;
    if (!crop && Object.values(content.crop).some((value) => typeof value === "number" && value !== 0)) {
      throw new Error(`操作 ${operation.operationId} 的绝对图片裁切未由 Backend Plan 归一化`);
    }
    const image = slide.images.add({
      blob: entry.bytes,
      contentType: entry.contentType,
      alt: operation.sceneNodeRef,
      fit: content.fitMode === "fill" ? "cover" : "contain",
      position,
      ...(crop ? { crop } : {}),
    });
    image.name = expected.objectRef;
  } else if (operation.parameters.nodeType === "connector") {
    const points = connectorPoints(operation, operationBySceneNode);
    const commands = points.map(([x, y], index) => index === 0
      ? { moveTo: { x: x - position.left, y: y - position.top } }
      : { lineTo: { x: x - position.left, y: y - position.top } });
    const shape = slide.shapes.add({
      geometry: "custom",
      name: expected.objectRef,
      position,
      fill: { type: "none" },
      line: strokeConfig(appearance, operation.operationId),
      customPaths: [{ width: position.width, height: position.height, commands }],
    });
    shape.name = expected.objectRef;
  } else {
    throw new Error(`操作 ${operation.operationId} 的节点类型 ${operation.parameters.nodeType} 没有物化执行器`);
  }

  for (const border of operation.expectedObjects.filter((object) => object.role.startsWith("border-") && !object.virtual)) {
    const side = border.role.slice("border-".length);
    const stroke = appearance.strokes.find((item) => item.side === side);
    if (!stroke) throw new Error(`操作 ${operation.operationId} 缺少 ${side} 边框参数`);
    const borderPosition = boxToPosition(border.bbox);
    const endpoints = {
      top: [[0, 0], [borderPosition.width, 0]],
      right: [[borderPosition.width, 0], [borderPosition.width, borderPosition.height]],
      bottom: [[borderPosition.width, borderPosition.height], [0, borderPosition.height]],
      left: [[0, borderPosition.height], [0, 0]],
    }[side];
    const shape = slide.shapes.add({
      geometry: "custom",
      name: border.objectRef,
      position: borderPosition,
      fill: { type: "none" },
      line: strokeConfig({ ...appearance, strokes: [stroke] }, operation.operationId, { primary: false }),
      customPaths: [{
        width: borderPosition.width,
        height: borderPosition.height,
        commands: [{ moveTo: { x: endpoints[0][0], y: endpoints[0][1] } }, { lineTo: { x: endpoints[1][0], y: endpoints[1][1] } }],
      }],
    });
    shape.name = border.objectRef;
  }
}

function elementName(element) {
  return Array.from(element.getElementsByTagNameNS(P_NS, "cNvPr"))[0]?.getAttribute("name");
}

function elementId(element) {
  return Array.from(element.getElementsByTagNameNS(P_NS, "cNvPr"))[0]?.getAttribute("id");
}

function objectElements(document) {
  const tree = Array.from(document.getElementsByTagNameNS(P_NS, "spTree"))[0];
  if (!tree) return [];
  return Array.from(tree.childNodes).filter((node) => node.nodeType === 1 && ["sp", "pic", "cxnSp", "graphicFrame", "grpSp"].includes(node.localName));
}

function xfrmOf(element) {
  return Array.from(element.getElementsByTagNameNS(A_NS, "xfrm"))[0];
}

function patchPlannedOoxml(outputPath, plan) {
  return fs.readFile(outputPath).then((bytes) => {
    const archive = unzipSync(new Uint8Array(bytes));
    const byObjectRef = new Map(plan.operations.flatMap((operation) => operation.expectedObjects
      .filter((object) => !object.virtual)
      .map((object) => [object.objectRef, { operation, object }])));
    plan.pages.forEach((page, pageIndex) => {
      const entryName = `ppt/slides/slide${pageIndex + 1}.xml`;
      const entry = archive[entryName];
      if (!entry) throw new Error(`候选 PPTX 缺少 ${entryName}`);
      const document = new DOMParser().parseFromString(new TextDecoder().decode(entry), "application/xml");
      for (const element of objectElements(document)) {
        const planned = byObjectRef.get(elementName(element));
        if (!planned) continue;
        const transform = planned.object.transform;
        if (transform.kind === "affine-2d") {
          const [a, b, c, d] = transform.matrix;
          const xfrm = xfrmOf(element);
          if (!xfrm) throw new Error(`对象 ${planned.object.objectRef} 缺少 a:xfrm`);
          const angle = Math.atan2(b, a) * 180 / Math.PI;
          if (Math.abs(angle) > 1e-8) xfrm.setAttribute("rot", String(Math.round(angle * 60000)));
          if (a * d - b * c < 0) xfrm.setAttribute("flipV", "1");
        }
        if (planned.operation.parameters.nodeType === "text") {
          const runs = planned.operation.parameters.content.runs;
          const runProperties = Array.from(element.getElementsByTagNameNS(A_NS, "rPr"));
          runProperties.forEach((properties, index) => {
            const style = runs[Math.min(index, runs.length - 1)]?.style;
            if (!style) return;
            const trackingPx = toPx(style.tracking);
            if (trackingPx !== 0) properties.setAttribute("spc", String(Math.round(trackingPx * 750)));
            const baselinePx = toPx(style.baselineShift);
            const fontSizePx = toPx(style.fontSize);
            if (baselinePx !== 0) properties.setAttribute("baseline", String(Math.round(baselinePx / fontSizePx * 100000)));
          });
        }
      }
      archive[entryName] = new TextEncoder().encode(new XMLSerializer().serializeToString(document));
    });
    return fs.writeFile(outputPath, zipSync(archive, { level: 6 }));
  });
}

function nativeKind(element) {
  if (element.localName === "pic") return "image";
  if (element.localName === "grpSp") return "group";
  if (element.localName === "cxnSp") return "connector";
  if (element.localName === "graphicFrame") {
    if (element.getElementsByTagNameNS(A_NS, "tbl").length) return "table";
    return "chart";
  }
  if (element.getElementsByTagNameNS(P_NS, "txBody").length) return "text";
  if (element.getElementsByTagNameNS(A_NS, "custGeom").length) return "path";
  return "shape";
}

function actualFeatures(element) {
  const features = [];
  const kind = nativeKind(element);
  if (kind === "shape") features.push("native-shape");
  if (kind === "text") features.push("native-text");
  if (kind === "text" && element.getElementsByTagNameNS(A_NS, "r").length > 1) features.push("rich-text-runs");
  if (kind === "text" && Array.from(element.getElementsByTagNameNS(A_NS, "rPr")).some((node) => node.hasAttribute("spc") || node.hasAttribute("baseline"))) features.push("manual-text-metrics");
  if (element.getElementsByTagNameNS(A_NS, "custGeom").length) features.push("custom-geometry");
  if (element.getElementsByTagNameNS(A_NS, "srcRect").length) features.push("picture-crop");
  if (element.getElementsByTagNameNS(A_NS, "effectLst").length) features.push("effect-list");
  if (kind === "group") features.push("grouping");
  if (kind === "table") features.push("native-table");
  if (kind === "chart") features.push("native-chart");
  return [...new Set(features)].sort();
}

function actualBox(element) {
  const xfrm = xfrmOf(element);
  const off = xfrm && Array.from(xfrm.getElementsByTagNameNS(A_NS, "off"))[0];
  const ext = xfrm && Array.from(xfrm.getElementsByTagNameNS(A_NS, "ext"))[0];
  if (!off || !ext) return null;
  return {
    x: Number(off.getAttribute("x")) / EMU_PER_PX,
    y: Number(off.getAttribute("y")) / EMU_PER_PX,
    width: Number(ext.getAttribute("cx")) / EMU_PER_PX,
    height: Number(ext.getAttribute("cy")) / EMU_PER_PX,
    unit: "px",
    coordinateSpace: "page",
  };
}

function actualTransform(element) {
  const xfrm = xfrmOf(element);
  return {
    kind: "ooxml-2d",
    rotationDeg: Number(xfrm?.getAttribute("rot") || 0) / 60000,
    flipHorizontal: xfrm?.getAttribute("flipH") === "1",
    flipVertical: xfrm?.getAttribute("flipV") === "1",
  };
}

function relationshipIds(element) {
  const result = new Set();
  const visit = (node) => {
    if (node.nodeType === 1) {
      for (const attribute of Array.from(node.attributes ?? [])) {
        if (attribute.namespaceURI === R_NS) result.add(attribute.value);
      }
    }
    for (const child of Array.from(node.childNodes ?? [])) visit(child);
  };
  visit(element);
  return [...result].sort();
}

export async function inspectBackendPlanObjects(pptxPath, plan) {
  await PresentationFile.importPptx(await FileBlob.load(pptxPath));
  const archive = unzipSync(new Uint8Array(await fs.readFile(pptxPath)));
  const actualByName = new Map();
  plan.pages.forEach((page, pageIndex) => {
    const entryName = `ppt/slides/slide${pageIndex + 1}.xml`;
    const document = new DOMParser().parseFromString(new TextDecoder().decode(archive[entryName]), "application/xml");
    for (const element of objectElements(document)) {
      const name = elementName(element);
      if (name) actualByName.set(name, { pageId: page.pageId, element });
    }
  });

  const objects = [];
  const expectedNames = new Set();
  for (const operation of plan.operations) {
    for (const expected of operation.expectedObjects) {
      expectedNames.add(expected.objectRef);
      if (expected.virtual) {
        objects.push({
          objectRef: expected.objectRef,
          sceneNodeId: operation.sceneNodeRef,
          operationId: operation.operationId,
          slideId: operation.pageId,
          virtual: true,
          ooxmlObjectIds: [],
          nativeObjectKind: "virtual",
          bbox: structuredClone(expected.bbox),
          transform: null,
          contentDigest: null,
          editability: structuredClone(operation.editabilityContract),
          actualOoxmlFeatures: [],
          relationshipIds: [],
        });
        continue;
      }
      const actual = actualByName.get(expected.objectRef);
      if (!actual) throw new Error(`保存并重开候选后缺少计划对象 ${expected.objectRef}`);
      const xml = new XMLSerializer().serializeToString(actual.element);
      objects.push({
        objectRef: expected.objectRef,
        sceneNodeId: operation.sceneNodeRef,
        operationId: operation.operationId,
        slideId: actual.pageId,
        virtual: false,
        ooxmlObjectIds: [elementId(actual.element)].filter(Boolean),
        nativeObjectKind: nativeKind(actual.element),
        bbox: actualBox(actual.element),
        transform: actualTransform(actual.element),
        contentDigest: sha256Digest({ nativeKind: nativeKind(actual.element), xml }),
        editability: structuredClone(operation.editabilityContract),
        actualOoxmlFeatures: actualFeatures(actual.element),
        relationshipIds: relationshipIds(actual.element),
      });
    }
  }
  const undeclared = [...actualByName.keys()].filter((name) => name.startsWith("object-") && !expectedNames.has(name));
  if (undeclared.length) throw new Error(`候选 PPTX 包含未声明对象: ${undeclared.join(", ")}`);
  return objects;
}

function assertRendererInput(plan) {
  if (!plan || plan.contractKind !== "backend-plan" || plan.schemaVersion !== 2) throw new TypeError("V2 PPTX Renderer 只接受 Backend Plan");
  if (!Array.isArray(plan.pages) || !plan.pages.length) throw new Error("Backend Plan 缺少页面画布");
  if (!Array.isArray(plan.operations)) throw new Error("Backend Plan 缺少 operations");
  assertBackendPlanExecutable(plan);
  const first = plan.pages[0].canvas;
  for (const page of plan.pages.slice(1)) {
    if (page.canvas.unit !== first.unit || page.canvas.width !== first.width || page.canvas.height !== first.height) {
      throw new Error("单个 PPTX 不支持页面画布尺寸不一致，Planner 必须在渲染前拒绝该计划");
    }
  }
}

export async function renderPptxFromBackendPlan(plan, resources, outputPath, options = {}) {
  assertRendererInput(plan);
  const canvas = plan.pages[0].canvas;
  const presentation = Presentation.create({
    slideSize: {
      width: toPx({ value: canvas.width, unit: canvas.unit }),
      height: toPx({ value: canvas.height, unit: canvas.unit }),
    },
  });
  const operationBySceneNode = new Map(plan.operations.map((operation) => [operation.sceneNodeRef, operation]));
  for (const page of plan.pages) {
    const slide = presentation.slides.add();
    const operations = plan.operations
      .filter((operation) => operation.pageId === page.pageId)
      .sort((left, right) => left.parameters.drawOrder - right.parameters.drawOrder);
    for (const operation of operations) renderOperation(slide, operation, resources, operationBySceneNode);
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await (await PresentationFile.exportPptx(presentation)).save(outputPath);
  await patchPlannedOoxml(outputPath, plan);
  const objects = await inspectBackendPlanObjects(outputPath, plan);
  const outputBytes = await fs.readFile(outputPath);
  const outputPptxBlobDigest = sha256BytesDigest(outputBytes);
  const objectManifest = {
    schemaVersion: 2,
    contractKind: "object-manifest",
    manifestId: `object-manifest-${sha256Digest({ planId: plan.planId, outputPptxBlobDigest }).slice(7, 31)}`,
    planRef: plan.planId,
    outputPptx: {
      digest: outputPptxBlobDigest,
      byteLength: outputBytes.length,
      mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    },
    pages: plan.pages.map((page) => ({ pageId: page.pageId, objectRefs: objects.filter((object) => object.slideId === page.pageId).map((object) => object.objectRef) })),
    objects,
  };
  const manifestValidation = validateV2Contracts({ schemaVersion: 2, contracts: [plan, objectManifest] });
  if (!manifestValidation.ok) {
    const error = new Error(`Object Manifest 校验失败:\n${manifestValidation.errors.map((item) => `${item.code}: ${item.message}`).join("\n")}`);
    error.code = "V2_OBJECT_MANIFEST_INVALID";
    error.validationErrors = manifestValidation.errors;
    throw error;
  }
  if (options.manifestPath) {
    await fs.mkdir(path.dirname(options.manifestPath), { recursive: true });
    await fs.writeFile(options.manifestPath, `${JSON.stringify(objectManifest, null, 2)}\n`);
  }
  return { outputPath, outputPptxBlobDigest, outputPptxByteLength: outputBytes.length, objectManifest };
}
