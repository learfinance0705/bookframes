import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ingestBook } from "../ingest/index.js";
import {
  buildFixedPagePlan,
  buildFullCoveragePagePlan,
  buildHeuristicPagePlan,
  isAutoSpreadsValue,
  isFullCoverageSpreadsValue,
  normalizePagePlan,
  parseSpreadCount,
} from "../page-plan/index.js";
import { planPictureBook } from "../planner/index.js";
import {
  ensureCodexLocalJobs,
  generateOpenAIImageQueue,
  getNextCodexPrompt,
  getNextCodexQueuePrompt,
  ensureImages,
  importCharacterReference,
  importCodexImage,
  importLatestCodexImages,
  importLatestCodexQueue,
  listPendingCodexQueue,
  listPendingCodexSpreads,
  markSpreadForRedraw,
} from "../image/index.js";
import { renderStaticBook } from "../layout/index.js";
import { exportBookArtifacts } from "../export/index.js";
import { lintBookProject, summarizeProject } from "../core/schema.js";
import { MANIFEST_FILE, readJson, resolveManifestPath, writeJson } from "../core/io.js";

export async function createBookProject({
  sourcePath,
  outDir,
  title,
  audienceAge,
  stylePreset,
  spreadsPerChapter = "full-coverage",
  languageProfile = "auto",
  imageProvider = "placeholder",
  ingestOptions = {},
  pagePlanProvider,
}) {
  const absoluteSource = path.resolve(sourcePath);
  const projectDir = path.resolve(outDir);
  await mkdir(projectDir, { recursive: true });

  const ingest = await ingestBookWithCache(absoluteSource, {
    projectDir,
    languageProfile,
    ingestOptions,
  });
  await writeIngestArtifacts(projectDir, ingest);
  const pagePlan = await resolvePagePlan({
    ingest,
    spreadsPerChapter,
    pagePlanProvider,
  });
  const project = planPictureBook({
    ingest,
    title,
    audienceAge,
    stylePreset,
    spreadsPerChapter,
    languageProfile,
    pagePlan,
  });
  await writePlanningArtifacts(projectDir, project, pagePlan);

  await ensureImages(project, projectDir, { provider: imageProvider });
  await renderStaticBook(project, projectDir);

  const manifestPath = path.join(projectDir, MANIFEST_FILE);
  await writeJson(manifestPath, project);

  return {
    project,
    manifestPath,
    htmlPath: path.join(projectDir, project.exports.html),
    lint: lintBookProject(project),
    summary: summarizeProject(project),
  };
}

async function resolvePagePlan({ ingest, spreadsPerChapter, pagePlanProvider }) {
  if (!String(spreadsPerChapter ?? "").trim() || isFullCoverageSpreadsValue(spreadsPerChapter)) {
    return buildFullCoveragePagePlan(ingest);
  }
  if (!isAutoSpreadsValue(spreadsPerChapter)) {
    return buildFixedPagePlan(ingest, parseSpreadCount(spreadsPerChapter || 3));
  }
  if (pagePlanProvider) {
    try {
      const providedPlan = await pagePlanProvider(ingest);
      return normalizePagePlan(providedPlan, ingest, {
        mode: providedPlan?.mode || "codex-auto",
        provider: providedPlan?.provider || "local-codex",
      });
    } catch (error) {
      return buildHeuristicPagePlan(ingest, {
        mode: "heuristic-fallback",
        provider: "heuristic",
        fallbackReason: `Local Codex page planning failed: ${error.message}`,
        warnings: [error.message],
      });
    }
  }
  return buildHeuristicPagePlan(ingest, {
    mode: "heuristic",
    provider: "heuristic",
    reason: "Auto page planning requested; CLI used local heuristic because no Codex page-plan provider was attached.",
  });
}

async function ingestBookWithCache(sourcePath, {
  projectDir,
  languageProfile,
  ingestOptions = {},
}) {
  const options = {
    ...ingestOptions,
    expectedLanguage: ingestOptions.expectedLanguage || languageProfile,
    mineruOutputDir: ingestOptions.mineruOutputDir || path.join(projectDir, "source", "mineru"),
  };
  const cache = await resolveIngestCache(sourcePath, options).catch((error) => ({
    enabled: false,
    error: error.message,
  }));

  if (cache.enabled) {
    notifyProducerProgress(options, {
      event: "ingest-cache-check",
      stage: "checking BookFrames import cache",
      progressHint: 5,
      engine: "ingest-cache",
      cacheStatus: "checking",
      cacheKey: cache.key,
    });
    const cached = await readIngestCache(cache, sourcePath).catch(() => null);
    if (cached) {
      notifyProducerProgress(options, {
        event: "ingest-cache-hit",
        stage: "reusing cached OCR/text extraction",
        progressHint: 15,
        engine: cached.source?.extractionMethod || "ingest-cache",
        cacheStatus: "hit",
        cacheKey: cache.key,
        pageCount: cached.source?.pageCount || null,
        processedPages: cached.source?.ocr?.processedPages || null,
        charCount: cached.text?.length || null,
      });
      return cached;
    }
    notifyProducerProgress(options, {
      event: "ingest-cache-miss",
      stage: "import cache miss, extracting source text",
      progressHint: 6,
      engine: "ingest-cache",
      cacheStatus: "miss",
      cacheKey: cache.key,
    });
  }

  const ingest = await ingestBook(sourcePath, options);
  if (cache.enabled) {
    await writeIngestCache(cache, ingest).catch((error) => {
      notifyProducerProgress(options, {
        event: "ingest-cache-write-failed",
        stage: `import cache write failed: ${error.message}`,
        progressHint: 17,
        engine: ingest.source?.extractionMethod || "ingest-cache",
        cacheStatus: "write_failed",
        cacheKey: cache.key,
      });
    });
    ingest.source.cache = {
      status: "miss",
      key: cache.key,
      path: cache.filePath,
      updatedAt: new Date().toISOString(),
    };
    ingest.stats.cacheStatus = "miss";
  }
  return ingest;
}

async function resolveIngestCache(sourcePath, options = {}) {
  if (parseBooleanFlag(options.disableIngestCache, false)) return { enabled: false, reason: "disabled" };
  if (options.chapterMap || options.chapterMapPath) return { enabled: false, reason: "explicit_chapter_map" };
  const cacheDir = options.ingestCacheDir
    || process.env.BOOKFRAMES_INGEST_CACHE_DIR
    || path.join(process.cwd(), "runs", "_ingest-cache");
  const sourceBuffer = await readFile(sourcePath);
  const sourceHash = createHash("sha256").update(sourceBuffer).digest("hex");
  const config = cacheRelevantIngestOptions(options);
  const key = createHash("sha256")
    .update(JSON.stringify({
      schemaVersion: 2,
      sourceHash,
      sourceExt: path.extname(sourcePath).toLowerCase(),
      config,
    }))
    .digest("hex")
    .slice(0, 32);
  return {
    enabled: true,
    key,
    sourceHash,
    config,
    dir: path.join(cacheDir, key),
    filePath: path.join(cacheDir, key, "ingest.json"),
  };
}

function cacheRelevantIngestOptions(options = {}) {
  return stableObject({
    pdfEngine: options.pdfEngine || "auto",
    ocrMode: options.ocrMode || options.ocr || "auto",
    ocrLang: options.ocrLang || "",
    ocrMaxPages: options.ocrMaxPages || "",
    ocrRecognition: options.ocrRecognition || options.recognition || "",
    ocrScale: options.ocrScale || "",
    expectedLanguage: options.expectedLanguage || options.languageProfile || options.language || "",
    mineruBackend: options.mineruBackend || "",
    mineruLang: options.mineruLang || "",
    mineruMethod: options.mineruMethod || "",
    mineruImageAnalysis: options.mineruImageAnalysis || options.imageAnalysis || "",
    preferMineru: options.preferMineru || "",
    autoMineruRoute: options.autoMineruRoute || "",
    disableMineruAutoRoute: options.disableMineruAutoRoute || "",
  });
}

async function readIngestCache(cache, sourcePath) {
  const payload = JSON.parse(await readFile(cache.filePath, "utf8"));
  if (payload.schemaVersion !== 2 || payload.sourceHash !== cache.sourceHash) return null;
  const ingest = payload.ingest;
  if (!ingest?.text || !Array.isArray(ingest.chapters)) return null;
  const readAt = new Date().toISOString();
  return {
    ...ingest,
    sourcePath,
    source: {
      ...(ingest.source || {}),
      cache: {
        status: "hit",
        key: cache.key,
        path: cache.filePath,
        cachedAt: payload.createdAt,
        readAt,
      },
    },
    stats: {
      ...(ingest.stats || {}),
      cacheStatus: "hit",
    },
  };
}

async function writeIngestCache(cache, ingest) {
  await mkdir(cache.dir, { recursive: true });
  const createdAt = new Date().toISOString();
  await writeFile(cache.filePath, JSON.stringify({
    schemaVersion: 2,
    key: cache.key,
    sourceHash: cache.sourceHash,
    config: cache.config,
    createdAt,
    ingest: {
      ...ingest,
      sourcePath: "",
      source: {
        ...(ingest.source || {}),
        cache: {
          status: "stored",
          key: cache.key,
          createdAt,
        },
      },
      stats: {
        ...(ingest.stats || {}),
        cacheStatus: "stored",
      },
    },
  }, null, 2), "utf8");
}

function notifyProducerProgress(options, event) {
  if (typeof options.onProgress !== "function") return;
  try {
    options.onProgress(event);
  } catch {
    // Progress callbacks must never block import.
  }
}

function stableObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

async function writePlanningArtifacts(projectDir, project, pagePlan) {
  const planningDir = path.join(projectDir, "planning");
  await mkdir(planningDir, { recursive: true });
  await writeFile(path.join(planningDir, "page-plan.json"), JSON.stringify(pagePlan || project.book?.pagePlan || {}, null, 2), "utf8");
  await writeFile(path.join(planningDir, "story-arc.json"), JSON.stringify(project.storyArc || {}, null, 2), "utf8");
  await writeFile(path.join(planningDir, "planning-review.json"), JSON.stringify(project.planningReview || {}, null, 2), "utf8");
  await writeFile(path.join(planningDir, "character-review.json"), JSON.stringify(project.characterReview || {}, null, 2), "utf8");
}

async function writeIngestArtifacts(projectDir, ingest) {
  const sourceDir = path.join(projectDir, "source");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(sourceDir, "extracted.txt"), ingest.text, "utf8");
  await writeFile(path.join(sourceDir, "ingest-report.json"), JSON.stringify({
    sourcePath: ingest.sourcePath,
    source: ingest.source,
    stats: ingest.stats,
    chapters: ingest.chapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      sourceAnchors: chapter.sourceAnchors,
      stats: chapter.stats,
    })),
  }, null, 2), "utf8");
  if (ingest.source?.pageAudit) {
    await writeFile(path.join(sourceDir, "page-audit.json"), JSON.stringify(ingest.source.pageAudit, null, 2), "utf8");
  }
  if (ingest.source?.chapterMap) {
    await writeFile(path.join(sourceDir, "chapter-map.json"), JSON.stringify(ingest.source.chapterMap, null, 2), "utf8");
  }
  if (ingest.source?.importQuality) {
    await writeFile(path.join(sourceDir, "import-quality.json"), JSON.stringify(ingest.source.importQuality, null, 2), "utf8");
  }
}

export async function renderExistingProject(inputPath, { imageProvider = "preserve" } = {}) {
  const manifestPath = resolveManifestPath(inputPath);
  const projectDir = path.dirname(manifestPath);
  const project = await readJson(manifestPath);

  if (imageProvider !== "preserve") {
    await ensureImages(project, projectDir, { provider: imageProvider });
  }
  await renderStaticBook(project, projectDir);
  await writeJson(manifestPath, project);

  return {
    project,
    manifestPath,
    htmlPath: path.join(projectDir, project.exports.html),
    lint: lintBookProject(project),
    summary: summarizeProject(project),
  };
}

export async function prepareCodexImageJobs(inputPath) {
  const manifestPath = resolveManifestPath(inputPath);
  const projectDir = path.dirname(manifestPath);
  const project = await readJson(manifestPath);

  await ensureCodexLocalJobs(project, projectDir);
  await renderStaticBook(project, projectDir);
  await writeJson(manifestPath, project);

  return {
    project,
    manifestPath,
    htmlPath: path.join(projectDir, project.exports.html),
    jobs: listPendingCodexSpreads(project),
    queue: listPendingCodexQueue(project),
    lint: lintBookProject(project),
    summary: summarizeProject(project),
  };
}

export async function importCodexImageToProject(inputPath, { spreadId, imagePath }) {
  const manifestPath = resolveManifestPath(inputPath);
  const projectDir = path.dirname(manifestPath);
  const project = await readJson(manifestPath);

  const image = await importCodexImage(project, projectDir, { spreadId, imagePath });
  await renderStaticBook(project, projectDir);
  await writeJson(manifestPath, project);

  return {
    project,
    manifestPath,
    htmlPath: path.join(projectDir, project.exports.html),
    image,
    lint: lintBookProject(project),
    summary: summarizeProject(project),
  };
}

export async function importCharacterReferenceToProject(inputPath, { characterId, imagePath }) {
  const manifestPath = resolveManifestPath(inputPath);
  const projectDir = path.dirname(manifestPath);
  const project = await readJson(manifestPath);

  const reference = await importCharacterReference(project, projectDir, { characterId, imagePath });
  await renderStaticBook(project, projectDir);
  await writeJson(manifestPath, project);

  return {
    project,
    manifestPath,
    htmlPath: path.join(projectDir, project.exports.html),
    reference,
    lint: lintBookProject(project),
    summary: summarizeProject(project),
  };
}

export async function importLatestCodexImagesToProject(inputPath, { limit = 1, sourceRoot, spreadId } = {}) {
  const manifestPath = resolveManifestPath(inputPath);
  const projectDir = path.dirname(manifestPath);
  const project = await readJson(manifestPath);

  const imported = await importLatestCodexImages(project, projectDir, { limit, sourceRoot, spreadId });
  await renderStaticBook(project, projectDir);
  await writeJson(manifestPath, project);

  return {
    project,
    manifestPath,
    htmlPath: path.join(projectDir, project.exports.html),
    imported,
    lint: lintBookProject(project),
    summary: summarizeProject(project),
  };
}

export async function importLatestCodexQueueToProject(inputPath, { limit = 1, sourceRoot } = {}) {
  const manifestPath = resolveManifestPath(inputPath);
  const projectDir = path.dirname(manifestPath);
  const project = await readJson(manifestPath);

  const imported = await importLatestCodexQueue(project, projectDir, { limit, sourceRoot });
  await renderStaticBook(project, projectDir);
  await writeJson(manifestPath, project);

  return {
    project,
    manifestPath,
    htmlPath: path.join(projectDir, project.exports.html),
    imported,
    lint: lintBookProject(project),
    summary: summarizeProject(project),
  };
}

export async function generateOpenAIImagesForProject(inputPath, {
  limit = 1,
  apiKey,
  model,
  size,
  quality,
} = {}) {
  const manifestPath = resolveManifestPath(inputPath);
  const projectDir = path.dirname(manifestPath);
  const project = await readJson(manifestPath);

  const generated = await generateOpenAIImageQueue(project, projectDir, {
    limit,
    apiKey,
    model,
    size,
    quality,
  });
  await renderStaticBook(project, projectDir);
  await writeJson(manifestPath, project);

  return {
    project,
    manifestPath,
    htmlPath: path.join(projectDir, project.exports.html),
    generated,
    lint: lintBookProject(project),
    summary: summarizeProject(project),
  };
}

export async function markSpreadForRedrawInProject(inputPath, { spreadId, reason }) {
  const manifestPath = resolveManifestPath(inputPath);
  const projectDir = path.dirname(manifestPath);
  const project = await readJson(manifestPath);

  const redraw = await markSpreadForRedraw(project, projectDir, { spreadId, reason });
  await ensureCodexLocalJobs(project, projectDir);
  await renderStaticBook(project, projectDir);
  await writeJson(manifestPath, project);

  return {
    project,
    manifestPath,
    htmlPath: path.join(projectDir, project.exports.html),
    redraw,
    lint: lintBookProject(project),
    summary: summarizeProject(project),
  };
}

export async function getNextCodexPromptFromProject(inputPath, { spreadId } = {}) {
  const manifestPath = resolveManifestPath(inputPath);
  const project = await readJson(manifestPath);
  return {
    manifestPath,
    prompt: getNextCodexPrompt(project, { spreadId }),
    summary: summarizeProject(project),
  };
}

export async function getNextCodexQueuePromptFromProject(inputPath) {
  const manifestPath = resolveManifestPath(inputPath);
  const project = await readJson(manifestPath);
  return {
    manifestPath,
    prompt: getNextCodexQueuePrompt(project),
    summary: summarizeProject(project),
  };
}

export async function exportBookProject(inputPath) {
  const manifestPath = resolveManifestPath(inputPath);
  const projectDir = path.dirname(manifestPath);
  const project = await readJson(manifestPath);
  const exports = await exportBookArtifacts(project, projectDir);
  await writeJson(manifestPath, project);

  return {
    project,
    manifestPath,
    htmlPath: path.join(projectDir, project.exports.html),
    exports,
    lint: lintBookProject(project),
    summary: summarizeProject(project),
  };
}
