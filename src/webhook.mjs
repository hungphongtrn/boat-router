import { selectJob } from './domain.mjs';

export async function verifySignature(secret, body, signature) {
  if (typeof secret !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(signature ?? '')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const digest = Uint8Array.from(signature.slice(7).match(/../g), (hex) => Number.parseInt(hex, 16));
  return crypto.subtle.verify('HMAC', key, digest, body);
}

export async function webhook(request, env, secret, ingest, select = null) {
  if (Number(request.headers.get('Content-Length')) > 1_048_576) return new Response(null, { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400 });
  let length = 0;
  const chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 1_048_576) { await reader.cancel(); return new Response(null, { status: 413 }); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  if (!await verifySignature(secret, bytes, request.headers.get('X-Hub-Signature-256'))) {
    return new Response(null, { status: 401 });
  }
  if (request.headers.get('X-GitHub-Event') === 'ping') return new Response(null, { status: 204 });
  const name = request.headers.get('X-GitHub-Event');
  if (!select && name !== 'workflow_job') return new Response(null, { status: 204 });
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { return new Response(null, { status: 400 }); }
  let event;
  try { event = select ? select(name, payload) : selectJob(payload, env.ALLOW_SMOKE === 'true'); }
  catch (error) { if (error instanceof TypeError && /^(Unknown Boat size|Use one Boat runner label)/.test(error.message)) return new Response(error.message, { status: 400 }); throw error; }
  if (!event) return new Response(null, { status: 204 });
  await ingest(event);
  return new Response(null, { status: 202 });
}
