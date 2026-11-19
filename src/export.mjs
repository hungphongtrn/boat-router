// Disaster-recovery export of the Durable Object state. NDJSON: one `meta` line (build,
// deployment, plain configuration), one `entry` line per storage key, one `end` line.
// Secrets never leave: the GitHub App record keeps only its id and slug, any field whose name
// looks like a credential is replaced by "[redacted]", and so is any PEM-shaped string.
// Environment bindings are included only when they are plain strings with a non-secret name.

export const SECRET_FIELD = /secret|token|pem|private|password|passphrase|jit|credential|api[_-]?key|apikey|bearer/i;
export const SECRET_BINDING = /SECRET|TOKEN|KEY|HASH|PASSWORD|BOOTSTRAP|CLIENTS|CREDENTIAL|PRIVATE/;
const PEM = /-----BEGIN [A-Z ]+-----/;
const REDACTED = '[redacted]';

export function redactRecord(value, depth = 0) {
  if (depth > 32) return REDACTED;
  if (typeof value === 'string') return PEM.test(value) ? REDACTED : value;
  if (Array.isArray(value)) return value.map(item => redactRecord(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = SECRET_FIELD.test(key) ? REDACTED : redactRecord(item, depth + 1);
    return out;
  }
  return value;
}

export function exportEntry(key, value) {
  if (key === 'github-app') {
    const { id, slug, secretsMovedAt } = value ?? {};
    return { id: id ?? null, slug: slug ?? null, ...(secretsMovedAt ? { secretsMovedAt } : {}), hadPrivateKey: typeof value?.pem === 'string', hadWebhookSecret: typeof value?.webhookSecret === 'string' };
  }
  return redactRecord(value);
}

export function exportVars(env) {
  const vars = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(name) || SECRET_BINDING.test(name) || PEM.test(value)) continue;
    vars[name] = value;
  }
  return vars;
}

export async function* exportLines(storage, env, { build = 'unbuilt', deployment = 'default', now = Date.now, pageSize = 128 } = {}) {
  yield JSON.stringify({ type: 'meta', version: 1, exportedAt: new Date(now()).toISOString(), build, deployment, vars: exportVars(env) });
  let count = 0, startAfter = '';
  for (;;) {
    const page = await storage.list({ startAfter, limit: pageSize });
    for (const [key, value] of page) { count++; yield JSON.stringify({ type: 'entry', key, value: exportEntry(key, value) }); }
    if (page.size < pageSize) break;
    startAfter = [...page.keys()].at(-1);
  }
  yield JSON.stringify({ type: 'end', entries: count });
}

export function exportResponse(storage, env, options = {}) {
  const lines = exportLines(storage, env, options);
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await lines.next();
        if (done) { controller.close(); return; }
        controller.enqueue(encoder.encode(value + '\n'));
      } catch (error) { controller.error(error); }
    },
    cancel() { lines.return?.(); },
  });
  return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' } });
}
