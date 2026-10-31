export async function records(storage, prefix) {
  const result = []; let startAfter = '';
  for (;;) {
    const page = await storage.list({ prefix, startAfter, limit: 128 });
    result.push(...page.values());
    if (page.size < 128) return result;
    startAfter = [...page.keys()].at(-1);
  }
}

