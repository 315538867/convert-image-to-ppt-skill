import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const outputDir = path.join(root, "golden-corpus", "references");

const svg = (body, width = 960, height = 540, background = "#ffffff") => `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${background}"/>
  ${body}
</svg>`;

const assets = {
  "text-dense": svg(`
    <text x="48" y="62" font-family="Arial" font-size="28" font-weight="700" fill="#172033">Quarterly operations review</text>
    <text x="48" y="96" font-family="Arial" font-size="15" fill="#5b6475">Dense text layout with mixed weights, metrics, and aligned labels</text>
    ${Array.from({ length: 11 }, (_, index) => `<text x="48" y="${145 + index * 29}" font-family="Arial" font-size="16" fill="#283449">${String(index + 1).padStart(2, "0")}  Delivery milestone ${index + 1}    Owner: Team ${String.fromCharCode(65 + index % 5)}    Status: ${index % 3 === 0 ? "Complete" : "In progress"}</text>`).join("")}
    <line x1="48" y1="468" x2="912" y2="468" stroke="#c9d0db"/>
    <text x="48" y="503" font-family="Arial" font-size="14" fill="#687386">Notes: compare line wrapping, baseline alignment, and small type.</text>
  `),
  "table-grid": svg(`
    <text x="48" y="58" font-family="Arial" font-size="27" font-weight="700" fill="#172033">Resource allocation</text>
    <rect x="48" y="88" width="864" height="364" fill="#ffffff" stroke="#7e8ca3" stroke-width="2"/>
    ${[0, 1, 2, 3, 4, 5].map((row) => `<line x1="48" y1="${148 + row * 60}" x2="912" y2="${148 + row * 60}" stroke="#b7c0ce"/>`).join("")}
    ${[1, 2, 3].map((column) => `<line x1="${48 + column * 216}" y1="88" x2="${48 + column * 216}" y2="452" stroke="#b7c0ce"/>`).join("")}
    <rect x="49" y="89" width="862" height="59" fill="#e8eef7"/>
    ${["Department", "Budget", "Actual", "Variance"].map((label, index) => `<text x="${70 + index * 216}" y="125" font-family="Arial" font-size="16" font-weight="700" fill="#24324a">${label}</text>`).join("")}
    ${["Design", "Engineering", "Research", "Support", "Operations"].flatMap((label, row) => [
      `<text x="70" y="${185 + row * 60}" font-family="Arial" font-size="16" fill="#2d3a4f">${label}</text>`,
      `<text x="286" y="${185 + row * 60}" font-family="Arial" font-size="16" fill="#2d3a4f">$${(48 + row * 12).toFixed(1)}k</text>`,
      `<text x="502" y="${185 + row * 60}" font-family="Arial" font-size="16" fill="#2d3a4f">$${(45 + row * 13).toFixed(1)}k</text>`,
      `<text x="718" y="${185 + row * 60}" font-family="Arial" font-size="16" fill="${row % 2 ? "#ad4a35" : "#23745d"}">${row % 2 ? "-2.1%" : "+4.8%"}</text>`
    ]).join("")}
  `),
  "flowchart-structure": svg(`
    <text x="48" y="58" font-family="Arial" font-size="27" font-weight="700" fill="#172033">Approval workflow</text>
    <g font-family="Arial" font-size="16" text-anchor="middle" fill="#1f2d42">
      <rect x="70" y="205" width="170" height="74" rx="10" fill="#e9f1ff" stroke="#4675b9" stroke-width="2"/><text x="155" y="248">Submit request</text>
      <rect x="395" y="205" width="170" height="74" rx="10" fill="#eff8ed" stroke="#4d8c5d" stroke-width="2"/><text x="480" y="248">Review details</text>
      <path d="M720 205h95l35 37-35 37h-95l-35-37z" fill="#fff3d9" stroke="#bc8734" stroke-width="2"/><text x="767" y="248">Approved?</text>
      <rect x="395" y="390" width="170" height="74" rx="10" fill="#ffe9e7" stroke="#bb5b53" stroke-width="2"/><text x="480" y="433">Request changes</text>
    </g>
    <g fill="none" stroke="#526174" stroke-width="3" marker-end="url(#arrow)"><path d="M240 242h155"/><path d="M565 242h125"/><path d="M767 279v75H565"/><path d="M837 205v-75H155v75"/></g>
    <defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#526174"/></marker></defs>
    <text x="855" y="222" font-family="Arial" font-size="14" fill="#526174">No</text><text x="785" y="333" font-family="Arial" font-size="14" fill="#526174">Yes</text>
  `),
  "chart-primitives": svg(`
    <text x="48" y="58" font-family="Arial" font-size="27" font-weight="700" fill="#172033">Monthly throughput</text>
    <line x1="100" y1="420" x2="890" y2="420" stroke="#46556b" stroke-width="2"/><line x1="100" y1="105" x2="100" y2="420" stroke="#46556b" stroke-width="2"/>
    ${[0, 1, 2, 3, 4].map((tick) => `<line x1="100" y1="${420 - tick * 70}" x2="890" y2="${420 - tick * 70}" stroke="#d9dfe8"/><text x="72" y="${425 - tick * 70}" text-anchor="end" font-family="Arial" font-size="13" fill="#667287">${tick * 25}</text>`).join("")}
    ${[72, 176, 280, 384, 488, 592, 696].map((x, index) => `<rect x="${x}" y="${390 - (index % 5) * 45}" width="58" height="${30 + (index % 5) * 45}" fill="${["#3f78b5", "#5a9a76", "#d18a3d"][index % 3]}"/><text x="${x + 29}" y="448" text-anchor="middle" font-family="Arial" font-size="13" fill="#4c5a70">M${index + 1}</text>`).join("")}
    <polyline points="101,350 205,310 309,325 413,260 517,275 621,220 725,235" fill="none" stroke="#bb5549" stroke-width="4"/>
  `),
  "transparent-alpha": svg(`
    <rect x="90" y="100" width="430" height="270" rx="24" fill="#2f74b8" fill-opacity="0.72"/><circle cx="535" cy="280" r="150" fill="#ec8d53" fill-opacity="0.52"/><circle cx="390" cy="235" r="110" fill="#58a47a" fill-opacity="0.42"/>
    <text x="48" y="58" font-family="Arial" font-size="27" font-weight="700" fill="#172033">Alpha compositing</text><text x="610" y="200" font-family="Arial" font-size="18" fill="#334155">Layered transparent shapes</text><text x="610" y="231" font-family="Arial" font-size="15" fill="#64748b">Preserve opacity and overlap</text>
  `, 960, 540, "none"),
  "gradient-fill": svg(`
    <defs><linearGradient id="spectrum" x1="0" x2="1"><stop offset="0" stop-color="#2864b2"/><stop offset="0.52" stop-color="#54a27c"/><stop offset="1" stop-color="#e4a03d"/></linearGradient></defs>
    <text x="48" y="58" font-family="Arial" font-size="27" font-weight="700" fill="#172033">Gradient treatment</text><rect x="48" y="110" width="864" height="150" rx="18" fill="url(#spectrum)"/><rect x="90" y="320" width="350" height="100" rx="12" fill="#ffffff" fill-opacity="0.78" stroke="#718096"/><text x="115" y="365" font-family="Arial" font-size="19" font-weight="700" fill="#24324a">Primary panel</text><text x="115" y="394" font-family="Arial" font-size="14" fill="#526174">Fill and opacity remain editable</text>
  `),
  "shadow-effects": svg(`
    <defs><filter id="shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="12" stdDeviation="12" flood-color="#1f2937" flood-opacity="0.22"/></filter></defs>
    <text x="48" y="58" font-family="Arial" font-size="27" font-weight="700" fill="#172033">Elevation and shadow</text><rect x="92" y="125" width="330" height="230" rx="16" fill="#ffffff" filter="url(#shadow)"/><rect x="510" y="165" width="300" height="190" rx="16" fill="#f2f6fb" filter="url(#shadow)"/><text x="130" y="190" font-family="Arial" font-size="19" font-weight="700" fill="#24324a">Summary card</text><text x="130" y="225" font-family="Arial" font-size="15" fill="#5b687b">Soft ambient shadow</text><text x="548" y="220" font-family="Arial" font-size="18" font-weight="700" fill="#24324a">Secondary card</text>
  `),
  "multi-page-template": svg(`
    <text x="48" y="52" font-family="Arial" font-size="25" font-weight="700" fill="#172033">Two-page template overview</text><rect x="60" y="95" width="390" height="350" fill="#f4f7fb" stroke="#6b7a90" stroke-width="2"/><rect x="510" y="95" width="390" height="350" fill="#fff9ef" stroke="#9b835a" stroke-width="2"/><text x="92" y="140" font-family="Arial" font-size="19" font-weight="700" fill="#24324a">Page 01 / Overview</text><text x="542" y="140" font-family="Arial" font-size="19" font-weight="700" fill="#5a472b">Page 02 / Detail</text><rect x="92" y="175" width="300" height="80" fill="#4675b9"/><rect x="542" y="175" width="300" height="80" fill="#d18a3d"/><line x1="92" y1="300" x2="390" y2="300" stroke="#8290a5" stroke-width="12"/><line x1="542" y1="300" x2="840" y2="300" stroke="#ac9a7b" stroke-width="12"/><line x1="92" y1="340" x2="340" y2="340" stroke="#c2cbd8" stroke-width="10"/><line x1="542" y1="340" x2="790" y2="340" stroke="#d8c4a2" stroke-width="10"/>
  `),
  "low-clarity-input": svg(`
    <text x="48" y="58" font-family="Arial" font-size="27" font-weight="700" fill="#172033">Low clarity source</text><rect x="48" y="100" width="864" height="300" fill="#eef1f4"/><text x="82" y="180" font-family="Arial" font-size="44" font-weight="700" fill="#6f7781">Recover this heading</text><text x="84" y="235" font-family="Arial" font-size="22" fill="#7b838d">Small labels and faint separators remain legible.</text><line x1="84" y1="285" x2="820" y2="285" stroke="#aeb5bd" stroke-width="3"/><rect x="84" y="320" width="210" height="38" fill="#c6ccd2"/><rect x="320" y="320" width="160" height="38" fill="#d0d5da"/>
  `)
};

await fs.mkdir(outputDir, { recursive: true });
for (const [sampleId, markup] of Object.entries(assets)) {
  const outputPath = path.join(outputDir, `${sampleId}.png`);
  let image = sharp(Buffer.from(markup)).png();
  if (sampleId === "low-clarity-input") image = image.resize(480, 270).blur(0.7).png({ compressionLevel: 9 });
  await image.toFile(outputPath);
}

console.log(`已生成 ${Object.keys(assets).length} 个独立 golden 样例到 ${path.relative(root, outputDir)}`);
