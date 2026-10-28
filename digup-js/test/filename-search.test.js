import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { HashEmbedder } from '../src/embedder.js';
import { Indexer } from '../src/indexer.js';
import { Searcher } from '../src/search.js';

test('filename queries honor prefix, suffix and substring intent without changing content search', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'digup-filename-search-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    'WhatsApp Backup 2024.txt': 'Archived messages from 2024.',
    'whatsapp-group-list.md': 'A list of group names.',
    'Report about WhatsApp.txt': 'Quarterly usage report.',
    'Family notes.txt': 'We planned a solar garden party.',
  };
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), contents);
  }

  const db = openDb(':memory:');
  t.after(() => db.db.close());
  const embedder = new HashEmbedder();
  const indexer = new Indexer(db, embedder);
  await indexer.indexRoot({ path: root });
  const searcher = new Searcher(db, embedder);
  const filenames = async (query) => (await searcher.search(query, { filenames: true })).map(hit => hit.name);

  assert.deepEqual(await filenames('find all filenames with prefix Whatsapp'), [
    'WhatsApp Backup 2024.txt', 'whatsapp-group-list.md',
  ]);
  assert.deepEqual(await filenames('show all files whose names start with WhatsApp'), [
    'WhatsApp Backup 2024.txt', 'whatsapp-group-list.md',
  ]);
  assert.deepEqual(await filenames('find files ending with .md'), ['whatsapp-group-list.md']);
  assert.deepEqual(await filenames('WhatsApp'), [
    'Report about WhatsApp.txt', 'WhatsApp Backup 2024.txt', 'whatsapp-group-list.md',
  ]);
  assert.equal((await searcher.search('solar garden party'))[0].name, 'Family notes.txt');
});
