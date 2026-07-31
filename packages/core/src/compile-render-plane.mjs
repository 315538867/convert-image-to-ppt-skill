import { sliceIndexedText, utf16OffsetAt } from "./text-index.mjs";

function scaleLength(value, scale) {
  if (value.unit === "px") return { value: value.value * scale, unit: "pt" };
  if (value.unit === "pt") return { ...value };
  if (value.unit === "emu") return { value: value.value / 12700, unit: "pt" };
  throw new Error(`无法把 ${value.unit} 长度编译为绝对幻灯片长度`);
}

function scaleEdges(edges, scale) {
  return Object.fromEntries(Object.entries(edges).map(([key, value]) => [key, scaleLength(value, scale)]));
}

function toSlideBox(sourceBox, transform) {
  const scaleX = transform.scaleX;
  const scaleY = transform.scaleY;
  if (sourceBox.coordinateSpace === "slide") return { ...sourceBox, unit: "pt" };
  if (sourceBox.coordinateSpace !== "source-canvas") {
    throw new Error(`无法编译坐标空间 ${sourceBox.coordinateSpace}`);
  }
  return {
    x: sourceBox.x * scaleX,
    y: sourceBox.y * scaleY,
    width: sourceBox.width * scaleX,
    height: sourceBox.height * scaleY,
    unit: "pt",
    coordinateSpace: "slide",
  };
}

function toSlideStyle(style, transform) {
  const scaleX = transform.scaleX;
  const scaleY = transform.scaleY;
  const scale = scaleX === scaleY ? scaleX : null;
  if (scale === null) throw new Error("非等比坐标变换不能直接编译统一边框和字距");
  return {
    ...style,
    padding: scaleEdges(style.padding, scale),
    margin: scaleEdges(style.margin, scale),
    borders: Object.fromEntries(Object.entries(style.borders).map(([key, border]) => [
      key,
      { ...border, width: scaleLength(border.width, scale) },
    ])),
    cornerRadii: Object.fromEntries(Object.entries(style.cornerRadii).map(([key, radius]) => [key, scaleLength(radius, scale)])),
  };
}

function toSlideText(model, transform) {
  const scale = transform.scaleX === transform.scaleY ? transform.scaleX : null;
  if (scale === null) throw new Error("非等比坐标变换不能直接编译文字度量");
  return {
    ...model,
    inkBox: toSlideBox(model.inkBox, transform),
    boundaryPolicy: {
      ...model.boundaryPolicy,
      minimumClearance: scaleEdges(model.boundaryPolicy.minimumClearance, scale),
    },
    runs: model.runs.map((run) => ({
      ...run,
      font: { ...run.font, size: scaleLength(run.font.size, scale) },
      letterSpacing: scaleLength(run.letterSpacing, scale),
      baselineShift: scaleLength(run.baselineShift, scale),
      glyphAdvances: run.glyphAdvances?.map((advance) => scaleLength(advance, scale)),
    })),
    paragraphs: model.paragraphs.map((paragraph) => ({
      ...paragraph,
      spaceBefore: scaleLength(paragraph.spaceBefore, scale),
      spaceAfter: scaleLength(paragraph.spaceAfter, scale),
      indentLeft: scaleLength(paragraph.indentLeft, scale),
      indentRight: scaleLength(paragraph.indentRight, scale),
      firstLineIndent: scaleLength(paragraph.firstLineIndent, scale),
      ...(paragraph.list ? { list: { ...paragraph.list, markerGap: scaleLength(paragraph.list.markerGap, scale) } } : {}),
    })),
    visualLines: model.visualLines.map((line) => ({
      ...line,
      box: toSlideBox(line.box, transform),
      baseline: scaleLength(line.baseline, scale),
      lineHeight: scaleLength(line.lineHeight, scale),
    })),
    positionedClusters: model.positionedClusters.map((cluster) => ({
      ...cluster,
      frame: toSlideBox(cluster.frame, transform),
      inkBox: toSlideBox(cluster.inkBox, transform),
      baseline: scaleLength(cluster.baseline, scale),
      advance: scaleLength(cluster.advance, scale),
    })),
  };
}

function scalePoint(point, scale) {
  return { x: point.x * scale, y: point.y * scale };
}

function toSlidePath(path, transform) {
  if (path.unit === "pt") return structuredClone(path);
  const scale = transform.scaleX === transform.scaleY ? transform.scaleX : null;
  if (scale === null) throw new Error("非等比坐标变换不能直接编译 path-local 几何");
  return {
    ...path,
    unit: "pt",
    viewBox: { width: path.viewBox.width * scale, height: path.viewBox.height * scale },
    commands: path.commands.map((command) => ({
      ...command,
      ...(command.point ? { point: scalePoint(command.point, scale) } : {}),
      ...(command.control1 ? { control1: scalePoint(command.control1, scale) } : {}),
      ...(command.control2 ? { control2: scalePoint(command.control2, scale) } : {}),
      ...(command.kind === "arcTo" ? { radiusX: command.radiusX * scale, radiusY: command.radiusY * scale } : {}),
    })),
  };
}

function toSlideConnector(connector, transform) {
  const scale = transform.scaleX === transform.scaleY ? transform.scaleX : null;
  if (scale === null) throw new Error("非等比坐标变换不能直接编译连接线几何");
  return {
    ...connector,
    path: toSlidePath(connector.path, transform),
    startArrow: {
      ...connector.startArrow,
      length: scaleLength(connector.startArrow.length, scale),
      width: scaleLength(connector.startArrow.width, scale),
      ...(connector.startArrow.canonicalPath ? { canonicalPath: toSlidePath(connector.startArrow.canonicalPath, transform) } : {}),
      ...(connector.startArrow.canonicalStyle ? { canonicalStyle: toSlideStyle(connector.startArrow.canonicalStyle, transform) } : {}),
    },
    endArrow: {
      ...connector.endArrow,
      length: scaleLength(connector.endArrow.length, scale),
      width: scaleLength(connector.endArrow.width, scale),
      ...(connector.endArrow.canonicalPath ? { canonicalPath: toSlidePath(connector.endArrow.canonicalPath, transform) } : {}),
      ...(connector.endArrow.canonicalStyle ? { canonicalStyle: toSlideStyle(connector.endArrow.canonicalStyle, transform) } : {}),
    },
  };
}

function roundedRectPath(box, style) {
  const width = box.width;
  const height = box.height;
  const radii = {
    topLeft: style.cornerRadii.topLeft.value,
    topRight: style.cornerRadii.topRight.value,
    bottomRight: style.cornerRadii.bottomRight.value,
    bottomLeft: style.cornerRadii.bottomLeft.value,
  };
  const factors = [
    width / Math.max(radii.topLeft + radii.topRight, width),
    width / Math.max(radii.bottomLeft + radii.bottomRight, width),
    height / Math.max(radii.topLeft + radii.bottomLeft, height),
    height / Math.max(radii.topRight + radii.bottomRight, height),
  ];
  const factor = Math.min(1, ...factors);
  for (const key of Object.keys(radii)) radii[key] *= factor;
  const { topLeft: tl, topRight: tr, bottomRight: br, bottomLeft: bl } = radii;
  const commands = [
    { kind: "moveTo", point: { x: tl, y: 0 } },
    { kind: "lineTo", point: { x: width - tr, y: 0 } },
  ];
  if (tr) commands.push({ kind: "arcTo", radiusX: tr, radiusY: tr, rotation: 0, largeArc: false, sweep: true, point: { x: width, y: tr } });
  commands.push({ kind: "lineTo", point: { x: width, y: height - br } });
  if (br) commands.push({ kind: "arcTo", radiusX: br, radiusY: br, rotation: 0, largeArc: false, sweep: true, point: { x: width - br, y: height } });
  commands.push({ kind: "lineTo", point: { x: bl, y: height } });
  if (bl) commands.push({ kind: "arcTo", radiusX: bl, radiusY: bl, rotation: 0, largeArc: false, sweep: true, point: { x: 0, y: height - bl } });
  commands.push({ kind: "lineTo", point: { x: 0, y: tl } });
  if (tl) commands.push({ kind: "arcTo", radiusX: tl, radiusY: tl, rotation: 0, largeArc: false, sweep: true, point: { x: tl, y: 0 } });
  commands.push({ kind: "close" });
  return { unit: "pt", viewBox: { width, height }, fillRule: "nonzero", commands };
}

function fillIsVisible(fill) {
  if (fill.kind === "none") return false;
  if (fill.kind === "solid") return fill.color.alpha > 0;
  return fill.stops.some((stop) => stop.color.alpha > 0);
}

function styleHasVisiblePaint(style) {
  if (fillIsVisible(style.fill)) return true;
  return Object.values(style.borders).some((border) => border.style !== "none" && border.width.value > 0 && border.color.alpha > 0);
}

function borderIsVisible(border) {
  return border.style !== "none" && border.width.value > 0 && border.color.alpha > 0;
}

function borderNeedsPathLowering(style) {
  const borders = Object.values(style.borders);
  const visible = borders.filter(borderIsVisible);
  if (!visible.length) return false;
  const first = borders[0];
  return !borders.every((border) => border.style === first.style
    && border.width.value === first.width.value
    && border.width.unit === first.width.unit
    && border.alignment === first.alignment
    && JSON.stringify(border.color) === JSON.stringify(first.color))
    || first.alignment !== "center";
}

function styleWithoutBorders(style) {
  const noBorder = (border) => ({ ...border, width: { value: 0, unit: "pt" }, style: "none", alignment: "center" });
  return { ...style, borders: Object.fromEntries(Object.entries(style.borders).map(([side, border]) => [side, noBorder(border)])) };
}

function transparentTextStyle(style) {
  const zero = { value: 0, unit: "pt" };
  const edges = { top: zero, right: zero, bottom: zero, left: zero };
  const radii = { topLeft: zero, topRight: zero, bottomRight: zero, bottomLeft: zero };
  return {
    ...styleWithoutBorders(style),
    padding: edges,
    margin: edges,
    cornerRadii: radii,
    fill: { kind: "none" },
    clip: "none",
  };
}

function lowerPositionedText(primitiveId, nodeId, model, style) {
  if (model.layoutMode !== "positioned-clusters") return null;
  const clusterStyle = transparentTextStyle(style);
  return model.positionedClusters.flatMap((cluster) => {
    if (cluster.paintMode === "advance-only") return [];
    if (cluster.shapingIsolation !== "independent") {
      throw new Error(`节点 ${nodeId} 的定位簇 ${cluster.clusterId} 依赖上下文塑形，不能拆成独立可编辑文本对象`);
    }
    const sourceRun = model.runs.find((run) => run.start <= cluster.start && run.end >= cluster.end);
    const sourceParagraph = model.paragraphs.find((paragraph) => paragraph.start <= cluster.start && paragraph.end >= cluster.end);
    const sourceLine = model.visualLines[cluster.lineIndex];
    if (!sourceRun || !sourceParagraph || !sourceLine) throw new Error(`节点 ${nodeId} 的定位簇 ${cluster.clusterId} 缺少完整文字样式或行信息`);
    const content = sliceIndexedText(model, cluster.start, cluster.end);
    const startOffset = utf16OffsetAt(model, cluster.start);
    const endOffset = utf16OffsetAt(model, cluster.end);
    const sourceBoundaries = model.indexMap.utf16Boundaries.slice(cluster.start, cluster.end + 1);
    const { glyphAdvances: _glyphAdvances, ...runWithoutAdvances } = sourceRun;
    const span = cluster.end - cluster.start;
    return [{
      primitiveId: `${primitiveId}-cluster-${cluster.clusterId}`,
      kind: "text",
      box: cluster.frame,
      style: clusterStyle,
      editable: true,
      sourceNodeRefs: [nodeId],
      text: {
        content,
        inkBox: cluster.inkBox,
        boundaryPolicy: {
          ...model.boundaryPolicy,
          minimumClearance: model.boundaryPolicy.minimumClearance,
        },
        indexMap: {
          mode: "explicit-grapheme-boundaries",
          utf16Boundaries: sourceBoundaries.map((offset) => offset - startOffset),
        },
        hardBreakRanges: [],
        runs: [{ ...runWithoutAdvances, start: 0, end: span }],
        paragraphs: [{ ...sourceParagraph, start: 0, end: span, alignment: "left" }],
        visualLines: [{
          ...sourceLine,
          start: 0,
          end: span,
          box: { x: 0, y: 0, width: cluster.frame.width, height: cluster.frame.height, unit: "pt", coordinateSpace: "slide" },
          baseline: cluster.baseline,
          lineHeight: { value: cluster.frame.height, unit: "pt" },
          breakKind: "none",
        }],
        layoutMode: "native-flow",
        positionedClusters: [],
        wrapMode: "none",
        overflow: "clip",
      },
    }];
  });
}

function polygonPath(points) {
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));
  return {
    offset: { x: minX, y: minY },
    width: maxX - minX,
    height: maxY - minY,
    path: {
      unit: "pt",
      viewBox: { width: maxX - minX, height: maxY - minY },
      fillRule: "nonzero",
      commands: [
        { kind: "moveTo", point: { x: points[0].x - minX, y: points[0].y - minY } },
        ...points.slice(1).map((point) => ({ kind: "lineTo", point: { x: point.x - minX, y: point.y - minY } })),
        { kind: "close" },
      ],
    },
  };
}

function borderSplit(border) {
  if (!borderIsVisible(border)) return { outer: 0, inner: 0 };
  if (border.alignment === "inside") return { outer: 0, inner: border.width.value };
  if (border.alignment === "outside") return { outer: border.width.value, inner: 0 };
  return { outer: border.width.value / 2, inner: border.width.value / 2 };
}

function lowerSolidBorders(primitiveId, nodeId, box, style) {
  if (!borderNeedsPathLowering(style)) return null;
  const visible = Object.entries(style.borders).filter(([, border]) => borderIsVisible(border));
  if (visible.some(([, border]) => border.style !== "solid")) {
    throw new Error(`节点 ${nodeId} 的逐边虚线/点线边框尚未支持`);
  }
  if (Object.values(style.cornerRadii).some((radius) => radius.value !== 0)) {
    throw new Error(`节点 ${nodeId} 的圆角逐边边框尚未支持`);
  }
  const split = Object.fromEntries(Object.entries(style.borders).map(([side, border]) => [side, borderSplit(border)]));
  const outer = {
    left: -split.left.outer,
    top: -split.top.outer,
    right: box.width + split.right.outer,
    bottom: box.height + split.bottom.outer,
  };
  const inner = {
    left: split.left.inner,
    top: split.top.inner,
    right: box.width - split.right.inner,
    bottom: box.height - split.bottom.inner,
  };
  if (inner.left > inner.right || inner.top > inner.bottom) throw new Error(`节点 ${nodeId} 的边框宽度超过盒子可用尺寸`);
  const polygons = {
    top: [{ x: outer.left, y: outer.top }, { x: outer.right, y: outer.top }, { x: inner.right, y: inner.top }, { x: inner.left, y: inner.top }],
    right: [{ x: outer.right, y: outer.top }, { x: outer.right, y: outer.bottom }, { x: inner.right, y: inner.bottom }, { x: inner.right, y: inner.top }],
    bottom: [{ x: outer.right, y: outer.bottom }, { x: outer.left, y: outer.bottom }, { x: inner.left, y: inner.bottom }, { x: inner.right, y: inner.bottom }],
    left: [{ x: outer.left, y: outer.bottom }, { x: outer.left, y: outer.top }, { x: inner.left, y: inner.top }, { x: inner.left, y: inner.bottom }],
  };
  return visible.map(([side, border]) => {
    const polygon = polygonPath(polygons[side]);
    const borderStyle = styleWithoutBorders({
      ...style,
      fill: { kind: "solid", color: border.color },
      cornerRadii: Object.fromEntries(Object.keys(style.cornerRadii).map((key) => [key, { value: 0, unit: "pt" }])),
    });
    return {
      primitiveId: `${primitiveId}-border-${side}`,
      kind: "path",
      box: { x: box.x + polygon.offset.x, y: box.y + polygon.offset.y, width: polygon.width, height: polygon.height, unit: "pt", coordinateSpace: "slide" },
      style: borderStyle,
      editable: true,
      sourceNodeRefs: [nodeId],
      path: polygon.path,
    };
  });
}

export function compileRenderPlane(semanticPlaneArtifact, transform = { scaleX: 1, scaleY: 1 }) {
  if (semanticPlaneArtifact.artifactType !== "semantic-plane") throw new Error("输入必须是 semantic-plane Artifact");
  if (!(transform.scaleX > 0) || !(transform.scaleY > 0)) throw new Error("sourceToSlide 缩放必须为正数");

  function compileSlide(slide) {
    const globalPaintOrder = [];
    const editabilityMap = [];
    const fallbacks = [];

    function compileNode(node) {
      const primitiveId = `primitive-${node.nodeId}`;
      let kind;
      if (node.kind === "text") kind = "text";
      else if (node.kind === "image" || (node.kind === "icon" && node.sourceBlobDigest)) kind = "image";
      else if (node.kind === "connector") kind = "connector";
      else if (["group", "custom", "table", "table-row", "table-cell", "list", "list-item"].includes(node.kind) || (node.kind === "icon" && node.children.length)) kind = "group";
      else kind = "path";

      if (node.kind === "custom" && node.children.length === 0) {
        throw new Error(`custom 节点 ${node.nodeId} 没有可编译的子节点`);
      }

      const box = toSlideBox(node.box, transform);
      const style = toSlideStyle(node.computedStyle, transform);
      const compiledText = kind === "text" ? toSlideText(node.text, transform) : null;
      const compiledConnector = kind === "connector" ? toSlideConnector(node.connector, transform) : null;
      const arrowLayers = [];
      if (compiledConnector) {
        for (const [side, arrow] of [["start", compiledConnector.startArrow], ["end", compiledConnector.endArrow]]) {
          if (arrow.kind === "none") continue;
          if (arrow.canonicalPath.viewBox.width !== compiledConnector.path.viewBox.width
            || arrow.canonicalPath.viewBox.height !== compiledConnector.path.viewBox.height
            || arrow.canonicalPath.unit !== compiledConnector.path.unit) {
            throw new Error(`节点 ${node.nodeId} 的 ${side}Arrow canonicalPath 必须与 connector path 使用同一 viewBox`);
          }
          arrowLayers.push({
            primitiveId: `${primitiveId}-arrow-${side}`,
            kind: "path",
            box,
            style: arrow.canonicalStyle,
            editable: true,
            sourceNodeRefs: [node.nodeId],
            path: arrow.canonicalPath,
          });
        }
      }
      const loweredBorders = ["group", "path", "text", "image"].includes(kind)
        ? lowerSolidBorders(primitiveId, node.nodeId, box, style)
        : null;
      const baseStyle = loweredBorders ? styleWithoutBorders(style) : style;
      const ownLayers = [];
      const positionedTextLayers = compiledText ? lowerPositionedText(primitiveId, node.nodeId, compiledText, baseStyle) : null;
      if (positionedTextLayers) {
        if (styleHasVisiblePaint(baseStyle)) ownLayers.push({
          primitiveId: `${primitiveId}-background`,
          kind: "path",
          box,
          style: baseStyle,
          editable: true,
          sourceNodeRefs: [node.nodeId],
          path: roundedRectPath(box, baseStyle),
        });
        ownLayers.push(...positionedTextLayers, ...(loweredBorders ?? []));
      } else if (kind === "group") {
        if (styleHasVisiblePaint(baseStyle)) ownLayers.push({
          primitiveId: `${primitiveId}-background`,
          kind: "path",
          box,
          style: baseStyle,
          editable: true,
          sourceNodeRefs: [node.nodeId],
          path: roundedRectPath(box, baseStyle),
        });
        ownLayers.push(...(loweredBorders ?? []));
      } else if (loweredBorders) {
        if (kind !== "path" || fillIsVisible(baseStyle.fill)) ownLayers.push({
          primitiveId: `${primitiveId}-content`,
          kind,
          box,
          style: baseStyle,
          editable: true,
          sourceNodeRefs: [node.nodeId],
          ...(kind === "text" ? { text: compiledText } : {}),
          ...(kind === "path" ? { path: node.path ? toSlidePath(node.path, transform) : roundedRectPath(box, baseStyle) } : {}),
          ...(kind === "image" ? { blobDigest: node.sourceBlobDigest, crop: node.crop } : {}),
        });
        ownLayers.push(...loweredBorders);
      } else if (arrowLayers.length) {
        ownLayers.push({
          primitiveId: `${primitiveId}-content`,
          kind: "connector",
          box,
          style,
          editable: true,
          sourceNodeRefs: [node.nodeId],
          connector: {
            ...compiledConnector,
            startArrow: { ...compiledConnector.startArrow, kind: "none" },
            endArrow: { ...compiledConnector.endArrow, kind: "none" },
          },
        }, ...arrowLayers);
      }
      if (kind !== "group" && !positionedTextLayers && !loweredBorders && !arrowLayers.length) globalPaintOrder.push(primitiveId);
      for (const layer of ownLayers) globalPaintOrder.push(layer.primitiveId);
      const semanticChildren = node.children.map(compileNode);
      let primitive;
      if (kind === "group" || positionedTextLayers || loweredBorders || arrowLayers.length) {
        primitive = {
          primitiveId,
          kind: "group",
          box,
          style,
          editable: true,
          sourceNodeRefs: [node.nodeId],
          children: [...ownLayers, ...semanticChildren],
        };
      } else {
        primitive = {
          primitiveId,
          kind,
          box,
          style,
          editable: true,
          sourceNodeRefs: [node.nodeId],
          ...(kind === "text" ? { text: compiledText } : {}),
          ...(kind === "path" ? { path: node.path ? toSlidePath(node.path, transform) : roundedRectPath(box, style) } : {}),
          ...(kind === "image" ? { blobDigest: node.sourceBlobDigest, crop: node.crop } : {}),
          ...(kind === "connector" ? { connector: compiledConnector } : {}),
          ...(semanticChildren.length ? { children: semanticChildren } : {}),
        };
      }
      editabilityMap.push({ nodeId: node.nodeId, primitiveIds: [primitiveId, ...ownLayers.map((layer) => layer.primitiveId)], editable: true });
      if (loweredBorders) {
        fallbacks.push({ nodeId: node.nodeId, reason: "per-edge border lowered into non-overlapping editable paths", strategy: "custom-primitive-group", approved: true });
      }
      if (positionedTextLayers) {
        fallbacks.push({ nodeId: node.nodeId, reason: "explicit grapheme frames lowered into independently editable text primitives", strategy: "custom-primitive-group", approved: true });
      }
      if (arrowLayers.length) {
        fallbacks.push({ nodeId: node.nodeId, reason: "canonical connector arrows expanded into editable paths", strategy: "custom-primitive-group", approved: true });
      }
      if (node.kind === "custom") {
        fallbacks.push({ nodeId: node.nodeId, reason: "custom node expanded into editable primitive group", strategy: "custom-primitive-group", approved: true });
      }
      return primitive;
    }

    return {
      slideId: slide.slideId,
      renderRoot: compileNode(slide.root),
      globalPaintOrder,
      editabilityMap,
      fallbacks,
    };
  }

  return {
    semanticPlaneRef: semanticPlaneArtifact.artifactId,
    slides: semanticPlaneArtifact.body.slides.map(compileSlide),
  };
}
