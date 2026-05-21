import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export async function ensureImages(project, projectDir, { provider = "placeholder" } = {}) {
  if (provider === "placeholder") {
    return ensurePlaceholderImages(project, projectDir, { provider });
  }

  if (provider === "codex-local") {
    return ensureCodexLocalJobs(project, projectDir);
  }

  throw new Error(`Image provider "${provider}" is not wired yet. Use provider=placeholder or provider=codex-local.`);
}

export async function ensurePlaceholderImages(project, projectDir, { provider = "placeholder" } = {}) {
  const imagesDir = path.join(projectDir, "assets", "images");
  await mkdir(imagesDir, { recursive: true });
  const imageAssets = [];

  for (const chapter of project.chapters) {
    for (const spread of chapter.spreads) {
      const assetPath = spread.image?.assetPath || `assets/images/${spread.id}.svg`;
      const absolutePath = path.join(projectDir, assetPath);
      if (!(await exists(absolutePath))) {
        const svg = makePlaceholderSvg({ project, chapter, spread });
        await writeFile(absolutePath, svg, "utf8");
      }
      spread.image = {
        provider,
        status: "ready",
        assetPath,
        promptHash: hashString(spread.scenePrompt),
        generatedAt: new Date().toISOString(),
      };
      imageAssets.push({
        id: spread.id,
        assetPath,
        provider,
        promptHash: spread.image.promptHash,
      });
    }
  }

  project.assets.images = imageAssets;
  return project;
}

export async function ensureCodexLocalJobs(project, projectDir) {
  const imagesDir = path.join(projectDir, "assets", "images");
  const jobsDir = path.join(projectDir, "assets", "codex-image-jobs");
  await mkdir(imagesDir, { recursive: true });
  await mkdir(jobsDir, { recursive: true });
  await ensureCharacterReferenceJobs(project, projectDir);

  const imageAssets = [];
  const jobs = [];

  for (const chapter of project.chapters) {
    for (const spread of chapter.spreads) {
      const promptHash = hashString(spread.scenePrompt);
      const raster = await findExistingRaster(projectDir, spread.id);
      const acceptsExistingRaster = raster && (
        spread.image?.status !== "needs_redraw"
        || isRasterFreshForRedraw(raster, spread.image?.requestedAt)
      );
      const placeholderAssetPath = `assets/images/${spread.id}.svg`;
      const targetAssetPath = raster?.assetPath || `assets/images/${spread.id}.png`;
      const promptAssetPath = `assets/codex-image-jobs/${spread.id}.md`;
      const promptText = buildCodexImagePrompt({ project, chapter, spread });

      await writeFile(path.join(projectDir, promptAssetPath), promptText, "utf8");

      if (acceptsExistingRaster) {
        spread.image = {
          provider: spread.image?.provider === "openai-image" ? "openai-image" : "codex-local",
          status: "ready",
          assetPath: raster.assetPath,
          promptPath: promptAssetPath,
          promptHash,
          qa: await inspectImageQuality(path.join(projectDir, raster.assetPath), spread),
          generatedAt: spread.image?.generatedAt || new Date().toISOString(),
          ...(spread.image?.generation ? { generation: spread.image.generation } : {}),
        };
      } else {
        const placeholderPath = path.join(projectDir, placeholderAssetPath);
        if (!(await exists(placeholderPath))) {
          await writeFile(placeholderPath, makePlaceholderSvg({ project, chapter, spread }), "utf8");
        }

        spread.image = {
          provider: "codex-local",
          status: spread.image?.status === "needs_redraw" ? "needs_redraw" : "needs_codex_generation",
          assetPath: placeholderAssetPath,
          targetAssetPath,
          promptPath: promptAssetPath,
          promptHash,
          requestedAt: new Date().toISOString(),
        };

        jobs.push({
          spreadId: spread.id,
          chapterId: chapter.id,
          title: chapter.title,
          caption: spread.caption,
          readerCaption: spread.readerCaption || spread.caption,
          sourceExcerpt: spread.sourceExcerpt || spread.caption,
          promptPath: promptAssetPath,
          targetAssetPath,
          prompt: promptText,
        });
      }

      imageAssets.push({
        id: spread.id,
        assetPath: spread.image.assetPath,
        targetAssetPath: spread.image.targetAssetPath || spread.image.assetPath,
        promptPath: spread.image.promptPath,
        provider: "codex-local",
        status: spread.image.status,
        promptHash,
      });
    }
  }

  project.assets.images = imageAssets;
  project.assets.codexImageJobs = {
    provider: "codex-local",
    jobsPath: "assets/codex-image-jobs/jobs.jsonl",
    pendingCount: jobs.length,
    updatedAt: new Date().toISOString(),
  };
  const queueItems = buildCodexQueueItems(project, jobs);
  project.assets.codexImageQueue = {
    provider: "codex-local",
    queuePath: "assets/codex-image-jobs/queue.json",
    pendingCount: queueItems.filter((item) => item.status !== "ready").length,
    characterPendingCount: queueItems.filter((item) => item.type === "character" && item.status !== "ready").length,
    spreadPendingCount: queueItems.filter((item) => item.type === "spread" && item.status !== "ready").length,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(
    path.join(projectDir, project.assets.codexImageJobs.jobsPath),
    jobs.map((job) => JSON.stringify(job)).join("\n") + (jobs.length ? "\n" : ""),
    "utf8",
  );
  await writeFile(
    path.join(projectDir, project.assets.codexImageQueue.queuePath),
    JSON.stringify({ items: queueItems }, null, 2),
    "utf8",
  );

  return project;
}

export async function importCodexImage(project, projectDir, { spreadId, imagePath }) {
  const spreadContext = findSpread(project, spreadId);
  if (!spreadContext) throw new Error(`Spread not found: ${spreadId}`);

  const { spread } = spreadContext;
  const absoluteInput = path.resolve(imagePath);
  if (!(await exists(absoluteInput))) throw new Error(`Image file does not exist: ${absoluteInput}`);

  const ext = normalizeImageExtension(path.extname(absoluteInput));
  const assetPath = `assets/images/${spread.id}${ext}`;
  const absoluteOutput = path.join(projectDir, assetPath);
  await mkdir(path.dirname(absoluteOutput), { recursive: true });
  await copyFile(absoluteInput, absoluteOutput);
  const qa = await inspectImageQuality(absoluteOutput, spread);

  spread.image = {
    provider: "codex-local",
    status: qa.blockingIssues.length > 0 ? "needs_redraw" : "ready",
    assetPath,
    promptPath: spread.image?.promptPath || `assets/codex-image-jobs/${spread.id}.md`,
    promptHash: hashString(spread.scenePrompt),
    qa,
    generatedAt: new Date().toISOString(),
    importedFrom: absoluteInput,
  };

  syncImageAssets(project);
  return spread.image;
}

export async function importCharacterReference(project, projectDir, { characterId, imagePath }) {
  const character = (project.characters || []).find((item) => item.id === characterId);
  if (!character) throw new Error(`Character not found: ${characterId}`);

  const absoluteInput = path.resolve(imagePath);
  if (!(await exists(absoluteInput))) throw new Error(`Image file does not exist: ${absoluteInput}`);

  const ext = normalizeImageExtension(path.extname(absoluteInput));
  const assetPath = `assets/characters/${character.id}${ext}`;
  const absoluteOutput = path.join(projectDir, assetPath);
  await mkdir(path.dirname(absoluteOutput), { recursive: true });
  await copyFile(absoluteInput, absoluteOutput);

  character.reference = {
    ...character.reference,
    provider: "codex-local",
    status: "ready",
    assetPath,
    targetAssetPath: assetPath,
    importedFrom: absoluteInput,
    generatedAt: new Date().toISOString(),
  };
  await ensureCharacterReferenceJobs(project, projectDir);
  return character.reference;
}

export async function importLatestCodexImages(project, projectDir, { limit = 1, sourceRoot, spreadId } = {}) {
  const pending = spreadId
    ? [findSpread(project, spreadId)].filter(Boolean)
    : getPendingCodexSpreadContexts(project).slice(0, Number(limit));
  if (pending.length === 0) return [];

  const root = sourceRoot || path.join(process.env.HOME || "", ".codex", "generated_images");
  const files = await listRecentImageFiles(root, pending.length);
  if (files.length < pending.length) {
    throw new Error(`Only found ${files.length} generated image(s) under ${root}; need ${pending.length}.`);
  }

  const imported = [];
  for (let index = 0; index < pending.length; index += 1) {
    const spreadId = pending[index].spread.id;
    const image = await importCodexImage(project, projectDir, {
      spreadId,
      imagePath: files[index].filePath,
    });
    imported.push({ spreadId, imagePath: image.assetPath, importedFrom: files[index].filePath });
  }
  return imported;
}

export async function importLatestCodexQueue(project, projectDir, { limit = 1, sourceRoot } = {}) {
  const queue = getPendingCodexQueueContexts(project).slice(0, Number(limit));
  if (queue.length === 0) return [];

  const root = sourceRoot || path.join(process.env.HOME || "", ".codex", "generated_images");
  const files = await listRecentImageFiles(root, queue.length);
  if (files.length < queue.length) {
    throw new Error(`Only found ${files.length} generated image(s) under ${root}; need ${queue.length}.`);
  }

  const imported = [];
  for (let index = 0; index < queue.length; index += 1) {
    const item = queue[index];
    if (item.type === "character") {
      const reference = await importCharacterReference(project, projectDir, {
        characterId: item.character.id,
        imagePath: files[index].filePath,
      });
      imported.push({
        type: "character",
        id: item.character.id,
        imagePath: reference.assetPath,
        importedFrom: files[index].filePath,
      });
    } else {
      const image = await importCodexImage(project, projectDir, {
        spreadId: item.spread.id,
        imagePath: files[index].filePath,
      });
      imported.push({
        type: "spread",
        id: item.spread.id,
        imagePath: image.assetPath,
        importedFrom: files[index].filePath,
        qaStatus: image.qa?.status || "not_checked",
      });
    }
  }
  await ensureCodexLocalJobs(project, projectDir);
  return imported;
}

export async function generateOpenAIImageQueue(project, projectDir, {
  limit = 1,
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1",
  size = process.env.OPENAI_IMAGE_SIZE || "1536x1024",
  quality = process.env.OPENAI_IMAGE_QUALITY || "auto",
} = {}) {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for actual image generation. The Codex chat image tool is not exposed as a local Node API.");
  }
  const queue = getPendingCodexQueueContexts(project).slice(0, Math.max(1, Number(limit || 1)));
  if (queue.length === 0) return [];

  const generated = [];
  for (const item of queue) {
    if (item.type === "character") {
      const prompt = buildCharacterReferencePrompt(project, item.character);
      const targetAssetPath = item.character.reference?.targetAssetPath || `assets/characters/${item.character.id}.png`;
      await writeGeneratedOpenAIImage(path.join(projectDir, targetAssetPath), prompt, {
        apiKey,
        model,
        size,
        quality,
      });
      item.character.reference = {
        ...item.character.reference,
        provider: "openai-image",
        status: "ready",
        assetPath: targetAssetPath,
        targetAssetPath,
        generatedAt: new Date().toISOString(),
        generation: { model, size, quality },
      };
      generated.push({
        type: "character",
        id: item.character.id,
        imagePath: targetAssetPath,
        model,
      });
    } else {
      const { chapter, spread } = item;
      const targetAssetPath = spread.image?.targetAssetPath || rasterTargetFor(spread.id);
      const promptPath = spread.image?.promptPath || `assets/codex-image-jobs/${spread.id}.md`;
      const prompt = buildCodexImagePrompt({ project, chapter, spread });
      const absoluteOutput = path.join(projectDir, targetAssetPath);
      await writeGeneratedOpenAIImage(absoluteOutput, prompt, {
        apiKey,
        model,
        size,
        quality,
      });
      const qa = await inspectImageQuality(absoluteOutput, spread);
      spread.image = {
        provider: "openai-image",
        status: qa.blockingIssues.length ? "needs_redraw" : "ready",
        assetPath: targetAssetPath,
        targetAssetPath,
        promptPath,
        promptHash: hashString(spread.scenePrompt),
        qa,
        generatedAt: new Date().toISOString(),
        generation: { model, size, quality },
      };
      generated.push({
        type: "spread",
        id: spread.id,
        imagePath: targetAssetPath,
        qaStatus: qa.status,
        model,
      });
    }
  }

  await ensureCodexLocalJobs(project, projectDir);
  return generated;
}

export function listPendingCodexSpreads(project) {
  return getPendingCodexSpreadContexts(project).map(({ chapter, spread }) => ({
    spreadId: spread.id,
    chapterId: chapter.id,
    title: chapter.title,
    caption: spread.caption,
    readerCaption: spread.readerCaption || spread.caption,
    promptPath: spread.image?.promptPath || `assets/codex-image-jobs/${spread.id}.md`,
    targetAssetPath: spread.image?.targetAssetPath || `assets/images/${spread.id}.png`,
    status: spread.image?.status || "missing",
    qaStatus: spread.image?.qa?.status || "not_checked",
  }));
}

export function listPendingCodexQueue(project) {
  return getPendingCodexQueueContexts(project).map((item) => {
    if (item.type === "character") {
      return {
        type: "character",
        id: item.character.id,
        title: item.character.name,
        promptPath: item.character.reference?.promptPath,
        targetAssetPath: item.character.reference?.targetAssetPath,
        status: item.character.reference?.status || "missing",
      };
    }
    return {
      type: "spread",
      id: item.spread.id,
      chapterId: item.chapter.id,
      title: item.chapter.title,
      promptPath: item.spread.image?.promptPath,
      targetAssetPath: item.spread.image?.targetAssetPath,
      status: item.spread.image?.status || "missing",
      qaStatus: item.spread.image?.qa?.status || "not_checked",
    };
  });
}

export async function markSpreadForRedraw(project, projectDir, { spreadId, reason = "manual_redraw" }) {
  const spreadContext = findSpread(project, spreadId);
  if (!spreadContext) throw new Error(`Spread not found: ${spreadId}`);

  const { chapter, spread } = spreadContext;
  const targetAssetPath = spread.image?.targetAssetPath || rasterTargetFor(spread.id);
  const promptAssetPath = spread.image?.promptPath || `assets/codex-image-jobs/${spread.id}.md`;
  const promptText = buildCodexImagePrompt({ project, chapter, spread });

  await mkdir(path.join(projectDir, "assets", "codex-image-jobs"), { recursive: true });
  await writeFile(path.join(projectDir, promptAssetPath), promptText, "utf8");

  spread.image = {
    ...spread.image,
    provider: "codex-local",
    status: "needs_redraw",
    targetAssetPath,
    promptPath: promptAssetPath,
    redrawReason: reason,
    requestedAt: new Date().toISOString(),
  };
  syncImageAssets(project);
  return {
    spreadId,
    promptPath: promptAssetPath,
    targetAssetPath,
    status: spread.image.status,
  };
}

export function getNextCodexPrompt(project, { spreadId } = {}) {
  const contexts = spreadId
    ? [findSpread(project, spreadId)].filter(Boolean)
    : getPendingCodexSpreadContexts(project);
  const context = contexts[0];
  if (!context) return null;
  const { chapter, spread } = context;
  return {
    spreadId: spread.id,
    chapterId: chapter.id,
    title: chapter.title,
    caption: spread.caption,
    readerCaption: spread.readerCaption || spread.caption,
    promptPath: spread.image?.promptPath || `assets/codex-image-jobs/${spread.id}.md`,
    targetAssetPath: spread.image?.targetAssetPath || rasterTargetFor(spread.id),
    prompt: buildCodexImagePrompt({ project, chapter, spread }),
  };
}

export function getNextCodexQueuePrompt(project) {
  const item = getPendingCodexQueueContexts(project)[0];
  if (!item) return null;
  if (item.type === "character") {
    const promptPath = item.character.reference?.promptPath || `assets/codex-image-jobs/characters/${item.character.id}.md`;
    const targetAssetPath = item.character.reference?.targetAssetPath || `assets/characters/${item.character.id}.png`;
    return {
      type: "character",
      id: item.character.id,
      title: item.character.name,
      promptPath,
      targetAssetPath,
      prompt: buildCharacterReferencePrompt(project, item.character),
    };
  }
  const { chapter, spread } = item;
  return {
    type: "spread",
    id: spread.id,
    spreadId: spread.id,
    chapterId: chapter.id,
    title: chapter.title,
    caption: spread.caption,
    readerCaption: spread.readerCaption || spread.caption,
    promptPath: spread.image?.promptPath || `assets/codex-image-jobs/${spread.id}.md`,
    targetAssetPath: spread.image?.targetAssetPath || rasterTargetFor(spread.id),
    prompt: buildCodexImagePrompt({ project, chapter, spread }),
  };
}

function getPendingCodexSpreadContexts(project) {
  return (project.chapters || []).flatMap((chapter) => {
    return (chapter.spreads || [])
      .filter((spread) => spread.image?.provider === "codex-local" && spread.image?.status !== "ready")
      .map((spread) => ({ chapter, spread }));
  });
}

function getPendingCodexQueueContexts(project) {
  const characterItems = (project.characters || [])
    .filter((character) => character.reference?.status !== "ready")
    .map((character) => ({ type: "character", character }));
  const spreadItems = getPendingCodexSpreadContexts(project)
    .map(({ chapter, spread }) => ({ type: "spread", chapter, spread }));
  return [...characterItems, ...spreadItems];
}

function buildCodexQueueItems(project, spreadJobs) {
  const characterItems = (project.assets.characterReferences?.items || []).map((item) => ({
    type: "character",
    id: item.id,
    title: item.name,
    status: item.status,
    promptPath: item.promptPath,
    targetAssetPath: item.targetAssetPath,
    assetPath: item.assetPath,
    priority: item.status === "ready" ? 90 : 10,
  }));
  const spreadItems = spreadJobs.map((job, index) => ({
    type: "spread",
    id: job.spreadId,
    chapterId: job.chapterId,
    title: job.title,
    status: "needs_codex_generation",
    promptPath: job.promptPath,
    targetAssetPath: job.targetAssetPath,
    caption: job.caption,
    priority: 30 + index,
  }));
  return [...characterItems, ...spreadItems].sort((a, b) => a.priority - b.priority);
}

function buildCodexImagePrompt({ project, chapter, spread }) {
  const palette = (project.styleBible?.palette || []).join(", ");
  const characters = (spread.characterRefs || [])
    .map((id) => project.characters?.find((character) => character.id === id))
    .filter(Boolean)
    .map((character) => {
      const reference = character.reference?.assetPath
        ? ` Reference image already exists at ${character.reference.assetPath}.`
        : ` Character reference prompt: ${character.reference?.promptPath || `assets/codex-image-jobs/characters/${character.id}.md`}.`;
      return `${character.name}: ${character.description} Visual anchors: ${(character.visualAnchors || []).join(", ")}.${reference}`;
    })
    .join("\n");

  return `Use case: illustration-story
Asset type: children's picture-book spread illustration for BookFrames
Primary request: Create the illustration for spread ${spread.id}.
Scene/backdrop: ${spread.scenePrompt}
Subject: ${characters || "the main story characters described by the scene"}
Style/medium: ${project.styleBible?.artDirection || "warm illustrated picture-book art"}
Composition/framing: ${project.styleBible?.camera || "clear storybook composition"}; landscape 3:2 spread; leave calm negative space where a caption can be placed outside the image.
Lighting/mood: gentle, emotionally clear, child-safe, warm, readable silhouettes.
Color palette: ${palette || "warm paper, teal, coral, gold, soft blue-green"}.
Text: no text inside the image.
Constraints: keep recurring characters visually consistent; one clear action; no watermark; no logos; no visible typography; no scary violence.
Avoid: ${project.styleBible?.negativePrompt || "photorealistic, harsh horror, crowded tiny details, distorted hands, illegible text in image"}.

Reader caption context, not to render as text:
"${spread.caption}"

Source excerpt for grounding, not to render as text:
"${spread.sourceExcerpt || spread.caption}"

Save/import target in BookFrames:
${spread.image?.targetAssetPath || rasterTargetFor(spread.id)}
`;
}

async function ensureCharacterReferenceJobs(project, projectDir) {
  const jobsDir = path.join(projectDir, "assets", "codex-image-jobs", "characters");
  const charactersDir = path.join(projectDir, "assets", "characters");
  await mkdir(jobsDir, { recursive: true });
  await mkdir(charactersDir, { recursive: true });

  const characterAssets = [];
  for (const character of project.characters || []) {
    const promptPath = character.reference?.promptPath || `assets/codex-image-jobs/characters/${character.id}.md`;
    const targetAssetPath = character.reference?.targetAssetPath || `assets/characters/${character.id}.png`;
    const existing = await findExistingFile(projectDir, targetAssetPath);
    const prompt = buildCharacterReferencePrompt(project, character);
    await writeFile(path.join(projectDir, promptPath), prompt, "utf8");

    character.reference = {
      ...character.reference,
      status: existing ? "ready" : "needs_codex_generation",
      promptPath,
      targetAssetPath,
      ...(existing ? { assetPath: targetAssetPath } : {}),
      updatedAt: new Date().toISOString(),
    };
    characterAssets.push({
      id: character.id,
      name: character.name,
      status: character.reference.status,
      promptPath,
      targetAssetPath,
      assetPath: character.reference.assetPath,
    });
  }

  project.assets.characterReferences = {
    provider: "codex-local",
    count: characterAssets.length,
    readyCount: characterAssets.filter((asset) => asset.status === "ready").length,
    items: characterAssets,
    updatedAt: new Date().toISOString(),
  };
}

function buildCharacterReferencePrompt(project, character) {
  return `Use case: illustration-story
Asset type: character reference sheet for a children's picture-book generator
Primary request: Create a clean character reference sheet for ${character.name}.
Subject: ${character.description}
Visual anchors: ${(character.visualAnchors || []).join(", ")}
Style/medium: ${project.styleBible?.artDirection || "warm illustrated picture-book art"}
Composition/framing: one full-body front view, one side view, and three small expression heads on a simple warm paper background.
Lighting/mood: gentle, child-safe, clear, readable.
Color palette: ${(project.styleBible?.palette || []).join(", ") || "warm paper cream, deep teal, coral, gold, muted blue-green"}.
Text: no text, labels, captions, signatures, or watermark inside the image.
Constraints: the sheet is only for visual consistency; keep the design simple enough to reuse across many story pages.
Avoid: ${project.styleBible?.negativePrompt || "photorealistic, harsh horror, crowded tiny details, distorted hands, illegible text in image"}.

Save/import target in BookFrames:
${character.reference?.targetAssetPath || `assets/characters/${character.id}.png`}
`;
}

async function findExistingRaster(projectDir, spreadId) {
  for (const ext of [".png", ".jpg", ".jpeg", ".webp"]) {
    const assetPath = `assets/images/${spreadId}${ext}`;
    const absolutePath = path.join(projectDir, assetPath);
    const info = await stat(absolutePath).catch(() => null);
    if (info?.isFile()) return { assetPath, mtimeMs: info.mtimeMs };
  }
  return null;
}

function isRasterFreshForRedraw(raster, requestedAt) {
  const requestedAtMs = Date.parse(requestedAt || "");
  if (!Number.isFinite(requestedAtMs)) return true;
  return Number(raster?.mtimeMs || 0) >= requestedAtMs - 1000;
}

function findSpread(project, spreadId) {
  for (const chapter of project.chapters || []) {
    for (const spread of chapter.spreads || []) {
      if (spread.id === spreadId) return { chapter, spread };
    }
  }
  return null;
}

function syncImageAssets(project) {
  project.assets.images = (project.chapters || []).flatMap((chapter) => {
    return (chapter.spreads || []).map((spread) => ({
      id: spread.id,
      assetPath: spread.image?.assetPath,
      targetAssetPath: spread.image?.targetAssetPath || spread.image?.assetPath,
      promptPath: spread.image?.promptPath,
      provider: spread.image?.provider,
      status: spread.image?.status,
      qaStatus: spread.image?.qa?.status,
      promptHash: spread.image?.promptHash,
    }));
  });
}

async function inspectImageQuality(filePath, spread) {
  const meta = await readImageMetadata(filePath);
  const checks = [];
  const blockingIssues = [];
  const reviewNotes = [];

  if (!meta.width || !meta.height) {
    checks.push({ id: "dimensions", status: "fail", message: "Could not read image dimensions." });
    blockingIssues.push("unreadable_dimensions");
  } else {
    checks.push({ id: "dimensions", status: "pass", message: `${meta.width}x${meta.height}` });
  }

  const ratio = meta.width && meta.height ? meta.width / meta.height : 0;
  if (ratio && Math.abs(ratio - 1.5) <= 0.08) {
    checks.push({ id: "aspect_ratio", status: "pass", message: ratio.toFixed(2) });
  } else {
    checks.push({ id: "aspect_ratio", status: "fail", message: ratio ? ratio.toFixed(2) : "unknown" });
    blockingIssues.push("wrong_aspect_ratio");
  }

  if (meta.width >= 1024 && meta.height >= 680) {
    checks.push({ id: "minimum_size", status: "pass", message: "large_enough" });
  } else {
    checks.push({ id: "minimum_size", status: "fail", message: "below_1024x680" });
    blockingIssues.push("too_small");
  }

  if ((spread.characterRefs || []).length > 0) {
    checks.push({ id: "character_refs_declared", status: "pass", message: spread.characterRefs.join(",") });
  } else {
    checks.push({ id: "character_refs_declared", status: "warn", message: "no recurring character refs on this spread" });
  }

  reviewNotes.push("Manual review still needed for character drift, watermark/text artifacts, and caption-scene match.");

  return {
    status: blockingIssues.length ? "failed" : "basic_passed",
    checkedAt: new Date().toISOString(),
    width: meta.width,
    height: meta.height,
    format: meta.format,
    checks,
    blockingIssues,
    reviewNotes,
  };
}

async function readImageMetadata(filePath) {
  const buffer = await readFile(filePath);
  if (buffer.length >= 24 && buffer.toString("ascii", 1, 4) === "PNG") {
    return {
      format: "png",
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return readWebpMetadata(buffer);
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return readJpegMetadata(buffer);
  }

  return { format: "unknown", width: 0, height: 0 };
}

function readWebpMetadata(buffer) {
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X" && buffer.length >= 30) {
    const width = 1 + buffer.readUIntLE(24, 3);
    const height = 1 + buffer.readUIntLE(27, 3);
    return { format: "webp", width, height };
  }
  return { format: "webp", width: 0, height: 0 };
}

function readJpegMetadata(buffer) {
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        format: "jpeg",
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return { format: "jpeg", width: 0, height: 0 };
}

async function findExistingFile(projectDir, assetPath) {
  return exists(path.join(projectDir, assetPath));
}

async function writeGeneratedOpenAIImage(outputPath, prompt, { apiKey, model, size, quality }) {
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      prompt,
      size,
      quality,
      output_format: "png",
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.error?.message || `${response.status} ${response.statusText}`;
    throw new Error(`OpenAI image generation failed: ${message}`);
  }
  const first = payload.data?.[0];
  let buffer = null;
  if (first?.b64_json) {
    buffer = Buffer.from(first.b64_json, "base64");
  } else if (first?.url) {
    const imageResponse = await fetch(first.url);
    if (!imageResponse.ok) throw new Error(`OpenAI image download failed: ${imageResponse.status} ${imageResponse.statusText}`);
    buffer = Buffer.from(await imageResponse.arrayBuffer());
  }
  if (!buffer) throw new Error("OpenAI image generation returned no image data.");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, buffer);
}

function rasterTargetFor(spreadId) {
  return `assets/images/${spreadId}.png`;
}

async function listRecentImageFiles(root, limit) {
  const entries = [];
  await collectImageFiles(root, entries);
  return entries
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .reverse();
}

async function collectImageFiles(dir, entries, depth = 0) {
  if (!dir || depth > 4 || !(await exists(dir))) return;
  const children = await readdir(dir, { withFileTypes: true });
  for (const child of children) {
    const childPath = path.join(dir, child.name);
    if (child.isDirectory()) {
      await collectImageFiles(childPath, entries, depth + 1);
    } else if (/\.(png|jpe?g|webp)$/i.test(child.name)) {
      const info = await stat(childPath);
      entries.push({ filePath: childPath, mtimeMs: info.mtimeMs });
    }
  }
}

function normalizeImageExtension(ext) {
  const normalized = String(ext || "").toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(normalized)) return normalized;
  return ".png";
}

function makePlaceholderSvg({ project, chapter, spread }) {
  const palette = project.styleBible?.palette || ["#f7ead7", "#31515f", "#d9634f", "#e0a83f", "#6aa99b"];
  const accent = palette[Math.abs(hashString(spread.id)) % palette.length];
  const second = palette[(Math.abs(hashString(chapter.id)) + 2) % palette.length];
  const lines = wrapText(spread.caption, 38).slice(0, 4);
  const promptLines = wrapText(spread.scenePrompt.split("\n")[1]?.replace(/^Scene:\s*/, "") || "", 54).slice(0, 5);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="1024" viewBox="0 0 1536 1024" role="img" aria-label="${escapeXml(spread.caption)}">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="${escapeXml(palette[0])}"/>
      <stop offset="52%" stop-color="#fffaf0"/>
      <stop offset="100%" stop-color="${escapeXml(second)}" stop-opacity="0.42"/>
    </linearGradient>
    <filter id="grain">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
      <feComponentTransfer>
        <feFuncA type="table" tableValues="0 0.12"/>
      </feComponentTransfer>
    </filter>
  </defs>
  <rect width="1536" height="1024" fill="url(#bg)"/>
  <rect width="1536" height="1024" filter="url(#grain)" opacity="0.24"/>
  <path d="M114 746 C254 565 348 622 470 422 C604 203 832 206 978 360 C1115 504 1246 420 1410 238 L1410 900 L114 900 Z" fill="${escapeXml(accent)}" opacity="0.22"/>
  <circle cx="1110" cy="272" r="122" fill="${escapeXml(accent)}" opacity="0.55"/>
  <circle cx="1018" cy="298" r="34" fill="#fff7e8" opacity="0.8"/>
  <path d="M398 700 C448 592 548 538 640 590 C730 642 752 780 668 846 C566 926 350 806 398 700 Z" fill="${escapeXml(second)}" opacity="0.7"/>
  <path d="M498 574 C468 494 508 420 592 402 C688 382 764 454 744 548 C704 526 660 524 620 546 C580 568 542 578 498 574 Z" fill="#31515f" opacity="0.76"/>
  <g font-family="Avenir Next, Inter, system-ui, sans-serif" fill="#24333a">
    <text x="104" y="122" font-size="28" font-weight="700" letter-spacing="2">${escapeXml(chapter.title)}</text>
    <text x="104" y="174" font-size="62" font-weight="800">${escapeXml(project.book.title)}</text>
    ${lines.map((line, index) => `<text x="104" y="${790 + index * 42}" font-size="34" font-weight="700">${escapeXml(line)}</text>`).join("\n    ")}
  </g>
  <g font-family="Avenir Next, Inter, system-ui, sans-serif" fill="#31515f" opacity="0.72">
    ${promptLines.map((line, index) => `<text x="840" y="${704 + index * 30}" font-size="22">${escapeXml(line)}</text>`).join("\n    ")}
  </g>
</svg>
`;
}

function wrapText(text, maxLength) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxLength && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < String(value).length; index += 1) {
    hash = ((hash << 5) - hash + String(value).charCodeAt(index)) | 0;
  }
  return hash;
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
