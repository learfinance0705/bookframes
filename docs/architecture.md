# BookFrames Architecture Notes

BookFrames borrows HyperFrames' strongest product pattern: authorship is a deterministic project graph, not a single opaque generation call.

## HyperFrames Concept Mapping

| HyperFrames | BookFrames |
| --- | --- |
| Composition HTML | `bookframes.json` manifest plus rendered preview |
| Clips and nested compositions | Chapters and spreads |
| `data-composition-variables` | Style bible, character bible, spread variables |
| CLI lint/inspect/render | `bookframes lint`, `bookframes inspect`, `bookframes render` |
| Producer | Pipeline that ingests, plans, draws, lays out, and exports |
| Studio | Chapter/spread/prompt/image review workspace |
| Registry blocks | Layout templates and illustration style presets |

## Pipeline Contract

```txt
source book
  -> ingest text/PDF/OCR with source anchors and import evidence
  -> plan full-coverage picture-book spreads
  -> create image prompts and layout choices
  -> generate, pause, resume, or reuse image assets
  -> render static preview / export formats
  -> lint and inspect outputs
```

Every step should be restartable. A failed or paused image generation should not require re-splitting the book. A prompt edit should regenerate one spread, not the entire project.

## Ingest Boundary

`packages/ingest` normalizes every source into the same contract: extracted text, chapter records, source metadata, and stats. Text and Markdown use direct UTF-8 reads. PDF first tries native text extraction through `pypdf`; if the PDF looks like a scan, `--ocr auto` can route to MinerU automatically when the local model is available, otherwise it falls back to macOS Vision OCR. For high-precision imports, `--pdf-engine mineru-vlm` and `--pdf-engine mineru-hybrid` run MinerU's local VLM/hybrid backends and preserve MinerU artifacts under `source/mineru/`. The pipeline writes `source/extracted.txt`, `source/ingest-report.json`, `source/page-audit.json`, `source/import-quality.json`, and `source/chapter-map.json` so chapter splitting and prompt grounding can be audited after import.

OCR modes:

- `auto`: OCR only when native PDF text is empty or suspiciously sparse.
- `always`: OCR even when searchable text exists.
- `never`: keep native PDF text only and report sparse-text warnings.

PDF engines:

- `auto`: pypdf/Spotlight first, then MinerU for weak native text when available, then macOS Vision OCR as fallback.
- `native`: pypdf/Spotlight only, no MinerU.
- `mineru-pipeline`: MinerU's faster pipeline backend.
- `mineru-vlm`: MinerU's VLM backend for difficult scans and layouts.
- `mineru-hybrid`: MinerU's hybrid backend, the preferred high-precision default after VLM weights are installed.

## Provider Boundary

`packages/image` intentionally exposes a provider-shaped function. The placeholder provider writes SVGs so the rest of the system can be developed without waiting on image model wiring. The `codex-local` provider writes prompt jobs for Codex's built-in image tool, then imports generated files from the local filesystem.

Codex-local flow:

```txt
bookframes render --image-provider codex-local
  -> writes character reference prompts and assets/codex-image-jobs/<spread-id>.md
  -> writes assets/codex-image-jobs/queue.json with character references before spreads
  -> user/Codex runs built-in image generation
  -> generated image lands under $HOME/.codex/generated_images
  -> bookframes import-image, import-latest, or import-queue copies it to assets/images
  -> manifest and preview are regenerated
```

Any real provider should preserve these fields on every spread:

- `image.provider`
- `image.assetPath`
- `image.promptHash`
- `image.generatedAt`
- `image.status`

## Traceability Rule

Every chapter and spread keeps `sourceAnchors`. This is the guardrail against a pretty but ungrounded adaptation. Future LLM planners should cite source ranges and preserve enough text evidence for review.
