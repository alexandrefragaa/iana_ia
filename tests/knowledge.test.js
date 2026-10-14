import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import { createKnowledgeRouter, validateKnowledgeRequest } from '../core/knowledge-proxy.js';
import { DEFAULT_KNOWLEDGE_URL, formatJobSummary, isFinalJob, sourceLink, initializeKnowledgeUI, capabilitySummary } from '../public/js/knowledge.js';

async function listen(app, t) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, configure) {
  const upstream = express();
  upstream.use(express.json());
  const calls = [];
  upstream.use((req, _res, next) => { calls.push({ path: req.path, key: req.get('X-API-Key'), owner: req.get('X-Iana-User-Id'), body: req.body }); next(); });
  configure(upstream);
  const upstreamUrl = await listen(upstream, t);
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-session-secret', resave: false, saveUninitialized: false }));
  app.post('/login', (req, res) => { req.session.authenticated = true; res.json({ ok: true }); });
  app.use('/api/v1/knowledge', createKnowledgeRouter({
    pythonApiUrl: `${upstreamUrl}/api/v1/chat`, apiKey: 'private-test-key',
    authRequired(req, res, next) { if (req.session.authenticated) next(); else res.status(401).json({ mensagem: 'Login necessário.' }); }
  }));
  const base = await listen(app, t);
  async function login() {
    const response = await fetch(`${base}/login`, { method: 'POST' });
    return response.headers.get('set-cookie').split(';')[0];
  }
  return { base, calls, login };
}

test('source validation keeps the supplied query and bounds extraction options', () => {
  assert.deepEqual(validateKnowledgeRequest({ url: DEFAULT_KNOWLEDGE_URL }), { url: DEFAULT_KNOWLEDGE_URL, max_videos: 5, recent_days: 7 });
  assert.equal(validateKnowledgeRequest({ url: 'https://example.com', max_videos: 20, recent_days: 0 }).recent_days, 0);
  for (const url of ['file:///secret', 'ftp://example.com', 'http://localhost/a', 'http://127.0.0.1', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://192.168.0.1', 'https://user:pass@example.com', 'http://service.internal', 'https://example.com:8080', 'https://example.com/space here', 'https://exam\nple.com', 'not-a-url']) {
    assert.throws(() => validateKnowledgeRequest({ url }), { status: 400 }, url);
  }
  for (const body of [{ max_videos: 0 }, { max_videos: 21 }, { max_videos: '5' }, { recent_days: -1 }, { recent_days: 366 }, { recent_days: 0.5 }]) {
    assert.throws(() => validateKnowledgeRequest({ url: 'https://example.com', ...body }), { status: 400 });
  }
});

test('knowledge routes require login before contacting Python', async t => {
  const { base, calls } = await fixture(t, upstream => upstream.use((_req, res) => res.json({ documents: [], stats: {} })));
  for (const [path, method] of [['', 'GET'], ['/jobs', 'POST'], ['/jobs/other', 'GET']]) {
    const response = await fetch(`${base}/api/v1/knowledge${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.equal(response.status, 401);
  }
  assert.equal(calls.length, 0);
});

test('authenticated proxy sends only bounded inputs with the server credential and owns jobs by session', async t => {
  const { base, calls, login } = await fixture(t, upstream => {
    upstream.get('/api/v1/knowledge', (_req, res) => res.json({ documents: [], stats: { documents: 0, chunks: 0 } }));
    upstream.post('/api/v1/knowledge/jobs', (_req, res) => res.status(202).json({ job: { id: 'job_123', status: 'queued' } }));
    upstream.get('/api/v1/knowledge/jobs/job_123', (_req, res) => res.json({ job: { id: 'job_123', status: 'completed', document_count: 1 } }));
  });
  const cookie = await login();
  const inventory = await fetch(`${base}/api/v1/knowledge`, { headers: { cookie } });
  assert.equal(inventory.status, 200);
  assert.equal(inventory.headers.get('cache-control'), 'no-store');
  assert.match(calls[0].owner, /^guest:/);
  const invalid = await fetch(`${base}/api/v1/knowledge/jobs`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'http://localhost' }) });
  assert.equal(invalid.status, 400);
  assert.equal(calls.length, 1);
  const created = await fetch(`${base}/api/v1/knowledge/jobs`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: DEFAULT_KNOWLEDGE_URL, extra: 'drop me' }) });
  assert.equal(created.status, 202);
  assert.deepEqual(calls[1].body, { url: DEFAULT_KNOWLEDGE_URL, max_videos: 5, recent_days: 7 });
  assert.ok(calls.every(call => call.key === 'private-test-key'));
  const own = await fetch(`${base}/api/v1/knowledge/jobs/job_123`, { headers: { cookie } });
  assert.equal(own.status, 200);
  const otherCookie = await login();
  const foreign = await fetch(`${base}/api/v1/knowledge/jobs/job_123`, { headers: { cookie: otherCookie } });
  assert.equal(foreign.status, 404);
  assert.equal(calls.length, 3, 'foreign job must not reach upstream');
});

test('proxy redacts credentials and treats upstream authentication errors as unavailability', async t => {
  const { base, login } = await fixture(t, upstream => {
    upstream.get('/api/v1/knowledge', (_req, res) => res.json({ documents: [], stats: { documents: 0 }, note: 'private-test-key' }));
    upstream.post('/api/v1/knowledge/jobs', (_req, res) => res.status(401).json({ error: 'private-test-key denied' }));
  });
  const cookie = await login();
  const inventory = await fetch(`${base}/api/v1/knowledge`, { headers: { cookie } });
  assert.equal((await inventory.json()).note, '[redigido]');
  const response = await fetch(`${base}/api/v1/knowledge/jobs`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com' }) });
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /private-test-key/);
});

test('upstream redirects cannot forward the Python credential to another endpoint', async t => {
  const { base, calls, login } = await fixture(t, upstream => {
    upstream.get('/api/v1/knowledge', (_req, res) => res.redirect('/stolen'));
    upstream.get('/stolen', (_req, res) => res.json({ documents: [], stats: {} }));
  });
  const cookie = await login();
  assert.equal((await fetch(`${base}/api/v1/knowledge`, { headers: { cookie } })).status, 503);
  assert.deepEqual(calls.map(call => call.path), ['/api/v1/knowledge']);
});

test('UI summaries distinguish existing text, partial failures and empty imports honestly', () => {
  assert.match(formatJobSummary({ status: 'completed', document_count: 2, learned_count: 0 }), /0 nova/);
  assert.match(formatJobSummary({ status: 'partial', document_count: 1, learned_count: 1 }), /limitações/);
  assert.match(formatJobSummary({ status: 'completed', document_count: 0 }), /sem texto salvo/);
  assert.equal(formatJobSummary({ status: 'failed', error: 'Sem transcrição.' }), 'Sem transcrição.');
  assert.equal(isFinalJob({ status: 'running' }), false);
  assert.equal(isFinalJob({ status: 'partial' }), true);
  assert.equal(sourceLink('javascript:alert(1)'), null);
  assert.equal(sourceLink('https://user:pass@example.com'), null);
  assert.equal(sourceLink('https://example.com'), 'https://example.com/');
  assert.match(capabilitySummary({ asr_gemini: false, youtube_captions: false }), /áudio.*legendas/);
  assert.equal(capabilitySummary({ asr_gemini: true, youtube_captions: true, youtube_search: true, generative_model: true }), '');
});

function fakeDocument() {
  class Element {
    constructor() { this.listeners = {}; this.children = []; this.dataset = {}; this.textContent = ''; this.value = ''; this.disabled = false; this.hidden = false; this.open = false; }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    async dispatch(name, event = {}) { await Promise.all((this.listeners[name] || []).map(fn => fn(event))); }
    appendChild(element) { this.children.push(element); }
    replaceChildren(...elements) { this.children = elements; }
    querySelectorAll() { return this.inputs || []; }
    reportValidity() { return true; }
    showModal() { this.open = true; }
    close() { this.open = false; this.dispatch('close'); }
  }
  const ids = ['knowledge-dialog', 'knowledge-form', 'knowledge-progress', 'knowledge-sources', 'knowledge-results', 'knowledge-auth', 'knowledge-learn', 'knowledge-stats', 'knowledge-capabilities', 'btn-knowledge', 'knowledge-close', 'knowledge-login', 'knowledge-refresh', 'knowledge-url', 'knowledge-videos', 'knowledge-days'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  elements['knowledge-form'].inputs = ['knowledge-url', 'knowledge-videos', 'knowledge-days', 'knowledge-learn'].map(id => elements[id]);
  elements['knowledge-url'].value = DEFAULT_KNOWLEDGE_URL;
  elements['knowledge-videos'].value = '5';
  elements['knowledge-days'].value = '7';
  return { getElementById: id => elements[id], createElement: () => new Element(), elements };
}

test('UI handles real job flow, renders untrusted titles as text and refreshes saved counts', async () => {
  const doc = fakeDocument();
  const calls = [];
  let saved = false;
  initializeKnowledgeUI(doc, async (url, options = {}) => {
    calls.push({ url, options });
    let data;
    if (url.endsWith('/jobs') && options.method === 'POST') data = { job: { id: 'job_ui', status: 'queued' } };
    else if (url.endsWith('/jobs/job_ui')) {
      saved = true;
      data = { job: { id: 'job_ui', status: 'partial', document_count: 1, learned_count: 1, warnings: ['A data de um vídeo não pôde ser confirmada.'], results: [{ url: 'https://example.com', titulo: '<script>alert(1)</script>', status: 'learned' }, { url: 'javascript:alert(1)', titulo: 'Sem legenda', status: 'skipped', reason: 'Sem transcrição disponível.' }] } };
    } else data = { documents: saved ? [{ url: 'https://example.com', title: '<img onerror=alert(1)>', chunk_count: 3 }] : [], stats: { documents: saved ? 1 : 0, chunks: saved ? 3 : 0 }, capabilities: { asr_gemini: false } };
    return { ok: true, status: options.method === 'POST' ? 202 : 200, json: async () => data };
  });
  await doc.elements['btn-knowledge'].dispatch('click');
  assert.equal(doc.elements['knowledge-learn'].disabled, false);
  await doc.elements['knowledge-form'].dispatch('submit', { preventDefault() {} });
  assert.equal(doc.elements['knowledge-learn'].disabled, false);
  assert.match(doc.elements['knowledge-progress'].textContent, /limitações/);
  assert.match(doc.elements['knowledge-progress'].textContent, /data de um vídeo/);
  assert.match(doc.elements['knowledge-capabilities'].textContent, /áudio não está configurada/);
  assert.match(doc.elements['knowledge-stats'].textContent, /1 fonte.*3 trecho/);
  assert.equal(doc.elements['knowledge-results'].children[0].children[0].textContent, '<script>alert(1)</script>');
  assert.equal(doc.elements['knowledge-results'].children[1].children[0].href, undefined);
  assert.deepEqual(JSON.parse(calls.find(call => call.options.method === 'POST').options.body), { url: DEFAULT_KNOWLEDGE_URL, max_videos: 5, recent_days: 7 });
  doc.elements['knowledge-dialog'].close();
});

test('UI requires login and never submits a source after a session rejection', async () => {
  const doc = fakeDocument();
  let calls = 0;
  initializeKnowledgeUI(doc, async () => { calls++; return { status: 401, ok: false, json: async () => ({ mensagem: 'Login necessário.' }) }; });
  await doc.elements['btn-knowledge'].dispatch('click');
  assert.equal(doc.elements['knowledge-auth'].hidden, false);
  assert.equal(doc.elements['knowledge-learn'].disabled, true);
  await doc.elements['knowledge-form'].dispatch('submit', { preventDefault() {} });
  assert.equal(calls, 1);
  assert.match(doc.elements['knowledge-progress'].textContent, /Entre na sua conta/);
  doc.elements['knowledge-dialog'].close();
});
