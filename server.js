#!/usr/bin/env node
// diskuss: 2つのAIが討論し、オブザーバーAIが判定するローカル Web アプリ
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProviders, OBSERVER } from './lib/providers.js';
import { runDebate, toMarkdown, NAMES, DEFAULT_MAX_ROUNDS, MAX_ROUNDS_LIMIT, MIN_ROUNDS } from './lib/debate.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const TRANSCRIPT_DIR = join(ROOT, 'transcripts');
const PORT = Number(process.env.PORT) || 3210;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const debates = new Map();
let providersPromise;

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error('リクエストが大きすぎます');
  }
  return JSON.parse(raw || '{}');
}

async function parseDebater(input, name) {
  const providers = await providersPromise;
  const p = providers.find((x) => x.id === input?.provider);
  if (!p) throw new Error(`${name}のプロバイダが不正です`);
  if (!p.available) throw new Error(`${p.label} はこのマシンで利用できません`);
  const model = String(input.model ?? '');
  if (!p.models.some((m) => m.id === model)) throw new Error(`${name}のモデルが不正です`);
  return { provider: p.id, model };
}

async function startDebate(body) {
  const topic = String(body.topic ?? '').trim();
  if (!topic) throw new Error('議論テーマを入力してください');
  if (topic.length > 2000) throw new Error('議論テーマが長すぎます');
  const debaters = { AI1: await parseDebater(body.ai1, NAMES.AI1), AI2: await parseDebater(body.ai2, NAMES.AI2) };
  const maxRounds = Math.min(MAX_ROUNDS_LIMIT, Math.max(MIN_ROUNDS, Math.round(Number(body.maxRounds)) || DEFAULT_MAX_ROUNDS));
  const fixedStances = {
    AI1: String(body.stance1 ?? '').trim().slice(0, 500),
    AI2: String(body.stance2 ?? '').trim().slice(0, 500),
  };

  const id = randomUUID();
  const debate = { id, events: [], listeners: new Set(), done: false, abort: new AbortController() };
  debates.set(id, debate);

  const emit = (type, data = {}) => {
    const ev = { seq: debate.events.length, type, ...data };
    debate.events.push(ev);
    for (const send of debate.listeners) send(ev);
  };

  emit('started', { topic, debaters, maxRounds, observer: OBSERVER.label });
  runDebate({ topic, debaters, maxRounds, fixedStances, emit, signal: debate.abort.signal })
    .then(async (result) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const file = join(TRANSCRIPT_DIR, `${stamp}.md`);
      await mkdir(TRANSCRIPT_DIR, { recursive: true });
      await writeFile(file, toMarkdown(result));
      emit('saved', { file: `transcripts/${stamp}.md` });
    })
    .catch((err) => emit('error', { message: err.message }))
    .finally(() => {
      debate.done = true;
      emit('done');
      for (const send of debate.listeners) send(null);
      // 終了した討論は 1 時間後にメモリから破棄する
      setTimeout(() => debates.delete(id), 60 * 60 * 1000).unref();
    });
  return id;
}

function streamEvents(req, res, debate) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const lastId = Number(req.headers['last-event-id']);
  const from = Number.isInteger(lastId) ? lastId + 1 : 0;
  const send = (ev) => {
    if (ev === null) return res.end();
    res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
  };
  for (const ev of debate.events.slice(from)) send(ev);
  if (debate.done) return res.end();
  debate.listeners.add(send);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    debate.listeners.delete(send);
  });
}

async function serveStatic(res, pathname) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname);
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && pathname === '/api/config') {
      return sendJson(res, 200, {
        providers: await providersPromise,
        observer: OBSERVER.label,
        names: NAMES,
        rounds: { min: MIN_ROUNDS, max: MAX_ROUNDS_LIMIT, default: DEFAULT_MAX_ROUNDS },
      });
    }
    if (req.method === 'POST' && pathname === '/api/debates') {
      let id;
      try {
        id = await startDebate(await readBody(req));
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
      return sendJson(res, 201, { id });
    }
    const m = pathname.match(/^\/api\/debates\/([\w-]+)\/(events|cancel)$/);
    if (m) {
      const debate = debates.get(m[1]);
      if (!debate) return sendJson(res, 404, { error: '討論が見つかりません' });
      if (m[2] === 'events' && req.method === 'GET') return streamEvents(req, res, debate);
      if (m[2] === 'cancel' && req.method === 'POST') {
        debate.abort.abort();
        return sendJson(res, 200, { ok: true });
      }
    }
    if (req.method === 'GET') return serveStatic(res, pathname);
    sendJson(res, 405, { error: 'method not allowed' });
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
  }
});

providersPromise = listProviders();
server.listen(PORT, HOST, async () => {
  const providers = await providersPromise;
  console.log(`diskuss: http://${HOST}:${PORT}`);
  for (const p of providers) console.log(`  ${p.available ? '✓' : '✗'} ${p.label}${p.available ? ` (${p.models.length} モデル)` : ' — 見つかりません'}`);
  console.log(`  オブザーバー: ${OBSERVER.label}`);
});

process.on('SIGINT', () => {
  for (const d of debates.values()) d.abort.abort();
  process.exit(0);
});
