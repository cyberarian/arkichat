#!/usr/bin/env node
/**
 * Arki Chat — tiny zero-dependency server.
 * Serves the static UI, proxies /api/* to a local Ollama instance so the browser
 * never hits CORS and streaming responses pass straight through, and adds one
 * helper endpoint (/api/ytsearch) that lets the page play YouTube audio in-place
 * without needing an API key,
 * and an allowlisted desktop launcher (/api/apps, /api/launch): a web page can
 * never start a program, so "open VLC" is resolved against a fixed table here and
 * the matched argv array is spawned directly — never through a shell.
 *
 * Env vars:
 *   PORT         — port to listen on (default 5177, auto-increments if busy)
 *   OLLAMA_HOST  — Ollama base URL (default http://127.0.0.1:11434)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

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
  // the curated shortcuts here — the page builds its open_app tool from this
  if (url.pathname === '/api/apps') {
    return sendJSON(res, 200, {
      platform: process.platform,
      generic: true,
      apps: LOCAL_APPS.filter((a) => attemptsFor(a).length)
        .map((a) => ({ id: a.id, label: a.label, aliases: [a.id, ...a.aliases] })),
    });
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