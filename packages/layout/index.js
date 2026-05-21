import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function renderStaticBook(project, projectDir) {
  const distDir = path.join(projectDir, "dist");
  await mkdir(distDir, { recursive: true });

  const indexPath = path.join(distDir, "index.html");
  const studioPath = path.join(distDir, "studio.html");
  const readerPath = path.join(distDir, "reader.html");
  await writeFile(studioPath, buildStudioHtml(project), "utf8");
  await writeFile(readerPath, buildReaderHtml(project), "utf8");
  await writeFile(indexPath, buildIndexHtml(project), "utf8");

  project.exports = {
    ...project.exports,
    html: "dist/reader.html",
    indexHtml: "dist/index.html",
    readerHtml: "dist/reader.html",
    studioHtml: "dist/studio.html",
    renderedAt: new Date().toISOString(),
  };

  return readerPath;
}

function buildStudioHtml(project) {
  const chapters = project.chapters || [];
  const spreads = chapters.flatMap((chapter) => chapter.spreads.map((spread) => ({ chapter, spread })));
  const readyImageCount = spreads.filter(({ spread }) => spread.image?.status === "ready").length;
  const firstChapterId = chapters[0]?.id || "";

  return `<!doctype html>
<html lang="${escapeHtml(htmlLanguage(project.book.language))}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(project.book.title)} - BookFrames Studio</title>
  <style>
    :root {
      --paper: #fbf6ec;
      --surface: #fffaf2;
      --ink: #213238;
      --muted: #6b7b80;
      --line: #d9cdb9;
      --teal: #367c79;
      --coral: #c94f44;
      --gold: #d99b2b;
      --blue: #31515f;
      --shadow: 0 18px 55px rgba(44, 38, 30, 0.13);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      color: var(--ink);
      background: var(--paper);
      font-family: Avenir Next, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      overflow-x: hidden;
    }

    button, input, select, textarea { font: inherit; }

    .app {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr;
    }

    .topbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 20px;
      align-items: center;
      padding: 18px 24px;
      border-bottom: 1px solid var(--line);
      background: rgba(255, 250, 242, 0.92);
      position: sticky;
      top: 0;
      z-index: 10;
      backdrop-filter: blur(12px);
    }

    .brand {
      display: flex;
      gap: 14px;
      align-items: center;
      min-width: 0;
    }

    .brand > div:last-child {
      min-width: 0;
    }

    .mark {
      width: 42px;
      height: 42px;
      border: 2px solid var(--ink);
      background: linear-gradient(135deg, var(--gold), var(--coral) 58%, var(--teal));
      box-shadow: 5px 5px 0 var(--ink);
      flex: 0 0 auto;
    }

    h1 {
      margin: 0;
      font-size: clamp(22px, 2.4vw, 36px);
      line-height: 1.08;
      letter-spacing: 0;
    }

    .meta {
      color: var(--muted);
      font-size: 13px;
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 6px;
      min-width: 0;
    }

    .meta span {
      min-width: 0;
    }

    .status-strip {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .pill {
      border: 1px solid var(--line);
      background: #fffef8;
      padding: 7px 10px;
      font-size: 12px;
      color: var(--blue);
      white-space: nowrap;
    }

    .link-pill {
      text-decoration: none;
    }

    .workspace {
      display: grid;
      grid-template-columns: minmax(220px, 280px) minmax(0, 1fr) minmax(260px, 340px);
      min-height: 0;
    }

    .sidebar, .inspector {
      border-right: 1px solid var(--line);
      background: rgba(255, 250, 242, 0.64);
      padding: 20px;
    }

    .inspector {
      border-right: 0;
      border-left: 1px solid var(--line);
    }

    .panel-title {
      margin: 0 0 12px;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0;
      color: var(--muted);
      font-weight: 800;
    }

    .chapter-list {
      display: grid;
      gap: 8px;
    }

    .chapter-button {
      width: 100%;
      border: 1px solid var(--line);
      background: #fffdf8;
      color: var(--ink);
      padding: 11px 12px;
      text-align: left;
      cursor: pointer;
      display: grid;
      gap: 4px;
    }

    .chapter-button[aria-pressed="true"] {
      border-color: var(--teal);
      box-shadow: inset 4px 0 0 var(--teal);
      background: #f4fbf7;
    }

    .chapter-button strong {
      font-size: 14px;
      line-height: 1.25;
    }

    .chapter-button span {
      color: var(--muted);
      font-size: 12px;
    }

    .stage {
      min-width: 0;
      padding: 24px;
      overflow: auto;
    }

    .chapter-section {
      display: grid;
      gap: 16px;
      margin-bottom: 32px;
    }

    .chapter-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: end;
      gap: 20px;
      border-bottom: 2px solid var(--ink);
      padding-bottom: 12px;
    }

    .chapter-head h2 {
      margin: 0 0 6px;
      font-size: clamp(22px, 2.1vw, 32px);
      letter-spacing: 0;
    }

    .chapter-head p {
      margin: 0;
      color: var(--muted);
      line-height: 1.5;
      max-width: 92ch;
    }

    .spread-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
    }

    .spread-card {
      background: var(--surface);
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
      overflow: hidden;
      min-width: 0;
    }

    .spread-card figure {
      margin: 0;
    }

    .spread-card img {
      display: block;
      width: 100%;
      aspect-ratio: 3 / 2;
      object-fit: cover;
      background: #efe1c8;
    }

    .spread-body {
      padding: 14px;
      display: grid;
      gap: 10px;
    }

    .spread-caption {
      margin: 0;
      font-size: 16px;
      line-height: 1.38;
      font-weight: 750;
    }

    .spread-caption-line,
    .caption-line {
      display: block;
    }

    .spread-caption-line[data-pending="true"],
    .caption-line[data-pending="true"] {
      color: var(--muted);
      font-style: italic;
      font-weight: 600;
    }

    .caption-lang {
      font-size: 0.62em;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
      margin-right: 0.45em;
      font-family: Avenir Next, Inter, ui-sans-serif, system-ui, sans-serif;
    }

    .spread-meta {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 12px;
    }

    .prompt {
      margin: 0;
      color: var(--blue);
      font-size: 12px;
      line-height: 1.45;
      max-height: 96px;
      overflow: auto;
      border-top: 1px solid var(--line);
      padding-top: 10px;
      white-space: pre-wrap;
    }

    .kv {
      display: grid;
      grid-template-columns: 96px minmax(0, 1fr);
      gap: 8px;
      border-bottom: 1px solid rgba(217, 205, 185, 0.72);
      padding: 9px 0;
      font-size: 13px;
    }

    .kv dt {
      margin: 0;
      color: var(--muted);
      font-weight: 700;
    }

    .kv dd {
      margin: 0;
      min-width: 0;
      line-height: 1.4;
    }

    .audit-list {
      display: grid;
      gap: 7px;
      margin-top: 8px;
    }

    .audit-row {
      display: grid;
      grid-template-columns: 46px minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      padding: 8px 9px;
      border: 1px solid rgba(217, 205, 185, 0.76);
      background: #fffdf8;
      font-size: 12px;
    }

    .audit-row[data-status="review"] {
      border-color: rgba(217, 155, 43, 0.62);
      background: #fff7df;
    }

    .audit-row[data-status="empty"] {
      border-color: rgba(201, 79, 68, 0.58);
      background: #fff1ee;
    }

    .audit-row strong,
    .audit-row span {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .palette {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .swatch {
      width: 28px;
      height: 28px;
      border: 1px solid var(--ink);
    }

    .character-list {
      display: grid;
      gap: 10px;
      margin-top: 8px;
    }

    .character {
      border-left: 4px solid var(--coral);
      padding-left: 10px;
      font-size: 13px;
      line-height: 1.42;
      display: grid;
      grid-template-columns: 72px minmax(0, 1fr);
      gap: 10px;
      align-items: start;
    }

    .character-thumb {
      width: 72px;
      aspect-ratio: 1 / 1;
      object-fit: cover;
      border: 1px solid var(--line);
      background: #efe1c8;
    }

    .empty {
      padding: 36px;
      border: 1px dashed var(--line);
      color: var(--muted);
      background: rgba(255, 255, 255, 0.42);
    }

    @media (max-width: 1120px) {
      .workspace {
        grid-template-columns: 220px minmax(0, 1fr);
      }

      .inspector {
        grid-column: 1 / -1;
        border-left: 0;
        border-top: 1px solid var(--line);
      }
    }

    @media (max-width: 760px) {
      .topbar {
        grid-template-columns: 1fr;
        padding: 14px;
      }

      .brand {
        align-items: flex-start;
      }

      .meta {
        gap: 6px 10px;
        font-size: 12px;
      }

      .status-strip {
        justify-content: flex-start;
      }

      .workspace {
        grid-template-columns: 1fr;
      }

      .sidebar, .inspector {
        border-right: 0;
        border-left: 0;
        border-bottom: 1px solid var(--line);
      }

      .stage {
        padding: 16px;
      }

      .chapter-head {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <div class="mark" aria-hidden="true"></div>
        <div>
          <h1>${escapeHtml(project.book.title)}</h1>
          <div class="meta">
            <span>BookFrames Studio</span>
            <span>${chapters.length} chapters</span>
            <span>${spreads.length} spreads</span>
            <span>${escapeHtml(project.book.audienceAge)} age band</span>
          </div>
        </div>
      </div>
      <div class="status-strip" aria-label="Project status">
        <a class="pill link-pill" href="reader.html">Reader</a>
        <span class="pill">${escapeHtml(project.styleBible.name)}</span>
        <span class="pill">${readyImageCount}/${spreads.length} images ready</span>
        <span class="pill">${escapeHtml(project.book.language)}</span>
      </div>
    </header>

    <main class="workspace">
      <aside class="sidebar">
        <h2 class="panel-title">Chapters</h2>
        <div class="chapter-list">
          <button class="chapter-button" data-chapter="all" aria-pressed="false">
            <strong>All spreads</strong>
            <span>${spreads.length} generated pages</span>
          </button>
          ${chapters.map((chapter) => `
          <button class="chapter-button" data-chapter="${escapeHtml(chapter.id)}" aria-pressed="${chapter.id === firstChapterId ? "true" : "false"}">
            <strong>${escapeHtml(chapter.title)}</strong>
            <span>${chapter.spreads.length} spreads · ${chapter.sourceTextStats.charCount} chars</span>
          </button>`).join("")}
        </div>
      </aside>

      <section class="stage" id="stage">
        ${chapters.length ? chapters.map((chapter) => renderChapter(project, chapter)).join("") : `<div class="empty">No chapters generated.</div>`}
      </section>

      <aside class="inspector">
        ${renderSourceInspector(project)}
        ${renderPlanningReview(project)}
        <h2 class="panel-title" style="${project.book?.source ? "margin-top:24px" : ""}">Style Bible</h2>
        <dl>
          <div class="kv"><dt>Direction</dt><dd>${escapeHtml(project.styleBible.artDirection)}</dd></div>
          <div class="kv"><dt>Camera</dt><dd>${escapeHtml(project.styleBible.camera)}</dd></div>
          <div class="kv"><dt>Palette</dt><dd><div class="palette">${project.styleBible.palette.map((color) => `<span class="swatch" style="background:${escapeHtml(color)}" title="${escapeHtml(color)}"></span>`).join("")}</div></dd></div>
          <div class="kv"><dt>Avoid</dt><dd>${escapeHtml(project.styleBible.negativePrompt)}</dd></div>
        </dl>
        <h2 class="panel-title" style="margin-top:24px">Characters</h2>
        <div class="character-list">
          ${project.characters.map((character) => `
          <div class="character">
            ${character.reference?.assetPath ? `<img class="character-thumb" src="../${escapeHtml(character.reference.assetPath)}" alt="${escapeHtml(character.name)} reference" loading="lazy" />` : `<div class="character-thumb" aria-hidden="true"></div>`}
            <div>
              <strong>${escapeHtml(character.name)}</strong><br />
              ${escapeHtml(character.description)}<br />
              <span style="color:var(--muted)">ref:${escapeHtml(character.reference?.status || "missing")}</span>
            </div>
          </div>`).join("")}
        </div>
      </aside>
    </main>
  </div>

  <script>
    const buttons = [...document.querySelectorAll(".chapter-button")];
    const sections = [...document.querySelectorAll(".chapter-section")];

    function selectChapter(id) {
      for (const button of buttons) {
        button.setAttribute("aria-pressed", String(button.dataset.chapter === id));
      }
      for (const section of sections) {
        section.hidden = id !== "all" && section.dataset.chapter !== id;
      }
    }

    for (const button of buttons) {
      button.addEventListener("click", () => selectChapter(button.dataset.chapter));
    }

    selectChapter("${escapeJs(firstChapterId || "all")}");
  </script>
</body>
</html>
`;
}

function renderSourceInspector(project) {
  const source = project.book?.source || {};
  const stats = project.book?.originalStats || {};
  const format = source.format || stats.sourceFormat;
  if (!format) return "";
  const ocr = source.ocr || {};
  const quality = source.importQuality || {};
  const audit = source.pageAudit || {};
  const routing = source.routing || {};
  const warnings = [...(source.warnings || []), ...(stats.warnings || [])].filter(Boolean);
  return `
        <h2 class="panel-title">Source</h2>
        <dl>
          <div class="kv"><dt>Format</dt><dd>${escapeHtml(format)}</dd></div>
          <div class="kv"><dt>Extract</dt><dd>${escapeHtml(source.extractionMethod || stats.extractionMethod || "unknown")}</dd></div>
          <div class="kv"><dt>Route</dt><dd>${escapeHtml(routing.selectedEngine || routing.selectedBackend || routing.mode || "n/a")}${routing.reason ? ` · ${escapeHtml(routing.reason)}` : ""}</dd></div>
          <div class="kv"><dt>OCR</dt><dd>${escapeHtml(ocr.status || stats.ocrStatus || "not_used")}${ocr.engine ? ` · ${escapeHtml(ocr.engine)}` : ""}</dd></div>
          <div class="kv"><dt>Pages</dt><dd>${escapeHtml(source.pageCount || stats.pageCount || "n/a")}</dd></div>
          <div class="kv"><dt>Chars</dt><dd>${escapeHtml(stats.charCount || "n/a")}</dd></div>
          ${quality.score !== undefined ? `<div class="kv"><dt>Quality</dt><dd>${escapeHtml(`${quality.score}/100 · ${quality.level}`)}${quality.stopBeforeDrawing ? " · review first" : ""}</dd></div>` : ""}
          ${audit.pageCount ? `<div class="kv"><dt>Coverage</dt><dd>${escapeHtml(`${audit.pagesWithText}/${audit.pageCount} pages · ${audit.averageCharsPerPage || 0} chars/page`)}${audit.bboxCoverageRatio !== null && audit.bboxCoverageRatio !== undefined ? ` · bbox ${escapeHtml(Math.round(audit.bboxCoverageRatio * 100))}%` : ""}</dd></div>` : ""}
          ${warnings.length ? `<div class="kv"><dt>Warnings</dt><dd>${escapeHtml(warnings.slice(0, 2).join(" | "))}</dd></div>` : ""}
        </dl>
        ${renderPageAudit(audit)}
        ${quality.recommendations?.length ? `<h2 class="panel-title" style="margin-top:18px">Import Review</h2><div class="audit-list">${quality.recommendations.slice(0, 4).map((note) => `<div class="audit-row" data-status="${quality.stopBeforeDrawing ? "review" : "ok"}"><strong>QA</strong><span>${escapeHtml(note)}</span><span>${escapeHtml(quality.level || "")}</span></div>`).join("")}</div>` : ""}`;
}

function renderPageAudit(audit) {
  if (!audit?.pages?.length) return "";
  const pages = audit.pages.slice(0, 12);
  return `
        <h2 class="panel-title" style="margin-top:18px">Page Audit</h2>
        <div class="audit-list">
          ${pages.map((page) => `
          <div class="audit-row" data-status="${escapeHtml(page.status || "ok")}" title="${escapeHtml(page.textPreview || "")}">
            <strong>p${escapeHtml(page.pageNumber)}</strong>
            <span>${escapeHtml(`${page.charCount} chars · ${page.blockCount || 0} blocks · ${page.bboxCount || 0} bbox`)}</span>
            <span>${escapeHtml((page.warnings || []).slice(0, 2).join(",") || "ok")}</span>
          </div>`).join("")}
          ${audit.pages.length > pages.length ? `<div class="audit-row"><strong>...</strong><span>${escapeHtml(audit.pages.length - pages.length)} more page(s)</span><span>source/page-audit.json</span></div>` : ""}
        </div>`;
}

function renderPlanningReview(project) {
  const review = project.planningReview || {};
  const arc = project.storyArc || {};
  const characterReview = project.characterReview || {};
  if (!review.status && !arc.sceneCount && !characterReview.status) return "";
  const issues = [...(review.blockers || []), ...(review.warnings || [])].slice(0, 5);
  const characterSummary = characterReview.status
    ? `${characterReview.approvedCount || 0} approved · ${characterReview.rejectedCount || 0} rejected · ${characterReview.reviewCount || 0} review`
    : "n/a";
  const characterIssues = (characterReview.candidates || [])
    .filter((candidate) => candidate.status === "review")
    .slice(0, 3);
  return `
        <h2 class="panel-title" style="margin-top:24px">Plan QA</h2>
        <dl>
          <div class="kv"><dt>Status</dt><dd>${escapeHtml(review.status || "n/a")}</dd></div>
          <div class="kv"><dt>Characters</dt><dd>${escapeHtml(characterSummary)}</dd></div>
          <div class="kv"><dt>Arc</dt><dd>${escapeHtml([arc.opening, arc.midpoint, arc.closing].filter(Boolean).join(" → ") || "n/a")}</dd></div>
          <div class="kv"><dt>Scenes</dt><dd>${escapeHtml(arc.sceneCount || 0)}</dd></div>
        </dl>
        ${issues.length ? `<div class="audit-list">${issues.map((issue) => `<div class="audit-row" data-status="${review.blockers?.includes(issue) ? "empty" : "review"}"><strong>QA</strong><span>${escapeHtml(issue)}</span><span>${escapeHtml(review.status || "")}</span></div>`).join("")}</div>` : ""}
        ${characterIssues.length ? `<div class="audit-list">${characterIssues.map((candidate) => `<div class="audit-row" data-status="review"><strong>Character</strong><span>${escapeHtml(candidate.name)}</span><span>${escapeHtml(candidate.reason || "review")}</span></div>`).join("")}</div>` : ""}`;
}

function renderChapter(project, chapter) {
  return `
        <article class="chapter-section" data-chapter="${escapeHtml(chapter.id)}">
          <header class="chapter-head">
            <div>
              <h2>${escapeHtml(chapter.title)}</h2>
              <p>${escapeHtml(chapter.summary)}</p>
            </div>
            <span class="pill">${chapter.spreads.length} spreads</span>
          </header>
          <div class="spread-grid">
            ${chapter.spreads.map((spread) => renderSpread(project, chapter, spread)).join("")}
          </div>
        </article>`;
}

function renderSpread(project, chapter, spread) {
  const imageSrc = spread.image?.assetPath ? `../${spread.image.assetPath}` : "";
  const qaStatus = spread.image?.qa?.status || "not_checked";
  const sourceExcerpt = spread.sourceExcerpt && spread.sourceExcerpt !== spread.caption
    ? `<pre class="prompt">${escapeHtml(spread.sourceExcerpt)}</pre>`
    : "";
  return `
            <article class="spread-card">
              <figure>
                ${imageSrc ? `<img src="${escapeHtml(imageSrc)}" alt="${escapeHtml(spread.caption)}" loading="lazy" />` : ""}
              </figure>
              <div class="spread-body">
                <p class="spread-caption">${renderCaptionLines(spread, "spread-caption-line")}</p>
                <div class="spread-meta">
                  <span>${escapeHtml(spread.id)}</span>
                  <span>${escapeHtml(spread.layout)}</span>
                  <span>${escapeHtml(spread.image?.provider || "no-provider")}</span>
                  <span>${escapeHtml(spread.image?.status || "missing")}</span>
                  <span>qa:${escapeHtml(qaStatus)}</span>
                </div>
                ${sourceExcerpt}
                <pre class="prompt">${escapeHtml(spread.scenePrompt)}</pre>
              </div>
            </article>`;
}

function buildReaderHtml(project) {
  const chapters = project.chapters || [];
  const spreads = chapters.flatMap((chapter) => chapter.spreads.map((spread) => ({ chapter, spread })));

  return `<!doctype html>
<html lang="${escapeHtml(htmlLanguage(project.book.language))}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(project.book.title)}</title>
  <style>
    :root {
      --paper: #fbf6ec;
      --ink: #1f3135;
      --muted: #63777c;
      --line: #dccfba;
      --surface: #fffaf2;
      --accent: #c94f44;
      --teal: #367c79;
    }

    * { box-sizing: border-box; }

    html { scroll-behavior: smooth; }

    body {
      margin: 0;
      color: var(--ink);
      background: var(--paper);
      font-family: Avenir Next, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      overflow-x: hidden;
    }

    .reader-shell {
      min-height: 100vh;
      width: 100%;
      max-width: 100vw;
      min-width: 0;
      overflow-x: hidden;
    }

    .reader-top {
      min-height: 76vh;
      display: grid;
      align-content: center;
      gap: 20px;
      padding: 48px min(8vw, 96px);
      border-bottom: 1px solid var(--line);
      background: linear-gradient(180deg, #fffaf2 0%, #fbf6ec 100%);
      width: 100%;
      max-width: 100vw;
      min-width: 0;
    }

    .reader-top h1 {
      margin: 0;
      font-size: clamp(42px, 8vw, 108px);
      line-height: 0.98;
      letter-spacing: 0;
      max-width: 980px;
      overflow-wrap: anywhere;
    }

    .reader-top p {
      margin: 0;
      max-width: 720px;
      color: var(--muted);
      font-size: clamp(17px, 2vw, 24px);
      line-height: 1.45;
      overflow-wrap: anywhere;
    }

    .reader-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 8px;
      min-width: 0;
    }

    .reader-actions a {
      color: var(--ink);
      border: 1px solid var(--line);
      background: var(--surface);
      padding: 10px 13px;
      text-decoration: none;
      font-size: 14px;
    }

    .spread {
      min-height: 100vh;
      display: grid;
      grid-template-columns: minmax(0, 1.18fr) minmax(260px, 0.82fr);
      align-items: center;
      gap: min(5vw, 56px);
      padding: min(7vw, 72px);
      border-bottom: 1px solid var(--line);
      width: 100%;
      max-width: 100vw;
      min-width: 0;
      overflow-x: hidden;
    }

    .spread:nth-child(even) {
      background: #fffaf2;
    }

    .spread figure {
      margin: 0;
      background: #efe1c8;
      border: 1px solid var(--line);
      overflow: hidden;
      box-shadow: 0 24px 70px rgba(44, 38, 30, 0.15);
      min-width: 0;
    }

    .spread img {
      display: block;
      width: 100%;
      aspect-ratio: 3 / 2;
      object-fit: cover;
    }

    .copy {
      display: grid;
      gap: 18px;
      max-width: 520px;
      width: 100%;
      min-width: 0;
    }

    .chapter-kicker {
      color: var(--teal);
      font-size: 13px;
      text-transform: uppercase;
      font-weight: 800;
      letter-spacing: 0;
      overflow-wrap: anywhere;
    }

    .copy h2 {
      margin: 0;
      font-size: clamp(28px, 4vw, 54px);
      line-height: 1.04;
      letter-spacing: 0;
    }

    .caption {
      margin: 0;
      font-size: clamp(23px, 3.2vw, 42px);
      line-height: 1.18;
      font-weight: 800;
      overflow-wrap: anywhere;
    }

    .page-number {
      color: var(--muted);
      font-size: 14px;
    }

    @media (max-width: 820px) {
      .reader-top {
        min-height: 56vh;
        padding: 32px 18px;
      }

      .reader-top h1 {
        font-size: clamp(34px, 13vw, 56px);
      }

      .reader-top p {
        font-size: 17px;
      }

      .spread {
        min-height: auto;
        grid-template-columns: minmax(0, 1fr);
        padding: 24px 16px 40px;
        gap: 20px;
        width: 100%;
      }

      .spread figure {
        order: 1;
      }

      .copy {
        order: 2;
      }
    }
  </style>
</head>
<body>
  <main class="reader-shell">
    <header class="reader-top">
      <h1>${escapeHtml(project.book.title)}</h1>
      <p>${escapeHtml(chapters[0]?.summary || "A generated picture-book reading edition.")}</p>
      <nav class="reader-actions" aria-label="Book views">
        <a href="studio.html">Studio</a>
        <a href="#page-1">Start Reading</a>
      </nav>
    </header>
    ${spreads.map(({ chapter, spread }, index) => renderReaderSpread(chapter, spread, index + 1)).join("")}
  </main>
</body>
</html>
`;
}

function buildIndexHtml(project) {
  return `<!doctype html>
<html lang="${escapeHtml(htmlLanguage(project.book.language))}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="0; url=reader.html" />
  <title>${escapeHtml(project.book.title)}</title>
</head>
<body>
  <p><a href="reader.html">Open reader</a> · <a href="studio.html">Open studio</a></p>
</body>
</html>
`;
}

function renderReaderSpread(chapter, spread, pageNumber) {
  const imageSrc = spread.image?.assetPath ? `../${spread.image.assetPath}` : "";
  const caption = spread.readerCaption || spread.caption;
  return `
    <section class="spread" id="page-${pageNumber}">
      <figure>
        ${imageSrc ? `<img src="${escapeHtml(imageSrc)}" alt="${escapeHtml(caption)}" loading="lazy" />` : ""}
      </figure>
      <div class="copy">
        <div class="chapter-kicker">${escapeHtml(chapter.title)}</div>
        <h2>Page ${pageNumber}</h2>
        <p class="caption">${renderCaptionLines(spread, "caption-line")}</p>
        <div class="page-number">${escapeHtml(spread.id)}</div>
      </div>
    </section>`;
}

function renderCaptionLines(spread, className) {
  const fallback = spread.readerCaption || spread.caption || "";
  const lines = Array.isArray(spread.captionI18n?.lines) && spread.captionI18n.lines.length
    ? spread.captionI18n.lines
    : [{ language: "", label: "", text: fallback, needsTranslation: false }];
  return lines.map((line) => {
    const text = line.text || (line.needsTranslation ? "Translation pending" : fallback);
    const label = line.label || languageName(line.language);
    return `<span class="${className}" data-lang="${escapeHtml(line.language || "")}" data-pending="${line.text ? "false" : "true"}">${label ? `<span class="caption-lang">${escapeHtml(label)}</span>` : ""}${escapeHtml(text)}</span>`;
  }).join("");
}

function languageName(code) {
  return {
    zh: "中文",
    ja: "日本語",
    en: "English",
  }[code] || "";
}

function htmlLanguage(code) {
  if (code === "zh") return "zh-CN";
  if (code === "ja") return "ja-JP";
  return "en";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeJs(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
