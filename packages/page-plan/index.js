const AUTO_SPREAD_VALUES = new Set([
  "auto",
  "codex",
  "codex-auto",
  "codex-local",
  "local-codex",
  "本地codex",
  "自动",
]);

const FULL_COVERAGE_SPREAD_VALUES = new Set([
  "full",
  "complete",
  "full-coverage",
  "complete-coverage",
  "full-book",
  "complete-book",
  "完整",
  "完整绘本",
  "尽可能完整",
]);

export function isAutoSpreadsValue(value) {
  if (value && typeof value === "object") {
    return isAutoSpreadsValue(value.mode || value.provider || value.value);
  }
  const raw = String(value ?? "").trim().toLowerCase();
  return AUTO_SPREAD_VALUES.has(raw);
}

export function isFullCoverageSpreadsValue(value) {
  if (value && typeof value === "object") {
    return isFullCoverageSpreadsValue(value.mode || value.provider || value.value);
  }
  const raw = String(value ?? "").trim().toLowerCase();
  return FULL_COVERAGE_SPREAD_VALUES.has(raw);
}

export function parseSpreadCount(value, fallback = 3, { min = 1, max = 8 } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return clampInteger(fallback, min, max);
  return clampInteger(Math.round(numeric), min, max);
}

export function buildFixedPagePlan(ingest, spreadCount = 3, options = {}) {
  const count = parseSpreadCount(spreadCount, 3, options);
  return finishPagePlan({
    mode: "fixed",
    provider: "manual",
    minSpreads: options.min || 1,
    maxSpreads: options.max || 8,
    reason: `Manual fixed setting: ${count} pages per chapter.`,
    chapters: chapterInputs(ingest).map((chapter) => ({
      ...chapter,
      spreadCount: count,
      reason: `Manual setting uses ${count} pages for this chapter.`,
    })),
  });
}

export function buildHeuristicPagePlan(ingest, options = {}) {
  const min = options.min || 1;
  const max = options.max || 8;
  const chapters = chapterInputs(ingest).map((chapter) => {
    const spreadCount = heuristicSpreadCount(chapter.charCount, chapter.paragraphCount, {
      min,
      max,
      targetCharsPerSpread: options.targetCharsPerSpread,
    });
    return {
      ...chapter,
      spreadCount,
      reason: heuristicReason(chapter.charCount, chapter.paragraphCount, spreadCount, {
        targetCharsPerSpread: options.targetCharsPerSpread,
      }),
    };
  });
  return finishPagePlan({
    mode: options.mode || "heuristic",
    provider: options.provider || "heuristic",
    minSpreads: min,
    maxSpreads: max,
    reason: options.reason || "Local heuristic page plan based on chapter length and paragraph density.",
    fallbackReason: options.fallbackReason || null,
    warnings: options.warnings || [],
    chapters,
  });
}

export function buildFullCoveragePagePlan(ingest, options = {}) {
  const targetCharsPerSpread = options.targetCharsPerSpread || 1800;
  return buildHeuristicPagePlan(ingest, {
    mode: "full-coverage",
    provider: "heuristic-complete",
    min: options.min || 2,
    max: options.max || 60,
    targetCharsPerSpread,
    reason: options.reason || `Full-coverage plan: preserve chapter order and cover the source text at roughly ${targetCharsPerSpread} characters per picture-book page.`,
    warnings: options.warnings || [],
  });
}

export function normalizePagePlan(plan, ingest, options = {}) {
  if (!plan || typeof plan !== "object") {
    throw new Error("Page plan must be a JSON object.");
  }
  const min = options.min || Number(plan.minSpreads) || 1;
  const max = options.max || Number(plan.maxSpreads) || 8;
  const inputChapters = Array.isArray(plan) ? plan : Array.isArray(plan.chapters) ? plan.chapters : [];
  if (!inputChapters.length) {
    throw new Error("Page plan JSON must include a chapters array.");
  }
  const byIndex = new Map();
  const byId = new Map();
  for (const item of inputChapters) {
    const index = Number(item.chapterIndex);
    if (Number.isInteger(index)) byIndex.set(index, item);
    if (item.chapterId || item.id) byId.set(String(item.chapterId || item.id), item);
  }

  const normalizedChapters = chapterInputs(ingest).map((chapter, index) => {
    const source = byIndex.get(index) || byId.get(chapter.chapterId) || inputChapters[index] || {};
    const spreadCount = parseSpreadCount(source.spreadCount ?? source.pages ?? source.pageCount, 3, { min, max });
    return {
      ...chapter,
      spreadCount,
      reason: String(source.reason || source.rationale || source.note || `Planned ${spreadCount} pages.`).trim(),
    };
  });

  return finishPagePlan({
    mode: String(options.mode || plan.mode || "codex-auto"),
    provider: String(options.provider || plan.provider || "local-codex"),
    minSpreads: min,
    maxSpreads: max,
    reason: String(plan.reason || options.reason || "Local Codex planned chapter page counts.").trim(),
    fallbackReason: plan.fallbackReason || options.fallbackReason || null,
    warnings: Array.isArray(plan.warnings) ? plan.warnings.map(String) : options.warnings || [],
    chapters: normalizedChapters,
  });
}

export function pagePlanChapterSketches(ingest) {
  return chapterInputs(ingest).map((chapter) => ({
    chapterIndex: chapter.chapterIndex,
    chapterId: chapter.chapterId,
    title: chapter.title,
    charCount: chapter.charCount,
    paragraphCount: chapter.paragraphCount,
    opening: trimForPrompt(chapter.text, 300),
    closing: trimForPrompt(chapter.text.slice(Math.max(0, chapter.text.length - 420)), 260),
  }));
}

export function buildLocalCodexPagePlanPrompt({
  ingest,
  title = "Untitled",
  outputPath,
  minSpreads = 1,
  maxSpreads = 8,
}) {
  const sketches = pagePlanChapterSketches(ingest);
  return [
    "# BookFrames chapter page planning",
    "",
    "你是本地 Codex，正在为 BookFrames 绘本导入流程规划每一章要拆成多少页。",
    `书名：${title || "Untitled"}`,
    `输出文件：${outputPath}`,
    "",
    "请创建或覆盖这个输出文件，只写合法 JSON，不要写 Markdown、解释文字或注释。",
    "",
    "JSON schema:",
    "```json",
    JSON.stringify({
      mode: "codex-auto",
      provider: "local-codex",
      reason: "one sentence overall planning logic",
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
    "- 短章、过渡章可以 1-2 页；动作密集或场景变化多的章节 3-5 页；非常长且视觉节拍丰富的章节 6-8 页。",
    "- 不要平均分配；每章根据文本长度、场景变化、角色行动和适合儿童绘本的节奏独立判断。",
    "- 保持章节顺序和 chapterIndex，不要新增或删除章节。",
    "- reason 用简短中文说明，方便前端审稿。",
    "",
    "章节摘要：",
    "```json",
    JSON.stringify(sketches, null, 2),
    "```",
  ].join("\n");
}

export function plannedSpreadCount(pagePlan, chapterIndex, fallback = 3) {
  const chapterPlan = pagePlan?.chapters?.[chapterIndex];
  return parseSpreadCount(chapterPlan?.spreadCount, fallback, {
    min: pagePlan?.minSpreads || 1,
    max: pagePlan?.maxSpreads || 8,
  });
}

function finishPagePlan(plan) {
  const chapters = (plan.chapters || []).map((chapter, index) => ({
    chapterIndex: Number.isInteger(Number(chapter.chapterIndex)) ? Number(chapter.chapterIndex) : index,
    chapterId: chapter.chapterId || chapter.id || `ch-${String(index + 1).padStart(2, "0")}`,
    title: chapter.title || `Chapter ${index + 1}`,
    charCount: Number(chapter.charCount || 0),
    paragraphCount: Number(chapter.paragraphCount || 0),
    spreadCount: parseSpreadCount(chapter.spreadCount, 3, {
      min: plan.minSpreads || 1,
      max: plan.maxSpreads || 8,
    }),
    reason: String(chapter.reason || "").trim(),
  }));
  const totalSpreadCount = chapters.reduce((sum, chapter) => sum + chapter.spreadCount, 0);
  return {
    mode: plan.mode || "heuristic",
    provider: plan.provider || "heuristic",
    minSpreads: plan.minSpreads || 1,
    maxSpreads: plan.maxSpreads || 8,
    totalSpreadCount,
    averageSpreadsPerChapter: chapters.length ? Number((totalSpreadCount / chapters.length).toFixed(2)) : 0,
    reason: plan.reason || "",
    fallbackReason: plan.fallbackReason || null,
    warnings: plan.warnings || [],
    chapters,
    createdAt: new Date().toISOString(),
  };
}

function chapterInputs(ingest) {
  return (ingest.chapters || []).map((chapter, index) => {
    const text = String(chapter.text || "");
    return {
      chapterIndex: index,
      chapterId: chapter.id || `ch-${String(index + 1).padStart(2, "0")}`,
      title: chapter.title || `Chapter ${index + 1}`,
      charCount: Number(chapter.stats?.charCount || text.length || 0),
      paragraphCount: Number(chapter.stats?.paragraphCount || text.split(/\n{2,}/).filter(Boolean).length || 0),
      text,
    };
  });
}

function heuristicSpreadCount(charCount, paragraphCount, { min = 1, max = 8, targetCharsPerSpread } = {}) {
  if (targetCharsPerSpread) {
    const byLength = Math.ceil(Math.max(0, charCount) / Math.max(400, Number(targetCharsPerSpread)));
    const byParagraphs = paragraphCount >= 18 ? Math.ceil(paragraphCount / 42) : 0;
    return clampInteger(Math.max(byLength, byParagraphs, min), min, max);
  }
  let count = 1;
  if (charCount >= 700) count = 2;
  if (charCount >= 1600) count = 3;
  if (charCount >= 3200) count = 4;
  if (charCount >= 5200) count = 5;
  if (charCount >= 7600) count = 6;
  if (charCount >= 10500) count = 7;
  if (charCount >= 13500) count = 8;
  if (paragraphCount >= 24 && charCount >= 2600) count += 1;
  if (paragraphCount >= 42 && charCount >= 5200) count += 1;
  return clampInteger(count, min, max);
}

function heuristicReason(charCount, paragraphCount, spreadCount, { targetCharsPerSpread } = {}) {
  if (targetCharsPerSpread) {
    return `完整覆盖模式按约 ${targetCharsPerSpread} 字/页规划；本章 ${charCount} chars, ${paragraphCount} paragraphs，拆为 ${spreadCount} 页。`;
  }
  if (spreadCount <= 1) return "短章或过渡章，1 页足够保留主要画面。";
  if (spreadCount >= 6) return `章节较长且段落较多（${charCount} chars, ${paragraphCount} paragraphs），需要 ${spreadCount} 页承接节奏。`;
  return `按文本长度和场景密度规划为 ${spreadCount} 页。`;
}

function clampInteger(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(Number(value) || min)));
}

function trimForPrompt(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trim()}…`;
}
