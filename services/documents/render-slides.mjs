import fs from "node:fs/promises";
import path from "node:path";
import PptxGenJS from "pptxgenjs";
import { imageSize } from "image-size";

const [input, output] = process.argv.slice(2);
const { units, sources, title } = JSON.parse(await fs.readFile(input, "utf8"));
const deck = new PptxGenJS();
deck.layout = "LAYOUT_WIDE";
deck.author = "ArchFlow";
deck.subject = title;
deck.title = title;
deck.lang = "zh-CN";
const reference = sources.find(item => item.role === "reference");
const theme = reference?.theme ?? {};
const accent = theme.accent ?? "284E5C";
const font = "Noto Sans CJK SC";
deck.theme = { headFontFace: font, bodyFontFace: font, lang: "zh-CN" };
const issues = [];
const assets = new Map(sources.flatMap(doc => doc.assets.map(asset => [asset.id, { ...asset, directory: doc.directory }])));
async function placeImage(slide, assetId, box) {
  const image = assets.get(assetId);
  if (!image) throw new Error(`第 ${box.page} 页使用了不属于当前资料的图片。`);
  const imagePath = path.join(image.directory, image.file);
  const dimensions = imageSize(await fs.readFile(imagePath));
  if (box.fit === "cover") {
    // PptxGenJS computes srcRect from the image object's initial w/h, then
    // replaces its slide geometry with sizing.w/h. Initial dimensions must
    // reflect the source aspect ratio, not the destination box.
    slide.addImage({ path: imagePath, x: box.x, y: box.y, w: dimensions.width / 100, h: dimensions.height / 100,
      sizing: { type: "cover", w: box.w, h: box.h }, altText: image.caption ?? "项目资料" });
    return;
  }
  const scale = Math.min(box.w / dimensions.width, box.h / dimensions.height);
  const w = dimensions.width * scale, h = dimensions.height * scale;
  slide.addImage({ path: imagePath, x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h, altText: image.caption ?? "项目资料" });
}

async function renderDesignedSlide(slide, unit) {
  const design = unit.slide;
  slide.background = { color: design.background };
  for (const element of design.elements) {
    const box = { x: element.x, y: element.y, w: element.w, h: element.h };
    if (box.x + box.w > 13.334 || box.y + box.h > 7.501) throw new Error(`第 ${unit.unit_index} 页有元素超出画布。`);
    if (element.kind === "image") {
      await placeImage(slide, element.image_id, { ...box, fit: element.fit, page: unit.unit_index });
    } else if (element.kind === "text") {
      const characters = [...element.text].reduce((total, char) => total + (char.charCodeAt(0) < 128 ? .55 : 1), 0);
      const capacity = Math.max(1, Math.floor(box.w * 72 / element.font_size * box.h * 72 / (element.font_size * 1.4)));
      if (characters > capacity * 1.35) issues.push(`第 ${unit.unit_index} 页文字框过密：${element.text.slice(0, 24)}…`);
      slide.addText(element.text, { ...box, fontFace: font, fontSize: element.font_size, bold: element.bold, color: element.color,
        align: element.align, valign: element.valign, margin: 0, breakLine: false });
    } else if (element.kind === "table") {
      if (element.rows.some(row => row.some(cell => cell.length > 45))) issues.push(`第 ${unit.unit_index} 页表格单元格过密。`);
      const styledRows = element.rows.map((row, index) => row.map(cell => ({ text: cell, options: {
        fill: { color: index === 0 && element.header_fill ? element.header_fill : index % 2 === 0 && element.alternate_fill ? element.alternate_fill : element.fill ?? "FFFFFF" },
        color: index === 0 && element.header_color ? element.header_color : element.color, bold: index === 0,
      } })));
      slide.addTable(styledRows, { ...box, fontFace: font, fontSize: element.font_size, color: element.color,
        border: { pt: .5, color: element.stroke ?? "D7DEE2" }, fill: { color: element.fill ?? "FFFFFF" },
        margin: .06, autoPage: false, rowH: Math.min(.6, box.h / element.rows.length) });
    } else if (element.kind === "line") {
      slide.addShape(deck.ShapeType.line, { ...box, line: { color: element.stroke ?? element.color, width: 1.5 } });
    } else {
      slide.addShape(element.kind === "ellipse" ? deck.ShapeType.ellipse : deck.ShapeType.rect,
        { ...box, rectRadius: 0, line: { color: element.stroke ?? element.fill ?? design.background, width: element.stroke ? 1 : 0 },
          fill: { color: element.fill ?? design.background } });
    }
  }
}
function wrap(text, width) {
  return text.split("\n").flatMap(paragraph => {
    const tokens = paragraph.match(/[A-Za-z0-9]+(?:[.,/_-][A-Za-z0-9]+)*|./gu) ?? [];
    const weight = value => [...value].reduce((sum, character) => sum + (character.charCodeAt(0) < 128 ? .6 : 1), 0);
    const total = weight(paragraph);
    const balanced = Math.min(width, Math.ceil(total / Math.max(1, Math.ceil(total / width))));
    let line = "", length = 0;
    const lines = [];
    for (const token of tokens) {
      const size = weight(token);
      if (length + size > balanced && line && !/^[。，、；：！？）》”’%]$/.test(token)) { lines.push(line.trim()); line = ""; length = 0; }
      if (!line && /^\s+$/.test(token)) continue;
      line += token; length += size;
    }
    lines.push(line.trim());
    return lines;
  });
}

for (const unit of units) {
  const slide = deck.addSlide();
  if (unit.slide) {
    await renderDesignedSlide(slide, unit);
    const citations = unit.evidence.map(id => {
      for (const doc of sources) {
        const page = doc.pages.find(page => page.id === id);
        if (page) return `${doc.name}，第 ${page.page} 页（${doc.role === "reference" ? "参考案例，不是当前项目事实" : "项目资料"}）`;
      }
      return id === "user-brief" ? "用户在项目对话中确认的需求" : id;
    });
    slide.addNotes(citations.join("\n"));
    continue;
  }
  slide.background = { color: "FFFFFF" };
  const image = unit.layout === "table" ? null : sources.flatMap(doc => doc.assets.map(asset => ({ ...asset, directory: doc.directory }))).find(asset => asset.id === unit.image_id);
  const isCover = unit.layout === "cover";
  const bodyText = unit.body.replace(/^#+\s*/gm, "").replace(/\*\*/g, "");
  const bodyRows = wrap(bodyText, image ? 17 : 40);
  const body = bodyRows.join("\n");
  const titleRows = wrap(unit.title, isCover ? (image ? 8 : 20) : 25);
  // Fixed geometry + character/line budget rejects crowded content rather than shrinking it.
  if (titleRows.length > 2 || (unit.layout !== "table" && bodyRows.length > (isCover ? 6 : 10))) issues.push(`第 ${unit.unit_index} 页内容过密，请精简文字或拆分内容后重试。`);
  if (isCover) {
    slide.addText(titleRows.join("\n"), { x: .7, y: 1.15, w: image ? 5.1 : 11.9, h: 1.55, fontFace: font, fontSize: 42, bold: true, color: "152D38", margin: 0, breakLine: false });
    slide.addText(body, { x: .72, y: 3.0, w: image ? 5.1 : 11.85, h: 2.25, fontFace: font, fontSize: 20, color: accent, margin: 0, valign: "top" });
  } else {
    slide.addText(titleRows.join("\n"), { x: .7, y: .55, w: 11.9, h: 1.1, fontFace: font, fontSize: 32, bold: true, color: "152D38", margin: 0 });
    if (unit.layout === "table" && unit.table?.length) {
      if (unit.table.length > 9 || unit.table.some(row => row.length > 6 || row.some(cell => cell.length > 60))) issues.push(`第 ${unit.unit_index} 页表格过密。`);
      slide.addTable(unit.table, { x: .72, y: 1.95, w: 11.85, fontFace: font, fontSize: 17, color: "152D38", border: { pt: .5, color: "D9D9D9" }, margin: .12, rowH: .45, autoPage: false });
    } else {
      slide.addText(body, { x: .72, y: 1.95, w: image ? 5.1 : 11.85, h: 4.75, fontFace: font, fontSize: 20, color: "344650", margin: 0, valign: "top", paraSpaceAfter: 6, breakLine: false });
    }
  }
  if (image) {
    const imagePath = path.join(image.directory, image.file);
    const dimensions = imageSize(await fs.readFile(imagePath));
    const box = { x: 6.2, y: isCover ? 1.0 : 1.95, w: 6.35, h: isCover ? 5.5 : 4.75 };
    const scale = Math.min(box.w / dimensions.width, box.h / dimensions.height);
    const w = dimensions.width * scale, h = dimensions.height * scale;
    slide.addImage({ path: imagePath, x: box.x + (box.w-w)/2, y: box.y + (box.h-h)/2, w, h, altText: image.caption ?? "项目资料" });
  }
  slide.addText(String(unit.unit_index).padStart(2, "0"), { x: 12.05, y: 7.05, w: .5, h: .2, fontFace: font, fontSize: 10, color: "7C8C92", margin: 0, align: "right" });
  const citations = unit.evidence.map(id => {
    for (const doc of sources) {
      const page = doc.pages.find(page => page.id === id);
      if (page) return `${doc.name}，第 ${page.page} 页（${doc.role === "reference" ? "参考案例，不是当前项目事实" : "项目资料"}）`;
    }
    return id === "user-brief" ? "用户在项目对话中确认的需求" : id;
  });
  slide.addNotes(citations.join("\n"));
}
if (issues.length) throw new Error(issues.join("\n"));
await deck.writeFile({ fileName: output });
