<div align="center">

# BookFrames

### Stop making trailers. Make the book.

**BookFrames turns an entire source book into a complete, inspectable picture-book project: pages, prompts, images, bilingual captions, and exports.**

![Actual BookFrames output: generated picture-book spreads](docs/demo/tiny-adventure-contact-sheet.jpg)

**Actual output from the included `Tiny Adventure` demo. Not a mockup.**

[Quick Start](#quick-start) · [Actual Run](#actual-run) · [Why It Spreads](#why-it-spreads) · [Workbench](#workbench)

</div>

## Actual Run

One tiny source story became:

**3 chapters → 9 planned spreads → 9 generated illustrations → character references → Studio review → HTML/PDF/EPUB exports**

| The picture book people notice | The control room editors trust |
| --- | --- |
| ![A generated watercolor picture-book spread from BookFrames](docs/demo/tiny-adventure-spread.jpg) | ![BookFrames Studio showing chapters, images, prompts, characters, and style bible](docs/demo/tiny-adventure-studio.jpg) |

## Why It Spreads

Most AI picture-book tools make a trailer. BookFrames makes the book.

That difference is the hook:

- **Whole-book by default**: `full-coverage` planning is the main path, not an advanced setting.
- **Source-grounded pages**: every spread keeps excerpts and traceability, so the book does not drift into generic vibes.
- **A real editor surface**: import quality, page plan, prompts, characters, image queue, change requests, and exports live in one workbench.
- **Local-first drawing**: no `OPENAI_API_KEY` required for the default Codex-local image flow.
- **Caption-only localization**: switch to `中文 + English` without redrawing images.
- **Restartable long runs**: pause, resume, and skip already completed pages.

The product bet is simple: beautiful output only matters if the whole chain is reviewable.

![BookFrames pipeline overview](docs/bookframes-hero.svg)

## What You Get

```txt
source book
  -> text / PDF / OCR / MinerU import
  -> import audit and chapter map
  -> full-coverage page plan
  -> source-grounded captions and image prompts
  -> local Codex or API image generation
  -> reader HTML, studio HTML, print HTML, review PDF, EPUB
```

Every stage writes files. You can inspect, edit, resume, or replace any part of the pipeline.

## Quick Start

Requires Node.js 20+.

```bash
npm test
npm run demo
npm run web
```

Open:

```txt
http://127.0.0.1:4197/apps/web/
```

The demo creates a tiny local project under `runs/tiny-adventure/`. The `runs/` directory is intentionally ignored by git.

## Create a Book

```bash
node apps/cli/index.js create ~/Books/story.epub \
  --out runs/story \
  --title "Story" \
  --language zh-en \
  --spreads-per-chapter full-coverage
```

Useful commands:

```bash
node apps/cli/index.js lint runs/story
node apps/cli/index.js inspect runs/story
node apps/cli/index.js render runs/story --image-provider codex-local
node apps/cli/index.js codex-jobs runs/story --limit 8
node apps/cli/index.js export runs/story
```

For a scanned or layout-heavy PDF:

```bash
node apps/cli/index.js create ~/Books/scanned.pdf \
  --out runs/scanned-story \
  --pdf-engine mineru-hybrid \
  --mineru-lang ch \
  --language zh-en \
  --spreads-per-chapter full-coverage
```

## Workbench

The workbench is the product surface:

```bash
npm run web
```

Open:

```txt
http://127.0.0.1:4197/apps/web/
```

It supports:

- Uploading EPUB, PDF, TXT, and Markdown book sources.
- Full-coverage import and drawing by default.
- Import-quality review before drawing.
- Chapter and spread inspection.
- Local Codex image queue progress.
- Pause-ready persisted image runs under `runs/_image-runs/`.
- Change requests that write Codex-ready prompts under `runs/_change-requests/`.
- Caption conversion such as `中文 + English` without redrawing images.
- Export refresh for reader, print, PDF, and EPUB.

## Caption-Only Localization

Use the workbench export panel or call the API route:

```txt
POST /api/captions/language
```

BookFrames updates caption localization fields and export artifacts only. Existing `assets/images/` are preserved.

## Local Codex Images

The default local drawing path does not require `OPENAI_API_KEY`.

```bash
node apps/cli/index.js render runs/story --image-provider codex-local
node apps/cli/index.js next-queue-prompt runs/story
node apps/cli/index.js import-queue runs/story --limit 3
```

In the workbench:

- `复制下一张 Prompt` hands the next queue item to the current Codex chat.
- `本地 Codex 生成 1 张` starts a persisted one-page image run.
- `自动绘制整本` starts a persisted full-book image run.

If Codex CLI auth expires, run:

```bash
codex login --device-auth
```

Then start a new full-book image run. Already completed images remain in the project and are skipped.

## Optional API Images

```bash
OPENAI_API_KEY=... node apps/cli/index.js generate-openai runs/story --limit 1
```

The API-backed route remains available for automation, but it is not required for the default local workflow.

## PDF and OCR

PDF engines:

- `auto`: native extraction first, then stronger local paths when needed.
- `native`: searchable PDF text only.
- `mineru-pipeline`: faster MinerU pipeline path.
- `mineru-vlm`: heavy VLM path for difficult scans.
- `mineru-hybrid`: preferred high-precision path when local MinerU is installed.

BookFrames writes these audit artifacts:

- `source/extracted.txt`
- `source/ingest-report.json`
- `source/page-audit.json`
- `source/import-quality.json`
- `source/chapter-map.json`
- `planning/story-arc.json`
- `planning/planning-review.json`
- `planning/character-review.json`

## Project Shape

```txt
apps/cli             agent-friendly commands
apps/web             local browser workbench and API server
packages/core        schema, ids, lint, project IO
packages/ingest      text/PDF/OCR/MinerU import
packages/page-plan   fixed, auto, and full-coverage planning
packages/planner     story, spread, caption, character, prompt planning
packages/image       placeholder and Codex-local image bridge
packages/layout      static reader and studio renderer
packages/export      print HTML, PDF, and EPUB exporter
packages/producer    orchestration pipeline
```

## Design Principles

- Complete books, not teaser decks.
- Inspectable stages, not black boxes.
- Local-first by default.
- Source traceability over generic visual polish.
- Restartable drawing queues.
- Honest warnings when OCR, localization, or generation is weak.

## Repository Hygiene

This repository intentionally ignores:

- `runs/`
- `inputs/`
- `.venv*/`
- uploaded books and generated exports

Keep real books, generated images, local model artifacts, and private run logs out of commits.

## License

MIT
