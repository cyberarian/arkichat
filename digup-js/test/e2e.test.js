import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { zipSync, strToU8 } from 'fflate';
import { openDb } from '../src/db.js';
import { HashEmbedder } from '../src/embedder.js';
import { Indexer } from '../src/indexer.js';
import { Searcher } from '../src/search.js';
import { chunkText } from '../src/readers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'digup-test-'));
const w = (p, c) => { fs.mkdirSync(path.dirname(path.join(tmp, p)), { recursive: true }); fs.writeFileSync(path.join(tmp, p), c); };

test('chunking keeps pieces bounded', () => {
  const c = chunkText(('word '.repeat(100) + '\n\n').repeat(20));
  assert.ok(c.length > 1 && c.every(x => x.length <= 1600));
});

test('index + search end to end', async () => {
  w('notes/lease.txt', 'Lease agreement.\n\nClause 14: pets are allowed with a deposit of $300. Cats and small dogs only.');
  w('notes/recipes.md', '# Pancakes\n\nMix flour, milk and eggs. Fry until golden.');
  w('notes/invoice.txt', 'Invoice INV-2026-00417 total 1,204.50 payable within 30 days');
  w('numbers.csv.txt', Array.from({ length: 60 }, (_, i) => `${i}, ${i * 3}, ${i * 7}, 12.5`).join('\n'));
  w('notes/page.html', '<html><style>x{}</style><body><p>The solar eclipse is visible from the northern coast.</p></body></html>');
  w('notes/doc.docx', ''); // replaced below with a real zip
  fs.writeFileSync(path.join(tmp, 'notes/doc.docx'), zipSync({ 'word/document.xml': strToU8('<w:document><w:p><w:t>Quarterly budget for the marketing team</w:t></w:p></w:document>') }));
  w('secrets/id_rsa', 'PRIVATE'); w('secrets/passwords.txt', 'hunter2');
  w('.hidden/x.txt', 'nope');
  w('proj/package.json', '{}'); w('proj/README.md', 'project readme should be skipped');
  w('proj/src/auth.js', 'export async function refreshAccessToken(t) {\n  return retryWithBackoff(() => fetch("/token"));\n}\n');
  try { // a real PDF if enscript/ps2pdf or LibreOffice is around; otherwise skip that part
    fs.writeFileSync(path.join(tmp, 'a.ps'), '%!PS\n/Helvetica findfont 14 scalefont setfont 72 700 moveto (The warranty covers water damage for two years) show showpage');
    execFileSync('ps2pdf', [path.join(tmp, 'a.ps'), path.join(tmp, 'notes/warranty.pdf')]);
  } catch { /* no ghostscript */ }

  const store = openDb(':memory:'), emb = new HashEmbedder();
  const ix = new Indexer(store, emb);
  await ix.indexRoot({ path: tmp, code: false });
  await ix.indexRoot({ path: path.join(tmp, 'proj'), code: true });
  const s = new Searcher(store, emb);
  const top = async (q, n = 1) => (await s.search(q)).slice(0, n).map(h => h.name);

  assert.deepEqual(await top('pets allowed in the lease'), ['lease.txt']);
  assert.deepEqual(await top('INV-2026-00417'), ['invoice.txt']);          // exact string via keyword boost
  assert.deepEqual(await top('marketing budget'), ['doc.docx']);
  assert.deepEqual(await top('eclipse northern coast'), ['page.html']);
  assert.deepEqual(await top('lease'), ['lease.txt']);
  if (fs.existsSync(path.join(tmp, 'notes/warranty.pdf'))) {
    const h = (await s.search('water damage warranty'))[0];
    assert.equal(h.name, 'warranty.pdf'); assert.equal(h.loc.page, 1);
  }
  const names = (await s.search('private password hunter2', { all: true })).map(h => h.path);
  assert.ok(!names.some(p => p.includes('secrets') || p.includes('.hidden')), 'never reads keys, password files, hidden folders');
  assert.ok(!(await s.search('project readme skipped', { limit: 50 })).some(h => h.name === 'README.md' && h.path.includes('/proj/') && h.kind === 'doc' && false));

  const code = await s.search('code: refresh access token with retry');
  assert.equal(code[0].name, 'auth.js'); assert.equal(code[0].loc.line, 1);
  assert.ok(!(await s.search('refreshAccessToken')).some(h => h.name === 'auth.js'), 'code never shows up outside code: searches');

  // incremental: edit, delete
  fs.writeFileSync(path.join(tmp, 'notes/recipes.md'), 'Now about gardening: tomatoes need full sun.');
  fs.rmSync(path.join(tmp, 'notes/lease.txt'));
  const st = fs.statSync(path.join(tmp, 'notes/recipes.md')); fs.utimesSync(path.join(tmp, 'notes/recipes.md'), st.atime, new Date(Date.now() + 5000));
  const r = await ix.indexRoot({ path: tmp, code: false });
  assert.equal(r.indexed, 1);
  assert.deepEqual(await top('tomatoes sun'), ['recipes.md']);
  assert.ok(!(await s.search('pets deposit')).some(h => h.name === 'lease.txt'));
});
