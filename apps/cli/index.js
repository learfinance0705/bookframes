#!/usr/bin/env node
import { readJson, resolveManifestPath } from "../../packages/core/io.js";
import { lintBookProject, summarizeProject } from "../../packages/core/schema.js";
import {
  createBookProject,
  exportBookProject,
  generateOpenAIImagesForProject,
  getNextCodexPromptFromProject,
  getNextCodexQueuePromptFromProject,
  importCharacterReferenceToProject,
  importCodexImageToProject,
  importLatestCodexImagesToProject,
  importLatestCodexQueueToProject,
  markSpreadForRedrawInProject,
  prepareCodexImageJobs,
  renderExistingProject,
} from "../../packages/producer/index.js";

const [, , command, ...rest] = process.argv;

try {
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
  } else if (command === "create") {
    await createCommand(rest);
  } else if (command === "render") {
    await renderCommand(rest);
  } else if (command === "export") {
    await exportCommand(rest);
  } else if (command === "lint") {
    await lintCommand(rest);
  } else if (command === "inspect") {
    await inspectCommand(rest);
  } else if (command === "codex-jobs") {
    await codexJobsCommand(rest);
  } else if (command === "import-image") {
    await importImageCommand(rest);
  } else if (command === "import-character") {
    await importCharacterCommand(rest);
  } else if (command === "import-latest") {
    await importLatestCommand(rest);
  } else if (command === "import-queue") {
    await importQueueCommand(rest);
  } else if (command === "next-prompt") {
    await nextPromptCommand(rest);
  } else if (command === "next-queue-prompt") {
    await nextQueuePromptCommand(rest);
  } else if (command === "generate-openai") {
    await generateOpenAICommand(rest);
  } else if (command === "redraw") {
    await redrawCommand(rest);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(`BookFrames error: ${error.message}`);
  process.exitCode = 1;
}

async function createCommand(args) {
  const { positional, flags } = parseArgs(args);
  const sourcePath = positional[0];
  if (!sourcePath) throw new Error("create requires a source .txt/.md/.epub/.pdf file");
  const outDir = flags.out || "bookframes-project";

  const result = await createBookProject({
    sourcePath,
    outDir,
    title: flags.title,
    audienceAge: flags.age || "6-9",
    stylePreset: flags.style || "warm-watercolor",
    spreadsPerChapter: flags["spreads-per-chapter"] || "full-coverage",
    languageProfile: flags.language || flags.lang || "auto",
    imageProvider: flags["image-provider"] || "placeholder",
    ingestOptions: {
      pdfEngine: flags["pdf-engine"] || "auto",
      ocrMode: flags.ocr || "auto",
      ocrLang: flags["ocr-lang"],
      ocrMaxPages: flags["ocr-max-pages"],
      ocrRecognition: flags["ocr-recognition"],
      ocrScale: flags["ocr-scale"],
      expectedLanguage: flags.language || flags.lang,
      minTextChars: flags["min-text-chars"],
      autoMineruRoute: flags["auto-mineru-route"],
      preferMineru: flags["prefer-mineru"],
      mineruBackend: flags["mineru-backend"],
      mineruBin: flags["mineru-bin"],
      mineruLang: flags["mineru-lang"],
      mineruMethod: flags["mineru-method"],
      mineruImageAnalysis: flags["mineru-image-analysis"],
      mineruTimeoutMs: flags["mineru-timeout-ms"],
      chapterMapPath: flags["chapter-map"],
    },
  });

  printResult("created", result);
}

async function renderCommand(args) {
  const { positional, flags } = parseArgs(args);
  const inputPath = positional[0] || ".";
  const result = await renderExistingProject(inputPath, {
    imageProvider: flags["image-provider"] || "preserve",
  });
  printResult("rendered", result);
}

async function exportCommand(args) {
  const { positional } = parseArgs(args);
  const inputPath = positional[0] || ".";
  const result = await exportBookProject(inputPath);
  printResult("exported", result);
  console.log(`print html: ${result.project.exports.printHtml}`);
  console.log(`review pdf: ${result.project.exports.reviewPdf}`);
  console.log(`epub: ${result.project.exports.epub}`);
}


async function lintCommand(args) {
  const { positional } = parseArgs(args);
  const manifestPath = resolveManifestPath(positional[0] || ".");
  const project = await readJson(manifestPath);
  const lint = lintBookProject(project);

  for (const error of lint.errors) console.error(`error: ${error}`);
  for (const warning of lint.warnings) console.warn(`warning: ${warning}`);
  console.log(lint.valid ? "BookFrames lint: valid" : "BookFrames lint: invalid");
  process.exitCode = lint.valid ? 0 : 1;
}

async function inspectCommand(args) {
  const { positional } = parseArgs(args);
  const manifestPath = resolveManifestPath(positional[0] || ".");
  const project = await readJson(manifestPath);
  console.log(JSON.stringify({
    manifestPath,
    ...summarizeProject(project),
  }, null, 2));
}

async function codexJobsCommand(args) {
  const { positional, flags } = parseArgs(args);
  const inputPath = positional[0] || ".";
  const limit = Number(flags.limit || 5);
  const result = await prepareCodexImageJobs(inputPath);
  const jobs = result.jobs.slice(0, limit);

  printResult("prepared Codex image jobs for", result);
  console.log(`pending codex jobs: ${result.jobs.length}`);
  console.log(`jobs file: ${result.project.assets.codexImageJobs.jobsPath}`);
  console.log(`queue file: ${result.project.assets.codexImageQueue?.queuePath || "n/a"}`);
  console.log(`pending queue items: ${result.queue.length}`);
  if (result.project.assets.characterReferences?.items?.length) {
    console.log(`character refs: ${result.project.assets.characterReferences.readyCount}/${result.project.assets.characterReferences.count} ready`);
    for (const item of result.project.assets.characterReferences.items) {
      console.log(`character ${item.id}: ${item.status} · ${item.promptPath}`);
    }
  }

  for (const job of jobs) {
    console.log("");
    console.log(`--- ${job.spreadId} ---`);
    console.log(`prompt: ${job.promptPath}`);
    console.log(`target: ${job.targetAssetPath}`);
    console.log(`caption: ${job.caption}`);
  }

  if (result.jobs.length > limit) {
    console.log(`... ${result.jobs.length - limit} more job(s); increase --limit to print more.`);
  }
}

async function importImageCommand(args) {
  const { positional } = parseArgs(args);
  const [inputPath, spreadId, imagePath] = positional;
  if (!inputPath || !spreadId || !imagePath) {
    throw new Error("import-image requires <project-dir|bookframes.json> <spread-id> <image-file>");
  }

  const result = await importCodexImageToProject(inputPath, { spreadId, imagePath });
  printResult(`imported image for ${spreadId}`, result);
  console.log(`asset: ${result.image.assetPath}`);
}

async function importCharacterCommand(args) {
  const { positional } = parseArgs(args);
  const [inputPath, characterId, imagePath] = positional;
  if (!inputPath || !characterId || !imagePath) {
    throw new Error("import-character requires <project-dir|bookframes.json> <character-id> <image-file>");
  }

  const result = await importCharacterReferenceToProject(inputPath, { characterId, imagePath });
  printResult(`imported character reference for ${characterId}`, result);
  console.log(`asset: ${result.reference.assetPath}`);
}

async function importLatestCommand(args) {
  const { positional, flags } = parseArgs(args);
  const inputPath = positional[0] || ".";
  const result = await importLatestCodexImagesToProject(inputPath, {
    limit: Number(flags.limit || 1),
    sourceRoot: flags.source,
    spreadId: flags.spread,
  });

  printResult("imported latest Codex images for", result);
  for (const item of result.imported) {
    console.log(`${item.spreadId}: ${item.imagePath} <= ${item.importedFrom}`);
  }
}

async function importQueueCommand(args) {
  const { positional, flags } = parseArgs(args);
  const inputPath = positional[0] || ".";
  const result = await importLatestCodexQueueToProject(inputPath, {
    limit: Number(flags.limit || 1),
    sourceRoot: flags.source,
  });

  printResult("imported latest Codex queue items for", result);
  for (const item of result.imported) {
    console.log(`${item.type}:${item.id}: ${item.imagePath} <= ${item.importedFrom}${item.qaStatus ? ` (${item.qaStatus})` : ""}`);
  }
}

async function generateOpenAICommand(args) {
  const { positional, flags } = parseArgs(args);
  const inputPath = positional[0] || ".";
  const result = await generateOpenAIImagesForProject(inputPath, {
    limit: Number(flags.limit || 1),
    model: flags.model,
    size: flags.size,
    quality: flags.quality,
  });

  printResult("generated OpenAI images for", result);
  for (const item of result.generated) {
    console.log(`${item.type}:${item.id}: ${item.imagePath}${item.qaStatus ? ` (${item.qaStatus})` : ""}`);
  }
}

async function nextPromptCommand(args) {
  const { positional, flags } = parseArgs(args);
  const inputPath = positional[0] || ".";
  const result = await getNextCodexPromptFromProject(inputPath, {
    spreadId: flags.spread,
  });

  if (!result.prompt) {
    console.log("No pending Codex prompt.");
    return;
  }

  console.log(`spread: ${result.prompt.spreadId}`);
  console.log(`prompt: ${result.prompt.promptPath}`);
  console.log(`target: ${result.prompt.targetAssetPath}`);
  console.log("");
  console.log(result.prompt.prompt);
}

async function nextQueuePromptCommand(args) {
  const { positional } = parseArgs(args);
  const inputPath = positional[0] || ".";
  const result = await getNextCodexQueuePromptFromProject(inputPath);

  if (!result.prompt) {
    console.log("No pending Codex queue prompt.");
    return;
  }

  console.log(`type: ${result.prompt.type}`);
  console.log(`id: ${result.prompt.id || result.prompt.spreadId}`);
  console.log(`prompt: ${result.prompt.promptPath}`);
  console.log(`target: ${result.prompt.targetAssetPath}`);
  console.log("");
  console.log(result.prompt.prompt);
}

async function redrawCommand(args) {
  const { positional, flags } = parseArgs(args);
  const [inputPath, spreadId] = positional;
  if (!inputPath || !spreadId) {
    throw new Error("redraw requires <project-dir|bookframes.json> <spread-id>");
  }
  const result = await markSpreadForRedrawInProject(inputPath, {
    spreadId,
    reason: flags.reason || "manual_redraw",
  });
  printResult(`marked ${spreadId} for redraw`, result);
  console.log(`prompt: ${result.redraw.promptPath}`);
  console.log(`target: ${result.redraw.targetAssetPath}`);
}

function parseArgs(args) {
  const positional = [];
  const flags = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      index += 1;
    }
  }

  return { positional, flags };
}

function printResult(action, result) {
  const { summary, lint, manifestPath, htmlPath } = result;
  console.log(`BookFrames ${action}: ${summary.title}`);
  console.log(`manifest: ${manifestPath}`);
  console.log(`preview: ${htmlPath}`);
  if (summary.sourceFormat) {
    console.log(`source: ${summary.sourceFormat} via ${summary.extractionMethod || "unknown"} (${summary.extractionStatus || "unknown"}${summary.ocrStatus ? `, ocr:${summary.ocrStatus}` : ""})`);
    if (summary.importQualityScore !== null && summary.importQualityScore !== undefined) {
      console.log(`import quality: ${summary.importQualityScore}/100 (${summary.importQualityLevel || "unknown"}, split:${summary.chapterSplitMethod || "unknown"})`);
    }
  }
  console.log(`chapters: ${summary.chapterCount}`);
  console.log(`spreads: ${summary.spreadCount}`);
  if (summary.pagePlanMode) {
    console.log(`page plan: ${summary.pagePlanMode}${summary.pagePlanProvider ? ` via ${summary.pagePlanProvider}` : ""}${summary.pagePlanAverageSpreadsPerChapter ? `, avg ${summary.pagePlanAverageSpreadsPerChapter}/chapter` : ""}`);
  }
  console.log(`images: ${summary.readyImageCount}/${summary.spreadCount} ready (${summary.pendingImageCount} pending, ${summary.imageCount} preview assets)`);
  if (summary.codexQueuePath) console.log(`codex queue: ${summary.codexQueuePendingCount} pending · ${summary.codexQueuePath}`);
  if (summary.planningStatus) console.log(`planning: ${summary.planningStatus}`);
  console.log(`qa: ${summary.qaPassedCount}/${summary.spreadCount} basic passed, ${summary.needsRedrawCount} needs redraw`);
  console.log(`character refs: ${summary.readyCharacterReferenceCount}/${summary.characterReferenceCount} ready`);
  console.log(`lint: ${lint.valid ? "valid" : "invalid"} (${lint.errors.length} errors, ${lint.warnings.length} warnings)`);
  for (const warning of lint.warnings.slice(0, 5)) console.warn(`warning: ${warning}`);
}

function printHelp() {
  console.log(`BookFrames CLI

Commands:
  create <source.txt|source.md|source.epub|source.pdf> --out <dir> [--title <title>] [--language zh|ja|en|zh-en|zh-ja|ja-en] [--age 6-9] [--style warm-watercolor] [--spreads-per-chapter full-coverage|codex-auto|1-8] [--ocr auto|always|never] [--ocr-lang zh-Hans,en-US] [--ocr-max-pages 80] [--ocr-recognition fast|accurate] [--ocr-scale 1.25] [--pdf-engine auto|native|mineru-pipeline|mineru-vlm|mineru-hybrid] [--chapter-map chapters.json]
  render <project-dir|bookframes.json>
  export <project-dir|bookframes.json>
  lint <project-dir|bookframes.json>
  inspect <project-dir|bookframes.json>
  codex-jobs <project-dir|bookframes.json> [--limit 5]
  next-prompt <project-dir|bookframes.json> [--spread <spread-id>]
  next-queue-prompt <project-dir|bookframes.json>
  generate-openai <project-dir|bookframes.json> [--limit 1] [--model gpt-image-1] [--size 1536x1024] [--quality auto]
  redraw <project-dir|bookframes.json> <spread-id> [--reason <text>]
  import-image <project-dir|bookframes.json> <spread-id> <image-file>
  import-character <project-dir|bookframes.json> <character-id> <image-file>
  import-latest <project-dir|bookframes.json> [--limit 1] [--spread <spread-id>] [--source ~/.codex/generated_images]
  import-queue <project-dir|bookframes.json> [--limit 1] [--source ~/.codex/generated_images]

Examples:
  npm run demo
  node apps/cli/index.js create examples/tiny-adventure.txt --out runs/tiny-adventure --title "Tiny Adventure"
  node apps/cli/index.js create ~/Books/story.epub --out runs/story --spreads-per-chapter full-coverage
  node apps/cli/index.js create ~/Books/story.epub --out runs/story --title "Story" --language zh-en
  node apps/cli/index.js create ~/Books/story.pdf --out runs/story --ocr auto --ocr-lang zh-Hans,en-US --ocr-recognition fast --ocr-scale 1.25
  node apps/cli/index.js create ~/Books/scanned.pdf --out runs/story-vlm --pdf-engine mineru-hybrid --mineru-lang ch
  node apps/cli/index.js create ~/Books/story.pdf --out runs/story --chapter-map chapters.json
  node apps/cli/index.js render runs/tiny-adventure --image-provider codex-local
  node apps/cli/index.js export runs/tiny-adventure
  node apps/cli/index.js codex-jobs runs/tiny-adventure --limit 3
  node apps/cli/index.js next-prompt runs/tiny-adventure
  node apps/cli/index.js next-queue-prompt runs/tiny-adventure
  OPENAI_API_KEY=... node apps/cli/index.js generate-openai runs/tiny-adventure --limit 1
  node apps/cli/index.js redraw runs/tiny-adventure ch-02-sp-01
  node apps/cli/index.js import-latest runs/tiny-adventure --limit 1
  node apps/cli/index.js import-queue runs/tiny-adventure --limit 3
`);
}
