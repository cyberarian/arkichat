#!/usr/bin/env node
/**
 * Arki Chat — tiny zero-dependency server.
 * Serves the static UI, proxies to local inference (Ollama and/or llama.cpp),
 * adds YouTube search helper, desktop app launcher, and DigUp file search.
 *
 * Env vars:
 *   PORT             — port to listen on (default 5177, auto-increments if busy)
 *   OLLAMA_HOST      — Ollama base URL (default http://127.0.0.1:11434)
 *   LLAMA_CPP_HOST   — llama.cpp server base URL (default http://127.0.0.1:8080)
 *   DIGUP_ROOTS      — folders to index, separated by the OS path delimiter
 *   DIGUP_EMBEDDER   — `ollama` (auto when pulled), `hash`, or llama.cpp
 *   DIGUP_EMBED_MODEL— Ollama embedding model (default embeddinggemma-2)
 *   DIGUP_OLLAMA_HOST— Ollama for embeddings (default OLLAMA_HOST)
 *   DIGUP_MODEL      — llama.cpp embedding GGUF instead of Ollama (optional)
 *   DIGUP_MMPROJ     — multimodal projector GGUF for image/audio (optional)
 *   DIGUP_EMBED_URL  — an existing llama-server --embeddings (optional)
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const digup = require('./digup');
const { createCliAnything } = require('./cli-anything');
const cliAnything = createCliAnything({ maxOutput: 16384 });

const ROOT = __dirname;
const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
let LLAMA_CPP_HOST = (process.env.LLAMA_CPP_HOST || process.env.LLAMA_SERVER_HOST || 'http://127.0.0.1:8080').replace(/\/+$/, '');

// Auto-launch llama-server if possible
let llamaProc = null;
let llamaModel = null;   // the GGUF the managed server is serving
let llamaAlias = null;   // the model name that server advertises
// A llama.cpp server answers /v1/models with an OpenAI-style list. Checking the
// shape (not just the status code) keeps an unrelated service on the same port
// from being mistaken for a running model server.
async function llamaAlive(timeout = 1500) {
  try {
    const j = await fetchJSON(LLAMA_CPP_HOST + '/v1/models', { timeout });
    return !!(j && (Array.isArray(j.data) || Array.isArray(j.models)));
  } catch {
    return false;
  }
}

// The model names a running llama-server advertises.
// ---- remembered backend ----
// The UI keeps the user's backend choice in localStorage, which the server
// cannot see on boot. A tiny state file remembers which backend was last
// used, so a restart can warm llama.cpp back up instead of showing the
// "isn't serving" banner until the user presses start again.
const STATE_FILE = path.join(ROOT, '.arki-state.json');
let backendState = null;
function loadBackendState() {
  if (!backendState) {
    try { backendState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { backendState = {}; }
  }
  return backendState;
}
// Record which backend last served a chat. Only writes when the value
// changes, so a stream of chat messages stays free of disk writes.
function noteBackend(bk, model) {
  const st = loadBackendState();
  model = model || '';
  if (st.backend === bk && st.model === model) return;
  st.backend = bk; st.model = model;
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2)); } catch { /* best effort */ }
}
async function llamaServedModels() {
  try {
    const j = await fetchJSON(LLAMA_CPP_HOST + '/v1/models', { timeout: 2500 });
    const list = Array.isArray(j && j.data) ? j.data : Array.isArray(j && j.models) ? j.models : [];
    return list.map((m) => String((m && (m.id || m.name || m.model)) || '')).filter(Boolean);
  } catch {
    return [];
  }
}

// Is anything already listening on this port?
// Binding is not a reliable test: a server that uses SO_REUSEPORT (nginx does)
// lets a second process bind the same port, and then the other server keeps
// answering. So ask the port itself — if a connection succeeds, someone is
// there and we must not use it.
function portTaken(port) {
  return new Promise((resolve) => {
    const net = require('net');
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(800);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}
async function freePort(start) {
  for (let p = start; p < start + 20; p++) {
    if (!(await portTaken(p))) return p;
  }
  return start;
}
function isGGUF(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return buf.toString('latin1') === 'GGUF';
  } catch {
    return false;
  }
}

// Sequential reader over the head of a file. The GGUF header is variable
// length: a chat model's tokenizer table alone can be tens of megabytes, so a
// fixed-size buffer either truncates the metadata or reads the whole model.
// This walks the bytes it needs and nothing more.
class HeadReader {
  constructor(fd, size) {
    this.fd = fd;
    this.size = size;
    this.pos = 0;          // absolute file offset
    this.win = Buffer.alloc(0);
    this.winStart = 0;     // file offset of win[0]
  }
  // make sure n bytes are readable from the current position
  ensure(n) {
    if (this.pos + n <= this.winStart + this.win.length) return true;
    const want = Math.min(Math.max(n, 1 << 20), this.size - this.pos);
    if (want <= 0) return false;
    const buf = Buffer.allocUnsafe(want);
    const got = fs.readSync(this.fd, buf, 0, want, this.pos);
    this.win = buf.subarray(0, got);
    this.winStart = this.pos;
    return got >= n;
  }
  bytes(n) {
    if (n === 0) return Buffer.alloc(0);
    if (n > this.win.length) {                 // too big for the window: read it alone
      const buf = Buffer.allocUnsafe(n);
      const got = fs.readSync(this.fd, buf, 0, n, this.pos);
      if (got < n) throw new Error('eof');
      this.pos += got;
      this.win = Buffer.alloc(0);
      this.winStart = this.pos;
      return buf;
    }
    if (!this.ensure(n)) throw new Error('eof');
    const off = this.pos - this.winStart;
    const out = this.win.subarray(off, off + n);
    this.pos += n;
    return out;
  }
  u8() { if (!this.ensure(1)) throw new Error('eof'); const v = this.win.readUInt8(this.pos - this.winStart); this.pos += 1; return v; }
  i8() { if (!this.ensure(1)) throw new Error('eof'); const v = this.win.readInt8(this.pos - this.winStart); this.pos += 1; return v; }
  u16() { if (!this.ensure(2)) throw new Error('eof'); const v = this.win.readUInt16LE(this.pos - this.winStart); this.pos += 2; return v; }
  i16() { if (!this.ensure(2)) throw new Error('eof'); const v = this.win.readInt16LE(this.pos - this.winStart); this.pos += 2; return v; }
  u32() { if (!this.ensure(4)) throw new Error('eof'); const v = this.win.readUInt32LE(this.pos - this.winStart); this.pos += 4; return v; }
  i32() { if (!this.ensure(4)) throw new Error('eof'); const v = this.win.readInt32LE(this.pos - this.winStart); this.pos += 4; return v; }
  f32() { if (!this.ensure(4)) throw new Error('eof'); const v = this.win.readFloatLE(this.pos - this.winStart); this.pos += 4; return v; }
  f64() { if (!this.ensure(8)) throw new Error('eof'); const v = this.win.readDoubleLE(this.pos - this.winStart); this.pos += 8; return v; }
  u64() { if (!this.ensure(8)) throw new Error('eof'); const v = this.win.readBigUInt64LE(this.pos - this.winStart); this.pos += 8; return v; }
  i64() { if (!this.ensure(8)) throw new Error('eof'); const v = this.win.readBigInt64LE(this.pos - this.winStart); this.pos += 8; return v; }
  str() { const n = Number(this.u64()); return this.bytes(n).toString('utf8'); }
  // step over a value we do not care about
  skip(type) {
    if (type === 8) { this.bytes(Number(this.u64())); return; }
    if (type === 9) {
      const el = this.u32();
      const n = Number(this.u64());
      for (let i = 0; i < n; i++) this.skip(el);
      return;
    }
    const sizes = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
    this.bytes(sizes[type] || 0);
  }
}

// Minimal GGUF metadata reader: enough to read general.architecture and the
// pooling type. An embedding model sets a pooling type; a chat model does not,
// so this tells us whether a file can actually serve a conversation.
// The tokenizer section is skipped — it is the bulky part and carries nothing
// we need.
function ggufMeta(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const r = new HeadReader(fd, size);
    if (r.bytes(4).toString('latin1') !== 'GGUF') return {};
    r.u32();                        // format version
    r.u64();                        // tensor count
    const kvCount = Number(r.u64());
    const out = {};
    for (let i = 0; i < kvCount && i < 4096; i++) {
      let key;
      try { key = r.str(); } catch { break; }
      // the tokenizer block is huge and irrelevant here
      if (key.startsWith('tokenizer.')) break;
      let type;
      try { type = r.u32(); } catch { break; }
      try {
        if (type === 8) out[key] = r.str();
        else if (type === 0) out[key] = r.u8();
        else if (type === 1) out[key] = r.i8();
        else if (type === 2) out[key] = r.u16();
        else if (type === 3) out[key] = r.i16();
        else if (type === 4) out[key] = r.u32();
        else if (type === 5) out[key] = r.i32();
        else if (type === 6) out[key] = r.f32();
        else if (type === 7) out[key] = !!r.u8();
        else if (type === 10) out[key] = Number(r.u64());
        else if (type === 11) out[key] = Number(r.i64());
        else if (type === 12) out[key] = r.f64();
        else r.skip(type);
      } catch { break; }
    }
    return out;
  } catch {
    return {};
  } finally {
    try { if (fd) fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// llama.cpp can serve a conversation only with a generative model — an
// embedding model (pooling type set) is useless for chat.
// The pooling key is architecture-prefixed ("gemma3.pooling_type"), so match
// on the suffix rather than an exact name.
function isChatGGUF(file) {
  const meta = ggufMeta(file);
  for (const [k, v] of Object.entries(meta)) {
    if (/(^|\.)pooling_type$/.test(k) && Number(v) > 0) return false;
  }
  const arch = String(meta['general.architecture'] || '').toLowerCase();
  // no architecture at all: not a language model (a diffusion checkpoint, a
  // toy test file) — llama.cpp cannot load it
  if (!arch) return false;
  if (/bert/.test(arch)) return false;
  // architectures llama.cpp knows but that are not chat models
  if (/^(stable-diffusion|t5|marian|nougat|whisper|wav2vec|mmt|vision|clip|dall-e|medusa)$/.test(arch)) return false;
  // llama.cpp only understands the architectures compiled into its library;
  // the rest fail to load with "unknown model architecture", so they are
  // filtered out of the picker instead of failing when the user picks them
  if (!llamaSupportsArch(arch)) return false;
  // a main GGUF that ships its own audio encoder ("all-in-one" multimodal
  // files, e.g. gemma4) cannot be served by plain llama-server: the loader
  // creates only the text tensors, then dies with "wrong number of tensors;
  // expected N, got M". Ollama runs such models fine, so they stay out of
  // llama.cpp's model list; embedded *vision* encoders (llava-style) load
  // without a separate mmproj and stay eligible.
  for (const k of Object.keys(meta)) {
    if (/\.audio\./.test(k)) return false;
  }
  return true;
}

// llama.cpp only understands the architectures compiled into its library. The
// architecture names are plain strings in the library, so a model whose
// architecture does not appear there cannot be served by it.
let llamaArchCache = null;
function llamaArchitectures() {
  if (llamaArchCache) return llamaArchCache;
  const bin = findLlamaServer();
  const names = new Set();
  // a bare name means llama-server is not installed here — nothing to scan
  if (bin && bin.includes(path.sep)) {
    const dirs = [path.dirname(bin), path.join(path.dirname(bin), '..', 'lib'), path.join(path.dirname(bin), '..', 'lib64')];
    const files = [];
    for (const d of dirs) {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (!e.isFile() && !e.isSymbolicLink()) continue;
        const n = e.name;
        if (n === path.basename(bin) || /^libllama.*\.(dylib|so|a(\.\d+)*)$/.test(n)) files.push(path.join(d, n));
      }
    }
    for (const f of files) {
      let data;
      try { data = fs.readFileSync(f); } catch { continue; }
      // architecture names are stored as plain null-terminated strings
      const text = data.toString('latin1');
      for (const m of text.matchAll(/(?<![!-~])([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?=\x00)/g)) names.add(m[1]);
    }
  }
  llamaArchCache = names;
  return names;
}
function llamaSupportsArch(arch) {
  const a = String(arch || '').toLowerCase();
  if (!a) return false;
  const known = llamaArchitectures();
  // nothing found (an unusual install) — do not second-guess the loader
  if (!known.size) return true;
  return known.has(a);
}

// Ollama stores its models as GGUF blobs, so llama.cpp can reuse what the user
// already pulled. The manifest names which blob is the actual model; the model
// name itself comes from the path (…/library/qwen3.5/2b → qwen3.5:2b).
function ollamaGGUFs() {
  const base = path.join(os.homedir(), '.ollama', 'models');
  const manifestsRoot = path.join(base, 'manifests');
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      // manifests are named by tag (e.g. "2b"), not by extension
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
      if (!manifest || !Array.isArray(manifest.layers)) continue;
      // …/manifests/registry.ollama.ai/library/qwen3.5/2b → qwen3.5:2b
      const rel = path.relative(manifestsRoot, p).split(path.sep);
      const name = rel.length >= 2 ? rel[rel.length - 2] + ':' + rel[rel.length - 1] : path.basename(p);
      for (const l of manifest.layers) {
        if (l.mediaType !== 'application/vnd.ollama.image.model') continue;
        const dg = String(l.digest || '').replace('sha256:', '');
        if (!dg) continue;
        const blob = path.join(base, 'blobs', 'sha256-' + dg);
        if (!fs.existsSync(blob)) continue;
        if (!isGGUF(blob)) continue;      // safetensors models are not GGUF
        if (!isChatGGUF(blob)) continue;  // embedding models cannot chat
        out.push({ path: blob, name });
      }
    }
  };
  walk(manifestsRoot, 0);
  return out;
}

// Every chat-capable GGUF on this machine, with a display name the UI can
// show. Ollama's own models come first and keep their Ollama name, so the
// same model reads the same whichever backend ends up serving it.
// The scan is cached: it walks directories and parses GGUF headers, which is
// far too slow to repeat on every chat request.
let localCache = null;
let localCacheAt = 0;
function localChatModels(force = false) {
  if (!force && localCache && Date.now() - localCacheAt < 30000) return localCache;
  const out = [];
  const byPath = new Set();
  const byName = new Set();
  const add = (file, name) => {
    const key = path.resolve(file);
    if (byPath.has(key)) return;
    byPath.add(key);
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return; }
    // two models can share a name — keep both, but tell them apart
    let label = name;
    let n = 2;
    while (byName.has(label)) { label = name + ' #' + n; n++; }
    byName.add(label);
    out.push({ path: file, name: label, size });
  };
  // an explicitly configured model takes the first slot
  const explicit = process.env.LLAMA_CPP_MODEL || process.env.LLAMA_MODEL || process.env.MODEL_PATH;
  if (explicit) {
    try {
      fs.accessSync(explicit, fs.constants.R_OK);
      add(explicit, path.basename(explicit).replace(/\.gguf$/i, ''));
    } catch { /* not there, or not readable */ }
  }
  for (const m of ollamaGGUFs()) add(m.path, m.name);
  const home = os.homedir();
  const dirs = [
    path.join(home, '.cache', 'llama.cpp'),
    path.join(home, '.cache', 'huggingface', 'hub'),
    path.join(home, '.cache', 'lmstudio', 'models'),
    path.join(home, 'models'),
    path.join(home, '.local', 'share', 'models'),
    '/models',
  ];
  for (const d of dirs) {
    const stack = [{ dir: d, depth: 0 }];
    while (stack.length) {
      const { dir, depth } = stack.pop();
      if (depth > 3) continue;
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { stack.push({ dir: p, depth: depth + 1 }); continue; }
        if (!e.name.endsWith('.gguf')) continue;
        if (/mmproj|projector/i.test(e.name)) continue;   // vision projector, not a model
        if (!isChatGGUF(p)) continue;                      // embedding models cannot chat
        add(p, path.basename(p).replace(/\.gguf$/i, ''));
      }
    }
  }
  localCache = out;
  localCacheAt = Date.now();
  return out;
}

// The models llama.cpp should serve when the user has not picked one, best
// first: models Ollama itself calls a chat model (so it really is a chat
// model) come before the rest, and among those the smallest loads fastest.
// The list is a list because llama.cpp does not understand every architecture
// Ollama can run — the caller tries them in order until one loads.
async function defaultLlamaModels() {
  const local = localChatModels();
  if (!local.length) return [];
  const byName = new Map(local.map((m) => [m.name, m]));
  let chat = [];
  try {
    const j = await fetchJSON(OLLAMA_HOST + '/api/tags', { timeout: 2500 });
    chat = (j && j.models ? j.models : [])
      .filter((m) => {
        const caps = (m.details && m.details.capabilities) || [];
        return !caps.length || caps.includes('completion');
      })
      .map((m) => byName.get(m.name || m.model))
      .filter(Boolean)
      .sort((a, b) => a.size - b.size);
  } catch {
    // Ollama is down — fall back to whatever is on disk
  }
  const seen = new Set();
  const out = [];
  for (const m of [...chat, ...local]) {
    if (!m || seen.has(m.path)) continue;
    seen.add(m.path);
    out.push(m);
  }
  return out;
}
// llama-server is often installed outside PATH (Homebrew, a manual build, a
// venv), so look in the usual places before giving up.
function findLlamaServer() {
  if (process.env.LLAMA_SERVER_BIN) return process.env.LLAMA_SERVER_BIN;
  const home = os.homedir();
  // PATH first
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d, 'llama-server');
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
  }
  // Homebrew keeps llama-server inside its cellar, not /bin
  for (const prefix of ['/usr/local/opt/llama.cpp', '/opt/homebrew/opt/llama.cpp', '/usr/local', '/opt/homebrew']) {
    const p = path.join(prefix, 'bin', 'llama-server');
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
  }
  for (const p of [
    path.join(home, '.local', 'bin', 'llama-server'),
    path.join(home, 'bin', 'llama-server'),
    path.join(home, 'llama.cpp', 'llama-server'),
  ]) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
  }
  return 'llama-server';
}

// A multimodal GGUF holds only the text tower; vision and audio live in a
// separate mmproj file, and llama.cpp quietly serves text alone when it is not
// passed. Projectors are not named inside the model, so match by convention: an
// mmproj* file in the model's own folder whose name names the same family
// (mmproj-gemma-4-E4B-it-Q8_0.gguf next to gemma-4-E4B-it-Q4_K_M.gguf).
function findMmproj(modelPath) {
  if (process.env.LLAMA_MMPROJ) return process.env.LLAMA_MMPROJ;
  const dir = path.dirname(modelPath);
  let ents;
  try { ents = fs.readdirSync(dir); } catch { return null; }
  const projs = ents.filter((n) => /\.gguf$/i.test(n) && /^(mmproj|projector)/i.test(n));
  if (!projs.length) return null;
  const model = path.basename(modelPath).replace(/\.gguf$/i, '').toLowerCase();
  const family = (n) => n.toLowerCase().replace(/\.gguf$/i, '')
    .replace(/^(mmproj|projector)[-_]?/, '')
    .replace(/[-_](bf16|f16|f32|q\d.*|iq\d.*)$/, '');
  const hit = projs.find((n) => { const f = family(n); return f && model.includes(f); });
  const pick = hit || (projs.length === 1 ? projs[0] : null);
  return pick ? path.join(dir, pick) : null;
}

// Start (or reuse) a llama-server for one specific model.
// The UI picks the model, so this takes the model path — not just "whatever
// was found first". `alias` is the name the server advertises, so the model
// reads the same in the picker no matter which backend serves it.
// llama-server prints the reason on stderr when it cannot load a model (an
// architecture it does not know, a broken file), so that output is kept and
// turned into an error the user can act on.
async function startLlamaServer(modelPath, alias, { patient = false } = {}) {
  if (llamaProc && !llamaProc.killed) {
    if (llamaModel === modelPath) return LLAMA_CPP_HOST;
    // a different model was asked for — swap it
    try { llamaProc.kill('SIGTERM'); } catch { /* already gone */ }
    llamaProc = null;
    llamaModel = null;
    await new Promise((r) => setTimeout(r, 400));
  }
  const bin = findLlamaServer();
  let port = Number(new URL(LLAMA_CPP_HOST).port || '8080');
  // if the configured port already answers for someone else, move to the next
  // free one — the user's own server there must keep working
  if (await portTaken(port)) {
    const alt = await freePort(port + 1);
    console.log(`llama.cpp  →  port ${port} is in use, using ${alt} instead`);
    port = alt;
    LLAMA_CPP_HOST = `http://127.0.0.1:${port}`;
  }
  const args = ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port), '-ngl', process.env.LLAMA_NGL || '99'];
  if (alias) args.push('--alias', alias);
  if (process.env.LLAMA_CPP_ARGS) args.push(...process.env.LLAMA_CPP_ARGS.split(/\s+/).filter(Boolean));
  const mmproj = findMmproj(modelPath);
  if (mmproj) args.push('--mmproj', mmproj);
  const label = alias || path.basename(modelPath).replace(/\.gguf$/i, '');
  console.log(`llama.cpp  →  starting ${bin} with ${label}${mmproj ? ' + ' + path.basename(mmproj) : ''} on ${LLAMA_CPP_HOST}`);

  const stderr = [];
  let exited = null;
  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
  llamaProc = proc;
  llamaModel = modelPath;
  llamaAlias = label;
  proc.stderr.on('data', (d) => {
    const line = d.toString();
    stderr.push(line);
    if (stderr.length > 40) stderr.shift();
  });
  proc.on('error', (e) => {
    console.error('llama-server failed to start:', e.message);
    exited = { code: -1, reason: e.message };
    if (llamaProc === proc) { llamaProc = null; llamaModel = null; llamaAlias = null; }
  });
  proc.on('exit', (code) => {
    console.log(`llama.cpp  →  exited (code ${code})`);
    exited = { code, reason: llamaReason(stderr) };
    if (llamaProc === proc) { llamaProc = null; llamaModel = null; llamaAlias = null; }
  });

  // Wait for it to be ready — or for it to say why it cannot.
  // A patient start is used when the user explicitly picked this model: big
  // GGUFs can take minutes to mmap-load on a CPU-only machine, and killing a
  // healthy load just because the timer expired throws away minutes of I/O.
  // Leave the child running; the next start/chat call finds it once ready.
  const waitSec = patient ? Number(process.env.LLAMA_START_TIMEOUT || 360) : 120;
  for (let i = 0; i < waitSec; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (exited) throw new Error(exited.reason || `llama-server exited (code ${exited.code})`);
    if (await llamaAlive(1000)) {
      console.log(`llama.cpp  →  ready at ${LLAMA_CPP_HOST}`);
      return LLAMA_CPP_HOST;
    }
  }
  if (!patient) {
    try { proc.kill('SIGTERM'); } catch { /* already gone */ }
    throw new Error('llama-server did not become ready in time');
  }
  throw new Error('llama-server is still loading the model — it answers as soon as the load finishes; trying again in a minute usually works');
}

// Pull the useful line out of llama-server's stderr — the one that says why
// the model could not be loaded.
function llamaReason(lines) {
  const text = lines.join('');
  const bad = text.split('\n').map((l) => l.trim()).filter((l) => /error|failed|unknown model architecture/i.test(l));
  const pick = bad.find((l) => /unknown model architecture/i.test(l)) || bad[0];
  if (!pick) return '';
  return pick.replace(/^.*\bE\s+/, '').replace(/^\S+\s+llama_model_load:\s*/i, '').trim();
}

// Make sure a llama-server is running with the given model (by path).
// If nothing is running yet, start one with the default model.
async function ensureLlamaServer(modelPath, alias) {
  if (await llamaAlive()) {
    if (!modelPath) {
      console.log(`llama.cpp  →  ${LLAMA_CPP_HOST} (already running)`);
      return LLAMA_CPP_HOST;
    }
    // already running — does it serve the model we want?
    const running = await llamaServedModels();
    if (running.includes(modelPath) || running.includes(alias) || !running.length) return LLAMA_CPP_HOST;
  }
  if (llamaProc && !llamaProc.killed && llamaModel === modelPath) {
    // our own child is spawning or loading — give it a short window, then
    // report honestly that it is still loading rather than pretending ok
    // (the chat endpoint would otherwise forward "Loading model" 503s)
    for (let i = 0; i < 30; i++) {
      if (await llamaAlive(1000)) return LLAMA_CPP_HOST;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('llama.cpp is still loading the model — it answers as soon as the load finishes; trying again in a minute usually works');
  }
  if (modelPath) return startLlamaServer(modelPath, alias, { patient: true });

  // No model chosen: walk the candidates until one actually loads. Not every
  // model Ollama can run is a model llama.cpp understands, so the first one
  // that fails is skipped rather than being the end of the road.
  const candidates = await defaultLlamaModels();
  if (!candidates.length) {
    console.log('llama.cpp  →  not started (no chat model found; set LLAMA_CPP_MODEL=/path/to/model.gguf)');
    return null;
  }
  let lastError = '';
  for (const m of candidates) {
    try {
      return await startLlamaServer(m.path, alias || m.name);
    } catch (e) {
      lastError = e.message;
      console.log(`llama.cpp  →  ${m.name} did not load (${e.message}) — trying the next one`);
    }
  }
  throw new Error(lastError || 'no llama.cpp model could be loaded');
}

// Resolve a model name the UI picked back to a GGUF on disk, so the server can
// be (re)started with exactly that model.
function resolveLocalModel(name) {
  if (!name) return null;
  const local = localChatModels();
  return local.find((m) => m.name === name || m.path === name) || null;
}
const YT_HOST = 'https://www.youtube.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---- static files ----
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function getHttpClient(targetUrl) {
  return targetUrl.protocol === 'https:' ? https : http;
}

function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const target = new URL(url);
      const client = getHttpClient(target);
      const req = client.request(
        target,
        {
          method: options.method || 'GET',
          headers: options.headers || {},
          timeout: options.timeout || 5000,
        },
        (res) => {
          let data = '';
          res.on('data', (d) => (data += d));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 400) {
              return reject(new Error('HTTP ' + res.statusCode));
            }
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              resolve(data);
            }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('timeout'));
      });
      if (options.body) req.write(options.body);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

async function listAllModels() {
  const results = [];
  // Try Ollama
  try {
    const j = await fetchJSON(OLLAMA_HOST + '/api/tags', { timeout: 3000 });
    if (j && Array.isArray(j.models)) {
      for (const m of j.models) {
        results.push({
          name: m.name || m.model,
          model: m.name || m.model,
          backend: 'ollama',
          details: m.details || {},
          size: m.size,
          digest: m.digest,
        });
      }
    }
  } catch (e) {
    // ignore
  }
  // Try llama.cpp (OpenAI compatible)
  try {
    const j = await fetchJSON(LLAMA_CPP_HOST + '/v1/models', { timeout: 3000 });
    if (j) {
      const models = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
      for (const m of models) {
        const id = m.id || m.name || m.model;
        if (!id) continue;
        // same model name can exist on both backends — keep both, tagged
        if (results.find((r) => r.model === id && r.backend === 'llama.cpp')) continue;
        results.push({
          name: id,
          model: id,
          backend: 'llama.cpp',
          details: m.details || {},
          owned_by: m.owned_by,
        });
      }
    }
  } catch (e) {
    // ignore
  }
  return results;
}

// ---- streaming proxy to backends ----
function proxyToBackend(req, res, backend) {
  const host = backend === 'llama.cpp' ? LLAMA_CPP_HOST : OLLAMA_HOST;
  const target = new URL(req.url, host);
  const client = getHttpClient(target);
  const upstream = client.request(
    target,
    { method: req.method, headers: { ...req.headers, host: target.host } },
    (ur) => {
      res.writeHead(ur.statusCode || 502, ur.headers);
      ur.pipe(res);
    }
  );
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: (backend === 'llama.cpp' ? 'llama.cpp' : 'Ollama') + ' unreachable at ' + host + ' — is it running?' }));
  });
  req.pipe(upstream);
}

function proxy(req, res) {
  const target = new URL(req.url, OLLAMA_HOST);
  const client = getHttpClient(target);
  const upstream = client.request(
    target,
    { method: req.method, headers: { ...req.headers, host: target.host } },
    (ur) => {
      res.writeHead(ur.statusCode || 502, ur.headers);
      ur.pipe(res);
    }
  );
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'Ollama unreachable at ' + OLLAMA_HOST + ' — is it running? Start it with `ollama serve`.' }));
  });
  req.pipe(upstream);
}

// ---- YouTube search without an API key ----
// YouTube killed its public "search" player embed, so instead of a magic embed URL
// we read the normal results page once and hand the page a concrete video id that
// the nocookie player can actually play.
const ytCache = new Map();
const YT_TTL = 1000 * 60 * 10;

function unescapeJSON(s) {
  try {
    return JSON.parse('"' + s + '"');
  } catch {
    return s;
  }
}

async function ytSearch(query) {
  const key = query.toLowerCase().trim();
  const hit = ytCache.get(key);
  if (hit && Date.now() - hit.at < YT_TTL) return hit.value;
  const res = await fetch(YT_HOST + '/results?search_query=' + encodeURIComponent(query), {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (!res.ok) throw new Error('YouTube search failed (HTTP ' + res.status + ')');
  const html = await res.text();
  const out = [];
  // every search result card is a "videoRenderer" object; split on it and pull
  // the few fields we need out of each slice independently.
  for (const chunk of html.split('"videoRenderer":').slice(1)) {
    const id = /"videoId":"([\w-]{11})"/.exec(chunk);
    const title = /"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/.exec(chunk);
    if (!id || !title) continue;
    const dur = /"lengthText":\{"accessibility":\{"accessibilityData":\{"label":"([^"]+)"/.exec(chunk);
    const ch = /"ownerText":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/.exec(chunk);
    out.push({
      videoId: id[1],
      title: unescapeJSON(title[1]),
      channel: ch ? unescapeJSON(ch[1]) : '',
      duration: dur ? dur[1] : '',
    });
    if (out.length >= 5) break;
  }
  if (!out.length) throw new Error('no YouTube results for that search');
  ytCache.set(key, { at: Date.now(), value: out });
  return out;
}

// ---- desktop app launcher (generic, OS-neutral, no shell) ----
// A curated table first — verified commands plus friendly aliases — and anything
// else is resolved by the operating system itself, so "whatever the name" works:
//   darwin  open -a "<name>"        LaunchServices, any installed app
//   linux   .desktop Name → Exec    else the name as a PATH binary
//   win32   cmd /c start "<name>"   App Paths / Start Menu
// Every attempt is a fixed argv array handed to spawn(); the name is validated
// against a narrow charset and never concatenated into a shell string.
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const expandEnv = (s) => s.replace(/%([A-Za-z_]+)%/g, (m, k) => process.env[k] || m);
const winCmd = (exe) => ['cmd', '/c', 'start', '', exe];

const LOCAL_APPS = [
  {
    id: 'libreoffice',
    label: 'LibreOffice',
    aliases: ['libre office', 'soffice'],
    cmds: {
      darwin: [['open', '-a', 'LibreOffice']],
      linux: [['libreoffice'], ['soffice']],
      win32: [
        winCmd('C:\\Program Files\\LibreOffice\\program\\soffice.exe'),
        winCmd('C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'),
        winCmd('soffice'),
      ],
    },
  },
  {
    id: 'vlc',
    label: 'VLC',
    aliases: ['videolan', 'video lan'],
    cmds: {
      darwin: [['open', '-a', 'VLC']],
      linux: [['vlc']],
      win32: [
        winCmd('C:\\Program Files\\VideoLAN\\VLC\\vlc.exe'),
        winCmd('C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe'),
        winCmd('vlc'),
      ],
    },
  },
  {
    id: 'vscode',
    label: 'VS Code',
    aliases: ['vs code', 'visual studio code', 'code'],
    cmds: {
      darwin: [['open', '-a', 'Visual Studio Code']],
      linux: [['code']],
      win32: [
        winCmd('%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe'),
        winCmd('C:\\Program Files\\Microsoft VS Code\\Code.exe'),
        winCmd('code'),
      ],
    },
  },
  {
    id: 'digup',
    label: 'DigUp',
    aliases: ['dig up', 'search files', 'find files'],
    cmds: {
      darwin: [['open', '-a', 'DigUp']],
      linux: [['digup']],
      win32: [
        winCmd('C:\\Program Files\\DigUp\\DigUp.exe'),
        winCmd('digup'),
      ],
    },
  },
];

function lookupLocal(raw) {
  const key = normName(raw);
  if (!key) return null;
  for (const app of LOCAL_APPS) {
    if (normName(app.id) === key || app.aliases.some((a) => normName(a) === key)) return app;
  }
  return null;
}

// the commands that make sense on *this* machine: an absolute path that is not
// installed is dropped up front, so we never report success for a missing file
function attemptsFor(app) {
  const list = (app.cmds && app.cmds[process.platform]) || [];
  return list
    .map((argv) => argv.map(expandEnv))
    .filter((argv) => argv.every((a) => !(a.includes('\\') || a.includes('%')) || fs.existsSync(a)));
}

// the only allowlist left: letters, digits, spaces and .'+_-, so there are no
// path separators, no leading dash, and nothing cmd.exe can read as syntax
function validAppName(n) {
  return typeof n === 'string' && n.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9 .'+_-]*$/.test(n);
}

// ---- linux: resolve a human name through the freedesktop .desktop registry ----
const DESKTOP_DIRS = [
  '/usr/share/applications',
  '/usr/local/share/applications',
  path.join(os.homedir(), '.local/share/applications'),
  '/var/lib/flatpak/exports/share/applications',
  path.join(os.homedir(), '.local/share/flatpak/exports/share/applications'),
];
function splitExec(s) {
  const out = [];
  let cur = '', quoted = false;
  for (const c of String(s)) {
    if (c === '"') { quoted = !quoted; continue; }
    if (!quoted && /\s/.test(c)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out.filter((a) => !/^%[fFuUdDnNickvm]$/i.test(a)); // drop field codes
}
let desktopCache = null, desktopAt = 0;
function desktopApps() {
  if (desktopCache && Date.now() - desktopAt < 300000) return desktopCache;
  const map = new Map();
  const add = (key, argv) => { const k = normName(key); if (k && !map.has(k)) map.set(k, argv); };
  const walk = (dir, depth) => {
    if (depth > 2) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full, depth + 1); continue; }
      if (!ent.name.endsWith('.desktop')) continue;
      let txt = '';
      try { txt = fs.readFileSync(full, 'utf8'); } catch (e) { continue; }
      const ty = /^Type=(\S+)/m.exec(txt);
      if (ty && ty[1] !== 'Application') continue;
      if (/^(NoDisplay|Hidden)=(true|1)$/m.test(txt)) continue;
      const ex = /^Exec=(.+)$/m.exec(txt);
      if (!ex) continue;
      const argv = splitExec(ex[1]);
      if (!argv.length) continue;
      add(ent.name.replace(/\.desktop$/, ''), argv);
      const nm = /^Name=(.+)$/m.exec(txt);
      if (nm) add(nm[1], argv);
      add(path.basename(argv[0]), argv);
    }
  };
  DESKTOP_DIRS.forEach((d) => walk(d, 0));
  desktopCache = map;
  desktopAt = Date.now();
  return map;
}
function genericAttempts(name) {
  if (process.platform === 'darwin') return [['open', '-a', name]];
  if (process.platform === 'win32') return [['cmd', '/c', 'start', '', name]];
  if (process.platform === 'linux') return [desktopApps().get(normName(name)) || [name]];
  return [];
}

// spawns detached so the app outlives the request; resolves as soon as we know:
// an error/exit is definitive, while still running after a second means it launched
function trySpawn(argv) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, msg) => { if (!settled) { settled = true; resolve({ ok, msg }); } };
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) { return done(false, e.message); }
    let stderr = '';
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => done(true, ''), 1000);
    child.on('error', (e) => {
      clearTimeout(timer);
      done(false, e.code === 'ENOENT' ? '“' + argv[0] + '” is not installed' : e.message);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return done(true, '');
      const first = (stderr.trim().split('\n')[0] || '').trim();
      done(false, first || ('exited with code ' + code));
    });
    child.unref();
  });
}

async function launchApp(raw) {
  const name = String(raw || '').trim();
  if (!name) return { code: 400, body: { ok: false, reason: 'invalid', message: 'name is required' } };
  if (!validAppName(name)) return { code: 400, body: { ok: false, reason: 'invalid', message: 'that is not a usable app name' } };
  const app = lookupLocal(name);
  const label = app ? app.label : name;
  const known = app ? attemptsFor(app) : [];
  const seen = new Set();
  const attempts = [...known, ...genericAttempts(label)].filter((argv) => {
    const key = argv.join('\0');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!attempts.length) {
    return { code: 501, body: { ok: false, reason: 'unsupported', message: 'no launch command for ' + process.platform + '.' } };
  }
  let last = '';
  for (const argv of attempts) {
    const r = await trySpawn(argv);
    if (r.ok) return { code: 200, body: { ok: true, app: app ? app.id : name, message: 'Launched ' + label + '.' } };
    last = r.msg;
  }
  return { code: 502, body: { ok: false, reason: 'failed', message: 'Could not launch ' + label + ' — ' + last } };
}

function readBody(req, cb) {
  let data = '', over = false, sent = false;
  const finish = () => { if (sent) return; sent = true; cb(over ? null : data); };
  req.on('data', (d) => { data += d; if (data.length > 4096) over = true; });
  req.on('end', finish);
  req.on('error', finish);
}

// Chat bodies carry base64 images, so they get a much larger ceiling than the
// small control endpoints above.
function readBodyBuf(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on('data', (d) => {
      len += d.length;
      if (len > limit) { req.destroy(); reject(new Error('request body too large')); return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---- chat dialects: Ollama (what the page speaks) vs OpenAI (what llama.cpp speaks) ----
// The page posts to /api/chat in Ollama's dialect; llama.cpp only understands
// OpenAI's. These helpers translate in both directions — requests, streamed
// responses, and tool calls — so either backend can serve either endpoint.

// Ollama chat request -> OpenAI chat request
// ---- format conversion: Ollama chat <-> OpenAI chat (llama.cpp) ----
// Ollama sends images as a base64 array and tool arguments as an object;
// OpenAI wants content parts and a JSON string. These helpers keep both
// directions honest so tool calling and vision survive the hop.
function toOpenAIMessages(messages) {
  return (messages || []).map((m) => {
    const out = { role: m.role, content: m.content };
    if (Array.isArray(m.images) && m.images.length) {
      const parts = [{ type: 'text', text: m.content || '' }];
      for (const b64 of m.images) {
        parts.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } });
      }
      out.content = parts;
    }
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      out.tool_calls = m.tool_calls.map((c) => ({
        id: c.id || 'call_' + Math.random().toString(16).slice(2),
        type: 'function',
        function: {
          name: (c.function || {}).name,
          arguments: typeof (c.function || {}).arguments === 'string'
            ? (c.function || {}).arguments
            : JSON.stringify((c.function || {}).arguments || {}),
        },
      }));
    }
    if (m.role === 'tool' && m.tool_call_id) out.tool_call_id = m.tool_call_id;
    return out;
  });
}

function toOpenAITools(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((t) => {
    const fn = t.function || {};
    return {
      type: 'function',
      function: {
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters,
      },
    };
  });
}

function toOllamaToolCalls(calls) {
  if (!Array.isArray(calls)) return undefined;
  return calls.map((c) => {
    const fn = c.function || {};
    let args = fn.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { args = {}; }
    }
    return { id: c.id, function: { name: fn.name, arguments: args || {} } };
  });
}

function ollamaBodyToOpenaiBody(body) {
  const opts = body.options || {};
  const out = {
    model: body.model,
    messages: toOpenAIMessages(body.messages),
    stream: body.stream !== false,
  };
  if (opts.temperature !== undefined) out.temperature = opts.temperature;
  if (opts.top_p !== undefined) out.top_p = opts.top_p;
  if (opts.num_predict !== undefined) out.max_tokens = opts.num_predict;
  if (opts.seed !== undefined) out.seed = opts.seed;
  if (opts.stop !== undefined) out.stop = opts.stop;
  const tools = toOpenAITools(body.tools);
  if (tools) {
    out.tools = tools;
    out.tool_choice = body.tool_choice || 'auto';
  }
  return out;
}

// OpenAI chat request -> Ollama chat request
function openaiBodyToOllamaBody(body) {
  const messages = (body.messages || []).map((m) => {
    const out = { role: m.role, content: m.content };
    if (Array.isArray(m.content)) {
      // OpenAI content parts -> Ollama text plus an image list
      let text = '';
      const images = [];
      for (const part of m.content) {
        if (part.type === 'text') text += part.text || '';
        else if (part.type === 'image_url' && part.image_url) {
          const url = String(part.image_url.url || '');
          const b64 = url.startsWith('data:') ? url.slice(url.indexOf(',') + 1) : url;
          if (b64) images.push(b64);
        }
      }
      out.content = text;
      if (images.length) out.images = images;
    }
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      out.tool_calls = m.tool_calls.map((c) => {
        const fn = c.function || {};
        let args = fn.arguments;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { args = {}; }
        }
        return { id: c.id, function: { name: fn.name, arguments: args || {} } };
      });
    }
    if (m.role === 'tool' && m.tool_call_id) out.tool_call_id = m.tool_call_id;
    return out;
  });
  const options = {};
  if (body.temperature !== undefined) options.temperature = body.temperature;
  if (body.top_p !== undefined) options.top_p = body.top_p;
  if (body.max_tokens !== undefined) options.num_predict = body.max_tokens;
  if (body.seed !== undefined) options.seed = body.seed;
  if (body.stop !== undefined) options.stop = body.stop;
  const out = { model: body.model, messages, stream: body.stream !== false };
  if (Object.keys(options).length) out.options = options;
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => {
      const fn = t.function || {};
      return { type: 'function', function: { name: fn.name, description: fn.description, parameters: fn.parameters } };
    });
  }
  return out;
}

// Which backend should serve this request? The page states its preference in
// the body; otherwise the model name decides, and Ollama is the fallback.
async function pickBackend(body, model) {
  const want = String(body.backend || '').toLowerCase();
  if (want === 'ollama' || want === 'llama.cpp') return want;
  if (model) {
    const all = await listAllModels().catch(() => []);
    const hit = all.find((m) => m.model === model || m.name === model);
    if (hit) return hit.backend;
  }
  return 'ollama';
}

// POST a JSON body to a backend and pipe the answer back, optionally rewriting
// the response on the way through.
function proxyJson(host, pathname, bodyBuf, res, opts = {}) {
  const target = new URL(pathname, host);
  const client = getHttpClient(target);
  const upstream = client.request(
    target,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': bodyBuf.length },
    },
    (ur) => {
      if (opts.transform) {
        res.writeHead(ur.statusCode || 200, { 'Content-Type': opts.contentType || 'application/x-ndjson' });
        opts.transform(ur);
        return;
      }
      res.writeHead(ur.statusCode || 502, ur.headers);
      ur.pipe(res);
    }
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (opts.label || 'backend') + ' unreachable at ' + host }));
  });
  upstream.end(bodyBuf);
}

// OpenAI SSE -> Ollama NDJSON.
// llama.cpp streams tool calls as fragments keyed by index; they only become
// usable once the arguments are assembled, so they are buffered and emitted
// whole in the final chunk.
function pipeSseAsOllama(upstream, res, model) {
  let buf = '';
  const pending = new Map();
  let evalCount = 0;
  const started = Date.now();
  let finished = false;
  const write = (obj) => res.write(JSON.stringify(obj) + '\n');
  const finish = () => {
    if (finished) return;
    finished = true;
    const calls = [...pending.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, c]) => ({
        id: c.id || 'call_' + i,
        function: { name: c.name, arguments: safeJson(c.args) },
      }));
    pending.clear();
    const chunk = {
      model,
      created_at: new Date().toISOString(),
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: 'stop',
      total_duration: (Date.now() - started) * 1e6,
      eval_count: evalCount,
    };
    if (calls.length) chunk.message.tool_calls = calls;
    write(chunk);
    res.end();
  };
  upstream.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let oj;
      try { oj = JSON.parse(payload); } catch { continue; }
      if (oj.usage && oj.usage.completion_tokens) evalCount = oj.usage.completion_tokens;
      const choice = (oj.choices || [])[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      const base = { model: oj.model || model, created_at: new Date().toISOString(), done: false };
      if (delta.content) {
        write({ ...base, message: { role: 'assistant', content: delta.content } });
      }
      if (delta.reasoning_content) {
        write({ ...base, message: { role: 'assistant', content: '', thinking: delta.reasoning_content } });
      }
      for (const tc of delta.tool_calls || []) {
        const idx = tc.index == null ? 0 : tc.index;
        const cur = pending.get(idx) || { id: tc.id, name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function && tc.function.name) cur.name += tc.function.name;
        if (tc.function && tc.function.arguments) cur.args += tc.function.arguments;
        pending.set(idx, cur);
      }
    }
  });
  upstream.on('end', finish);
  upstream.on('error', finish);
}

// Ollama NDJSON -> OpenAI SSE (the page never needs this, but an OpenAI-style
// client pointed at an Ollama backend does).
function pipeOllamaAsSse(upstream, res, model) {
  let buf = '';
  const id = 'chatcmpl-' + Math.random().toString(16).slice(2);
  const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
  upstream.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.error) {
        send({ error: j.error });
        continue;
      }
      const msg = j.message || {};
      const out = {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: j.model || model,
        choices: [{ index: 0, delta: {}, finish_reason: null }],
      };
      if (msg.role) out.choices[0].delta.role = msg.role;
      if (msg.content) out.choices[0].delta.content = msg.content;
      if (msg.thinking) out.choices[0].delta.reasoning_content = msg.thinking;
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        out.choices[0].delta.tool_calls = msg.tool_calls.map((c, i) => ({
          index: i,
          id: c.id,
          type: 'function',
          function: { name: (c.function || {}).name, arguments: JSON.stringify((c.function || {}).arguments || {}) },
        }));
      }
      if (j.done) {
        out.choices[0].finish_reason = 'stop';
        send(out);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      send(out);
    }
  });
  upstream.on('end', () => {
    res.write('data: [DONE]\n\n');
    res.end();
  });
}

// A JSON body that may or may not be valid JSON.
function safeJson(text) {
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}

function pipeJsonAsOllama(upstream, res, model) {
  let data = '';
  upstream.on('data', (d) => (data += d));
  upstream.on('end', () => {
    let out;
    try {
      const oj = JSON.parse(data);
      const msg = (oj.choices || [])[0] && (oj.choices || [])[0].message;
      out = {
        model: oj.model || model,
        created_at: new Date().toISOString(),
        message: {
          role: (msg && msg.role) || 'assistant',
          content: (msg && msg.content) || '',
          tool_calls: toOllamaToolCalls(msg && msg.tool_calls),
        },
        done: true,
        done_reason: 'stop',
      };
    } catch (e) {
      out = { error: 'llama.cpp returned an unreadable answer', raw: data.slice(0, 400) };
    }
    res.end(JSON.stringify(out));
  });
}

function pipeJsonAsOpenai(upstream, res, model) {
  let data = '';
  upstream.on('data', (d) => (data += d));
  upstream.on('end', () => {
    let out;
    try {
      const oj = JSON.parse(data);
      const msg = oj.message || {};
      out = {
        id: 'chatcmpl-' + Math.random().toString(16).slice(2),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: oj.model || model,
        choices: [{
          index: 0,
          message: {
            role: msg.role || 'assistant',
            content: msg.content || '',
            tool_calls: (msg.tool_calls || []).map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: (c.function || {}).name, arguments: JSON.stringify((c.function || {}).arguments || {}) },
            })),
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: oj.prompt_eval_count || 0, completion_tokens: oj.eval_count || 0 },
      };
    } catch (e) {
      out = { error: 'Ollama returned an unreadable answer', raw: data.slice(0, 400) };
    }
    res.end(JSON.stringify(out));
  });
}

// OpenAI's completions dialect -> Ollama's generate dialect.
function pipeCompletionsAsOllama(upstream, res, model) {
  let buf = '';
  upstream.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let oj;
      try { oj = JSON.parse(payload); } catch { continue; }
      const choice = (oj.choices || [])[0] || {};
      res.write(JSON.stringify({
        model: oj.model || model,
        created_at: new Date().toISOString(),
        response: choice.text || '',
        done: false,
      }) + '\n');
    }
  });
  upstream.on('end', () => {
    res.write(JSON.stringify({
      model,
      created_at: new Date().toISOString(),
      response: '',
      done: true,
      done_reason: 'stop',
    }) + '\n');
    res.end();
  });
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/ytsearch') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return sendJSON(res, 400, { error: 'missing q' });
    ytSearch(q).then(
      (results) => sendJSON(res, 200, { query: q, results }),
      (e) => sendJSON(res, 502, { error: e.message })
    );
    return;
  }
  // Unified model listing from both backends (auto-detect)
  if (url.pathname === '/api/models' || url.pathname === '/api/v1/models') {
    listAllModels().then(
      (models) => sendJSON(res, 200, { models, ollama: OLLAMA_HOST, llama_cpp: LLAMA_CPP_HOST, detected: true }),
      (e) => sendJSON(res, 502, { error: e.message, ollama: OLLAMA_HOST, llama_cpp: LLAMA_CPP_HOST })
    );
    return;
  }
  if (url.pathname === '/api/inference/status') {
    Promise.allSettled([
      fetchJSON(OLLAMA_HOST + '/api/version').then(() => ({ ok: true, host: OLLAMA_HOST })).catch(() => ({ ok: false, host: OLLAMA_HOST })),
      llamaAlive(3000).then((ok) => ({ ok, host: LLAMA_CPP_HOST })),
    ]).then(([ollama, llama]) => {
      sendJSON(res, 200, { ollama: ollama.value, llama_cpp: llama.value });
    });
    return;
  }
  // The GGUF models on this machine that llama.cpp could serve. The picker
  // shows these so the user can choose one, rather than being handed whatever
  // happened to be found first.
  if (url.pathname === '/api/llama/models') {
    const local = localChatModels();
    llamaServedModels().then((served) => {
      sendJSON(res, 200, {
        host: LLAMA_CPP_HOST,
        running: llamaProc ? !llamaProc.killed : false,
        managed: !!llamaProc,
        current: llamaAlias,
        served,
        models: local.map((m) => ({
          name: m.name,
          path: m.path,
          size: m.size,
          // the running server advertises this model by name
          active: served.includes(m.name) || (llamaAlias && llamaAlias === m.name),
        })),
      });
    });
    return;
  }
  // Start (or switch) the llama.cpp server on a chosen GGUF.
  if (url.pathname === '/api/llama/start') {
    if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'POST only' });
    readBody(req, (body) => {
      if (body === null) return sendJSON(res, 413, { ok: false, error: 'request body too large' });
      let name = '';
      try { name = String(JSON.parse(body || '{}').model || ''); }
      catch (e) { return sendJSON(res, 400, { ok: false, error: 'invalid JSON' }); }
      // an empty model means "just start something sensible" — the first
      // chat GGUF that actually loads, best-first
      const local = name ? resolveLocalModel(name) : null;
      if (!local && name) return sendJSON(res, 404, { ok: false, error: 'no local GGUF named "' + name + '"' });
      const modelPath = local ? local.path : null;
      const modelName = local ? local.name : null;
      ensureLlamaServer(modelPath, modelName).then(
        (host) => {
          noteBackend('llama.cpp', modelName || llamaAlias || '');
          sendJSON(res, 200, { ok: true, host, model: modelName || llamaAlias || null });
        },
        (e) => sendJSON(res, 503, { ok: false, error: e.message })
      );
    });
    return;
  }
  // Stop the llama.cpp server we started (never one the user runs themselves).
  if (url.pathname === '/api/llama/stop') {
    if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'POST only' });
    if (!llamaProc) return sendJSON(res, 200, { ok: true, stopped: false, note: 'no managed llama-server' });
    try { llamaProc.kill('SIGTERM'); } catch { /* already gone */ }
    llamaProc = null;
    llamaModel = null;
    llamaAlias = null;
    sendJSON(res, 200, { ok: true, stopped: true });
    return;
  }
  // Ollama tags - return combined for compatibility
  if (url.pathname === '/api/tags') {
    listAllModels().then(
      (all) => {
        // Return all models in Ollama format for compatibility
        const models = all.map((m) => ({
          name: m.name,
          model: m.model,
          details: m.details || { backend: m.backend },
          size: m.size,
          digest: m.digest,
        }));
        sendJSON(res, 200, { models });
      },
      (e) => sendJSON(res, 502, { error: e.message })
    );
    return;
  }
  // the curated shortcuts here — the page builds its open_app tool from this
  if (url.pathname === '/api/apps') {
    return sendJSON(res, 200, {
      platform: process.platform,
      generic: true,
      apps: LOCAL_APPS.filter((a) => attemptsFor(a).length)
        .map((a) => ({ id: a.id, label: a.label, aliases: [a.id, ...a.aliases] })),
    });
  }
  if (url.pathname === '/api/cli-anything') {
    return sendJSON(res, 200, {
      apps: cliAnything.discover().map(({ id }) => ({ id, label: id.replace(/[-_]+/g, ' ') })),
    });
  }
  if (url.pathname === '/api/cli-anything/run') {
    if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'POST only' });
    readBody(req, (body) => {
      if (body === null) return sendJSON(res, 413, { ok: false, error: 'request body too large' });
      let input;
      try { input = JSON.parse(body || '{}'); }
      catch { return sendJSON(res, 400, { ok: false, error: 'invalid JSON' }); }
      cliAnything.run(input.app, input.args).then(
        (result) => sendJSON(res, 200, { ok: result.code === 0, ...result }),
        (error) => sendJSON(res, 400, { ok: false, error: error.message })
      );
    });
    return;
  }
  if (url.pathname === '/api/launch') {
    if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, reason: 'method', message: 'POST only' });
    readBody(req, (body) => {
      if (body === null) return sendJSON(res, 413, { ok: false, reason: 'too-large', message: 'request body too large' });
      let name = '';
      try { name = String(JSON.parse(body || '{}').name || ''); }
      catch (e) { return sendJSON(res, 400, { ok: false, reason: 'bad-json', message: 'invalid JSON' }); }
      launchApp(name).then(
        (r) => sendJSON(res, r.code, r.body),
        (e) => sendJSON(res, 500, { ok: false, reason: 'error', message: e.message })
      );
    });
    return;
  }
  // ---- DigUp: search the user's own files, on this machine ----
  if (url.pathname === '/api/digup') {
    digup.status().then(
      (s) => sendJSON(res, 200, s),
      (e) => sendJSON(res, 200, { ok: false, error: e.message })
    );
    return;
  }
  if (url.pathname === '/api/digup/search') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return sendJSON(res, 400, { ok: false, error: 'missing q' });
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 8));
    digup
      .search(q, {
        limit,
        all: url.searchParams.get('all') === '1',
        code: url.searchParams.get('code') === '1',
        filenames: url.searchParams.get('filenames') === '1',
      })
      .then(
        (hits) => sendJSON(res, 200, { ok: true, query: q, hits }),
        (e) => sendJSON(res, e.code === 'MODEL_MISMATCH' ? 409 : 503, { ok: false, error: e.message })
      );
    return;
  }
  if (url.pathname === '/api/digup/index') {
    if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'POST only' });
    readBody(req, (body) => {
      if (body === null) return sendJSON(res, 413, { ok: false, error: 'request body too large' });
      let reindex = false;
      try { reindex = !!JSON.parse(body || '{}').reindex; }
      catch { return sendJSON(res, 400, { ok: false, error: 'invalid JSON' }); }
      const job = reindex ? digup.reindex() : Promise.resolve(digup.indexNow());
      job.then(
        (r) => sendJSON(res, 200, { ok: true, indexing: r }),
        (e) => sendJSON(res, 503, { ok: false, error: e.message })
      );
    });
    return;
  }
  if (url.pathname === '/api/digup/roots') {
    if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'POST only' });
    readBody(req, (body) => {
      if (body === null) return sendJSON(res, 413, { ok: false, error: 'request body too large' });
      let msg;
      try { msg = JSON.parse(body || '{}'); }
      catch { return sendJSON(res, 400, { ok: false, error: 'invalid JSON' }); }
      const action = String(msg.action || 'add');
      const job = action === 'remove'
        ? digup.removeRoot(msg.path)
        : digup.addRoot(msg.path, { code: !!msg.code });
      job.then(
        (roots) => sendJSON(res, 200, { ok: true, roots }),
        (e) => sendJSON(res, 400, { ok: false, error: e.message })
      );
    });
    return;
  }
  if (url.pathname === '/api/digup/open') {
    if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'POST only' });
    readBody(req, (body) => {
      if (body === null) return sendJSON(res, 413, { ok: false, error: 'request body too large' });
      let id = 0;
      try { id = Number(JSON.parse(body || '{}').id); }
      catch { return sendJSON(res, 400, { ok: false, error: 'invalid JSON' }); }
      digup.fileById(id).then(
        (f) => {
          if (!f) return sendJSON(res, 404, { ok: false, error: 'that file is not in the DigUp index' });
          const argv = process.platform === 'darwin' ? ['open', f.path]
            : process.platform === 'win32' ? ['cmd', '/c', 'start', '', f.path]
            : ['xdg-open', f.path];
          trySpawn(argv).then((r) =>
            sendJSON(res, r.ok ? 200 : 502, r.ok
              ? { ok: true, path: f.path }
              : { ok: false, error: r.msg })
          );
        },
        (e) => sendJSON(res, 503, { ok: false, error: e.message })
      );
    });
    return;
  }
  if (url.pathname === '/api/chat' || url.pathname === '/api/generate' || url.pathname === '/v1/chat/completions') {
    if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'POST only' });
    handleChat(req, res, url).catch((e) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }
  if (url.pathname.startsWith('/api/')) return proxy(req, res);
  return serveStatic(req, res, url.pathname);
});

// ---- chat routing ----
// The page posts to /api/chat in Ollama's dialect and expects Ollama's NDJSON
// back; an OpenAI-style client posts to /v1/chat/completions and expects SSE.
// Whichever endpoint was used, the body is translated into whatever the chosen
// backend actually speaks, and the answer is translated back.
async function handleChat(req, res, url) {
  let raw;
  try {
    raw = await readBodyBuf(req);
  } catch (e) {
    return sendJSON(res, 413, { ok: false, error: e.message });
  }
  let parsed = {};
  try { parsed = JSON.parse(raw.toString('utf8') || '{}'); } catch { parsed = {}; }
  const model = String(parsed.model || '');
  const target = await pickBackend(parsed, model);
  const openaiIn = url.pathname === '/v1/chat/completions';
  const streaming = parsed.stream !== false;

  // --- Ollama backend -----------------------------------------------------
  noteBackend('ollama', model);
  if (target === 'ollama') {
    if (openaiIn) {
      // OpenAI in -> Ollama in -> SSE out
      const body = openaiBodyToOllamaBody(parsed);
      const buf = Buffer.from(JSON.stringify(body));
      if (!streaming) {
        return proxyJson(OLLAMA_HOST, '/api/chat', buf, res, {
          contentType: 'application/json',
          label: 'Ollama',
          transform: (ur) => pipeJsonAsOpenai(ur, res, model),
        });
      }
      return proxyJson(OLLAMA_HOST, '/api/chat', buf, res, {
        contentType: 'text/event-stream',
        label: 'Ollama',
        transform: (ur) => pipeOllamaAsSse(ur, res, model),
      });
    }
    // Ollama in -> Ollama in. /api/chat is NDJSON, /api/generate is JSON.
    const body = { ...parsed };
    delete body.backend;                       // our routing hint, not Ollama's
    const buf = Buffer.from(JSON.stringify(body));
    return proxyJson(OLLAMA_HOST, url.pathname, buf, res, { label: 'Ollama' });
  }

  // --- llama.cpp backend ---------------------------------------------------
  // llama.cpp only speaks OpenAI's dialect.
  noteBackend('llama.cpp', model);
  const local = resolveLocalModel(model);
  if (local) {
    // The user picked a specific GGUF — make sure the server serves it.
    try {
      await ensureLlamaServer(local.path, local.name);
    } catch (e) {
      return sendJSON(res, 503, { ok: false, error: 'llama.cpp: ' + e.message });
    }
  } else if (!(await llamaAlive())) {
    // Nothing running and no local file by that name — fall back to the default.
    const started = await ensureLlamaServer().catch(() => null);
    if (!started) {
      return sendJSON(res, 503, {
        ok: false,
        error: 'llama.cpp is not running and no local model matched "' + model + '".',
      });
    }
  }

  if (openaiIn) {
    // OpenAI in -> OpenAI in: the body is already right, pass it through.
    return proxyJson(LLAMA_CPP_HOST, '/v1/chat/completions', raw, res, { label: 'llama.cpp' });
  }

  if (url.pathname === '/api/generate') {
    // Ollama's prompt-completion dialect -> OpenAI's completions dialect.
    const body = {
      model,
      prompt: parsed.prompt || '',
      stream: streaming,
      temperature: (parsed.options || {}).temperature,
      top_p: (parsed.options || {}).top_p,
      max_tokens: (parsed.options || {}).num_predict,
      stop: (parsed.options || {}).stop,
    };
    Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);
    const buf = Buffer.from(JSON.stringify(body));
    return proxyJson(LLAMA_CPP_HOST, '/v1/completions', buf, res, {
      contentType: 'application/x-ndjson',
      label: 'llama.cpp',
      transform: (ur) => pipeCompletionsAsOllama(ur, res, model),
    });
  }

  // Ollama in -> OpenAI in -> NDJSON out
  const body = ollamaBodyToOpenaiBody(parsed);
  const buf = Buffer.from(JSON.stringify(body));
  if (!streaming) {
    return proxyJson(LLAMA_CPP_HOST, '/v1/chat/completions', buf, res, {
      contentType: 'application/json',
      label: 'llama.cpp',
      transform: (ur) => pipeJsonAsOllama(ur, res, model),
    });
  }
  return proxyJson(LLAMA_CPP_HOST, '/v1/chat/completions', buf, res, {
    contentType: 'application/x-ndjson',
    label: 'llama.cpp',
    transform: (ur) => pipeSseAsOllama(ur, res, model),
  });
}

// One-shot (non-streaming) conversions.
let port = Number(process.env.PORT) || 5177;
function listen() {
  server.listen(port, () => {
    console.log(`Arki chat  →  http://localhost:${port}`);
    console.log(`Ollama     →  ${OLLAMA_HOST}`);
    console.log(`llama.cpp  →  ${LLAMA_CPP_HOST}`);
  });
}
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && port < 65535) {
    console.warn(`Port ${port} busy, trying ${port + 1}…`);
    port++;
    listen();
  } else {
    console.error(err);
    process.exit(1);
  }
});
// llama.cpp is started on demand — when the user picks it in the UI, presses
// start, or sends a message routed to it. Booting it eagerly would load a
// model into memory the user may not want (they might only use Ollama).
// The one exception: the state file says llama.cpp was the last backend the
// user actually used. Then warm it back up, so a restart does not return the
// "isn't serving" banner they just got rid of.
listen();
(function warmLlama() {
  const st = loadBackendState();
  if (st.backend !== 'llama.cpp') return;   // Ollama users get no extra model load
  const local = st.model ? resolveLocalModel(st.model) : null;
  (async () => {
    const host = await ensureLlamaServer(local ? local.path : null, local ? local.name : undefined)
      .catch((e) => { console.log(`llama.cpp  →  not warmed (${e.message}) — the start button still works`); return null; });
    if (host) console.log(`llama.cpp  →  warm start ready at ${host}${local ? ' with ' + local.name : ''}`);
  })();
})();

// stop any managed processes and close the index cleanly
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      if (llamaProc && !llamaProc.killed) {
        llamaProc.kill('SIGTERM');
      }
    } catch (e) {
      // ignore
    }
    digup.shutdown().finally(() => process.exit(0));
  });
}
