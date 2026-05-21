import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function exportBookArtifacts(project, projectDir) {
  const exportDir = path.join(projectDir, "dist", "export");
  await mkdir(exportDir, { recursive: true });

  const printHtmlPath = path.join(exportDir, "book-print.html");
  const reviewPdfPath = path.join(exportDir, "book-review.pdf");
  const epubPath = path.join(exportDir, "book.epub");

  await writeFile(printHtmlPath, buildPictureBookHtml(project), "utf8");
  try {
    await renderHtmlToPdf(printHtmlPath, reviewPdfPath);
  } catch (error) {
    await writeFile(reviewPdfPath, buildTextOnlyReviewPdf(project));
    project.exports = {
      ...project.exports,
      exportWarnings: [`Picture PDF render failed: ${error.message}. Wrote text-only fallback PDF.`],
    };
  }
  await writeFile(epubPath, await buildPictureBookEpub(project, projectDir));

  delete project.exports?.hyperframesHtml;
  project.exports = {
    ...project.exports,
    printHtml: "dist/export/book-print.html",
    reviewPdf: "dist/export/book-review.pdf",
    epub: "dist/export/book.epub",
    exportedAt: new Date().toISOString(),
  };

  return {
    printHtmlPath,
    reviewPdfPath,
    epubPath,
  };
}

function buildPictureBookHtml(project) {
  const spreads = allSpreads(project);
  const coverImage = spreads.find(({ spread }) => spread.image?.assetPath)?.spread.image.assetPath || "";
  return `<!doctype html>
<html lang="${escapeHtml(htmlLanguage(project.book?.language))}"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(project.book?.title)} - picture book export</title>
<style>
@page{size:11in 8.5in;margin:0}
*{box-sizing:border-box}
html,body{margin:0;background:#efe4d0;color:#20343a;font-family:Avenir Next,Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.book-page{width:11in;height:8.5in;page-break-after:always;break-after:page;position:relative;overflow:hidden;background:#fff8ed;display:grid;padding:.42in}
.cover-page{grid-template-columns:1fr;align-items:end;background:#233b42;color:#fff}
.cover-page::before{content:"";position:absolute;inset:0;background:${coverImage ? `url("../../${escapeCssUrl(coverImage)}") center/cover no-repeat` : "linear-gradient(135deg,#d99b2b,#c55349 58%,#2f7d79)"};filter:saturate(1.05);transform:scale(1.02)}
.cover-page::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(20,34,38,.82),rgba(20,34,38,.18) 62%,rgba(20,34,38,.05))}
.cover-copy{position:relative;z-index:1;width:min(6.4in,78%);padding:.28in 0 .1in}
.kicker{font-size:13pt;letter-spacing:.08em;text-transform:uppercase;font-weight:800;opacity:.82;margin:0 0 .18in}
h1{font-size:42pt;line-height:.98;margin:0 0 .18in;letter-spacing:0}
.premise{font-size:15pt;line-height:1.38;margin:0;max-width:5.6in}
.story-page{grid-template-rows:minmax(0,1fr) auto;gap:.22in}
.art-panel{min-height:0;margin:0;border:1px solid #d8c6aa;background:#f3e5ce;display:grid;place-items:center;overflow:hidden;box-shadow:0 .08in .24in rgba(62,47,29,.12)}
.art-panel img{width:100%;height:100%;object-fit:contain;display:block;background:#f3e5ce}
.missing-art{width:100%;height:100%;display:grid;place-items:center;color:#7d6d58;font-weight:800;font-size:18pt;background:repeating-linear-gradient(45deg,#f5ead8,#f5ead8 12px,#eadac0 12px,#eadac0 24px)}
.caption-panel{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.24in;align-items:end;border-top:2px solid #263b42;padding-top:.16in}
.caption{font-family:Georgia,"Times New Roman",serif;font-size:21pt;line-height:1.18;margin:0;color:#1f3135}
.caption-line{display:block}.caption-line[data-pending="true"]{color:#65777c;font-style:italic}.caption-lang{font-family:Avenir Next,Inter,ui-sans-serif,system-ui,sans-serif;font-size:.58em;text-transform:uppercase;letter-spacing:.04em;color:#65777c;margin-right:.38em}
.chapter{font-size:9.5pt;line-height:1.25;color:#65777c;margin:0 0 .08in;text-transform:uppercase;font-weight:800}
.page-number{font-size:10pt;color:#65777c;white-space:nowrap}
.end-page{place-items:center;text-align:center;background:#fff8ed}
.end-page h2{font-size:26pt;margin:0 0 .16in}
.end-page p{font-size:13pt;margin:0;color:#65777c}
@media screen{body{display:grid;gap:24px;padding:24px}.book-page{width:min(11in,calc(100vw - 48px));height:auto;aspect-ratio:11/8.5;box-shadow:0 18px 50px rgba(45,38,28,.16);margin:auto}}
@media screen and (max-width:720px){body{padding:12px}.book-page{width:calc(100vw - 24px);padding:.22in}.cover-copy{width:88%}h1{font-size:24pt}.premise{font-size:9.5pt}.kicker{font-size:8pt}.caption{font-size:12pt}.chapter,.page-number{font-size:7pt}.caption-panel{gap:.12in;padding-top:.08in}}
</style></head><body>
<section class="book-page cover-page"><div class="cover-copy"><p class="kicker">BookFrames Picture Book</p><h1>${escapeHtml(project.book?.title || "Untitled")}</h1><p class="premise">${escapeHtml(project.storyArc?.premise || "A generated picture-book edition.")}</p></div></section>
${spreads.map(({ chapter, spread }, index) => {
  const image = spread.image?.assetPath;
  return `<section class="book-page story-page">
  <figure class="art-panel">${image ? `<img src="../../${escapeHtml(image)}" alt="${escapeHtml(spread.readerCaption || spread.caption || spread.id)}" />` : `<div class="missing-art">Image pending</div>`}</figure>
  <div class="caption-panel">
    <div><p class="chapter">${escapeHtml(chapter.title || "")}</p><p class="caption">${renderCaptionLines(spread)}</p></div>
    <div class="page-number">${index + 1}</div>
  </div>
</section>`;
}).join("")}
<section class="book-page end-page"><div><h2>The End</h2><p>${escapeHtml(project.book?.title || "BookFrames")}</p></div></section>
</body></html>`;
}

async function renderHtmlToPdf(htmlPath, pdfPath) {
  const chromePath = await findChromePath();
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--allow-file-access-from-files",
    "--no-pdf-header-footer",
    `--print-to-pdf=${pdfPath}`,
    pathToFileURL(htmlPath).href,
  ];
  await new Promise((resolve, reject) => {
    const child = spawn(chromePath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Chrome exited with ${code}: ${stderr.trim().slice(0, 600)}`));
    });
  });
  const info = await stat(pdfPath).catch(() => null);
  if (!info?.isFile() || info.size < 1024) throw new Error("PDF was not created");
}

async function findChromePath() {
  const candidates = [
    process.env.BOOKFRAMES_CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await stat(candidate).then((info) => info.isFile()).catch(() => false)) return candidate;
  }
  throw new Error("Chrome/Chromium was not found");
}

function buildTextOnlyReviewPdf(project) {
  const lines = [
    project.book?.title || "BookFrames Review",
    "",
    ...(allSpreads(project).flatMap(({ chapter, spread }, index) => [
      `${index + 1}. ${chapter.title}`,
      spread.readerCaption || spread.caption || "",
      spread.sourceExcerpt ? `Source: ${spread.sourceExcerpt}` : "",
      "",
    ])),
  ];
  const pages = chunkLines(lines.map((line) => asciiPdfText(line)), 34);
  const objects = [];
  objects.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i} 0 R`).join(" ")}] /Count ${pages.length} >>\nendobj\n`);
  const fontId = 3 + pages.length;
  pages.forEach((pageLines, pageIndex) => {
    const pageId = 3 + pageIndex;
    const contentId = fontId + 1 + pageIndex;
    objects.push(`${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`);
  });
  objects.push(`${fontId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
  pages.forEach((pageLines, pageIndex) => {
    const content = ["BT /F1 12 Tf 54 740 Td", ...pageLines.flatMap((line, i) => [
      i === 0 ? "" : "0 -20 Td",
      `(${escapePdfString(line)}) Tj`,
    ]), "ET"].filter(Boolean).join(" ");
    objects.push(`${fontId + 1 + pageIndex} 0 obj\n<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream\nendobj\n`);
  });
  return writePdfObjects(objects);
}

async function buildPictureBookEpub(project, projectDir) {
  const title = project.book?.title || "BookFrames";
  const spreads = allSpreads(project);
  const imageManifest = [];
  const imageEntries = [];
  const sections = [];
  for (const { chapter, spread } of spreads) {
    const imageRef = await epubImageEntry(spread, projectDir, imageEntries, imageManifest);
    sections.push(`<section class="page">${imageRef ? `<figure><img src="${escapeXml(imageRef.href)}" alt="${escapeXml(spread.readerCaption || spread.caption || spread.id)}"/></figure>` : ""}<p class="chapter">${escapeXml(chapter.title || "")}</p><p class="caption">${renderEpubCaptionLines(spread)}</p></section>`);
  }
  return zipStore([
    { name: "mimetype", data: "application/epub+zip" },
    { name: "META-INF/container.xml", data: `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>` },
    { name: "OEBPS/content.opf", data: `<?xml version="1.0" encoding="utf-8"?><package version="3.0" unique-identifier="bookid" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">bookframes-${Date.now()}</dc:identifier><dc:title>${escapeXml(title)}</dc:title><dc:language>${escapeXml(project.book?.language || "en")}</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="book" href="book.xhtml" media-type="application/xhtml+xml"/><item id="style" href="style.css" media-type="text/css"/>${imageManifest.map((item) => `<item id="${item.id}" href="${escapeXml(item.href)}" media-type="${item.mediaType}"/>`).join("")}</manifest><spine><itemref idref="book"/></spine></package>` },
    { name: "OEBPS/nav.xhtml", data: `<!doctype html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${escapeXml(title)}</title></head><body><nav epub:type="toc"><ol><li><a href="book.xhtml">${escapeXml(title)}</a></li></ol></nav></body></html>` },
    { name: "OEBPS/style.css", data: `body{margin:0;background:#fff8ed;color:#20343a;font-family:serif}.cover,.page{page-break-after:always;padding:1rem}.cover h1{font-size:2.2rem}.page img{display:block;width:100%;height:auto;margin:0 0 .8rem}.chapter{font:.72rem sans-serif;text-transform:uppercase;color:#65777c}.caption{font-size:1.35rem;line-height:1.25}` },
    { name: "OEBPS/book.xhtml", data: `<!doctype html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${escapeXml(title)}</title><link rel="stylesheet" href="style.css" type="text/css"/></head><body><section class="cover"><h1>${escapeXml(title)}</h1><p>${escapeXml(project.storyArc?.premise || "A generated picture-book edition.")}</p></section>${sections.join("")}</body></html>` },
    ...imageEntries,
  ]);
}

async function epubImageEntry(spread, projectDir, entries, manifest) {
  const assetPath = spread.image?.assetPath;
  if (!assetPath) return null;
  const source = path.join(projectDir, assetPath);
  const data = await readFile(source).catch(() => null);
  if (!data) return null;
  const ext = imageExtension(assetPath);
  const id = `image_${manifest.length + 1}`;
  const href = `images/${safeName(spread.id || id)}${ext}`;
  entries.push({ name: `OEBPS/${href}`, data });
  manifest.push({ id, href, mediaType: imageMediaType(ext) });
  return { id, href };
}

function renderCaptionLines(spread) {
  const fallback = spread.readerCaption || spread.caption || "";
  return captionLines(spread, fallback).map((line) => {
    const text = line.text || (line.needsTranslation ? "Translation pending" : fallback);
    return `<span class="caption-line" data-lang="${escapeHtml(line.language || "")}" data-pending="${line.text ? "false" : "true"}">${line.label ? `<span class="caption-lang">${escapeHtml(line.label)}</span>` : ""}${escapeHtml(text)}</span>`;
  }).join("");
}

function renderEpubCaptionLines(spread) {
  const fallback = spread.readerCaption || spread.caption || "";
  return captionLines(spread, fallback).map((line) => {
    const text = line.text || (line.needsTranslation ? "Translation pending" : fallback);
    const label = line.label ? `<span class="caption-lang">${escapeXml(line.label)}</span>` : "";
    return `<span class="caption-line">${label}${escapeXml(text)}</span>`;
  }).join("");
}

function captionLines(spread, fallback) {
  return Array.isArray(spread.captionI18n?.lines) && spread.captionI18n.lines.length
    ? spread.captionI18n.lines
    : [{ language: "", label: "", text: fallback, needsTranslation: false }];
}

function htmlLanguage(code) {
  if (code === "zh") return "zh-CN";
  if (code === "ja") return "ja-JP";
  return "en";
}

function allSpreads(project) {
  return (project.chapters || []).flatMap((chapter) => (chapter.spreads || []).map((spread) => ({ chapter, spread })));
}

function imageExtension(assetPath) {
  const ext = path.extname(assetPath || "").toLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp"].includes(ext) ? ext : ".png";
}

function imageMediaType(ext) {
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function safeName(value) {
  return String(value || "image").toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "image";
}

function chunkLines(lines, size) {
  const chunks = [];
  for (let i = 0; i < lines.length; i += size) chunks.push(lines.slice(i, i + size));
  return chunks.length ? chunks : [["BookFrames Review"]];
}

function writePdfObjects(objectStrings) {
  const header = Buffer.from("%PDF-1.4\n", "latin1");
  const objects = objectStrings.map((part) => Buffer.from(part, "latin1"));
  const offsets = [];
  let position = header.length;
  const body = Buffer.concat(objects.map((object) => {
    offsets.push(position);
    position += object.length;
    return object;
  }));
  const xrefPosition = position;
  const xref = Buffer.from([
    "xref", `0 ${objects.length + 1}`, "0000000000 65535 f ",
    ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    "trailer", `<< /Size ${objects.length + 1} /Root 1 0 R >>`, "startxref", String(xrefPosition), "%%EOF", "",
  ].join("\n"), "latin1");
  return Buffer.concat([header, body, xref]);
}

function zipStore(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function asciiPdfText(value) {
  return String(value || "").normalize("NFKD").replace(/[^\x20-\x7e]/g, "?").slice(0, 92);
}

function escapePdfString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeCssUrl(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\)/g, "\\)");
}

function escapeXml(value) {
  return escapeHtml(value).replace(/'/g, "&apos;");
}
