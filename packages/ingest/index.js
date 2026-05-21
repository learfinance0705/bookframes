import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHAPTER_HEADING =
  /^(?:#{1,3}\s+.+|chapter\s+\d+[\s:.-].*|chapter\s+[ivxlcdm]+[\s:.-].*|第[一二三四五六七八九十百千万零〇○两俩壹贰叁肆伍陆柒捌玖拾佰仟0-9叫下卡]+[章节回].*|卷[一二三四五六七八九十百千万零〇○两俩壹贰叁肆伍陆柒捌玖拾佰仟0-9]+.*)$/iu;
const CONTENTS_HEADING = /^(?:contents|table of contents|目录|目錄)\s*[:：]?$/iu;
const EPUB_BACK_MATTER_HEADING =
  /^(?:about\s+the\s+author|acknowledg(?:e)?ments?|bibliography|index|notes|other\s+books|the\s+dale\s+carnegie\s+courses?|版权页|版權頁|参考文献|參考文獻|延伸阅读|延伸閱讀)$/iu;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PDF_TOOLS_PATH = path.join(MODULE_DIR, "pdf_tools.py");
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown"]);
const EPUB_TEXT_EXTENSIONS = new Set([".xhtml", ".html", ".htm", ".xml"]);
const MINERU_ENGINE_BACKENDS = {
  "mineru-pipeline": "pipeline",
  "mineru-vlm": "vlm-auto-engine",
  "mineru-hybrid": "hybrid-auto-engine",
};

export async function ingestBook(sourcePath, options = {}) {
  const ext = path.extname(sourcePath).toLowerCase();
  let extracted;

  if (TEXT_EXTENSIONS.has(ext)) {
    extracted = await extractTextFile(sourcePath);
  } else if (ext === ".epub") {
    extracted = await extractEpubFile(sourcePath);
  } else if (ext === ".pdf") {
    extracted = await extractPdfFile(sourcePath, options);
  } else {
    throw new Error(
      `BookFrames ingest supports .txt, .md, .epub, and .pdf. Add an extractor for ${ext || "unknown"} in packages/ingest.`,
    );
  }

  const text = normalizeText(extracted.text);
  if (!text) {
    throw new Error(`No readable text was extracted from ${sourcePath}`);
  }

  const loadedChapterMap = await loadChapterMap(options.chapterMap || options.chapterMapPath);
  const extractedChapterMap = extracted.source?.chapterMap || null;
  const chapterMap = loadedChapterMap
    || extractedChapterMap
    || null;
  const chapters = splitIntoChapters(text, { ...options, chapterMap });
  if (
    !loadedChapterMap
    && extractedChapterMap?.method === "epub-section"
    && chapters.length
    && chapters[0].splitMethod !== "chapter_map"
  ) {
    extracted.source.warnings = extracted.source.warnings || [];
    extracted.source.warnings.push("EPUB spine sections were too coarse for picture-book planning; split by internal chapter headings instead.");
  }
  extracted.source.chapterMap = buildChapterMapReport(chapters, chapterMap);
  const importQuality = scoreImportQuality({ text, source: extracted.source, chapters });
  extracted.source.importQuality = importQuality;

  return {
    sourcePath,
    source: extracted.source,
    text,
    chapters,
    stats: {
      charCount: text.length,
      paragraphCount: text.split(/\n{2,}/).filter(Boolean).length,
      chapterCount: chapters.length,
      sourceFormat: extracted.source.format,
      extractionMethod: extracted.source.extractionMethod,
      extractionStatus: extracted.source.status,
      pageCount: extracted.source.pageCount || null,
      ocrStatus: extracted.source.ocr?.status || "not_used",
      ocrEngine: extracted.source.ocr?.engine || null,
      importQualityScore: importQuality.score,
      importQualityLevel: importQuality.level,
      chapterSplitMethod: extracted.source.chapterMap?.method || chapters[0]?.splitMethod || "unknown",
      warnings: extracted.source.warnings || [],
    },
  };
}

async function extractTextFile(sourcePath) {
  const rawText = await readFile(sourcePath, "utf8");
  return {
    text: rawText,
    source: {
      format: path.extname(sourcePath).toLowerCase().slice(1) || "text",
      extractionMethod: "utf8",
      status: "ok",
      warnings: [],
      ocr: {
        status: "not_used",
      },
    },
  };
}

async function extractEpubFile(sourcePath) {
  const archive = await readZipEntries(sourcePath);
  const contentFiles = archive
    .filter((entry) => EPUB_TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .filter((entry) => !/^(META-INF|mimetype\b)/i.test(entry.name))
    .sort((a, b) => epubReadingOrderScore(a.name) - epubReadingOrderScore(b.name) || a.name.localeCompare(b.name));
  if (!contentFiles.length) {
    throw new Error("EPUB did not contain readable XHTML/HTML content files.");
  }

  const sections = [];
  const warnings = [];
  for (const entry of contentFiles) {
    const html = entry.data.toString("utf8");
    const title = extractHtmlTitle(html) || path.basename(entry.name, path.extname(entry.name));
    let text = htmlToText(html);
    while (title && text.toLowerCase().startsWith(title.toLowerCase())) {
      text = text.slice(title.length).trim();
    }
    if (text.length < 20) continue;
    sections.push({
      file: entry.name,
      title,
      text,
      charCount: text.length,
    });
  }
  if (!sections.length) {
    throw new Error("EPUB content files were found, but no readable text was extracted.");
  }
  if (!archive.some((entry) => /content\.opf$/i.test(entry.name))) {
    warnings.push("EPUB package file content.opf was not found; reading order is inferred from XHTML filenames.");
  }

  const storySections = selectEpubStorySections(sections);
  if (storySections.length < sections.length) {
    warnings.push(`Skipped ${sections.length - storySections.length} EPUB front/back matter section(s) for picture-book planning.`);
  }
  const story = buildEpubStoryText(storySections);
  warnings.push(...story.warnings);

  return {
    text: story.text,
    source: {
      format: "epub",
      extractionMethod: "epub-xhtml",
      status: "ok",
      spineItemCount: sections.length,
      storySectionCount: storySections.length,
      warnings,
      ocr: {
        status: "not_used",
      },
      chapterMap: story.chapterMap,
      pageAudit: {
        format: "epub",
        pages: sections.map((section, index) => ({
          page: index + 1,
          file: section.file,
          title: section.title,
          charCount: section.charCount,
          status: storySections.includes(section) ? "ok" : "skipped_front_or_back_matter",
        })),
      },
    },
  };
}

function selectEpubStorySections(sections) {
  const storySections = sections.filter((section) => !isEpubNonStorySection(section));
  const storyChars = storySections.reduce((sum, section) => sum + section.charCount, 0);
  const totalChars = sections.reduce((sum, section) => sum + section.charCount, 0);
  if (storySections.length >= 2 && storyChars >= Math.min(5000, totalChars * 0.35)) {
    return storySections;
  }
  return sections;
}

function isEpubNonStorySection(section) {
  const title = String(section.title || "").trim().toLowerCase();
  const file = String(section.file || "").trim().toLowerCase();
  if (/copyright|cover|titlepage|toc|nav/.test(file)) return true;
  return /^(?:致謝|致谢|鳴謝|鸣谢|參考書目|参考书目|參考文獻|参考文献|延伸閱讀|延伸阅读|聆賞推薦|聆赏推荐|版權頁|版权页|目錄|目录)/iu.test(title)
    || /國內.*好評|媒體.*好評|專業盛讚|专业盛赞/iu.test(title);
}

function buildEpubStoryText(sections) {
  const lines = [];
  const chapters = [];
  const warnings = [];
  for (const [index, section] of sections.entries()) {
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
    const startLine = lines.length + 1;
    lines.push(section.title || `Section ${index + 1}`);
    lines.push("");
    const bodyLines = String(section.text || "").split("\n");
    lines.push(...bodyLines);
    const endLine = lines.length;
    chapters.push({
      title: section.title || `Section ${index + 1}`,
      startLine,
      endLine,
      sourceFile: section.file,
      charCount: section.charCount,
    });
  }
  const trimmed = trimInlineEpubMatter(lines);
  if (trimmed.frontLineCount) {
    warnings.push(`Trimmed ${trimmed.frontLineCount} inline EPUB front-matter line(s) before the first story heading.`);
  }
  if (trimmed.backLineCount) {
    warnings.push(`Trimmed ${trimmed.backLineCount} inline EPUB back-matter line(s) after the final story section.`);
  }

  return {
    text: trimmed.lines.join("\n"),
    warnings,
    chapterMap: {
      method: "epub-section",
      confidence: 0.88,
      editable: true,
      inlineTrim: {
        frontLineCount: trimmed.frontLineCount,
        backLineCount: trimmed.backLineCount,
      },
      chapters,
    },
  };
}

function trimInlineEpubMatter(lines) {
  let start = 0;
  let end = lines.length;
  const storyStart = findInlineEpubStoryStart(lines);
  if (storyStart > 20) start = storyStart;

  const backMatterStart = findInlineEpubBackMatterStart(lines, start);
  if (backMatterStart > start) end = backMatterStart;

  return {
    lines: lines.slice(start, end),
    frontLineCount: start,
    backLineCount: lines.length - end,
  };
}

function findInlineEpubStoryStart(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.length > 92) continue;
    if (isEnglishPartHeading(line)) return index;
    if (CHAPTER_HEADING.test(line)) return index;
    if (isNumberedChapterMarker(lines, index)) return index;
  }
  return 0;
}

function findInlineEpubBackMatterStart(lines, startIndex) {
  const earliest = Math.max(startIndex + 80, Math.floor(lines.length * 0.55));
  for (let index = earliest; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.length > 92) continue;
    if (EPUB_BACK_MATTER_HEADING.test(line)) return index;
  }
  return lines.length;
}

async function readZipEntries(filePath) {
  const buffer = await readFile(filePath);
  const entries = [];
  const centralOffset = findZipCentralDirectoryOffset(buffer);
  let offset = centralOffset;
  while (offset + 46 <= buffer.length && buffer.readUInt32LE(offset) === 0x02014b50) {
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) continue;
    const compressed = buffer.subarray(dataStart, dataEnd);
    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = inflateRawSync(compressed);
    else continue;
    if (!uncompressedSize || data.length === uncompressedSize) entries.push({ name, data });
  }
  return entries;
}

function findZipCentralDirectoryOffset(buffer) {
  const minOffset = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return buffer.readUInt32LE(offset + 16);
    }
  }
  throw new Error("Invalid EPUB/ZIP: central directory not found.");
}

function epubReadingOrderScore(name) {
  const lower = name.toLowerCase();
  if (/nav|toc|cover|titlepage|copyright/.test(lower)) return 10_000;
  const number = lower.match(/(?:chapter|ch|section|part|page|p)?[-_ .]*(\d{1,4})/i)?.[1];
  return number ? Number(number) : 5_000;
}

function extractHtmlTitle(html) {
  const heading = String(html || "").match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1]
    || String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return heading ? decodeHtmlEntities(stripTags(heading)).trim().slice(0, 120) : "";
}

function htmlToText(html) {
  return normalizeText(decodeHtmlEntities(
    stripTags(String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<\s*(h[1-6]|p|div|section|article|li|br)\b[^>]*>/gi, "\n")
      .replace(/<\s*\/\s*(h[1-6]|p|div|section|article|li)\s*>/gi, "\n")),
  ));
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ");
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'");
}

async function extractPdfFile(sourcePath, options = {}) {
  const ocrMode = normalizeOcrMode(options.ocrMode ?? options.ocr ?? "auto");
  const pdfEngine = normalizePdfEngine(options.pdfEngine || "auto");
  const minTextChars = toPositiveInteger(options.minTextChars, 120);
  const maxPages = toPositiveInteger(options.ocrMaxPages, null);
  const language = String(options.ocrLang || options.language || "").trim();
  const ocrRecognition = normalizeOcrRecognition(options.ocrRecognition || options.recognition || defaultOcrRecognitionForLanguage(language));
  const ocrScale = toPositiveNumber(options.ocrScale, ocrRecognition === "fast" ? 1.25 : 1.5);
  const attempts = [];
  const warnings = [];

  if (pdfEngine !== "auto" && pdfEngine !== "native") {
    return extractPdfWithMineru(sourcePath, {
      ...options,
      pdfEngine,
      ocrMode,
      language,
    });
  }

  let native = null;
  try {
    notifyIngestProgress(options, {
      event: "pdf-native-start",
      stage: "extracting native PDF text",
      progressHint: 6,
      engine: "pypdf",
    });
    native = await runPdfTool(["extract-text", sourcePath], { timeoutMs: 120000 });
    attempts.push({
      method: native.engine || "pypdf",
      status: "ok",
      charCount: normalizeText(native.text).length,
      pageCount: native.pageCount || null,
    });
    notifyIngestProgress(options, {
      event: "pdf-native-complete",
      stage: "native PDF text extracted",
      progressHint: 8,
      engine: native.engine || "pypdf",
      pageCount: native.pageCount || null,
      pagesWithText: native.pagesWithText || null,
      charCount: normalizeText(native.text).length,
    });
  } catch (error) {
    attempts.push({ method: "pypdf", status: "failed", error: error.message });
    warnings.push(`PDF native text extraction failed: ${error.message}`);
  }

  if (!native?.text) {
    const spotlight = await extractPdfTextWithSpotlight(sourcePath);
    if (spotlight.text) {
      native = spotlight;
      attempts.push({
        method: spotlight.engine,
        status: "ok",
        charCount: normalizeText(spotlight.text).length,
        pageCount: spotlight.pageCount || null,
      });
    } else if (spotlight.error) {
      attempts.push({ method: "mdls", status: "failed", error: spotlight.error });
    }
  }

  const nativeText = normalizeText(native?.text || "");
  const expectedLanguage = String(options.expectedLanguage || options.languageProfile || options.language || language || "").trim();
  const nativeTextQuality = analyzeTextQuality(nativeText, { expectedLanguage });
  const weakNativeText = isWeakPdfText(nativeText, native, minTextChars, { expectedLanguage });
  if (nativeTextQuality.garbledLikely) {
    warnings.push("Native PDF text layer looks garbled; forcing OCR instead of using embedded text.");
  }
  const autoMineru = selectAutoMineruEngine({
    native,
    nativeText,
    weakNativeText,
    ocrMode,
    options,
  });
  if (pdfEngine === "auto" && autoMineru && await isMineruAvailable(options)) {
    try {
      notifyIngestProgress(options, {
        event: "mineru-start",
        stage: `running MinerU ${autoMineru.engine}`,
        progressHint: 9,
        engine: autoMineru.engine,
        reason: autoMineru.reason,
      });
      const mineruResult = await extractPdfWithMineru(sourcePath, {
        ...options,
        pdfEngine: autoMineru.engine,
        ocrMode,
        language,
      });
      mineruResult.source.attempts = [
        ...attempts,
        ...(mineruResult.source.attempts || []),
      ];
      mineruResult.source.routing = {
        mode: "auto",
        selectedEngine: autoMineru.engine,
        selectedBackend: mineruResult.source.mineru?.backend || null,
        reason: autoMineru.reason,
        native: summarizeNativePdfSignal(native, nativeText, nativeTextQuality),
      };
      return mineruResult;
    } catch (error) {
      attempts.push({ method: autoMineru.engine, status: "failed", error: error.message });
      warnings.push(`Auto MinerU route failed; falling back to macOS/native OCR: ${error.message}`);
    }
  }

  const shouldOcr = ocrMode === "always" || (ocrMode === "auto" && weakNativeText);
  let selectedText = nativeText;
  let selectedMethod = native?.engine || "pdf-native";
  let status = nativeText ? "ok" : "needs_ocr";
  let ocr = { status: "not_used" };
  let selectedPages = native?.pages || [];

  if (ocrMode === "never" && weakNativeText) {
    warnings.push("PDF text looks sparse; OCR is disabled by --ocr never.");
  }
  if (pdfEngine === "auto" && weakNativeText && !autoMineru && ocrMode !== "never") {
    warnings.push("Auto PDF route used the faster native/macOS OCR path. Choose MinerU hybrid/VLM explicitly when layout-level extraction is worth the wait.");
  }

  if (shouldOcr) {
    try {
      notifyIngestProgress(options, {
        event: "ocr-start",
        stage: "running macOS Vision OCR",
        progressHint: 9,
        engine: "macos-vision",
        pageCount: native?.pageCount || null,
        recognition: ocrRecognition,
        scale: ocrScale,
      });
      const ocrResult = await runPdfTool([
        "ocr",
        sourcePath,
        ...(language ? ["--language", language] : []),
        ...(maxPages ? ["--max-pages", String(maxPages)] : []),
        "--recognition", ocrRecognition,
        "--scale", String(ocrScale),
        ...(typeof options.onProgress === "function" ? ["--progress-json"] : []),
      ], {
        timeoutMs: 900000,
        onProgress: (event) => notifyIngestProgress(options, {
          ...event,
          stage: "running macOS Vision OCR",
          progressHint: progressHintFromOcrEvent(event),
        }),
      });
      const ocrText = normalizeText(ocrResult.text || "");
      ocr = {
        status: ocrText ? "ok" : "empty",
        engine: ocrResult.engine || "macos-vision",
        language: ocrResult.language || language || "auto",
        pageCount: ocrResult.pageCount || null,
        processedPages: ocrResult.processedPages || null,
        recognition: ocrResult.recognition || ocrRecognition,
        scale: ocrResult.scale || ocrScale,
      };
      attempts.push({
        method: ocr.engine,
        status: ocr.status,
        charCount: ocrText.length,
        pageCount: ocr.pageCount,
        processedPages: ocr.processedPages,
        recognition: ocr.recognition,
        scale: ocr.scale,
      });
      notifyIngestProgress(options, {
        event: "ocr-complete",
        stage: "macOS Vision OCR complete",
        progressHint: 17,
        engine: ocr.engine,
        pageCount: ocr.pageCount,
        processedPages: ocr.processedPages,
        recognition: ocr.recognition,
        scale: ocr.scale,
      });

      if (ocrText && (ocrMode === "always" || ocrText.length >= nativeText.length || weakNativeText)) {
        selectedText = ocrText;
        selectedMethod = ocr.engine;
        status = "ok";
        selectedPages = ocrResult.pages || [];
      } else if (!ocrText && nativeText) {
        warnings.push("OCR produced no text; using native PDF text instead.");
      }
    } catch (error) {
      ocr = {
        status: "failed",
        engine: "macos-vision",
        language: language || "auto",
        error: error.message,
      };
      attempts.push({ method: "macos-vision", status: "failed", error: error.message });
      if (!nativeText) {
        throw new Error(
          `PDF appears to need OCR, but OCR failed: ${error.message}. On macOS, ensure Vision/Quartz are available; otherwise install a PDF OCR path and retry.`,
        );
      }
      warnings.push(`OCR failed; using native PDF text instead: ${error.message}`);
    }
  }

  if (!selectedText) {
    throw new Error("PDF text extraction returned no text. Retry with --ocr always or use a searchable PDF.");
  }

  const pageAudit = buildPdfToolPageAudit({
    pageCount: native?.pageCount || ocr.pageCount || null,
    pages: selectedPages,
    selectedText,
    engine: selectedMethod,
    warnings,
  });

  return {
    text: selectedText,
    source: {
      format: "pdf",
      extractionMethod: selectedMethod,
      status,
      pageCount: native?.pageCount || ocr.pageCount || null,
      pagesWithText: native?.pagesWithText || null,
      averageCharsPerPage: native?.pageCount ? Math.round(nativeText.length / Math.max(1, native.pageCount)) : null,
      ocrMode,
      ocr,
      attempts,
      warnings,
      textQuality: analyzeTextQuality(selectedText, { expectedLanguage: expectedLanguage || ocr.language || language }),
      pageAudit,
      routing: {
        mode: pdfEngine,
        selectedEngine: selectedMethod,
        reason: pdfEngine === "native" ? "native_engine_requested" : "native_text_sufficient_or_mineru_unavailable",
        native: summarizeNativePdfSignal(native, nativeText, nativeTextQuality),
      },
    },
  };
}

export function normalizeText(rawText) {
  return stripGutenbergBoilerplate(String(rawText || ""))
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function stripGutenbergBoilerplate(rawText) {
  let text = String(rawText || "").replace(/^\uFEFF/, "");
  const startMatch = text.match(/\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i);
  if (startMatch?.index !== undefined) {
    text = text.slice(startMatch.index + startMatch[0].length);
  }
  const endMatch = text.match(/\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i);
  if (endMatch?.index !== undefined) {
    text = text.slice(0, endMatch.index);
  }
  return text;
}

export function splitIntoChapters(text, { fallbackChars = 4200, chapterMap } = {}) {
  const lines = text.split("\n");
  const mapped = chaptersFromExplicitMap(text, chapterMap);
  if (mapped.length > 0) return mapped;

  const headings = findChapterHeadings(lines);

  if (headings.length >= 2) {
    return repairSequentialChineseChapterTitles(headings.map((heading, headingIndex) => {
      const next = headings[headingIndex + 1]?.index ?? lines.length;
      const bodyStart = heading.bodyStartIndex ?? heading.index + 1;
      const body = lines.slice(bodyStart, next).join("\n").trim();
      return chapterRecord({
        title: cleanHeading(heading.line),
        body,
        index: headingIndex,
        anchorLine: heading.index + 1,
        splitMethod: "heading",
        splitConfidence: 0.92,
      });
    }));
  }

  const semantic = splitBySemanticBeats(text, fallbackChars);
  const paragraphs = semantic.length > 1
    ? semantic
    : text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks = [];
  let current = [];
  let length = 0;

  for (const paragraph of paragraphs) {
    if (current.length > 0 && length + paragraph.length > fallbackChars) {
      chunks.push(current.join("\n\n"));
      current = [];
      length = 0;
    }
    current.push(paragraph);
    length += paragraph.length;
  }
  if (current.length > 0) chunks.push(current.join("\n\n"));

  return chunks.map((body, index) => chapterRecord({
    title: `Chapter ${index + 1}`,
    body,
    index,
    anchorLine: findLineNumber(lines, body),
    splitMethod: semantic.length > 1 ? "semantic_fallback" : "length_fallback",
    splitConfidence: semantic.length > 1 ? 0.62 : 0.42,
  }));
}

function chapterRecord({ title, body, index, anchorLine, splitMethod = "unknown", splitConfidence = 0.5 }) {
  return {
    id: `ch-${String(index + 1).padStart(2, "0")}`,
    title,
    text: body,
    sourceAnchors: [`text:line:${anchorLine}`],
    splitMethod,
    splitConfidence,
    stats: {
      charCount: body.length,
      paragraphCount: body.split(/\n{2,}/).filter(Boolean).length,
    },
  };
}

function repairSequentialChineseChapterTitles(chapters) {
  const chapterish = chapters.filter((chapter) => /^第.{1,6}章/.test(chapter.title || ""));
  if (chapterish.length < 4 || chapterish.length / Math.max(1, chapters.length) < 0.7) return chapters;
  return chapters.map((chapter, index) => {
    const title = String(chapter.title || "");
    if (!/^第.{1,6}章/.test(title)) return chapter;
    const expectedPrefix = `第${toChineseOrdinal(index + 1)}章`;
    const rest = title.replace(/^第.{1,6}章/u, "").trim();
    const parsed = parseChineseChapterOrdinal(title);
    const shouldRepair = parsed == null || parsed !== index + 1 || hasLikelyOcrOrdinalNoise(title);
    if (!shouldRepair) return chapter;
    return {
      ...chapter,
      title: rest ? `${expectedPrefix} ${rest}` : expectedPrefix,
    };
  });
}

function hasLikelyOcrOrdinalNoise(title) {
  return /第[叫下卡万]/u.test(title || "");
}

function parseChineseChapterOrdinal(title) {
  const match = String(title || "").match(/^第(.{1,6})章/u);
  if (!match) return null;
  const raw = match[1].replace(/[零〇○]/g, "零");
  if (/^\d+$/.test(raw)) return Number(raw);
  const normalized = raw
    .replace(/[壹一]/g, "一")
    .replace(/[贰貳二两俩]/g, "二")
    .replace(/[叁參三]/g, "三")
    .replace(/[肆四]/g, "四")
    .replace(/[伍五]/g, "五")
    .replace(/[陆陸六]/g, "六")
    .replace(/[柒七]/g, "七")
    .replace(/[捌八]/g, "八")
    .replace(/[玖九]/g, "九")
    .replace(/[拾十]/g, "十")
    .replace(/[佰百]/g, "百");
  const digits = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (normalized === "十") return 10;
  if (/^十[一二三四五六七八九]$/.test(normalized)) return 10 + digits[normalized[1]];
  if (/^[一二三四五六七八九]十$/.test(normalized)) return digits[normalized[0]] * 10;
  if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(normalized)) return digits[normalized[0]] * 10 + digits[normalized[2]];
  if (/^[一二三四五六七八九]$/.test(normalized)) return digits[normalized];
  return null;
}

function toChineseOrdinal(value) {
  const number = Number(value);
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (!Number.isInteger(number) || number <= 0) return String(value);
  if (number < 10) return digits[number];
  if (number === 10) return "十";
  if (number < 20) return `十${digits[number - 10]}`;
  if (number < 100) {
    const tens = Math.floor(number / 10);
    const ones = number % 10;
    return `${digits[tens]}十${ones ? digits[ones] : ""}`;
  }
  return String(value);
}

function cleanHeading(line) {
  const cleaned = repairCommonOcrHeadingText(line.replace(/^#{1,3}\s+/, "").trim());
  const numbered = cleaned.match(/^(\d{1,2})\s+(.+)$/u);
  if (numbered) return `Chapter ${numbered[1]}: ${numbered[2].trim()}`;
  return cleaned;
}

function repairCommonOcrHeadingText(value) {
  return String(value || "")
    .replace(/用米传达/g, "用来传达")
    .replace(/纽织/g, "组织")
    .replace(/介紹辞[.．·。]颁奖辞/g, "介绍辞、颁奖辞")
    .replace(/介绍辞[.．·。]颁奖辞/g, "介绍辞、颁奖辞")
    .replace(/淡话/g, "谈话")
    .replace(/活爽活现/g, "活灵活现")
    .trim();
}

function findChapterHeadings(lines) {
  const primaryHeadings = [];
  const sectionHeadings = [];
  let inContentsBlock = false;
  let contentsSawHeading = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (CONTENTS_HEADING.test(line)) {
      inContentsBlock = true;
      contentsSawHeading = false;
      continue;
    }
    if (inContentsBlock) {
      if (!line) {
        if (contentsSawHeading) inContentsBlock = false;
        continue;
      }
      if (isPotentialChapterHeading(lines, index, { allowSection: true }) || isLikelyTocLine(line)) {
        contentsSawHeading = true;
        continue;
      }
      if (contentsSawHeading) continue;
    }
    if (!line || line.length > 92) continue;
    if (isLikelyTocLine(line)) continue;
    const primary = detectChapterHeading(lines, index, { allowSection: false });
    if (primary) {
      primaryHeadings.push(primary);
      continue;
    }
    const section = detectChapterHeading(lines, index, { allowSection: true });
    if (section) sectionHeadings.push(section);
  }
  return primaryHeadings.length >= 2 ? primaryHeadings : sectionHeadings;
}

function isLikelyTocLine(line) {
  const value = String(line || "").trim();
  return /\.{3,}\s*\d+\s*$/.test(value)
    || /(?:^|\s)(page|页码)\s*\d+\s*$/iu.test(value)
    || /\/\s*(?:[ivxlcdm]+|\d{1,4})\s*$/iu.test(value);
}

function isPotentialChapterHeading(lines, index, { allowSection = false } = {}) {
  return Boolean(detectChapterHeading(lines, index, { allowSection }));
}

function detectChapterHeading(lines, index, { allowSection = false } = {}) {
  const line = lines[index].trim();
  if (CHAPTER_HEADING.test(line)) return expandChapterHeading(lines, index);
  if (isNumberedChapterMarker(lines, index)) return expandNumberedChapterHeading(lines, index);
  if (allowSection && isEnglishPartHeading(line)) return expandSectionHeading(lines, index);
  return null;
}

function expandChapterHeading(lines, index) {
  const line = lines[index].trim();
  if (!isBareChapterHeading(line)) return { line, index };

  let titleIndex = index + 1;
  while (titleIndex < lines.length && !lines[titleIndex].trim()) titleIndex += 1;
  const subtitle = lines[titleIndex]?.trim() || "";
  if (
    subtitle
    && subtitle.length <= 92
    && !CHAPTER_HEADING.test(subtitle)
    && !isLikelyTocLine(subtitle)
  ) {
    return {
      line: `${line} ${subtitle}`,
      index,
      bodyStartIndex: titleIndex + 1,
    };
  }
  return { line, index };
}

function expandNumberedChapterHeading(lines, index) {
  const line = lines[index].trim().replace(/\.$/, "");
  const title = collectFollowingTitleLines(lines, index + 1);
  if (!title) return null;
  return {
    line: `${line} ${title.text}`,
    index,
    bodyStartIndex: title.bodyStartIndex,
  };
}

function expandSectionHeading(lines, index) {
  const line = lines[index].trim();
  const title = collectFollowingTitleLines(lines, index + 1, { allowTitleCase: true, maxLines: 3 });
  return {
    line: title ? `${line} ${title.text}` : line,
    index,
    bodyStartIndex: title?.bodyStartIndex,
  };
}

function isNumberedChapterMarker(lines, index) {
  const line = lines[index]?.trim() || "";
  if (!/^\d{1,2}\.?$/.test(line)) return false;
  const title = collectFollowingTitleLines(lines, index + 1);
  return Boolean(title);
}

function collectFollowingTitleLines(lines, startIndex, { allowTitleCase = false, maxLines = 4 } = {}) {
  let cursor = startIndex;
  while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
  const titleLines = [];
  let blankGap = 0;
  while (cursor < lines.length && titleLines.length < maxLines) {
    const candidate = lines[cursor].trim();
    if (!candidate) {
      if (titleLines.length && blankGap < 2) {
        blankGap += 1;
        cursor += 1;
        continue;
      }
      break;
    }
    if (!isLikelyChapterTitleLine(candidate, { allowTitleCase })) break;
    titleLines.push(candidate);
    blankGap = 0;
    cursor += 1;
  }
  if (!titleLines.length) return null;
  while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
  return {
    text: titleLines.join(" ").replace(/\s+/g, " ").trim(),
    bodyStartIndex: cursor,
  };
}

function isLikelyChapterTitleLine(line, { allowTitleCase = false } = {}) {
  const value = String(line || "").trim();
  if (!value || value.length > 82) return false;
  if (/^(?:principle\s+\d+|\d{1,2}\.?|part\s+)/iu.test(value)) return false;
  const letters = value.match(/\p{Letter}/gu) || [];
  if (letters.length < 4) return false;
  const uppercase = letters.filter((char) => char === char.toUpperCase() && char !== char.toLowerCase()).length;
  if (uppercase / letters.length >= 0.62) return true;
  if (/[.!?。！？]\s*$/.test(value)) return false;
  return allowTitleCase && /^[\p{Lu}0-9"“‘'(-][\p{Letter}\p{Number}\s,'’“”":;-]+$/u.test(value);
}

function isEnglishPartHeading(line) {
  const value = String(line || "").replace(/\s+/g, " ").trim();
  if (!value) return false;
  if (/^part\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2}|[ivxlcdm]+)$/iu.test(value)) return true;
  return /^part\s+(?:[a-z]\s*){2,}$/iu.test(value);
}

function isBareChapterHeading(line) {
  return /^(?:chapter\s+(?:\d+|[ivxlcdm]+)\.?|第[一二三四五六七八九十百千万零〇○两俩壹贰叁肆伍陆柒捌玖拾佰仟0-9叫下卡]+[章节回]|卷[一二三四五六七八九十百千万零〇○两俩壹贰叁肆伍陆柒捌玖拾佰仟0-9]+)$/iu.test(line.trim());
}

function chaptersFromExplicitMap(text, chapterMap) {
  const entries = Array.isArray(chapterMap?.chapters) ? chapterMap.chapters : Array.isArray(chapterMap) ? chapterMap : [];
  if (!entries.length) return [];
  if (shouldIgnoreExplicitChapterMap(text, chapterMap, entries)) return [];
  const lines = text.split("\n");
  return entries.map((entry, index) => {
    const startLine = Math.max(1, Number(entry.startLine || entry.start || 1));
    const endLine = Math.min(lines.length, Number(entry.endLine || entry.end || lines.length));
    const body = lines.slice(startLine - 1, endLine).join("\n").trim();
    return chapterRecord({
      title: entry.title || `Chapter ${index + 1}`,
      body,
      index,
      anchorLine: startLine,
      splitMethod: "chapter_map",
      splitConfidence: 1,
    });
  }).filter((chapter) => chapter.text);
}

function shouldIgnoreExplicitChapterMap(text, chapterMap, entries) {
  const method = String(chapterMap?.method || "").toLowerCase();
  if (method !== "epub-section") return false;
  const entryCount = entries.length;
  if (!entryCount) return false;
  const averageChars = text.length / entryCount;
  if (entryCount <= 6 && averageChars > 12000) return true;
  const detectedHeadingCount = findChapterHeadings(text.split("\n")).length;
  return detectedHeadingCount >= Math.max(2, entryCount + 2) && averageChars > 6000;
}

function splitBySemanticBeats(text, fallbackChars) {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  if (paragraphs.length < 6) return [];
  const beats = [];
  let current = [];
  let length = 0;
  for (const paragraph of paragraphs) {
    const startsNewBeat = current.length > 0 && (
      /^(later|meanwhile|at night|the next|by morning|soon|then|finally|忽然|后来|夜里|第二天|清晨|最后)/iu.test(paragraph)
      || length > fallbackChars
    );
    if (startsNewBeat) {
      beats.push(current.join("\n\n"));
      current = [];
      length = 0;
    }
    current.push(paragraph);
    length += paragraph.length;
  }
  if (current.length) beats.push(current.join("\n\n"));
  return beats.length >= 2 ? beats : [];
}

function findLineNumber(lines, body) {
  const firstLine = body.split("\n").find((line) => line.trim())?.trim();
  if (!firstLine) return 1;
  const index = lines.findIndex((line) => line.trim() === firstLine);
  return index >= 0 ? index + 1 : 1;
}

async function loadChapterMap(chapterMap) {
  if (!chapterMap) return null;
  if (typeof chapterMap === "object") return chapterMap;
  const mapPath = path.resolve(String(chapterMap));
  return JSON.parse(await readFile(mapPath, "utf8"));
}

function buildChapterMapReport(chapters, explicitMap) {
  const usedExplicitMap = Boolean(explicitMap) && chapters.some((chapter) => chapter.splitMethod === "chapter_map");
  const method = usedExplicitMap
    ? "chapter_map"
    : chapters[0]?.splitMethod || "unknown";
  const confidences = chapters.map((chapter) => Number(chapter.splitConfidence || 0.5));
  const confidence = confidences.length
    ? Number((confidences.reduce((sum, value) => sum + value, 0) / confidences.length).toFixed(2))
    : 0;
  return {
    method,
    confidence,
    editable: true,
    count: chapters.length,
    chapters: chapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      sourceAnchors: chapter.sourceAnchors,
      charCount: chapter.stats?.charCount || 0,
      method: chapter.splitMethod || method,
      confidence: chapter.splitConfidence || confidence,
    })),
  };
}

function selectAutoMineruEngine({ native, nativeText, weakNativeText, ocrMode, options }) {
  if (ocrMode === "never") return null;
  if (parseBooleanFlag(options.disableMineruAutoRoute, false)) return null;
  const autoMineruEnabled = parseBooleanFlag(options.autoMineruRoute, false)
    || parseBooleanFlag(options.preferMineru, false)
    || parseBooleanFlag(process.env.BOOKFRAMES_AUTO_MINERU, false);
  if (!autoMineruEnabled) return null;
  if (!weakNativeText && !parseBooleanFlag(options.preferMineru, false)) return null;

  const pageCount = Number(native?.pageCount || 0);
  const pagesWithText = Number(native?.pagesWithText || 0);
  const averageCharsPerPage = pageCount ? nativeText.length / Math.max(1, pageCount) : 0;
  if (!nativeText) {
    return {
      engine: pageCount > 0 && pageCount <= 3 ? "mineru-vlm" : "mineru-hybrid",
      reason: "native_text_empty",
    };
  }
  if (pageCount >= 4 && pagesWithText / Math.max(1, pageCount) < 0.6) {
    return { engine: "mineru-hybrid", reason: "many_pages_without_native_text" };
  }
  if (averageCharsPerPage > 0 && averageCharsPerPage < 40) {
    return { engine: "mineru-hybrid", reason: "native_text_sparse" };
  }
  if (parseBooleanFlag(options.preferMineru, false)) {
    return { engine: "mineru-hybrid", reason: "prefer_mineru_requested" };
  }
  return null;
}

function summarizeNativePdfSignal(native, nativeText, textQuality = analyzeTextQuality(nativeText)) {
  const pageCount = native?.pageCount || null;
  return {
    engine: native?.engine || null,
    pageCount,
    pagesWithText: native?.pagesWithText || null,
    charCount: nativeText.length,
    averageCharsPerPage: pageCount ? Math.round(nativeText.length / Math.max(1, pageCount)) : null,
    textQuality,
  };
}

function buildPdfToolPageAudit({ pageCount, pages, selectedText, engine, warnings }) {
  const auditPages = Array.isArray(pages) && pages.length
    ? pages.map((page) => auditPageRecord({
      pageIndex: Number(page.page || 1) - 1,
      charCount: Number(page.charCount || 0),
      lineCount: Number(page.lineCount || 0),
      confidence: page.confidence ?? null,
      blockCount: Number(page.lineCount || 0),
      bboxCount: 0,
      textPreview: "",
      warnings: page.error ? [page.error] : [],
    }))
    : [{
      pageIndex: 0,
      pageNumber: 1,
      charCount: selectedText.length,
      lineCount: selectedText.split("\n").filter((line) => line.trim()).length,
      blockCount: 0,
      bboxCount: 0,
      confidence: null,
      textPreview: previewText(selectedText),
      warnings: [],
      status: selectedText ? "ok" : "empty",
    }];
  return summarizePageAudit({
    engine,
    pages: auditPages,
    warnings,
    hasBboxes: false,
    totalTextChars: selectedText.length,
    source: "pdf-tool",
    reviewHint: "Use MinerU VLM/hybrid for bbox-level layout review when page structure matters.",
    pageCountOverride: pageCount,
  });
}

function buildMineruPageAudit({ contentList, selectedText, backend, warnings }) {
  const groups = new Map();
  if (Array.isArray(contentList)) {
    for (const item of contentList) {
      const pageIndex = Number.isFinite(Number(item?.page_idx)) ? Number(item.page_idx) : 0;
      const group = groups.get(pageIndex) || {
        pageIndex,
        textParts: [],
        blockCount: 0,
        bboxCount: 0,
      };
      group.blockCount += 1;
      if (Array.isArray(item?.bbox) && item.bbox.length >= 4) group.bboxCount += 1;
      if (typeof item?.text === "string" && item.text.trim()) group.textParts.push(item.text.trim());
      groups.set(pageIndex, group);
    }
  }
  const pages = [...groups.values()]
    .sort((a, b) => a.pageIndex - b.pageIndex)
    .map((page) => {
      const text = page.textParts.join("\n");
      return auditPageRecord({
        pageIndex: page.pageIndex,
        charCount: text.length,
        lineCount: text.split("\n").filter(Boolean).length,
        confidence: null,
        blockCount: page.blockCount,
        bboxCount: page.bboxCount,
        textPreview: previewText(text),
        warnings: [],
      });
    });
  if (!pages.length && selectedText) {
    pages.push(auditPageRecord({
      pageIndex: 0,
      charCount: selectedText.length,
      lineCount: selectedText.split("\n").filter((line) => line.trim()).length,
      blockCount: 0,
      bboxCount: 0,
      textPreview: previewText(selectedText),
      warnings: ["MinerU content_list was missing or empty."],
    }));
  }
  return summarizePageAudit({
    engine: `mineru:${backend}`,
    pages,
    warnings,
    hasBboxes: true,
    totalTextChars: selectedText.length,
    source: "mineru",
    reviewHint: "Review low-text pages and bbox-light pages before sending prompts to image generation.",
  });
}

function auditPageRecord({ pageIndex, charCount, lineCount, confidence, blockCount, bboxCount, textPreview, warnings }) {
  const pageWarnings = [...warnings];
  if (charCount === 0) pageWarnings.push("empty_text");
  if (charCount > 0 && charCount < 24) pageWarnings.push("sparse_text");
  if (confidence !== null && confidence < 0.6) pageWarnings.push("low_ocr_confidence");
  if (blockCount > 0 && bboxCount === 0) pageWarnings.push("missing_bboxes");
  return {
    pageIndex,
    pageNumber: pageIndex + 1,
    charCount,
    lineCount,
    blockCount,
    bboxCount,
    confidence,
    textPreview,
    warnings: pageWarnings,
    status: pageWarnings.includes("empty_text") ? "empty" : pageWarnings.length ? "review" : "ok",
  };
}

function summarizePageAudit({ engine, pages, warnings, hasBboxes, totalTextChars, source, reviewHint, pageCountOverride }) {
  const pageCount = pageCountOverride || pages.length || null;
  const pagesWithText = pages.filter((page) => page.charCount > 0).length;
  const lowConfidencePages = pages.filter((page) => page.warnings.includes("low_ocr_confidence")).length;
  const weakPages = pages.filter((page) => page.status !== "ok").length;
  const totalBlocks = pages.reduce((sum, page) => sum + page.blockCount, 0);
  const totalBboxes = pages.reduce((sum, page) => sum + page.bboxCount, 0);
  return {
    source,
    engine,
    pageCount,
    pagesWithText,
    textCoverageRatio: pageCount ? round(pagesWithText / Math.max(1, pageCount), 3) : null,
    averageCharsPerPage: pageCount ? Math.round(totalTextChars / Math.max(1, pageCount)) : null,
    totalTextChars,
    totalBlocks,
    totalBboxes,
    bboxCoverageRatio: totalBlocks ? round(totalBboxes / totalBlocks, 3) : (hasBboxes ? 0 : null),
    weakPages,
    lowConfidencePages,
    reviewHint,
    warnings: warnings || [],
    pages,
  };
}

function scoreImportQuality({ text, source, chapters }) {
  const audit = source.pageAudit || {};
  const textQuality = source.textQuality || analyzeTextQuality(text, { expectedLanguage: source.ocr?.language || source.ocrLang || "" });
  const pageCount = Number(audit.pageCount || source.pageCount || 0);
  const textCoverage = audit.textCoverageRatio ?? (text ? 1 : 0);
  const avgChars = Number(audit.averageCharsPerPage || (pageCount ? text.length / pageCount : text.length));
  const bboxCoverage = audit.bboxCoverageRatio;
  const chapterConfidence = source.chapterMap?.confidence
    || average(chapters.map((chapter) => Number(chapter.splitConfidence || 0.5)));
  const warnings = [
    ...(source.warnings || []),
    ...(textQuality.flags || []),
    ...((audit.pages || []).flatMap((page) => page.warnings || [])),
  ];

  const textScore = Math.min(30, Math.round(Math.min(1, text.length / 1200) * 30));
  const coverageScore = Math.round(Math.min(1, textCoverage || 0) * 25);
  const chapterScore = Math.round(Math.min(1, chapterConfidence || 0) * 20);
  const bboxScore = bboxCoverage === null || bboxCoverage === undefined
    ? 8
    : Math.round(Math.min(1, bboxCoverage) * 15);
  const densityScore = Math.round(Math.min(1, avgChars / 80) * 10);
  const qualityPenalty = textQuality.garbledLikely ? 35 : 0;
  const penalty = Math.min(18, new Set(warnings).size * 3) + qualityPenalty;
  const score = Math.max(0, Math.min(100, textScore + coverageScore + chapterScore + bboxScore + densityScore - penalty));
  return {
    score,
    level: score >= 78 ? "high" : score >= 55 ? "medium" : "low",
    checks: {
      textChars: text.length,
      pageCount: pageCount || null,
      textCoverageRatio: textCoverage,
      averageCharsPerPage: audit.averageCharsPerPage || null,
      bboxCoverageRatio: bboxCoverage ?? null,
      chapterCount: chapters.length,
      chapterConfidence: round(chapterConfidence || 0, 2),
      warningCount: warnings.length,
      cjkRatio: textQuality.cjkRatio,
      latinRatio: textQuality.latinRatio,
      commonEnglishWordRatio: textQuality.commonEnglishWordRatio,
      garbledLikely: textQuality.garbledLikely,
    },
    stopBeforeDrawing: score < 55 || textQuality.garbledLikely,
    recommendations: qualityRecommendations({ score, audit, chapters, source, textQuality }),
  };
}

function qualityRecommendations({ score, audit, chapters, source, textQuality }) {
  const notes = [];
  if (textQuality?.garbledLikely) notes.push("Re-run import with OCR; native PDF text appears garbled.");
  if (score < 55) notes.push("Review import before drawing; extracted text or chapter split looks weak.");
  if ((audit.weakPages || 0) > 0) notes.push("Open page audit and inspect sparse or low-confidence pages.");
  if ((audit.bboxCoverageRatio ?? 1) < 0.7 && source.mineru) notes.push("Re-run with --mineru-image-analysis true if image-heavy pages need layout grounding.");
  if (chapters.length <= 1) notes.push("Provide --chapter-map for long books without clear chapter headings.");
  if (!notes.length) notes.push("Import is ready for story planning and image prompts.");
  return notes;
}

async function extractPdfWithMineru(sourcePath, options = {}) {
  const pdfEngine = normalizePdfEngine(options.pdfEngine || "mineru-hybrid");
  const backend = normalizeMineruBackend(
    options.mineruBackend || MINERU_ENGINE_BACKENDS[pdfEngine] || pdfEngine,
  );
  const method = String(
    options.mineruMethod || (backend === "pipeline" && options.ocrMode === "always" ? "ocr" : "auto"),
  ).trim();
  const language = normalizeMineruLanguage(options.mineruLang || options.language || options.ocrLang);
  const imageAnalysis = parseBooleanFlag(options.mineruImageAnalysis ?? options.imageAnalysis, false);
  const mineruBin = await resolveMineruBin(options.mineruBin);
  const outputDir = options.mineruOutputDir || await mkdtemp(path.join(os.tmpdir(), "bookframes-mineru-"));
  const keepOutput = Boolean(options.mineruOutputDir) || parseBooleanFlag(options.keepMineruOutput, false);
  const timeoutMs = toPositiveInteger(options.mineruTimeoutMs, 1800000);
  const args = ["-p", sourcePath, "-o", outputDir, "-b", backend];
  const cacheKey = keepOutput ? await mineruCacheKey(sourcePath, {
    backend,
    method,
    language,
    imageAnalysis,
  }) : null;
  const cachePath = path.join(outputDir, "_bookframes-mineru-cache.json");

  if (backend === "pipeline" || backend === "hybrid-auto-engine") {
    args.push("-m", method);
  }
  if (language) {
    args.push("-l", language);
  }
  if (backend === "vlm-auto-engine" || backend === "hybrid-auto-engine") {
    args.push("--image-analysis", String(imageAnalysis));
  }

  const startedAt = Date.now();
  try {
    if (keepOutput && await hasValidMineruCache(outputDir, cachePath, cacheKey)) {
      return createMineruExtractionFromOutput({
        sourcePath,
        outputDir,
        pdfEngine,
        backend,
        method,
        language,
        imageAnalysis,
        keepOutput,
        startedAt,
        cacheHit: true,
      });
    }

    await rm(outputDir, { recursive: true, force: true });
    await runCommand(mineruBin, args, { timeoutMs });
    if (keepOutput) {
      await mkdir(outputDir, { recursive: true });
      await writeFile(cachePath, JSON.stringify({
        cacheKey,
        sourcePath,
        backend,
        method,
        language: language || "auto",
        imageAnalysis,
        cachedAt: new Date().toISOString(),
      }, null, 2), "utf8");
    }
    return createMineruExtractionFromOutput({
      sourcePath,
      outputDir,
      pdfEngine,
      backend,
      method,
      language,
      imageAnalysis,
      keepOutput,
      startedAt,
      cacheHit: false,
    });
  } finally {
    if (!keepOutput) {
      await rm(outputDir, { recursive: true, force: true });
    }
  }
}

async function createMineruExtractionFromOutput({
  sourcePath,
  outputDir,
  pdfEngine,
  backend,
  method,
  language,
  imageAnalysis,
  keepOutput,
  startedAt,
  cacheHit,
}) {
  const files = await listFilesRecursive(outputDir);
  const markdownPath = files.find((file) => file.endsWith(".md"));
  if (!markdownPath) {
    throw new Error(`MinerU completed but did not write a markdown file under ${outputDir}`);
  }

  const contentListPath = files.find((file) => file.endsWith("_content_list.json")) || null;
  const modelJsonPath = files.find((file) => file.endsWith("_model.json")) || null;
  const middleJsonPath = files.find((file) => file.endsWith("_middle.json")) || null;
  const layoutPdfPath = files.find((file) => file.endsWith("_layout.pdf")) || null;
  const markdownText = normalizeText(await readFile(markdownPath, "utf8"));
  const contentList = contentListPath ? await readJsonFile(contentListPath) : null;
  const contentText = normalizeText(textFromMineruContentList(contentList));
  const selectedText = markdownText || contentText;

  if (!selectedText) {
    throw new Error(`MinerU completed but extracted no readable text from ${sourcePath}`);
  }

  const pageCount = pageCountFromMineruContentList(contentList);
  const blockCount = Array.isArray(contentList) ? contentList.length : null;
  const relativeFiles = files.map((file) => path.relative(outputDir, file));
  const durationMs = Date.now() - startedAt;
  const warnings = cacheHit ? ["MinerU output reused from project cache."] : [];
  const pageAudit = buildMineruPageAudit({
    contentList,
    selectedText,
    backend,
    warnings,
  });

  return {
    text: selectedText,
    source: {
      format: "pdf",
      extractionMethod: `mineru:${backend}`,
      status: "ok",
      pageCount,
      pagesWithText: pageAudit.pagesWithText || pageCount,
      averageCharsPerPage: pageAudit.averageCharsPerPage,
      ocrMode: "auto",
      ocr: {
        status: "ok",
        engine: `mineru:${backend}`,
        language: language || "auto",
        pageCount,
        processedPages: pageCount,
      },
      attempts: [{
        method: `mineru:${backend}`,
        status: "ok",
        charCount: selectedText.length,
        pageCount,
        blockCount,
        durationMs,
        cacheHit,
      }],
      warnings,
      pageAudit,
      routing: {
        mode: pdfEngine,
        selectedEngine: pdfEngine,
        selectedBackend: backend,
        reason: cacheHit ? "project_cache_hit" : "explicit_or_auto_mineru_route",
      },
      mineru: {
        engine: pdfEngine,
        backend,
        method,
        language: language || "auto",
        imageAnalysis,
        outputDir: keepOutput ? outputDir : null,
        markdownPath: keepOutput ? markdownPath : null,
        contentListPath: keepOutput ? contentListPath : null,
        modelJsonPath: keepOutput ? modelJsonPath : null,
        middleJsonPath: keepOutput ? middleJsonPath : null,
        layoutPdfPath: keepOutput ? layoutPdfPath : null,
        files: keepOutput ? relativeFiles : [],
        blockCount,
        durationMs,
        cacheHit,
      },
    },
  };
}

async function mineruCacheKey(sourcePath, config) {
  const sourceHash = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
  return createHash("sha256")
    .update(JSON.stringify({ sourceHash, config }))
    .digest("hex");
}

async function hasValidMineruCache(outputDir, cachePath, cacheKey) {
  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8"));
    if (cached.cacheKey !== cacheKey) return false;
    const files = await listFilesRecursive(outputDir);
    return files.some((file) => file.endsWith(".md"));
  } catch {
    return false;
  }
}

function normalizePdfEngine(value) {
  const engine = String(value || "auto").toLowerCase();
  if (["auto", "native", ...Object.keys(MINERU_ENGINE_BACKENDS)].includes(engine)) return engine;
  throw new Error(
    `Unsupported PDF engine: ${value}. Use auto, native, mineru-pipeline, mineru-vlm, or mineru-hybrid.`,
  );
}

function normalizeOcrMode(value) {
  const mode = String(value || "auto").toLowerCase();
  if (["auto", "always", "never"].includes(mode)) return mode;
  throw new Error(`Unsupported OCR mode: ${value}. Use auto, always, or never.`);
}

function normalizeOcrRecognition(value) {
  const mode = String(value || "fast").toLowerCase();
  if (["fast", "accurate"].includes(mode)) return mode;
  throw new Error(`Unsupported OCR recognition mode: ${value}. Use fast or accurate.`);
}

function defaultOcrRecognitionForLanguage(language) {
  const normalized = String(language || "").toLowerCase();
  if (normalized.includes("zh") || normalized.includes("ch") || normalized.includes("ja") || normalized.includes("jp")) {
    return "accurate";
  }
  return "fast";
}

function normalizeMineruBackend(value) {
  const backend = String(value || "hybrid-auto-engine").trim();
  if (["pipeline", "vlm-auto-engine", "hybrid-auto-engine"].includes(backend)) return backend;
  throw new Error(`Unsupported MinerU backend: ${value}. Use pipeline, vlm-auto-engine, or hybrid-auto-engine.`);
}

function normalizeMineruLanguage(value) {
  const language = String(value || "").trim();
  if (!language) return "";
  const primary = language.split(",")[0].trim().toLowerCase();
  if (primary.startsWith("zh") || primary === "ch" || primary === "cn") return "ch";
  if (primary.startsWith("en")) return "en";
  return primary;
}

function parseBooleanFlag(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function toPositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === "" || value === false) return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function toPositiveNumber(value, fallback) {
  if (value === undefined || value === null || value === "" || value === false) return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function isWeakPdfText(text, result, minTextChars, { expectedLanguage = "" } = {}) {
  const pageCount = Number(result?.pageCount || 0);
  const pagesWithText = Number(result?.pagesWithText || 0);
  if (!text) return true;
  if (text.length < minTextChars) return true;
  if (analyzeTextQuality(text, { expectedLanguage }).garbledLikely) return true;
  if (pageCount >= 4 && pagesWithText > 0 && pagesWithText / pageCount < 0.6) return true;
  if (pageCount >= 4 && text.length / pageCount < 24) return true;
  return false;
}

export function analyzeTextQuality(text, { expectedLanguage = "" } = {}) {
  const value = String(text || "");
  const chars = [...value].filter((char) => !/\s/u.test(char));
  const nonSpace = chars.length || 1;
  const cjkCount = countMatches(value, /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  const latinCount = countMatches(value, /[A-Za-z]/g);
  const replacementCount = countMatches(value, /\uFFFD/g);
  const slashCount = countMatches(value, /[\\|]/g);
  const tokens = value.toLowerCase().match(/[a-z]{2,}/g) || [];
  const commonEnglishCount = tokens.filter((token) => COMMON_ENGLISH_WORDS.has(token)).length;
  const cjkRatio = round(cjkCount / nonSpace, 4);
  const latinRatio = round(latinCount / nonSpace, 4);
  const replacementRatio = round(replacementCount / nonSpace, 4);
  const slashRatio = round(slashCount / nonSpace, 4);
  const commonEnglishWordRatio = round(commonEnglishCount / Math.max(1, tokens.length), 4);
  const expectedCjk = expectsCjkText(expectedLanguage);
  const flags = [];

  if (replacementRatio > 0.01) flags.push("many_replacement_chars");
  if (slashRatio > 0.02) flags.push("many_pdf_escape_chars");
  if (
    expectedCjk
    && value.length > 500
    && cjkRatio < 0.02
    && latinRatio > 0.35
    && commonEnglishWordRatio < 0.12
  ) {
    flags.push("cjk_expected_but_native_text_looks_latin_garbled");
  }

  return {
    charCount: value.length,
    cjkRatio,
    latinRatio,
    replacementRatio,
    slashRatio,
    commonEnglishWordRatio,
    expectedCjk,
    garbledLikely: flags.length > 0,
    flags,
  };
}

const COMMON_ENGLISH_WORDS = new Set(
  "the of and to in a is that it for on with as was at by be this from or are an have not but can you we they he she his her their into about more one all if when which what there so do does did has had will would could should may might our your than then its were been who how why".split(" "),
);

function expectsCjkText(language) {
  const normalized = String(language || "").toLowerCase();
  return normalized.includes("zh")
    || normalized.includes("ch")
    || normalized.includes("cn")
    || normalized.includes("ja")
    || normalized.includes("jp");
}

function countMatches(value, pattern) {
  return [...String(value || "").matchAll(pattern)].length;
}

async function runPdfTool(args, { timeoutMs, onProgress } = {}) {
  const output = await runCommand(process.env.BOOKFRAMES_PYTHON || "python3", [PDF_TOOLS_PATH, ...args], {
    timeoutMs,
    onStderrLine: onProgress
      ? (line) => {
        try {
          onProgress(JSON.parse(line));
        } catch {
          // Ignore non-JSON tool diagnostics; they remain buffered for failures.
        }
      }
      : undefined,
  });
  try {
    const parsed = JSON.parse(output.stdout || "{}");
    if (parsed.ok === false) throw new Error(parsed.error || "unknown PDF tool failure");
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`PDF tool returned invalid JSON: ${output.stderr || output.stdout || error.message}`);
    }
    throw error;
  }
}

function notifyIngestProgress(options, event) {
  if (typeof options.onProgress !== "function") return;
  try {
    options.onProgress(event);
  } catch {
    // Progress callbacks should never break extraction.
  }
}

function progressHintFromOcrEvent(event) {
  const pageCount = Number(event?.pageCount || 0);
  const processed = Number(event?.processedPages || 0);
  if (!pageCount || !processed) return 9;
  return Math.max(9, Math.min(17, 9 + Math.round((processed / pageCount) * 8)));
}

async function extractPdfTextWithSpotlight(sourcePath) {
  try {
    const output = await runCommand("mdls", ["-raw", "-name", "kMDItemTextContent", sourcePath], {
      timeoutMs: 30000,
    });
    const text = output.stdout.trim();
    if (!text || text === "(null)") return { text: "", error: "Spotlight returned no text" };
    return {
      ok: true,
      engine: "mdls",
      text,
      pageCount: null,
      pagesWithText: null,
    };
  } catch (error) {
    return { text: "", error: error.message };
  }
}

async function resolveMineruBin(explicitPath) {
  if (explicitPath) return explicitPath;
  if (process.env.BOOKFRAMES_MINERU) return process.env.BOOKFRAMES_MINERU;

  const localMineru = path.resolve(MODULE_DIR, "../../.venv-mineru/bin/mineru");
  try {
    await access(localMineru);
    return localMineru;
  } catch {
    return "mineru";
  }
}

async function isMineruAvailable(options = {}) {
  const explicit = options.mineruBin || process.env.BOOKFRAMES_MINERU;
  if (explicit) {
    try {
      await access(explicit);
      return true;
    } catch {
      return false;
    }
  }
  const localMineru = path.resolve(MODULE_DIR, "../../.venv-mineru/bin/mineru");
  try {
    await access(localMineru);
    return true;
  } catch {
    try {
      await runCommand("mineru", ["--help"], { timeoutMs: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}

async function listFilesRecursive(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function textFromMineruContentList(contentList) {
  if (!Array.isArray(contentList)) return "";
  return contentList
    .map((item) => typeof item?.text === "string" ? item.text.trim() : "")
    .filter(Boolean)
    .join("\n\n");
}

function pageCountFromMineruContentList(contentList) {
  if (!Array.isArray(contentList)) return null;
  const pageIndexes = contentList
    .map((item) => Number(item?.page_idx))
    .filter((pageIndex) => Number.isFinite(pageIndex));
  if (!pageIndexes.length) return null;
  return Math.max(...pageIndexes) + 1;
}

function previewText(text, limit = 220) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trim()}...`;
}

function average(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  if (!clean.length) return 0;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(Number(value || 0) * scale) / scale;
}

function runCommand(command, args, { timeoutMs = 120000, onStderrLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stderrLineBuffer = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (onStderrLine) {
        stderrLineBuffer += chunk;
        const lines = stderrLineBuffer.split(/\r?\n/);
        stderrLineBuffer = lines.pop() || "";
        for (const line of lines) {
          if (line.trim()) onStderrLine(line.trim());
        }
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (onStderrLine && stderrLineBuffer.trim()) {
        onStderrLine(stderrLineBuffer.trim());
      }
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
      }
    });
  });
}
