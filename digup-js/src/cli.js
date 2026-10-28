#!/usr/bin/env node
import path from 'node:path';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { loadConfig, saveConfig, DB_PATH, HOME } from './config.js';
import { openDb } from './db.js';
import { makeEmbedder } from './embedder.js';
import { Indexer } from './indexer.js';
import { Searcher, fmtLoc } from './search.js';
import { startServer } from './server.js';
import { DecisionRouter } from './decision.js';

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter(a => a.startsWith('--') && !a.includes('=')));
const kv = Object.fromEntries(rest.filter(a => a.startsWith('--') && a.includes('=')).map(a => a.slice(2).split('=')));
const args = rest.filter(a => !a.startsWith('--'));

const HELP = `digup: search your files by what's in them. Everything runs on this machine.

  digup add <folder> [--code]   choose a folder to search (--code also reads source code there)
  digup remove <folder>         stop searching a folder and drop its index
  digup list                    show folders and what's indexed
  digup index                   read new and changed files (long PDFs get their tail last)
  digup watch                   index, then keep the index fresh as files change
  digup search <words> [--limit=10] [--all] [--open]
                                 start with "code:" to search code, e.g. digup search "code: retry with backoff"
  digup serve [--port=7777]     local search panel in your browser (also keeps indexing)
  digup reindex                 wipe the index and read everything again (after changing the model)

Embeddings: llama.cpp's llama-server running EmbeddingGemma 2. Set DIGUP_MODEL=<gguf> [DIGUP_MMPROJ=<gguf>]
[DIGUP_LLAMA_SERVER=<path>] to have DigUp start it, or DIGUP_EMBED_URL to use one that's running.
DIGUP_EMBEDDER=hash runs a model-free text-only stand-in for trying things out. Data lives in ${HOME}.`;

async function main() {
  if (!cmd || cmd === 'help' || flags.has('--help')) return console.log(HELP);
  const cfg = loadConfig();

  if (cmd === 'add') {
    const p = path.resolve(args[0] || ''); if (!fs.existsSync(p)) throw new Error('No such folder: ' + p);
    cfg.roots = cfg.roots.filter(r => r.path !== p); cfg.roots.push({ path: p, code: flags.has('--code') });
    saveConfig(cfg); return console.log('added', p);
  }
  if (cmd === 'list') {
    cfg.roots.forEach(r => console.log(r.path + (r.code ? '  (code)' : '')));
    const db = openDb(DB_PATH); console.table(db.stats()); return;
  }
  if (cmd === 'remove') {
    const p = path.resolve(args[0] || ''); const db = openDb(DB_PATH);
    for (const f of db.rootFiles(p)) db.removeFile(f.id);
    cfg.roots = cfg.roots.filter(r => r.path !== p); saveConfig(cfg); return console.log('removed', p);
  }
  if (cmd === 'reindex') { fs.rmSync(DB_PATH, { force: true }); fs.rmSync(DB_PATH + '-wal', { force: true }); fs.rmSync(DB_PATH + '-shm', { force: true }); }

  const store = openDb(DB_PATH);
  const emb = makeEmbedder();
  const modelChanged = store.meta('model') && store.meta('model') !== emb.id;
  if (modelChanged) throw new Error(`The index was built with ${store.meta('model')} but this run uses ${emb.id}. Run \`digup reindex\`.`);
  const stop = async () => { await emb.stop(); };
  process.on('SIGINT', async () => { await stop(); process.exit(0); });

  const log = (m) => process.stderr.write(m + '\n');
  const indexAll = async () => {
    const ix = new Indexer(store, emb, { log });
    for (const r of cfg.roots) await ix.indexRoot(r, cfg);
    await ix.finishPending();
  };

  if (cmd === 'index' || cmd === 'reindex') {
    if (!cfg.roots.length) throw new Error('No folders yet. Try: digup add ~/Documents');
    await emb.start(); store.setMeta('model', emb.id);
    await indexAll(); await stop(); return console.log('done'); // the model helper quits when it's done
  }

  if (cmd === 'watch' || cmd === 'serve') {
    await emb.start(); store.setMeta('model', emb.id);
    const searcher = new Searcher(store, emb);
    if (cmd === 'serve') {
      const port = +(kv.port || 7777); startServer({ store, searcher, port });
      console.log(`DigUp panel: http://127.0.0.1:${port}`);
    }
    let busy = false, again = false;
    const kick = async () => {
      if (busy) { again = true; return; } busy = true;
      try { do { again = false; await indexAll(); } while (again); } catch (e) { log(e.message); } finally { busy = false; }
    };
    kick();
    let t;                                                       // a new file is searchable seconds after it lands
    for (const r of cfg.roots) {
      try { fs.watch(r.path, { recursive: true }, () => { clearTimeout(t); t = setTimeout(kick, r.code ? 60000 : 3000); }); }
      catch (e) { log(`can't watch ${r.path}: ${e.message}`); }
    }
    return;
  }

  if (cmd === 'search') {
    const q = args.join(' '); if (!q) throw new Error('digup search <words>');
    await emb.start();
    try {
      const hits = await new Searcher(store, emb).search(q, { limit: +(kv.limit || 10), all: flags.has('--all') });
      if (!hits.length) console.log('No matches.');
      hits.forEach((h, i) => console.log(`${i + 1}. ${h.name}${fmtLoc(h.loc) ? ' · ' + fmtLoc(h.loc) : ''}  [${h.score}]\n   ${h.path}${h.snippet ? '\n   ' + h.snippet : ''}`));
      if (flags.has('--open') && hits[0]) openHit(hits[0]);
    } finally { await stop(); }
    return;
  }
  console.log(HELP);
}

/** Opens a hit at its spot where we know how: video/audio in mpv or VLC at the moment, code in $EDITOR-ish at the line, else the default app. */
function openHit(h) {
  const has = (c) => { try { return spawn(c, ['--version'], { stdio: 'ignore' }).on('error', () => {}) && true; } catch { return false; } };
  const t = h.loc.t ? Math.floor(h.loc.t) : 0;
  if ((h.kind === 'video' || h.kind === 'audio') && t) {
    const p = spawn('mpv', [`--start=${t}`, h.path], { stdio: 'ignore', detached: true });
    p.on('error', () => spawn('vlc', ['--start-time', String(t), h.path], { stdio: 'ignore', detached: true }).on('error', () => defaultOpen(h.path)).unref());
    return p.unref();
  }
  if (h.kind === 'code' && h.loc.line && process.env.DIGUP_EDITOR_CMD)
    return spawn(process.env.DIGUP_EDITOR_CMD, [`${h.path}:${h.loc.line}`], { stdio: 'ignore', detached: true }).unref();
  defaultOpen(h.path);
}
function defaultOpen(p) {
  const [c, a] = process.platform === 'darwin' ? ['open', [p]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', p]] : ['xdg-open', [p]];
  spawn(c, a, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

main().catch(e => { console.error('digup:', e.message); process.exit(1); });
