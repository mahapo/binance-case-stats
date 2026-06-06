#!/usr/bin/env node
/*
 * Markdown -> self-contained PDF (for the Gutachten).
 *
 *   npm run pdf                       # docs/zone-recovery/GUTACHTEN.md -> GUTACHTEN.pdf
 *   node scripts/md-to-pdf.js <in.md> [out.pdf]
 *
 * Inlines images relative to the .md file (SVG as vector markup, raster as base64)
 * so the PDF is fully self-contained, then prints it via headless Chrome/Chromium.
 * Override the browser with CHROME_PATH if needed.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { marked } = require("marked");

const input = path.resolve(process.argv[2] || "docs/zone-recovery/GUTACHTEN.md");
const output = path.resolve(process.argv[3] || input.replace(/\.md$/i, ".pdf"));
const baseDir = path.dirname(input);

if (!fs.existsSync(input)) {
  console.error(`Input nicht gefunden: ${input}`);
  process.exit(1);
}

// 1) Markdown -> HTML, then inline every local image.
let body = marked.parse(fs.readFileSync(input, "utf8"));
body = body.replace(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/g, (m, src) => {
  if (/^(https?:|data:)/i.test(src)) return m; // leave remote/data URIs alone
  const file = path.join(baseDir, decodeURIComponent(src));
  try {
    if (/\.svg$/i.test(file)) {
      const svg = fs
        .readFileSync(file, "utf8")
        .replace(/<\?xml[^>]*\?>/i, "")
        .replace(/<!DOCTYPE[^>]*>/i, "")
        .trim();
      return `<figure class="fig">${svg}</figure>`;
    }
    const ext = path.extname(file).slice(1).toLowerCase();
    const mime = ext === "jpg" ? "jpeg" : ext;
    const b64 = fs.readFileSync(file).toString("base64");
    return `<figure class="fig"><img src="data:image/${mime};base64,${b64}"></figure>`;
  } catch {
    return `<p style="color:#b00">[Bild fehlt: ${src}]</p>`;
  }
});

// 2) Wrap in a print stylesheet (A4, clean, no grey boxes).
const css = `
  @page { size: A4; margin: 16mm 15mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; font-size: 10.5pt;
         line-height: 1.5; color: #1a1a1a; max-width: 100%; }
  h1 { font-size: 19pt; line-height: 1.25; margin: 0 0 8px; }
  h2 { font-size: 15pt; margin: 22px 0 8px; padding-top: 6px; border-top: 2px solid #e5e7eb; }
  h3 { font-size: 12.5pt; margin: 16px 0 6px; }
  h4 { font-size: 11pt; margin: 12px 0 4px; }
  h2, h3, h4 { break-after: avoid; }
  p, li { orphans: 2; widows: 2; }
  a { color: #1d4ed8; text-decoration: none; }
  strong { color: #111; }
  blockquote { margin: 12px 0; padding: 0; font-size: 10pt; }
  code { padding: 0; font-size: 9pt; font-family: "SF Mono", Menlo, Consolas, monospace; }
  pre { padding: 6px 0; font-size: 9.2pt; line-height: 1.55; white-space: pre-wrap;
        word-break: break-word; font-family: "SF Mono", Menlo, Consolas, monospace; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 8.8pt;
          break-inside: avoid; }
  th, td { border: 1px solid #d0d7de; padding: 3px 7px; text-align: left; vertical-align: top; }
  th { background: #f0f3f6; }
  tbody tr:nth-child(even) { background: #fafbfc; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 18px 0; }
  .fig { margin: 10px 0; text-align: center; break-inside: avoid; }
  .fig svg, .fig img { max-width: 100%; height: auto; }
  em { color: #555; }
`;
const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
const tmpHtml = path.join(os.tmpdir(), `md2pdf-${Date.now()}.html`);
fs.writeFileSync(tmpHtml, html);

// 3) Locate a Chrome/Chromium binary.
const candidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
].filter(Boolean);
let chrome = null;
for (const c of candidates) {
  try {
    if (c.includes("/")) { fs.accessSync(c, fs.constants.X_OK); chrome = c; break; }
    chrome = execFileSync("command", ["-v", c], { shell: true }).toString().trim(); break;
  } catch { /* try next */ }
}
if (!chrome) {
  console.error("Kein Chrome/Chromium gefunden. Bitte CHROME_PATH setzen.");
  process.exit(1);
}

// 4) Print to PDF.
execFileSync(chrome, [
  "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
  "--virtual-time-budget=20000", `--print-to-pdf=${output}`, `file://${tmpHtml}`,
], { stdio: "ignore" });
fs.rmSync(tmpHtml, { force: true });

const mb = (fs.statSync(output).size / 1048576).toFixed(2);
console.log(`PDF erstellt: ${output} (${mb} MB)`);
