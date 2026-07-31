import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileBlob, Presentation, PresentationFile } from "./artifact-tool-loader.mjs";
import { sha256BytesDigest } from "@image-to-ppt/core/canonical";
import { patchPptxTextMetrics } from "./patch-pptx-text-metrics.mjs";
import { indexedTextSegment, sliceIndexedText } from "@image-to-ppt/core/text-index";

const PT_TO_PX = 96 / 72;

function toPx(value) {
  if (!value || typeof value.value !== "number") throw new Error("无效的长度值");
  if (value.unit === "px") return value.value;
  if (value.unit === "pt") return value.value * PT_TO_PX;
  throw new Error(`不支持的长度单位 ${value.unit}`);
}

function toPosition(box) {
  return {
    left: toPx({ value: box.x, unit: box.unit }),
    top: toPx({ value: box.y, unit: box.unit }),
    width: toPx({ value: box.width, unit: box.unit }),
    height: toPx({ value: box.height, unit: box.unit }),
  };
}

function toRgb(color) {
  if (!color || color.space !== "srgb" || !Array.isArray(color.components)) return "#000000";
  const channel = (value) => Math.max(0, Math.min(255, Math.round(value * 255)));
  return `#${channel(color.components[0]).toString(16).padStart(2, "0")}${channel(color.components[1]).toString(16).padStart(2, "0")}${channel(color.components[2]).toString(16).padStart(2, "0")}`.toUpperCase();
}

function toColorConfig(color, opacity = 1) {
  if (!color) return "#000000";
  const effectiveOpacity = (typeof color.alpha === "number" ? color.alpha : 1) * opacity;
  return {
    type: "rgb",
    value: toRgb(color),
    ...(effectiveOpacity < 1 ? { transform: { opacity: effectiveOpacity } } : {}),
  };
}

function toFill(style) {
  if (!style || style.fill?.kind === "none") return { type: "none" };
  if (style.fill.kind === "solid") return { type: "solid", color: toColorConfig(style.fill.color, style.opacity ?? 1) };
  return {
    type: "gradient",
    gradientKind: style.fill.gradientType === "radial" ? "path" : "linear",
    ...(style.fill.gradientType === "linear" ? { angleDeg: style.fill.angleDeg } : {}),
    stops: style.fill.stops.map((stop) => ({
      offset: Math.round(stop.offset * 100000),
      color: toColorConfig(stop.color, style.opacity ?? 1),
    })),
  };
}

function toLine(style) {
  const border = style?.borders?.top;
  if (!border || border.style === "none" || toPx(border.width) === 0) {
    return { style: "solid", fill: "none", width: 0 };
  }
  return { style: border.style, fill: toColorConfig(border.color, style.opacity ?? 1), width: toPx(border.width) };
}

function maxRadius(style) {
  return Math.max(...Object.values(style?.cornerRadii ?? {}).map(toPx), 0);
}

function sameColor(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertRepresentableShapeStyle(style, primitiveId, { geometryResolved = false } = {}) {
  const borders = Object.values(style?.borders ?? {});
  const visibleBorders = borders.filter((border) => border.style !== "none" && toPx(border.width) > 0 && border.color.alpha > 0);
  if (visibleBorders.length) {
    const first = borders[0];
    const same = borders.every((border) => border.style === first.style
      && toPx(border.width) === toPx(first.width)
      && border.alignment === first.alignment
      && sameColor(border.color, first.color));
    if (!same) throw new Error(`primitive ${primitiveId} 的四边边框不一致，必须编译为独立边线 primitive`);
    if (first.style !== "none" && first.alignment !== "center") {
      throw new Error(`primitive ${primitiveId} 的 ${first.alignment} 边框不能用 PowerPoint 居中描边近似`);
    }
  }
  if (!geometryResolved) {
    const radii = Object.values(style?.cornerRadii ?? {}).map(toPx);
    if (radii.length && !radii.every((radius) => radius === radii[0])) {
      throw new Error(`primitive ${primitiveId} 的非对称圆角必须编译为 custom path`);
    }
  }
}

function toInsets(style) {
  return Object.fromEntries(Object.entries(style?.padding ?? {}).map(([side, value]) => [side, toPx(value)]));
}

function runTextStyle(run) {
  return {
    ...(run.font?.size ? { fontSize: `${toPx(run.font.size)}px` } : {}),
    ...(run.font?.families?.[0] ? { typeface: run.font.families[0] } : {}),
    ...(run.font?.weight >= 600 ? { bold: true } : {}),
    ...(run.font?.style === "italic" ? { italic: true } : {}),
    // artifact-tool 的富文本 run 在导出时要求使用 RGB 字符串，避免被解析成主题色而丢失局部颜色。
    ...(run.color ? { color: toRgb(run.color) } : {}),
  };
}

function splitRun(model, start, end) {
  const chunks = [];
  for (const run of model.runs) {
    const from = Math.max(start, run.start);
    const to = Math.min(end, run.end);
    if (to <= from) continue;
    chunks.push({ run: sliceIndexedText(model, from, to), textStyle: runTextStyle(run) });
  }
  return chunks;
}

function paragraphInput(model, paragraph) {
  const hardBreaks = new Set((model.hardBreakRanges ?? []).filter((range) => range.end === range.start + 1).map((range) => range.start));
  const result = [];
  let cursor = paragraph.start;
  for (let index = paragraph.start; index < paragraph.end; index += 1) {
    if (indexedTextSegment(model, index) === "\n" || hardBreaks.has(index)) {
      if (index > cursor) result.push(...splitRun(model, cursor, index));
      result.push("\n");
      cursor = index + 1;
    }
  }
  if (cursor < paragraph.end) result.push(...splitRun(model, cursor, paragraph.end));
  return {
    runs: result.length ? result : [""],
    ...(paragraph.list ? {
      bulletCharacter: paragraph.list.kind === "bullet" ? paragraph.list.marker : undefined,
      marginLeft: toPx(paragraph.indentLeft) + toPx(paragraph.list.markerGap),
      indent: -toPx(paragraph.list.markerGap),
    } : {}),
    paragraphStyle: { alignment: paragraph.alignment },
    spaceBefore: toPx(paragraph.spaceBefore),
    spaceAfter: toPx(paragraph.spaceAfter),
  };
}

function toTextValue(model) {
  return model.paragraphs.map((paragraph) => paragraphInput(model, paragraph));
}

function metricIssues(text, options = {}) {
  const issues = [];
  if (options.applyOoxmlTextMetrics !== true && text.runs.some((run) => run.letterSpacing?.value !== 0)) issues.push("letter-spacing");
  if (text.runs.some((run) => run.glyphAdvances?.length)) issues.push("glyph-advances");
  if (options.applyOoxmlTextMetrics !== true && text.runs.some((run) => run.baselineShift?.value !== 0)) issues.push("baseline-shift");
  if (options.applyOoxmlTextMetrics !== true && text.runs.some((run) => run.kerning !== undefined)) issues.push("kerning");
  return issues;
}

function renderText(slide, primitive, options) {
  assertRepresentableShapeStyle(primitive.style, primitive.primitiveId);
  const shape = slide.shapes.add({
    geometry: "textbox",
    name: primitive.primitiveId,
    position: toPosition(primitive.box),
    fill: toFill(primitive.style),
    line: toLine(primitive.style),
    ...(maxRadius(primitive.style) > 0 ? { borderRadius: maxRadius(primitive.style) } : {}),
  });
  const text = primitive.text;
  const unsupportedMetrics = metricIssues(text, options);
  if (unsupportedMetrics.length && options.requireNativeTextMetrics) {
    throw new Error(`artifact-tool 无法原生表达文字度量: ${unsupportedMetrics.join(", ")}`);
  }
  shape.text.set(toTextValue(text));
  const firstRun = text.runs[0];
  const firstParagraph = text.paragraphs[0];
  const lineHeight = text.visualLines[0]?.lineHeight ? toPx(text.visualLines[0].lineHeight) : undefined;
  const fontSize = firstRun?.font?.size ? toPx(firstRun.font.size) : 18;
  shape.text.style = {
    fontSize,
    ...(lineHeight ? { lineSpacing: lineHeight / fontSize } : {}),
    alignment: firstParagraph?.alignment ?? "left",
    verticalAlignment: "top",
    wrap: text.wrapMode === "none" ? "none" : "square",
    autoFit: text.overflow === "shrink-to-fit" ? "shrinkText" : "none",
    insets: toInsets(primitive.style),
  };
  return { shape, primitiveId: primitive.primitiveId, kind: primitive.kind, sourceNodeRefs: primitive.sourceNodeRefs };
}

function toCustomPath(path, allowCurvePlaceholder = false) {
  const commands = path.commands.map((command) => {
    if (command.kind === "moveTo") return { moveTo: { x: toPx({ value: command.point.x, unit: path.unit }), y: toPx({ value: command.point.y, unit: path.unit }) } };
    if (command.kind === "lineTo") return { lineTo: { x: toPx({ value: command.point.x, unit: path.unit }), y: toPx({ value: command.point.y, unit: path.unit }) } };
    if (command.kind === "close") return { close: {} };
    if (allowCurvePlaceholder && ["cubicTo", "arcTo"].includes(command.kind)) {
      return { lineTo: { x: toPx({ value: command.point.x, unit: path.unit }), y: toPx({ value: command.point.y, unit: path.unit }) } };
    }
    throw new Error(`artifact-tool 当前不能原生表达 ${command.kind} path 命令`);
  });
  return {
    width: toPx({ value: path.viewBox.width, unit: path.unit }),
    height: toPx({ value: path.viewBox.height, unit: path.unit }),
    commands,
  };
}

function isNativeRoundedRectPath(primitive) {
  if (primitive.kind !== "path" || maxRadius(primitive.style) <= 0) return false;
  const commands = primitive.path?.commands ?? [];
  const arcs = commands.filter((command) => command.kind === "arcTo");
  return arcs.length === 4
    && commands[0]?.kind === "moveTo"
    && commands.at(-1)?.kind === "close"
    && commands.every((command) => ["moveTo", "lineTo", "arcTo", "close"].includes(command.kind));
}

function renderPath(slide, primitive, options) {
  assertRepresentableShapeStyle(primitive.style, primitive.primitiveId, { geometryResolved: true });
  if (isNativeRoundedRectPath(primitive)) {
    const shape = slide.shapes.add({
      geometry: "roundRect",
      name: primitive.primitiveId,
      position: toPosition(primitive.box),
      fill: toFill(primitive.style),
      line: toLine(primitive.style),
      borderRadius: maxRadius(primitive.style),
    });
    return { shape, primitiveId: primitive.primitiveId, kind: primitive.kind, sourceNodeRefs: primitive.sourceNodeRefs };
  }
  const shape = slide.shapes.add({
    geometry: "custom",
    name: primitive.primitiveId,
    position: toPosition(primitive.box),
    fill: toFill(primitive.style),
    line: toLine(primitive.style),
    customPaths: [toCustomPath(primitive.path, options.applyOoxmlPathGeometry === true)],
  });
  return { shape, primitiveId: primitive.primitiveId, kind: primitive.kind, sourceNodeRefs: primitive.sourceNodeRefs };
}

function renderConnector(slide, primitive, options) {
  const connector = primitive.connector;
  if (connector.startArrow.kind !== "none" || connector.endArrow.kind !== "none") {
    throw new Error("连接线箭头尺寸尚未实现精确 OOXML 映射，禁止使用近似枚举");
  }
  const points = connector.path.commands.filter((command) => command.point).map((command) => command.point);
  if (connector.routing === "straight" && (points.length !== 2 || connector.path.commands.some((command) => !["moveTo", "lineTo"].includes(command.kind)))) {
    throw new Error("straight connector 必须包含且仅包含 moveTo/lineTo 两个端点");
  }
  const shape = slide.shapes.add({
    geometry: "custom",
    name: primitive.primitiveId,
    position: toPosition(primitive.box),
    fill: { type: "none" },
    line: toLine(primitive.style),
    customPaths: [toCustomPath(connector.path, options.applyOoxmlPathGeometry === true)],
  });
  return { shape, primitiveId: primitive.primitiveId, kind: primitive.kind, sourceNodeRefs: primitive.sourceNodeRefs };
}

function renderImage(slide, primitive, blobs, imageSizes) {
  assertRepresentableShapeStyle(primitive.style, primitive.primitiveId);
  const visibleBorder = Object.values(primitive.style?.borders ?? {}).some((border) => border.style !== "none" && toPx(border.width) > 0);
  if (visibleBorder) throw new Error(`primitive ${primitive.primitiveId} 的图片边框必须编译为独立 path，不能由图片对象静默丢弃`);
  const entry = blobs?.get?.(primitive.blobDigest) ?? blobs?.[primitive.blobDigest];
  if (!entry) throw new Error(`缺少图片 Blob ${primitive.blobDigest}`);
  const bytes = entry.bytes ?? entry.data ?? entry;
  const contentType = entry.contentType ?? "image/png";
  const imageSize = imageSizes?.get?.(primitive.blobDigest) ?? imageSizes?.[primitive.blobDigest];
  const crop = primitive.crop;
  let normalizedCrop;
  if (crop && Object.values(crop).some((value) => toPx(value) > 0)) {
    if (!imageSize?.width || !imageSize?.height) throw new Error(`缺少图片 ${primitive.blobDigest} 的源尺寸，无法安全还原裁切`);
    normalizedCrop = {
      left: toPx(crop.left) / imageSize.width,
      top: toPx(crop.top) / imageSize.height,
      right: toPx(crop.right) / imageSize.width,
      bottom: toPx(crop.bottom) / imageSize.height,
    };
  }
  const image = slide.images.add({
    blob: bytes,
    contentType,
    alt: primitive.sourceNodeRefs.join(","),
    fit: normalizedCrop ? "cover" : "contain",
    position: toPosition(primitive.box),
    ...(normalizedCrop ? { crop: normalizedCrop } : {}),
    ...(maxRadius(primitive.style) > 0 ? { geometry: "roundRect", borderRadius: maxRadius(primitive.style) } : {}),
  });
  image.name = primitive.primitiveId;
  return { shape: image, primitiveId: primitive.primitiveId, kind: primitive.kind, sourceNodeRefs: primitive.sourceNodeRefs, normalizedCrop };
}

export async function renderPptxFromRenderPlane(renderPlaneBody, options = {}) {
  if (!Array.isArray(renderPlaneBody.slides) || renderPlaneBody.slides.length === 0) throw new Error("Render Plane 必须包含至少一个 slide");
  const rootBox = renderPlaneBody.slides[0].renderRoot.box;
  const slideWidth = options.slideWidth ?? toPx({ value: rootBox.width, unit: rootBox.unit });
  const slideHeight = options.slideHeight ?? toPx({ value: rootBox.height, unit: rootBox.unit });
  const presentation = Presentation.create({ slideSize: { width: slideWidth, height: slideHeight } });
  const manifest = [];

  function visit(slide, slideBody, primitive) {
    let materialized = null;
    if (primitive.kind === "text") materialized = renderText(slide, primitive, options);
    else if (primitive.kind === "path") materialized = renderPath(slide, primitive, options);
    else if (primitive.kind === "image") materialized = renderImage(slide, primitive, options.blobs, options.imageSizes);
    else if (primitive.kind === "connector") materialized = renderConnector(slide, primitive, options);
    manifest.push({
      primitiveId: primitive.primitiveId,
      slideId: slideBody.slideId,
      kind: primitive.kind,
      editable: primitive.editable,
      sourceNodeRefs: primitive.sourceNodeRefs,
      bbox: toPosition(primitive.box),
      nativeObject: materialized ? { name: materialized.shape.name, id: materialized.shape.id ?? null } : null,
      virtual: primitive.kind === "group",
      ...(primitive.kind === "text" ? { unsupportedNativeMetrics: metricIssues(primitive.text, options) } : {}),
      ...(materialized?.normalizedCrop ? { normalizedCrop: materialized.normalizedCrop } : {}),
    });
    for (const child of primitive.children ?? []) visit(slide, slideBody, child);
  }

  for (const slideBody of renderPlaneBody.slides) {
    const slide = presentation.slides.add();
    if (options.background) slide.background.fill = options.background;
    const slideBox = slideBody.renderRoot.box;
    const width = toPx({ value: slideBox.width, unit: slideBox.unit });
    const height = toPx({ value: slideBox.height, unit: slideBox.unit });
    if (Math.abs(width - slideWidth) > 0.01 || Math.abs(height - slideHeight) > 0.01) throw new Error(`slide ${slideBody.slideId} 尺寸与演示文稿不一致`);
    visit(slide, slideBody, slideBody.renderRoot);
  }
  return { presentation, manifest };
}

export async function renderPptxFromBundle(bundle, outputPath, options = {}) {
  const renderPlane = bundle.artifacts.find((artifact) => artifact.artifactType === "render-plane");
  if (!renderPlane) throw new Error("任务束缺少 render-plane Artifact");
  const capability = bundle.artifacts.find((artifact) => artifact.artifactType === "capability-manifest");
  const declaredTextMetrics = Object.values(capability?.body.textMetricCapabilities ?? {});
  const declaredGeometry = capability?.body.geometryCapabilities ?? {};
  const effectiveOptions = {
    ...options,
    applyOoxmlTextMetrics: options.applyOoxmlTextMetrics ?? declaredTextMetrics.includes("ooxml-postprocess"),
    applyOoxmlPathGeometry: options.applyOoxmlPathGeometry ?? ["path-cubic", "path-axis-aligned-arc", "path-rotated-arc"].some((name) => declaredGeometry[name] === "ooxml-postprocess"),
  };
  const result = await renderPptxFromRenderPlane(renderPlane.body, effectiveOptions);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const pptx = await PresentationFile.exportPptx(result.presentation);
  await pptx.save(outputPath);
  let exportedPresentation = result.presentation;
  const textByShapeName = new Map();
  const textOpacityByShapeName = new Map();
  const imageCropsByShapeName = new Map();
  const imageOpacityByShapeName = new Map();
  const pathsByShapeName = new Map();
  function collectPostprocessInputs(primitive) {
    if (effectiveOptions.applyOoxmlTextMetrics === true && primitive.kind === "text") {
      textByShapeName.set(primitive.primitiveId, primitive.text);
      textOpacityByShapeName.set(primitive.primitiveId, primitive.style.opacity ?? 1);
    }
    if (primitive.kind === "image") {
      const manifestItem = result.manifest.find((item) => item.primitiveId === primitive.primitiveId);
      if (manifestItem?.normalizedCrop) imageCropsByShapeName.set(primitive.primitiveId, manifestItem.normalizedCrop);
      imageOpacityByShapeName.set(primitive.primitiveId, primitive.style.opacity ?? 1);
    }
    if (primitive.kind === "path" && !isNativeRoundedRectPath(primitive)) pathsByShapeName.set(primitive.primitiveId, primitive.path);
    if (primitive.kind === "connector") pathsByShapeName.set(primitive.primitiveId, primitive.connector.path);
    for (const child of primitive.children ?? []) collectPostprocessInputs(child);
  }
  for (const slide of renderPlane.body.slides) collectPostprocessInputs(slide.renderRoot);
  if (textByShapeName.size || imageCropsByShapeName.size || pathsByShapeName.size || textOpacityByShapeName.size || imageOpacityByShapeName.size) {
    const patchResult = await patchPptxTextMetrics(outputPath, outputPath, textByShapeName, imageCropsByShapeName, pathsByShapeName, textOpacityByShapeName, imageOpacityByShapeName);
    if (patchResult.patchedPaths !== pathsByShapeName.size) throw new Error(`OOXML path 后处理不完整: ${patchResult.patchedPaths}/${pathsByShapeName.size}`);
    exportedPresentation = await PresentationFile.importPptx(await FileBlob.load(outputPath));
  }
  const pptxBytes = await fs.readFile(outputPath);
  const outputPptxBlobDigest = sha256BytesDigest(pptxBytes);
  if (effectiveOptions.manifestPath) await fs.writeFile(effectiveOptions.manifestPath, `${JSON.stringify(result.manifest, null, 2)}\n`);
  if (effectiveOptions.layoutPath) await fs.writeFile(effectiveOptions.layoutPath, await (await exportedPresentation.slides.items[0].export({ format: "layout" })).text());
  if (effectiveOptions.previewPath) {
    const preview = await exportedPresentation.export({ slide: exportedPresentation.slides.items[0], format: "png", scale: 1 });
    await fs.writeFile(effectiveOptions.previewPath, new Uint8Array(await preview.arrayBuffer()));
  }
  return { ...result, presentation: exportedPresentation, outputPath, outputPptxBlobDigest, outputPptxByteLength: pptxBytes.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.error("请通过 renderPptxFromBundle/renderPptxFromRenderPlane 调用 PPTX 后端");
  process.exitCode = 1;
}
