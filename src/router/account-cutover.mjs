import { SharedBudget } from './shared-budget.mjs';
import { snapshotLimits } from './ledger.mjs';

// Untagged records predate the cutover and belong to the secondary account.
export function accountApi(storage, secondary, work) {
  const active = work;
  const forIdentity = async (identity = {}) => {
    const box = identity.machineId ? await storage.get(`box:${identity.machineId}`) : null;
    const account = identity.account ?? box?.account ?? (identity.machineId || identity.createKey ? 'secondary' : 'primary');
    if (!['secondary', 'primary'].includes(account)) throw new TypeError('unknown box account');
    return account === 'secondary' ? secondary : work;
  };
  return new Proxy(active, {
    get(target, name) {
      if (name === 'forIdentity') return forIdentity;
      if (typeof target[name] !== 'function') return target[name];
      if (['limits', 'listSandboxes'].includes(name)) return target[name].bind(target);
      return async (...args) => {
        const api = await forIdentity(args[0]);
        return api[name](...args);
      };
    },
  });
}

// both Boat accounts form one open pool. A start goes to an account that can start now
// and has the larger share of its day window free. An account without credit, with a full day window, or with a
// recent provider refusal is skipped quietly; the other account serves the start.
export const ACCOUNT_BLOCK_MS = 900_000;
export const accountBlockKey = account => `account-block:${account}`;
const BILLING_BLOCKED = ['past_due', 'unpaid', 'canceled'];
const FUNDS = limits => [limits.creditBalanceSeconds, limits.packBalanceSeconds, limits.subscriptionRemainingSeconds, limits.creditBalanceHours, limits.planIncluded?.vmHoursRemaining].filter(Number.isFinite);

// Fields the provider omits give no opinion: the ledger still checks every window before a start.
export function accountReady(limits, size) {
  if (!limits || limits.canStart !== true || limits.checkoutRequired === true || BILLING_BLOCKED.includes(limits.billingStatus)) return false;
  if (size && !limits.machineTypes?.some(type => type.type === size && type.available === true)) return false;
  const funds = FUNDS(limits);
  if (limits.unlimited !== true && funds.length && !funds.some(value => value > 0)) return false;
  if (limits.nextStartDollars !== undefined && limits.nextStartDollars !== 0) return false;
  const day = limits.starts?.day;
  if (Number.isFinite(day?.remaining) && day.remaining < 1) return false;
  return true;
}

// Starts the ledger admitted that the provider snapshot may not count yet use the window too.
export async function dayShareFree(limits, ledger) {
  const day = limits?.starts?.day;
  if (!Number.isFinite(day?.limit) || day.limit < 1 || !Number.isFinite(day?.remaining)) return null;
  let unobserved = 0;
  try {
    const state = ledger ? await ledger.storage.get(ledger.key) : null;
    const at = limits.observedAt ?? 0;
    unobserved = Object.values(state?.claims ?? {}).filter(claim => claim.status !== 'created' || (claim.settledAt ?? claim.at) >= at).length;
  } catch { /* The provider counter alone still orders the accounts. */ }
  return Math.max(0, day.remaining - unobserved) / day.limit;
}

export async function accountBlocked(storage, account, now) {
  const block = await storage.get(accountBlockKey(account));
  return Number.isFinite(block?.until) && block.until > now;
}

// Returns 'secondary' when the secondary account should take a new start, otherwise 'primary'.
// `snapshot` names the accounts that hold a snapshot for this start; an account with the snapshot wins while it can
// start, because a box from the other account would boot cold.
export async function preferredAccount({ storage, poolOptions, secondaryLedger, workLedger, size, now, snapshot = null }) {
  if (!poolOptions?.secondaryEnabled) return 'primary';
  if (await accountBlocked(storage, 'secondary', now)) return 'primary';
  let secondaryLimits;
  try { secondaryLimits = await (poolOptions.secondaryChoiceLimits ?? poolOptions.secondaryLimits)(); } catch { return 'primary'; }
  if (!accountReady(secondaryLimits, size)) return 'primary';
  if (!poolOptions.workEnabled || !poolOptions.workLimits) return 'secondary';
  let workLimits;
  try { workLimits = await poolOptions.workLimits(); } catch { return 'secondary'; }
  if (!accountReady(workLimits, size)) return 'secondary';
  if (snapshot && snapshot.primary !== snapshot.secondary) return snapshot.primary ? 'primary' : 'secondary';
  const [secondaryShare, workShare] = await Promise.all([dayShareFree(secondaryLimits, secondaryLedger), dayShareFree(workLimits, workLedger)]);
  if (secondaryShare == null) return 'primary';
  if (workShare == null) return 'secondary';
  return secondaryShare >= workShare ? 'secondary' : 'primary';
}

// A provider refusal on the secondary account parks only that account; the project keeps starting on primary.
export async function blockAccount(storage, account, now, reason, delayMs = ACCOUNT_BLOCK_MS) {
  await storage.put(accountBlockKey(account), { at: now, until: now + delayMs, reason });
}

export function availablePacedStarts(state, at) {
  const sample = state?.pacingStatus;
  if (!Number.isFinite(sample?.sampledAt) || sample.sampledAt > at || at - sample.sampledAt > 30_000 || !Number.isFinite(sample.burstCredit) || !sample.remaining || !['minute', 'hour', 'day'].every(key => Number.isFinite(sample.remaining[key]))) return null;
  return Math.max(0, Math.min(sample.burstCredit, sample.remaining.minute, sample.remaining.hour, sample.remaining.day));
}

export function cutoverBudget(storage, secondaryLedger, workLedger, project, now, poolOptions = null) {
  const secondary = new SharedBudget(secondaryLedger, project, now);
  const work = new SharedBudget(workLedger, project, now);
  return new Proxy(work, {
    get(target, name) {
      if (name === 'selectAccount' && poolOptions) return async (key, size) => {
        const recordKey = `create:${key}`, record = await storage.get(recordKey);
        if (!record || record.state !== 'pending' || record.accountReconciliationMissing) return false;
        const selectSecondary = () => storage.transaction(async tx => {
          const current = await tx.get(recordKey);
          if (!current || current.state !== 'pending' || current.createKey !== record.createKey) return false;
          await tx.put(recordKey, { ...current, account: 'secondary' });
          return true;
        });
        const [secondaryClaim, workClaim] = await Promise.all([secondary.claim(key), work.claim(key)]);
        if (secondaryClaim && workClaim) throw new Error('create claimed by multiple accounts');
        if (secondaryClaim) {
          if (secondaryClaim.status === 'pending' && !poolOptions.secondaryEnabled) return false;
          if (!await selectSecondary()) return false;
          await work.abandon(key);
          return true;
        }
        if (workClaim) return record.account === 'primary' && (workClaim.status !== 'pending' || poolOptions.workEnabled);
        const snapshot = poolOptions.snapshotAccounts?.(project) ?? null;
        if (poolOptions.secondaryEnabled && await preferredAccount({ storage: secondaryLedger.storage, poolOptions, secondaryLedger, workLedger, size, now: now(), snapshot }) === 'secondary') {
          try {
            const limits = await poolOptions.secondaryLimits();
            if (accountReady(limits, size)) {
              const result = await secondary.admit(key, limits, { queuedAt: record.queuedAt, jobId: record.snapshotRecoveryJobId, pool: true, label: JSON.parse(record.pool)[1], snapshotRecovery: Boolean(record.snapshotRecoveryJobId) });
              if (result.ok) {
                if (!await selectSecondary()) { await secondary.abandon(key); return false; }
                await work.abandon(key);
                return true;
              }
            }
          } catch { /* The work account can still serve the request. */ }
          // A secondary claim can exist if the response or storage write failed.
          // Never fall back to a second account while it is unresolved.
          if (await secondary.claim(key)) return false;
          await secondary.abandon(key);
        }
        return poolOptions.workEnabled;
      };
      if (name === 'blockAccount') return async (account, reason, delayMs) => { if (account === 'secondary') await blockAccount(secondaryLedger.storage, account, now(), reason, delayMs); };
      if (name === 'migrationLedgerKey') return secondaryLedger.key;
      if (name === 'ledger' || name === 'project' || name === 'now') return target[name];
      if (name === 'claimKey') return target.claimKey.bind(target);
      if (typeof target[name] !== 'function') return target[name];
      return async (key, ...args) => {
        const record = await storage.get(`create:${key}`);
        const account = record?.account ?? (record ? 'secondary' : 'primary');
        if (!['secondary', 'primary'].includes(account)) throw new TypeError('unknown create account');
        return (account === 'secondary' ? secondary : work)[name](key, ...args);
      };
    },
  });
}

export function externalCutoverLedger(secondary, work, poolOptions = null, now = Date.now) {
  const keyPosition = { claim: 0, enqueue: 1, admit: 1, begin: 1, abandon: 1, resolve: 0 };
  return new Proxy(work, { get(target, name) {
    if (name === 'selectForLease' && poolOptions) return async lease => {
      // A base lease starts on secondary only when the operator pinned a secondary copy of that base.
      const workOnly = lease.baseId != null && !poolOptions.secondaryBase?.(lease);
      const [secondaryClaim, workClaim] = await Promise.all([secondary.claim(lease.claimKey), work.claim(lease.claimKey)]);
      if (secondaryClaim && workClaim) throw new Error('lease claimed by multiple accounts');
      if (secondaryClaim) return !workOnly && (secondaryClaim.status !== 'pending' || poolOptions.secondaryEnabled) ? 'secondary' : null;
      if (workClaim) return workClaim.status !== 'pending' || poolOptions.workEnabled ? 'primary' : null;
      if (!workOnly && poolOptions.secondaryEnabled && await preferredAccount({ storage: secondary.storage, poolOptions, secondaryLedger: secondary, workLedger: work, size: lease.size, now: now() }) === 'secondary') {
        try {
          const limits = await poolOptions.secondaryLimits();
          if (accountReady(limits, lease.size)) {
            await secondary.enqueue(lease.project, lease.claimKey, lease.createdAt, undefined, { client: lease.client });
            const admitted = await secondary.admit(lease.project, lease.claimKey, snapshotLimits(limits, now()));
            if (admitted.ok) return 'secondary';
          }
        } catch { /* Work remains available if secondary limits fail. */ }
        if (await secondary.claim(lease.claimKey)) return null;
        await secondary.abandon(lease.project, lease.claimKey);
      }
      return poolOptions.workEnabled ? 'primary' : null;
    };
    if (name === 'blockAccount') return async (account, reason, delayMs) => { if (account === 'secondary') await blockAccount(secondary.storage, account, now(), reason, delayMs); };
    if (!(name in keyPosition)) return typeof target[name] === 'function' ? target[name].bind(target) : target[name];
    return async (...args) => {
      const key = args[keyPosition[name]], existing = await secondary.claim(key);
      return (existing ? secondary : work)[name](...args);
    };
  } });
}

export async function tagCutoverRecords(storage, budget) {
  async function all(prefix) {
    const entries = []; let startAfter = '';
    for (;;) {
      const page = await storage.list({ prefix, startAfter, limit: 128 });
      entries.push(...page);
      if (page.size < 128) return entries;
      startAfter = [...page.keys()].at(-1);
    }
  }
  const boxes = (await all('box:')).filter(([, box]) => !box.account);
  for (let i = 0; i < boxes.length; i += 64) await storage.transaction(async tx => {
    for (const [key] of boxes.slice(i, i + 64)) {
      const current = await tx.get(key);
      if (current && !current.account) await tx.put(key, { ...current, account: 'secondary' });
    }
  });
  for (const [key, record] of await all('create:')) {
    if (record.account) continue;
    const hash = await budget.claimKey(record.createKey);
    const root = storage.storage ?? storage, rootKey = storage.key ? storage.key(key) : key;
    await root.transaction(async tx => {
      const current = await tx.get(rootKey);
      if (!current || current.account) return;
      const ledger = await tx.get(budget.migrationLedgerKey), claim = ledger?.claims?.[hash];
      if (claim && claim.project !== budget.project) throw new Error('create claim belongs to another project');
      if (current.state === 'pending' && (!claim || claim.status === 'pending')) {
        if (ledger) {
          if (claim) delete ledger.claims[hash];
          ledger.waiting = (ledger.waiting ?? []).filter(item => item.key !== hash);
          if (Array.isArray(ledger.dynamicPacing?.floorStarts)) ledger.dynamicPacing.floorStarts = ledger.dynamicPacing.floorStarts.filter(item => item.key !== hash);
          await tx.put(budget.migrationLedgerKey, ledger);
        }
        await tx.put(rootKey, { ...current, account: 'primary' });
      } else {
        await tx.put(rootKey, { ...current, account: 'secondary', ...(claim ? {} : { accountReconciliationMissing: true }) });
      }
    });
  }
}
