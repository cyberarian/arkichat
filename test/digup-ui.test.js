const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('const digup=');
const end = html.indexOf('/* ================= Muslim prayer times', start);
assert.ok(start >= 0 && end > start, 'DigUp script section must exist');
const source = html.slice(start, end);

// Only the DOM operations used by this card are needed; no browser dependency.
class Element {
  constructor() {
    this.children = [];
    this.hidden = false;
    this.value = '';
    this.attributes = {};
    this.listeners = {};
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  set textContent(value) { this.content = String(value); this.children = []; }
  get textContent() { return (this.content || '') + this.children.map(c => c.textContent).join(''); }
  set innerHTML(value) { this.content = String(value).replace(/<[^>]*>/g, ''); this.children = []; }
  get innerHTML() { return this.textContent; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.content = ''; this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  focus() {}
}

function setup() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const requests = [];
  const context = vm.createContext({
    $: element,
    document: { createElement: () => new Element() },
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
    log() {}, play() {}, setTimeout() {}, clearTimeout() {},
    AbortController, AbortSignal,
  });
  vm.runInContext(source, context, { filename: 'index.html (DigUp)' });
  return { context, element, elements, requests };
}

function answer(request, hits) {
  request.resolve({ ok: true, json: async () => ({ hits }) });
}

function hit(name) {
  return { fileId: name, name, path: '/documents/' + name, snippet: 'Contents of ' + name };
}

test('newest search owns the results while each caller receives its own hits', async () => {
  const { context, element, requests } = setup();
  const older = context.digupSearch('old');
  const newer = context.digupSearch('new');
  answer(requests[1], [hit('new.txt')]);
  assert.equal((await newer).hits[0].name, 'new.txt');
  answer(requests[0], [hit('old.txt')]);
  assert.equal((await older).hits[0].name, 'old.txt');
  assert.match(element('digupResults').textContent, /new\.txt/);
  assert.doesNotMatch(element('digupResults').textContent, /old\.txt/);
});

test('clearing a query prevents its pending response from reopening results', async () => {
  const { context, element, requests } = setup();
  const pending = context.digupSearch('old');
  await context.digupSearch('  ');
  assert.equal(element('digupResults').hidden, true);
  answer(requests[0], [hit('old.txt')]);
  await pending;
  assert.equal(element('digupResults').hidden, true);
});

test('a stale search error does not replace newer successful results', async () => {
  const { context, element, requests } = setup();
  const older = context.digupSearch('old');
  const newer = context.digupSearch('new');
  answer(requests[1], [hit('new.txt')]);
  await newer;
  requests[0].reject(new Error('Old request failed'));
  assert.equal((await older).error, 'Old request failed');
  assert.match(element('digupResults').textContent, /new\.txt/);
  assert.doesNotMatch(element('digupResults').textContent, /Old request failed/);
});

test('service failure stays visible and can recover through retry', async () => {
  const { context, element, requests } = setup();
  const pending = context.digupLoad();
  requests[0].reject(new Error('Service is offline'));
  assert.equal(await pending, null);
  assert.equal(element('diguppanel').hidden, false);
  assert.equal(element('digupNotice').hidden, false);
  assert.match(element('digupNotice').textContent, /Service is offline/);
  assert.equal(element('digupRetry').hidden, false);
  const retry = element('digupRetry').listeners.click();
  requests[1].resolve({ ok: true, json: async () => ({ roots: [], setup: true }) });
  await retry;
  assert.equal(element('diguppanel').hidden, false);
  assert.equal(element('digupNotice').hidden, true);
  assert.equal(element('digupRetry').hidden, true);
});

test('search timeout explains recovery and retry preserves query and code mode', async () => {
  const { context, element, requests } = setup();
  const pending = context.digupSearch('billing & invoices', true);
  assert.ok(requests[0].options.signal instanceof AbortSignal, 'requests must support timeout cancellation');
  requests[0].reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
  const result = await pending;
  assert.match(result.error, /Search timed out.*Try again/);
  assert.equal(element('digupResults').attributes['aria-busy'], 'false');
  const retryButton = element('digupResults').children.find(el => el.textContent === 'retry search');
  assert.ok(retryButton);
  const retry = retryButton.onclick();
  assert.equal(requests[1].url, requests[0].url);
  assert.equal(element('digupResults').attributes['aria-busy'], 'true');
  answer(requests[1], [hit('invoice.txt')]);
  await retry;
  assert.match(element('digupResults').textContent, /invoice\.txt/);
  assert.doesNotMatch(element('digupResults').textContent, /timed out/);
  assert.equal(element('digupResults').attributes['aria-busy'], 'false');
});

test('adding a folder prevents duplicate submissions and indexes it once', async () => {
  const { context, element, requests } = setup();
  element('digupPath').value = '  ~/Documents  ';
  element('digupIncludeCode').checked = true;
  const first = context.digupAddFolder();
  await context.digupAddFolder();
  assert.equal(requests.length, 1);
  assert.equal(element('digupSave').disabled, true);
  assert.deepEqual(JSON.parse(requests[0].options.body), { action: 'add', path: '~/Documents', code: true });
  requests[0].resolve({ ok: true, json: async () => ({ roots: [{ path: '/home/test/Documents', code: true }] }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, '/api/digup/index');
  assert.equal(element('digupPath').value, '');
  requests[1].resolve({ ok: true, json: async () => ({ ok: true }) });
  await first;
  assert.match(element('digupRoots').textContent, /source code included/);
  assert.equal(element('digupSave').disabled, true, 'adding stays disabled during indexing');
});

test('failed folder submission preserves input and allows another attempt', async () => {
  const { context, element, requests } = setup();
  element('digupPath').value = '/missing/folder';
  element('digupIncludeCode').checked = true;
  const pending = context.digupAddFolder();
  requests[0].resolve({ ok: false, status: 400, json: async () => ({ error: 'Folder does not exist' }) });
  await pending;
  assert.equal(element('digupPath').value, '/missing/folder');
  assert.equal(element('digupIncludeCode').checked, true);
  assert.equal(element('digupSave').disabled, false);
  assert.equal(element('digupNotice').hidden, false);
  assert.match(element('digupNotice').textContent, /Folder does not exist/);
  const retry = context.digupAddFolder();
  assert.equal(requests.length, 2);
  requests[1].reject(new Error('Still unavailable'));
  await retry;
});

test('index submission prevents duplicate runs and unlocks controls after failure', async () => {
  const { context, element, requests } = setup();
  vm.runInContext("digup.roots = [{path:'/documents'}]", context);
  const pending = context.digupIndex(false);
  await context.digupIndex(true);
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0].options.body), { reindex: false });
  assert.equal(element('digupIndex').disabled, true);
  requests[0].reject(new Error('Index unavailable'));
  await pending;
  assert.equal(element('digupIndex').disabled, false);
  assert.equal(element('digupRebuild').disabled, false);
  assert.match(element('digupNotice').textContent, /Index unavailable/);
});

test('rebuild invalidates old file results and blocks searches until indexing finishes', async () => {
  const { context, element, requests } = setup();
  vm.runInContext("digup.roots = [{path:'/documents'}]", context);
  context.digupRender([hit('existing.txt')]);
  const pendingSearch = context.digupSearch('old');
  const rebuild = context.digupIndex(true);
  assert.equal(element('digupResults').hidden, true, 'rebuild must hide results with obsolete file IDs');
  answer(requests[0], [hit('old.txt')]);
  assert.equal((await pendingSearch).hits[0].name, 'old.txt');
  assert.equal(element('digupResults').hidden, true, 'old responses must not restore obsolete results');
  const blockedSearch = await context.digupSearch('new');
  assert.equal(blockedSearch.hits.length, 0);
  assert.match(blockedSearch.error, /index is being rebuilt/i);
  assert.equal(requests.length, 2, 'rebuilding must not send a search request');
  requests[1].resolve({ ok: true, json: async () => ({ ok: true }) });
  await rebuild;
  const stillBlocked = await context.digupSearch('new');
  assert.match(stillBlocked.error, /index is being rebuilt/i);
  assert.equal(requests.length, 2, 'accepting the rebuild is not completion');
  const poll = context.digupPoll();
  requests[2].resolve({ ok: true, json: async () => ({ roots: [{ path: '/documents' }], indexing: { indexing: false, phase: 'done' } }) });
  await poll;
  const freshSearch = context.digupSearch('new');
  assert.equal(requests.length, 4);
  answer(requests[3], [hit('new.txt')]);
  await freshSearch;
  assert.equal(element('digupResults').hidden, false);
  assert.match(element('digupResults').textContent, /new\.txt/);
});
