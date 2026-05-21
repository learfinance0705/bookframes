export const BOOKFRAMES_SCHEMA_VERSION = "0.1.0";

export function normalizeId(input, fallback = "item") {
  const value = String(input || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return value || fallback;
}

export function createProjectManifest({
  title,
  sourceFile,
  language = "auto",
  languageProfile,
  audienceAge = "6-9",
  styleBible,
  characters,
  chapters,
  originalStats,
  sourceDetails,
  pagePlan,
}) {
  return {
    schemaVersion: BOOKFRAMES_SCHEMA_VERSION,
    generator: {
      name: "BookFrames",
      version: "0.1.0",
      philosophy: "structured, inspectable, regenerable picture-book projects",
    },
    createdAt: new Date().toISOString(),
    book: {
      title,
      sourceFile,
      language,
      languageProfile: languageProfile || {
        mode: language === "auto" ? "auto" : "single",
        primary: language,
        secondary: null,
        bilingual: false,
        label: language,
      },
      audienceAge,
      originalStats,
      source: sourceDetails || null,
      pagePlan: pagePlan || null,
    },
    styleBible,
    characters,
    chapters,
    assets: {
      images: [],
    },
    exports: {},
  };
}

export function lintBookProject(project) {
  const errors = [];
  const warnings = [];
  const ids = new Set();

  if (!project || typeof project !== "object") {
    return { valid: false, errors: ["Manifest is not an object"], warnings };
  }

  if (project.schemaVersion !== BOOKFRAMES_SCHEMA_VERSION) {
    warnings.push(`Unexpected schemaVersion: ${project.schemaVersion || "missing"}`);
  }

  if (!project.book?.title) errors.push("book.title is required");
  if (!project.book?.sourceFile) warnings.push("book.sourceFile is missing");
  if (!project.styleBible?.artDirection) warnings.push("styleBible.artDirection is missing");
  if (project.book?.source?.importQuality?.stopBeforeDrawing) {
    warnings.push(`source.importQuality is ${project.book.source.importQuality.level}; review import before drawing`);
  }
  if (project.planningReview?.status === "blocked") {
    errors.push("planningReview.status is blocked");
  } else if (project.planningReview?.status === "review") {
    warnings.push("planningReview.status is review; inspect planning/planning-review.json");
  }
  if (project.characterReview?.status === "fallback") {
    warnings.push("characterReview.status is fallback; inspect planning/character-review.json");
  } else if (project.characterReview?.status === "review" || project.characterReview?.reviewCount > 0) {
    warnings.push("characterReview has candidates to inspect in planning/character-review.json");
  }
  if (!Array.isArray(project.characters)) warnings.push("characters should be an array");
  for (const [characterIndex, character] of (project.characters || []).entries()) {
    const characterPath = `characters[${characterIndex}]`;
    checkId(character.id, characterPath);
    if (!character.name) warnings.push(`${characterPath}.name is missing`);
    if (!Array.isArray(character.visualAnchors) || character.visualAnchors.length === 0) {
      warnings.push(`${characterPath}.visualAnchors is empty; character continuity is weak`);
    }
    if (!character.reference?.promptPath) {
      warnings.push(`${characterPath}.reference.promptPath is missing`);
    }
  }
  if (!Array.isArray(project.chapters) || project.chapters.length === 0) {
    errors.push("chapters must contain at least one chapter");
  }

  for (const [chapterIndex, chapter] of (project.chapters || []).entries()) {
    const chapterPath = `chapters[${chapterIndex}]`;
    checkId(chapter.id, chapterPath);
    if (!chapter.title) warnings.push(`${chapterPath}.title is missing`);
    if (!Array.isArray(chapter.sourceAnchors) || chapter.sourceAnchors.length === 0) {
      warnings.push(`${chapterPath}.sourceAnchors is empty; chapter traceability is weak`);
    }
    if (!chapter.summary) warnings.push(`${chapterPath}.summary is missing`);
    if (!Array.isArray(chapter.spreads) || chapter.spreads.length === 0) {
      errors.push(`${chapterPath}.spreads must contain at least one spread`);
      continue;
    }

    for (const [spreadIndex, spread] of chapter.spreads.entries()) {
      const spreadPath = `${chapterPath}.spreads[${spreadIndex}]`;
      checkId(spread.id, spreadPath);
      if (!spread.caption) warnings.push(`${spreadPath}.caption is missing`);
      if (!spread.readerCaption) warnings.push(`${spreadPath}.readerCaption is missing`);
      if (!spread.sourceExcerpt) warnings.push(`${spreadPath}.sourceExcerpt is missing`);
      if (spread.caption && spread.caption.length > 180) {
        warnings.push(`${spreadPath}.caption is long for a picture-book page`);
      }
      if (!spread.scenePrompt) errors.push(`${spreadPath}.scenePrompt is required`);
      if (!spread.layout) warnings.push(`${spreadPath}.layout is missing`);
      if (!spread.image?.assetPath) warnings.push(`${spreadPath}.image.assetPath is missing`);
      if (spread.image?.status === "ready" && !spread.image?.qa) {
        warnings.push(`${spreadPath}.image.qa is missing for a ready image`);
      }
      if (!Array.isArray(spread.sourceAnchors) || spread.sourceAnchors.length === 0) {
        warnings.push(`${spreadPath}.sourceAnchors is empty`);
      }
    }
  }

  function checkId(id, path) {
    if (!id) {
      errors.push(`${path}.id is required`);
      return;
    }
    if (ids.has(id)) errors.push(`Duplicate id: ${id}`);
    ids.add(id);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function summarizeProject(project) {
  const chapterCount = project.chapters?.length || 0;
  const spreadCount = (project.chapters || []).reduce((sum, chapter) => {
    return sum + (chapter.spreads?.length || 0);
  }, 0);
  const imageCount = (project.chapters || []).reduce((sum, chapter) => {
    return sum + (chapter.spreads || []).filter((spread) => spread.image?.assetPath).length;
  }, 0);
  const readyImageCount = (project.chapters || []).reduce((sum, chapter) => {
    return sum + (chapter.spreads || []).filter((spread) => spread.image?.status === "ready").length;
  }, 0);
  const qaPassedCount = (project.chapters || []).reduce((sum, chapter) => {
    return sum + (chapter.spreads || []).filter((spread) => spread.image?.qa?.status === "basic_passed").length;
  }, 0);
  const needsRedrawCount = (project.chapters || []).reduce((sum, chapter) => {
    return sum + (chapter.spreads || []).filter((spread) => spread.image?.status === "needs_redraw").length;
  }, 0);
  const characterReferenceCount = project.characters?.length || 0;
  const readyCharacterReferenceCount = (project.characters || []).filter((character) => {
    return character.reference?.status === "ready";
  }).length;
  const source = project.book?.source || {};
  const originalStats = project.book?.originalStats || {};
  const queue = project.assets?.codexImageQueue || {};
  const pagePlan = project.book?.pagePlan || {};
  const characterReview = project.characterReview || {};

  return {
    title: project.book?.title || "Untitled",
    sourceFormat: source.format || originalStats.sourceFormat || null,
    extractionMethod: source.extractionMethod || originalStats.extractionMethod || null,
    extractionStatus: source.status || originalStats.extractionStatus || null,
    pageCount: source.pageCount || originalStats.pageCount || null,
    ocrStatus: source.ocr?.status || originalStats.ocrStatus || null,
    importQualityScore: source.importQuality?.score || originalStats.importQualityScore || null,
    importQualityLevel: source.importQuality?.level || originalStats.importQualityLevel || null,
    chapterSplitMethod: source.chapterMap?.method || originalStats.chapterSplitMethod || null,
    pagePlanMode: pagePlan.mode || null,
    pagePlanProvider: pagePlan.provider || null,
    pagePlanTotalSpreadCount: pagePlan.totalSpreadCount || null,
    pagePlanAverageSpreadsPerChapter: pagePlan.averageSpreadsPerChapter || null,
    planningStatus: project.planningReview?.status || null,
    characterReviewStatus: characterReview.status || null,
    characterReviewApprovedCount: characterReview.approvedCount || null,
    characterReviewRejectedCount: characterReview.rejectedCount || 0,
    characterReviewPendingCount: characterReview.reviewCount || 0,
    codexQueuePendingCount: queue.pendingCount || 0,
    codexQueuePath: queue.queuePath || null,
    chapterCount,
    spreadCount,
    imageCount,
    readyImageCount,
    pendingImageCount: Math.max(0, spreadCount - readyImageCount),
    qaPassedCount,
    needsRedrawCount,
    characterReferenceCount,
    readyCharacterReferenceCount,
    style: project.styleBible?.name || "custom",
    exportedHtml: project.exports?.html || null,
    readerHtml: project.exports?.readerHtml || null,
    studioHtml: project.exports?.studioHtml || null,
    printHtml: project.exports?.printHtml || null,
    reviewPdf: project.exports?.reviewPdf || null,
    epub: project.exports?.epub || null,
  };
}
