export function codePointBoundaries(content) {
  const boundaries = [0];
  let offset = 0;
  for (const scalar of content) {
    offset += scalar.length;
    boundaries.push(offset);
  }
  return boundaries;
}

export function textIndexLength(model) {
  return Math.max(0, (model.indexMap?.utf16Boundaries?.length ?? 1) - 1);
}

export function utf16OffsetAt(model, index) {
  const offset = model.indexMap.utf16Boundaries[index];
  if (offset === undefined) throw new Error(`文字索引 ${index} 超出显式边界表`);
  return offset;
}

export function textIndexAtUtf16Offset(model, offset) {
  const index = model.indexMap.utf16Boundaries.indexOf(offset);
  if (index < 0) throw new Error(`UTF-16 偏移 ${offset} 不在显式文字边界表中`);
  return index;
}

export function sliceIndexedText(model, start, end) {
  return model.content.slice(utf16OffsetAt(model, start), utf16OffsetAt(model, end));
}

export function indexedTextSegment(model, index) {
  return sliceIndexedText(model, index, index + 1);
}

export function explicitTextIndexErrors(model) {
  const boundaries = model.indexMap?.utf16Boundaries ?? [];
  const errors = [];
  if (model.indexMap?.mode !== "explicit-grapheme-boundaries") errors.push("文字索引必须使用 explicit-grapheme-boundaries");
  if (boundaries[0] !== 0) errors.push("文字边界表必须从 UTF-16 偏移 0 开始");
  if (boundaries.at(-1) !== model.content.length) errors.push(`文字边界表必须结束于 UTF-16 偏移 ${model.content.length}`);
  for (let index = 1; index < boundaries.length; index += 1) {
    if (boundaries[index] <= boundaries[index - 1]) errors.push("文字边界表必须严格递增");
    const offset = boundaries[index];
    if (offset > 0 && offset < model.content.length) {
      const previous = model.content.charCodeAt(offset - 1);
      const current = model.content.charCodeAt(offset);
      if (previous >= 0xD800 && previous <= 0xDBFF && current >= 0xDC00 && current <= 0xDFFF) {
        errors.push(`文字边界 ${offset} 切断了 UTF-16 代理对`);
      }
    }
  }
  return [...new Set(errors)];
}
