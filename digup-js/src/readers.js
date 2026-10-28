import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unzipSync, strFromU8 } from 'fflate';

const run = promisify(execFile);
const BIG = 256 * 1024 * 1024;

export const EXT = {
  image: new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.tif', '.tiff']),
  pdf: new Set(['.pdf']),
  doc: new Set(['.txt', '.md', '.markdown', '.rtf', '.docx', '.odt', '.html', '.htm']),
  audio: new Set(['.mp3', '.m4a', '.wav', '.flac', '.ogg', '.opus', '.aac']),
  video: new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']),
  code: new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.rs', '.go', '.java', '.kt', '.swift', '.c', '.h',
    '.cc', '.cpp', '.hpp', '.cs', '.rb', '.php', '.sh', '.lua', '.sql', '.scala', '.dart', '.vue', '.svelte', '.ipynb', '.md']),
};
export function kindOf(file) {
  const e = path.extname(file).toLowerCase();
  for (const k of ['image', 'pdf', 'doc', 'audio', 'video']) if (EXT[k].has(e)) return k;
  if (EXT.code.has(e)) return 'code';
  return null;
}

// ---------- text ----------
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' };
const unent = (s) => s.replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(\d+);/g, (m, n) => n ? String.fromCodePoint(+n) : ENT[m]);

async function extractText(file, ext) {
  if (ext === '.docx' || ext === '.odt') {
    const z = unzipSync(new Uint8Array(await fsp.readFile(file)));
    const part = ext === '.docx' ? 'word/document.xml' : 'content.xml';
    if (!z[part]) return '';
    let x = strFromU8(z[part]);
    x = ext === '.docx' ? x.replace(/<\/w:p>|<w:br\/>|<w:tab\/>/g, '\n') : x.replace(/<\/text:(p|h)>|<text:line-break\/>/g, '\n');
    return unent(x.replace(/<[^>]+>/g, ''));
  }
  const raw = await fsp.readFile(file, 'utf8');
  if (ext === '.html' || ext === '.htm')
    return unent(raw.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<\/(p|div|h\d|li|tr|br)>/gi, '\n').replace(/<[^>]+>/g, ' '));
  if (ext === '.rtf')
    return raw.replace(/\\par[d]?/g, '\n').replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '');
  return raw;
}

/** Paragraph-aware chunks of ~maxLen chars with a little overlap. */
export function chunkText(text, maxLen = 1400, overlap = 150) {
  const paras = text.replace(/\r/g, '').split(/\n{2,}|\n(?=\s*[#\-*•]\s)/).map(s => s.trim()).filter(Boolean);
  const out = []; let cur = '';
  const push = () => { if (cur.trim()) out.push(cur.trim()); };
  for (let p of paras) {
    while (p.length > maxLen) {                       // very long paragraph: hard split on a space
      let cut = p.lastIndexOf(' ', maxLen); if (cut < maxLen / 2) cut = maxLen;
      if (cur) { push(); cur = ''; }
      out.push(p.slice(0, cut).trim()); p = p.slice(Math.max(0, cut - overlap)).trim();
    }
    if ((cur + '\n\n' + p).length > maxLen) { push(); cur = cur.slice(-overlap) + '\n\n' + p; }
    else cur = cur ? cur + '\n\n' + p : p;
  }
  push();
  return out;
}
const mostlyNumbers = (t) => { const d = (t.match(/[\d.,;:\-\s|]/g) || []).length; return t.length > 200 && d / t.length > 0.7; };

// ---------- units: what the indexer embeds ----------
// { mod:'text', text, loc, embed?:false }  |  { mod:'image'|'audio', data:Buffer, loc, text? }
export async function* readDoc(file) {
  const text = await extractText(file, path.extname(file).toLowerCase());
  let i = 0;
  for (const c of chunkText(text)) yield { mod: 'text', text: c, loc: { n: i++ }, embed: !mostlyNumbers(c) };
}

export async function* readCode(file) {
  const st = await fsp.stat(file);
  if (st.size > 300 * 1024 || /\.min\.|-lock\.|\.lock$/.test(file)) return;
  let src = await fsp.readFile(file, 'utf8');
  if (file.endsWith('.ipynb')) {                      // notebook cells, without outputs
    const nb = JSON.parse(src);
    let n = 0;
    for (const c of nb.cells || []) {
      const t = [].concat(c.source || []).join('');
      if (t.trim()) yield { mod: 'code', text: t.slice(0, 3000), loc: { cell: n } };
      n++;
    }
    return;
  }
  if (src.includes('\0')) return;
  const lines = src.split('\n'), W = 60, STEP = 50;
  for (let s = 0; s < lines.length; s += STEP) {
    const t = lines.slice(s, s + W).join('\n');
    if (t.trim()) yield { mod: 'code', text: t, loc: { line: s + 1 } };
    if (s + W >= lines.length) break;
  }
}

async function pdfPages(file) {
  try {
    const { stdout } = await run('pdfinfo', [file]);
    return +(stdout.match(/Pages:\s+(\d+)/)?.[1] ?? 0);
  } catch { return 0; }
}
const have = {};
async function hasTool(t) {
  if (t in have) return have[t];
  try { await run(t, ['-h'], { timeout: 5000 }).catch(e => { if (e.code === 'ENOENT') throw e; }); have[t] = true; }
  catch { have[t] = false; }
  return have[t];
}

/** Reads pages [from, to]. Pages with no text layer (scans) are rendered and embedded as pictures. */
export async function* readPdf(file, from = 1, to = 30, onPage = () => {}) {
  const total = Math.min(await pdfPages(file), 5000);
  const last = Math.min(to, total);
  for (let p = from; p <= last; p++) {
    let text = '';
    try { text = (await run('pdftotext', ['-f', p, '-l', p, '-layout', file, '-'], { maxBuffer: BIG })).stdout.trim(); } catch { /* skip */ }
    onPage(p, total);
    if (text.length > 20) {
      const parts = text.length > 2200 ? chunkText(text, 1800, 200) : [text];
      for (const t of parts) yield { mod: 'text', text: t, loc: { page: p }, embed: !mostlyNumbers(t) };
    } else if (await hasTool('pdftoppm')) {
      const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'digup-'));
      try {
        await run('pdftoppm', ['-f', p, '-l', p, '-r', '80', '-jpeg', '-singlefile', file, path.join(tmp, 'p')]);
        yield { mod: 'image', data: await fsp.readFile(path.join(tmp, 'p.jpg')), loc: { page: p } };
      } catch { /* ignore */ } finally { await fsp.rm(tmp, { recursive: true, force: true }); }
    }
  }
  yield { _done: true, nextPage: last < total ? last + 1 : null, total };
}

export async function* readImage(file) {
  const ext = path.extname(file).toLowerCase();
  let data = await fsp.readFile(file);
  if (!['.jpg', '.jpeg', '.png'].includes(ext) || data.length > 4_000_000) {  // normalize to a modest JPEG
    try { data = (await run('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'scale=1024:-2:force_original_aspect_ratio=decrease', '-frames:v', '1', '-f', 'mjpeg', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: BIG })).stdout; } catch { return; }
  }
  yield { mod: 'image', data, loc: {} };
}

// ---------- audio & video ----------
async function probe(file) {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file]);
    const j = JSON.parse(stdout);
    return { duration: +j.format?.duration || 0, hasAudio: (j.streams || []).some(s => s.codec_type === 'audio') };
  } catch { return { duration: 0, hasAudio: false }; }
}

function wav(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Overlapping 30 s windows (20 s stride); the model listens 30 s at a time and a match points at its moment. */
export async function* readAudioTrack(file, { win = 30, stride = 20, maxWindows = 720 } = {}) {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 2 ** 31 - 1 }).catch(() => ({ stdout: Buffer.alloc(0) }));
  const bps = 32000, total = stdout.length / bps;
  let count = 0;
  for (let t = 0; t < total && count < maxWindows; t += stride, count++) {
    const pcm = stdout.subarray(t * bps, Math.min(total, t + win) * bps);
    if (pcm.length < bps * 1.5) break;
    let e = 0; for (let i = 0; i < pcm.length; i += 64) e += Math.abs(pcm.readInt16LE(i));
    if (e / (pcm.length / 64) < 40) continue;                      // silence
    yield { mod: 'audio', data: wav(pcm), loc: { t } };
  }
}
export async function* readAudio(file) { yield* readAudioTrack(file); }

/** A frame every few seconds (spacing grows for long videos), plus the soundtrack like audio. */
export async function* readVideo(file) {
  const { duration, hasAudio } = await probe(file);
  if (duration > 0) {
    const every = Math.max(5, Math.ceil(duration / 300));
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'digup-'));
    try {
      await run('ffmpeg', ['-v', 'error', '-i', file, '-vf', `fps=1/${every},scale=448:-2`, '-q:v', '4', path.join(tmp, '%05d.jpg')], { maxBuffer: BIG });
      const frames = (await fsp.readdir(tmp)).sort();
      for (let i = 0; i < frames.length; i++)
        yield { mod: 'image', data: await fsp.readFile(path.join(tmp, frames[i])), loc: { t: i * every } };
    } catch { /* unreadable video */ } finally { await fsp.rm(tmp, { recursive: true, force: true }); }
  }
  if (hasAudio) yield* readAudioTrack(file);
}
