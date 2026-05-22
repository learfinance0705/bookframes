const state = {
  project: null,
  projectBaseUrl: "",
  projectPath: "",
  changeContext: null,
  lastChangeRequest: null,
  lastImageRun: null,
  lastBookRun: null,
  statusTimer: null,
  imageRunTimer: null,
  bookRunTimer: null,
  changeBusy: false,
  exportBusy: false,
  importBusy: false,
  modelConfig: null,
  modelEnv: null,
  modelConfigBusy: false,
};

const AUTO_SPREAD_PLAN_VALUES = new Set([
  "auto",
  "codex",
  "codex-auto",
  "codex-local",
  "local-codex",
  "自动",
  "本地codex",
]);

const FULL_COVERAGE_PLAN_VALUES = new Set([
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

const fallbackProject = {
  book: {
    title: "BookFrames",
    language: "zh",
    audienceAge: "6-9",
    originalStats: {
      sourceFormat: "pdf",
      extractionMethod: "mineru-hybrid",
      importQualityScore: 0,
      importQualityLevel: "未加载",
    },
    source: {
      format: "pdf",
      extractionMethod: "未加载",
      importQuality: {
        score: 0,
        level: "empty",
        recommendations: ["载入 bookframes.json 后显示审稿结果。"],
      },
      pageAudit: { pages: [] },
      chapterMap: { method: "n/a", count: 0 },
    },
  },
  styleBible: { name: "warm-watercolor" },
  chapters: [],
  characters: [],
  assets: {},
  exports: {},
  storyArc: {},
  planningReview: { status: "empty", warnings: [] },
};

const els = {
  projectMeta: document.getElementById("projectMeta"),
  sourceInput: document.getElementById("sourceInput"),
  outInput: document.getElementById("outInput"),
  titleInput: document.getElementById("titleInput"),
  pdfEngineInput: document.getElementById("pdfEngineInput"),
  ocrPresetInput: document.getElementById("ocrPresetInput"),
  ocrMaxPagesInput: document.getElementById("ocrMaxPagesInput"),
  langInput: document.getElementById("langInput"),
  spreadsInput: document.getElementById("spreadsInput"),
  modelProviderInput: document.getElementById("modelProviderInput"),
  modelTextInput: document.getElementById("modelTextInput"),
  modelImageInput: document.getElementById("modelImageInput"),
  modelBaseUrlInput: document.getElementById("modelBaseUrlInput"),
  modelApiKeyEnvInput: document.getElementById("modelApiKeyEnvInput"),
  saveModelConfigButton: document.getElementById("saveModelConfigButton"),
  testModelConfigButton: document.getElementById("testModelConfigButton"),
  modelConfigStatus: document.getElementById("modelConfigStatus"),
  createCommand: document.getElementById("createCommand"),
  queueCommand: document.getElementById("queueCommand"),
  importAutoButton: document.getElementById("importAutoButton"),
  bookRunView: document.getElementById("bookRunView"),
  copyCommandButton: document.getElementById("copyCommandButton"),
  copyQueueButton: document.getElementById("copyQueueButton"),
  openChangeButton: document.getElementById("openChangeButton"),
  loadDemoButton: document.getElementById("loadDemoButton"),
  projectFileInput: document.getElementById("projectFileInput"),
  summaryBand: document.getElementById("summaryBand"),
  qualityView: document.getElementById("qualityView"),
  planningView: document.getElementById("planningView"),
  chapterFilter: document.getElementById("chapterFilter"),
  chapterList: document.getElementById("chapterList"),
  queueView: document.getElementById("queueView"),
  copyNextPromptButton: document.getElementById("copyNextPromptButton"),
  importLatestImageButton: document.getElementById("importLatestImageButton"),
  generateApiImageButton: document.getElementById("generateApiImageButton"),
  generateFullBookButton: document.getElementById("generateFullBookButton"),
  imageActionStatus: document.getElementById("imageActionStatus"),
  imageRunView: document.getElementById("imageRunView"),
  captionModeInput: document.getElementById("captionModeInput"),
  convertCaptionsButton: document.getElementById("convertCaptionsButton"),
  exportBookButton: document.getElementById("exportBookButton"),
  exportStatus: document.getElementById("exportStatus"),
  exportsView: document.getElementById("exportsView"),
  changeRequestView: document.getElementById("changeRequestView"),
  pageAuditView: document.getElementById("pageAuditView"),
  changeDialog: document.getElementById("changeDialog"),
  changeProjectLabel: document.getElementById("changeProjectLabel"),
  closeChangeButton: document.getElementById("closeChangeButton"),
  changeTargetInput: document.getElementById("changeTargetInput"),
  changeFeedbackInput: document.getElementById("changeFeedbackInput"),
  submitChangeButton: document.getElementById("submitChangeButton"),
  planChangeButton: document.getElementById("planChangeButton"),
  runChangeButton: document.getElementById("runChangeButton"),
  changeDialogStatus: document.getElementById("changeDialogStatus"),
};

async function init() {
  for (const input of [
    els.sourceInput,
    els.outInput,
    els.titleInput,
    els.pdfEngineInput,
    els.ocrPresetInput,
    els.ocrMaxPagesInput,
    els.langInput,
    els.spreadsInput,
  ]) {
    input.addEventListener("input", renderCommands);
  }
  for (const input of [
    els.modelTextInput,
    els.modelImageInput,
    els.modelBaseUrlInput,
    els.modelApiKeyEnvInput,
  ]) {
    input.addEventListener("input", () => {
      state.modelConfig = modelConfigFromInputs();
      renderModelConfigStatus();
      renderCommands();
    });
  }

  els.modelProviderInput.addEventListener("change", handleModelProviderChange);
  els.saveModelConfigButton.addEventListener("click", saveModelConfig);
  els.testModelConfigButton.addEventListener("click", testModelConfig);
  els.copyCommandButton.addEventListener("click", () => copyText(els.createCommand.textContent));
  els.copyQueueButton.addEventListener("click", () => copyText(els.queueCommand.textContent));
  els.importAutoButton.addEventListener("click", startAutoImportRun);
  els.openChangeButton.addEventListener("click", openChangeDialog);
  els.loadDemoButton.addEventListener("click", () => loadProjectFromUrl("/tests/tmp/smoke-project/bookframes.json"));
  els.projectFileInput.addEventListener("change", loadProjectFile);
  els.chapterFilter.addEventListener("change", renderChapters);
  els.closeChangeButton.addEventListener("click", () => els.changeDialog.close());
  els.submitChangeButton.addEventListener("click", () => submitChangeRequest({ action: "queue" }));
  els.planChangeButton.addEventListener("click", () => submitChangeRequest({ action: "plan" }));
  els.runChangeButton.addEventListener("click", () => submitChangeRequest({ action: "run" }));
  els.copyNextPromptButton.addEventListener("click", copyNextImagePrompt);
  els.importLatestImageButton.addEventListener("click", importLatestGeneratedImage);
  els.generateApiImageButton.addEventListener("click", generateOneImageWithLocalCodex);
  els.generateFullBookButton.addEventListener("click", generateFullBookWithLocalCodex);
  els.imageRunView.addEventListener("click", handleImageRunAction);
  els.convertCaptionsButton.addEventListener("click", convertCaptionsLanguage);
  els.captionModeInput.addEventListener("input", updateCaptionModeButton);
  els.exportBookButton.addEventListener("click", exportBook);

  await loadModelConfig();
  const params = new URLSearchParams(window.location.search);
  const project = params.get("project");
  if (project) {
    await loadProjectFromUrl(project);
  } else {
    setProject(fallbackProject, "", "");
  }
  await loadLatestImageRun({ allowProjectSwitch: true });
  loadLatestChangeRequest();
  await loadLatestBookRun();
  renderCommands();
}

async function loadProjectFromUrl(projectPath) {
  try {
    const response = await fetch(projectPath);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const project = await response.json();
    const base = new URL(projectPath, window.location.href);
    base.pathname = base.pathname.replace(/[^/]+$/, "");
    setProject(project, base.pathname, projectPath);
    updateProjectUrl(projectPath);
  } catch (error) {
    setProject({
      ...fallbackProject,
      book: {
        ...fallbackProject.book,
        title: "加载失败",
        source: {
          ...fallbackProject.book.source,
          importQuality: {
            score: 0,
            level: "error",
            recommendations: [error.message],
          },
        },
      },
    }, "", projectPath);
  }
}

function updateProjectUrl(projectPath) {
  const value = String(projectPath || "");
  if (!value.startsWith("/runs/")) return;
  const url = new URL(window.location.href);
  url.searchParams.set("project", value);
  window.history.replaceState(null, "", url);
}

async function loadProjectFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const lowerName = file.name.toLowerCase();
  if (!lowerName.endsWith(".json")) {
    await uploadBookSourceFile(file);
    event.target.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const project = JSON.parse(reader.result);
      setProject(project, "", file.name);
    } catch (error) {
      setProject({
        ...fallbackProject,
        book: {
          ...fallbackProject.book,
          title: "JSON 错误",
          source: {
            ...fallbackProject.book.source,
            importQuality: {
              score: 0,
              level: "error",
              recommendations: [error.message],
            },
          },
        },
      }, "", file.name);
    }
  };
  reader.readAsText(file);
  event.target.value = "";
}

async function uploadBookSourceFile(file) {
  const supported = /\.(epub|pdf|txt|md|markdown)$/i.test(file.name);
  if (!supported) {
    renderBookRunMessage("请选择 bookframes.json 或 EPUB/PDF/TXT/MD 书源。", "bad");
    return;
  }
  setImportBusy(true);
  renderBookRunMessage(`正在上传并导入 ${file.name}...`, "warn");
  try {
    const params = new URLSearchParams({
      filename: file.name,
      title: titleFromFilename(file.name),
      spreadsPerChapter: spreadsPlanValue(),
      pdfEngine: els.pdfEngineInput.value,
      ocrRecognition: ocrRecognitionForPreset(els.ocrPresetInput.value),
      ocrScale: ocrScaleForPreset(els.ocrPresetInput.value),
      languageMode: els.langInput.value,
    });
    const ocrMaxPages = ocrMaxPagesValue();
    if (ocrMaxPages) params.set("ocrMaxPages", ocrMaxPages);
    const ocrLanguage = ocrLanguageForMode(els.langInput.value);
    if (ocrLanguage) {
      params.set("mineruLang", ocrLanguage);
      params.set("ocrLang", ocrLanguage);
    }
    const response = await fetch(`/api/book-runs/upload?${params.toString()}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || response.statusText);
    state.lastBookRun = data.job;
    setImportBusy(true);
    els.sourceInput.value = data.job.sourcePath || file.name;
    if (data.job.outDir) els.outInput.value = displayWorkspacePath(data.job.outDir);
    els.titleInput.value = data.job.title || titleFromFilename(file.name);
    renderBookRun();
    pollBookRun(data.job.id);
    return;
  } catch (error) {
    renderBookRunMessage(`导入失败：${error.message}`, "bad");
    setImportBusy(false);
  }
}

function setProject(project, baseUrl, projectPath) {
  state.project = project;
  state.projectBaseUrl = baseUrl || "";
  state.projectPath = projectPath || "";
  clearMismatchedImageRun();
  syncInputsFromProject(project, projectPath);
  renderProject();
}

function renderProject() {
  const project = state.project || fallbackProject;
  const summary = summarize(project);
  els.projectMeta.textContent = [
    project.book?.title || "未命名",
    summary.source,
    `${summary.chapterCount} 章`,
    `${summary.spreadCount} 页`,
  ].join(" · ");

  renderSummary(summary);
  renderQuality(project);
  renderPlanning(project);
  renderChapterFilter(project);
  renderChapters();
  renderQueue(project);
  renderBookRun();
  renderImageRun();
  renderExports(project);
  renderChangeRequest();
  renderPageAudit(project);
  renderCommands();
  updateCaptionModeButton();
  setExportBusy(state.exportBusy);
  updateRevisionGate(project);
}

async function loadModelConfig() {
  try {
    const response = await fetch("/api/model-config");
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || response.statusText);
    applyModelConfig(data.config, data.env);
  } catch {
    applyModelConfig(defaultModelConfigForProvider("local-codex"), {
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyEnvPresent: false,
    });
  }
}

function applyModelConfig(config, env = null) {
  const normalized = {
    ...defaultModelConfigForProvider(config?.provider || "local-codex"),
    ...(config || {}),
  };
  state.modelConfig = normalized;
  state.modelEnv = env;
  els.modelProviderInput.value = normalized.provider;
  els.modelTextInput.value = normalized.textModel || "";
  els.modelImageInput.value = normalized.imageModel || "";
  els.modelBaseUrlInput.value = normalized.baseUrl || "";
  els.modelApiKeyEnvInput.value = normalized.apiKeyEnv || "";
  updateModelDependentButtons();
  renderModelConfigStatus();
  renderCommands();
}

function handleModelProviderChange() {
  applyModelConfig(defaultModelConfigForProvider(els.modelProviderInput.value), state.modelEnv);
}

function modelConfigFromInputs() {
  const provider = els.modelProviderInput.value || "local-codex";
  return {
    provider,
    textModel: els.modelTextInput.value.trim(),
    imageModel: els.modelImageInput.value.trim(),
    baseUrl: els.modelBaseUrlInput.value.trim(),
    apiKeyEnv: els.modelApiKeyEnvInput.value.trim(),
    planningMode: provider === "local-codex" ? "local-codex" : "api",
    captionMode: provider === "local-codex" ? "local-codex" : "api",
  };
}

async function saveModelConfig() {
  setModelConfigBusy(true);
  state.modelConfig = modelConfigFromInputs();
  renderModelConfigStatus({ ok: true, message: "正在保存连接..." });
  try {
    const response = await fetch("/api/model-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: state.modelConfig }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || response.statusText);
    applyModelConfig(data.config, data.env);
    renderModelConfigStatus({ ok: true, message: "连接已保存。" });
  } catch (error) {
    renderModelConfigStatus({ ok: false, message: `保存失败：${error.message}` });
  } finally {
    setModelConfigBusy(false);
  }
}

async function testModelConfig() {
  setModelConfigBusy(true);
  state.modelConfig = modelConfigFromInputs();
  renderModelConfigStatus({ ok: true, message: "正在检测连接..." });
  try {
    const response = await fetch("/api/model-config/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: state.modelConfig }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || response.statusText);
    state.modelConfig = data.config;
    state.modelEnv = data.env;
    renderModelConfigStatus(data.result);
  } catch (error) {
    renderModelConfigStatus({ ok: false, message: `检测失败：${error.message}` });
  } finally {
    setModelConfigBusy(false);
  }
}

function renderModelConfigStatus(result = null) {
  const config = state.modelConfig || modelConfigFromInputs();
  const env = state.modelEnv || {};
  const provider = modelProviderLabel(config.provider);
  const imageProvider = imageProviderForCurrentModel(config) === "openai-image" ? "OpenAI 图片 API" : "本地 Codex 图片";
  const envLabel = config.provider === "local-codex"
    ? "本地授权"
    : config.provider === "ollama"
      ? "本地端点"
    : `${config.apiKeyEnv || "API_KEY"} ${env.apiKeyEnvPresent ? "已设置" : "未设置"}`;
  const tone = result ? (result.ok ? "good" : "bad") : config.provider === "local-codex" || config.provider === "ollama" || env.apiKeyEnvPresent ? "good" : "warn";
  const message = result?.message || `${provider} · ${envLabel} · ${imageProvider}`;
  els.modelConfigStatus.dataset.tone = tone;
  els.modelConfigStatus.innerHTML = `
    <span>${escapeHtml(message)}</span>
    ${config.baseUrl ? `<span>${escapeHtml(config.baseUrl)}</span>` : ""}
    ${result?.detail ? `<span>${escapeHtml(result.detail)}</span>` : ""}
  `;
  updateModelDependentButtons();
}

function setModelConfigBusy(isBusy) {
  state.modelConfigBusy = Boolean(isBusy);
  els.saveModelConfigButton.disabled = isBusy;
  els.testModelConfigButton.disabled = isBusy;
}

function updateModelDependentButtons() {
  const provider = imageProviderForCurrentModel();
  els.generateApiImageButton.textContent = provider === "openai-image" ? "OpenAI 生成 1 张" : "本地 Codex 生成 1 张";
  els.generateApiImageButton.title = provider === "openai-image"
    ? "使用 OPENAI_API_KEY 和图片模型生成当前队列下一张"
    : "使用本地 Codex 生成当前队列下一张";
}

function imageProviderForCurrentModel(config = state.modelConfig) {
  const provider = config?.provider || "local-codex";
  const imageModel = String(config?.imageModel || "").trim();
  if (provider === "openai" && imageModel && imageModel !== "codex-local") return "openai-image";
  return "codex-exec";
}

function defaultModelConfigForProvider(provider) {
  const selected = provider || "local-codex";
  const defaults = {
    "local-codex": {
      provider: "local-codex",
      textModel: "gpt-5.5",
      imageModel: "codex-local",
      baseUrl: "",
      apiKeyEnv: "OPENAI_API_KEY",
    },
    openai: {
      provider: "openai",
      textModel: "gpt-5.5",
      imageModel: "gpt-image-1",
      baseUrl: "",
      apiKeyEnv: "OPENAI_API_KEY",
    },
    openrouter: {
      provider: "openrouter",
      textModel: "openai/gpt-5.5",
      imageModel: "",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
    },
    ollama: {
      provider: "ollama",
      textModel: "qwen3:14b",
      imageModel: "",
      baseUrl: "http://127.0.0.1:11434",
      apiKeyEnv: "",
    },
    custom: {
      provider: "custom",
      textModel: "model-name",
      imageModel: "",
      baseUrl: "",
      apiKeyEnv: "LLM_API_KEY",
    },
  };
  return {
    ...defaults["local-codex"],
    ...(defaults[selected] || {}),
  };
}

function modelProviderLabel(provider) {
  return {
    "local-codex": "本地 Codex",
    openai: "OpenAI",
    openrouter: "OpenRouter",
    ollama: "Ollama",
    custom: "自定义接口",
  }[provider] || provider || "模型";
}

async function startAutoImportRun() {
  const sourcePath = els.sourceInput.value.trim();
  const outDir = els.outInput.value.trim();
  if (!sourcePath || !outDir) {
    renderBookRunMessage("请先填写源文件和输出目录。", "bad");
    return;
  }
  setImportBusy(true);
  renderBookRunMessage("正在创建导入任务...", "warn");
  try {
    const response = await fetch("/api/book-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourcePath,
        outDir,
        title: els.titleInput.value.trim(),
        pdfEngine: els.pdfEngineInput.value,
        ocrRecognition: ocrRecognitionForPreset(els.ocrPresetInput.value),
        ocrScale: ocrScaleForPreset(els.ocrPresetInput.value),
        ocrMaxPages: ocrMaxPagesValue(),
        languageMode: els.langInput.value,
        mineruLang: ocrLanguageForMode(els.langInput.value),
        ocrLang: ocrLanguageForMode(els.langInput.value),
        spreadsPerChapter: spreadsPlanValue(),
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || response.statusText);
    state.lastBookRun = data.job;
    setImportBusy(true);
    renderBookRun();
    pollBookRun(data.job.id);
    return;
  } catch (error) {
    renderBookRunMessage(`导入失败：${error.message}`, "bad");
    setImportBusy(false);
  }
}

function renderSummary(summary) {
  els.summaryBand.innerHTML = [
    metric("质量", summary.quality),
    metric("章节", summary.chapterCount),
    metric("页面", summary.spreadCount),
    metric("图片", `${summary.readyImages}/${summary.spreadCount}`),
    metric("语言", summary.language),
    metric("页规", summary.pagePlan),
    metric("队列", summary.queuePending),
  ].join("");
}

function renderQuality(project) {
  const source = project.book?.source || {};
  const quality = source.importQuality || {};
  const checks = quality.checks || {};
  const tone = quality.stopBeforeDrawing ? "bad" : quality.level === "high" ? "good" : "warn";
  els.qualityView.innerHTML = `
    <div class="quality-main">
      <div class="score-ring" style="border-color:${scoreColor(quality.score)}">${escapeHtml(quality.score ?? 0)}</div>
      <div>
        <div class="status-line">
          <span class="pill" data-tone="${tone}">${escapeHtml(quality.level || "n/a")}</span>
          <span class="pill">${escapeHtml(source.extractionMethod || "unknown")}</span>
          <span class="pill">${escapeHtml(source.routing?.reason || source.routing?.mode || "route")}</span>
        </div>
        <div class="arc-list" style="margin-top:10px">
          ${arcRow("覆盖", `${percent(checks.textCoverageRatio)} · ${checks.textChars || 0} chars`, "文本")}
          ${arcRow("bbox", checks.bboxCoverageRatio === null || checks.bboxCoverageRatio === undefined ? "n/a" : percent(checks.bboxCoverageRatio), "版面")}
          ${arcRow("分章", `${checks.chapterCount || 0} · ${checks.chapterConfidence || 0}`, source.chapterMap?.method || "method")}
        </div>
      </div>
    </div>
    <div class="arc-list" style="margin-top:12px">
      ${(quality.recommendations || []).slice(0, 4).map((item) => arcRow("建议", item, quality.level || "")).join("")}
    </div>`;
}

function renderPlanning(project) {
  const arc = project.storyArc || {};
  const review = project.planningReview || {};
  const checks = review.checks || {};
  const pagePlan = project.book?.pagePlan || {};
  const characterReview = project.characterReview || {};
  const statusTone = review.status === "ready" ? "good" : review.status === "blocked" ? "bad" : "warn";
  const characterTone = characterReview.status === "ready" ? "good" : "warn";
  const characterSummary = characterReview.status
    ? `${characterReview.approvedCount || 0} 通过 · ${characterReview.rejectedCount || 0} 拦截 · ${characterReview.reviewCount || 0} 待审`
    : "";
  const issues = [...(review.blockers || []), ...(review.warnings || [])];
  els.planningView.innerHTML = `
    <div class="status-line">
      <span class="pill" data-tone="${statusTone}">${escapeHtml(review.status || "n/a")}</span>
      ${characterReview.status ? `<span class="pill" data-tone="${characterTone}">${escapeHtml(`角色 ${characterReview.status}`)}</span>` : ""}
      <span class="pill">${escapeHtml(`${arc.sceneCount || 0} scenes`)}</span>
      <span class="pill">${escapeHtml(pagePlanLabel(pagePlan))}</span>
      <span class="pill">${escapeHtml((arc.recurringCharacters || []).join(", ") || "characters")}</span>
    </div>
    <div class="arc-list" style="margin-top:12px">
      ${pagePlan.reason ? arcRow("页数规划", pagePlan.reason, pagePlan.provider || pagePlan.mode || "plan") : ""}
      ${pagePlan.fallbackReason ? arcRow("兜底", pagePlan.fallbackReason, "fallback") : ""}
      ${characterSummary ? arcRow("角色审稿", characterSummary, characterReview.status || "") : ""}
      ${arcRow("开场", arc.opening || "n/a", "opening")}
      ${arcRow("中段", arc.midpoint || "n/a", "middle")}
      ${arcRow("结尾", arc.closing || "n/a", "closing")}
      ${checks.highDensitySpreadCount ? arcRow("密度", `${checks.highDensitySpreadCount} 页过密`, "review") : ""}
      ${issues.slice(0, 3).map((issue) => arcRow("复核", issue, review.status || "")).join("")}
    </div>`;
}

function renderChapterFilter(project) {
  const value = els.chapterFilter.value || "all";
  const chapters = project.chapters || [];
  els.chapterFilter.innerHTML = `<option value="all">全部章节</option>${chapters.map((chapter) => (
    `<option value="${escapeHtml(chapter.id)}">${escapeHtml(chapter.title)}</option>`
  )).join("")}`;
  if ([...els.chapterFilter.options].some((option) => option.value === value)) {
    els.chapterFilter.value = value;
  }
}

function renderChapters() {
  const project = state.project || fallbackProject;
  const selected = els.chapterFilter.value || "all";
  const chapters = (project.chapters || []).filter((chapter) => selected === "all" || chapter.id === selected);
  if (!chapters.length) {
    els.chapterList.innerHTML = `<div class="empty-state">没有章节数据。</div>`;
    return;
  }

  els.chapterList.innerHTML = chapters.map((chapter) => `
    <section class="chapter-section">
      <header class="chapter-head">
        <div>
          <h3>${escapeHtml(chapter.title)}</h3>
          <p>${escapeHtml(chapter.summary || "")}</p>
          ${chapter.pagePlan?.reason ? `<p class="chapter-plan">${escapeHtml(chapter.pagePlan.reason)}</p>` : ""}
        </div>
        <span class="pill">${escapeHtml(`${chapter.spreads?.length || 0} pages`)}</span>
      </header>
      <div class="spread-grid">
        ${(chapter.spreads || []).map((spread) => renderSpread(chapter, spread)).join("")}
      </div>
    </section>
  `).join("");
  for (const button of els.chapterList.querySelectorAll("[data-action='edit-spread']")) {
    button.addEventListener("click", () => {
      const context = findSpreadContext(button.dataset.chapterId, button.dataset.spreadId);
      openChangeDialog(context);
    });
  }
}

function renderSpread(chapter, spread) {
  const image = spread.image?.assetPath ? resolveAsset(spread.image.assetPath) : "";
  const imageLabel = spread.readerCaption || spread.caption || spread.id;
  const sourceChars = spread.sourceTextStats?.charCount || 0;
  const locked = isRevisionLocked(state.project);
  const imageMarkup = image
    ? `<div class="spread-thumb thumb-shell"><img src="${escapeHtml(image)}" alt="${escapeHtml(imageLabel)}" loading="lazy" onerror="this.parentElement.dataset.status='broken'; this.remove();" /><span>图片待导入</span></div>`
    : `<div class="spread-thumb thumb-shell" data-status="missing"><span>图片待导入</span></div>`;
  return `
    <article class="spread-card">
      ${imageMarkup}
      <div class="spread-body">
        <div class="spread-caption">${renderSpreadCaption(spread)}</div>
        <div class="spread-meta">
          <span class="pill">${escapeHtml(spread.id)}</span>
          <span class="pill">${escapeHtml(spread.visualIntent || "beat")}</span>
          <span class="pill">${escapeHtml(spread.image?.status || "missing")}</span>
          <span class="pill">${escapeHtml(spread.image?.provider || "provider")}</span>
          ${sourceChars ? `<span class="pill" data-tone="${sourceChars > 3600 ? "warn" : ""}">${escapeHtml(`${sourceChars} chars`)}</span>` : ""}
        </div>
        <button class="spread-edit-button" type="button" data-action="edit-spread" data-chapter-id="${escapeHtml(chapter.id)}" data-spread-id="${escapeHtml(spread.id)}" ${locked ? "disabled" : ""}>修改此页</button>
      </div>
    </article>`;
}

function renderSpreadCaption(spread) {
  const fallback = spread.readerCaption || spread.caption || spread.id;
  const lines = Array.isArray(spread.captionI18n?.lines) && spread.captionI18n.lines.length
    ? spread.captionI18n.lines
    : [{ language: "", label: "", text: fallback, needsTranslation: false }];
  return lines.map((line) => {
    const pending = !String(line.text || "").trim();
    const text = line.text || (line.needsTranslation ? "字幕待翻译" : fallback);
    const label = line.label || languageName(line.language || "");
    return `<span class="spread-caption-line" data-lang="${escapeHtml(line.language || "")}" data-pending="${pending ? "true" : "false"}">${label ? `<span class="caption-lang">${escapeHtml(label)}</span>` : ""}${escapeHtml(text)}</span>`;
  }).join("");
}

function renderQueue(project) {
  const queue = project.assets?.codexImageQueue;
  const items = queueItems(project);
  if (!items.length) {
    els.queueView.innerHTML = `<div class="empty-state">没有待处理队列。</div>`;
    return;
  }
  els.queueView.innerHTML = items.slice(0, 12).map((item) => `
    <div class="queue-row" data-status="${escapeHtml(item.status || "")}">
      <strong>${escapeHtml(item.type)}</strong>
      <span>${escapeHtml(item.title || item.id)}</span>
      <span>${escapeHtml(item.status || "n/a")}</span>
    </div>
  `).join("") + (items.length > 12 ? `<div class="queue-row"><strong>...</strong><span>${items.length - 12} more</span><span>${escapeHtml(queue?.queuePath || "")}</span></div>` : "");
}

async function copyNextImagePrompt() {
  if (!state.projectPath) {
    setImageActionStatus("当前项目不是本地服务路径，不能读取队列。", "bad");
    return;
  }
  setImageActionBusy(true);
  setImageActionStatus("正在读取下一张 prompt...", "warn");
  try {
    const response = await fetch(`/api/image-queue/next?project=${encodeURIComponent(state.projectPath)}`);
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || response.statusText);
    if (!data.prompt) {
      setImageActionStatus("没有待生成图片。", "good");
      return;
    }
    await copyText(data.prompt.prompt);
    setImageActionStatus(`已复制 ${data.prompt.type}:${data.prompt.id || data.prompt.spreadId}，目标 ${data.prompt.targetAssetPath}`, "good");
  } catch (error) {
    setImageActionStatus(`复制失败：${error.message}`, "bad");
  } finally {
    setImageActionBusy(false);
  }
}

async function importLatestGeneratedImage() {
  if (!state.projectPath) {
    setImageActionStatus("当前项目不是本地服务路径，不能导入。", "bad");
    return;
  }
  setImageActionBusy(true);
  setImageActionStatus("正在导入最近生成图片...", "warn");
  try {
    const response = await fetch("/api/image-queue/import-latest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: state.projectPath,
        limit: 1,
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || response.statusText);
    const item = data.imported?.[0];
    setImageActionStatus(item ? `已导入 ${item.type}:${item.id}` : "没有导入项。", "good");
    await refreshProjectFromDisk();
  } catch (error) {
    setImageActionStatus(`导入失败：${error.message}`, "bad");
  } finally {
    setImageActionBusy(false);
  }
}

async function generateOneImageWithLocalCodex() {
  if (!state.projectPath) {
    setImageActionStatus("当前项目不是本地服务路径，不能生成。", "bad");
    return;
  }
  const provider = imageProviderForCurrentModel();
  const providerLabel = provider === "openai-image" ? "OpenAI 图片 API" : "本地 Codex";
  setImageActionBusy(true);
  setImageActionStatus(`正在启动${providerLabel}图片任务...`, "warn");
  try {
    const response = await fetch("/api/image-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: state.projectPath,
        limit: 1,
        provider,
        model: state.modelConfig?.imageModel || "",
        apiKeyEnv: state.modelConfig?.apiKeyEnv || "OPENAI_API_KEY",
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || response.statusText);
    state.lastImageRun = data.job;
    renderImageRun();
    setImageActionStatus(`已启动${providerLabel}任务：${data.job.id}`, "good");
    pollImageRun(data.job.id);
  } catch (error) {
    setImageActionStatus(`生成失败：${error.message}`, "bad");
  } finally {
    setImageActionBusy(false);
  }
}

async function generateFullBookWithLocalCodex() {
  if (!state.projectPath) {
    setImageActionStatus("当前项目不是本地服务路径，不能生成整本。", "bad");
    return;
  }
  setImageActionBusy(true);
  setImageActionStatus("正在启动整本绘制任务...", "warn");
  try {
    const response = await fetch("/api/image-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: state.projectPath,
        limit: "all",
        mode: "all",
        provider: "codex-exec",
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || response.statusText);
    state.lastImageRun = data.job;
    renderImageRun();
    updateRevisionGate(state.project);
    setImageActionStatus(`已启动整本绘制任务：${data.job.id}`, "good");
    pollImageRun(data.job.id);
  } catch (error) {
    setImageActionStatus(`整本绘制失败：${error.message}`, "bad");
  } finally {
    setImageActionBusy(false);
  }
}

async function handleImageRunAction(event) {
  const button = event.target.closest("[data-image-run-action]");
  if (!button) return;
  const action = button.dataset.imageRunAction;
  const runId = button.dataset.runId;
  const job = state.lastImageRun;
  if (!job || (runId && job.id !== runId)) return;
  setImageActionBusy(true);
  try {
    if (action === "pause") {
      const response = await fetch(`/api/image-runs/${encodeURIComponent(job.id)}/pause`, {
        method: "POST",
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || response.statusText);
      state.lastImageRun = data.job;
      renderImageRun();
      updateRevisionGate(state.project);
      setImageActionStatus("画图队列已暂停。", "warn");
      return;
    }

    if (action === "resume") {
      const projectPath = job.projectPath || state.projectPath;
      if (!projectPath) throw new Error("当前任务没有可继续的项目路径。");
      const response = await fetch("/api/image-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath,
          mode: job.mode || "all",
          limit: job.mode === "single" ? 1 : "all",
          provider: job.provider || "codex-exec",
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || response.statusText);
      state.lastImageRun = data.job;
      renderImageRun();
      updateRevisionGate(state.project);
      setImageActionStatus(`继续绘制：${data.job.id}`, "good");
      pollImageRun(data.job.id);
    }
  } catch (error) {
    setImageActionStatus(`队列操作失败：${error.message}`, "bad");
  } finally {
    setImageActionBusy(false);
  }
}

async function loadLatestImageRun({ allowProjectSwitch = false } = {}) {
  try {
    const response = await fetch("/api/image-runs");
    const data = await response.json();
    if (data.ok && data.jobs?.length) {
      const matching = data.jobs.find((job) => imageRunMatchesCurrentProject(job)) || null;
      const bestActive = selectBestImageRunForPage(data.jobs);
      const shouldSwitch = allowProjectSwitch
        && bestActive?.projectPath
        && !sameProjectPath(bestActive.projectPath, state.projectPath)
        && shouldSwitchToImageRunProject(bestActive);
      state.lastImageRun = shouldSwitch ? bestActive : matching;
      if (shouldSwitch) {
        await loadProjectFromUrl(bestActive.projectPath);
      }
      renderImageRun();
      if (["queued", "running"].includes(state.lastImageRun?.status)) {
        pollImageRun(state.lastImageRun.id);
      }
    }
  } catch {
    // The static page can still work without the local API.
  }
}

function selectBestImageRunForPage(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  const active = list.filter((job) => ["queued", "running", "paused"].includes(job?.status) && job?.projectPath);
  if (!active.length) return null;
  return active.sort((a, b) => imageRunPageScore(b) - imageRunPageScore(a)
    || latestTimestamp(b) - latestTimestamp(a))[0];
}

function shouldSwitchToImageRunProject(job) {
  if (!state.projectPath) return true;
  const jobTotal = imageRunPageScore(job);
  const currentTotal = currentProjectSpreadCount();
  if (!currentTotal) return true;
  if (state.project?.book?.pagePlan?.mode === "full-coverage") return false;
  return jobTotal > currentTotal;
}

function imageRunPageScore(job) {
  return Number(job?.totalItems || job?.generated?.length || 0);
}

function currentProjectSpreadCount() {
  return (state.project?.chapters || []).reduce((sum, chapter) => sum + (chapter.spreads || []).length, 0);
}

function latestTimestamp(job) {
  return Date.parse(job?.heartbeatAt || "") || Date.parse(job?.updatedAt || "") || Date.parse(job?.createdAt || "") || 0;
}

async function loadLatestBookRun() {
  try {
    const response = await fetch("/api/book-runs");
    const data = await response.json();
    if (data.ok && data.jobs?.length) {
      state.lastBookRun = selectBookRunForCurrentProject(data.jobs);
      renderBookRun();
      if (state.lastBookRun?.projectPath && !state.projectPath) {
        await loadProjectFromUrl(state.lastBookRun.projectPath);
      }
      if (["queued", "running", "drawing"].includes(state.lastBookRun?.status)) {
        setImportBusy(true);
        pollBookRun(state.lastBookRun.id);
      }
    }
  } catch {
    // The static page can still work without the local API.
  }
}

function selectBookRunForCurrentProject(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  const active = (job) => ["queued", "running", "drawing"].includes(job?.status);
  if (state.projectPath) {
    return list.find((job) => bookRunMatchesCurrentProject(job) && active(job))
      || list.find((job) => bookRunMatchesCurrentProject(job))
      || null;
  }
  return list.find(active) || list[0] || null;
}

function pollBookRun(id) {
  clearTimeout(state.bookRunTimer);
  state.bookRunTimer = setTimeout(async () => {
    try {
      const response = await fetch(`/api/book-runs/${encodeURIComponent(id)}`);
      const data = await response.json();
      if (data.ok) {
        const previousProjectPath = state.lastBookRun?.projectPath;
        state.lastBookRun = data.job;
        renderBookRun();
        updateRevisionGate(state.project);
        if (data.job.projectPath && (!sameProjectPath(data.job.projectPath, previousProjectPath) || !sameProjectPath(data.job.projectPath, state.projectPath))) {
          await loadProjectFromUrl(data.job.projectPath);
        }
        if (data.job.imageRunId && (!state.lastImageRun || state.lastImageRun.id !== data.job.imageRunId)) {
          pollImageRun(data.job.imageRunId);
        }
        if (["queued", "running", "drawing"].includes(data.job.status)) {
          pollBookRun(id);
        } else if (data.job.projectPath) {
          setImportBusy(false);
          await loadProjectFromUrl(data.job.projectPath);
        } else {
          setImportBusy(false);
        }
      }
    } catch {
      pollBookRun(id);
    }
  }, 1800);
}

function pollImageRun(id) {
  clearTimeout(state.imageRunTimer);
  state.imageRunTimer = setTimeout(async () => {
    try {
      const response = await fetch(`/api/image-runs/${encodeURIComponent(id)}`);
      const data = await response.json();
      if (data.ok) {
        if (!imageRunMatchesCurrentProject(data.job)) return;
        const previousCompleted = state.lastImageRun?.id === data.job.id
          ? Number(state.lastImageRun.completedItems || 0)
          : 0;
        state.lastImageRun = data.job;
        renderImageRun();
        updateRevisionGate(state.project);
        if (Number(data.job.completedItems || 0) > previousCompleted) {
          await refreshProjectFromDisk().catch(() => {});
        }
        if (["queued", "running"].includes(data.job.status)) {
          pollImageRun(id);
        } else if (data.job.status === "completed") {
          setImageActionStatus("本地 Codex 图片任务完成，已刷新项目。", "good");
          await refreshProjectFromDisk();
        } else if (data.job.status === "failed") {
          setImageActionStatus(`图片任务失败：${data.job.error || "unknown"}`, "bad");
        }
      }
    } catch {
      pollImageRun(id);
    }
  }, 1400);
}

function renderImageRun() {
  const job = state.lastImageRun;
  if (!job || !imageRunMatchesCurrentProject(job)) {
    els.imageRunView.innerHTML = "";
    return;
  }
  const tone = job.status === "completed" ? "good" : job.status === "failed" ? "bad" : "warn";
  const generated = (job.generated || []).map((item) => `${item.type}:${item.id}`).join(", ");
  const itemLabel = job.item ? `${job.item.type}:${job.item.id}` : "";
  const countLabel = job.totalItems ? `${job.completedItems || 0}/${job.totalItems}` : "";
  const progressValue = job.totalItems
    ? Math.floor((100 * Number(job.completedItems || 0)) / Math.max(1, Number(job.totalItems || 1)))
    : Number(job.progress || 0);
  const elapsedLabel = job.elapsedSeconds
    ? formatDuration(job.elapsedSeconds)
    : job.currentItemStartedAt
      ? formatDuration(Math.max(0, Math.round((Date.now() - Date.parse(job.currentItemStartedAt)) / 1000)))
      : "";
  const heartbeatLabel = job.heartbeatAt || job.updatedAt ? timeAgo(job.heartbeatAt || job.updatedAt) : "";
  const canPause = ["queued", "running"].includes(job.status);
  const canResume = ["paused", "failed"].includes(job.status) && job.projectPath;
  els.imageRunView.innerHTML = `
    <div class="image-run-card">
      <div class="status-line">
        <span class="pill" data-tone="${tone}">${escapeHtml(job.status || "queued")}</span>
        <span class="pill">${escapeHtml(job.provider || "provider")}</span>
        ${job.mode ? `<span class="pill">${escapeHtml(job.mode)}</span>` : ""}
        <span class="pill">${escapeHtml(`${progressValue}%`)}</span>
      </div>
      <strong>${escapeHtml(job.id)}</strong>
      <div class="run-progress"><span style="width:${Math.max(0, Math.min(100, progressValue))}%"></span></div>
      <span>${escapeHtml(job.stage || "")}</span>
      ${countLabel ? `<span>进度：${escapeHtml(countLabel)}</span>` : ""}
      ${elapsedLabel ? `<span>当前耗时：${escapeHtml(elapsedLabel)}</span>` : ""}
      ${heartbeatLabel ? `<span>最后更新：${escapeHtml(heartbeatLabel)}</span>` : ""}
      ${itemLabel ? `<span>队列：${escapeHtml(itemLabel)}</span>` : ""}
      ${generated ? `<span>产物：${escapeHtml(generated)}</span>` : ""}
      ${job.error ? `<span class="run-error">${escapeHtml(job.error)}</span>` : ""}
      ${(canPause || canResume) ? `<div class="run-actions">
        ${canPause ? `<button type="button" data-image-run-action="pause" data-run-id="${escapeHtml(job.id)}">暂停画图</button>` : ""}
        ${canResume ? `<button type="button" data-image-run-action="resume" data-run-id="${escapeHtml(job.id)}">继续绘制</button>` : ""}
      </div>` : ""}
    </div>`;
}

function renderBookRun() {
  const job = state.lastBookRun;
  if (!job) {
    els.bookRunView.innerHTML = "";
    return;
  }
  const tone = job.status === "ready_for_revision" ? "good" : job.status === "failed" ? "bad" : "warn";
  const countLabel = job.totalItems ? `${job.completedItems || 0}/${job.totalItems}` : "";
  const importDetails = bookRunImportDetails(job);
  const heartbeatLabel = job.heartbeatAt || job.updatedAt ? timeAgo(job.heartbeatAt || job.updatedAt) : "";
  els.bookRunView.innerHTML = `
    <div class="image-run-card">
      <div class="status-line">
        <span class="pill" data-tone="${tone}">${escapeHtml(job.status || "queued")}</span>
        <span class="pill">${escapeHtml(job.phase || "import")}</span>
        <span class="pill">${escapeHtml(`${job.progress || 0}%`)}</span>
      </div>
      <strong>${escapeHtml(job.title || job.id)}</strong>
      <div class="run-progress"><span style="width:${Math.max(0, Math.min(100, Number(job.progress || 0)))}%"></span></div>
      <span>${escapeHtml(job.stage || "")}</span>
      ${countLabel ? `<span>绘制：${escapeHtml(countLabel)}</span>` : ""}
      ${importDetails ? `<span>导入：${escapeHtml(importDetails)}</span>` : ""}
      ${heartbeatLabel ? `<span>最后更新：${escapeHtml(heartbeatLabel)}</span>` : ""}
      ${job.projectPath ? `<span>项目：${escapeHtml(job.projectPath)}</span>` : ""}
      ${job.imageRunId ? `<span>图片任务：${escapeHtml(job.imageRunId)}</span>` : ""}
      ${job.error ? `<span class="run-error">${escapeHtml(job.error)}</span>` : ""}
    </div>`;
}

function renderBookRunMessage(message, tone = "") {
  els.bookRunView.innerHTML = `<div class="mini-status" data-tone="${escapeHtml(tone)}">${escapeHtml(message)}</div>`;
}

function bookRunImportDetails(job) {
  const progress = job.importProgress || {};
  const parts = [];
  if (job.phase === "planning" && job.pagePlanTotalChapters) {
    parts.push(`页数规划 ${job.pagePlanCompletedChapters || 0}/${job.pagePlanTotalChapters} 章`);
    if (job.pagePlanShardCount) parts.push(`${job.pagePlanShardCount} shards`);
    if (job.pagePlanConcurrency) parts.push(`并行 ${job.pagePlanConcurrency}`);
  }
  if (progress.engine) parts.push(progress.engine);
  if (progress.cacheStatus === "hit") parts.push("cache hit");
  if (progress.cacheStatus === "miss") parts.push("cache miss");
  if (progress.cacheStatus === "checking") parts.push("checking cache");
  if (progress.processedPages && progress.pageCount) {
    parts.push(`${progress.processedPages}/${progress.pageCount} 页`);
  } else if (progress.pageCount) {
    parts.push(`${progress.pageCount} 页`);
  }
  if (progress.recognition) parts.push(progress.recognition);
  if (progress.scale) parts.push(`scale ${progress.scale}`);
  if (progress.elapsedSeconds) parts.push(formatDuration(progress.elapsedSeconds));
  if (progress.sourceSizeMB) parts.push(`${progress.sourceSizeMB}MB`);
  if (progress.mineruFileCount) parts.push(`MinerU ${progress.mineruFileCount} files`);
  if (!parts.length && job.ingestOptions?.pdfEngine) parts.push(job.ingestOptions.pdfEngine);
  return parts.join(" · ");
}

async function refreshProjectFromDisk() {
  if (!state.projectPath) return;
  const separator = state.projectPath.includes("?") ? "&" : "?";
  const response = await fetch(`${state.projectPath}${separator}t=${Date.now()}`);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const project = await response.json();
  const base = new URL(state.projectPath, window.location.href);
  base.pathname = base.pathname.replace(/[^/]+$/, "");
  setProject(project, base.pathname, state.projectPath);
}

function setImageActionBusy(isBusy) {
  els.copyNextPromptButton.disabled = isBusy;
  els.importLatestImageButton.disabled = isBusy;
  els.generateApiImageButton.disabled = isBusy;
  els.generateFullBookButton.disabled = isBusy;
}

function setImportBusy(isBusy) {
  state.importBusy = Boolean(isBusy);
  els.importAutoButton.disabled = isBusy;
}

function isRevisionLocked(project = state.project) {
  const imageJob = imageRunMatchesCurrentProject(state.lastImageRun) ? state.lastImageRun : null;
  const bookJob = state.lastBookRun;
  if (["queued", "running"].includes(imageJob?.status)) return true;
  if (["queued", "running", "drawing"].includes(bookJob?.status)) return true;
  const queuePending = summarize(project || fallbackProject).queuePending;
  return queuePending > 0;
}

function updateRevisionGate(project = state.project) {
  const locked = isRevisionLocked(project);
  els.openChangeButton.disabled = locked;
  els.openChangeButton.title = locked ? "整本绘制完成后再修改" : "";
  els.submitChangeButton.disabled = locked || state.changeBusy;
  els.planChangeButton.disabled = locked || state.changeBusy;
  els.runChangeButton.disabled = locked || state.changeBusy;
}

function setImageActionStatus(message, tone = "") {
  els.imageActionStatus.textContent = message || "";
  els.imageActionStatus.dataset.tone = tone;
}

function renderExports(project) {
  const exports = project.exports || {};
  const links = [
    ["阅读", exports.readerHtml],
    ["审稿", exports.studioHtml],
    ["打印", exports.printHtml],
    ["PDF", exports.reviewPdf],
    ["EPUB", exports.epub],
  ].filter(([, href]) => href);
  if (!links.length) {
    els.exportsView.innerHTML = `<div class="empty-state">还没有导出文件。点击“导出绘本”生成阅读版、打印版、PDF 和 EPUB。</div>`;
    return;
  }
  els.exportsView.innerHTML = links.map(([label, href]) => `
    <a class="export-link" href="${escapeHtml(resolveAsset(href))}" target="_blank" rel="noreferrer">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(href)}</span>
      <span>打开</span>
    </a>
  `).join("");
}

async function exportBook() {
  if (!state.projectPath) {
    setExportStatus("当前项目不是本地服务路径，不能导出。", "bad");
    return;
  }
  setExportBusy(true);
  setExportStatus("正在导出绘本...", "warn");
  try {
    const response = await fetch("/api/exports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath: state.projectPath }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || response.statusText);
    await refreshProjectFromDisk();
    setExportStatus("导出完成：已刷新阅读版、打印版、PDF 和 EPUB。", "good");
  } catch (error) {
    setExportStatus(`导出失败：${error.message}`, "bad");
  } finally {
    setExportBusy(false);
  }
}

async function convertCaptionsLanguage() {
  if (!state.projectPath) {
    setExportStatus("当前项目不是本地服务路径，不能修改字幕。", "bad");
    return;
  }
  const languageMode = els.captionModeInput.value || "zh-en";
  setExportBusy(true);
  setExportStatus(`${captionModeLabel(languageMode)} 字幕处理中；只刷新字幕和导出，不重画图片...`, "warn");
  try {
    const response = await fetch("/api/captions/language", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: state.projectPath,
        languageMode,
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || response.statusText);
    await refreshProjectFromDisk();
    const translated = data.localization?.translatedCount ?? 0;
    const pending = data.localization?.pendingCount ?? data.captions?.pendingCaptionCount ?? 0;
    const imageNote = data.imagesUnchanged ? "图片未改动" : "请复核图片状态";
    const tone = pending || !data.imagesUnchanged ? "warn" : "good";
    setExportStatus(`字幕已更新：${translated} 条翻译，${pending} 条待补；${imageNote}。`, tone);
  } catch (error) {
    setExportStatus(`字幕修改失败：${error.message}`, "bad");
  } finally {
    setExportBusy(false);
  }
}

function setExportBusy(isBusy) {
  state.exportBusy = isBusy;
  els.convertCaptionsButton.disabled = isBusy || !state.projectPath;
  els.exportBookButton.disabled = isBusy || !state.projectPath;
}

function setExportStatus(message, tone = "") {
  els.exportStatus.textContent = message || "";
  els.exportStatus.dataset.tone = tone;
}

function renderChangeRequest() {
  const request = state.lastChangeRequest;
  if (!request) {
    els.changeRequestView.innerHTML = `<div class="empty-state">还没有修改请求。</div>`;
    return;
  }
  const statusTone = request.status === "completed" ? "good" : request.status === "failed" ? "bad" : "warn";
  const busy = ["running", "planning", "snapshotting"].includes(request.status);
  els.changeRequestView.innerHTML = `
    <div class="change-card">
      <div class="status-line">
        <span class="pill" data-tone="${statusTone}">${escapeHtml(request.status || "queued")}</span>
        <span class="pill">${escapeHtml(request.target || "overall")}</span>
        ${request.context?.spread?.id ? `<span class="pill">${escapeHtml(request.context.spread.id)}</span>` : ""}
      </div>
      <strong>${escapeHtml(request.id)}</strong>
      <span>${escapeHtml(request.feedback || "")}</span>
      ${request.snapshotPath ? `<span>快照：${escapeHtml(request.snapshotPath)}</span>` : ""}
      ${request.planText ? `<details class="request-details" open><summary>修改计划</summary><pre>${escapeHtml(request.planText)}</pre></details>` : ""}
      ${request.logTail ? `<details class="request-details"><summary>运行日志</summary><pre>${escapeHtml(request.logTail)}</pre></details>` : ""}
      <pre class="command small-command">${escapeHtml(request.codexCommand || "")}</pre>
      <div class="inline-actions">
        <button type="button" data-action="copy-change-command">复制 Codex 命令</button>
        <button type="button" data-action="plan-change-request" ${busy ? "disabled" : ""}>生成计划</button>
        <button type="button" data-action="run-change-request" ${busy ? "disabled" : ""}>执行修改</button>
      </div>
    </div>`;
  els.changeRequestView.querySelector("[data-action='copy-change-command']")?.addEventListener("click", () => copyText(request.codexCommand || ""));
  els.changeRequestView.querySelector("[data-action='plan-change-request']")?.addEventListener("click", () => planChangeRequest(request.id));
  els.changeRequestView.querySelector("[data-action='run-change-request']")?.addEventListener("click", () => runChangeRequest(request.id));
}

function renderPageAudit(project) {
  const pages = project.book?.source?.pageAudit?.pages || [];
  if (!pages.length) {
    els.pageAuditView.innerHTML = `<div class="empty-state">没有页面审计。</div>`;
    return;
  }
  els.pageAuditView.innerHTML = pages.slice(0, 14).map((page) => `
    <div class="audit-row" data-status="${escapeHtml(page.status || "ok")}" title="${escapeHtml(page.textPreview || "")}">
      <strong>p${escapeHtml(page.pageNumber)}</strong>
      <span>${escapeHtml(`${page.charCount || 0} chars · ${page.blockCount || 0} blocks · ${page.bboxCount || 0} bbox`)}</span>
      <span>${escapeHtml((page.warnings || []).slice(0, 2).join(",") || "ok")}</span>
    </div>
  `).join("");
}

function openChangeDialog(context = null) {
  if (isRevisionLocked(state.project)) {
    renderBookRunMessage("整本绘制完成后再开放修改。", "warn");
    return;
  }
  const project = state.project || fallbackProject;
  state.changeContext = context;
  els.changeProjectLabel.textContent = [
    project.book?.title || "未命名",
    context?.spread?.id ? `页面 ${context.spread.id}` : null,
    state.projectPath || "未保存路径",
  ].filter(Boolean).join(" · ");
  if (context?.spread) {
    const characterName = displayCharacterName(context.spread.characterRefs?.[0] || context.spread.characters?.[0], project) || "主角";
    els.changeTargetInput.value = "spread";
    els.changeFeedbackInput.placeholder = `针对 ${context.spread.id} 输入修改意见，例如：画面改成雨夜、更突出 ${characterName}、保持水彩纸纹理。`;
  } else {
    els.changeTargetInput.value = "overall";
    const characterName = displayCharacterName(project.characters?.[0]?.id, project) || "主角";
    els.changeFeedbackInput.placeholder = `例如：第三章节奏太快，把第 2 页改成夜晚场景；${characterName} 的人物外观要保持一致；画图提示词增加水彩纸纹理。`;
  }
  els.changeDialogStatus.textContent = "";
  if (typeof els.changeDialog.showModal === "function") {
    els.changeDialog.showModal();
  }
}

async function submitChangeRequest({ action }) {
  const feedback = els.changeFeedbackInput.value.trim();
  if (!feedback) {
    els.changeDialogStatus.textContent = "请先输入修改意见。";
    return;
  }
  setChangeBusy(true);
  els.changeDialogStatus.textContent = action === "run" ? "正在提交并调用 Codex..." : action === "plan" ? "正在生成修改计划..." : "正在提交修改请求...";
  try {
    const response = await fetch("/api/change-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: state.projectPath,
        projectTitle: state.project?.book?.title || "",
        target: els.changeTargetInput.value,
        selectedChapter: els.chapterFilter.value || "all",
        feedback,
        context: state.changeContext,
        sourceUrl: window.location.href,
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || response.statusText);
    state.lastChangeRequest = data.request;
    renderChangeRequest();
    els.changeDialogStatus.textContent = `已提交：${data.request.id}`;
    if (action === "plan") await planChangeRequest(data.request.id);
    if (action === "run") await runChangeRequest(data.request.id);
  } catch (error) {
    els.changeDialogStatus.textContent = `提交失败：${error.message}`;
  } finally {
    setChangeBusy(false);
  }
}

async function planChangeRequest(id) {
  if (!id) return;
  setChangeBusy(true);
  try {
    const response = await fetch(`/api/change-requests/${encodeURIComponent(id)}/plan`, { method: "POST" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || response.statusText);
    state.lastChangeRequest = data.request;
    renderChangeRequest();
    pollChangeRequest(id);
  } catch (error) {
    els.changeDialogStatus.textContent = `计划失败：${error.message}`;
  } finally {
    setChangeBusy(false);
  }
}

async function runChangeRequest(id) {
  if (!id) return;
  setChangeBusy(true);
  try {
    const response = await fetch(`/api/change-requests/${encodeURIComponent(id)}/run`, { method: "POST" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || response.statusText);
    state.lastChangeRequest = data.request;
    renderChangeRequest();
    pollChangeRequest(id);
  } catch (error) {
    els.changeDialogStatus.textContent = `调用失败：${error.message}`;
  } finally {
    setChangeBusy(false);
  }
}

function pollChangeRequest(id) {
  clearTimeout(state.statusTimer);
  state.statusTimer = setTimeout(async () => {
    try {
      const response = await fetch(`/api/change-requests/${encodeURIComponent(id)}`);
      const data = await response.json();
      if (data.ok) {
        state.lastChangeRequest = data.request;
        renderChangeRequest();
        if (["running", "planning", "queued", "snapshotting"].includes(data.request.status)) {
          pollChangeRequest(id);
        }
      }
    } catch {
      pollChangeRequest(id);
    }
  }, 1800);
}

function setChangeBusy(isBusy) {
  state.changeBusy = isBusy;
  const locked = isRevisionLocked(state.project);
  els.submitChangeButton.disabled = isBusy || locked;
  els.planChangeButton.disabled = isBusy || locked;
  els.runChangeButton.disabled = isBusy || locked;
}

async function loadLatestChangeRequest() {
  try {
    const response = await fetch("/api/change-requests");
    const data = await response.json();
    if (data.ok && data.requests?.length) {
      state.lastChangeRequest = data.requests[0];
      renderChangeRequest();
    }
  } catch {
    // The static page can still work without the local API.
  }
}

function findSpreadContext(chapterId, spreadId) {
  const project = state.project || fallbackProject;
  const chapter = (project.chapters || []).find((item) => item.id === chapterId);
  const spread = (chapter?.spreads || []).find((item) => item.id === spreadId);
  if (!chapter || !spread) return null;
  return {
    type: "spread",
    chapterId: chapter.id,
    spreadId: spread.id,
    chapter: {
      id: chapter.id,
      title: chapter.title,
      summary: chapter.summary,
    },
    spread: {
      id: spread.id,
      readerCaption: spread.readerCaption,
      caption: spread.caption,
      visualIntent: spread.visualIntent,
      prompt: spread.prompt,
      image: spread.image,
      characters: spread.characters,
    },
  };
}

function renderCommands() {
  const source = els.sourceInput.value.trim() || "~/Books/story.pdf";
  const out = els.outInput.value.trim() || "runs/story";
  const title = els.titleInput.value.trim();
  const engine = els.pdfEngineInput.value;
  const languageMode = els.langInput.value;
  const spreads = spreadsPlanValue();
  const titlePart = title ? ` --title ${quote(title)}` : "";
  const isPdf = /\.pdf(?:$|[?#])/i.test(source);
  const pdfPart = isPdf ? ` --pdf-engine ${engine}` : "";
  const ocrPreset = els.ocrPresetInput.value;
  const ocrMaxPages = ocrMaxPagesValue();
  const ocrTuningPart = isPdf
    ? ` --ocr-recognition ${ocrRecognitionForPreset(ocrPreset)} --ocr-scale ${ocrScaleForPreset(ocrPreset)}${ocrMaxPages ? ` --ocr-max-pages ${ocrMaxPages}` : ""}`
    : "";
  const languagePart = languageMode && languageMode !== "auto" ? ` --language ${languageMode}` : "";
  const ocrLanguage = ocrLanguageForMode(languageMode);
  const langPart = isPdf && ocrLanguage ? ` --mineru-lang ${ocrLanguage}` : "";
  els.createCommand.textContent = `node apps/cli/index.js create ${quote(source)} --out ${quote(out)}${titlePart}${languagePart}${pdfPart}${ocrTuningPart}${langPart} --spreads-per-chapter ${spreads} --image-provider codex-local`;
  const config = state.modelConfig || defaultModelConfigForProvider("local-codex");
  const apiImageLine = config.provider === "openai"
    ? `${config.apiKeyEnv || "OPENAI_API_KEY"}=... node apps/cli/index.js generate-openai ${quote(out)} --limit 1${config.imageModel ? ` --model ${quote(config.imageModel)}` : ""}`
    : "";
  els.queueCommand.textContent = [
    `# 网页中的“导入并自动绘制整本”会创建 book-run，并顺序调用本地 Codex 画完整本。`,
    config.provider !== "local-codex" ? `# 当前大模型连接：${modelProviderLabel(config.provider)} · 文本 ${config.textModel || "model"} · 密钥环境变量 ${config.apiKeyEnv || "API_KEY"}` : `# 当前大模型连接：本地 Codex`,
    `node apps/cli/index.js codex-jobs ${quote(out)} --limit 6`,
    apiImageLine,
    `node apps/cli/index.js export ${quote(out)}`,
  ].filter(Boolean).join("\n");
}

function updateCaptionModeButton() {
  els.convertCaptionsButton.textContent = els.captionModeInput.value === "zh-en"
    ? "字幕改成中英"
    : "仅改字幕";
}

function summarize(project) {
  const chapters = project.chapters || [];
  const spreads = chapters.flatMap((chapter) => chapter.spreads || []);
  const readyImages = spreads.filter((spread) => spread.image?.status === "ready").length;
  const queue = project.assets?.codexImageQueue || {};
  const source = project.book?.source || {};
  const quality = source.importQuality || {};
  return {
    source: `${source.format || project.book?.originalStats?.sourceFormat || "source"} via ${source.extractionMethod || project.book?.originalStats?.extractionMethod || "n/a"}`,
    quality: quality.score === undefined ? "n/a" : `${quality.score}/${quality.level || "?"}`,
    chapterCount: chapters.length,
    spreadCount: spreads.length,
    readyImages,
    language: languageLabel(project.book?.languageProfile || project.book?.language || "auto"),
    pagePlan: pagePlanLabel(project.book?.pagePlan),
    queuePending: queue.pendingCount || queueItems(project).filter((item) => item.status !== "ready").length,
  };
}

function queueItems(project) {
  const queuePathItems = project.assets?.codexImageQueue?.items;
  if (Array.isArray(queuePathItems)) return queuePathItems;
  const characters = (project.assets?.characterReferences?.items || []).map((item) => ({
    type: "character",
    id: item.id,
    title: item.name,
    status: item.status,
  }));
  const spreads = (project.assets?.images || []).filter((item) => item.status !== "ready").map((item) => ({
    type: "spread",
    id: item.id,
    title: item.id,
    status: item.status,
  }));
  return [...characters, ...spreads];
}

function syncInputsFromProject(project, projectPath) {
  const projectDir = projectDirFromPath(projectPath);
  const sourceFile = project.book?.sourceFile || "";
  if (sourceFile) els.sourceInput.value = sourceFile;
  if (projectDir) els.outInput.value = projectDir;
  if (project.book?.title) els.titleInput.value = project.book.title;
  const spreadsPerChapter = inferSpreadsPerChapter(project);
  if (spreadsPerChapter) els.spreadsInput.value = String(spreadsPerChapter);
  const languageMode = languageModeFromProject(project);
  if ([...els.langInput.options].some((option) => option.value === languageMode)) {
    els.langInput.value = languageMode;
  }
}

function projectDirFromPath(projectPath) {
  const text = String(projectPath || "");
  if (!text) return "";
  const withoutQuery = text.split(/[?#]/)[0];
  return withoutQuery.replace(/\/?bookframes\.json$/i, "").replace(/^\//, "") || "";
}

function clearMismatchedImageRun() {
  if (state.lastImageRun && !imageRunMatchesCurrentProject(state.lastImageRun)) {
    state.lastImageRun = null;
  }
}

function imageRunMatchesCurrentProject(job) {
  if (!job || !state.projectPath) return false;
  return sameProjectPath(job.projectPath, state.projectPath);
}

function bookRunMatchesCurrentProject(job) {
  if (!job || !state.projectPath) return false;
  return sameProjectPath(job.projectPath, state.projectPath);
}

function sameProjectPath(left, right) {
  return Boolean(left && right) && normalizeProjectPath(left) === normalizeProjectPath(right);
}

function normalizeProjectPath(value) {
  return String(value || "").split(/[?#]/)[0].replace(/^\//, "");
}

function displayWorkspacePath(value) {
  const text = String(value || "");
  const marker = "/bookframes/";
  const index = text.indexOf(marker);
  return index >= 0 ? text.slice(index + marker.length) : text;
}

function ocrLanguageForMode(mode) {
  const languages = String(mode || "")
    .split(/[-+,/]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const primary = languages[0] || "";
  if (primary === "zh") return "ch";
  if (primary === "ja") return "japan";
  if (primary === "en") return "en";
  return "";
}

function ocrRecognitionForPreset(preset) {
  return preset === "balanced" || preset === "accurate" ? "accurate" : "fast";
}

function ocrScaleForPreset(preset) {
  if (preset === "accurate") return "2";
  if (preset === "balanced") return "1.5";
  return "1.25";
}

function ocrMaxPagesValue() {
  const value = Number(els.ocrMaxPagesInput.value || 0);
  return Number.isFinite(value) && value > 0 ? String(Math.floor(value)) : "";
}

function spreadsPlanValue() {
  const raw = String(els.spreadsInput.value || "").trim().toLowerCase();
  if (!raw || FULL_COVERAGE_PLAN_VALUES.has(raw)) {
    return "full-coverage";
  }
  if (AUTO_SPREAD_PLAN_VALUES.has(raw)) {
    return "codex-auto";
  }
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return "full-coverage";
  return String(Math.min(8, Math.max(1, Math.round(numeric))));
}

function languageModeFromProject(project) {
  const profile = project.book?.languageProfile || {};
  if (profile.bilingual && profile.primary && profile.secondary) {
    return `${profile.primary}-${profile.secondary}`;
  }
  const language = profile.primary || project.book?.language || "auto";
  if (language === "ch") return "zh";
  if (["zh", "ja", "en"].includes(language)) return language;
  return "auto";
}

function pagePlanLabel(pagePlan) {
  if (!pagePlan || typeof pagePlan !== "object") return "codex-auto";
  const mode = pagePlan.mode || "plan";
  const provider = pagePlan.provider ? `/${pagePlan.provider}` : "";
  const total = pagePlan.totalSpreadCount ? ` · ${pagePlan.totalSpreadCount} 页` : "";
  return `${mode}${provider}${total}`;
}

function languageLabel(value) {
  if (value && typeof value === "object") {
    if (value.bilingual && value.primary && value.secondary) {
      return `${languageName(value.primary)} + ${languageName(value.secondary)}`;
    }
    return languageName(value.primary || value.language || "auto");
  }
  const mode = String(value || "auto");
  if (mode.includes("-")) {
    return mode.split("-").map(languageName).join(" + ");
  }
  return languageName(mode);
}

function languageName(code) {
  return {
    ch: "中文",
    zh: "中文",
    ja: "日本語",
    en: "English",
    auto: "自动",
  }[code] || code || "自动";
}

function captionModeLabel(mode) {
  return String(mode || "zh-en").split(/[-+,/]/).map(languageName).join(" + ");
}

function titleFromFilename(filename) {
  return String(filename || "Story")
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "Story";
}

function inferSpreadsPerChapter(project) {
  const pagePlan = project.book?.pagePlan;
  if (!pagePlan || typeof pagePlan !== "object") return "full-coverage";
  if (pagePlan?.mode === "full-coverage") return "full-coverage";
  if (pagePlan?.mode && pagePlan.mode !== "fixed") return "full-coverage";
  const fixedCount = pagePlan?.chapters?.[0]?.spreadCount;
  if (pagePlan?.mode === "fixed" && fixedCount) return fixedCount;
  return "full-coverage";
}

function displayCharacterName(characterId, project) {
  if (!characterId) return "";
  const match = (project.characters || []).find((character) => character.id === characterId || character.name === characterId);
  return match?.name || String(characterId).replace(/[-_]+/g, " ");
}

function metric(label, value) {
  return `<dl class="metric"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></dl>`;
}

function formatDuration(seconds) {
  const value = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  return minutes ? `${minutes}m ${String(rest).padStart(2, "0")}s` : `${rest}s`;
}

function timeAgo(iso) {
  const timestamp = Date.parse(iso || "");
  if (!timestamp) return "";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 5) return "刚刚";
  if (seconds < 60) return `${seconds}s 前`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s 前`;
}

function arcRow(label, value, tag) {
  return `<div class="arc-row"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value || "n/a")}</span><span>${escapeHtml(tag || "")}</span></div>`;
}

function scoreColor(score) {
  const value = Number(score || 0);
  if (value >= 78) return "var(--green)";
  if (value >= 55) return "var(--gold)";
  return "var(--coral)";
}

function percent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "n/a";
  return `${Math.round(Number(value) * 100)}%`;
}

function quote(value) {
  const text = String(value || "");
  if (/^[A-Za-z0-9_./~:-]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

function resolveAsset(assetPath) {
  if (!assetPath) return "";
  if (/^(https?:|data:|blob:)/.test(assetPath)) return assetPath;
  if (!state.projectBaseUrl) return assetPath;
  return new URL(assetPath, window.location.origin + state.projectBaseUrl).pathname;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

init().catch((error) => {
  setProject({
    ...fallbackProject,
    book: {
      ...fallbackProject.book,
      title: "加载失败",
      source: {
        ...fallbackProject.book.source,
        importQuality: {
          score: 0,
          level: "error",
          recommendations: [error.message],
        },
      },
    },
  }, "", "");
});
