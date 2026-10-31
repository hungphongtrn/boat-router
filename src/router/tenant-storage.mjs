const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class TenantStorage {
  constructor(storage, project) {
    if (!PROJECT_ID.test(project)) throw new TypeError('invalid project id');
    this.storage = storage;
    this.prefix = `project:${project}:`;
  }
  key(key) {
    if (typeof key !== 'string') throw new TypeError('invalid storage key');
    return this.prefix + key;
  }
  async get(key, options) {
    if (Array.isArray(key)) {
      const result = await this.storage.get(key.map(k => this.key(k)), options);
      return new Map([...result].map(([k, v]) => [k.slice(this.prefix.length), v]));
    }
    return this.storage.get(this.key(key), options);
  }
  put(key, value, options) {
    if (typeof key === 'object' && key !== null) {
      return this.storage.put(Object.fromEntries(Object.entries(key).map(([k, v]) => [this.key(k), v])), value);
    }
    return this.storage.put(this.key(key), value, options);
  }
  delete(key, options) {
    return this.storage.delete(Array.isArray(key) ? key.map(k => this.key(k)) : this.key(key), options);
  }
  async list(options = {}) {
    const query = { ...options, prefix: this.key(options.prefix ?? '') };
    for (const bound of ['start', 'startAfter', 'end']) if (options[bound] !== undefined) query[bound] = this.key(options[bound]);
    const result = await this.storage.list(query);
    return new Map([...result].map(([k, v]) => [k.slice(this.prefix.length), v]));
  }
  transaction(fn) { return this.storage.transaction(tx => fn(new TenantStorage(tx, this.prefix.slice(8, -1)))); }
  getAlarm(options) { return this.storage.getAlarm(options); }
  // All tenants share one Durable Object alarm. Never let a later request
  // postpone an earlier tenant's wakeup.
  setAlarm(time, options) {
    return this.storage.transaction(async tx => {
      const previous = await tx.getAlarm();
      if (previous === null || Number(time) < previous) await tx.setAlarm(time, options);
    });
  }
}
