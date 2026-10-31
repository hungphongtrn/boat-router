// APIs.configure transfers JIT data through the Boat file API. The adapter
// persists only the runner id; the JIT configuration stays inside APIs.
export class JitAdapter {
  constructor(storage, api, resetVerifier = null) { Object.assign(this, { storage, api, resetVerifier }); this.deferredReset = !resetVerifier; }
  async register(job, generation) {
    const identity = { ...job, generation };
    let runnerId;
    await this.api.configure(identity, async id => {
      if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('invalid runner id');
      await this.storage.transaction(async tx => {
        const key = `machine:${job.machineId}`, machine = await tx.get(key);
        if (machine?.state !== 'assigning' || machine.lease !== job.id || machine.generation !== generation || (machine.runnerId != null && machine.runnerId !== id)) throw new Error('lost lease');
        await tx.put(key, { ...machine, runnerId: id });
      });
      runnerId = id;
    });
    if (!runnerId) throw new Error('runner identity missing');
    return { ...identity, runnerId };
  }
  async start(machineId, registration) {
    if (registration?.machineId !== machineId) throw new Error('machine identity mismatch');
    const machine = await this.storage.get(`machine:${machineId}`);
    if (machine?.state !== 'assigning' || machine.lease !== registration.id || machine.generation !== registration.generation || machine.runnerId !== registration.runnerId) throw new Error('lost lease');
    const result = await this.api.start(registration);
    if (result?.success === false) throw new Error('runner start failed');
  }
  async removeRunner(job, generation) {
    const machine = await this.storage.get(`machine:${job.machineId}`);
    if (machine?.state !== 'cleaning' || machine.lease !== job.id || machine.generation !== generation || !Number.isSafeInteger(machine.runnerId)) throw new Error('runner identity unavailable');
    try { await this.api.removeRunner({ ...job, runnerId: machine.runnerId, generation }); }
    catch (error) { if (error?.status !== 404) throw error; }
  }
  async resetAndVerify(machineId) {
    if (!this.resetVerifier) return null;
    return this.resetVerifier(machineId);
  }
  async canRetry(job) {
    if (!job.operationId || !['purging', 'pool_silent_wait'].includes(job.phase)) return null;
    const deletion = await this.api.deletion(job);
    const actual = await this.api.getJob(job, job.id);
    return { boxTerminal: deletion?.operation?.status === 'completed', jobQueued: actual?.status === 'queued' };
  }
}
