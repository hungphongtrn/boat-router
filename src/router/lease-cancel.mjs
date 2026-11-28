// A lease client may kill a process it started. The provider takes an opaque
// command id, so only a plain positive integer (or its decimal string) is
// accepted; a float, a negative, an exponent, an object or an oversized value is
// rejected before any provider call.
const PROCESS_ID = /^[1-9][0-9]{0,15}$/;

export function normalizeProcessId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !PROCESS_ID.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}
