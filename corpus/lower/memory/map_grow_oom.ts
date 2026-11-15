// memory-pages: 96
// A module-level map that runs out of memory while it grows, and then is used (R4). JsMap's growth makes the new table's
// buffers before it moves anything, as the direct route's runtime map does, so running out partway through leaves the
// map as it was: the next case finds every entry it had. Before R4 JsMap moved its buffers aside first, and the next
// case's `get` trapped 2 through the TSL route in `manual` (M5's R3 record). Number keys and values, so growth is the
// only thing that allocates, and nothing here allocates after the first case: the second only reads, deletes and
// overwrites keys it already has.
const live = new Map<number, number>();

/** Inserts until memory runs out natively (trap 14), which happens in a growth: the last table outgrown. */
export function fill(n: number): number {
  for (let i = 0; i < (n | 0); i++) live.set(i, i * 2 + 1);
  return live.size;
}

/** 1 if the map holds exactly keys 0 to size - 1, each with its own value, and lookups, deletes and overwrites work. */
export function intact(_x: number): number {
  const n = live.size;
  if (n === 0) return 0;
  let bad = 0;
  for (let k = 0; k < n; k++) if (live.get(k) !== k * 2 + 1) bad++;
  if (live.has(-1) || live.has(n)) bad++;
  live.delete(0);
  if (live.has(0) || live.size !== n - 1) bad++;
  live.set(1, 7);
  if (live.get(1) !== 7 || live.size !== n - 1) bad++;
  return bad === 0 ? 1 : -bad;
}
