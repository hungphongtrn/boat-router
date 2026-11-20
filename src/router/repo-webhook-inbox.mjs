const prefix = 'repo-webhook-inbox:';
const batchSize = 32;

function wake(storage, at) {
  return storage.transaction(async tx => {
    const alarm = await tx.getAlarm();
    if (alarm === null || alarm > at) await tx.setAlarm(at);
  });
}

// The acknowledgment commits only the selected event and its wakeup. The inbox
// shares the Fleet DO with polling, so the consumer uses the same admission lock.
export class RepoWebhookInbox {
  constructor(storage, router) {
    this.storage = storage;
    this.router = router;
    const runTick = router.runTick.bind(router);
    router.runTick = async () => {
      await this.drain();
      return runTick();
    };
  }

  async enqueue(selection, receivedAt) {
    const key = `${prefix}${String(receivedAt).padStart(16, '0')}:${crypto.randomUUID()}`;
    await this.storage.transaction(async tx => {
      await tx.put(key, { selection, receivedAt });
      const alarm = await tx.getAlarm();
      if (alarm === null || alarm > receivedAt + 1000) await tx.setAlarm(receivedAt + 1000);
    });
  }

  async drain() {
    const entries = await this.storage.list({ prefix, limit: batchSize });
    for (const [key, { selection, receivedAt }] of entries) {
      const started = Date.now();
      const { event, project } = selection;
      try {
        await this.router.ingest(selection, { receivedAt });
        await this.storage.delete(key);
        if (event.status === 'queued') console.info(JSON.stringify({ event: 'repo_webhook_observed', project, job_id: event.id, run_id: event.runId, inbox_ms: started - receivedAt, ingest_ms: Date.now() - started }));
      } catch {
        // Keep the event for an alarm retry, without blocking other deliveries.
        await wake(this.storage, Date.now() + 5000);
        console.warn(JSON.stringify({ event: 'repo_webhook_ingest_failed', project, job_id: event.id }));
      }
    }
    if (entries.size === batchSize) await wake(this.storage, Date.now() + 1000);
  }

  async alarm() {
    const overlapping = this.router.ticking;
    await this.router.tick();
    // This alarm may have fired after a running tick took its inbox snapshot.
    // In that case it must not consume the wakeup without processing the inbox.
    if (overlapping && (await this.storage.list({ prefix, limit: 1 })).size) await this.router.tick();
  }
}
