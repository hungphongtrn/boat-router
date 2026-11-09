import { generateKeyPairSync } from 'node:crypto';
import { APIs } from '../src/apis.mjs';
import { FleetController } from '../src/fleet.mjs';

export class Storage {
  constructor() { this.data = new Map(); this.alarm = null; this.queue = Promise.resolve(); }
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, value) { this.data.set(key, structuredClone(value)); }
  async delete(key) { this.data.delete(key); }
  async getAlarm() { return this.alarm; }
  async setAlarm(time) { this.alarm = time; }
  async list({ prefix = '', limit = Infinity, startAfter = '' } = {}) {
    return new Map([...this.data].filter(([k]) => k.startsWith(prefix) && k > startAfter).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([k, v]) => [k, structuredClone(v)]));
  }
  transaction(fn) {
    const result = this.queue.then(() => fn(this));
    this.queue = result.catch(() => {});
    return result;
  }
}
export function event(id = 101, label = 'boat-default', status = 'queued', runnerName = null) {
  return { id, label, size: { 'boat-default': 'default', 'boat-large': 'large', 'boat-xlarge': 'xlarge' }[label],
    repo: 'hungphongtrn/peek', installation: 1, status, runnerName };
}
export function fixture() {
  const clock = { time: 1_000_000 };
  const now = () => clock.time;
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const env = { ENABLED: 'true', GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: privateKey,
    BOAT_CI_API_KEY: 'fake-boat-token', GITHUB_WEBHOOK_SECRET: 'fake-webhook-secret' };
  const fake = {
    requests: [], machines: new Map(), jobs: new Map(), runners: new Map(), keys: new Map(),
    starts: 0, refusals: [], deletes: [], files: [], commands: [], jit: 'PRIVATE_FAKE_JIT_MUST_NEVER_APPEAR_IN_LOGS',
    loseCreateResponse: false, purgeComplete: true, jobOutage: false,
  };
  const respond = (value, status = 200) => new Response(status === 204 ? null : JSON.stringify(value), { status });
  const fetcher = async (url, options) => {
    const u = new URL(url); const path = u.pathname; const method = options.method;
    const body = options.body ? JSON.parse(options.body) : undefined;
    fake.requests.push({ host: u.host, path, method, body, headers: options.headers });
    if (u.host === 'api.github.com') {
      if (path.endsWith('/access_tokens')) return respond({ token: 'fake-installation-token', expires_at: new Date(now() + 3600_000).toISOString() }, 201);
      const job = /\/actions\/jobs\/(\d+)$/.exec(path);
      if (job) {
        if (fake.jobOutage) return respond({ message: fake.jit }, 503);
        return respond(fake.jobs.get(Number(job[1])) ?? { id: Number(job[1]), status: 'queued' });
      }
      if (path.endsWith('/generate-jitconfig')) {
        const id = 100 + fake.runners.size;
        fake.runners.set(id, { id, name: body.name, busy: false, status: 'offline' });
        return respond({ runner: { id }, encoded_jit_config: fake.jit }, 201);
      }
      const runner = /\/actions\/runners\/(\d+)$/.exec(path);
      if (runner) {
        const id = Number(runner[1]);
        if (!fake.runners.has(id)) return respond({}, 404);
        if (method === 'DELETE') { fake.runners.delete(id); return respond({}, 204); }
        return respond(fake.runners.get(id));
      }
      if (path.endsWith('/actions/runners')) return respond({ runners: [...fake.runners.values()].filter(r => r.name === u.searchParams.get('name')) });
    }
    if (u.host === 'boat.dev') {
      if (path.endsWith('/limits')) return respond({ nextStartDollars: 0, overagePrices: { vmHourDollars: 0.036, startBrackets: [{ aboveMultiple: 1, upToMultiple: 1.5, dollars: 0.03 }, { aboveMultiple: 1.5, upToMultiple: 2, dollars: 0.05 }, { aboveMultiple: 2, upToMultiple: 3, dollars: 0.07 }], startLimitMultiplier: 3 }, canStart: true, billingStatus: 'active', machineTypes: ['default', 'large', 'xlarge'].map(type => ({ type, available: true })) });
      if (path.endsWith('/sandboxes') && method === 'POST') {
        if (fake.refusals.length) { const r = fake.refusals.shift(); return respond({ code: r.code, retryAfterSeconds: r.retryAfterSeconds, message: fake.jit }, r.status); }
        const key = new Headers(options.headers).get('Idempotency-Key');
        let id = fake.keys.get(key);
        if (!id) {
          id = `bx_2345678${++fake.starts + 1}`; fake.keys.set(key, id);
          fake.machines.set(id, { id, state: 'ready', setupStatus: 'done', size: body.type });
        }
        if (fake.loseCreateResponse) { fake.loseCreateResponse = false; throw new Error(fake.jit); }
        return respond({ sandbox: fake.machines.get(id) }, 202);
      }
      if (path.includes('/deletion-operations/')) return respond({ operation: { id: path.split('/').at(-1), status: fake.purgeComplete ? 'completed' : 'waiting_for_uploads' } });
      const machine = /\/sandboxes\/(bx_[^/]+)$/.exec(path);
      if (machine) {
        const id = machine[1];
        if (method === 'DELETE') {
          fake.deletes.push(id); fake.machines.delete(id);
          return respond({ operation: { id: `del-${id}`, status: 'pending' } }, 202);
        }
        return fake.machines.has(id) ? respond({ sandbox: fake.machines.get(id) }) : respond({}, 404);
      }
      if (path.endsWith('/files')) { fake.files.push(body); return respond({ success: true }); }
      if (path.endsWith('/commands')) { fake.commands.push(body); return respond({ success: true, processId: 123 }); }
    }
    throw new Error('Unhandled fake API route');
  };
  const storage = new Storage(); const logs = [];
  const api = new APIs(env, fetcher, now);
  const controller = new FleetController(storage, env, api, now, line => logs.push(line));
  async function pump(count = 30, interval = 15_000) {
    for (let i = 0; i < count; i++) { clock.time += interval; await controller.tick(); }
  }
  return { clock, now, env, fake, fetcher, storage, logs, api, controller, pump };
}
