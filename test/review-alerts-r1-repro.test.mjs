// Reviewer repro: run the real AlertHooks inside workerd (Miniflare) with its DEFAULT fetcher.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { build } from 'esbuild';

const worker = `
import { AlertHooks } from './src/router/alert-hooks.mjs';
class MemStorage { constructor() { this.m = new Map(); }
  async get(k) { return this.m.get(k); } async put(k, v) { this.m.set(k, v); }
  async transaction(fn) { return fn(this); } }
export default { async fetch(request, env, ctx) {
  const url = new URL(request.url);
  const errors = [];
  const hooks = new AlertHooks(new MemStorage(), [{ on: ['breaker_open'], url: 'https://hooks.example/alert' }], () => env, { waitUntil: p => ctx.waitUntil(p) });
  if (url.pathname === '/bound') hooks.fetcher = fetch.bind(globalThis);
  // Wrap to observe the exception the production code swallows.
  const inner = hooks.fetcher;
  const probe = { inner };
  hooks.fetcher = async function (...args) { try { return await inner.apply(this, args); } catch (e) { errors.push(String(e)); throw e; } };
  await hooks.observe('breaker_open', { active: true, value: 1, limit: 1 });
  await new Promise(r => setTimeout(r, 200));
  return Response.json({ errors });
} };`;

test('default AlertHooks fetcher delivers inside workerd', async () => {
  const out = await build({ stdin: { contents: worker, resolveDir: process.cwd(), loader: 'js' }, bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent' });
  const received = [];
  const mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], log: new Log(LogLevel.ERROR),
    outboundService: async request => { received.push(request.url); return new Response(null, { status: 204 }); } });
  try {
    const bound = await (await mf.dispatchFetch('https://w.test/bound')).json();
    console.log('bound fetch:', JSON.stringify(bound), 'received', received.length);
    assert.equal(received.length, 1, 'control: bound fetch delivers');
    received.length = 0;
    const unbound = await (await mf.dispatchFetch('https://w.test/default')).json();
    console.log('default fetcher:', JSON.stringify(unbound), 'received', received.length);
    assert.equal(received.length, 1, 'default fetcher should deliver one POST');
  } finally { await mf.dispose(); }
});
