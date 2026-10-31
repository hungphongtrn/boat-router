import { BUILD_COMMIT } from './build.mjs';
export { Fleet } from './fleet.mjs';
function fleet(env) { return env.FLEET.get(env.FLEET.idFromName('production-v1')); }
function forward(request, env) {
  const headers = new Headers(request.headers);
  headers.set('X-Boat-CI-Enabled', env.ENABLED === 'true' ? 'true' : 'false');
  return fleet(env).fetch(new Request(request, { headers }));
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/router/build') {
      const response = await forward(request, env);
      if (!response.ok) return response;
      const data = await response.json();
      return Response.json({ worker_commit: BUILD_COMMIT, do_commit: data.do_commit }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (request.method === 'GET' && url.pathname === '/health') return forward(new Request('https://fleet/health'), env);
    if ((request.method === 'POST' && url.pathname === '/webhook') ||
      ['/setup', '/setup/callback', '/setup/installed', '/setup/reset', '/setup/status', '/proof', '/status', '/events', '/router/claims', '/router/pool-shadow', '/router/pool-mode', '/router/pools', '/router/reconcile', '/router/box', '/router/restart', '/router/status', '/router/reuse', '/router/resync', '/router/release', '/router/verification-breaker', '/router/verification-outcomes', '/router/verification-failures', '/router/local/claim', '/router/local/release', '/router/local/started', '/router/local/operator-release'].includes(url.pathname)) return forward(request, env);
    return new Response('Not found', { status: 404 });
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(forward(new Request('https://fleet/sweep', { method: 'POST' }), env));
  },
};
