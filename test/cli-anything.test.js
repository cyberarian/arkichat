const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCliAnything } = require('../cli-anything');

test('discovers only executable CLI-Anything harnesses on PATH', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arki-cli-anything-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const harness = path.join(dir, 'cli-anything-demo');
  fs.writeFileSync(harness, '#!/usr/bin/env node\n');
  fs.chmodSync(harness, 0o755);
  fs.writeFileSync(path.join(dir, 'other-tool'), '#!/usr/bin/env node\n');
  fs.chmodSync(path.join(dir, 'other-tool'), 0o755);

  const localBin = path.join(dir, 'local-bin');
  fs.mkdirSync(localBin);
  const bridge = createCliAnything({ env: { PATH: dir + path.delimiter + process.env.PATH }, platform: 'darwin', localBin });
  assert.deepEqual(bridge.discover().map(({ id }) => id), ['demo']);
});

test('runs a discovered harness with argv and no shell, and rejects unknown harnesses', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arki-cli-anything-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const harness = path.join(dir, 'cli-anything-demo');
  fs.writeFileSync(harness, '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\n');
  fs.chmodSync(harness, 0o755);

  const bridge = createCliAnything({ env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH, HOME: dir }, platform: 'darwin', timeout: 3000 });
  const result = await bridge.run('demo', ['file name.txt', '$(touch nope)']);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), ['file name.txt', '$(touch nope)']);
  await assert.rejects(bridge.run('missing', []), /not installed/);
});

test('validates harness arguments and caps execution output', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arki-cli-anything-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const harness = path.join(dir, 'cli-anything-demo');
  fs.writeFileSync(harness, '#!/usr/bin/env node\nprocess.stdout.write("x".repeat(5000))\n');
  fs.chmodSync(harness, 0o755);

  const bridge = createCliAnything({ env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH, HOME: dir }, platform: 'darwin', maxOutput: 1024 });
  await assert.rejects(bridge.run('demo', ['bad\0arg']), /invalid argument/);
  const result = await bridge.run('demo', []);
  assert.equal(result.truncated, true);
  assert.ok(result.stdout.length <= 1024);
});
