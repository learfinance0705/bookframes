import assert from "node:assert/strict";
import { rm, stat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createBookProject,
  exportBookProject,
  generateOpenAIImagesForProject,
  getNextCodexQueuePromptFromProject,
  importCodexImageToProject,
  prepareCodexImageJobs,
} from "../packages/producer/index.js";
import { analyzeTextQuality, normalizeText, splitIntoChapters } from "../packages/ingest/index.js";
import { deriveCharacterReview, deriveCharacters, referencedCharacters } from "../packages/planner/index.js";
import {
  applyOcrCaptionCorrectionsToProject,
  applyCaptionLanguageModeToProject,
  applySourceAdaptationsToProject,
  buildCaptionLocalizationPrompt,
  buildChangePlanPrompt,
  buildChangeRequestPrompt,
  buildCodexImageRunPrompt,
  buildLocalCodexPagePlanShardPrompt,
  buildOcrCaptionPolishPrompt,
  buildSourceAdaptationPrompt,
  parseCodexGeneratedImagePathsFromLog,
  resolveProjectFile,
} from "../apps/web/server.js";

const root = process.cwd();
const outDir = path.join(root, "tests", "tmp", "smoke-project");
const autoOutDir = path.join(root, "tests", "tmp", "auto-page-plan-project");
const fullOutDir = path.join(root, "tests", "tmp", "full-coverage-project");
const pdfOutDir = path.join(root, "tests", "tmp", "pdf-project");
const pdfCachedOutDir = path.join(root, "tests", "tmp", "pdf-project-cached");
const pdfCacheDir = path.join(root, "tests", "tmp", "ingest-cache");
await rm(outDir, { recursive: true, force: true });
await rm(autoOutDir, { recursive: true, force: true });
await rm(fullOutDir, { recursive: true, force: true });
await rm(pdfOutDir, { recursive: true, force: true });
await rm(pdfCachedOutDir, { recursive: true, force: true });
await rm(pdfCacheDir, { recursive: true, force: true });

const result = await createBookProject({
  sourcePath: path.join(root, "examples", "tiny-adventure.txt"),
  outDir,
  title: "Tiny Adventure",
  audienceAge: "6-9",
  stylePreset: "warm-watercolor",
  spreadsPerChapter: 3,
});

assert.equal(result.lint.valid, true);
assert.equal(result.summary.chapterCount, 3);
assert.equal(result.summary.spreadCount, 9);
assert.equal(result.summary.imageCount, 9);
assert.equal(result.summary.readyImageCount, 9);

await stat(result.manifestPath);
await stat(result.htmlPath);

const html = await readFile(result.htmlPath, "utf8");
assert.match(html, /Tiny Adventure/);
assert.match(html, /ch-01-sp-01/);
assert.match(html, /Start Reading/);
const studioHtml = await readFile(path.join(outDir, "dist", "studio.html"), "utf8");
assert.match(studioHtml, /BookFrames Studio/);
assert.match(studioHtml, /Plan QA/);
await stat(path.join(outDir, "planning", "story-arc.json"));
await stat(path.join(outDir, "planning", "planning-review.json"));
await stat(path.join(outDir, "planning", "character-review.json"));
await stat(path.join(outDir, "planning", "page-plan.json"));
const createdManifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
assert.ok(createdManifest.chapters[0].spreads[0].sourceTextStats.charCount > 0);
assert.equal(createdManifest.book.pagePlan.mode, "fixed");
assert.equal(createdManifest.book.pagePlan.totalSpreadCount, 9);
assert.equal(typeof createdManifest.planningReview.checks.highDensitySpreadCount, "number");
assert.equal(Array.isArray(createdManifest.characterReview.candidates), true);
assert.ok(createdManifest.chapters[0].spreads[0].sourcePassage.length >= createdManifest.chapters[0].spreads[0].sourceExcerpt.length);

const autoResult = await createBookProject({
  sourcePath: path.join(root, "examples", "tiny-adventure.txt"),
  outDir: autoOutDir,
  title: "Auto Page Plan",
  audienceAge: "6-9",
  stylePreset: "warm-watercolor",
  spreadsPerChapter: "codex-auto",
});
assert.equal(autoResult.lint.valid, true);
assert.equal(autoResult.project.book.pagePlan.mode, "heuristic");
assert.equal(autoResult.project.book.pagePlan.provider, "heuristic");
assert.equal(autoResult.project.book.pagePlan.chapters.length, 3);
assert.equal(autoResult.summary.spreadCount, autoResult.project.book.pagePlan.totalSpreadCount);

const fullResult = await createBookProject({
  sourcePath: path.join(root, "examples", "tiny-adventure.txt"),
  outDir: fullOutDir,
  title: "Full Coverage Plan",
  audienceAge: "6-9",
  stylePreset: "warm-watercolor",
  spreadsPerChapter: "full-coverage",
});
assert.equal(fullResult.lint.valid, true);
assert.equal(fullResult.project.book.pagePlan.mode, "full-coverage");
assert.equal(fullResult.project.book.pagePlan.provider, "heuristic-complete");
assert.equal(fullResult.project.book.pagePlan.maxSpreads, 60);
assert.ok(fullResult.summary.spreadCount >= fullResult.summary.chapterCount * 2);
assert.equal(fullResult.summary.spreadCount, fullResult.project.book.pagePlan.totalSpreadCount);

const webHtml = await readFile(path.join(root, "apps", "web", "index.html"), "utf8");
const webCss = await readFile(path.join(root, "apps", "web", "styles.css"), "utf8");
const webJs = await readFile(path.join(root, "apps", "web", "app.js"), "utf8");
const webServerJs = await readFile(path.join(root, "apps", "web", "server.js"), "utf8");
const webBundle = [webHtml, webCss, webJs].join("\n");
assert.match(webHtml, /BookFrames Workbench/);
assert.match(webHtml, /导入审稿/);
assert.match(webHtml, /修改意见/);
assert.match(webHtml, /导入并自动绘制整本/);
assert.match(webHtml, /字幕改成中英/);
assert.match(webHtml, /只改字幕和导出文件，不重画图片/);
assert.match(webHtml, /大模型接入/);
assert.match(webHtml, /modelProviderInput/);
assert.match(webHtml, /不在浏览器保存密钥/);
assert.match(webHtml, /复制下一张 Prompt/);
assert.match(webHtml, /本地 Codex 生成 1 张/);
assert.match(webHtml, /自动绘制整本/);
assert.match(webHtml, /full-coverage/);
assert.match(webHtml, /codex-auto/);
assert.match(webHtml, /value="full-coverage"/);
assert.match(webHtml, /imageRunView/);
assert.match(webHtml, /生成修改计划/);
assert.match(webJs, /mode: "all"/);
assert.match(webJs, /book-runs/);
assert.match(webJs, /image-queue\/next/);
assert.match(webJs, /image-runs/);
assert.match(webJs, /captions\/language/);
assert.match(webJs, /renderSpreadCaption/);
assert.match(webJs, /codex-exec/);
assert.match(webJs, /generateOneImageWithLocalCodex/);
assert.match(webJs, /generateFullBookWithLocalCodex/);
assert.match(webJs, /loadModelConfig/);
assert.match(webJs, /saveModelConfig/);
assert.match(webJs, /testModelConfig/);
assert.match(webJs, /imageProviderForCurrentModel/);
assert.match(webJs, /isRevisionLocked/);
assert.match(webJs, /pollImageRun/);
assert.match(webJs, /handleImageRunAction/);
assert.match(webJs, /暂停画图/);
assert.match(webJs, /继续绘制/);
assert.match(webJs, /change-requests/);
assert.match(webJs, /planChangeRequest/);
assert.match(webJs, /edit-spread/);
assert.match(webJs, /syncInputsFromProject/);
assert.match(webJs, /bookframes\.json/);
assert.match(webJs, /页数规划/);
assert.match(webJs, /full-coverage/);
assert.match(webJs, /pagePlan\?\.mode && pagePlan\.mode !== "fixed"\) return "full-coverage"/);
assert.doesNotMatch(webJs, /Mira/);
assert.match(webServerJs, /\/api\/change-requests/);
assert.match(webServerJs, /\/api\/book-runs/);
assert.match(webServerJs, /\/api\/model-config/);
assert.match(webServerJs, /normalizeModelConfig/);
assert.match(webServerJs, /testModelConnection/);
assert.match(webServerJs, /\/api\/image-queue\/generate-openai/);
assert.match(webServerJs, /\/api\/image-runs/);
assert.match(webServerJs, /\/pause/);
assert.match(webServerJs, /pauseImageRun/);
assert.match(webServerJs, /startImageRun/);
assert.match(webServerJs, /startBookRun/);
assert.match(webServerJs, /runCodexExecImageBatchJob/);
assert.match(webServerJs, /runCodexExecImageJob/);
assert.match(webServerJs, /buildCodexImageRunPrompt/);
assert.match(webServerJs, /local-codex-parallel/);
assert.match(webServerJs, /BOOKFRAMES_CODEX_PAGE_PLAN_CONCURRENCY/);
assert.match(webServerJs, /BOOKFRAMES_CODEX_LOCALIZATION_BATCH_SIZE/);
assert.match(webServerJs, /localizing caption batch/);
assert.match(webServerJs, /spreadLimitFromEnv/);
assert.doesNotMatch(webServerJs, /SOURCE_ADAPT_MAX_SPREADS \|\| 360/);
assert.doesNotMatch(webServerJs, /OCR_POLISH_MAX_SPREADS \|\| 140/);
assert.doesNotMatch(webServerJs, /using source captions as placeholders/);
assert.match(webServerJs, /\/plan/);
assert.match(webServerJs, /snapshotPath/);
assert.doesNotMatch(webServerJs, /ask-for-approval/);
assert.match(webCss, /\.workspace/);
assert.doesNotMatch(webBundle, /视频|mp4|renderVideo/i);

const shardPrompt = buildLocalCodexPagePlanShardPrompt({
  title: "Parallel Plan",
  outputPath: "/tmp/page-plan.part-01.codex.json",
  shard: [
    {
      chapterIndex: 0,
      chapterId: "ch-01",
      title: "Opening",
      charCount: 1200,
      paragraphCount: 8,
      opening: "Once upon a page.",
      closing: "The chapter turns.",
    },
  ],
});
assert.match(shardPrompt, /并行页数规划/);
assert.match(shardPrompt, /page-plan\.part-01\.codex\.json/);
assert.match(shardPrompt, /spreadCount/);

const resolvedProjectFile = resolveProjectFile(root, "/tests/tmp/smoke-project/bookframes.json");
assert.equal(resolvedProjectFile, path.join(outDir, "bookframes.json"));
const changePrompt = buildChangeRequestPrompt({
  projectFile: resolvedProjectFile,
  projectTitle: "Tiny Adventure",
  target: "planning",
  selectedChapter: "ch-01",
  context: {
    spread: {
      id: "ch-01-sp-02",
      visualIntent: "gentle rain",
    },
  },
  planText: "先修改 ch-01-sp-02 的提示词，再标记 needs_redraw。",
  feedback: "让第一章节奏更慢，画图提示词保持水彩风格。",
}, { root });
assert.match(changePrompt, /Tiny Adventure/);
assert.match(changePrompt, /让第一章节奏更慢/);
assert.match(changePrompt, /ch-01-sp-02/);
assert.match(changePrompt, /已生成修改计划/);
assert.match(changePrompt, /npm test/);
const planPrompt = buildChangePlanPrompt({
  projectFile: resolvedProjectFile,
  projectTitle: "Tiny Adventure",
  target: "spread",
  selectedChapter: "ch-01",
  context: {
    spread: {
      id: "ch-01-sp-02",
    },
  },
  feedback: "第二页雨夜更温柔。",
}, { root });
assert.match(planPrompt, /请只生成修改计划/);
assert.match(planPrompt, /needs_redraw/);
const imageRunPrompt = buildCodexImageRunPrompt({
  root,
  projectFile: resolvedProjectFile,
  promptFile: path.join(outDir, "assets", "codex-image-jobs", "characters", "alice.md"),
  targetFile: path.join(outDir, "assets", "characters", "alice.png"),
  item: {
    type: "character",
    id: "alice",
  },
});
assert.match(imageRunPrompt, /没有 OPENAI_API_KEY/);
assert.match(imageRunPrompt, /内置图片生成能力/);
assert.match(imageRunPrompt, /不要调用外部 API 脚本/);
assert.match(imageRunPrompt, /assets\/characters\/alice\.png/);
const parsedGeneratedImages = parseCodexGeneratedImagePathsFromLog(`
copied /Users/employee/.codex/generated_images/019e48f7-d14a-7000-aa47-01f9a0f6c28e/ig_016110bde5b61490016a0e959ff6208193a1a16cef0c931590.png
and /Users/employee/.codex/generated_images/019e48f7-f3eb-7151-815a-1618e36531d2/ig_0844016b82647d70016a0e95af936481909f3cbaff4919b148.webp.
`);
assert.equal(parsedGeneratedImages.length, 2);
assert.equal(path.basename(parsedGeneratedImages[0]), "ig_016110bde5b61490016a0e959ff6208193a1a16cef0c931590.png");
assert.equal(path.extname(parsedGeneratedImages[1]), ".webp");

const ocrPolishPrompt = buildOcrCaptionPolishPrompt({
  manifestPath: path.join(outDir, "bookframes.json"),
  outputPath: path.join(outDir, "planning", "ocr-caption-polish.codex.json"),
  project: createdManifest,
  candidates: [{
    id: "ch-01-sp-01",
    chapterTitle: "第一章",
    caption: "我从1912年开始教授演郎，也就是泰进几克号沉没的同一年。",
    sourceExcerpt: "卡耐基课科廾课之初都会有些示兆表演。",
    sceneText: "学员害怕上台说话，希望变得自信。",
  }],
});
assert.match(ocrPolishPrompt, /OCR caption proofreading/);
assert.match(ocrPolishPrompt, /ocr-caption-polish\.codex\.json/);
assert.match(ocrPolishPrompt, /演郎/);
const captionLocalizationPrompt = buildCaptionLocalizationPrompt({
  manifestPath: path.join(outDir, "bookframes.json"),
  project: createdManifest,
  pending: [{
    chapterId: "ch-01",
    spreadId: "ch-01-sp-01",
    language: "zh",
    label: "中文",
    sourceText: "Mira folded a paper boat beside the window.",
  }],
  batchIndex: 1,
  totalBatches: 2,
});
assert.match(captionLocalizationPrompt, /当前批次：1\/2/);
assert.match(captionLocalizationPrompt, /本批只处理/);
assert.match(captionLocalizationPrompt, /不要把 sourceText 原样复制到不同语言/);
const captionModeProject = JSON.parse(JSON.stringify(createdManifest));
const imageBeforeCaptionMode = JSON.stringify(captionModeProject.chapters[0].spreads[0].image);
const captionModeApplied = applyCaptionLanguageModeToProject(captionModeProject, "zh-en");
const captionModeSpread = captionModeProject.chapters[0].spreads[0];
const zhLine = captionModeSpread.captionI18n.lines.find((line) => line.language === "zh");
const enLine = captionModeSpread.captionI18n.lines.find((line) => line.language === "en");
assert.equal(captionModeProject.book.languageProfile.bilingual, true);
assert.equal(captionModeApplied.pendingCaptionCount, captionModeProject.chapters.flatMap((chapter) => chapter.spreads).length);
assert.equal(zhLine.needsTranslation, true);
assert.equal(zhLine.text, "");
assert.equal(enLine.text, captionModeSpread.readerCaption);
assert.equal(JSON.stringify(captionModeSpread.image), imageBeforeCaptionMode);
const polishProject = JSON.parse(JSON.stringify(createdManifest));
const polishApplied = applyOcrCaptionCorrectionsToProject(polishProject, {
  spreads: [{
    id: "ch-01-sp-01",
    caption: "1912年，卡耐基开始教授演讲，帮助学员面对上台恐惧。",
    sceneSummary: "温暖的课堂里，紧张的学员围坐在一起，老师鼓励他们练习公开表达。",
  }],
}, {
  updatedAt: "2026-05-21T00:00:00.000Z",
});
const polishedSpread = polishProject.chapters[0].spreads[0];
assert.equal(polishApplied.updatedCount, 1);
assert.equal(polishedSpread.caption, "1912年，卡耐基开始教授演讲，帮助学员面对上台恐惧。");
assert.match(polishedSpread.scenePrompt, /老师鼓励他们练习公开表达/);
assert.equal(polishedSpread.ocrPolish.originalCaption, createdManifest.chapters[0].spreads[0].caption);
assert.equal(polishedSpread.image.status, "needs_redraw");
const sourceAdaptationPrompt = buildSourceAdaptationPrompt({
  manifestPath: path.join(outDir, "bookframes.json"),
  outputPath: path.join(outDir, "planning", "source-adaptation.part-01.codex.json"),
  project: createdManifest,
  candidates: [{
    id: "ch-01-sp-01",
    chapterTitle: "Opening",
    sourceLanguage: "en",
    currentCaption: "Mira folded a paper boat beside the window.",
    sourcePassage: "Mira folded a paper boat beside the window and decided to follow the rain's path.",
  }],
});
assert.match(sourceAdaptationPrompt, /真实内容/);
assert.match(sourceAdaptationPrompt, /sourcePassage/);
const sourceAdaptProject = JSON.parse(JSON.stringify(createdManifest));
const sourceAdaptApplied = applySourceAdaptationsToProject(sourceAdaptProject, {
  spreads: [{
    id: "ch-01-sp-01",
    caption: "Mira turns a rainy window into the start of a small voyage.",
    sceneSummary: "Mira folds a paper boat at the window while rain streaks the glass, ready to follow where it goes.",
  }],
}, {
  updatedAt: "2026-05-21T00:00:00.000Z",
});
const sourceAdaptedSpread = sourceAdaptProject.chapters[0].spreads[0];
assert.equal(sourceAdaptApplied.updatedCount, 1);
assert.equal(sourceAdaptedSpread.sourceAdaptation.originalCaption, createdManifest.chapters[0].spreads[0].caption);
assert.equal(sourceAdaptedSpread.image.status, "needs_redraw");
assert.equal(sourceAdaptedSpread.image.redrawReason, "source_content_adapted");

const gutenbergLikeText = normalizeText(`
Project Gutenberg header
*** START OF THE PROJECT GUTENBERG EBOOK SAMPLE ***
Contents

CHAPTER I. The Door
CHAPTER II. The Garden

CHAPTER I.
The Door

Alice found a little door.

CHAPTER II.
The Garden

Alice walked into the garden.
*** END OF THE PROJECT GUTENBERG EBOOK SAMPLE ***
License text
`);
const gutenbergChapters = splitIntoChapters(gutenbergLikeText);
assert.equal(gutenbergChapters.length, 2);
assert.equal(gutenbergChapters[0].title, "CHAPTER I. The Door");
assert.doesNotMatch(gutenbergChapters[1].text, /License text/);

const chineseTocText = normalizeText(`
封面
目录
第一章 基本技巧/3
一、从经验中获得信心/4
第二章 建立自信/15
一、做好准备/18

引言
这是一段正文前言。

第一章
掌握基本的技巧
真正的第一章正文，讲述演讲课程如何开始。

第二章
建立自信
真正的第二章正文，讲述准备与练习。
`);
const chineseTocChapters = splitIntoChapters(chineseTocText);
assert.equal(chineseTocChapters.length, 2);
assert.equal(chineseTocChapters[0].title, "第一章 掌握基本的技巧");
assert.doesNotMatch(chineseTocChapters[0].text, /从经验中获得信心/);
assert.equal(chineseTocChapters[1].title, "第二章 建立自信");

const chineseOcrOrdinalChapters = splitIntoChapters(normalizeText(`
第一章
开场
这里是真正的开场正文。

第二章
继续
这里是真正的继续正文。

第三章
推进
这里是真正的推进正文。

第叫章
把握机会
这里是真正的第四章正文。

第五章
收束
这里是真正的收束正文。
`));
assert.equal(chineseOcrOrdinalChapters[3].title, "第四章 把握机会");

const coarseEpubLikeText = normalizeText(`
Book marketing page
Eight things this book will help you do.

PART ONE
Helpful Techniques

1
THE FIRST CLEAR LESSON

${"A classroom story shows how blame makes people defensive, while patient understanding opens the conversation.\n\n".repeat(180)}

PRINCIPLE 1
Begin with understanding.

2
THE SECOND CLEAR LESSON

${"A manager learns to notice sincere effort before asking for change, and the room becomes calmer.\n\n".repeat(180)}

THE DALE CARNEGIE COURSES
Back matter that should not drive picture-book planning.
`);
const coarseEpubChapters = splitIntoChapters(coarseEpubLikeText, {
  chapterMap: {
    method: "epub-section",
    chapters: [
      { title: "How To Win Friends and Influence People", startLine: 1, endLine: 100 },
      { title: "How To Win Friends and Influence People", startLine: 101, endLine: 999 },
    ],
  },
});
assert.equal(coarseEpubChapters.length, 2);
assert.equal(coarseEpubChapters[0].title, "Chapter 1: THE FIRST CLEAR LESSON");
assert.equal(coarseEpubChapters[1].title, "Chapter 2: THE SECOND CLEAR LESSON");

const aliceLikeCharacters = deriveCharacters(`
Alice followed the White Rabbit and met the White Rabbit again.
The Hatter laughed with the March Hare while the Cheshire Cat smiled.
The Queen shouted orders, and the Caterpillar watched Alice wonder.
The Hatter, March Hare, Cheshire Cat, Queen, and Caterpillar all returned later.
`);
const aliceLikeNames = aliceLikeCharacters.map((character) => character.name);
assert.ok(aliceLikeNames.includes("Alice"));
assert.ok(aliceLikeNames.includes("White Rabbit"));
assert.ok(aliceLikeNames.includes("Hatter"));
assert.ok(aliceLikeNames.includes("Cheshire Cat"));
assert.ok(aliceLikeCharacters.every((character) => Array.isArray(character.aliases)));
const nonfictionReview = deriveCharacterReview(`
How To Win Friends and Influence People
Dale Carnegie wrote about New York, New York, and New York.
Let people talk. Let people talk. For people, For people, For people.
Abraham Lincoln said one kind word to Carnegie. Dale Carnegie quoted Lincoln again.
`, { title: "How To Win Friends and Influence People" });
const nonfictionNames = nonfictionReview.characters.map((character) => character.name);
assert.equal(nonfictionNames.includes("New"), false);
assert.equal(nonfictionNames.includes("York"), false);
assert.equal(nonfictionNames.includes("For"), false);
assert.equal(nonfictionNames.includes("Let"), false);
assert.equal(nonfictionNames.includes("Carnegie"), false);
assert.ok(nonfictionReview.rejectedCount >= 2);
assert.deepEqual(referencedCharacters("Alice was beginning to think.", [{ id: "king", name: "King", aliases: ["King"] }]), []);
assert.deepEqual(referencedCharacters("The King arrived.", [{ id: "king", name: "King", aliases: ["King"] }]), ["king"]);

const garbledCjkPdfText = normalizeText(`
— = a \\itt ey a se \\\\n hes TN \\\\y 2 " z r\\\\ 7 & Ty % ck
BUR FE TH BE HBA HB EK SE BT SKIT ARAB ZX BK RI SEA ERE HG AN ESI ZE
The Q@uwick&Easy Way to Effective Speaking HY SEO ULI STARE URI MT AO TT
`);
assert.equal(analyzeTextQuality(garbledCjkPdfText, { expectedLanguage: "ch" }).garbledLikely, true);
assert.equal(analyzeTextQuality("The quick and easy way to effective speaking is a clear lesson for readers.", { expectedLanguage: "en" }).garbledLikely, false);

const codexJobs = await prepareCodexImageJobs(outDir);
assert.equal(codexJobs.jobs.length, 9);
assert.equal(codexJobs.queue.length, 12);
assert.equal(codexJobs.summary.readyImageCount, 0);
assert.equal(codexJobs.summary.pendingImageCount, 9);
await stat(path.join(outDir, "assets", "codex-image-jobs", "queue.json"));
const nextQueuePrompt = await getNextCodexQueuePromptFromProject(outDir);
assert.equal(nextQueuePrompt.prompt.type, "character");
assert.match(nextQueuePrompt.prompt.prompt, /character reference sheet/);
const originalOpenAiKey = process.env.OPENAI_API_KEY;
delete process.env.OPENAI_API_KEY;
await assert.rejects(
  () => generateOpenAIImagesForProject(outDir, { limit: 1 }),
  /OPENAI_API_KEY is required/,
);
if (originalOpenAiKey !== undefined) process.env.OPENAI_API_KEY = originalOpenAiKey;

const prompt = await readFile(path.join(outDir, "assets", "codex-image-jobs", "ch-01-sp-01.md"), "utf8");
assert.match(prompt, /Use case: illustration-story/);
assert.match(prompt, /Save\/import target in BookFrames/);

const fixturePng = path.join(outDir, "tmp-generated.png");
await writeFile(
  fixturePng,
  makeMinimalPngHeader(1536, 1024),
);
const imported = await importCodexImageToProject(outDir, {
  spreadId: "ch-01-sp-01",
  imagePath: fixturePng,
});
assert.equal(imported.image.assetPath, "assets/images/ch-01-sp-01.png");
assert.equal(imported.summary.readyImageCount, 1);
assert.equal(imported.image.qa.status, "basic_passed");
await stat(path.join(outDir, "assets", "images", "ch-01-sp-01.png"));

const exported = await exportBookProject(outDir);
await stat(path.join(outDir, exported.project.exports.printHtml));
await stat(path.join(outDir, exported.project.exports.reviewPdf));
await stat(path.join(outDir, exported.project.exports.epub));
assert.equal(exported.project.exports.hyperframesHtml, undefined);

const pdfFixture = path.join(root, "tests", "tmp", "fixture-book.pdf");
await writeFile(pdfFixture, makeSimplePdf([
  "Chapter 1: PDF Rain",
  "Mira folded a paper boat beside the window.",
  "The rain made bright ladders on the glass.",
  "Chapter 2: PDF Moon",
  "At night the boat waited under a small lamp.",
  "Mira promised it one more voyage.",
]));
const pdfResult = await createBookProject({
  sourcePath: pdfFixture,
  outDir: pdfOutDir,
  title: "PDF Adventure",
  audienceAge: "6-9",
  stylePreset: "warm-watercolor",
  spreadsPerChapter: 1,
  ingestOptions: {
    ocrMode: "never",
    ingestCacheDir: pdfCacheDir,
  },
});
assert.equal(pdfResult.lint.valid, true);
assert.equal(pdfResult.summary.sourceFormat, "pdf");
assert.equal(pdfResult.summary.extractionMethod, "pypdf");
assert.equal(pdfResult.summary.ocrStatus, "not_used");
assert.equal(pdfResult.summary.chapterCount, 2);
await stat(path.join(pdfOutDir, "source", "extracted.txt"));
const ingestReport = JSON.parse(await readFile(path.join(pdfOutDir, "source", "ingest-report.json"), "utf8"));
assert.equal(ingestReport.source.format, "pdf");
assert.match(ingestReport.source.extractionMethod, /pypdf/);
assert.equal(ingestReport.source.pageAudit.pageCount, 1);
assert.equal(ingestReport.source.importQuality.level, "medium");
assert.equal(ingestReport.source.cache.status, "miss");
await stat(path.join(pdfOutDir, "source", "page-audit.json"));
await stat(path.join(pdfOutDir, "source", "import-quality.json"));
await stat(path.join(pdfOutDir, "source", "chapter-map.json"));

const cachedPdfResult = await createBookProject({
  sourcePath: pdfFixture,
  outDir: pdfCachedOutDir,
  title: "PDF Adventure Cached",
  audienceAge: "6-9",
  stylePreset: "warm-watercolor",
  spreadsPerChapter: 1,
  ingestOptions: {
    ocrMode: "never",
    ingestCacheDir: pdfCacheDir,
  },
});
assert.equal(cachedPdfResult.lint.valid, true);
assert.equal(cachedPdfResult.summary.extractionMethod, "pypdf");
const cachedIngestReport = JSON.parse(await readFile(path.join(pdfCachedOutDir, "source", "ingest-report.json"), "utf8"));
assert.equal(cachedIngestReport.source.cache.status, "hit");
assert.equal(cachedIngestReport.stats.cacheStatus, "hit");

console.log("smoke: ok");

function makeMinimalPngHeader(width, height) {
  const buffer = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 2;
  return buffer;
}

function makeSimplePdf(lines) {
  const escapedLines = lines.map((line) => `(${escapePdfString(line)}) Tj`);
  const content = [
    "BT /F1 18 Tf 72 720 Td",
    escapedLines[0],
    ...escapedLines.slice(1).flatMap((line) => ["0 -32 Td", line]),
    "ET",
  ].join(" ");
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream\nendobj\n`,
  ].map((part) => Buffer.from(part, "latin1"));
  const header = Buffer.from("%PDF-1.4\n", "latin1");
  const offsets = [];
  let position = header.length;
  const body = Buffer.concat(objects.map((object) => {
    offsets.push(position);
    position += object.length;
    return object;
  }));
  const xrefPosition = position;
  const xref = Buffer.from([
    "xref",
    "0 6",
    "0000000000 65535 f ",
    ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    "trailer",
    "<< /Size 6 /Root 1 0 R >>",
    "startxref",
    String(xrefPosition),
    "%%EOF",
    "",
  ].join("\n"), "latin1");
  return Buffer.concat([header, body, xref]);
}

function escapePdfString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
