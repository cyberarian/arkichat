# digup-js

A Node.js rebuild of [ARahim3/DigUp](https://github.com/ARahim3/DigUp): search your files by what's in them. Text, PDFs, images, recordings, video and code, on-device.

Built from the original's README (its source wasn't readable), so the architecture follows it but the code is new. No Swift, Tauri or native add-ons: Node 22.13+, `node:sqlite`, and CLI tools you probably have (`ffmpeg`, poppler's `pdftotext`/`pdfinfo`/`pdftoppm`).

> In Arki Chat, `digup.js` uses Ollama's `embeddinggemma-2` automatically (text embeddings). The llama.cpp setup below still works when you prefer it.

## Quick start
```bash
npm install
export DIGUP_MODEL=/path/to/embeddinggemma-2-q8_0.gguf      # + DIGUP_MMPROJ=/path/to/mmproj.gguf for images/audio
export DIGUP_LLAMA_SERVER=/path/to/llama-server              # or run llama-server --embeddings yourself and set DIGUP_EMBED_URL
node src/cli.js add ~/Documents
node src/cli.js add ~/Projects --code                        # opt in to code search for this folder
node src/cli.js index
node src/cli.js search "the clause about pets in the lease"
node src/cli.js search "code: retry a failed call with backoff"
node src/cli.js serve                                        # search panel at http://127.0.0.1:7777 (also watches for changes)
```
Try it with no model: `DIGUP_EMBEDDER=hash` (text only, lexical stand-in).

## How it maps to the original
| DigUp | here |
|---|---|
| EmbeddingGemma 2 via llama.cpp helper process that quits when done | `LlamaEmbedder` spawns `llama-server`, stops it after `index`/`search` |
| One SQLite file: vector per page/passage/frame/30 s sound + keyword index | `node:sqlite`, `chunks` table + FTS5 |
| Nearest vectors + exact-word boost | cosine over a normalized matrix + `bm25` boost (`src/search.js`) |
| PDFs: first 30 pages now, rest later (≤5000) | `readPdf` + `finishPending`; scanned pages are rendered and embedded as images |
| Audio: overlapping 30 s windows; video: frames + soundtrack | `ffmpeg` (`readers.js`); 30 s windows / 20 s stride, frame every ≥5 s |
| Docs: txt md rtf docx odt html; numeric text exact-match only | `readDoc`, `mostlyNumbers` |
| Code search off by default, `code:` prefix, own index, git-ignore aware | `add --code`, `scope='code'`, `git ls-files` |
| Never reads keys, hidden dirs, apps, caches, cloud-only files; code projects → screenshots only | `scanner.js` |
| Menubar app, preview, open at page/moment | local web panel (`serve`); `search --open` uses mpv/VLC at the moment |

## Not done / unverified
- **Image and audio embedding call llama-server's multimodal `/embedding` endpoint (`multimodal_data`) from memory.** I couldn't run EmbeddingGemma 2 here, so only the text path and the pipeline (PDF, docx, video/audio extraction, FTS, incremental indexing) were tested. Check the request shape against your llama.cpp build.
- Query/document task prefixes (`DIGUP_QUERY_PREFIX`) and model/mmproj file names are yours to set.
- Not ported: OCR of screenshots, HEIC/RAW/SVG/legacy `.doc`, global hotkey/tray, auto-update, GPU probing (llama.cpp does its own via `DIGUP_LLAMA_ARGS`).
- Search is brute-force cosine in memory: fine to ~hundreds of thousands of chunks; beyond that you'd want an ANN index.

## Arki sidebar integration

The sidebar exposes folder management, explicit code opt-in, index progress and recovery,
full result paths, and keyboard navigation. Search responses use a generation guard so an
older request cannot replace a newer result or reopen a cleared query.

These interaction patterns were compared with upstream DigUp at
[`d6f1f480`](https://github.com/ARahim3/DigUp/tree/d6f1f480427d151640196e4d6588906e1f3ee782)
(October 22, 2026), particularly
[search rendering and request generations](https://github.com/ARahim3/DigUp/blob/d6f1f480427d151640196e4d6588906e1f3ee782/shell/ui/panel.js)
and [folder settings and progress](https://github.com/ARahim3/DigUp/blob/d6f1f480427d151640196e4d6588906e1f3ee782/shell/ui/settings.js).
This remains an independent JavaScript implementation; upstream's native previews,
OCR, global shortcuts, and opening at the exact page or timestamp are not provided by
the Arki sidebar. Its result button opens the file in the default application.

From the repository root, run `node --test test/digup-ui.test.js` for sidebar regression
tests and `npm test --prefix digup-js` for engine tests.
