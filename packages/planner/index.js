import path from "node:path";
import { createProjectManifest, normalizeId } from "../core/schema.js";
import { plannedSpreadCount, parseSpreadCount } from "../page-plan/index.js";

export function planPictureBook({
  ingest,
  title,
  audienceAge = "6-9",
  stylePreset = "warm-watercolor",
  spreadsPerChapter = 3,
  languageProfile = "auto",
  pagePlan,
}) {
  const sourceText = ingest.text;
  const styleBible = createStyleBible(stylePreset);
  const projectTitle = title || titleFromPath(ingest.sourcePath);
  const rawCharacterReview = deriveCharacterReview(sourceText, { title: projectTitle });
  const characterReview = shouldUseEpisodicSceneCasting(sourceText, projectTitle)
    ? disableCharacterReferences(rawCharacterReview, "Likely nonfiction or advice text; use page-specific people and scenes instead of a recurring cast.")
    : rawCharacterReview;
  const characters = characterReview.characters;
  const sourceLanguage = detectLanguage(sourceText);
  const outputLanguage = normalizeLanguageProfile(languageProfile, sourceLanguage);

  let pageNumberBase = 0;
  const chapters = ingest.chapters.map((chapter, index) => {
    const chapterId = chapter.id || `ch-${String(index + 1).padStart(2, "0")}`;
    const summary = summarizeText(chapter.text, 260);
    const chapterPagePlan = pagePlan?.chapters?.[index] || null;
    const chapterSpreadCount = plannedSpreadCount(pagePlan, index, parseSpreadCount(spreadsPerChapter || 3));
    const spreads = createSpreads({
      chapter,
      chapterId,
      chapterIndex: index,
      spreadsPerChapter: chapterSpreadCount,
      pageNumberBase,
      styleBible,
      characters,
      sourceLanguage,
      languageProfile: outputLanguage,
    });
    pageNumberBase += spreads.length;

    return {
      id: chapterId,
      title: chapter.title,
      summary,
      sourceAnchors: chapter.sourceAnchors,
      sourceTextStats: chapter.stats,
      pagePlan: chapterPagePlan ? {
        spreadCount: chapterSpreadCount,
        reason: chapterPagePlan.reason || "",
        provider: pagePlan?.provider || "",
      } : null,
      spreads,
    };
  });

  const project = createProjectManifest({
    title: projectTitle,
    sourceFile: path.relative(process.cwd(), ingest.sourcePath),
    language: outputLanguage.primary || sourceLanguage,
    languageProfile: outputLanguage,
    audienceAge,
    styleBible,
    characters,
    chapters,
    originalStats: ingest.stats,
    sourceDetails: ingest.source,
    pagePlan,
  });
  project.characterReview = characterReview;
  project.storyArc = buildStoryArc(project);
  project.planningReview = reviewPictureBookPlan(project);
  return project;
}

export function createStyleBible(stylePreset) {
  const presets = {
    "warm-watercolor": {
      name: "warm-watercolor",
      artDirection: "gentle watercolor picture book, soft pencil linework, warm daylight, tactile paper grain",
      palette: ["#f7ead7", "#31515f", "#d9634f", "#e0a83f", "#6aa99b"],
      camera: "storybook eye-level composition with clear silhouettes",
      continuityRules: [
        "Keep recurring characters visually consistent across pages.",
        "Use child-safe expressions and readable body language.",
        "Leave calm negative space for captions.",
      ],
      negativePrompt: "photorealistic, harsh horror, crowded tiny details, distorted hands, illegible text in image",
    },
    "ink-collage": {
      name: "ink-collage",
      artDirection: "ink and paper collage picture book, bold cut-paper shapes, expressive texture, crisp silhouettes",
      palette: ["#fff7e8", "#202225", "#1f8a70", "#f25f5c", "#f2c94c"],
      camera: "flat theatrical stage composition with playful depth layers",
      continuityRules: [
        "Repeat signature colors for each recurring character.",
        "Keep props simple enough for young readers to identify.",
        "Prefer one clear action per page.",
      ],
      negativePrompt: "3d render, glossy plastic, busy background, scary violence, unreadable typography",
    },
  };

  return presets[stylePreset] || presets["warm-watercolor"];
}

function createSpreads({ chapter, chapterId, spreadsPerChapter, pageNumberBase, styleBible, characters, sourceLanguage, languageProfile }) {
  const segments = splitForSpreads(chapter.text, spreadsPerChapter);
  return segments.map((segment, index) => {
    const spreadNumber = index + 1;
    const spreadId = `${chapterId}-sp-${String(spreadNumber).padStart(2, "0")}`;
    const sourceExcerpt = makeSourceExcerpt(segment, spreadNumber);
    const sourcePassage = makeSourcePassage(segment);
    const readerCaption = makeReaderCaption(segment, spreadNumber);
    const characterRefs = referencedCharacters(segment, characters);
    const characterNames = characterRefs
      .map((id) => characters.find((character) => character.id === id)?.name)
      .filter(Boolean);
    const prompt = [
      styleBible.artDirection,
      `Scene: ${summarizeText(segment, 420)}`,
      `Characters: ${characterNames.length ? characterNames.join(", ") : "people named or implied by the scene summary only; no unrelated recurring cast"}`,
      `Composition: ${styleBible.camera}; one emotionally clear action; no visible text.`,
      `Continuity: ${styleBible.continuityRules.join(" ")}`,
      `Avoid: ${styleBible.negativePrompt}.`,
    ].join("\n");

    return {
      id: spreadId,
      chapterId,
      pageNumber: pageNumberBase + spreadNumber,
      visualIntent: classifyVisualIntent(segment, index, segments.length),
      caption: readerCaption,
      readerCaption,
      captionI18n: buildCaptionI18n(readerCaption, {
        sourceLanguage,
        languageProfile,
      }),
      sourceExcerpt,
      sourcePassage,
      scenePrompt: prompt,
      characterRefs,
      sourceAnchors: [`${chapter.sourceAnchors?.[0] || "text:line:1"}:spread:${spreadNumber}`],
      sourceTextStats: {
        charCount: segment.length,
        paragraphCount: segment.split(/\n{2,}/).filter(Boolean).length,
      },
      layout: index % 2 === 0 ? "full-bleed-caption-bottom" : "image-left-caption-right",
      image: {
        status: "pending",
      },
    };
  });
}

function shouldUseEpisodicSceneCasting(text, title = "") {
  const titleText = String(title || "").toLowerCase();
  if (/\b(how to|win friends|influence people|effective speaking|self[-\s]?help|principles?)\b/.test(titleText)) {
    return true;
  }
  const source = String(text || "").toLowerCase();
  if (source.length < 50000) return false;
  const signals = [
    /\bprinciple\s+\d+\b/g,
    /\bsummary\b/g,
    /\bhow to\b/g,
    /\bpeople\b/g,
    /\bbusiness\b/g,
    /\bcourse\b/g,
    /\bsuccess\b/g,
    /\bchapter\b/g,
  ];
  const signalScore = signals.reduce((sum, pattern) => sum + Math.min(4, (source.match(pattern) || []).length), 0);
  return signalScore >= 12 && /\bprinciple\b/.test(source);
}

function disableCharacterReferences(review, reason) {
  const candidates = (review.candidates || []).map((candidate) => ({
    ...candidate,
    status: candidate.status === "approved" ? "rejected" : candidate.status,
    reason: candidate.status === "approved" ? reason : candidate.reason,
  }));
  return {
    ...review,
    status: "not_used",
    approvedCount: 0,
    rejectedCount: Number(review.rejectedCount || 0) + Number(review.approvedCount || 0) + Number(review.reviewCount || 0),
    reviewCount: 0,
    candidates,
    warnings: [...(review.warnings || []), reason],
    characters: [],
    updatedAt: new Date().toISOString(),
  };
}

function buildCaptionI18n(caption, { sourceLanguage, languageProfile }) {
  const profile = languageProfile || normalizeLanguageProfile("auto", sourceLanguage);
  const targets = profile.bilingual
    ? [profile.primary, profile.secondary].filter(Boolean)
    : [profile.primary || sourceLanguage];
  const uniqueTargets = [...new Set(targets)];
  const lines = uniqueTargets.map((language) => ({
    language,
    label: languageName(language),
    text: language === sourceLanguage ? caption : "",
    source: language === sourceLanguage ? "source" : "pending_translation",
    needsTranslation: language !== sourceLanguage,
  }));
  return {
    mode: profile.mode,
    primary: profile.primary,
    secondary: profile.secondary || null,
    bilingual: profile.bilingual,
    sourceLanguage,
    lines,
  };
}

export function normalizeLanguageProfile(value, sourceLanguage = "en") {
  if (value && typeof value === "object") {
    const primary = normalizeLanguageCode(value.primary || value.language || sourceLanguage);
    const secondary = normalizeLanguageCode(value.secondary || "");
    return {
      mode: secondary ? "bilingual" : primary === "auto" ? "auto" : "single",
      primary: primary === "auto" ? sourceLanguage : primary,
      secondary: secondary || null,
      bilingual: Boolean(secondary),
      label: secondary ? `${languageName(primary)} + ${languageName(secondary)}` : languageName(primary),
    };
  }
  const raw = String(value || "auto").trim().toLowerCase();
  if (!raw || raw === "auto") {
    return {
      mode: "auto",
      primary: sourceLanguage,
      secondary: null,
      bilingual: false,
      label: `Auto (${languageName(sourceLanguage)})`,
    };
  }
  const parts = raw.split(/[-+,/]/).map(normalizeLanguageCode).filter((part) => part && part !== "auto");
  const primary = parts[0] || sourceLanguage;
  const secondary = parts.find((part) => part !== primary) || null;
  return {
    mode: secondary ? "bilingual" : "single",
    primary,
    secondary,
    bilingual: Boolean(secondary),
    label: secondary ? `${languageName(primary)} + ${languageName(secondary)}` : languageName(primary),
  };
}

function normalizeLanguageCode(value) {
  const code = String(value || "").trim().toLowerCase();
  if (["ch", "cn", "zh-cn", "zh-hans", "chinese", "中文"].includes(code)) return "zh";
  if (["jp", "ja-jp", "japanese", "日本語", "日文"].includes(code)) return "ja";
  if (["en-us", "en-gb", "english", "英文"].includes(code)) return "en";
  if (["zh", "ja", "en", "auto"].includes(code)) return code;
  return "";
}

function languageName(code) {
  return {
    zh: "中文",
    ja: "日本語",
    en: "English",
    auto: "Auto",
  }[code] || code || "Auto";
}

function buildStoryArc(project) {
  const chapters = project.chapters || [];
  const spreads = chapters.flatMap((chapter) => chapter.spreads || []);
  return {
    premise: summarizeText(chapters[0]?.summary || project.book?.title || "", 180),
    opening: summarizeText(spreads[0]?.sourceExcerpt || chapters[0]?.summary || "", 160),
    midpoint: summarizeText(spreads[Math.floor(spreads.length / 2)]?.sourceExcerpt || "", 160),
    closing: summarizeText(spreads[spreads.length - 1]?.sourceExcerpt || chapters[chapters.length - 1]?.summary || "", 160),
    recurringCharacters: (project.characters || []).map((character) => character.id),
    sceneCount: spreads.length,
  };
}

function reviewPictureBookPlan(project) {
  const warnings = [];
  const blockers = [];
  const spreads = (project.chapters || []).flatMap((chapter) => {
    return (chapter.spreads || []).map((spread) => ({ chapter, spread }));
  });
  const captions = new Map();
  const highDensitySpreads = [];
  for (const { chapter, spread } of spreads) {
    const key = normalizeReviewText(spread.readerCaption || spread.caption);
    if (captions.has(key)) {
      warnings.push(`Repeated caption idea: ${spread.id} duplicates ${captions.get(key)}.`);
    } else {
      captions.set(key, spread.id);
    }
    if (!spread.sourceExcerpt) blockers.push(`${spread.id} has no source excerpt.`);
    if ((spread.readerCaption || "").length > 100) warnings.push(`${spread.id} caption is long for a read-aloud page.`);
    if ((spread.sourceTextStats?.charCount || 0) > 3600) highDensitySpreads.push(spread.id);
    if (!(spread.characterRefs || []).length && (project.characters || []).length > 1) {
      warnings.push(`${spread.id} has no recurring character reference; check visual continuity.`);
    }
  }
  if (highDensitySpreads.length) {
    warnings.push(`${highDensitySpreads.length} spreads compress more than 3600 source characters; increase spreads-per-chapter or split dense chapters. Examples: ${highDensitySpreads.slice(0, 4).join(", ")}.`);
  }
  if (project.book?.source?.importQuality?.stopBeforeDrawing) {
    blockers.push("Import quality is low; review source/page-audit.json before drawing.");
  }
  if (!project.storyArc?.closing) warnings.push("Story arc has a weak closing; review final spread.");

  return {
    status: blockers.length ? "blocked" : warnings.length ? "review" : "ready",
    blockers,
    warnings,
    checks: {
      spreadCount: spreads.length,
      duplicateCaptionWarnings: warnings.filter((warning) => warning.startsWith("Repeated caption")).length,
      sourceGroundedSpreads: spreads.filter(({ spread }) => Boolean(spread.sourceExcerpt)).length,
      characterContinuityWarnings: warnings.filter((warning) => warning.includes("visual continuity")).length,
      highDensitySpreadCount: highDensitySpreads.length,
    },
    updatedAt: new Date().toISOString(),
  };
}

function classifyVisualIntent(segment, index, count) {
  const text = String(segment || "").toLowerCase();
  if (index === 0) return "establishing";
  if (index === count - 1) return "resolution";
  if (/\b(ran|jumped|opened|found|fell|climbed|followed|placed|picked|looked|said)\b/.test(text)) {
    return "action";
  }
  if (/\b(afraid|happy|sad|promised|wondered|laughed|smiled|cried|curious)\b/.test(text)) {
    return "emotion";
  }
  return "story-beat";
}

function normalizeReviewText(value) {
  return String(value || "").toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, " ").trim();
}

function splitForSpreads(text, count) {
  const rawParagraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  if (!rawParagraphs.length) return padSegments(rawParagraphs, count);

  const initialTotalChars = rawParagraphs.reduce((sum, paragraph) => sum + paragraph.length, 0);
  const initialTargetChars = Math.max(1, Math.ceil(initialTotalChars / count));
  const paragraphs = rawParagraphs.flatMap((paragraph) => splitLongParagraph(paragraph, initialTargetChars));
  if (paragraphs.length <= count) return padSegments(paragraphs, count);

  const totalChars = paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0);
  const targetChars = Math.max(1, Math.ceil(totalChars / count));
  const groups = [];
  let current = [];
  let currentChars = 0;

  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index];
    const remainingParagraphs = paragraphs.length - index;
    const remainingGroupsAfterCurrent = count - groups.length - 1;
    const mustKeepForLater = remainingParagraphs <= remainingGroupsAfterCurrent;
    const combinedChars = currentChars + paragraph.length;
    const wouldOverfill = current.length > 0 && combinedChars > targetChars;
    const shouldCloseBeforeParagraph = wouldOverfill
      && Math.abs(targetChars - currentChars) <= Math.abs(targetChars - combinedChars);

    if (shouldCloseBeforeParagraph && !mustKeepForLater && groups.length < count - 1) {
      groups.push(current.join("\n\n"));
      current = [];
      currentChars = 0;
    }

    current.push(paragraph);
    currentChars += paragraph.length;
  }
  if (current.length) groups.push(current.join("\n\n"));
  return padSegments(groups.filter(Boolean), count);
}

function splitLongParagraph(paragraph, targetChars) {
  const text = String(paragraph || "").trim();
  if (!text || text.length <= targetChars * 1.15) return [text].filter(Boolean);

  const sentences = text
    .split(/(?<=[.!?。！？][”’"]?)\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  if (sentences.length <= 1) return splitByLength(text, targetChars);

  const chunks = [];
  let current = [];
  let currentChars = 0;
  for (const sentence of sentences) {
    if (current.length && currentChars + sentence.length > targetChars) {
      chunks.push(current.join(" "));
      current = [];
      currentChars = 0;
    }
    if (sentence.length > targetChars * 1.25) {
      if (current.length) {
        chunks.push(current.join(" "));
        current = [];
        currentChars = 0;
      }
      chunks.push(...splitByLength(sentence, targetChars));
      continue;
    }
    current.push(sentence);
    currentChars += sentence.length;
  }
  if (current.length) chunks.push(current.join(" "));
  return chunks.filter(Boolean);
}

function splitByLength(text, targetChars) {
  const chunks = [];
  for (let index = 0; index < text.length; index += targetChars) {
    chunks.push(text.slice(index, index + targetChars).trim());
  }
  return chunks.filter(Boolean);
}

function padSegments(segments, count) {
  const safe = segments.length ? segments : [""];
  while (safe.length < count) safe.push(safe[safe.length - 1]);
  return safe.slice(0, count);
}

function makeSourceExcerpt(text, spreadNumber) {
  const firstSentence = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?。！？])\s+/u)
    .find(Boolean);
  const caption = firstSentence || `A quiet story moment ${spreadNumber}.`;
  return summarizeText(caption, 118);
}

function makeSourcePassage(text) {
  return summarizeText(String(text || "").replace(/\s+/g, " ").trim(), 1200);
}

function makeReaderCaption(text, spreadNumber) {
  const excerpt = makeSourceExcerpt(text, spreadNumber);
  const cleaned = excerpt
    .replace(/\bexplained that\b/gi, "shared")
    .replace(/\bwatched the\b/gi, "watched")
    .replace(/\bwith the confidence of\b/gi, "like")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length <= 86) return cleaned;

  const fragments = cleaned.split(/,\s+|;\s+|\s+and\s+/i).filter(Boolean);
  const compact = fragments.find((fragment) => fragment.length >= 22 && fragment.length <= 86);
  if (compact) return compact;

  return summarizeText(cleaned, 86);
}

function summarizeText(text, limit) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1).trim()}...`;
}

export function deriveCharacters(text, options = {}) {
  return deriveCharacterReview(text, options).characters;
}

export function deriveCharacterReview(text, options = {}) {
  const rawCandidates = collectCharacterCandidates(text, options);
  const decisions = rawCandidates.map((candidate) => ({
    ...candidate,
    ...reviewCharacterCandidate(candidate, text, options),
  }));
  const approved = decisions
    .filter((candidate) => candidate.status === "approved")
    .sort((a, b) => b.reviewScore - a.reviewScore || b.score - a.score || b.count - a.count || a.name.localeCompare(b.name));
  const characters = approved
    .slice(0, 10)
    .map((item, index) => characterFromCandidate(item.name, item, index));
  const rejectedCount = decisions.filter((candidate) => candidate.status === "rejected").length;
  const reviewCount = decisions.filter((candidate) => candidate.status === "review").length;

  if (characters.length > 0) {
    return {
      status: reviewCount ? "review" : "ready",
      provider: "heuristic-character-review",
      approvedCount: characters.length,
      rejectedCount,
      reviewCount,
      candidates: decisions.slice(0, 40).map(characterDecisionForManifest),
      characters,
      updatedAt: new Date().toISOString(),
    };
  }

  const fallback = fallbackCharacter();
  return {
    status: "fallback",
    provider: "heuristic-character-review",
    approvedCount: 1,
    rejectedCount,
    reviewCount,
    candidates: decisions.slice(0, 40).map(characterDecisionForManifest),
    warnings: ["No strong recurring character candidates were found; using a generic protagonist until the character bible is reviewed."],
    characters: [fallback],
    updatedAt: new Date().toISOString(),
  };
}

function collectCharacterCandidates(text, options = {}) {
  const candidates = new Map();
  const phraseCandidates = new Map();
  const canonicalCharacters = [
    { name: "Alice", aliases: ["Alice"], priority: 100 },
    { name: "White Rabbit", aliases: ["White Rabbit", "Rabbit"], priority: 65 },
    { name: "Cheshire Cat", aliases: ["Cheshire Cat", "Cheshire Puss"], priority: 80 },
    { name: "Hatter", aliases: ["Hatter", "Mad Hatter"], priority: 50 },
    { name: "March Hare", aliases: ["March Hare"], priority: 45 },
    { name: "Mock Turtle", aliases: ["Mock Turtle"], priority: 40 },
    { name: "Queen", aliases: ["Queen", "Queen of Hearts"], priority: 45 },
    { name: "King", aliases: ["King", "King of Hearts"], priority: 20 },
    { name: "Caterpillar", aliases: ["Caterpillar"], priority: 45 },
    { name: "Gryphon", aliases: ["Gryphon"], priority: 20 },
    { name: "Duchess", aliases: ["Duchess"], priority: 20 },
    { name: "Dormouse", aliases: ["Dormouse"], priority: 20 },
    { name: "Dinah", aliases: ["Dinah"], priority: 5 },
  ];
  if (shouldUseCanonicalCharacterSet(text, options)) {
    for (const character of canonicalCharacters) {
      const count = countExactNames(text, character.aliases);
      if (count > 0) {
        phraseCandidates.set(character.name, {
          name: character.name,
          count,
          score: count + character.priority,
          aliases: character.aliases,
          source: "canonical",
        });
      }
    }
  }
  const titlePhrases = String(text).match(/\b[A-Z][a-z]{2,}(?:\s+(?:of\s+|the\s+)?[A-Z][a-z]{2,}){1,2}\b/g) || [];
  const phraseStop = new Set([
    "Project Gutenberg",
    "Alice Adventures",
    "Lewis Carroll",
    "Millennium Fulcrum",
    "How To Win",
    "Win Friends",
    "New York",
    ...(titleStopPhrases(options.title || "")),
  ]);
  for (const phrase of titlePhrases) {
    if (phraseStop.has(phrase)) continue;
    if (/\b(Chapter|Illustration|Contents)\b/.test(phrase)) continue;
    const existing = phraseCandidates.get(phrase);
    if (existing) {
      if (existing.source === "canonical") continue;
      existing.count += 1;
      existing.score += 1;
      continue;
    }
    phraseCandidates.set(phrase, {
      name: phrase,
      count: 1,
      score: 1,
      aliases: [phrase],
      source: "title-phrase",
    });
  }

  const matches = String(text).match(/\b[A-Z][a-z]{2,}\b/g) || [];
  const stop = new Set([
    "The",
    "And",
    "But",
    "Chapter",
    "Then",
    "When",
    "This",
    "That",
    "Once",
    "Her",
    "His",
    "She",
    "He",
    "They",
    "You",
    "Your",
    "What",
    "Why",
    "How",
    "Who",
    "Where",
    "Which",
    "There",
    "Here",
    "Nothing",
    "Anything",
    "Everything",
    "Well",
    "Yes",
    "No",
    "Oh",
    "One",
    "Come",
    "Look",
    "Dear",
    "Poor",
    "Please",
    "Mine",
    "Off",
    "Window",
    "Rain",
    "Lantern",
    "Bridge",
    "Home",
    "Moonrise",
    "Project",
    "Gutenberg",
    "Alice’s",
    "Adventures",
    "Wonderland",
    "Lewis",
    "Carroll",
    "Mock",
    "Turtle",
    "Rabbit",
    "Hare",
    "Cat",
    "Hatter",
    "Hearts",
  ]);
  const protectedPhraseWords = new Set(
    [...phraseCandidates.entries()]
      .filter(([, item]) => item.count >= 2)
      .flatMap(([phrase, item]) => [phrase, ...(item.aliases || [])])
      .flatMap((phrase) => phrase.split(/\s+/).filter((word) => !["of", "the"].includes(word.toLowerCase()))),
  );
  for (const match of matches) {
    if (stop.has(match)) continue;
    if (protectedPhraseWords.has(match)) continue;
    const existing = candidates.get(match) || { count: 0, score: 0, aliases: [match] };
    candidates.set(match, {
      name: match,
      count: existing.count + 1,
      score: existing.score + 1,
      aliases: existing.aliases,
      source: "capitalized-word",
    });
  }

  return [...new Map([
    ...[...phraseCandidates.entries()].filter(([, item]) => item.count >= 2),
    ...candidates.entries(),
  ]).values()]
    .sort((a, b) => b.score - a.score || b.count - a.count || a.name.localeCompare(b.name));
}

function shouldUseCanonicalCharacterSet(text, options = {}) {
  const title = String(options.title || "").toLowerCase();
  if (/\balice\b|wonderland/.test(title)) return true;
  const source = String(text || "");
  const canonicalSignals = [
    "Alice",
    "White Rabbit",
    "Cheshire Cat",
    "Hatter",
    "March Hare",
    "Queen of Hearts",
    "Caterpillar",
  ];
  const hitCount = canonicalSignals.filter((name) => countExactNames(source, [name]) > 0).length;
  return hitCount >= 3 && /\bAlice\b/u.test(source);
}

function reviewCharacterCandidate(candidate, text) {
  const name = candidate.name;
  const normalized = normalizeCharacterNameForReview(name);
  const contextScore = characterContextScore(name, text);
  const multiWord = /\s/.test(name);
  const reviewScore = candidate.score + contextScore + (multiWord ? 2 : 0);

  if (COMMON_NON_CHARACTER_NAMES.has(normalized)) {
    return {
      status: "rejected",
      reason: "common word or title fragment, not a stable character",
      reviewScore,
    };
  }
  if (isLikelyPlaceCandidate(name, text)) {
    return {
      status: "rejected",
      reason: "place or location phrase",
      reviewScore,
    };
  }
  if (candidate.source === "canonical") {
    return {
      status: "approved",
      reason: "known recurring story character",
      reviewScore,
    };
  }
  if (candidate.count < 2) {
    return {
      status: "rejected",
      reason: "only mentioned once",
      reviewScore,
    };
  }
  if (!multiWord && candidate.count < 3 && contextScore === 0) {
    return {
      status: "rejected",
      reason: "weak single-word signal without character action context",
      reviewScore,
    };
  }
  if (!multiWord && contextScore === 0) {
    return {
      status: "review",
      reason: "recurring proper-name candidate needs story/action context review",
      reviewScore,
    };
  }
  return {
    status: "approved",
    reason: contextScore ? "recurring named entity with story/action context" : "recurring proper-name candidate",
    reviewScore,
  };
}

function characterFromCandidate(name, item, index) {
  const id = normalizeId(name, `character-${index + 1}`);
  return {
    id,
    name,
    aliases: [...new Set([name, ...(item.aliases || [])])],
    sourceMentions: item.count,
    description: describeCharacter(name, index),
    visualAnchors: visualAnchorsFor(name, index),
    review: {
      status: item.status,
      reason: item.reason,
      score: item.reviewScore,
      source: item.source,
    },
    reference: {
      status: "needs_codex_generation",
      targetAssetPath: `assets/characters/${id}.png`,
      promptPath: `assets/codex-image-jobs/characters/${id}.md`,
    },
  };
}

function fallbackCharacter() {
  return {
    id: "protagonist",
    name: "Protagonist",
    description: "A gentle recurring protagonist designed with a stable outfit and warm expression.",
    visualAnchors: ["stable outfit", "warm expression", "simple silhouette"],
    review: {
      status: "fallback",
      reason: "no approved recurring character candidates",
      score: 0,
      source: "fallback",
    },
    reference: {
      status: "needs_codex_generation",
      targetAssetPath: "assets/characters/protagonist.png",
      promptPath: "assets/codex-image-jobs/characters/protagonist.md",
    },
  };
}

function characterDecisionForManifest(candidate) {
  return {
    name: candidate.name,
    aliases: candidate.aliases,
    count: candidate.count,
    score: candidate.score,
    reviewScore: candidate.reviewScore,
    status: candidate.status,
    reason: candidate.reason,
    source: candidate.source,
  };
}

function titleStopPhrases(title) {
  const words = String(title || "").match(/\b[A-Z][A-Za-z]{2,}\b/g) || [];
  const phrases = [];
  for (let index = 0; index < words.length - 1; index += 1) {
    phrases.push(`${words[index]} ${words[index + 1]}`);
  }
  for (let index = 0; index < words.length - 2; index += 1) {
    phrases.push(`${words[index]} ${words[index + 1]} ${words[index + 2]}`);
  }
  return phrases;
}

const COMMON_NON_CHARACTER_NAMES = new Set([
  "about",
  "after",
  "again",
  "all",
  "also",
  "another",
  "before",
  "business",
  "chapter",
  "contents",
  "culture",
  "every",
  "first",
  "for",
  "friend",
  "friends",
  "from",
  "good",
  "great",
  "happy",
  "into",
  "just",
  "lesson",
  "let",
  "music",
  "never",
  "new",
  "next",
  "now",
  "page",
  "part",
  "people",
  "principle",
  "second",
  "some",
  "story",
  "than",
  "their",
  "these",
  "thing",
  "things",
  "think",
  "time",
  "when",
  "with",
  "work",
  "world",
  "york",
  "white house",
  "baa",
  "baby",
  "fire",
]);

function normalizeCharacterNameForReview(name) {
  return String(name || "")
    .normalize("NFKC")
    .replace(/[’‘]/g, "'")
    .trim()
    .toLowerCase();
}

function isLikelyPlaceCandidate(name, text) {
  const normalized = normalizeCharacterNameForReview(name);
  if (["york", "london", "paris", "america", "england", "china", "japan", "white house"].includes(normalized)) return true;
  if (normalized === "new" && /\bNew\s+York\b/.test(text)) return true;
  return /\b(?:New York|United States|United Kingdom|Los Angeles|San Francisco)\b/.test(name);
}

function characterContextScore(name, text) {
  let score = 0;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exactName = `(?<![\\p{Letter}\\p{Number}])${escaped}(?![\\p{Letter}\\p{Number}])`;
  const actionWords = "said|asked|answered|replied|called|shouted|whispered|laughed|smiled|cried|followed|met|watched|walked|ran|looked|promised|wondered|thought|explained|saluted";
  const nameThenAction = new RegExp(`${exactName}\\s+(?:${actionWords})\\b`, "iu");
  const actionThenName = new RegExp(`\\b(?:${actionWords})\\b\\s+(?:to\\s+|at\\s+|with\\s+|the\\s+)?${exactName}`, "iu");
  const titledName = new RegExp(`\\b(?:mr|mrs|miss|dr|professor|queen|king|grandpa|grandma)\\.?\\s+${exactName}`, "iu");
  const pattern = exactNameRegExp(name, "giu");
  for (const match of String(text || "").matchAll(pattern)) {
    const start = Math.max(0, (match.index || 0) - 48);
    const end = Math.min(text.length, (match.index || 0) + match[0].length + 48);
    const snippet = text.slice(start, end).toLowerCase();
    if (nameThenAction.test(snippet) || actionThenName.test(snippet)) {
      score += 2;
    }
    if (titledName.test(snippet)) {
      score += 1;
    }
    if (score >= 6) return score;
  }
  return score;
}

function countExactNames(text, names) {
  const source = String(text);
  const ranges = [];
  const orderedNames = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const name of orderedNames) {
    for (const match of source.matchAll(exactNameRegExp(name, "giu"))) {
      const start = match.index || 0;
      const end = start + match[0].length;
      const overlapsExisting = ranges.some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart);
      if (!overlapsExisting) ranges.push([start, end]);
    }
  }
  return ranges.length;
}

function exactNameRegExp(name, flags = "iu") {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{Letter}\\p{Number}])${escaped}(?![\\p{Letter}\\p{Number}])`, flags);
}

function describeCharacter(name, index) {
  const lower = name.toLowerCase();
  if (lower === "mira") {
    return "Mira is a young child with dark bobbed hair, a small red hair clip, a yellow raincoat, a teal striped shirt, red rain boots, and a warm curious expression.";
  }
  if (lower === "grandpa") {
    return "Grandpa is a kind elderly figure with soft white hair, round glasses, a gentle moustache, a deep teal cardigan, and a red umbrella.";
  }
  if (lower === "niko") {
    return "Niko is a friendly small green frog with a bottle-cap hat, bright eyes, and a serious but gentle expression.";
  }

  const accents = ["coral red", "deep teal", "warm gold", "soft blue-green", "moss green", "paper cream"];
  return `${name} as a recurring picture-book character with a stable outfit, ${accents[index % accents.length]} accent color, readable silhouette, and clear facial expression.`;
}

function visualAnchorsFor(name, index) {
  const lower = name.toLowerCase();
  if (lower === "mira") return ["dark bobbed hair", "red hair clip", "yellow raincoat", "teal striped shirt", "red rain boots"];
  if (lower === "grandpa") return ["white hair", "round glasses", "deep teal cardigan", "red umbrella", "kind smile"];
  if (lower === "niko") return ["small green frog", "bottle-cap hat", "bright eyes", "serious gentle expression"];

  const accent = ["coral red", "deep teal", "warm gold", "soft blue-green", "moss green", "paper cream"][index % 6];
  return ["stable silhouette", `${accent} color accent`, "clear facial expression"];
}

export function referencedCharacters(text, characters) {
  return characters
    .filter((character) => {
      const names = [character.name, ...(character.aliases || [])].filter(Boolean);
      return names.some((name) => exactNameRegExp(name).test(text));
    })
    .map((character) => character.id);
}

function detectLanguage(text) {
  if (/[\u3040-\u30ff]/u.test(text)) return "ja";
  if (/[\u3400-\u9fff]/u.test(text)) return "zh";
  return "en";
}

function titleFromPath(sourcePath) {
  return path.basename(sourcePath, path.extname(sourcePath)).replace(/[-_]+/g, " ");
}
