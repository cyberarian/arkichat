import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// One SQLite file: files, chunks (a vector per picture / page / passage / frame / 30 s of sound)
// plus an FTS5 keyword index. Code lives in its own scope and never shows up in other searches.
export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS files(
      id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, root TEXT NOT NULL,
      kind TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'general',
      mtime INTEGER NOT NULL, size INTEGER NOT NULL,
      pending_from INTEGER                 -- long PDFs: next page still to read
    );
    CREATE TABLE IF NOT EXISTS chunks(
      id INTEGER PRIMARY KEY,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      scope TEXT NOT NULL, mod TEXT NOT NULL, loc TEXT, text TEXT, vec BLOB
    );
    CREATE INDEX IF NOT EXISTS chunks_file ON chunks(file_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
      text, name, tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
  return new Store(db);
}

export class Store {
  constructor(db) {
    this.db = db;
    this.s = {
      getFile: db.prepare('SELECT * FROM files WHERE path = ?'),
      insFile: db.prepare('INSERT INTO files(path,root,kind,scope,mtime,size,pending_from) VALUES(?,?,?,?,?,?,?)'),
      updFile: db.prepare('UPDATE files SET mtime=?, size=?, pending_from=? WHERE id=?'),
      delChunksFts: db.prepare('DELETE FROM fts WHERE rowid IN (SELECT id FROM chunks WHERE file_id = ?)'),
      delChunks: db.prepare('DELETE FROM chunks WHERE file_id = ?'),
      delFile: db.prepare('DELETE FROM files WHERE id = ?'),
      insChunk: db.prepare('INSERT INTO chunks(file_id,scope,mod,loc,text,vec) VALUES(?,?,?,?,?,?)'),
      insFts: db.prepare('INSERT INTO fts(rowid,text,name) VALUES(?,?,?)'),
      filesByRoot: db.prepare('SELECT id,path,mtime,size,pending_from FROM files WHERE root = ?'),
      pending: db.prepare('SELECT * FROM files WHERE pending_from IS NOT NULL'),
      getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
    };
  }
  tx(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  meta(k) { return this.s.getMeta.get(k)?.value ?? null; }
  setMeta(k, v) { this.s.setMeta.run(k, String(v)); }
  getFile(p) { return this.s.getFile.get(p); }
  hasVector(fileId, mod) { return !!this.db.prepare('SELECT 1 FROM chunks WHERE file_id = ? AND mod = ? AND vec IS NOT NULL LIMIT 1').get(fileId, mod); }
  pendingMedia() {
    return Number(this.db.prepare(`SELECT COUNT(*) n FROM files f WHERE f.kind IN ('image','audio')
      AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.file_id = f.id AND c.mod = f.kind AND c.vec IS NOT NULL)`).get().n);
  }
  upsertFile({ path: p, root, kind, scope, mtime, size, pendingFrom = null }) {
    const f = this.getFile(p);
    if (f) { this.clearChunks(f.id); this.s.updFile.run(mtime, size, pendingFrom, f.id); return f.id; }
    return Number(this.s.insFile.run(p, root, kind, scope, mtime, size, pendingFrom).lastInsertRowid);
  }
  setPending(id, n) { this.db.prepare('UPDATE files SET pending_from=? WHERE id=?').run(n, id); }
  clearChunks(fileId) { this.s.delChunksFts.run(fileId); this.s.delChunks.run(fileId); }
  removeFile(id) { this.clearChunks(id); this.s.delFile.run(id); }
  addChunk(fileId, scope, name, { mod, loc, text, vec }) {
    const blob = vec ? new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength) : null;
    const id = Number(this.s.insChunk.run(fileId, scope, mod, JSON.stringify(loc ?? {}), text ?? null, blob).lastInsertRowid);
    this.s.insFts.run(id, text ?? '', name);
    return id;
  }
  rootFiles(root) { return this.s.filesByRoot.all(root); }
  pendingFiles() { return this.s.pending.all(); }
  stats() {
    return this.db.prepare(`SELECT f.kind, COUNT(DISTINCT f.id) files, COUNT(c.id) chunks
      FROM files f LEFT JOIN chunks c ON c.file_id=f.id GROUP BY f.kind`).all();
  }
  /** Every vector for a scope, as one flat normalized matrix for brute-force dot products. */
  loadMatrix(scope) {
    const rows = this.db.prepare(
      'SELECT id, file_id, mod, loc, text, vec FROM chunks WHERE scope = ? AND vec IS NOT NULL').all(scope);
    if (!rows.length) return { dim: 0, ids: [], meta: [], data: new Float32Array(0) };
    const dim = rows[0].vec.byteLength / 4;
    const data = new Float32Array(rows.length * dim);
    const meta = new Array(rows.length);
    rows.forEach((r, i) => {
      data.set(new Float32Array(r.vec.slice().buffer, 0, dim), i * dim);
      meta[i] = { id: r.id, fileId: r.file_id, mod: r.mod, loc: JSON.parse(r.loc || '{}'), text: r.text };
    });
    return { dim, meta, data };
  }
  signature() {
    const r = this.db.prepare('SELECT COUNT(*) n, COALESCE(MAX(id),0) m FROM chunks').get();
    return `${r.n}:${r.m}`;
  }
}
