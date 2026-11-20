export async function records(storage, prefix) {
  if (storage.records) return storage.records(prefix);
  return [...(await recordEntries(storage, prefix)).values()];
}

export async function recordEntries(storage, prefix) {
  const result = new Map(); let startAfter = '';
  for (;;) {
    const page = await storage.list({ prefix, startAfter, limit: 128 });
    for (const [key, value] of page) result.set(key, value);
    if (page.size < 128) return result;
    startAfter = [...page.keys()].at(-1);
  }
}
