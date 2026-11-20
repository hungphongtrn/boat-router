import { recordEntries } from './pool-records.mjs';

const HOT_RANGE = /^(?:project:[a-z0-9-]+:(?:gh-job|box|create|local-runner|runner|job):|external-lease:)/;
const MAX_ROWS = 20000;
const MAX_WEIGHT = 16 * 1024 * 1024;
const weight = (key, value) => 128 + 2 * (key.length + JSON.stringify(value).length);

// Cache only whole, known ranges. Point reads, arbitrary lists and reads within
// storage transactions keep using native storage. Cache state is never durable.
export class ReadCache {
  #ranges = new Map();
  #rows = 0;
  #weight = 0;

  #range(prefix) {
    if (!this.#ranges.has(prefix)) this.#ranges.set(prefix, { rows: null, weight: 0, writers: 0, revision: 0 });
    return this.#ranges.get(prefix);
  }

  #evict(range) {
    if (!range.rows) return;
    this.#rows -= range.rows.size;
    this.#weight -= range.weight;
    range.rows = null;
    range.weight = 0;
  }

  #cache(prefix, key, range, value) {
    if (!range.rows) return;
    const previous = range.rows.get(key);
    if (previous) {
      range.rows.delete(key);
      this.#rows--;
      this.#weight -= previous.weight;
      range.weight -= previous.weight;
    }
    if (value === undefined) return;
    let size;
    try { size = weight(key, value); } catch { this.#evict(range); return; }
    // Never truncate: a range which doesn't fit always reads from storage.
    if (this.#rows >= MAX_ROWS || this.#weight + size > MAX_WEIGHT || !key.startsWith(prefix) || !/^[\x20-\x7e]+$/.test(key)) {
      this.#evict(range);
      return;
    }
    this.#rows++;
    this.#weight += size;
    range.weight += size;
    range.rows.set(key, { value: structuredClone(value), weight: size });
  }

  async #records(storage, prefix) {
    if (HOT_RANGE.exec(prefix)?.[0] !== prefix) return [...(await recordEntries(storage, prefix)).values()];
    const range = this.#range(prefix);
    if (range.rows && !range.writers) {
      // ASCII keys sort in the same order as SQLite KV's UTF-8 keys. Clone
      // because planning may attach transient fields to the returned records.
      return structuredClone([...range.rows.keys()].sort().map(key => range.rows.get(key).value));
    }
    const revision = range.revision;
    const rows = await recordEntries(storage, prefix);
    if (!range.rows && !range.writers && revision === range.revision && rows.size + this.#rows <= MAX_ROWS) {
      range.rows = new Map();
      for (const [key, value] of rows) {
        this.#cache(prefix, key, range, value);
        if (!range.rows) break;
      }
    }
    return [...rows.values()];
  }

  #change(journal, key, value) {
    const prefix = HOT_RANGE.exec(key)?.[0];
    if (!prefix) return;
    const range = this.#range(prefix);
    let changes = journal.get(prefix);
    if (!changes) {
      if (range.writers++) this.#evict(range); // Competing commit order: reload from storage.
      range.revision++;
      journal.set(prefix, changes = new Map());
    }
    if (range.rows) changes.set(key, structuredClone(value));
  }

  #finish(journal, committed) {
    for (const [prefix, changes] of journal) {
      const range = this.#ranges.get(prefix);
      // A failed operation may have been caught inside a transaction. In doubt,
      // discard the range rather than publishing bytes that were not written.
      if (!committed) this.#evict(range);
      else for (const [key, value] of changes) this.#cache(prefix, key, range, value);
      range.writers--;
      range.revision++;
    }
  }

  wrap(storage, journal = null) {
    return new Proxy(storage, { get: (target, method) => {
      if (method === 'records' && !journal) return prefix => this.#records(storage, prefix);
      if (method === 'transaction' && typeof target.transaction === 'function') return async fn => {
        let changes = new Map();
        try {
          const result = await storage.transaction(tx => {
            this.#finish(changes, false); // Native transaction callbacks may retry.
            changes = new Map();
            return fn(this.wrap(tx, changes));
          });
          this.#finish(changes, true);
          return result;
        } catch (error) { this.#finish(changes, false); throw error; }
      };
      if (method === 'rollback' && typeof target.rollback === 'function') return (...args) => {
        for (const prefix of journal?.keys() ?? []) this.#evict(this.#ranges.get(prefix));
        return target.rollback(...args);
      };
      if (method === 'put' || method === 'delete') return async (...args) => {
        const changes = journal ?? new Map();
        try {
          const [key, value] = args;
          const updates = method === 'put' ? (typeof key === 'string' ? [[key, value]] : Object.entries(key)) : (Array.isArray(key) ? key : [key]).map(k => [k, undefined]);
          for (const [k, v] of updates) this.#change(changes, k, v);
          const result = await target[method](...args);
          if (!journal) this.#finish(changes, true);
          return result;
        } catch (error) {
          if (!journal) this.#finish(changes, false);
          else for (const prefix of changes.keys()) this.#evict(this.#ranges.get(prefix));
          throw error;
        }
      };
      const value = target[method];
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
}
