#!/usr/bin/env node
/**
 * Arki Chat — tiny zero-dependency server.
 * Serves the static UI, proxies /api/* to a local Ollama instance so the browser
 * never hits CORS and streaming responses pass straight through, and adds one
 * helper endpoint (/api/ytsearch) that lets the page play YouTube audio in-place
 * without needing an API key.
 *
 * Env vars:
 *   PORT         — port to listen on (default 5177, auto-increments if busy)
 *   OLLAMA_HOST  — Ollama base URL (default http://127.0.0.1:11434)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
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

// ---- streaming proxy to Ollama ----
function proxy(req, res) {
  const target = new URL(req.url, OLLAMA_HOST);
  const upstream = http.request(
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
  if (url.pathname.startsWith('/api/')) return proxy(req, res);
  return serveStatic(req, res, url.pathname);
});

let port = Number(process.env.PORT) || 5177;
function listen() {
  server.listen(port, () => {
    console.log(`Arki chat  →  http://localhost:${port}`);
    console.log(`Ollama     →  ${OLLAMA_HOST}`);
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
listen();