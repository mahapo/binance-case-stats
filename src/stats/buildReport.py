#!/usr/bin/env python3
"""
Render docs/stats/GUTACHTEN.md to a print-ready HTML (embedded CSS) so it can be
converted to PDF by headless Chrome. Images are referenced relatively, so the HTML
is written next to the markdown (same dir as img/).

Run:  npm run stats:report        # = python3 src/stats/buildReport.py
Then (PDF):
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu \
      --print-to-pdf=docs/stats/GUTACHTEN.pdf --no-pdf-header-footer docs/stats/GUTACHTEN.html
"""
import os
import markdown

HERE = os.path.dirname(os.path.abspath(__file__))
DOC = os.path.abspath(os.path.join(HERE, "..", "..", "docs", "stats"))
SRC = os.path.join(DOC, "GUTACHTEN.md")
OUT = os.path.join(DOC, "GUTACHTEN.html")

with open(SRC, encoding="utf-8") as f:
    md_text = f.read()

body = markdown.markdown(
    md_text,
    extensions=["extra", "tables", "sane_lists", "toc", "nl2br"],
)

CSS = """
@page { size: A4; margin: 18mm 16mm 20mm 16mm; }
* { box-sizing: border-box; }
body {
  font-family: -apple-system, "Helvetica Neue", Arial, sans-serif;
  font-size: 10.5pt; line-height: 1.5; color: #1a1a1a; max-width: 100%;
}
h1 { font-size: 19pt; color: #1a2533; border-bottom: 3px solid #2980b9;
     padding-bottom: 8px; margin: 0 0 14px; }
h2 { font-size: 14pt; color: #1a2533; border-bottom: 1px solid #d0d7de;
     padding-bottom: 4px; margin: 22px 0 10px; page-break-after: avoid; }
h3 { font-size: 11.5pt; color: #2c3e50; margin: 16px 0 6px; page-break-after: avoid; }
p { margin: 6px 0; }
strong { color: #11181f; }
mark { background: #fff2a8; padding: 0 2px; border-radius: 2px; }
a { color: #2980b9; text-decoration: none; }
img { max-width: 100%; height: auto; display: block; margin: 10px auto;
      page-break-inside: avoid; border: 1px solid #e1e4e8; border-radius: 4px; }
table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 9.5pt;
        page-break-inside: avoid; }
th, td { border: 1px solid #c8cdd2; padding: 5px 8px; text-align: left; }
th { background: #f0f3f6; }
tr:nth-child(even) td { background: #fafbfc; }
blockquote {
  margin: 10px 0; padding: 8px 14px; background: #f6f8fa;
  border-left: 4px solid #2980b9; color: #2c3e50; page-break-inside: avoid;
  font-size: 9.8pt;
}
code { background: #f0f3f6; padding: 1px 4px; border-radius: 3px;
       font-family: "SF Mono", Menlo, monospace; font-size: 9pt; }
pre { background: #f6f8fa; padding: 10px; border-radius: 5px; overflow-x: auto;
      page-break-inside: avoid; }
pre code { background: none; padding: 0; }
hr { border: none; border-top: 1px solid #d0d7de; margin: 16px 0; }
"""

html = f"""<!DOCTYPE html>
<html lang="de"><head><meta charset="utf-8">
<title>Statistisches Gutachten — Binance USD-M Futures</title>
<style>{CSS}</style></head>
<body>{body}</body></html>"""

with open(OUT, "w", encoding="utf-8") as f:
    f.write(html)
print("Wrote", os.path.relpath(OUT))
