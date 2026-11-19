import worker, { Fleet } from '../src/worker.mjs';
export default worker;
export class TestFleet extends Fleet {
  async fetch(request) {
    if (new URL(request.url).pathname === '/step') {
      await this.controller.patch(501, { nextAt: 0 });
      await this.controller.tick();
      return new Response(null, { status: 204 });
    }
    if (new URL(request.url).pathname === '/inspect') {
      return Response.json({ job: await this.controller.storage.get('job:501'),
        alarm: await this.controller.storage.getAlarm(),
        activeCount: (await this.controller.storage.list({ prefix: 'due:' })).size });
    }
    return super.fetch(request);
  }
}
