import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { Searcher } from '../src/search.js';

function fixture() {
  const db = openDb(':memory:');
  const add = (name, text, cosine, mod = 'text', kind = 'doc') => {
    const ext = kind === 'image' ? '.jpg' : '.txt';
    const fileId = db.upsertFile({ path: `/fixture/${name}${ext}`, root: '/fixture', kind, scope: 'general', mtime: 1, size: text.length });
    const side = Math.sqrt(1 - cosine * cosine);
    const chunkId = db.addChunk(fileId, 'general', `${name}${ext}`, { mod, loc: {}, text, vec: new Float32Array([cosine, side]) });
    return { fileId, chunkId };
  };
  return { db, add };
}

test('semantic results keep only files that stand out for this query', async (t) => {
  const { db, add } = fixture();
  t.after(() => db.db.close());
  for (let i = 0; i < 30; i++) add(`background-${i}`, `unrelated notes ${i}`, 0.20 + (i % 5) * 0.015);
  add('match', 'unrelated reference material', 0.68);

  const searcher = new Searcher(db, { embedTexts: async () => [new Float32Array([1, 0])] });
  const hits = await searcher.search('distinctive phrase');

  assert.deepEqual(hits.map(hit => hit.name), ['match.txt']);
});

test('exact keyword coverage rescues a match even when its vector is weak', async (t) => {
  const { db, add } = fixture();
  t.after(() => db.db.close());
  for (let i = 0; i < 30; i++) add(`background-${i}`, `unrelated notes ${i}`, 0.20 + (i % 5) * 0.015);
  add('invoice', 'Invoice QX-8192 approved by finance', 0.08);

  const searcher = new Searcher(db, { embedTexts: async () => [new Float32Array([1, 0])] });
  const hits = await searcher.search('find the invoice QX-8192');

  assert.equal(hits[0]?.name, 'invoice.txt');
});

test('query cleanup drops request words and expands an absent final word to a prefix', async (t) => {
  const { db, add } = fixture();
  t.after(() => db.db.close());
  add('release-notes', 'The Grok4 release notes describe faster indexing.', 0.12);

  const searcher = new Searcher(db, { embedTexts: async () => [new Float32Array([1, 0])] });
  const hits = await searcher.search('please find the release notes for grok');

  assert.equal(hits[0]?.name, 'release-notes.txt');
});

test('small indexes can still return their clearest semantic match', async (t) => {
  const { db, add } = fixture();
  t.after(() => db.db.close());
  add('background', 'ordinary unrelated text', 0.2);
  add('match', 'another unrelated passage', 0.7);

  const searcher = new Searcher(db, { embedTexts: async () => [new Float32Array([1, 0])] });
  const hits = await searcher.search('rarely mentioned topic');

  assert.deepEqual(hits.map(hit => hit.name), ['match.txt']);
});

test('keyword-qualified files point at the passage containing the query terms', async (t) => {
  const { db, add } = fixture();
  t.after(() => db.db.close());
  for (let i = 0; i < 30; i++) add(`background-${i}`, `unrelated notes ${i}`, 0.20 + (i % 5) * 0.015);
  const fileId = db.upsertFile({ path: '/fixture/receipt.txt', root: '/fixture', kind: 'doc', scope: 'general', mtime: 1, size: 80 });
  const matching = db.addChunk(fileId, 'general', 'receipt.txt', { mod: 'text', loc: { n: 0 }, text: 'Invoice review reference and approval details.', vec: new Float32Array([0.08, Math.sqrt(1 - 0.08 ** 2)]) });
  db.addChunk(fileId, 'general', 'receipt.txt', { mod: 'text', loc: { n: 1 }, text: 'Unrelated material with no matching terms.', vec: new Float32Array([0.27, Math.sqrt(1 - 0.27 ** 2)]) });

  const searcher = new Searcher(db, { embedTexts: async () => [new Float32Array([1, 0])] });
  const hits = await searcher.search('invoice review reference');

  assert.equal(hits[0]?.chunkId, matching);
  assert.match(hits[0]?.snippet || '', /Invoice review reference/);
});

test('semantic normalization does not let another modality suppress text matches', async (t) => {
  const { db, add } = fixture();
  t.after(() => db.db.close());
  for (let i = 0; i < 20; i++) add(`image-${i}`, `image description ${i}`, 0.64 + (i % 4) * 0.005, 'image');
  for (let i = 0; i < 20; i++) add(`text-${i}`, `unrelated notes ${i}`, 0.20 + (i % 5) * 0.015);
  add('match', 'different unrelated passage', 0.68);

  const searcher = new Searcher(db, { embedTexts: async () => [new Float32Array([1, 0])] });
  const hits = await searcher.search('distinctive phrase');

  assert.equal(hits[0]?.name, 'match.txt');
});

test('the lexical hash fallback does not invent semantic matches', async (t) => {
  const { db, add } = fixture();
  t.after(() => db.db.close());
  for (let i = 0; i < 12; i++) add(`notes-${i}`, `ordinary material about topic ${i}`, 0.2 + (i % 4) * 0.03);

  const searcher = new Searcher(db, { id: 'hash:2', embedTexts: async () => [new Float32Array([1, 0])] });

  assert.deepEqual(await searcher.search('rarely mentioned topic'), []);
});

test('explicit image intent returns only semantically matched image files', async (t) => {
  const { db, add } = fixture();
  t.after(() => db.db.close());
  for (let i = 0; i < 6; i++) add(`photo-${i}`, `image record ${i}`, 0.20 + (i % 4) * 0.015, 'image', 'image');
  add('beach-photo', 'unindexed image content', 0.68, 'image', 'image');
  add('pirate-notes', 'notes mention pirates', 0.95);

  const searcher = new Searcher(db, { embedTexts: async () => [new Float32Array([1, 0])] });
  const hits = await searcher.search('pirate in image');

  assert.deepEqual(hits.map(hit => hit.name), ['beach-photo.jpg']);
});
