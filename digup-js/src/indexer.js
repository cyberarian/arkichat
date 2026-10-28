import path from 'node:path';
import { scan } from './scanner.js';
import * as R from './readers.js';

const FIRST_PDF_PAGES = 30;

function reader(kind, file, opts = {}) {
  switch (kind) {
    case 'doc': return R.readDoc(file);
    case 'code': return R.readCode(file);
    case 'pdf': return R.readPdf(file, opts.from ?? 1, opts.to ?? FIRST_PDF_PAGES);
    case 'image': return R.readImage(file);
    case 'audio': return R.readAudio(file);
    case 'video': return R.readVideo(file);
  }
}

export class Indexer {
  constructor(store, embedder, { log = () => {}, skipEmbedMedia = false } = {}) {
    this.db = store; this.emb = embedder; this.log = log;
  }

  /** Brings one root up to date: new/changed files in, vanished files out. Long PDFs wait for their tail. */
  async indexRoot(rootCfg, cfg = {}) {
    const root = path.resolve(rootCfg.path);
    const known = new Map(this.db.rootFiles(root).map(f => [f.path, f]));
    const seen = new Set(); const todo = [];
    for await (const f of scan(root, { code: !!rootCfg.code, skipDirs: cfg.skipDirs, skipExts: cfg.skipExts })) {
      seen.add(f.path);
      const k = known.get(f.path);
      const mediaUpgrade = !!k && this.emb.media && ['image', 'audio'].includes(f.kind) && !this.db.hasVector(k.id, f.kind);
      if (!k || k.mtime !== f.mtime || k.size !== f.size || mediaUpgrade) todo.push({ ...f, root, mediaUpgrade });
    }
    for (const [p, k] of known) if (!seen.has(p)) this.db.removeFile(k.id);
    let done = 0;
    for (const f of todo) {
      if (f.mediaUpgrade && !this.emb.media) {
        this.log(`[${++done}/${todo.length}] media embedding unavailable; kept ${f.path}`);
        continue;
      }
      this.log(`indexing ${f.path}`);
      try { await this.indexFile(f); } catch (e) { this.log(`skip ${f.path}: ${e.message}`); }
      this.log(`[${++done}/${todo.length}] ${f.path}`);
    }
    return { scanned: seen.size, indexed: todo.length };
  }

  /** Reads the rest of long PDFs, once everything else is in. */
  async finishPending() {
    for (const f of this.db.pendingFiles()) {
      this.log(`finishing PDF ${path.basename(f.path)}`);
      try { await this._pdfTail(f); } catch (e) { this.log(`tail ${f.path}: ${e.message}`); }
    }
  }

  async indexFile(f) {
    const mod = this.db.getFile(f.path);
    const id = this.db.upsertFile({ ...f, pendingFrom: null });
    const name = path.basename(f.path);
    const units = [];
    let next = null;
    for await (const u of reader(f.kind, f.path)) {
      if (u._done) { next = u.nextPage; continue; }
      units.push(u);
    }
    const stored = await this._store(id, f.scope, name, units);
    if (next) this.db.setPending(id, next);
    // files whose content couldn't be embedded still get a filename entry, so exact names keep working
    if (!stored) this.db.addChunk(id, f.scope, name, { mod: 'name', loc: {}, text: name, vec: null });
    return mod ? 'updated' : 'added';
  }

  async _pdfTail(f) {
    const units = []; let next = null, total = 0, lastPage = f.pending_from - 1;
    for await (const u of R.readPdf(f.path, f.pending_from, f.pending_from + 400 - 1, (page, pages) => {
      lastPage = page; total = pages;
      this.log(`PDF ${path.basename(f.path)}: reading page ${page} of ${pages}`);
    })) {
      if (u._done) { next = u.nextPage; total = u.total; } else units.push(u);
    }
    this.log(`PDF ${path.basename(f.path)}: indexing pages ${f.pending_from}–${lastPage} of ${total}`);
    await this._store(f.id, 'general', path.basename(f.path), units);
    this.log(next
      ? `PDF ${path.basename(f.path)}: indexed through page ${lastPage} of ${total}`
      : `PDF ${path.basename(f.path)}: indexed all ${total} pages`);
    this.db.setPending(f.id, next);
    if (next) await this._pdfTail({ ...f, pending_from: next });
  }

  async _store(fileId, scope, name, units) {
    const rows = [];
    // text in batches of 16
    const texts = units.filter(u => u.mod === 'text' || u.mod === 'code');
    for (let i = 0; i < texts.length; i += 16) {
      const batch = texts.slice(i, i + 16);
      const need = batch.filter(u => u.embed !== false);
      const vecs = need.length ? await this.emb.embedTexts(need.map(u => u.text)) : [];
      let j = 0;
      for (const u of batch) rows.push({ mod: u.mod, loc: u.loc, text: u.text, vec: u.embed === false ? null : vecs[j++] });
    }
    for (const u of units.filter(u => u.mod === 'image' || u.mod === 'audio')) {
      const vec = await this.emb.embedMedia(u.mod, u.data);
      if (vec) rows.push({ mod: u.mod, loc: u.loc, text: null, vec });
    }
    this.db.tx(() => { for (const r of rows) this.db.addChunk(fileId, scope, name, r); });
    return rows.length;
  }
}
