import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fmtLoc } from './search.js';

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.opus': 'audio/ogg' };

export function startServer({ store, searcher, port = 7777 }) {
  const getFile = store.db.prepare('SELECT path FROM files WHERE id = ?');
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
      if (u.pathname === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(PAGE); }
      if (u.pathname === '/api/search') {
        const hits = await searcher.search(u.searchParams.get('q') || '', { limit: 30 });
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify(hits.map(h => ({ ...h, where: fmtLoc(h.loc) }))));
      }
      if (u.pathname === '/api/status') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(store.stats())); }
      const m = u.pathname.match(/^\/api\/file\/(\d+)$/);
      if (m) {                                                   // only files that are in the index; supports Range for seeking
        const f = getFile.get(+m[1]); if (!f) { res.statusCode = 404; return res.end(); }
        const st = fs.statSync(f.path), type = MIME[path.extname(f.path).toLowerCase()] || 'application/octet-stream';
        const r = (req.headers.range || '').match(/bytes=(\d*)-(\d*)/);
        res.setHeader('content-type', type); res.setHeader('accept-ranges', 'bytes');
        if (r) {
          const s = r[1] ? +r[1] : 0, e = r[2] ? Math.min(+r[2], st.size - 1) : st.size - 1;
          res.writeHead(206, { 'content-range': `bytes ${s}-${e}/${st.size}`, 'content-length': e - s + 1 });
          return fs.createReadStream(f.path, { start: s, end: e }).pipe(res);
        }
        res.setHeader('content-length', st.size);
        return fs.createReadStream(f.path).pipe(res);
      }
      res.statusCode = 404; res.end('not found');
    } catch (e) { res.statusCode = 500; res.end(String(e.message)); }
  });
  srv.listen(port, '127.0.0.1');                                  // localhost only: nothing leaves the machine
  return srv;
}

const PAGE = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>DigUp</title>
<style>
:root{--bg:#fff;--fg:#1c1c1e;--mut:#6b6b70;--card:#f4f4f6;--line:#e2e2e6;--acc:#2f6bff}
@media(prefers-color-scheme:dark){:root{--bg:#1b1c1f;--fg:#ececf0;--mut:#9a9aa3;--card:#26272b;--line:#34353a;--acc:#6f97ff}}
*{box-sizing:border-box}body{margin:0;font:15px system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{position:sticky;top:0;background:var(--bg);padding:16px 20px;border-bottom:1px solid var(--line)}
input{width:100%;max-width:760px;display:block;margin:0 auto;font-size:18px;padding:12px 16px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--fg);outline:none}
input:focus{border-color:var(--acc)}
main{max-width:760px;margin:0 auto;padding:12px 20px 60px}
.r{display:flex;gap:14px;padding:12px;border-radius:12px;cursor:pointer;align-items:center}
.r:hover,.r.sel{background:var(--card)}
.th{width:96px;height:72px;flex:none;border-radius:8px;background:var(--line);object-fit:cover;display:grid;place-items:center;color:var(--mut);font-size:12px;overflow:hidden}
.t{font-weight:600}.m{color:var(--mut);font-size:13px;margin-top:2px}.sn{font-size:13px;margin-top:4px;color:var(--mut)}
#pv{position:fixed;inset:0;background:#000c;display:none;place-items:center;padding:24px}#pv.on{display:grid}
#pv>div{background:var(--bg);border-radius:14px;max-width:min(92vw,1000px);width:100%;max-height:90vh;overflow:auto;padding:12px}
#pv img,#pv video,#pv iframe{width:100%;max-height:78vh;border:0;border-radius:8px}#pv iframe{height:78vh}#pv pre{white-space:pre-wrap}
</style>
<header><input id=q placeholder="Describe it. Dig it up." autofocus autocomplete=off></header>
<main id=out></main><div id=pv onclick="this.classList.remove('on')"><div id=pvb></div></div>
<script>
let hits=[],sel=0,tm;const q=document.getElementById('q'),out=document.getElementById('out'),pv=document.getElementById('pv'),pvb=document.getElementById('pvb');
const esc=s=>s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const url=h=>'/api/file/'+h.fileId;
function thumb(h){if(h.kind==='image')return '<img class=th loading=lazy src="'+url(h)+'">';
 if(h.kind==='video')return '<video class=th preload=metadata muted src="'+url(h)+'#t='+((h.loc.t||0)+.1)+'"></video>';
 return '<div class=th>'+({pdf:'PDF',doc:'DOC',audio:'AUDIO',code:'CODE'}[h.kind]||h.kind)+'</div>'}
function render(){out.innerHTML=hits.map((h,i)=>'<div class="r'+(i===sel?' sel':'')+'" data-i='+i+'>'+thumb(h)+'<div><div class=t>'+esc(h.name)+(h.where?' · '+h.where:'')+'</div><div class=m>'+esc(h.path)+'</div>'+(h.snippet?'<div class=sn>'+esc(h.snippet)+'</div>':'')+'</div></div>').join('')||'<p class=m>No matches.</p>'}
function preview(h){let b;if(h.kind==='image')b='<img src="'+url(h)+'">';
 else if(h.kind==='pdf')b='<iframe src="'+url(h)+'#page='+(h.loc.page||1)+'"></iframe>';
 else if(h.kind==='video')b='<video controls autoplay src="'+url(h)+'#t='+(h.loc.t||0)+'"></video>';
 else if(h.kind==='audio')b='<audio controls autoplay style="width:100%" src="'+url(h)+'#t='+(h.loc.t||0)+'"></audio>';
 else b='<pre>'+esc(h.snippet||h.path)+'</pre>';pvb.innerHTML=b;pv.classList.add('on')}
async function go(){const v=q.value.trim();if(!v){out.innerHTML='';return}
 hits=await (await fetch('/api/search?q='+encodeURIComponent(v))).json();sel=0;render()}
q.addEventListener('input',()=>{clearTimeout(tm);tm=setTimeout(go,150)});
addEventListener('keydown',e=>{if(e.key==='ArrowDown'){sel=Math.min(hits.length-1,sel+1);render();e.preventDefault()}
 else if(e.key==='ArrowUp'){sel=Math.max(0,sel-1);render();e.preventDefault()}
 else if(e.key==='Escape')pv.classList.remove('on');
 else if((e.key===' '&&document.activeElement!==q)||(e.key==='Enter'&&hits[sel]))preview(hits[sel])});
out.addEventListener('click',e=>{const r=e.target.closest('.r');if(r){sel=+r.dataset.i;render();preview(hits[sel])}});
</script>`;
