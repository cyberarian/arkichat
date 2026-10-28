import path from 'node:path';

const tokens = (q) => (q.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) || []);
const filenameStopWords = new Set(['please', 'find', 'show', 'list', 'search', 'get', 'all', 'the', 'files', 'file', 'filenames', 'filename', 'names', 'name', 'with', 'for', 'of', 'whose', 'that', 'are', 'is', 'has', 'have', 'called', 'named', 'prefix', 'starting', 'starts', 'start', 'beginning', 'begins', 'begin', 'suffix', 'ending', 'ends', 'end', 'containing', 'contains', 'include', 'including', 'matching', 'match', 'extension', 'type']);
const stopWords = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'and', 'or', 'my', 'me', 'that', 'this',
  'these', 'those', 'from', 'about', 'where', 'what', 'which', 'who', 'when', 'is', 'was', 'are', 'were', 'be',
  'it', 'its', 'some', 'any', 'find', 'show', 'file', 'files', 'photo', 'photos', 'picture', 'pictures',
  'image', 'images', 'screenshot', 'screenshots', 'video', 'videos', 'pdf', 'document', 'documents', 'recording',
]);
const queryTerms = (q) => [...new Set(tokens(q).filter(t => !stopWords.has(t)))];
function kindIntent(q) {
  const words = new Set(tokens(q));
  if (['image', 'images', 'photo', 'photos', 'picture', 'pictures', 'screenshot', 'screenshots'].some(w => words.has(w))) return 'image';
  return null;
}

/**
 * Hybrid search: cosine similarity over every vector + an FTS5 keyword pass whose hits get a boost,
 * because no embedding holds an invoice number exactly. Start a query with `code:` to search code.
 */
export class Searcher {
  constructor(store, embedder) { this.db = store; this.emb = embedder; this.cache = {}; }

  _matrix(scope) {
    const sig = this.db.signature();
    const c = this.cache[scope];
    if (!c || c.sig !== sig) this.cache[scope] = { sig, m: this.db.loadMatrix(scope) };
    return this.cache[scope].m;
  }

  _termPattern(term, scope) {
    const exact = `"${term}"`;
    try {
      const found = this.db.db.prepare(`SELECT 1 FROM fts JOIN chunks c ON c.id = fts.rowid WHERE fts MATCH ? AND c.scope = ? LIMIT 1`).get(exact, scope);
      return !found && term.length >= 3 ? `${exact}*` : exact;
    } catch { return exact; }
  }

  _fts(q, scope, limit = 60, kind = null) {
    const t = queryTerms(q);
    if (!t.length) return new Map();
    const match = t.map(x => this._termPattern(x, scope)).join(' OR ');
    let rows = [];
    try {
      rows = this.db.db.prepare(`
        SELECT fts.rowid id, bm25(fts, 1.0, 3.0) r FROM fts
        JOIN chunks c ON c.id = fts.rowid JOIN files f ON f.id = c.file_id
        WHERE fts MATCH ? AND c.scope = ? AND (? IS NULL OR f.kind = ?) ORDER BY r LIMIT ?`).all(match, scope, kind, kind, limit);
    } catch { return new Map(); }
    const worst = Math.max(...rows.map(r => -r.r), 1e-9);
    return new Map(rows.map(r => [r.id, -r.r / worst]));
  }

  _keywordCoverage(terms, scope, kind = null) {
    const files = new Map();
    for (const term of terms) {
      const pattern = this._termPattern(term, scope);
      let rows = [];
      try {
        rows = this.db.db.prepare(`
          SELECT c.file_id fileId, fts.rowid id, c.mod, c.loc, c.text, bm25(fts, 1.0, 3.0) rank
          FROM fts JOIN chunks c ON c.id = fts.rowid JOIN files f ON f.id = c.file_id
          WHERE fts MATCH ? AND c.scope = ? AND (? IS NULL OR f.kind = ?) ORDER BY rank LIMIT 1000`).all(pattern, scope, kind, kind);
      } catch { continue; }
      for (const row of rows) {
        let file = files.get(row.fileId);
        if (!file) files.set(row.fileId, file = { terms: new Set(), chunks: new Map() });
        file.terms.add(term);
        let chunk = file.chunks.get(row.id);
        if (!chunk) file.chunks.set(row.id, chunk = { id: row.id, fileId: row.fileId, mod: row.mod,
          loc: JSON.parse(row.loc || '{}'), text: row.text, terms: new Set(), rank: row.rank });
        chunk.terms.add(term);
        if (row.rank < chunk.rank) chunk.rank = row.rank;
      }
    }
    for (const file of files.values()) {
      file.coverage = file.terms.size / terms.length;
      file.best = [...file.chunks.values()].sort((a, b) => b.terms.size - a.terms.size || a.rank - b.rank)[0];
    }
    return files;
  }

  async search(query, { limit = 10, mods = null, all = false, boost = 0.25, filenames = false, zGate = 2, kind = null } = {}) {
    let scope = 'general', q = query.trim();
    if (filenames && q) {
      const prefix = /\b(prefix|starting with|start with|starts with|beginning with|begin with|begins with)\b/i.test(q);
      const suffix = /\b(suffix|ending with|ends with)\b/i.test(q);
      const terms = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(term => !filenameStopWords.has(term));
      const files = this.db.db.prepare('SELECT id,path,kind FROM files ORDER BY path').all();
      const chunk = this.db.db.prepare('SELECT id,mod,loc,text FROM chunks WHERE file_id = ? ORDER BY id LIMIT 1');
      return files.filter(f => {
        const name = path.basename(f.path).toLowerCase();
        if (!terms.length) return false;
        if (prefix && !name.startsWith(terms[0])) return false;
        if (suffix && !name.endsWith(terms[terms.length - 1])) return false;
        return terms.every(term => name.includes(term));
      }).map(f => {
        const c = chunk.get(f.id);
        return { score: 1, cos: 0, path: f.path, name: path.basename(f.path), kind: f.kind,
          fileId: f.id, chunkId: c?.id ?? null, mod: c?.mod ?? 'name', loc: c ? JSON.parse(c.loc || '{}') : {},
          snippet: c?.text ? snippet(c.text, q) : '' };
      });
    }
    const m = q.match(/^code:\s*/i);
    if (m) { scope = 'code'; q = q.slice(m[0].length); }
    if (!q) return [];

    kind ||= kindIntent(q);
    const terms = queryTerms(q);
    if (!terms.length) return [];
    const fts = this._fts(q, scope, 60, kind);
    const coverage = this._keywordCoverage(terms, scope, kind);
    const matrix = this._matrix(scope);
    const allowedFiles = kind ? new Set(this.db.db.prepare('SELECT id FROM files WHERE kind = ?').all(kind).map(f => f.id)) : null;
    const rows = (matrix.meta || []).map((row, index) => ({ row, index }))
      .filter(({ row }) => !allowedFiles || allowedFiles.has(row.fileId));
    const { dim, data } = matrix;
    const meta = rows.map(({ row }) => row);
    const scores = new Map();                                  // chunk id -> {score, meta}
    const zscores = new Map();
    if (meta?.length && !this.emb.id?.startsWith('hash:')) {
      const [qv] = await this.emb.embedTexts([q], { query: true });
      if (qv.length !== dim) throw new Error(`Query vector is ${qv.length}-d but the index is ${dim}-d: the index was built with a different model. Run \`digup reindex\`.`);
      const cosine = new Float64Array(meta.length);
      let mean = 0;
      for (let i = 0; i < meta.length; i++) {
        let s = 0; const o = rows[i].index * dim;
        for (let d = 0; d < dim; d++) s += data[o + d] * qv[d];
        cosine[i] = s; mean += s;
      }
      mean /= cosine.length;
      const modalityStats = new Map();
      for (let i = 0; i < cosine.length; i++) {
        const mod = meta[i].mod;
        const stats = modalityStats.get(mod) || { sum: 0, count: 0 };
        stats.sum += cosine[i];stats.count++;
        modalityStats.set(mod, stats);
      }
      const centered = cosine.map((score, i) => {
        const stats = modalityStats.get(meta[i].mod);
        return score - (stats.count >= 20 ? stats.sum / stats.count : mean);
      });
      const centeredMean = centered.reduce((sum, score) => sum + score, 0) / centered.length;
      const deviation = Math.max(Math.sqrt(centered.reduce((sum, score) => sum + (score - centeredMean) ** 2, 0) / centered.length), 0.02);
      for (let i = 0; i < meta.length; i++) {
        const z = (centered[i] - centeredMean) / deviation;
        zscores.set(meta[i].id, z);
        scores.set(meta[i].id, { score: z, meta: meta[i], cos: cosine[i] });
      }
    }
    for (const file of coverage.values()) {
      if (file.coverage < 0.5 || !file.best || scores.has(file.best.id)) continue;
      scores.set(file.best.id, { score: 0, meta: file.best, cos: 0 });
    }

    const bestZ = new Map();
    for (const r of scores.values()) {
      const z = zscores.get(r.meta.id) ?? 0;
      if (z > (bestZ.get(r.meta.fileId) ?? -Infinity)) bestZ.set(r.meta.fileId, z);
    }
    // A small corpus cannot produce a 2-sigma outlier even when one result is clearly best.
    // Scale the gate to the maximum possible z-score; a single vector has no comparison basis.
    const effectiveZGate = Math.min(zGate, Math.sqrt(Math.max((meta?.length || 0) - 1, 0)));
    const candidates = new Set([...bestZ].filter(([, z]) => (meta?.length || 0) > 1 && z >= effectiveZGate).map(([id]) => id));
    for (const [id, file] of coverage) if (file.coverage >= 0.5) candidates.add(id);
    const lookup = terms.every(t => /\d/.test(t) && (/[\p{L}]/u.test(t) || t.length >= 4));
    const meaningWeight = lookup ? 0.5 : 1;
    const wordWeight = (scope === 'code' ? 1 : 2) * (lookup ? 2 : 1);
    let ranked = [...scores.values()].filter(r => candidates.has(r.meta.fileId) && (all
      || bestZ.get(r.meta.fileId) >= effectiveZGate
      || r.meta.id === coverage.get(r.meta.fileId)?.best?.id)).map(r => {
      const words = coverage.get(r.meta.fileId)?.coverage || 0;
      const z = zscores.get(r.meta.id) || 0;
      return { ...r, score: meaningWeight * Math.max(z, 0) + wordWeight * words ** 1.5 + boost * (fts.get(r.meta.id) || 0) };
    }).sort((a, b) => b.score - a.score);
    if (mods) ranked = ranked.filter(r => mods.includes(r.meta.mod));
    if (!all) { const seen = new Set(); ranked = ranked.filter(r => !seen.has(r.meta.fileId) && seen.add(r.meta.fileId)); }
    ranked = ranked.slice(0, limit);

    const getFile = this.db.db.prepare('SELECT path, kind FROM files WHERE id = ?');
    return ranked.map(r => {
      const f = getFile.get(r.meta.fileId);
      return { score: +r.score.toFixed(4), cos: +r.cos.toFixed(4), path: f.path, name: path.basename(f.path), kind: f.kind,
        fileId: r.meta.fileId, chunkId: r.meta.id, mod: r.meta.mod, loc: r.meta.loc, snippet: snippet(r.meta.text, q) };
    });
  }
}

function snippet(text, q) {
  if (!text) return '';
  const t = text.replace(/\s+/g, ' ');
  const i = Math.max(0, ...tokens(q).map(w => t.toLowerCase().indexOf(w)).filter(x => x >= 0).slice(0, 1));
  const s = Math.max(0, i - 60);
  return (s ? '…' : '') + t.slice(s, s + 220) + (t.length > s + 220 ? '…' : '');
}

export function fmtLoc(loc) {
  if (loc.page) return `page ${loc.page}`;
  if (loc.t != null) { const t = Math.floor(loc.t); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; }
  if (loc.line) return `line ${loc.line}`;
  if (loc.cell != null) return `cell ${loc.cell}`;
  return '';
}
