import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OllamaEmbedder } from '../src/embedder.js';

test('Ollama media embeddings send image bytes through the shared embedding space', async () => {
  const embedder = new OllamaEmbedder({ url: 'http://ollama.test', model: 'embeddinggemma-2', media: true });
  let request;
  embedder._json = async (path, body) => {
    request = { path, body };
    return { embeddings: [[3, 4]] };
  };

  const vector = await embedder.embedMedia('image', Buffer.from('image bytes'));

  assert.deepEqual(request, {
    path: '/api/embed',
    body: { model: 'embeddinggemma-2', input: { image: Buffer.from('image bytes').toString('base64') } },
  });
  assert.ok(Math.abs(vector[0] - 0.6) < 1e-6);
  assert.ok(Math.abs(vector[1] - 0.8) < 1e-6);
});

test('unsupported Ollama media embedding degrades to filename search and reports why', async () => {
  const embedder = new OllamaEmbedder({ url: 'http://ollama.test', model: 'text-only-model', media: true });
  embedder._json = async () => { throw Object.assign(new Error('model does not accept image input'), { status: 400 }); };

  assert.equal(await embedder.embedMedia('image', Buffer.from('image bytes')), null);
  assert.equal(embedder.media, false);
  assert.match(embedder.mediaError, /does not accept image input/);
});

test('transient Ollama media errors remain enabled and propagate for retry', async () => {
  const embedder = new OllamaEmbedder({ url: 'http://ollama.test', model: 'embeddinggemma-2', media: true });
  embedder._json = async () => { throw new Error('connection timed out'); };

  await assert.rejects(embedder.embedMedia('image', Buffer.from('image bytes')), /connection timed out/);
  assert.equal(embedder.media, true);
});
