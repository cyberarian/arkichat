import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { Indexer } from '../src/indexer.js';

test('updating the index backfills media vectors for unchanged images', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'digup-media-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'vacation.png');
  fs.writeFileSync(file, Buffer.from('a small image placeholder'));

  const db = openDb(':memory:');
  t.after(() => db.db.close());
  const embedder = {
    media: false,
    async embedTexts() { return []; },
    async embedMedia() { return this.media ? new Float32Array([1, 0]) : null; },
  };
  const indexer = new Indexer(db, embedder);

  await indexer.indexRoot({ path: root });
  const indexed = db.getFile(file);
  assert.equal(db.hasVector(indexed.id, 'image'), false);
  assert.equal(db.pendingMedia(), 1);

  embedder.media = true;
  const updated = await indexer.indexRoot({ path: root });

  assert.equal(updated.indexed, 1);
  assert.equal(db.hasVector(indexed.id, 'image'), true);
  assert.equal(db.pendingMedia(), 0);
  assert.equal((await indexer.indexRoot({ path: root })).indexed, 0);
});
