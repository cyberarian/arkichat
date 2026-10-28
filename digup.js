'use strict';
/**
 * DigUp bridge — lets Arki search the user's own files by what's inside them.
 *
 * digup-js is ESM and talks to node:sqlite, an embedding model or the model-free
 * hash stand-in, and optionally ffmpeg/poppler for media and PDFs. It is loaded
 * lazily on the first DigUp API call so the chat app still starts (and works)
 * with Node 18, or before `npm install --prefix digup-js` has been run.
 *
 * Everything stays on this machine: the index lives in ~/.digup/index.sqlite and
 * the folders are the ones the user chose through the sidebar or `digup add`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const DIR = path.join(__dirname, 'digup-js');
const HOME_DIR = process.env.DIGUP_HOME || path.join(os.homedir(), '.digup');
const DB_FILE = path.join(HOME_DIR, 'index.sqlite');
const CFG_FILE = path.join(HOME_DIR, 'config.json');

const st = {
  booted: false,
  config: null,
  db: null,
  embedder: null,
  searcher: null,
  indexer: null,
  searchMod: null,
  cfg: null,
  lexical: false,
};

const run = {
  indexing: false,
  phase: 'idle',
  done: 0,
  total: 0,
  scanned: 0,
  indexed: 0,
  startedAt: 0,
  finishedAt: 0,
  error: null,
  last: '',
};

let booting = null;
let lastIndexedAt = 0;

function friendly(err) {
  const msg = (err && err.message) || String(err);
  if (/Cannot find package 'fflate'|ERR_MODULE_NOT_FOUND/i.test(msg))
    return 'DigUp dependencies are missing — run `npm install --prefix digup-js` once.';
  if (/node:sqlite|DatabaseSync|No such built-in module/i.test(msg))
    return 'DigUp needs Node 22.13 or newer (it uses the built-in `node:sqlite`).';
  if (/fetch failed|ECONNREFUSED/i.test(msg))
    return 'Ollama is unreachable — start it with `ollama serve`, or set DIGUP_EMBEDDER=hash for lexical search.';
  return msg;
}

function expandHome(raw) {
  const s = String(raw || '').trim();
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return s;
}

function readConfiguredRoots() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
    return Array.isArray(cfg.roots) ? cfg.roots : [];
  } catch {
    return [];
  }
}

/** Whether anything has asked DigUp to index something — config or env. */
function hasRootsRequest() {
  return readConfiguredRoots().length > 0 || String(process.env.DIGUP_ROOTS || '').trim() !== '';
}

/** Node 22.13+ (node:sqlite) and the one npm package readers.js needs. */
function depsReady() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const nodeOk = major > 22 || (major === 22 && minor >= 13);
  let fflate = false;
  try {
    require.resolve('fflate', { paths: [DIR] });
    fflate = true;
  } catch {
    /* not installed yet */
  }
  return nodeOk && fflate;
}

async function leanStatus(roots) {
  const ready = depsReady();
  const llama = !!(process.env.DIGUP_MODEL || process.env.DIGUP_EMBED_URL);
  let embedder = null;
  let media = false;
  let lexical = process.env.DIGUP_EMBEDDER === 'hash' || llama;
  if (ready && !lexical) {
    const em = await import(pathToFileURL(path.join(DIR, 'src', 'embedder.js')).href);
    const ollama = new em.OllamaEmbedder();
    if (await ollama.available()) {
      embedder = ollama.id;
      media = !!ollama.media;
      lexical = false;
    } else if (process.env.DIGUP_EMBEDDER === 'ollama') {
      embedder = ollama.id;
    } else {
      lexical = true;
    }
  }
  return {
    ok: true,
    home: HOME_DIR,
    db: DB_FILE,
    roots,
    embedder,
    media,
    lexical,
    model: null,
    modelReady: true,
    files: 0,
    chunks: 0,
    stats: [],
    pending: 0,
    indexing: publicRun(),
    indexedAt: null,
    setup: ready,
    hint: !ready
      ? 'DigUp needs Node 22.13+ and one dependency — run `npm install --prefix digup-js` once.'
      : lexical
        ? 'No folders yet. Press + folder to begin; run `ollama pull embeddinggemma-2` for semantic search.'
        : 'No folders yet. Press + folder to choose what DigUp may read.',
  };
}

function resolveDir(raw, { mustExist = true } = {}) {
  const p = expandHome(raw);
  if (!p) throw new Error('a folder path is required');
  const abs = path.resolve(p);
  if (!mustExist) return abs;
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new Error('no such folder: ' + abs);
  }
  if (!stat.isDirectory()) throw new Error('not a folder: ' + abs);
  return abs;
}

/** Explicit choice first; otherwise use the Ollama embedding model when it is
 *  pulled, and fall back to the lexical hash stand-in when it is not. */
async function pickEmbedder(em) {
  const configured = process.env.DIGUP_EMBEDDER;
  if (configured === 'hash') {
    st.lexical = true;
    return new em.HashEmbedder();
  }
  if (configured === 'ollama') {
    st.lexical = false;
    return new em.OllamaEmbedder();
  }
  if (process.env.DIGUP_MODEL || process.env.DIGUP_EMBED_URL) {
    st.lexical = false;
    return em.makeEmbedder();
  }
  const ollama = new em.OllamaEmbedder();
  if (await ollama.available()) {
    st.lexical = false;
    return ollama;
  }
  st.lexical = true;
  return new em.HashEmbedder();
}

async function boot() {
  if (st.booted) return st;
  if (booting) return booting;
  booting = (async () => {
    const imp = (file) => import(pathToFileURL(path.join(DIR, 'src', file)).href);
    const [config, dbMod, embedder, indexer, search] = await Promise.all([
      imp('config.js'),
      imp('db.js'),
      imp('embedder.js'),
      imp('indexer.js'),
      imp('search.js'),
    ]);

    const cfg = config.loadConfig();
    if (!Array.isArray(cfg.roots)) cfg.roots = [];
    if (!Array.isArray(cfg.skipDirs)) cfg.skipDirs = [];
    if (!Array.isArray(cfg.skipExts)) cfg.skipExts = [];

    // DIGUP_ROOTS=/a:/b makes a headless setup possible without touching the UI.
    const envRoots = String(process.env.DIGUP_ROOTS || '')
      .split(path.delimiter)
      .map((s) => s.trim())
      .filter(Boolean);
    let changed = false;
    for (const raw of envRoots) {
      try {
        const p = resolveDir(raw);
        if (!cfg.roots.some((r) => r.path === p)) {
          cfg.roots.push({ path: p, code: false });
          changed = true;
        }
      } catch {
        /* a stale env root should not stop the app from booting */
      }
    }
    if (changed) config.saveConfig(cfg);

    const embedderInstance = await pickEmbedder(embedder);
    const db = dbMod.openDb(config.DB_PATH);
    const searcher = new search.Searcher(db, embedderInstance);
    const ix = new indexer.Indexer(db, embedderInstance, { log: progressLog });

    Object.assign(st, {
      booted: true,
      config,
      db,
      embedder: embedderInstance,
      searcher,
      indexer: ix,
      searchMod: search,
      cfg,
    });
    return st;
  })().catch((e) => {
    st.booted = false;
    booting = null;
    const err = new Error(friendly(e));
    err.code = e.code;
    throw err;
  });
  return booting;
}

function progressLog(line) {
  run.last = String(line || '').slice(0, 300);
  const m = /^\[(\d+)\/(\d+)\]/.exec(run.last);
  if (m) {
    run.done = Number(m[1]);
    run.total = Number(m[2]);
  }
}

function assertModel() {
  const saved = st.db.meta('model');
  if (saved && saved !== st.embedder.id) {
    const err = new Error(
      `This DigUp index was built with ${saved}, but this run uses ${st.embedder.id}. ` +
        'Rebuild it (open folders → rebuild entire index in the sidebar, or run `npm run digup -- reindex`).'
    );
    err.code = 'MODEL_MISMATCH';
    throw err;
  }
}

function publicRun() {
  return { ...run };
}

async function status() {
  const configured = readConfiguredRoots();
  // Opening the page must not create ~/.digup on its own: with no folders and
  // no existing index there is nothing to report, so don't touch the disk.
  if (!st.booted && !hasRootsRequest() && !fs.existsSync(DB_FILE)) {
    return await leanStatus(configured);
  }
  try {
    await boot();
  } catch (e) {
    return { ok: false, error: e.message, hint: e.message };
  }
  try {
    const stats = st.db.stats();
    const files = stats.reduce((n, r) => n + Number(r.files || 0), 0);
    const chunks = stats.reduce((n, r) => n + Number(r.chunks || 0), 0);
    const model = st.db.meta('model');
    return {
      ok: true,
      home: st.config.HOME,
      db: st.config.DB_PATH,
      roots: st.cfg.roots.map((r) => ({ path: r.path, code: !!r.code })),
      embedder: st.embedder.id,
      media: !!st.embedder.media,
      mediaError: st.embedder.mediaError || null,
      pendingMedia: st.db.pendingMedia(),
      lexical: st.lexical,
      model,
      modelReady: !model || model === st.embedder.id,
      files,
      chunks,
      stats,
      pending: st.db.pendingFiles().length,
      indexing: publicRun(),
      indexedAt: lastIndexedAt || null,
      setup: true,
      hint: st.lexical
        ? 'DigUp is using its lexical hash stand-in. Run `ollama pull embeddinggemma-2` and restart Arki for semantic search, or set DIGUP_EMBED_MODEL to another Ollama embedding model.'
        : st.embedder.mediaError
          ? 'This Ollama model could not embed images or audio: ' + st.embedder.mediaError
          : null,
    };
  } catch (e) {
    return { ok: false, error: friendly(e) };
  }
}

async function search(query, { limit = 8, all = false, code = false, filenames = false } = {}) {
  let q = String(query || '').trim();
  if (!q) return [];
  if (!st.booted && !hasRootsRequest() && !fs.existsSync(DB_FILE)) return [];
  await boot();
  if (!filenames) assertModel();
  if (code && !filenames && !/^code:\s*/i.test(q)) q = 'code: ' + q;
  // Filename-only lookups do not need an embedding model.
  const hasVec = !filenames && st.db.db.prepare('SELECT 1 FROM chunks WHERE vec IS NOT NULL LIMIT 1').get();
  if (hasVec) await st.embedder.start();
  const hits = await st.searcher.search(q, {
    limit: Math.max(1, Math.min(50, Number(limit) || 8)),
    all: !!all,
    filenames: !!filenames,
  });
  return hits.map((h) => ({ ...h, where: st.searchMod.fmtLoc(h.loc) }));
}

/** Starts an index run and returns immediately; poll status() for progress. */
function indexNow() {
  if (run.indexing) return publicRun();
  Object.assign(run, {
    indexing: true,
    phase: 'starting',
    done: 0,
    total: 0,
    scanned: 0,
    indexed: 0,
    startedAt: Date.now(),
    finishedAt: 0,
    error: null,
    last: '',
  });
  (async () => {
    try {
      // don't create an empty index just because someone pressed index before
      // choosing a folder
      if (!st.booted && !hasRootsRequest() && !fs.existsSync(DB_FILE)) {
        run.phase = 'empty';
        return;
      }
      await boot();
      if (!st.cfg.roots.length) {
        run.phase = 'empty';
        return;
      }
      assertModel();
      await st.embedder.start();
      st.db.setMeta('model', st.embedder.id);
      run.phase = 'indexing';
      for (const root of st.cfg.roots) {
        const res = await st.indexer.indexRoot(root, st.cfg);
        run.scanned += Number(res.scanned || 0);
        run.indexed += Number(res.indexed || 0);
      }
      run.phase = 'finishing';
      await st.indexer.finishPending();
      run.phase = 'done';
      lastIndexedAt = Date.now();
    } catch (e) {
      run.phase = 'error';
      run.error = friendly(e);
    } finally {
      run.indexing = false;
      run.finishedAt = Date.now();
    }
  })();
  return publicRun();
}

async function addRoot(raw, { code = false } = {}) {
  const p = resolveDir(raw);
  await boot();
  const existing = st.cfg.roots.find((r) => r.path === p);
  if (existing) existing.code = !!code;
  else st.cfg.roots.push({ path: p, code: !!code });
  st.config.saveConfig(st.cfg);
  return st.cfg.roots.map((r) => ({ path: r.path, code: !!r.code }));
}

async function removeRoot(raw) {
  const p = resolveDir(raw, { mustExist: false });
  await boot();
  for (const f of st.db.rootFiles(p)) st.db.removeFile(f.id);
  st.cfg.roots = st.cfg.roots.filter((r) => r.path !== p);
  st.config.saveConfig(st.cfg);
  return st.cfg.roots.map((r) => ({ path: r.path, code: !!r.code }));
}

async function reindex() {
  await boot();
  if (run.indexing) throw new Error('An index run is already in progress.');
  try {
    await st.embedder.stop();
  } catch {
    /* the helper may never have started */
  }
  try {
    st.db.db.close();
  } catch {
    /* already closed */
  }
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(st.config.DB_PATH + suffix, { force: true });
  }
  st.booted = false;
  st.db = null;
  st.embedder = null;
  st.searcher = null;
  st.indexer = null;
  booting = null;
  await boot();
  return indexNow();
}

/** The file row behind a search hit, used to open it with the OS. */
async function fileById(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  await boot();
  return st.db.db.prepare('SELECT id, path, kind FROM files WHERE id = ?').get(n) || null;
}

async function shutdown() {
  try {
    if (st.embedder) await st.embedder.stop();
  } catch {
    /* nothing to stop */
  }
  try {
    if (st.db) st.db.db.close();
  } catch {
    /* already closed */
  }
  st.booted = false;
  booting = null;
}

module.exports = {
  status,
  search,
  indexNow,
  addRoot,
  removeRoot,
  reindex,
  fileById,
  shutdown,
};
