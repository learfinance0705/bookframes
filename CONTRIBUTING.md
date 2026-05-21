# Contributing to BookFrames

BookFrames is built around one product promise: turn a source book into an inspectable picture-book project, without hiding the source, planning, prompts, images, or exports behind a single opaque button.

## Local Setup

```bash
npm test
npm run demo
npm run web
```

Open the workbench at:

```txt
http://127.0.0.1:4197/apps/web/
```

## Pull Request Checklist

- Keep generated files under `runs/`, `dist/`, or `tests/tmp/` out of the commit.
- Add or update smoke-test coverage when changing ingest, planning, export, or API behavior.
- Preserve source traceability: every spread should keep usable source anchors or source excerpts.
- Keep image generation restartable. A failed page should not force a full re-import.
- Do not add external service requirements to the default path. Optional providers are welcome, but the demo and workbench should stay runnable locally.

## Product Taste

- Prefer complete-book workflows over sample-only demos.
- Prefer reviewable artifacts over hidden intermediate state.
- Prefer a quiet, dense workbench over a marketing page.
- Prefer explicit warnings over pretending OCR, translation, or image generation was perfect.
