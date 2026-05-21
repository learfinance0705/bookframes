import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { appendFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHeuristicPagePlan,
  isAutoSpreadsValue,
  isFullCoverageSpreadsValue,
  normalizePagePlan,
  pagePlanChapterSketches,
  parseSpreadCount,
} from "../../packages/page-plan/index.js";
import {
  createBookProject,
  exportBookProject,
  generateOpenAIImagesForProject,
  getNextCodexQueuePromptFromProject,
  importLatestCodexQueueToProject,
  renderExistingProject,
} from "../../packages/producer/index.js";
import { normalizeLanguageProfile } from "../../packages/planner/index.js";

const webDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(webDir, "../..");
const requestsDir = path.join(rootDir, "runs", "_change-requests");
const imageRunsDir = path.join(rootDir, "runs", "_image-runs");
const bookRunsDir = path.join(rootDir, "runs", "_book-runs");
const uploadRunsDir = path.join(rootDir, "runs", "_uploads");
const defaultPort = Number(process.env.PORT || 4197);
const codexBin = process.env.CODEX_BIN || "/Applications/Codex.app/Contents/Resources/codex";
const activeRuns = new Map();
const activeImageRuns = new Map();
const activeBookRuns = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
  ".epub": "application/epub+zip",
};

export function createBookFramesServer({
  root = rootDir,
  requestRoot = requestsDir,
  imageRunRoot = imageRunsDir,
  bookRunRoot = bookRunsDir,
  codexPath = codexBin,
} = {}) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url, { root, requestRoot, imageRunRoot, bookRunRoot, codexPath });
        return;
      }
      await serveStatic(req, res, url, root);
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
  });
}

async function handleApi(req, res, url, options) {
  if (req.method === "POST" && url.pathname === "/api/change-requests") {
    const payload = await readJson(req);
    const request = await saveChangeRequest(payload, options);
    sendJson(res, 200, { ok: true, request });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/book-runs") {
    const payload = await readJson(req);
    const job = await startBookRun(payload, options);
    sendJson(res, 200, { ok: true, job });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/book-runs/upload") {
    const job = await startUploadedBookRun(req, url, options);
    sendJson(res, 200, { ok: true, job });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/book-runs") {
    const jobs = await listBookRuns(options.bookRunRoot);
    sendJson(res, 200, { ok: true, jobs });
    return;
  }

  const bookRunMatch = url.pathname.match(/^\/api\/book-runs\/([^/]+)$/);
  if (req.method === "GET" && bookRunMatch) {
    sendJson(res, 200, { ok: true, job: await readBookRun(bookRunMatch[1], options.bookRunRoot) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/change-requests") {
    sendJson(res, 200, { ok: true, requests: await listChangeRequests(options.requestRoot) });
    return;
  }

  const runMatch = url.pathname.match(/^\/api\/change-requests\/([^/]+)\/run$/);
  if (req.method === "POST" && runMatch) {
    const request = await runCodexForRequest(runMatch[1], options);
    sendJson(res, 200, { ok: true, request });
    return;
  }

  const planMatch = url.pathname.match(/^\/api\/change-requests\/([^/]+)\/plan$/);
  if (req.method === "POST" && planMatch) {
    const request = await planCodexForRequest(planMatch[1], options);
    sendJson(res, 200, { ok: true, request });
    return;
  }

  const itemMatch = url.pathname.match(/^\/api\/change-requests\/([^/]+)$/);
  if (req.method === "GET" && itemMatch) {
    sendJson(res, 200, { ok: true, request: await readDecoratedChangeRequest(itemMatch[1], options.requestRoot) });
    return;
  }

  const logMatch = url.pathname.match(/^\/api\/change-requests\/([^/]+)\/log$/);
  if (req.method === "GET" && logMatch) {
    const request = await readChangeRequest(logMatch[1], options.requestRoot);
    const log = request.logPath ? await readFile(request.logPath, "utf8").catch(() => "") : "";
    sendText(res, 200, log, "text/plain; charset=utf-8");
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/image-queue/next") {
    const projectPath = resolveProjectFile(options.root, url.searchParams.get("project") || "");
    if (!projectPath) throw new Error("project is required");
    const result = await getNextCodexQueuePromptFromProject(projectPath);
    sendJson(res, 200, { ok: true, ...result });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/image-queue/import-latest") {
    const payload = await readJson(req);
    const projectPath = resolveProjectFile(options.root, payload.projectPath);
    if (!projectPath) throw new Error("projectPath is required");
    const result = await importLatestCodexQueueToProject(projectPath, {
      limit: Number(payload.limit || 1),
      sourceRoot: payload.sourceRoot,
    });
    sendJson(res, 200, { ok: true, ...result });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/image-queue/generate-openai") {
    const payload = await readJson(req);
    const projectPath = resolveProjectFile(options.root, payload.projectPath);
    if (!projectPath) throw new Error("projectPath is required");
    const result = await generateOpenAIImagesForProject(projectPath, {
      limit: Number(payload.limit || 1),
      model: payload.model,
      size: payload.size,
      quality: payload.quality,
    });
    sendJson(res, 200, { ok: true, ...result });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/exports") {
    const payload = await readJson(req);
    const projectPath = resolveProjectFile(options.root, payload.projectPath);
    if (!projectPath) throw new Error("projectPath is required");
    const result = await exportBookProject(projectPath);
    sendJson(res, 200, { ok: true, ...result });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/captions/language") {
    const payload = await readJson(req);
    const projectPath = resolveProjectFile(options.root, payload.projectPath);
    if (!projectPath) throw new Error("projectPath is required");
    const result = await updateProjectCaptionLanguage(projectPath, {
      languageMode: payload.languageMode || "zh-en",
      root: options.root,
      codexPath: options.codexPath,
    });
    sendJson(res, 200, { ok: true, ...result });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/image-runs") {
    const payload = await readJson(req);
    const job = await startImageRun(payload, options);
    if (payload.bookRunId) {
      await attachImageRunToBookRun(payload.bookRunId, job, options);
    }
    sendJson(res, 200, { ok: true, job });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/image-runs") {
    const jobs = await listImageRuns(options.imageRunRoot);
    sendJson(res, 200, { ok: true, jobs });
    return;
  }

  const imageRunMatch = url.pathname.match(/^\/api\/image-runs\/([^/]+)$/);
  if (req.method === "GET" && imageRunMatch) {
    sendJson(res, 200, { ok: true, job: await readImageRun(imageRunMatch[1], options.imageRunRoot) });
    return;
  }

  const imageRunPauseMatch = url.pathname.match(/^\/api\/image-runs\/([^/]+)\/pause$/);
  if (req.method === "POST" && imageRunPauseMatch) {
    const job = await pauseImageRun(imageRunPauseMatch[1], options);
    sendJson(res, 200, { ok: true, job });
    return;
  }

  sendJson(res, 404, { ok: false, error: "API route not found" });
}

async function startImageRun(payload, {
  root = rootDir,
  imageRunRoot = imageRunsDir,
  codexPath = codexBin,
} = {}) {
  await mkdir(imageRunRoot, { recursive: true });
  const projectFile = resolveProjectFile(root, payload.projectPath);
  if (!projectFile) throw new Error("projectPath is required");
  const provider = String(payload.provider || "codex-exec");
  const mode = payload.mode === "all" || payload.limit === "all" || payload.drawAll ? "all" : "single";
  const existing = await findRecentActiveImageRun({
    imageRunRoot,
    projectPath: String(payload.projectPath || ""),
    provider,
    mode,
  });
  if (existing) return existing;
  const id = makeRequestId();
  const now = new Date().toISOString();
  const jobPath = path.join(imageRunRoot, `${id}.json`);
  const job = {
    schemaVersion: 1,
    id,
    status: "queued",
    provider,
    mode,
    projectPath: String(payload.projectPath || ""),
    projectFile,
    projectDir: path.dirname(projectFile),
    limit: provider === "codex-exec" && mode === "all" ? 0 : provider === "codex-exec" ? 1 : Math.max(1, Number(payload.limit || 1)),
    progress: 0,
    stage: "queued",
    createdAt: now,
    updatedAt: now,
    jobPath,
    promptRunPath: path.join(imageRunRoot, `${id}.prompt.md`),
    logPath: path.join(imageRunRoot, `${id}.log`),
    generated: [],
    completedItems: 0,
    totalItems: 0,
  };
  await writeFile(jobPath, JSON.stringify(job, null, 2), "utf8");
  activeImageRuns.set(id, job);
  runImageJobInBackground(job, { root, imageRunRoot, codexPath }).catch(() => {});
  return job;
}

async function runImageJobInBackground(job, { root = rootDir, imageRunRoot = imageRunsDir, codexPath = codexBin } = {}) {
  await writeImageRun({
    ...job,
    status: "running",
    progress: 8,
    stage: "starting image generation",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  try {
    if (job.provider === "codex-exec") {
      const result = job.mode === "all"
        ? await runCodexExecImageBatchJob(job, { root, imageRunRoot, codexPath })
        : await runCodexExecImageJob(job, { root, imageRunRoot, codexPath });
      const completed = {
        ...await readImageRun(job.id, imageRunRoot),
        status: "completed",
        progress: 100,
        stage: "completed",
        generated: result.generated || [],
        summary: result.summary,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await writeImageRun(completed);
      return;
    }

    if (job.provider !== "openai-image") {
      throw new Error(`Unsupported image provider: ${job.provider}`);
    }
    await writeImageRun({
      ...await readImageRun(job.id, imageRunRoot),
      progress: 24,
      stage: "calling OpenAI image API",
      updatedAt: new Date().toISOString(),
    });
    const result = await generateOpenAIImagesForProject(job.projectFile, {
      limit: job.limit,
    });
    const completed = {
      ...await readImageRun(job.id, imageRunRoot),
      status: "completed",
      progress: 100,
      stage: "completed",
      generated: result.generated || [],
      summary: result.summary,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeImageRun(completed);
  } catch (error) {
    const current = await readImageRun(job.id, imageRunRoot).catch(() => job);
    if (current.status === "paused") {
      await writeImageRun({
        ...current,
        status: "paused",
        stage: current.stage || "paused",
        error: null,
        pid: null,
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    const failed = {
      ...current,
      status: "failed",
      progress: 100,
      stage: "failed",
      error: error.message,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeImageRun(failed);
  } finally {
    activeImageRuns.delete(job.id);
  }
}

async function runCodexExecImageBatchJob(job, { root = rootDir, imageRunRoot = imageRunsDir, codexPath = codexBin } = {}) {
  await writeImageRun({
    ...await readImageRun(job.id, imageRunRoot),
    progress: 0,
    stage: "preparing full drawing queue",
    updatedAt: new Date().toISOString(),
  });
  const prepared = await renderExistingProject(job.projectFile, { imageProvider: "codex-local" });
  const pendingItems = prepared.summary.codexQueuePendingCount || 0;
  const completedOffset = Math.max(0, Number(prepared.summary.readyImageCount || 0) + Number(prepared.summary.readyCharacterReferenceCount || 0));
  const totalItems = completedOffset + pendingItems;
  if (!pendingItems) {
    const exported = await exportBookProject(job.projectFile);
    return {
      generated: [],
      summary: exported.summary,
    };
  }

  const generated = [];
  let summary = prepared.summary;
  for (let index = 0; index < pendingItems; index += 1) {
    const latest = await readImageRun(job.id, imageRunRoot);
    if (latest.status === "paused") {
      throw new Error("Image run paused");
    }
    const next = await getNextCodexQueuePromptFromProject(job.projectFile);
    if (!next.prompt) break;
    const item = normalizeImageQueueItem(next.prompt);
    const completedBeforeItem = completedOffset + index;
    const progressBase = Math.floor((100 * completedBeforeItem) / totalItems);
    const progressSpan = Math.max(1, Math.ceil(100 / totalItems));
    const current = {
      ...await readImageRun(job.id, imageRunRoot),
      promptRunPath: path.join(imageRunRoot, `${job.id}-${String(index + 1).padStart(3, "0")}.prompt.md`),
      progressBase,
      progressSpan,
      completedItems: completedBeforeItem,
      totalItems,
      item,
      stage: `drawing ${completedBeforeItem + 1}/${totalItems}: ${item.type}:${item.id}`,
      updatedAt: new Date().toISOString(),
    };
    await writeImageRun({
      ...current,
      progress: progressBase,
    });
    const result = await runCodexExecImageJob(current, { root, imageRunRoot, codexPath });
    generated.push(...(result.generated || []));
    summary = result.summary || summary;
    await writeImageRun({
      ...await readImageRun(job.id, imageRunRoot),
      generated,
      completedItems: completedOffset + index + 1,
      totalItems,
      summary,
      progress: Math.floor((100 * (completedOffset + index + 1)) / totalItems),
      stage: `drawn ${completedOffset + index + 1}/${totalItems}`,
      updatedAt: new Date().toISOString(),
    });
  }

  await writeImageRun({
    ...await readImageRun(job.id, imageRunRoot),
    progress: 99,
    stage: "exporting completed picture book",
    updatedAt: new Date().toISOString(),
  });
  const exported = await exportBookProject(job.projectFile);
  return {
    generated,
    summary: exported.summary,
  };
}

async function runCodexExecImageJob(job, { root = rootDir, imageRunRoot = imageRunsDir, codexPath = codexBin } = {}) {
  await writeImageRun({
    ...await readImageRun(job.id, imageRunRoot),
    progress: imageProgress(job, 18),
    stage: "refreshing Codex-local queue",
    updatedAt: new Date().toISOString(),
  });
  await renderExistingProject(job.projectFile, { imageProvider: "codex-local" });

  const next = await getNextCodexQueuePromptFromProject(job.projectFile);
  if (!next.prompt) {
    return {
      generated: [],
      summary: next.summary,
    };
  }

  const item = normalizeImageQueueItem(next.prompt);
  const promptFile = safeProjectPath(job.projectDir, item.promptPath);
  const targetFile = safeProjectPath(job.projectDir, item.targetAssetPath);
  if (!promptFile) throw new Error(`Invalid prompt path: ${item.promptPath}`);
  if (!targetFile) throw new Error(`Invalid target path: ${item.targetAssetPath}`);
  await mkdir(path.dirname(targetFile), { recursive: true });
  await mkdir(path.dirname(promptFile), { recursive: true });
  await rm(targetFile, { force: true }).catch(() => {});
  const promptText = await readFile(promptFile, "utf8").catch(() => item.prompt || "");
  if (!promptText.trim()) await writeFile(promptFile, item.prompt || "", "utf8");

  const runPrompt = buildCodexImageRunPrompt({
    root,
    projectFile: job.projectFile,
    promptFile,
    targetFile,
    item,
  });
  await writeFile(job.promptRunPath, runPrompt, "utf8");
  const command = buildCodexCommand({ codexPath, root, promptPath: job.promptRunPath });
  await appendFile(job.logPath, `[${new Date().toISOString()}] ${command}\n`, "utf8");

  await writeImageRun({
    ...await readImageRun(job.id, imageRunRoot),
    progress: imageProgress(job, 32),
    stage: `starting local Codex for ${item.type}:${item.id}`,
    item,
    targetAssetPath: item.targetAssetPath,
    targetFile,
    codexCommand: command,
    currentItemStartedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const itemStartedAt = Date.now();
  const exitCode = await spawnCodexImageProcess({
    codexPath,
    root,
    prompt: runPrompt,
    logPath: job.logPath,
    targetFile,
    maxRuntimeMs: Number(process.env.BOOKFRAMES_CODEX_IMAGE_TIMEOUT_MS || 12 * 60 * 1000),
    onStart: async (pid) => {
      await writeImageRun({
        ...await readImageRun(job.id, imageRunRoot),
        pid,
        progress: imageProgress(job, 44),
        stage: "local Codex image_gen running",
        updatedAt: new Date().toISOString(),
      });
    },
    onHeartbeat: async () => {
      const now = new Date();
      await writeImageRun({
        ...await readImageRun(job.id, imageRunRoot),
        progress: imageProgress(job, 44),
        stage: "local Codex image_gen running",
        heartbeatAt: now.toISOString(),
        elapsedSeconds: Math.round((Date.now() - itemStartedAt) / 1000),
        updatedAt: now.toISOString(),
      });
    },
  });

  await writeImageRun({
    ...await readImageRun(job.id, imageRunRoot),
    progress: imageProgress(job, 82),
    stage: "verifying generated image",
    exitCode,
    updatedAt: new Date().toISOString(),
  });
  if (exitCode !== 0) {
    const log = await readFile(job.logPath, "utf8").catch(() => "");
    const recovered = await recoverGeneratedImageFromCodexLog({
      logText: log,
      targetFile,
      startedAtMs: itemStartedAt,
      logPath: job.logPath,
    });
    if (!recovered) {
      throw new Error(`Local Codex exited with ${exitCode}: ${tailText(log, 1200)}`);
    }
    await writeImageRun({
      ...await readImageRun(job.id, imageRunRoot),
      progress: imageProgress(job, 86),
      stage: `recovered image after Codex exit ${exitCode}`,
      recoveredImagePath: recovered.sourcePath,
      recoveredAfterExitCode: exitCode,
      updatedAt: new Date().toISOString(),
    });
  }
  let targetInfo = await stat(targetFile).catch(() => null);
  if (!targetInfo?.isFile() || targetInfo.size === 0) {
    const log = await readFile(job.logPath, "utf8").catch(() => "");
    const recovered = await recoverGeneratedImageFromCodexLog({
      logText: log,
      targetFile,
      startedAtMs: itemStartedAt,
      logPath: job.logPath,
    });
    targetInfo = await stat(targetFile).catch(() => null);
    if (!recovered || !targetInfo?.isFile() || targetInfo.size === 0) {
      throw new Error(`Local Codex finished but did not write ${item.targetAssetPath}. ${tailText(log, 1200)}`);
    }
    await writeImageRun({
      ...await readImageRun(job.id, imageRunRoot),
      progress: imageProgress(job, 86),
      stage: "recovered image from Codex generated_images",
      recoveredImagePath: recovered.sourcePath,
      updatedAt: new Date().toISOString(),
    });
  }

  await writeImageRun({
    ...await readImageRun(job.id, imageRunRoot),
    progress: imageProgress(job, 90),
    stage: "refreshing BookFrames preview",
    updatedAt: new Date().toISOString(),
  });
  const refreshed = await renderExistingProject(job.projectFile, { imageProvider: "codex-local" });
  return {
    generated: [{
      type: item.type,
      id: item.id,
      imagePath: item.targetAssetPath,
      promptPath: item.promptPath,
      bytes: targetInfo.size,
    }],
    summary: refreshed.summary,
  };
}

async function recoverGeneratedImageFromCodexLog({
  logText,
  targetFile,
  startedAtMs,
  logPath,
}) {
  const targetInfo = await stat(targetFile).catch(() => null);
  if (targetInfo?.isFile() && targetInfo.size > 0) {
    return {
      sourcePath: targetFile,
      targetFile,
      bytes: targetInfo.size,
      alreadyCopied: true,
    };
  }
  const candidates = [];
  const seen = new Set();
  for (const sourcePath of parseCodexGeneratedImagePathsFromLog(logText)) {
    if (seen.has(sourcePath)) continue;
    seen.add(sourcePath);
    const info = await stat(sourcePath).catch(() => null);
    if (info?.isFile() && info.size > 0) {
      candidates.push({
        sourcePath,
        size: info.size,
        mtimeMs: info.mtimeMs,
        fromLog: true,
      });
    }
  }
  for (const item of await findRecentCodexGeneratedImages(startedAtMs - 60 * 1000)) {
    if (seen.has(item.sourcePath)) continue;
    seen.add(item.sourcePath);
    candidates.push(item);
  }
  const recent = candidates
    .filter((item) => item.mtimeMs >= startedAtMs - 60 * 1000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const picked = recent[0];
  if (!picked) return null;

  await mkdir(path.dirname(targetFile), { recursive: true });
  await cp(picked.sourcePath, targetFile, { force: true });
  const copied = await stat(targetFile).catch(() => null);
  if (!copied?.isFile() || copied.size === 0) return null;
  await appendFile(
    logPath,
    `\n[${new Date().toISOString()}] recovered generated image ${picked.sourcePath} -> ${targetFile}\n`,
    "utf8",
  ).catch(() => {});
  return {
    ...picked,
    targetFile,
    bytes: copied.size,
  };
}

export function parseCodexGeneratedImagePathsFromLog(logText) {
  const matches = String(logText || "").match(/\/[^\s'"`<>]+\/\.codex\/generated_images\/[^\s'"`<>]+\.(?:png|jpe?g|webp)/gi) || [];
  return [...new Set(matches.map((value) => value.replace(/[),.;]+$/g, "")))];
}

async function findRecentCodexGeneratedImages(afterMs) {
  const generatedRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "generated_images");
  const candidates = [];
  await walkGeneratedImageDir(generatedRoot, 0, async (filePath) => {
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile() || info.size <= 0 || info.mtimeMs < afterMs) return;
    candidates.push({
      sourcePath: filePath,
      size: info.size,
      mtimeMs: info.mtimeMs,
      fromGeneratedRoot: true,
    });
  }).catch(() => {});
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 24);
}

async function walkGeneratedImageDir(dir, depth, onFile) {
  if (depth > 3) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkGeneratedImageDir(filePath, depth + 1, onFile);
    } else if (entry.isFile() && /\.(?:png|jpe?g|webp)$/i.test(entry.name)) {
      await onFile(filePath);
    }
  }
}

function imageProgress(job, percent) {
  if (typeof job.progressBase === "number" && typeof job.progressSpan === "number") {
    return Math.min(96, Math.round(job.progressBase + (job.progressSpan * percent) / 100));
  }
  return percent;
}

function normalizeImageQueueItem(prompt) {
  return {
    type: prompt.type || "spread",
    id: prompt.id || prompt.spreadId || "next",
    title: prompt.title || "",
    promptPath: prompt.promptPath || "",
    targetAssetPath: prompt.targetAssetPath || "",
    prompt: prompt.prompt || "",
  };
}

export function buildCodexImageRunPrompt({ root = rootDir, projectFile, promptFile, targetFile, item }) {
  return [
    "你是 Codex，正在维护本地 BookFrames 绘本生成器。",
    "",
    "任务：在没有 OPENAI_API_KEY 的情况下，使用本地 Codex 内置 image generation 能力生成一张图片。",
    "",
    "## 工作区",
    `- Repo root: ${root}`,
    `- Project file: ${projectFile}`,
    `- Queue item: ${item.type}:${item.id}`,
    `- 输入 prompt 文件: ${promptFile}`,
    `- 输出目标: ${targetFile}`,
    "",
    "## 要求",
    "1. 读取输入 prompt 文件。",
    "2. 使用 Codex 内置图片生成能力生成图片；不要使用 OpenAI API key，不要调用外部 API 脚本。",
    "3. 将生成出的最终 PNG 复制或移动到输出目标路径。",
    "4. 不要修改源码；只生成这一张图片。",
    "5. 如果当前 codex exec 环境没有图片生成工具，请明确写出失败原因。",
    "",
  ].join("\n");
}

async function spawnCodexImageProcess({
  codexPath,
  root,
  prompt,
  logPath,
  targetFile,
  maxRuntimeMs = 12 * 60 * 1000,
  onStart,
  onHeartbeat,
}) {
  const args = [
    "exec",
    "--skip-git-repo-check",
    "-C",
    root,
    "--sandbox",
    "workspace-write",
    "-",
  ];
  const child = spawn(codexPath, args, {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  await onStart?.(child.pid);
  child.stdin.end(prompt);
  child.stdout.on("data", (chunk) => appendFile(logPath, chunk).catch(() => {}));
  child.stderr.on("data", (chunk) => appendFile(logPath, chunk).catch(() => {}));
  return new Promise((resolve, reject) => {
    let settled = false;
    let lastSize = -1;
    let stableCount = 0;
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      onHeartbeat?.().catch(() => {});
    }, 10000);
    const watchdog = setInterval(async () => {
      try {
        const info = targetFile ? await stat(targetFile).catch(() => null) : null;
        if (info?.isFile() && info.size > 0) {
          if (info.size === lastSize) stableCount += 1;
          else stableCount = 0;
          lastSize = info.size;
          if (stableCount >= 1) {
            await appendFile(logPath, `\n[${new Date().toISOString()}] target image is stable; continuing without waiting for Codex shutdown\n`, "utf8").catch(() => {});
            finish(0, true);
            return;
          }
        }
        if (Date.now() - startedAt > maxRuntimeMs) {
          if (info?.isFile() && info.size > 0) {
            await appendFile(logPath, `\n[${new Date().toISOString()}] timeout reached but target image exists; continuing\n`, "utf8").catch(() => {});
            finish(0, true);
          } else {
            finish(new Error(`Local Codex image generation timed out after ${Math.round(maxRuntimeMs / 1000)}s`));
          }
        }
      } catch (error) {
        finish(error);
      }
    }, 3000);
    function clearTimers() {
      clearInterval(heartbeat);
      clearInterval(watchdog);
    }
    function finish(value, killChild = false) {
      if (settled) return;
      settled = true;
      clearTimers();
      if (killChild && !child.killed) child.kill("SIGTERM");
      if (value instanceof Error) reject(value);
      else resolve(value);
    }
    child.on("error", (error) => {
      finish(error);
    });
    child.on("close", (code) => {
      finish(code);
    });
  });
}

async function writeImageRun(job) {
  await writeFile(job.jobPath, JSON.stringify(job, null, 2), "utf8");
  activeImageRuns.set(job.id, job);
  return job;
}

async function readImageRun(id, imageRunRoot = imageRunsDir) {
  const safeId = id.replace(/[^A-Za-z0-9_.-]/g, "");
  if (activeImageRuns.has(safeId)) return activeImageRuns.get(safeId);
  return JSON.parse(await readFile(path.join(imageRunRoot, `${safeId}.json`), "utf8"));
}

async function pauseImageRun(id, {
  imageRunRoot = imageRunsDir,
} = {}) {
  const safeId = id.replace(/[^A-Za-z0-9_.-]/g, "");
  const current = await readImageRun(safeId, imageRunRoot);
  const now = new Date().toISOString();
  const paused = {
    ...current,
    status: "paused",
    stage: "paused by user",
    error: null,
    pausedAt: now,
    updatedAt: now,
    heartbeatAt: now,
    pid: null,
  };
  const active = activeImageRuns.get(safeId);
  if (active) {
    active.status = "paused";
    active.stage = paused.stage;
    active.error = null;
  }
  const pid = Number(current.pid || active?.pid || 0);
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already exited.
    }
  }
  return writeImageRun(paused);
}

async function listImageRuns(imageRunRoot = imageRunsDir) {
  await mkdir(imageRunRoot, { recursive: true });
  const files = (await readdir(imageRunRoot)).filter((file) => file.endsWith(".json")).sort().reverse().slice(0, 20);
  const jobs = await Promise.all(files.map((file) => readFile(path.join(imageRunRoot, file), "utf8").then(JSON.parse).then(markStaleRun)));
  return jobs;
}

async function findRecentActiveImageRun({ imageRunRoot = imageRunsDir, projectPath, provider, mode }) {
  const jobs = await listImageRuns(imageRunRoot).catch(() => []);
  return jobs.find((job) => {
    return ["queued", "running"].includes(job.status)
      && job.projectPath === projectPath
      && job.provider === provider
      && job.mode === mode
      && isRecentlyUpdated(job, 12 * 60 * 1000);
  }) || null;
}

async function startUploadedBookRun(req, url, {
  root = rootDir,
  bookRunRoot = bookRunsDir,
  imageRunRoot = imageRunsDir,
  codexPath = codexBin,
} = {}) {
  const filename = sanitizeUploadedFileName(url.searchParams.get("filename") || "book.epub");
  const ext = path.extname(filename).toLowerCase();
  if (![".epub", ".pdf", ".txt", ".md", ".markdown"].includes(ext)) {
    throw new Error("Only EPUB, PDF, TXT, and MD book sources can be uploaded.");
  }
  const id = makeRequestId();
  const uploadDir = path.join(uploadRunsDir, id);
  await mkdir(uploadDir, { recursive: true });
  const uploadedSourcePath = path.join(uploadDir, filename);
  await writeFile(uploadedSourcePath, await readRequestBuffer(req, 512 * 1024 * 1024));
  const title = String(url.searchParams.get("title") || titleFromFilename(filename));
  const outDir = url.searchParams.get("outDir")
    ? resolveOutputDir(root, url.searchParams.get("outDir"))
    : path.join(root, "runs", `${slugify(title)}-${id.split("-").at(-1)}`);
  return startBookRun({
    sourcePath: uploadedSourcePath,
    outDir,
    title,
    languageMode: url.searchParams.get("languageMode") || "auto",
    spreadsPerChapter: url.searchParams.get("spreadsPerChapter") || "full-coverage",
    pdfEngine: url.searchParams.get("pdfEngine") || "auto",
    ocrLang: url.searchParams.get("ocrLang") || "",
    ocrMaxPages: url.searchParams.get("ocrMaxPages") || "",
    ocrRecognition: url.searchParams.get("ocrRecognition") || "",
    ocrScale: url.searchParams.get("ocrScale") || "",
    mineruLang: url.searchParams.get("mineruLang") || "",
  }, {
    root,
    bookRunRoot,
    imageRunRoot,
    codexPath,
  });
}

async function startBookRun(payload, {
  root = rootDir,
  bookRunRoot = bookRunsDir,
  imageRunRoot = imageRunsDir,
  codexPath = codexBin,
} = {}) {
  await mkdir(bookRunRoot, { recursive: true });
  const sourcePath = resolveLocalInputPath(payload.sourcePath);
  if (!sourcePath) throw new Error("sourcePath is required");
  const outDir = resolveOutputDir(root, payload.outDir || "runs/story");
  const existing = await findRecentActiveBookRun({
    bookRunRoot,
    sourcePath,
    outDir,
  });
  if (existing) return existing;
  const id = makeRequestId();
  const now = new Date().toISOString();
  const jobPath = path.join(bookRunRoot, `${id}.json`);
  const logPath = path.join(bookRunRoot, `${id}.log`);
  const job = {
    schemaVersion: 1,
    id,
    status: "queued",
    phase: "import",
    stage: "queued",
    progress: 0,
    sourcePath,
    outDir,
    title: String(payload.title || ""),
    languageMode: String(payload.languageMode || payload.language || "auto"),
    audienceAge: String(payload.audienceAge || payload.age || "6-9"),
    stylePreset: String(payload.stylePreset || payload.style || "warm-watercolor"),
    spreadsPerChapter: String(payload.spreadsPerChapter || "full-coverage"),
    ingestOptions: buildIngestOptions(payload),
    createdAt: now,
    updatedAt: now,
    jobPath,
    logPath,
  };
  await writeBookRun(job);
  activeBookRuns.set(id, job);
  runBookRunInBackground(job, { root, bookRunRoot, imageRunRoot, codexPath }).catch(() => {});
  return job;
}

async function runBookRunInBackground(job, {
  root = rootDir,
  bookRunRoot = bookRunsDir,
  imageRunRoot = imageRunsDir,
  codexPath = codexBin,
} = {}) {
  let importProgress = null;
  try {
    await writeBookRun({
      ...job,
      status: "running",
      phase: "import",
      stage: "importing and planning",
      progress: 5,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    importProgress = startBookRunImportHeartbeat(job, { bookRunRoot });
    let created = await createBookProject({
      sourcePath: job.sourcePath,
      outDir: job.outDir,
      title: job.title,
      audienceAge: job.audienceAge,
      stylePreset: job.stylePreset,
      spreadsPerChapter: job.spreadsPerChapter,
      languageProfile: job.languageMode,
      imageProvider: "codex-local",
      ingestOptions: {
        ...job.ingestOptions,
        ingestCacheDir: path.join(root, "runs", "_ingest-cache"),
        onProgress: importProgress.onProgress,
      },
      pagePlanProvider: isAutoSpreadsValue(job.spreadsPerChapter) && !isFullCoverageSpreadsValue(job.spreadsPerChapter)
        ? (ingest) => planPageCountsWithLocalCodex(ingest, {
          root,
          codexPath,
          job,
          bookRunRoot,
        })
        : undefined,
    });
    await importProgress.stop({
      event: "import-complete",
      stage: "import complete, proofreading OCR captions",
      progressHint: 17,
    });
    importProgress = null;
    const polished = await polishOcrCaptionsForProject(created.manifestPath, {
      root,
      codexPath,
      job,
      bookRunRoot,
      logPath: job.logPath,
    });
    if (polished.updated) {
      created = await renderExistingProject(created.manifestPath, { imageProvider: "codex-local" });
    }
    const sourceAdaptation = polished.updated
      ? { status: "skipped", updated: false, reason: "OCR caption proofreading already adapted this project" }
      : await adaptCaptionsToSourceForProject(created.manifestPath, {
        root,
        codexPath,
        job,
        bookRunRoot,
        logPath: job.logPath,
      });
    if (sourceAdaptation.updated) {
      created = await renderExistingProject(created.manifestPath, { imageProvider: "codex-local" });
    }
    const localized = await localizeCaptionsForLanguageMode(created.manifestPath, {
      root,
      codexPath,
      job,
      bookRunRoot,
    });
    if (localized.updated) {
      created = await renderExistingProject(created.manifestPath, { imageProvider: "preserve" });
    }
    const projectPath = projectUrlPath(root, created.manifestPath);
    const currentAfterImport = await readBookRun(job.id, bookRunRoot);
    const imported = {
      ...currentAfterImport,
      status: "drawing",
      phase: "drawing",
      stage: "drawing all queued images",
      progress: Math.max(Number(currentAfterImport.progress || 0), 20),
      projectPath,
      projectFile: created.manifestPath,
      projectDir: path.dirname(created.manifestPath),
      htmlPath: created.htmlPath,
      summary: created.summary,
      lint: created.lint,
      sourceAdaptation,
      localization: localized,
      updatedAt: new Date().toISOString(),
    };
    await writeBookRun(imported);
    const imageJob = await startImageRun({
      projectPath,
      provider: "codex-exec",
      mode: "all",
      limit: "all",
    }, {
      root,
      imageRunRoot,
      codexPath,
    });
    await writeBookRun({
      ...await readBookRun(job.id, bookRunRoot),
      imageRunId: imageJob.id,
      imageRunPath: imageJob.jobPath,
      updatedAt: new Date().toISOString(),
    });
    monitorImageRunForBookRun(job.id, imageJob.id, { bookRunRoot, imageRunRoot }).catch(() => {});
  } catch (error) {
    if (importProgress) {
      await importProgress.stop({
        event: "import-failed",
        stage: "import failed",
        progressHint: 100,
      }).catch(() => {});
      importProgress = null;
    }
    const failed = {
      ...await readBookRun(job.id, bookRunRoot).catch(() => job),
      status: "failed",
      phase: "failed",
      stage: "failed",
      progress: 100,
      error: error.message,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeBookRun(failed);
    activeBookRuns.delete(job.id);
  }
}

function startBookRunImportHeartbeat(job, { bookRunRoot = bookRunsDir } = {}) {
  const startedAt = Date.now();
  let stopped = false;
  let lastWriteAt = 0;
  let lastEvent = {};

  const writeProgress = async (event = {}, force = false) => {
    const nowMs = Date.now();
    if (!force && nowMs - lastWriteAt < 1200) return;
    lastWriteAt = nowMs;
    const current = await readBookRun(job.id, bookRunRoot).catch(() => null);
    if (!current || current.phase !== "import" || !["queued", "running"].includes(current.status)) return;
    const artifacts = await inspectBookImportArtifacts(job);
    const elapsedSeconds = Math.max(0, Math.round((nowMs - startedAt) / 1000));
    const now = new Date().toISOString();
    const pageCount = Number(event.pageCount || lastEvent.pageCount || artifacts.ocr?.pageCount || 0);
    const processedPages = Number(event.processedPages || lastEvent.processedPages || artifacts.ocr?.processedPages || 0);
    const progressHint = Number(event.progressHint || lastEvent.progressHint || 0);
    const artifactProgress = artifacts.ingestReportExists
      ? 16
      : artifacts.extractedTextExists
        ? 14
        : artifacts.mineruFileCount
          ? 11
          : 0;
    const elapsedProgress = Math.min(15, 5 + Math.floor(elapsedSeconds / 20));
    const progress = Math.max(
      Number(current.progress || 0),
      progressHint,
      artifactProgress,
      elapsedProgress,
    );
    const importStage = event.stage || inferBookImportStage(job, artifacts, lastEvent);

    await writeBookRun({
      ...current,
      stage: importStage,
      progress: Math.min(17, Math.max(5, progress)),
      heartbeatAt: now,
      updatedAt: now,
      importProgress: {
        ...(current.importProgress || {}),
        startedAt: current.startedAt || new Date(startedAt).toISOString(),
        elapsedSeconds,
        engine: event.engine || lastEvent.engine || artifacts.ocr?.engine || inferBookImportEngine(job, artifacts),
        pageCount: pageCount || artifacts.pageCount || null,
        processedPages: processedPages || null,
        recognition: event.recognition || lastEvent.recognition || artifacts.ocr?.recognition || current.ingestOptions?.ocrRecognition || null,
        scale: event.scale || lastEvent.scale || artifacts.ocr?.scale || current.ingestOptions?.ocrScale || null,
        sourceSizeMB: artifacts.sourceSizeMB,
        mineruFileCount: artifacts.mineruFileCount,
        artifactCount: artifacts.artifactCount,
        extractedTextReady: artifacts.extractedTextExists,
        ingestReportReady: artifacts.ingestReportExists,
        latestArtifactAt: artifacts.latestArtifactAt,
        cacheStatus: event.cacheStatus || lastEvent.cacheStatus || artifacts.cache?.status || null,
        cacheKey: event.cacheKey || lastEvent.cacheKey || artifacts.cache?.key || null,
        lastEvent: event.event || lastEvent.event || null,
      },
    });
  };

  const timer = setInterval(() => {
    if (stopped) return;
    writeProgress(lastEvent).catch(() => {});
  }, 5000);
  timer.unref?.();

  return {
    onProgress(event = {}) {
      lastEvent = {
        ...lastEvent,
        ...event,
      };
      writeProgress(lastEvent).catch(() => {});
    },
    async stop(event = {}) {
      stopped = true;
      clearInterval(timer);
      lastEvent = {
        ...lastEvent,
        ...event,
      };
      await writeProgress(lastEvent, true);
    },
  };
}

async function inspectBookImportArtifacts(job) {
  const result = {
    sourceSizeMB: null,
    artifactCount: 0,
    mineruFileCount: 0,
    extractedTextExists: false,
    ingestReportExists: false,
    latestArtifactAt: null,
    pageCount: null,
    ocr: null,
    cache: null,
  };
  try {
    const sourceStat = await stat(job.sourcePath);
    result.sourceSizeMB = Math.round(sourceStat.size / 1024 / 1024);
  } catch {}

  const sourceDir = path.join(job.outDir, "source");
  const mineruDir = path.join(sourceDir, "mineru");
  const files = await listFilesRecursiveSafe(sourceDir, 5000);
  const minMtimeMs = Date.parse(job.startedAt || job.createdAt || "") || 0;
  const freshFiles = [];
  for (const file of files) {
    try {
      const fileStat = await stat(file);
      if (minMtimeMs && fileStat.mtimeMs < minMtimeMs - 1000) continue;
      freshFiles.push(file);
      if (!result.latestArtifactAt || fileStat.mtimeMs > Date.parse(result.latestArtifactAt)) {
        result.latestArtifactAt = fileStat.mtime.toISOString();
      }
    } catch {}
  }
  result.artifactCount = freshFiles.length;
  result.mineruFileCount = freshFiles.filter((file) => file.startsWith(mineruDir + path.sep)).length;
  result.extractedTextExists = freshFiles.includes(path.join(sourceDir, "extracted.txt"));
  const ingestReportPath = path.join(sourceDir, "ingest-report.json");
  result.ingestReportExists = freshFiles.includes(ingestReportPath);
  if (result.ingestReportExists) {
    try {
      const report = JSON.parse(await readFile(ingestReportPath, "utf8"));
      result.pageCount = report.source?.pageCount || report.source?.pageAudit?.pageCount || null;
      result.ocr = report.source?.ocr || null;
      result.cache = report.source?.cache || null;
    } catch {}
  }
  return result;
}

async function listFilesRecursiveSafe(root, limit = 1000) {
  const files = [];
  async function visit(dir) {
    if (files.length >= limit) return;
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= limit) return;
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }
  await visit(root);
  return files;
}

function inferBookImportStage(job, artifacts, event) {
  if (artifacts.ingestReportExists) return "building chapters and page plan";
  if (artifacts.extractedTextExists) return "text extracted, building chapters";
  if (event?.pageCount && event?.processedPages) {
    return `running macOS Vision OCR ${event.processedPages}/${event.pageCount}`;
  }
  if (artifacts.mineruFileCount > 0) return "running MinerU OCR/layout extraction";
  if (path.extname(job.sourcePath).toLowerCase() === ".pdf") return "running PDF OCR/text extraction";
  return "importing and planning";
}

function inferBookImportEngine(job, artifacts) {
  if (artifacts.mineruFileCount > 0) return job.ingestOptions?.pdfEngine || "mineru";
  if (path.extname(job.sourcePath).toLowerCase() === ".pdf") {
    return job.ingestOptions?.pdfEngine === "auto" ? "native/macos-vision" : job.ingestOptions?.pdfEngine || "pdf";
  }
  return "text";
}

async function monitorImageRunForBookRun(bookRunId, imageRunId, { bookRunRoot = bookRunsDir, imageRunRoot = imageRunsDir } = {}) {
  const imageJob = await readImageRun(imageRunId, imageRunRoot).catch(() => null);
  if (!imageJob) return;
  const bookJob = await readBookRun(bookRunId, bookRunRoot).catch(() => null);
  if (!bookJob) return;
  if (bookJob.imageRunId && bookJob.imageRunId !== imageRunId) return;
  if (["superseded", "stale"].includes(imageJob.status)) {
    activeBookRuns.delete(bookRunId);
    return;
  }
  const isDone = imageJob.status === "completed" || imageJob.status === "failed";
  const status = imageJob.status === "completed" ? "ready_for_revision" : imageJob.status === "failed" ? "failed" : "drawing";
  await writeBookRun({
    ...bookJob,
    status,
    phase: status === "ready_for_revision" ? "revision" : status,
    stage: status === "ready_for_revision" ? "ready for revision" : imageJob.stage || "drawing",
    progress: status === "ready_for_revision" || status === "failed"
      ? 100
      : Math.min(98, Math.round(20 + (Number(imageJob.progress || 0) * 0.78))),
    imageRunStatus: imageJob.status,
    imageRunProgress: imageJob.progress,
    completedItems: imageJob.completedItems || 0,
    totalItems: imageJob.totalItems || 0,
    generated: imageJob.generated || [],
    summary: imageJob.summary || bookJob.summary,
    error: imageJob.error,
    completedAt: isDone ? new Date().toISOString() : bookJob.completedAt,
    heartbeatAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  if (isDone) {
    activeBookRuns.delete(bookRunId);
    return;
  }
  setTimeout(() => {
    monitorImageRunForBookRun(bookRunId, imageRunId, { bookRunRoot, imageRunRoot }).catch(() => {});
  }, 4000);
}

async function attachImageRunToBookRun(bookRunId, imageJob, {
  bookRunRoot = bookRunsDir,
  imageRunRoot = imageRunsDir,
} = {}) {
  const bookJob = await readBookRun(bookRunId, bookRunRoot);
  await writeBookRun({
    ...bookJob,
    status: "drawing",
    phase: "drawing",
    stage: imageJob.stage || "drawing all queued images",
    progress: Math.max(Number(bookJob.progress || 0), 18),
    imageRunId: imageJob.id,
    imageRunPath: imageJob.jobPath,
    imageRunStatus: imageJob.status,
    imageRunProgress: imageJob.progress,
    completedItems: imageJob.completedItems || 0,
    totalItems: imageJob.totalItems || 0,
    updatedAt: new Date().toISOString(),
  });
  monitorImageRunForBookRun(bookRunId, imageJob.id, { bookRunRoot, imageRunRoot }).catch(() => {});
}

async function planPageCountsWithLocalCodex(ingest, {
  root = rootDir,
  codexPath = codexBin,
  job,
  bookRunRoot = bookRunsDir,
} = {}) {
  const now = new Date().toISOString();
  const planningDir = path.join(job.outDir, "planning");
  const rawPlanPath = path.join(planningDir, "page-plan.codex.json");
  await mkdir(planningDir, { recursive: true });
  const sketches = pagePlanChapterSketches(ingest);
  const shardSize = clampIntegerEnv(process.env.BOOKFRAMES_CODEX_PAGE_PLAN_SHARD_SIZE, 4, 1, 8);
  const concurrency = clampIntegerEnv(process.env.BOOKFRAMES_CODEX_PAGE_PLAN_CONCURRENCY, 3, 1, 6);
  const shards = chunkArray(sketches, shardSize);
  const heuristic = buildHeuristicPagePlan(ingest, {
    mode: "heuristic-seed",
    provider: "heuristic",
    reason: "Seed plan used as a per-chapter fallback during parallel local Codex planning.",
  });
  const currentJob = await readBookRun(job.id, bookRunRoot);
  await writeBookRun({
    ...currentJob,
    status: "running",
    phase: "planning",
    stage: "text imported; planning chapter page counts in parallel",
    progress: Math.max(Number(currentJob.progress || 0), 18),
    pagePlanMode: "codex-auto",
    pagePlanProvider: "local-codex-parallel",
    pagePlanCompletedChapters: 0,
    pagePlanTotalChapters: sketches.length,
    pagePlanShardCount: shards.length,
    pagePlanConcurrency: concurrency,
    updatedAt: now,
  });
  await appendFile(job.logPath, `\n[${now}] planning ${sketches.length} chapter page counts with local Codex in ${shards.length} shard(s), concurrency ${concurrency}\n`, "utf8").catch(() => {});

  const fallbackByIndex = new Map(heuristic.chapters.map((chapter) => [chapter.chapterIndex, chapter]));
  const warnings = [];
  let completedChapters = 0;

  const shardResults = await mapWithConcurrency(shards, concurrency, async (shard, shardIndex) => {
    try {
      const chapters = await planPageCountShardWithLocalCodex({
        root,
        codexPath,
        job,
        planningDir,
        shard,
        shardIndex,
        fallbackByIndex,
      });
      return { chapters };
    } catch (error) {
      const message = `Shard ${shardIndex + 1} fell back to heuristic page counts: ${error.message}`;
      warnings.push(message);
      await appendFile(job.logPath, `\n[${new Date().toISOString()}] ${message}\n`, "utf8").catch(() => {});
      return {
        chapters: shard.map((chapter) => fallbackByIndex.get(chapter.chapterIndex)).filter(Boolean),
      };
    } finally {
      completedChapters += shard.length;
      await updatePagePlanProgress(job, bookRunRoot, {
        completedChapters,
        totalChapters: sketches.length,
        shardIndex,
      });
    }
  });

  const chapters = shardResults
    .flatMap((result) => result.chapters || [])
    .sort((a, b) => a.chapterIndex - b.chapterIndex);
  const plan = normalizePagePlan({
    mode: "codex-auto",
    provider: "local-codex-parallel",
    reason: `Local Codex planned page counts after text import using ${shards.length} parallel chapter shard(s).`,
    fallbackReason: warnings.length ? `${warnings.length} chapter shard(s) used heuristic fallback.` : null,
    warnings,
    chapters,
  }, ingest, {
    mode: "codex-auto",
    provider: "local-codex-parallel",
  });
  return commitPagePlan(job, bookRunRoot, rawPlanPath, plan, {
    pagePlanCompletedChapters: sketches.length,
    pagePlanTotalChapters: sketches.length,
    pagePlanShardCount: shards.length,
    pagePlanConcurrency: concurrency,
    pagePlanWarning: warnings.join(" | ") || undefined,
  });
}

async function readCodexPagePlan(rawPlanPath, ingest) {
  return normalizePagePlan(await readJsonFile(rawPlanPath), ingest, {
    mode: "codex-auto",
    provider: "local-codex",
  });
}

async function planPageCountShardWithLocalCodex({
  root,
  codexPath,
  job,
  planningDir,
  shard,
  shardIndex,
  fallbackByIndex,
}) {
  const outputPath = path.join(
    planningDir,
    `page-plan.part-${String(shardIndex + 1).padStart(2, "0")}-${safeFileSegment(shard[0]?.chapterId || "chapter")}.codex.json`,
  );
  await rm(outputPath, { force: true }).catch(() => {});
  const prompt = buildLocalCodexPagePlanShardPrompt({
    title: job.title,
    outputPath,
    shard,
  });
  try {
    await spawnCodexTextProcess({
      codexPath,
      root,
      prompt,
      logPath: job.logPath,
      targetFile: outputPath,
      maxRuntimeMs: Number(process.env.BOOKFRAMES_CODEX_PAGE_PLAN_SHARD_TIMEOUT_MS || 2 * 60 * 1000),
      timeoutLabel: `page planning shard ${shardIndex + 1}`,
    });
    return readCodexPagePlanShard(outputPath, shard, fallbackByIndex);
  } catch (error) {
    const recovered = await readCodexPagePlanShard(outputPath, shard, fallbackByIndex).catch(() => null);
    if (recovered?.length) {
      await appendFile(job.logPath, `\n[${new Date().toISOString()}] recovered page plan shard ${shardIndex + 1} after: ${error.message}\n`, "utf8").catch(() => {});
      return recovered;
    }
    throw error;
  }
}

export function buildLocalCodexPagePlanShardPrompt({
  title = "Untitled",
  outputPath,
  shard = [],
  minSpreads = 1,
  maxSpreads = 8,
}) {
  return [
    "# BookFrames parallel chapter page planning",
    "",
    "你是本地 Codex，正在为 BookFrames 绘本导入流程做并行页数规划。",
    "前置流程已经完成：书源已经导入，章节已经切分。你只需要判断本分片里每章要拆成多少页。",
    `书名：${title || "Untitled"}`,
    `输出文件：${outputPath}`,
    "",
    "请创建或覆盖这个输出文件，只写合法 JSON，不要写 Markdown、解释文字或注释。",
    "",
    "JSON schema:",
    "```json",
    JSON.stringify({
      provider: "local-codex-parallel",
      chapters: [
        {
          chapterIndex: 0,
          chapterId: "ch-01",
          title: "Chapter title",
          spreadCount: 3,
          reason: "why this chapter needs this many picture-book pages",
        },
      ],
    }, null, 2),
    "```",
    "",
    "规划规则：",
    `- spreadCount 必须是 ${minSpreads}-${maxSpreads} 的整数。`,
    "- 只输出下面给出的章节，不要新增、删除或重排章节。",
    "- 短章、过渡章可以 1-2 页；动作密集或场景变化多的章节 3-5 页；非常长且视觉节拍丰富的章节 6-8 页。",
    "- 不要平均分配；每章根据文本长度、场景变化、角色行动和适合儿童绘本的节奏独立判断。",
    "- reason 用简短中文说明，方便前端审稿。",
    "",
    "本分片章节摘要：",
    "```json",
    JSON.stringify(shard, null, 2),
    "```",
  ].join("\n");
}

async function readCodexPagePlanShard(outputPath, shard, fallbackByIndex) {
  const raw = await readJsonFile(outputPath);
  const items = Array.isArray(raw) ? raw : Array.isArray(raw.chapters) ? raw.chapters : [raw];
  return shard.map((chapter, position) => {
    const item = findPagePlanItem(items, chapter, position) || {};
    const fallback = fallbackByIndex.get(chapter.chapterIndex) || chapter;
    const spreadCount = parseSpreadCount(item.spreadCount ?? item.pages ?? item.pageCount, fallback.spreadCount || 3);
    return {
      ...fallback,
      chapterIndex: chapter.chapterIndex,
      chapterId: chapter.chapterId,
      title: chapter.title,
      spreadCount,
      reason: String(item.reason || item.rationale || item.note || fallback.reason || `Planned ${spreadCount} pages.`).trim(),
    };
  });
}

function findPagePlanItem(items, chapter, position) {
  return items.find((item) => Number(item.chapterIndex) === chapter.chapterIndex)
    || items.find((item) => String(item.chapterId || item.id || "") === String(chapter.chapterId))
    || items[position]
    || null;
}

async function updatePagePlanProgress(job, bookRunRoot, {
  completedChapters,
  totalChapters,
  shardIndex,
}) {
  const current = await readBookRun(job.id, bookRunRoot).catch(() => null);
  if (!current || current.phase !== "planning") return;
  const ratio = totalChapters ? completedChapters / totalChapters : 0;
  await writeBookRun({
    ...current,
    stage: `planning chapter page counts in parallel (${completedChapters}/${totalChapters})`,
    progress: Math.max(Number(current.progress || 0), Math.min(20, 18 + Math.floor(ratio * 2))),
    pagePlanCompletedChapters: completedChapters,
    pagePlanTotalChapters: totalChapters,
    pagePlanLastShard: shardIndex + 1,
    heartbeatAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function clampIntegerEnv(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function spreadLimitFromEnv(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.toLowerCase() === "all" || raw.toLowerCase() === "unlimited") {
    return Number.POSITIVE_INFINITY;
  }
  const numeric = Number(raw);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : Number.POSITIVE_INFINITY;
}

function safeFileSegment(value) {
  return String(value || "part").replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "part";
}

async function commitPagePlan(job, bookRunRoot, rawPlanPath, plan, extra = {}) {
  await writeFile(rawPlanPath, JSON.stringify(plan, null, 2), "utf8");
  await writeBookRun({
    ...await readBookRun(job.id, bookRunRoot),
    pagePlanMode: plan.mode,
    pagePlanProvider: plan.provider,
    plannedSpreadCount: plan.totalSpreadCount,
    ...extra,
    updatedAt: extra.updatedAt || new Date().toISOString(),
  });
  return plan;
}

export async function polishOcrCaptionsForProject(manifestPath, {
  root = rootDir,
  codexPath = codexBin,
  job,
  bookRunRoot = bookRunsDir,
  logPath,
  force = false,
} = {}) {
  const project = await readJsonFile(manifestPath);
  if (!force && !shouldPolishOcrProject(project)) {
    return { status: "skipped", updated: false, reason: "source is not an OCR PDF project" };
  }
  if (!force && project.book?.ocrPolish?.status === "completed") {
    return { status: "skipped", updated: false, reason: "OCR captions were already polished" };
  }

  const candidates = collectOcrCaptionPolishCandidates(project, {
    limit: spreadLimitFromEnv(process.env.BOOKFRAMES_OCR_POLISH_MAX_SPREADS),
  });
  if (!candidates.length) {
    return { status: "skipped", updated: false, reason: "no spreads to polish" };
  }

  const projectDir = path.dirname(manifestPath);
  const planningDir = path.join(projectDir, "planning");
  const outputPath = path.join(planningDir, "ocr-caption-polish.codex.json");
  const appliedPath = path.join(planningDir, "ocr-caption-polish.applied.json");
  const polishLogPath = logPath || path.join(planningDir, "ocr-caption-polish.log");
  await mkdir(planningDir, { recursive: true });

  const startedAt = new Date().toISOString();
  await updateBookRunForOcrPolish(job, bookRunRoot, {
    status: "running",
    phase: "proofreading",
    stage: "proofreading OCR captions with local Codex",
    progress: 18,
    ocrPolishPendingCount: candidates.length,
  });
  await appendFile(polishLogPath, `\n[${startedAt}] proofreading ${candidates.length} OCR-derived captions with local Codex\n`, "utf8").catch(() => {});
  await rm(outputPath, { force: true }).catch(() => {});

  const prompt = buildOcrCaptionPolishPrompt({
    manifestPath,
    outputPath,
    project,
    candidates,
  });

  try {
    await spawnCodexTextProcess({
      codexPath,
      root,
      prompt,
      logPath: polishLogPath,
      targetFile: outputPath,
      maxRuntimeMs: Number(process.env.BOOKFRAMES_CODEX_OCR_POLISH_TIMEOUT_MS || 5 * 60 * 1000),
      timeoutLabel: "OCR caption proofreading",
    });

    const corrections = await readOcrCaptionCorrections(outputPath);
    const applied = applyOcrCaptionCorrectionsToProject(project, corrections, {
      provider: "local-codex",
      updatedAt: new Date().toISOString(),
    });
    if (!applied.updatedCount) {
      throw new Error("Local Codex did not return any usable OCR caption corrections.");
    }
    project.book.ocrPolish = {
      status: "completed",
      provider: "local-codex",
      correctedSpreadCount: applied.updatedCount,
      requestedSpreadCount: candidates.length,
      outputPath: path.relative(projectDir, outputPath),
      appliedPath: path.relative(projectDir, appliedPath),
      updatedAt: applied.updatedAt,
    };
    await writeOcrPolishPlanningArtifacts(projectDir, project);
    await writeFile(appliedPath, JSON.stringify({
      ...project.book.ocrPolish,
      spreads: applied.spreads,
    }, null, 2), "utf8");
    await writeFile(manifestPath, JSON.stringify(project, null, 2), "utf8");
    await updateBookRunForOcrPolish(job, bookRunRoot, {
      ocrPolishStatus: "completed",
      ocrPolishCorrectedCount: applied.updatedCount,
      ocrPolishPendingCount: 0,
    });
    await appendFile(polishLogPath, `\n[${new Date().toISOString()}] applied ${applied.updatedCount} OCR caption corrections\n`, "utf8").catch(() => {});
    return {
      status: "completed",
      updated: true,
      correctedCount: applied.updatedCount,
      requestedCount: candidates.length,
      outputPath,
      appliedPath,
    };
  } catch (error) {
    const recovered = await recoverOcrCaptionPolishOutput({
      manifestPath,
      outputPath,
      appliedPath,
      projectDir,
      job,
      bookRunRoot,
      polishLogPath,
      candidates,
      error,
    });
    if (recovered) return recovered;
    await appendFile(polishLogPath, `\n[${new Date().toISOString()}] OCR caption proofreading failed; continuing with original OCR text: ${error.message}\n`, "utf8").catch(() => {});
    await updateBookRunForOcrPolish(job, bookRunRoot, {
      ocrPolishStatus: "failed",
      ocrPolishError: error.message,
      ocrPolishPendingCount: candidates.length,
    });
    return {
      status: "failed",
      updated: false,
      error: error.message,
      requestedCount: candidates.length,
    };
  }
}

export async function adaptCaptionsToSourceForProject(manifestPath, {
  root = rootDir,
  codexPath = codexBin,
  job,
  bookRunRoot = bookRunsDir,
  logPath,
  force = false,
} = {}) {
  const project = await readJsonFile(manifestPath);
  if (!force && !shouldAdaptSourceProject(project)) {
    return { status: "skipped", updated: false, reason: "source adaptation is not needed for this project" };
  }
  if (!force && project.book?.sourceAdaptation?.status === "completed") {
    return { status: "skipped", updated: false, reason: "source adaptation already completed" };
  }

  const candidates = collectSourceAdaptationCandidates(project, {
    limit: spreadLimitFromEnv(process.env.BOOKFRAMES_SOURCE_ADAPT_MAX_SPREADS),
  });
  if (!candidates.length) {
    return { status: "skipped", updated: false, reason: "no spreads to adapt" };
  }

  const projectDir = path.dirname(manifestPath);
  const planningDir = path.join(projectDir, "planning");
  const appliedPath = path.join(planningDir, "source-adaptation.applied.json");
  const adaptationLogPath = logPath || path.join(planningDir, "source-adaptation.log");
  await mkdir(planningDir, { recursive: true });

  const batchSize = Math.max(1, Number(process.env.BOOKFRAMES_SOURCE_ADAPT_BATCH_SIZE || 16));
  const totalBatches = Math.ceil(candidates.length / batchSize);
  const maxBatches = Math.max(1, Number(process.env.BOOKFRAMES_SOURCE_ADAPT_MAX_BATCHES || totalBatches));
  const startedAt = new Date().toISOString();
  await updateBookRunForOcrPolish(job, bookRunRoot, {
    status: "running",
    phase: "adapting",
    stage: `adapting source text into picture-book pages (${Math.min(totalBatches, maxBatches)} batch(es))`,
    progress: 18,
    sourceAdaptationPendingCount: candidates.length,
    sourceAdaptationBatchSize: batchSize,
  });
  await appendFile(adaptationLogPath, `\n[${startedAt}] adapting ${candidates.length} source-grounded spread(s) with local Codex\n`, "utf8").catch(() => {});

  let currentProject = project;
  const appliedSpreads = [];
  try {
    for (let batchIndex = 0; batchIndex < totalBatches && batchIndex < maxBatches; batchIndex += 1) {
      const batch = candidates.slice(batchIndex * batchSize, (batchIndex + 1) * batchSize);
      const outputPath = path.join(planningDir, `source-adaptation.part-${String(batchIndex + 1).padStart(2, "0")}.codex.json`);
      let corrections = await readOcrCaptionCorrections(outputPath).catch(() => null);
      if (!corrections) {
        await rm(outputPath, { force: true }).catch(() => {});
        const prompt = buildSourceAdaptationPrompt({
          manifestPath,
          outputPath,
          project: currentProject,
          candidates: batch,
          batchIndex: batchIndex + 1,
          totalBatches,
        });
        await spawnCodexTextProcess({
          codexPath,
          root,
          prompt,
          logPath: adaptationLogPath,
          targetFile: outputPath,
          maxRuntimeMs: Number(process.env.BOOKFRAMES_CODEX_SOURCE_ADAPT_TIMEOUT_MS || 5 * 60 * 1000),
          timeoutLabel: "source-grounded picture-book adaptation",
        });
        corrections = await readOcrCaptionCorrections(outputPath);
      }
      const applied = applySourceAdaptationsToProject(currentProject, corrections, {
        provider: "local-codex",
        updatedAt: new Date().toISOString(),
      });
      appliedSpreads.push(...applied.spreads);
      await updateBookRunForOcrPolish(job, bookRunRoot, {
        sourceAdaptationStatus: "running",
        sourceAdaptationCorrectedCount: appliedSpreads.length,
        sourceAdaptationPendingCount: Math.max(0, candidates.length - appliedSpreads.length),
        stage: `adapted source batch ${batchIndex + 1}/${totalBatches}`,
      });
    }

    if (!appliedSpreads.length) {
      throw new Error("Local Codex did not return any usable source adaptations.");
    }
    const completedAt = new Date().toISOString();
    currentProject.book = currentProject.book || {};
    currentProject.book.sourceAdaptation = {
      status: appliedSpreads.length < candidates.length ? "partial" : "completed",
      provider: "local-codex",
      adaptedSpreadCount: appliedSpreads.length,
      requestedSpreadCount: candidates.length,
      appliedPath: path.relative(projectDir, appliedPath),
      updatedAt: completedAt,
    };
    await writeOcrPolishPlanningArtifacts(projectDir, currentProject, "source_adapted_captions");
    await writeFile(appliedPath, JSON.stringify({
      ...currentProject.book.sourceAdaptation,
      spreads: appliedSpreads,
    }, null, 2), "utf8");
    await writeFile(manifestPath, JSON.stringify(currentProject, null, 2), "utf8");
    await updateBookRunForOcrPolish(job, bookRunRoot, {
      sourceAdaptationStatus: currentProject.book.sourceAdaptation.status,
      sourceAdaptationCorrectedCount: appliedSpreads.length,
      sourceAdaptationPendingCount: Math.max(0, candidates.length - appliedSpreads.length),
    });
    await appendFile(adaptationLogPath, `\n[${completedAt}] applied ${appliedSpreads.length} source-grounded spread adaptations\n`, "utf8").catch(() => {});
    return {
      status: currentProject.book.sourceAdaptation.status,
      updated: true,
      adaptedCount: appliedSpreads.length,
      requestedCount: candidates.length,
      appliedPath,
    };
  } catch (error) {
    await appendFile(adaptationLogPath, `\n[${new Date().toISOString()}] source adaptation failed; continuing with heuristic captions: ${error.message}\n`, "utf8").catch(() => {});
    await updateBookRunForOcrPolish(job, bookRunRoot, {
      sourceAdaptationStatus: "failed",
      sourceAdaptationError: error.message,
      sourceAdaptationPendingCount: candidates.length,
    });
    return {
      status: "failed",
      updated: false,
      error: error.message,
      requestedCount: candidates.length,
    };
  }
}

async function recoverOcrCaptionPolishOutput({
  manifestPath,
  outputPath,
  appliedPath,
  projectDir,
  job,
  bookRunRoot,
  polishLogPath,
  candidates,
  error,
}) {
  try {
    const project = await readJsonFile(manifestPath);
    const corrections = await readOcrCaptionCorrections(outputPath);
    const applied = applyOcrCaptionCorrectionsToProject(project, corrections, {
      provider: "local-codex",
      updatedAt: new Date().toISOString(),
    });
    if (!applied.updatedCount) return null;
    project.book.ocrPolish = {
      status: "completed",
      provider: "local-codex",
      correctedSpreadCount: applied.updatedCount,
      requestedSpreadCount: candidates.length,
      recoveredAfterError: error.message,
      outputPath: path.relative(projectDir, outputPath),
      appliedPath: path.relative(projectDir, appliedPath),
      updatedAt: applied.updatedAt,
    };
    await writeOcrPolishPlanningArtifacts(projectDir, project);
    await writeFile(appliedPath, JSON.stringify({
      ...project.book.ocrPolish,
      spreads: applied.spreads,
    }, null, 2), "utf8");
    await writeFile(manifestPath, JSON.stringify(project, null, 2), "utf8");
    await updateBookRunForOcrPolish(job, bookRunRoot, {
      ocrPolishStatus: "completed",
      ocrPolishCorrectedCount: applied.updatedCount,
      ocrPolishPendingCount: 0,
      ocrPolishRecoveredAfterError: error.message,
    });
    await appendFile(polishLogPath, `\n[${new Date().toISOString()}] recovered ${applied.updatedCount} OCR caption corrections after: ${error.message}\n`, "utf8").catch(() => {});
    return {
      status: "completed",
      updated: true,
      recoveredAfterError: error.message,
      correctedCount: applied.updatedCount,
      requestedCount: candidates.length,
      outputPath,
      appliedPath,
    };
  } catch {
    return null;
  }
}

export function buildOcrCaptionPolishPrompt({ manifestPath, outputPath, project, candidates }) {
  const sourceLanguage = project.book?.languageProfile?.sourceLanguage
    || project.book?.languageProfile?.primary
    || project.book?.language
    || "zh";
  return [
    "# BookFrames OCR caption proofreading",
    "",
    "你是 Codex，正在为本地 BookFrames 绘本生成器清理 OCR 文本。",
    `项目文件：${manifestPath}`,
    `输出 JSON：${outputPath}`,
    `书名：${project.book?.title || ""}`,
    `源语言：${sourceLanguage}`,
    "",
    "请只创建或覆盖“输出 JSON”这个文件，不要修改 bookframes.json，不要修改源码。",
    "",
    "目标：把 OCR 产生的错字、页眉、页码、断行、乱码整理成适合绘本生成的干净文本。",
    "- caption：每页 18-56 个中文字符左右；如果源语言不是中文，则使用对应源语言的简短自然句。",
    "- sceneSummary：45-140 个中文字符左右；描述这页要画的一个清晰场景，不要出现页码、目录、乱码或 OCR 残片。",
    "- 修正明显 OCR 错字，例如“演郎”应理解为“演讲”，“人门”应理解为“入门”，“用米”应理解为“用来”。",
    "- 只基于给出的片段做保守整理，不要新增人物、事件或结论。",
    "- 不要输出 Markdown，不要在图片里加文字，不要保留页眉书名。",
    "",
    "输出必须是合法 JSON，结构如下：",
    "```json",
    JSON.stringify({
      spreads: [
        {
          id: "ch-01-sp-01",
          caption: "1912年，卡耐基开始教授演讲，帮助学员面对上台恐惧。",
          sceneSummary: "温暖的课堂里，紧张的学员围坐在一起，老师鼓励他们练习公开表达。",
        },
      ],
    }, null, 2),
    "```",
    "",
    "待校对页面：",
    "```json",
    JSON.stringify(candidates, null, 2),
    "```",
  ].join("\n");
}

export function buildSourceAdaptationPrompt({
  manifestPath,
  outputPath,
  project,
  candidates,
  batchIndex = 1,
  totalBatches = 1,
}) {
  const sourceLanguage = inferProjectCaptionSourceLanguage(project);
  return [
    "# BookFrames source-grounded picture-book adaptation",
    "",
    "你是 Codex，正在为本地 BookFrames 绘本生成器把上传书的真实内容改编成绘本页。",
    `项目文件：${manifestPath}`,
    `输出 JSON：${outputPath}`,
    `书名：${project.book?.title || ""}`,
    `源语言：${sourceLanguage}`,
    `当前批次：${batchIndex}/${totalBatches}`,
    "",
    "请只创建或覆盖“输出 JSON”这个文件，不要修改 bookframes.json，不要修改源码。",
    "",
    "目标：每一页都必须能看出来自上传书的具体章节、案例、原则或情节，而不是泛泛的励志句或随机场景。",
    "- caption：写成适合朗读的一句话；英文原书用自然英文，中文原书用中文；不要照抄目录、版权、宣传语或页眉。",
    "- sceneSummary：描述一个能画出来的具体画面，要包含人物行动、场景和情绪；不要要求图片里出现文字。",
    "- 只基于 sourcePassage 做保守改编，可以压缩和儿童化表达，但不要新增原书没有的人物、事件或结论。",
    "- 如果片段是原则总结，要把原则转化成一个可视化的生活场景，而不是只写抽象口号。",
    "- 不要输出 Markdown，不要解释。",
    "",
    "输出必须是合法 JSON，结构如下：",
    "```json",
    JSON.stringify({
      spreads: [
        {
          id: "ch-01-sp-01",
          caption: "A young student learns that criticism closes a heart faster than anger.",
          sceneSummary: "A warm classroom scene where a teacher gently redirects a frustrated student from blame toward understanding.",
        },
      ],
    }, null, 2),
    "```",
    "",
    "待改编页面：",
    "```json",
    JSON.stringify(candidates, null, 2),
    "```",
  ].join("\n");
}

export function applyOcrCaptionCorrectionsToProject(project, corrections, {
  provider = "local-codex",
  updatedAt = new Date().toISOString(),
  revisionType = "ocr_polish",
} = {}) {
  const entries = Array.isArray(corrections) ? corrections : corrections?.spreads;
  const byId = new Map((entries || [])
    .map((entry) => [String(entry.id || entry.spreadId || "").trim(), entry])
    .filter(([id]) => id));
  const applied = [];
  const revisionField = revisionType === "source_adaptation" ? "sourceAdaptation" : "ocrPolish";
  const lineSource = revisionType === "source_adaptation" ? "source_adapted" : "ocr_polished";
  const redrawReason = revisionType === "source_adaptation" ? "source_content_adapted" : "ocr_caption_polished";
  const narrativeSource = revisionType === "source_adaptation" ? "source_adapted_captions" : "ocr_polished_captions";

  for (const chapter of project.chapters || []) {
    for (const spread of chapter.spreads || []) {
      const correction = byId.get(spread.id);
      if (!correction) continue;
      const caption = normalizePolishedText(correction.caption || correction.readerCaption, 160);
      const sceneSummary = normalizePolishedText(correction.sceneSummary || correction.scene || correction.summary, 360);
      const nextCaption = caption || normalizePolishedText(sceneSummary, 100);
      const nextSceneSummary = sceneSummary || nextCaption;
      if (!nextCaption) continue;

      const previousRevision = spread[revisionField] || {};
      const originalCaption = previousRevision.originalCaption || spread.caption || "";
      const originalSourceExcerpt = previousRevision.originalSourceExcerpt || spread.sourceExcerpt || "";
      const originalScenePrompt = previousRevision.originalScenePrompt || spread.scenePrompt || "";
      spread[revisionField] = {
        status: "applied",
        provider,
        revisionType,
        originalCaption,
        originalSourceExcerpt,
        originalScenePrompt,
        caption: nextCaption,
        sceneSummary: nextSceneSummary,
        updatedAt,
      };
      if (!spread.sourceExcerptRaw && spread.sourceExcerpt) {
        spread.sourceExcerptRaw = spread.sourceExcerpt;
      }
      spread.caption = nextCaption;
      spread.readerCaption = nextCaption;
      spread.sourceExcerpt = nextCaption;
      spread.scenePrompt = buildPolishedScenePrompt(project, spread, nextSceneSummary);
      refreshCaptionI18nAfterPolish(project, spread, nextCaption, lineSource);
      markSpreadImageForOcrRedraw(spread, updatedAt, redrawReason);
      applied.push({
        id: spread.id,
        chapterId: chapter.id,
        caption: nextCaption,
        sceneSummary: nextSceneSummary,
      });
    }
  }
  if (applied.length) refreshProjectNarrativeFromPolishedCaptions(project, narrativeSource);

  return {
    updated: Boolean(applied.length),
    updatedCount: applied.length,
    updatedAt,
    spreads: applied,
  };
}

export function applySourceAdaptationsToProject(project, corrections, {
  provider = "local-codex",
  updatedAt = new Date().toISOString(),
} = {}) {
  return applyOcrCaptionCorrectionsToProject(project, corrections, {
    provider,
    updatedAt,
    revisionType: "source_adaptation",
  });
}

async function writeOcrPolishPlanningArtifacts(projectDir, project, narrativeSource = "ocr_polished_captions") {
  refreshProjectNarrativeFromPolishedCaptions(project, narrativeSource);
  const planningDir = path.join(projectDir, "planning");
  await mkdir(planningDir, { recursive: true });
  await writeFile(path.join(planningDir, "story-arc.json"), JSON.stringify(project.storyArc || {}, null, 2), "utf8");
  await writeFile(path.join(planningDir, "planning-review.json"), JSON.stringify(project.planningReview || {}, null, 2), "utf8");
  await writeFile(path.join(planningDir, "character-review.json"), JSON.stringify(project.characterReview || {}, null, 2), "utf8");
}

function refreshProjectNarrativeFromPolishedCaptions(project, source = "ocr_polished_captions") {
  const chapters = project.chapters || [];
  const spreads = chapters.flatMap((chapter) => chapter.spreads || []);
  let polishedChapterCount = 0;
  for (const chapter of chapters) {
    const captions = (chapter.spreads || []).map((spread) => spread.caption || spread.readerCaption || "").filter(Boolean);
    if (!captions.length) continue;
    if (!chapter.ocrPolish && chapter.summary) {
      chapter.ocrPolish = { originalSummary: chapter.summary };
    }
    chapter.summary = summarizeCleanCaptions(captions, 260);
    polishedChapterCount += 1;
  }
  if (spreads.length) {
    const midpoint = spreads[Math.floor(spreads.length / 2)] || spreads[0];
    project.storyArc = {
      ...(project.storyArc || {}),
      premise: summarizeCleanCaptions(chapters.map((chapter) => chapter.summary || chapter.title || "").filter(Boolean), 180),
      opening: summarizeCleanCaptions([spreads[0]?.caption || spreads[0]?.readerCaption || ""], 160),
      midpoint: summarizeCleanCaptions([midpoint.caption || midpoint.readerCaption || ""], 160),
      closing: summarizeCleanCaptions([spreads[spreads.length - 1]?.caption || spreads[spreads.length - 1]?.readerCaption || ""], 160),
      sceneCount: spreads.length,
      source,
      updatedAt: new Date().toISOString(),
    };
  }
  const reviewKey = source === "source_adapted_captions" ? "sourceAdaptation" : "ocrPolish";
  project.planningReview = {
    ...(project.planningReview || {}),
    [reviewKey]: {
      status: "completed",
      refreshedChapterSummaries: polishedChapterCount,
      source,
      updatedAt: new Date().toISOString(),
    },
  };
}

function summarizeCleanCaptions(values, maxChars) {
  const text = values.join(" ").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function shouldPolishOcrProject(project) {
  const source = project.book?.source || {};
  const method = String(source.extractionMethod || source.ocr?.engine || "").toLowerCase();
  return source.format === "pdf" && (
    source.ocr?.status === "ok"
    || method.includes("ocr")
    || method.includes("vision")
    || method.includes("mineru")
  );
}

function shouldAdaptSourceProject(project) {
  const source = project.book?.source || {};
  if (shouldPolishOcrProject(project)) return false;
  const format = String(source.format || "").toLowerCase();
  const supported = ["epub", "txt", "text", "md", "markdown", "pdf"].includes(format);
  const spreads = (project.chapters || []).flatMap((chapter) => chapter.spreads || []);
  return supported && spreads.length > 0;
}

function collectSourceAdaptationCandidates(project, { limit = Number.POSITIVE_INFINITY } = {}) {
  const items = [];
  const sourceLanguage = inferProjectCaptionSourceLanguage(project);
  for (const chapter of project.chapters || []) {
    for (const spread of chapter.spreads || []) {
      items.push({
        id: spread.id,
        chapterId: chapter.id,
        chapterTitle: chapter.title || "",
        sourceLanguage,
        currentCaption: clipText(spread.caption || spread.readerCaption || "", 260),
        sourceExcerpt: clipText(spread.sourceExcerpt || "", 420),
        sourcePassage: clipText(spread.sourcePassage || spread.sourceExcerptRaw || extractSceneText(spread.scenePrompt || "") || spread.sourceExcerpt || "", 1800),
        visualIntent: spread.visualIntent || "",
      });
      if (items.length >= limit) return items;
    }
  }
  return items;
}

function collectOcrCaptionPolishCandidates(project, { limit = Number.POSITIVE_INFINITY } = {}) {
  const items = [];
  for (const chapter of project.chapters || []) {
    for (const spread of chapter.spreads || []) {
      items.push({
        id: spread.id,
        chapterId: chapter.id,
        chapterTitle: chapter.title || "",
        caption: clipText(spread.caption || spread.readerCaption || "", 260),
        sourceExcerpt: clipText(spread.sourceExcerpt || "", 900),
        sceneText: clipText(extractSceneText(spread.scenePrompt || ""), 900),
      });
      if (items.length >= limit) return items;
    }
  }
  return items;
}

async function readOcrCaptionCorrections(outputPath) {
  const text = await readFile(outputPath, "utf8");
  const parsed = parseJsonish(text);
  const entries = Array.isArray(parsed) ? parsed : parsed?.spreads;
  if (!Array.isArray(entries)) {
    throw new Error("OCR caption corrections JSON must contain a spreads array.");
  }
  return {
    spreads: entries.map((entry) => ({
      id: String(entry.id || entry.spreadId || "").trim(),
      caption: normalizePolishedText(entry.caption || entry.readerCaption, 180),
      sceneSummary: normalizePolishedText(entry.sceneSummary || entry.scene || entry.summary, 420),
    })).filter((entry) => entry.id && (entry.caption || entry.sceneSummary)),
  };
}

function parseJsonish(text) {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1]);
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("Could not parse OCR caption corrections as JSON.");
  }
}

function buildPolishedScenePrompt(project, spread, sceneSummary) {
  const styleBible = project.styleBible || {};
  const characterNames = (spread.characterRefs || [])
    .map((id) => (project.characters || []).find((character) => character.id === id)?.name)
    .filter(Boolean);
  return [
    styleBible.artDirection || "gentle illustrated picture book, warm light, clear silhouettes",
    `Scene: ${sceneSummary}`,
    `Characters: ${characterNames.length ? characterNames.join(", ") : "people named or implied by the scene summary only; no unrelated recurring cast"}`,
    `Composition: ${styleBible.camera || "storybook eye-level composition"}; one emotionally clear action; no visible text.`,
    `Continuity: ${(styleBible.continuityRules || ["Keep expressions child-safe and readable."]).join(" ")}`,
    `Avoid: ${styleBible.negativePrompt || "photorealistic, harsh horror, crowded tiny details, distorted hands, illegible text in image"}.`,
  ].join("\n");
}

function refreshCaptionI18nAfterPolish(project, spread, caption, source = "ocr_polished") {
  if (!spread.captionI18n?.lines?.length) return;
  const sourceLanguage = spread.captionI18n.sourceLanguage || project.book?.language || "zh";
  const sourceLine = spread.captionI18n.lines.find((line) => line.language === sourceLanguage)
    || spread.captionI18n.lines.find((line) => line.language === "zh")
    || spread.captionI18n.lines[0];
  for (const line of spread.captionI18n.lines) {
    if (line === sourceLine) {
      line.text = caption;
      line.source = source;
      line.needsTranslation = false;
    } else {
      line.text = "";
      line.source = `pending_translation_after_${source}`;
      line.needsTranslation = true;
    }
  }
}

function markSpreadImageForOcrRedraw(spread, updatedAt, reason = "ocr_caption_polished") {
  const current = spread.image || {};
  const targetAssetPath = current.targetAssetPath
    || (String(current.assetPath || "").endsWith(".png") ? current.assetPath : `assets/images/${spread.id}.png`);
  spread.image = {
    ...current,
    provider: "codex-local",
    status: "needs_redraw",
    targetAssetPath,
    redrawReason: reason,
    requestedAt: updatedAt,
  };
}

async function updateProjectCaptionLanguage(manifestPath, {
  languageMode = "zh-en",
  root = rootDir,
  codexPath = codexBin,
} = {}) {
  const project = await readJsonFile(manifestPath);
  const beforeImages = projectImageFingerprint(project);
  const applied = applyCaptionLanguageModeToProject(project, languageMode);
  await writeFile(manifestPath, JSON.stringify(project, null, 2), "utf8");

  const localization = await localizeCaptionsForLanguageMode(manifestPath, {
    root,
    codexPath,
  });
  const rendered = await renderExistingProject(manifestPath, { imageProvider: "preserve" });
  const exported = await exportBookProject(manifestPath);
  const afterImages = projectImageFingerprint(exported.project);
  return {
    project: exported.project,
    manifestPath,
    htmlPath: rendered.htmlPath,
    exports: exported.exports,
    lint: exported.lint,
    summary: exported.summary,
    captions: applied,
    localization,
    imagesUnchanged: beforeImages === afterImages,
  };
}

export function applyCaptionLanguageModeToProject(project, languageMode = "zh-en") {
  const sourceLanguage = inferProjectCaptionSourceLanguage(project);
  const profile = normalizeLanguageProfile(languageMode, sourceLanguage);
  const targetLanguages = profile.bilingual
    ? [profile.primary, profile.secondary].filter(Boolean)
    : [profile.primary || sourceLanguage];
  const uniqueTargetLanguages = [...new Set(targetLanguages)];
  let changedCaptionCount = 0;
  let pendingCaptionCount = 0;

  project.book = project.book || {};
  project.book.language = profile.primary || sourceLanguage;
  project.book.languageProfile = {
    ...profile,
    sourceLanguage,
  };

  for (const chapter of project.chapters || []) {
    for (const spread of chapter.spreads || []) {
      const previous = JSON.stringify(spread.captionI18n || null);
      const spreadSourceLanguage = spread.captionI18n?.sourceLanguage || sourceLanguage;
      const sourceText = captionSourceText(spread, spreadSourceLanguage);
      const existingLines = new Map((spread.captionI18n?.lines || []).map((line) => [line.language, line]));
      const lines = uniqueTargetLanguages.map((language) => {
        const existing = existingLines.get(language);
        if (language === spreadSourceLanguage) {
          return {
            language,
            label: captionLanguageName(language),
            text: sourceText,
            source: existing?.source && !isDeferredCaptionTranslation(existing) ? existing.source : "source",
            needsTranslation: false,
          };
        }
        if (existing?.text && !existing.needsTranslation && !isDeferredCaptionTranslation(existing)) {
          return {
            language,
            label: existing.label || captionLanguageName(language),
            text: existing.text,
            source: existing.source || "existing_translation",
            needsTranslation: false,
          };
        }
        pendingCaptionCount += 1;
        return {
          language,
          label: existing?.label || captionLanguageName(language),
          text: "",
          source: "pending_translation",
          needsTranslation: true,
        };
      });

      spread.captionI18n = {
        mode: profile.mode,
        primary: profile.primary,
        secondary: profile.secondary || null,
        bilingual: profile.bilingual,
        sourceLanguage: spreadSourceLanguage,
        lines,
      };
      if (previous !== JSON.stringify(spread.captionI18n)) changedCaptionCount += 1;
    }
  }

  project.localization = {
    ...(project.localization || {}),
    status: pendingCaptionCount ? "pending" : "ready",
    targetLanguageMode: profile.bilingual ? `${profile.primary}-${profile.secondary}` : profile.primary,
    sourceLanguage,
    pendingCaptionCount,
    updatedAt: new Date().toISOString(),
  };

  return {
    languageMode: project.localization.targetLanguageMode,
    sourceLanguage,
    changedCaptionCount,
    pendingCaptionCount,
  };
}

function extractSceneText(scenePrompt) {
  const match = String(scenePrompt || "").match(/Scene:\s*([\s\S]*?)(?:\nCharacters:|\nComposition:|\nContinuity:|\nAvoid:|$)/i);
  return match ? match[1] : scenePrompt;
}

function normalizePolishedText(value, maxChars) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function clipText(value, maxChars) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

async function updateBookRunForOcrPolish(job, bookRunRoot, patch) {
  if (!job?.id) return;
  try {
    const currentJob = await readBookRun(job.id, bookRunRoot);
    await writeBookRun({
      ...currentJob,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
  } catch {
    // The proofreading step is allowed to run outside a tracked import job.
  }
}

export async function localizeCaptionsForLanguageMode(manifestPath, {
  root = rootDir,
  codexPath = codexBin,
  job,
  bookRunRoot = bookRunsDir,
} = {}) {
  let project = await readJsonFile(manifestPath);
  const resetDeferredCount = resetDeferredCaptionTranslations(project);
  if (resetDeferredCount) {
    await writeFile(manifestPath, JSON.stringify(project, null, 2), "utf8");
  }
  let pending = pendingCaptionTranslations(project);
  if (!pending.length) {
    return { status: "skipped", updated: Boolean(resetDeferredCount), pendingCount: 0, resetDeferredCount };
  }

  const requestedCount = pending.length;
  const batchSize = Math.max(1, Number(process.env.BOOKFRAMES_CODEX_LOCALIZATION_BATCH_SIZE || 24));
  const maxBatches = Math.max(1, Number(process.env.BOOKFRAMES_CODEX_LOCALIZATION_MAX_BATCHES || Math.ceil(requestedCount / batchSize)));
  const totalBatches = Math.ceil(requestedCount / batchSize);
  const logPath = job?.logPath || path.join(path.dirname(manifestPath), "planning", "caption-localization.log");
  await mkdir(path.dirname(logPath), { recursive: true });
  const now = new Date().toISOString();
  await updateBookRunLocalizationState(job, bookRunRoot, {
    status: "running",
    phase: "localizing",
    stage: `localizing captions in ${totalBatches} batch(es)`,
    localizationPendingCount: requestedCount,
    localizationBatchSize: batchSize,
    updatedAt: now,
  });
  await appendLocalizationLog(logPath, `\n[${now}] localizing ${requestedCount} caption line(s) with local Codex in batches of ${batchSize}\n`);

  let lastError = null;
  const localizationDir = path.dirname(logPath);
  for (let batchIndex = 0; pending.length && batchIndex < maxBatches; batchIndex += 1) {
    const batch = pending.slice(0, batchSize);
    await updateBookRunLocalizationState(job, bookRunRoot, {
      status: "running",
      phase: "localizing",
      stage: `localizing caption batch ${batchIndex + 1}/${totalBatches}`,
      localizationPendingCount: pending.length,
      localizationBatchIndex: batchIndex + 1,
      localizationBatchCount: totalBatches,
      updatedAt: new Date().toISOString(),
    });
    await appendLocalizationLog(logPath, `[${new Date().toISOString()}] localization batch ${batchIndex + 1}/${totalBatches}: ${batch.length} line(s)\n`);
    const outputPath = path.join(localizationDir, `caption-localization.part-${String(batchIndex + 1).padStart(2, "0")}.codex.json`);

    try {
      let translations = await readCaptionLocalizationOutput(outputPath).catch(() => null);
      if (!translations) {
        await rm(outputPath, { force: true }).catch(() => {});
        const prompt = buildCaptionLocalizationOutputPrompt({
          manifestPath,
          outputPath,
          project,
          pending: batch,
          batchIndex: batchIndex + 1,
          totalBatches,
        });
        await spawnCodexTextProcess({
          codexPath,
          root,
          prompt,
          logPath,
          targetFile: outputPath,
          maxRuntimeMs: Number(process.env.BOOKFRAMES_CODEX_TEXT_TIMEOUT_MS || 4 * 60 * 1000),
          timeoutLabel: `caption localization batch ${batchIndex + 1}`,
        });
        translations = await readCaptionLocalizationOutput(outputPath);
      }
      const applied = applyCaptionTranslationsToProject(project, translations);
      if (!applied.updatedCount) {
        lastError = new Error(`Local Codex did not return usable translations for caption batch ${batchIndex + 1}`);
        await appendLocalizationLog(logPath, `[${new Date().toISOString()}] ${lastError.message}\n`);
        break;
      }
      await writeFile(manifestPath, JSON.stringify(project, null, 2), "utf8");
      pending = pendingCaptionTranslations(project);
    } catch (error) {
      lastError = error;
      await appendLocalizationLog(logPath, `[${new Date().toISOString()}] caption localization batch ${batchIndex + 1} failed: ${error.message}\n`);
      break;
    }
  }

  project = await readJsonFile(manifestPath);
  pending = pendingCaptionTranslations(project);
  const translatedCount = Math.max(0, requestedCount - pending.length);
  const status = pending.length ? translatedCount ? "partial" : "failed" : "completed";
  project.localization = {
    ...(project.localization || {}),
    status,
    requestedCaptionCount: requestedCount,
    translatedCaptionCount: translatedCount,
    pendingCaptionCount: pending.length,
    resetDeferredCaptionCount: resetDeferredCount,
    batchSize,
    updatedAt: new Date().toISOString(),
    ...(lastError ? { error: lastError.message } : {}),
  };
  await writeFile(manifestPath, JSON.stringify(project, null, 2), "utf8");
  if (lastError) {
    await appendLocalizationLog(logPath, `[${new Date().toISOString()}] caption localization stopped: ${lastError.message}\n`);
  }
  return {
    status,
    updated: Boolean(translatedCount || resetDeferredCount),
    pendingCount: pending.length,
    requestedCount,
    translatedCount,
    resetDeferredCount,
    ...(lastError ? { error: lastError.message } : {}),
  };
}

export function buildCaptionLocalizationOutputPrompt({
  manifestPath,
  outputPath,
  project,
  pending,
  batchIndex = 1,
  totalBatches = 1,
}) {
  const languages = [...new Set(pending.map((item) => item.language))].join(", ");
  return [
    "# BookFrames caption localization JSON output",
    "",
    "你是 Codex，正在为本地 BookFrames 绘本生成中/日/英或双语 caption。",
    `项目文件：${manifestPath}`,
    `输出 JSON：${outputPath}`,
    `书名：${project.book?.title || ""}`,
    `需要补齐的目标语言：${languages}`,
    `当前批次：${batchIndex}/${totalBatches}`,
    "",
    "请只创建或覆盖“输出 JSON”这个文件，不要修改 bookframes.json，不要修改源码。",
    "",
    "输出必须是合法 JSON，结构如下：",
    "```json",
    JSON.stringify({
      translations: [
        {
          spreadId: "ch-01-sp-01",
          language: "zh",
          text: "自然、简洁、适合朗读的译文",
        },
      ],
    }, null, 2),
    "```",
    "",
    "规则：",
    "- 本批只处理下面 JSON 列出的 spreadId/language；不要新增其他条目。",
    "- 对每个本批 line，把 sourceText 翻译成 line.language。",
    "- zh 用自然简洁中文；ja 用自然简洁日文；en 用自然简洁英文。",
    "- 保持绘本朗读口吻，短句，适合儿童读。",
    "- 不要把 sourceText 原样复制到不同语言；如果无法可靠翻译，就不要输出该条。",
    "- 不要输出 Markdown，不要解释。",
    "",
    "待翻译条目：",
    "```json",
    JSON.stringify(pending, null, 2),
    "```",
  ].join("\n");
}

async function readCaptionLocalizationOutput(outputPath) {
  const raw = await readJsonFile(outputPath);
  const entries = Array.isArray(raw) ? raw : Array.isArray(raw.translations) ? raw.translations : Array.isArray(raw.lines) ? raw.lines : [];
  if (!entries.length) throw new Error("Caption localization output has no translations.");
  return entries;
}

function applyCaptionTranslationsToProject(project, translations) {
  const byKey = new Map((translations || [])
    .map((entry) => ({
      spreadId: String(entry.spreadId || entry.id || "").trim(),
      language: normalizeCaptionLanguage(entry.language || entry.lang || ""),
      text: String(entry.text || entry.translation || "").trim(),
    }))
    .filter((entry) => entry.spreadId && entry.language && entry.text)
    .map((entry) => [`${entry.spreadId}:${entry.language}`, entry]));
  let updatedCount = 0;
  for (const chapter of project.chapters || []) {
    for (const spread of chapter.spreads || []) {
      for (const line of spread.captionI18n?.lines || []) {
        const entry = byKey.get(`${spread.id}:${normalizeCaptionLanguage(line.language)}`);
        if (!entry) continue;
        line.text = entry.text;
        line.source = "codex_translation";
        line.needsTranslation = false;
        delete line.deferredTranslation;
        updatedCount += 1;
      }
    }
  }
  return { updatedCount };
}

function pendingCaptionTranslations(project) {
  const pending = [];
  for (const chapter of project.chapters || []) {
    for (const spread of chapter.spreads || []) {
      for (const line of spread.captionI18n?.lines || []) {
        if ((line.needsTranslation && !String(line.text || "").trim()) || isDeferredCaptionTranslation(line)) {
          pending.push({
            chapterId: chapter.id,
            spreadId: spread.id,
            language: line.language,
            label: line.label,
            sourceText: spread.readerCaption || spread.caption || "",
          });
        }
      }
    }
  }
  return pending;
}

function inferProjectCaptionSourceLanguage(project) {
  for (const chapter of project.chapters || []) {
    for (const spread of chapter.spreads || []) {
      if (spread.captionI18n?.sourceLanguage) return normalizeCaptionLanguage(spread.captionI18n.sourceLanguage);
      const sourceLine = (spread.captionI18n?.lines || []).find((line) => line.source === "source" && line.text);
      if (sourceLine?.language) return normalizeCaptionLanguage(sourceLine.language);
    }
  }
  const sample = (project.chapters || [])
    .flatMap((chapter) => chapter.spreads || [])
    .map((spread) => spread.readerCaption || spread.caption || "")
    .join("\n");
  return detectCaptionLanguage(sample || project.book?.language || "");
}

function captionSourceText(spread, sourceLanguage) {
  const sourceLine = (spread.captionI18n?.lines || []).find((line) => {
    return line.language === sourceLanguage && line.text && !isDeferredCaptionTranslation(line);
  });
  return sourceLine?.text || spread.readerCaption || spread.caption || "";
}

function detectCaptionLanguage(text) {
  const value = String(text || "");
  if (/[\u3040-\u30ff]/u.test(value)) return "ja";
  if (/[\u3400-\u9fff]/u.test(value)) return "zh";
  return normalizeCaptionLanguage(value) || "en";
}

function normalizeCaptionLanguage(value) {
  const text = String(value || "").trim().toLowerCase();
  if (["ch", "cn", "zh-cn", "zh-hans", "chinese", "中文"].includes(text)) return "zh";
  if (["jp", "ja-jp", "japanese", "日本語", "日文"].includes(text)) return "ja";
  if (["en-us", "en-gb", "english", "英文"].includes(text)) return "en";
  if (["zh", "ja", "en"].includes(text)) return text;
  return "";
}

function captionLanguageName(code) {
  return {
    zh: "中文",
    ja: "日本語",
    en: "English",
  }[code] || code || "";
}

function resetDeferredCaptionTranslations(project) {
  let count = 0;
  for (const chapter of project.chapters || []) {
    for (const spread of chapter.spreads || []) {
      const sourceLanguage = spread.captionI18n?.sourceLanguage || project.book?.language || "";
      for (const line of spread.captionI18n?.lines || []) {
        if (!isDeferredCaptionTranslation(line)) continue;
        if (line.language === sourceLanguage && String(line.text || "").trim()) {
          line.source = "source";
          line.needsTranslation = false;
        } else {
          line.text = "";
          line.source = "pending_translation_after_deferred";
          line.needsTranslation = true;
        }
        delete line.deferredTranslation;
        count += 1;
      }
    }
  }
  return count;
}

function isDeferredCaptionTranslation(line) {
  return Boolean(line?.deferredTranslation || line?.source === "deferred_source_caption");
}

function captionTranslationKey(item) {
  return `${item.spreadId}:${item.language}`;
}

function projectImageFingerprint(project) {
  const spreads = (project.chapters || []).flatMap((chapter) => chapter.spreads || []);
  const spreadImages = spreads.map((spread) => ({
    id: spread.id,
    image: spread.image || null,
  }));
  const characters = (project.characters || []).map((character) => ({
    id: character.id,
    reference: character.reference || null,
  }));
  return JSON.stringify({ spreadImages, characters });
}

async function updateBookRunLocalizationState(job, bookRunRoot, patch) {
  if (!job?.id) return;
  const currentJob = await readBookRun(job.id, bookRunRoot).catch(() => null);
  if (!currentJob) return;
  await writeBookRun({
    ...currentJob,
    progress: Math.max(Number(currentJob.progress || 0), 19),
    ...patch,
  });
}

async function appendLocalizationLog(logPath, text) {
  if (!logPath) return;
  await appendFile(logPath, text, "utf8").catch(() => {});
}

export function buildCaptionLocalizationPrompt({ manifestPath, project, pending, batchIndex = 1, totalBatches = 1 }) {
  const languages = [...new Set(pending.map((item) => item.language))].join(", ");
  return [
    "# BookFrames caption localization",
    "",
    "你是 Codex，正在为本地 BookFrames 绘本生成中/日/英或双语 caption。",
    `项目文件：${manifestPath}`,
    `书名：${project.book?.title || ""}`,
    `需要补齐的目标语言：${languages}`,
    `当前批次：${batchIndex}/${totalBatches}`,
    "",
    "请直接编辑这个 JSON 文件，只修改 chapters[].spreads[].captionI18n.lines 中 text/source/needsTranslation 三个字段：",
    "- 本批只处理下面 JSON 列出的 spreadId/language；不要改其他 caption 行。",
    "- 对每个本批 line，把同页 readerCaption 翻译成 line.language。",
    "- zh 用自然简洁中文；ja 用自然简洁日文；en 用自然简洁英文。",
    "- 保持绘本朗读口吻，短句，适合儿童读。",
    "- 不要把 sourceText 原样复制到不同语言；如果无法可靠翻译，就保持 text 为空且 needsTranslation=true。",
    "- 不要改图片、章节结构、prompt、sourceExcerpt、id、assetPath。",
    "- 翻译完成后把该 line.source 改为 \"codex_translation\"，needsTranslation 改为 false。",
    "- 保持 JSON 合法，并尽量保留原有缩进。",
    "",
    "待翻译样例：",
    "```json",
    JSON.stringify(pending.slice(0, 80), null, 2),
    "```",
  ].join("\n");
}

function spawnCodexTextProcess({
  codexPath,
  root,
  prompt,
  logPath,
  targetFile,
  maxRuntimeMs = 10 * 60 * 1000,
  timeoutLabel = "text task",
}) {
  const child = spawn(codexPath, [
    "exec",
    "--skip-git-repo-check",
    "-C",
    root,
    "--sandbox",
    "workspace-write",
    "-",
  ], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  child.stdin.end(prompt);
  child.stdout.on("data", (chunk) => appendFile(logPath, chunk).catch(() => {}));
  child.stderr.on("data", (chunk) => appendFile(logPath, chunk).catch(() => {}));
  return new Promise((resolve, reject) => {
    let settled = false;
    let lastSize = -1;
    let stableCount = 0;
    const startedAt = Date.now();
    const watchdog = setInterval(async () => {
      const info = targetFile ? await stat(targetFile).catch(() => null) : null;
      if (info?.isFile() && info.size > 2 && info.mtimeMs >= startedAt - 1000) {
        if (info.size === lastSize) stableCount += 1;
        else stableCount = 0;
        lastSize = info.size;
        if (stableCount >= 1) {
          await appendFile(logPath, `\n[${new Date().toISOString()}] target JSON is stable for ${timeoutLabel}; continuing without waiting for Codex shutdown\n`, "utf8").catch(() => {});
          finish();
          return;
        }
      }
      if (Date.now() - startedAt > maxRuntimeMs) {
        finish(new Error(`Local Codex ${timeoutLabel} timed out after ${Math.round(maxRuntimeMs / 1000)}s`));
      }
    }, 3000);
    child.on("error", (error) => {
      finish(error);
    });
    child.on("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(`Local Codex exited with ${code}`));
    });
    function finish(error) {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      if (targetFile && !child.killed) child.kill("SIGTERM");
      if (error) reject(error);
      else resolve();
    }
  });
}

async function writeBookRun(job) {
  await writeFile(job.jobPath, JSON.stringify(job, null, 2), "utf8");
  activeBookRuns.set(job.id, job);
  return job;
}

async function readBookRun(id, bookRunRoot = bookRunsDir) {
  const safeId = id.replace(/[^A-Za-z0-9_.-]/g, "");
  if (activeBookRuns.has(safeId)) return activeBookRuns.get(safeId);
  return JSON.parse(await readFile(path.join(bookRunRoot, `${safeId}.json`), "utf8"));
}

async function listBookRuns(bookRunRoot = bookRunsDir) {
  await mkdir(bookRunRoot, { recursive: true });
  const files = (await readdir(bookRunRoot)).filter((file) => file.endsWith(".json")).sort().reverse().slice(0, 20);
  const jobs = await Promise.all(files.map((file) => readFile(path.join(bookRunRoot, file), "utf8").then(JSON.parse).then(markStaleRun)));
  return jobs;
}

async function resumeRecentWork({
  root = rootDir,
  imageRunRoot = imageRunsDir,
  bookRunRoot = bookRunsDir,
  codexPath = codexBin,
} = {}) {
  const maxResume = Math.max(0, Number(process.env.BOOKFRAMES_RESUME_MAX_IMAGE_RUNS || 0));
  const imageJobs = (await listImageRuns(imageRunRoot).catch(() => []))
    .filter((imageJob) => ["queued", "running"].includes(imageJob.status))
    .filter((imageJob) => isRecentlyUpdated(imageJob, 30 * 60 * 1000))
    .sort((a, b) => latestJobTimestamp(b) - latestJobTimestamp(a));
  const bookJobs = await listBookRuns(bookRunRoot).catch(() => []);
  for (const imageJob of imageJobs.slice(0, maxResume)) {
    if (activeImageRuns.has(imageJob.id)) continue;
    const projectFile = imageJob.projectFile || resolveProjectFile(root, imageJob.projectPath);
    if (!projectFile) continue;
    const resumed = {
      ...imageJob,
      projectFile,
      projectDir: imageJob.projectDir || path.dirname(projectFile),
      status: "queued",
      stage: "resuming image queue after server restart",
      updatedAt: new Date().toISOString(),
    };
    activeImageRuns.set(resumed.id, resumed);
    runImageJobInBackground(resumed, { root, imageRunRoot, codexPath }).catch(() => {});

    const linkedBook = bookJobs.find((bookJob) => bookJob.imageRunId === imageJob.id);
    if (linkedBook) {
      monitorImageRunForBookRun(linkedBook.id, imageJob.id, { bookRunRoot, imageRunRoot }).catch(() => {});
    }
  }
}

async function findRecentActiveBookRun({ bookRunRoot = bookRunsDir, sourcePath, outDir }) {
  const jobs = await listBookRuns(bookRunRoot).catch(() => []);
  return jobs.find((job) => {
    return ["queued", "running", "drawing"].includes(job.status)
      && job.sourcePath === sourcePath
      && job.outDir === outDir
      && isRecentlyUpdated(job, 12 * 60 * 1000);
  }) || null;
}

function markStaleRun(job) {
  if (!["queued", "running", "drawing"].includes(job.status)) return job;
  if (isRecentlyUpdated(job, 15 * 60 * 1000)) return job;
  return {
    ...job,
    status: "stale",
    phase: job.phase === "drawing" ? "drawing" : job.phase,
    stage: "stale after server restart or stalled child process",
    progress: Number(job.progress || 0),
  };
}

function isRecentlyUpdated(job, maxAgeMs) {
  const timestamp = latestJobTimestamp(job);
  return Boolean(timestamp) && Date.now() - timestamp <= maxAgeMs;
}

function latestJobTimestamp(job) {
  return Math.max(
    Date.parse(job.heartbeatAt || "") || 0,
    Date.parse(job.updatedAt || "") || 0,
    Date.parse(job.createdAt || "") || 0,
  );
}

async function saveChangeRequest(payload, { root = rootDir, requestRoot = requestsDir, codexPath = codexBin } = {}) {
  const feedback = String(payload.feedback || "").trim();
  if (!feedback) throw new Error("feedback is required");
  await mkdir(requestRoot, { recursive: true });

  const id = makeRequestId();
  const projectFile = resolveProjectFile(root, payload.projectPath);
  const projectDir = projectFile ? path.dirname(projectFile) : "";
  const context = await buildRequestContext(payload, { projectFile, projectDir });
  const now = new Date().toISOString();
  const requestPath = path.join(requestRoot, `${id}.json`);
  const promptPath = path.join(requestRoot, `${id}.prompt.md`);
  const planPath = path.join(requestRoot, `${id}.plan.md`);
  const logPath = path.join(requestRoot, `${id}.log`);
  const request = {
    schemaVersion: 1,
    id,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    projectTitle: String(payload.projectTitle || ""),
    projectPath: String(payload.projectPath || ""),
    projectFile,
    projectDir,
    target: String(payload.target || "overall"),
    selectedChapter: String(payload.selectedChapter || ""),
    context,
    feedback,
    sourceUrl: String(payload.sourceUrl || ""),
    requestPath,
    promptPath,
    planPath,
    logPath,
  };
  const prompt = buildChangeRequestPrompt(request, { root });
  request.codexCommand = buildCodexCommand({ codexPath, root, promptPath });

  await writeFile(promptPath, prompt, "utf8");
  await writeFile(requestPath, JSON.stringify(request, null, 2), "utf8");
  return request;
}

export function buildChangeRequestPrompt(request, { root = rootDir } = {}) {
  return [
    "# BookFrames 修改请求",
    "",
    "你是 Codex，正在维护一个本地绘本生成器 BookFrames。请根据用户从前端工作台提交的意见直接修改项目或代码。",
    "",
    "## 工作区",
    `- Repo root: ${root}`,
    `- Project file: ${request.projectFile || request.projectPath || "unknown"}`,
    `- Project title: ${request.projectTitle || "unknown"}`,
    `- Target: ${request.target}`,
    `- Selected chapter: ${request.selectedChapter || "all"}`,
    "",
    contextSection(request),
    planSection(request),
    "## 用户意见",
    request.feedback,
    "",
    "## 执行要求",
    "- 只围绕绘本生成器修改，不添加视频或 HyperFrames 导出流程。",
    "- 如果意见指向绘本内容，优先修改 bookframes.json、source/chapter-map.json、planning/story-arc.json、planning/planning-review.json 或 assets/codex-image-jobs 里的提示词。",
    "- 如果意见指向前端工作台或生成器能力，修改对应源码并保持现有架构。",
    "- 修改后运行 npm test。",
    "- 如果改了项目内容，请按需要运行 node apps/cli/index.js render <project-dir> 或 node apps/cli/index.js export <project-dir> 来刷新输出。",
    "- 最后用中文简短说明改了哪些文件、验证结果、还有什么需要人工确认。",
    "",
  ].join("\n");
}

export function buildChangePlanPrompt(request, { root = rootDir } = {}) {
  return [
    "# BookFrames 修改计划请求",
    "",
    "你是 Codex，正在维护一个本地绘本生成器 BookFrames。请只生成修改计划，不要修改任何文件。",
    "",
    "## 工作区",
    `- Repo root: ${root}`,
    `- Project file: ${request.projectFile || request.projectPath || "unknown"}`,
    `- Project title: ${request.projectTitle || "unknown"}`,
    `- Target: ${request.target}`,
    `- Selected chapter: ${request.selectedChapter || "all"}`,
    "",
    contextSection(request),
    "## 用户意见",
    request.feedback,
    "",
    "## 输出要求",
    "- 用中文输出。",
    "- 先判断这是内容修改、画图提示词修改、导入/OCR修改、导出修改，还是系统能力修改。",
    "- 明确列出建议修改的文件和字段。",
    "- 如果影响画面，列出需要标记为 needs_redraw 的 spread id。",
    "- 不要执行文件写入，不要运行命令。",
    "",
  ].join("\n");
}

function contextSection(request) {
  const context = request.context || {};
  if (!Object.keys(context).length) return "";
  return [
    "## 当前上下文",
    "```json",
    JSON.stringify(context, null, 2),
    "```",
    "",
  ].join("\n");
}

function planSection(request) {
  if (!request.planText) return "";
  return [
    "## 已生成修改计划",
    request.planText,
    "",
  ].join("\n");
}

export function resolveProjectFile(root, projectPath) {
  if (!projectPath) return "";
  const text = String(projectPath);
  const candidates = [];
  if (text.startsWith("file://")) candidates.push(fileURLToPath(text));
  if (path.isAbsolute(text) && text.startsWith(root)) candidates.push(text);
  if (text.startsWith("/") && !text.startsWith(root)) candidates.push(path.join(root, text.slice(1)));
  if (!path.isAbsolute(text)) candidates.push(path.join(root, text));
  for (const candidate of candidates) {
    const normalized = path.normalize(candidate);
    if (normalized.startsWith(root)) return normalized;
  }
  return "";
}

function buildIngestOptions(payload) {
  return {
    pdfEngine: payload.pdfEngine || "auto",
    ocrMode: payload.ocrMode || payload.ocr || "auto",
    ocrLang: payload.ocrLang,
    ocrMaxPages: payload.ocrMaxPages,
    ocrRecognition: payload.ocrRecognition,
    ocrScale: payload.ocrScale,
    expectedLanguage: payload.expectedLanguage || payload.languageMode || payload.language,
    minTextChars: payload.minTextChars,
    disableMineruAutoRoute: payload.disableMineruAutoRoute,
    autoMineruRoute: payload.autoMineruRoute,
    preferMineru: payload.preferMineru,
    mineruBackend: payload.mineruBackend,
    mineruBin: payload.mineruBin,
    mineruLang: payload.mineruLang,
    mineruMethod: payload.mineruMethod,
    mineruImageAnalysis: payload.mineruImageAnalysis,
    mineruTimeoutMs: payload.mineruTimeoutMs,
    chapterMapPath: payload.chapterMapPath,
  };
}

function resolveLocalInputPath(value) {
  if (!value) return "";
  const text = String(value).trim();
  if (!text) return "";
  if (text.startsWith("file://")) return fileURLToPath(text);
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return path.resolve(text);
}

function resolveOutputDir(root, value) {
  const text = String(value || "runs/story").trim();
  const target = path.isAbsolute(text) ? path.normalize(text) : path.normalize(path.join(root, text));
  if (!target.startsWith(root)) throw new Error("outDir must be inside the BookFrames workspace");
  return target;
}

function projectUrlPath(root, manifestPath) {
  const relative = path.relative(root, manifestPath).split(path.sep).join("/");
  return `/${relative}`;
}

async function planCodexForRequest(id, { requestRoot = requestsDir, codexPath = codexBin, root = rootDir } = {}) {
  return spawnCodexForRequest(id, {
    requestRoot,
    codexPath,
    root,
    runMode: "plan",
  });
}

async function runCodexForRequest(id, { requestRoot = requestsDir, codexPath = codexBin, root = rootDir } = {}) {
  return spawnCodexForRequest(id, {
    requestRoot,
    codexPath,
    root,
    runMode: "edit",
  });
}

async function spawnCodexForRequest(id, { requestRoot = requestsDir, codexPath = codexBin, root = rootDir, runMode = "edit" } = {}) {
  if (activeRuns.has(id)) return activeRuns.get(id);
  let request = await readChangeRequest(id, requestRoot);
  if (runMode === "edit") {
    const planText = request.planPath ? await readFile(request.planPath, "utf8").catch(() => "") : "";
    request = {
      ...request,
      planText,
      status: "snapshotting",
      updatedAt: new Date().toISOString(),
    };
    request.snapshotPath = await createProjectSnapshot(request);
    await writeFile(request.requestPath, JSON.stringify(request, null, 2), "utf8");
    await writeFile(request.promptPath, buildChangeRequestPrompt(request, { root }), "utf8");
  } else {
    await writeFile(request.planPath, "", "utf8");
  }
  const prompt = runMode === "plan"
    ? buildChangePlanPrompt(request, { root })
    : await readFile(request.promptPath, "utf8");
  const running = {
    ...request,
    status: runMode === "plan" ? "planning" : "running",
    runMode,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(request.requestPath, JSON.stringify(running, null, 2), "utf8");
  activeRuns.set(id, running);
  await appendFile(request.logPath, `\n[${running.startedAt}] starting Codex ${runMode}\n`, "utf8");

  const args = [
    "exec",
    "--skip-git-repo-check",
    "-C",
    root,
    "--sandbox",
    runMode === "plan" ? "read-only" : "workspace-write",
  ];
  if (runMode === "plan") args.push("-o", request.planPath);
  args.push(
    "-",
  );
  const child = spawn(codexPath, args, {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  child.stdin.end(prompt);
  child.stdout.on("data", (chunk) => appendFile(request.logPath, chunk).catch(() => {}));
  child.stderr.on("data", (chunk) => appendFile(request.logPath, chunk).catch(() => {}));
  child.on("error", async (error) => {
    const failedRequest = {
      ...running,
      status: "failed",
      error: error.message,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await appendFile(request.logPath, `\n[${failedRequest.completedAt}] Codex failed: ${error.message}\n`, "utf8").catch(() => {});
    await writeFile(request.requestPath, JSON.stringify(failedRequest, null, 2), "utf8").catch(() => {});
    activeRuns.delete(id);
  });
  child.on("close", async (code) => {
    if (!activeRuns.has(id)) return;
    const finalRequest = {
      ...running,
      status: code === 0 ? (runMode === "plan" ? "planned" : "completed") : "failed",
      exitCode: code,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await appendFile(request.logPath, `\n[${finalRequest.completedAt}] Codex exited with ${code}\n`, "utf8").catch(() => {});
    await writeFile(request.requestPath, JSON.stringify(finalRequest, null, 2), "utf8").catch(() => {});
    activeRuns.delete(id);
  });

  return { ...running, pid: child.pid };
}

async function buildRequestContext(payload, { projectFile, projectDir }) {
  const base = payload.context && typeof payload.context === "object" ? payload.context : {};
  const context = { ...base };
  const project = projectFile ? await readJsonFile(projectFile).catch(() => null) : null;
  const selectedSpreadId = context.spreadId || context.spread?.id || "";
  const selectedChapterId = context.chapterId || context.chapter?.id || payload.selectedChapter || "";
  if (project) {
    context.projectStats = {
      chapterCount: project.chapters?.length || 0,
      spreadCount: (project.chapters || []).reduce((count, chapter) => count + (chapter.spreads?.length || 0), 0),
      importQuality: project.book?.source?.importQuality?.level || project.book?.originalStats?.importQualityLevel || "",
      style: project.styleBible?.name || "",
    };
    const chapter = (project.chapters || []).find((item) => item.id === selectedChapterId);
    if (chapter) {
      context.chapter = pickFields(chapter, ["id", "title", "summary"]);
      const spread = (chapter.spreads || []).find((item) => item.id === selectedSpreadId);
      if (spread) {
        context.spread = pickFields(spread, [
          "id",
          "readerCaption",
          "caption",
          "visualIntent",
          "prompt",
          "image",
          "characters",
        ]);
        const promptPath = spread.image?.promptPath || context.spread?.image?.promptPath;
        if (promptPath && projectDir) {
          context.promptPath = promptPath;
          context.promptText = await readTextInside(projectDir, promptPath, 5000).catch(() => "");
        }
      }
    }
  }
  return context;
}

async function createProjectSnapshot(request) {
  if (!request.projectDir || !request.projectDir.startsWith(rootDir)) return "";
  const snapshotPath = path.join(request.projectDir, ".bookframes-snapshots", request.id);
  await mkdir(snapshotPath, { recursive: true });
  await copyIfExists(path.join(request.projectDir, "bookframes.json"), path.join(snapshotPath, "bookframes.json"));
  await copyIfExists(path.join(request.projectDir, "planning"), path.join(snapshotPath, "planning"));
  await copyIfExists(path.join(request.projectDir, "assets", "codex-image-jobs"), path.join(snapshotPath, "assets", "codex-image-jobs"));
  await mkdir(path.join(snapshotPath, "source"), { recursive: true });
  for (const file of ["chapter-map.json", "import-quality.json", "page-audit.json", "ingest-report.json"]) {
    await copyIfExists(path.join(request.projectDir, "source", file), path.join(snapshotPath, "source", file));
  }
  return snapshotPath;
}

async function copyIfExists(from, to) {
  if (!await stat(from).catch(() => null)) return;
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true, force: true });
}

async function readTextInside(root, relativePath, maxChars) {
  const filePath = path.normalize(path.join(root, relativePath));
  if (!filePath.startsWith(root)) return "";
  const text = await readFile(filePath, "utf8");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...[truncated]` : text;
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function pickFields(value, fields) {
  const picked = {};
  for (const field of fields) {
    if (value?.[field] !== undefined) picked[field] = value[field];
  }
  return picked;
}

async function readChangeRequest(id, requestRoot = requestsDir) {
  const safeId = id.replace(/[^A-Za-z0-9_.-]/g, "");
  return JSON.parse(await readFile(path.join(requestRoot, `${safeId}.json`), "utf8"));
}

async function readDecoratedChangeRequest(id, requestRoot = requestsDir) {
  const request = await readChangeRequest(id, requestRoot);
  return decorateRequest(request);
}

async function listChangeRequests(requestRoot = requestsDir) {
  await mkdir(requestRoot, { recursive: true });
  const files = (await readdir(requestRoot)).filter((file) => file.endsWith(".json")).sort().reverse().slice(0, 20);
  const requests = await Promise.all(files.map((file) => readFile(path.join(requestRoot, file), "utf8").then(JSON.parse)));
  return Promise.all(requests.map(decorateRequest));
}

async function decorateRequest(request) {
  const log = request.logPath ? await readFile(request.logPath, "utf8").catch(() => "") : "";
  const planText = request.planPath ? await readFile(request.planPath, "utf8").catch(() => "") : "";
  return {
    ...request,
    logTail: tailText(log, 3200),
    planText: tailText(planText, 5000),
  };
}

function tailText(text, maxChars) {
  if (!text || text.length <= maxChars) return text || "";
  return text.slice(text.length - maxChars);
}

async function serveStatic(req, res, url, root) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendText(res, 405, "Method not allowed");
    return;
  }
  const pathname = url.pathname === "/" ? "/apps/web/" : decodeURIComponent(url.pathname);
  const filePath = safeStaticPath(root, pathname);
  if (!filePath) {
    sendText(res, 403, "Forbidden");
    return;
  }
  let target = filePath;
  const info = await stat(target).catch(() => null);
  if (info?.isDirectory()) target = path.join(target, "index.html");
  const finalInfo = await stat(target).catch(() => null);
  if (!finalInfo?.isFile()) {
    sendText(res, 404, "Not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": mimeTypes[path.extname(target).toLowerCase()] || "application/octet-stream",
    "Content-Length": finalInfo.size,
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(target).pipe(res);
}

function safeStaticPath(root, pathname) {
  const target = path.normalize(path.join(root, pathname));
  return target.startsWith(root) ? target : "";
}

function safeProjectPath(root, relativePath) {
  if (!relativePath) return "";
  const target = path.normalize(path.join(root, relativePath));
  return target.startsWith(root) ? target : "";
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error("request body too large"));
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function readRequestBuffer(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`request body too large; max ${Math.round(maxBytes / 1024 / 1024)}MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, value) {
  sendText(res, statusCode, JSON.stringify(value, null, 2), "application/json; charset=utf-8");
}

function sendText(res, statusCode, value, contentType = "text/plain; charset=utf-8") {
  const body = Buffer.from(value);
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": body.length,
  });
  res.end(body);
}

function makeRequestId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  return `${stamp}-${Math.random().toString(16).slice(2, 8)}`;
}

function sanitizeUploadedFileName(value) {
  const basename = path.basename(String(value || "book.epub"));
  return basename.replace(/[^A-Za-z0-9._ -]+/g, "-").replace(/\s+/g, " ").trim() || "book.epub";
}

function titleFromFilename(filename) {
  return path.basename(filename, path.extname(filename)).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim() || "Story";
}

function slugify(value) {
  return String(value || "story").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "story";
}

function buildCodexCommand({ codexPath, root, promptPath }) {
  return [
    shellQuote(codexPath),
    "exec",
    "--skip-git-repo-check",
    "-C",
    shellQuote(root),
    "--sandbox workspace-write",
    "-",
    "<",
    shellQuote(promptPath),
  ].join(" ");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createBookFramesServer();
  server.listen(defaultPort, () => {
    console.log(`BookFrames web running at http://127.0.0.1:${defaultPort}/apps/web/`);
    resumeRecentWork().catch((error) => {
      console.warn(`BookFrames resume skipped: ${error.message}`);
    });
  });
}
