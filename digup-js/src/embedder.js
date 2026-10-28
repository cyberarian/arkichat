import { spawn } from 'node:child_process';

function l2(v) {
  let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/**
 * Talks to llama.cpp's `llama-server --embeddings`, which serves the model's text, image and audio parts.
 * Set DIGUP_MODEL (+ DIGUP_MMPROJ for images/audio) and DIGUP_LLAMA_SERVER to have DigUp start the
 * helper process itself and stop it when it's done; or point DIGUP_EMBED_URL at one that's already running.
 */
export class LlamaEmbedder {
  constructor({ url = process.env.DIGUP_EMBED_URL || 'http://127.0.0.1:8099', queryPrefix = process.env.DIGUP_QUERY_PREFIX || '' } = {}) {
    this.url = url; this.queryPrefix = queryPrefix; this.proc = null;
    this.id = `llama:${process.env.DIGUP_MODEL || url}`;
    this.media = !!process.env.DIGUP_MMPROJ || process.env.DIGUP_MEDIA === '1';
  }
  async _json(path, body) {
    const r = await fetch(this.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${path} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }
  async start() {
    if (await this._alive()) return;
    const model = process.env.DIGUP_MODEL;
    if (!model) throw new Error('No embedding server at ' + this.url + '. Start llama-server --embeddings, or set DIGUP_MODEL (and DIGUP_LLAMA_SERVER) so DigUp can start it. For a dry run use DIGUP_EMBEDDER=hash.');
    const port = new URL(this.url).port || '8099';
    const args = ['-m', model, '--embeddings', '--port', port, '--host', '127.0.0.1', '-c', '8192', '-ub', '2048'];
    if (process.env.DIGUP_MMPROJ) args.push('--mmproj', process.env.DIGUP_MMPROJ);
    if (process.env.DIGUP_LLAMA_ARGS) args.push(...process.env.DIGUP_LLAMA_ARGS.split(' '));
    this.proc = spawn(process.env.DIGUP_LLAMA_SERVER || 'llama-server', args, { stdio: 'ignore' });
    this.proc.on('error', (e) => console.error('llama-server failed to start:', e.message));
    for (let i = 0; i < 240; i++) { if (await this._alive()) return; await new Promise(r => setTimeout(r, 500)); }
    throw new Error('llama-server did not become ready');
  }
  async _alive() { try { return (await fetch(this.url + '/health')).ok; } catch { return false; } }
  async stop() { if (this.proc) { this.proc.kill(); this.proc = null; } }

  async embedTexts(texts, { query = false } = {}) {
    const input = texts.map(t => (query ? this.queryPrefix : '') + t);
    const r = await this._json('/v1/embeddings', { input });
    return r.data.sort((a, b) => a.index - b.index).map(d => l2(Float32Array.from(d.embedding)));
  }
  /** kind: 'image' | 'audio'; data: Buffer (jpeg/png or wav). */
  async embedMedia(kind, data) {
    if (!this.media) return null;
    const r = await this._json('/embedding', {
      content: { prompt_string: '<__media__>', multimodal_data: [data.toString('base64')] },
    });
    let e = Array.isArray(r) ? r[0].embedding : r.embedding;
    if (Array.isArray(e[0])) e = e[0];
    return l2(Float32Array.from(e));
  }
}

/** Ollama EmbeddingGemma exposes text and media in the same embedding space through /api/embed. */
export class OllamaEmbedder {
  constructor({
    url = process.env.DIGUP_OLLAMA_HOST || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
    model = process.env.DIGUP_EMBED_MODEL || 'embeddinggemma-2',
    queryPrefix = process.env.DIGUP_QUERY_PREFIX || '',
    media = process.env.DIGUP_MEDIA !== '0',
  } = {}) {
    this.url = url.replace(/\/+$/, '');
    this.model = model;
    this.queryPrefix = queryPrefix;
    this.id = `ollama:${this.model}`;
    this.media = media;
    this.mediaError = null;
  }
  async _json(path, body) {
    const r = await fetch(this.url + path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) throw Object.assign(new Error(`${path} -> ${r.status} ${(await r.text()).slice(0, 200)}`), { status: r.status });
    return r.json();
  }
  async start() {
    const r = await fetch(this.url + '/api/tags', { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`Ollama is not reachable at ${this.url}`);
    const tags = await r.json();
    const names = (tags.models || []).map(m => m.name);
    if (!names.includes(this.model) && !names.includes(this.model + ':latest')) {
      throw new Error(`Ollama does not have the embedding model "${this.model}". Run \`ollama pull ${this.model}\`.`);
    }
  }
  async available() { try { await this.start(); return true; } catch { return false; } }
  async stop() {}
  async embedTexts(texts, { query = false } = {}) {
    const input = texts.map(t => (query ? this.queryPrefix : '') + t);
    const j = await this._json('/api/embed', { model: this.model, input });
    const rows = j.embeddings || (j.embedding ? [j.embedding] : []);
    if (rows.length !== input.length) throw new Error(`Ollama returned ${rows.length} embeddings for ${input.length} inputs`);
    return rows.map(e => l2(Float32Array.from(e)));
  }
  async embedMedia(kind, data) {
    if (!this.media || !['image', 'audio'].includes(kind)) return null;
    try {
      const j = await this._json('/api/embed', { model: this.model, input: { [kind]: data.toString('base64') } });
      const row = j.embeddings?.[0];
      if (!row) throw new Error('Ollama returned no media embedding');
      return l2(Float32Array.from(row));
    } catch (e) {
      if (!(e.status >= 400 && e.status < 500 && /image|audio|media|multimodal/i.test(e.message))) throw e;
      this.media = false;
      this.mediaError = e.message;
      return null;
    }
  }
}

/** Dev/test embedder: hashed word + trigram features. Lexical, text only, no model needed. */
export class HashEmbedder {
  constructor(dim = 512) { this.dim = dim; this.id = `hash:${dim}`; this.media = false; }
  async start() {} async stop() {}
  _vec(t) {
    const v = new Float32Array(this.dim);
    const add = (s, w) => { let h = 2166136261; for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } v[(h >>> 0) % this.dim] += w; };
    const words = t.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    for (const w of words) { add(w, 1); for (let i = 0; i + 3 <= w.length; i++) add('#' + w.slice(i, i + 3), 0.3); }
    return l2(v);
  }
  async embedTexts(texts) { return texts.map(t => this._vec(t)); }
  async embedMedia() { return null; }
}

export function makeEmbedder() {
  return process.env.DIGUP_EMBEDDER === 'hash' ? new HashEmbedder() : new LlamaEmbedder();
}
