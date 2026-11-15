// Number keys, no strings (strkeys, D72): the maps benchmarks' work, a table grown to n, read, then a mix of sets, gets and
// deletes, then iterated, with every key and value a number. So `Map<number, number>` and `Set<number>` printed as
// @tsl/jsrt's JsMap and JsSet are judged on their own, apart from string keys. Each takes a size and gives a digest, which
// the harness compares with V8's.
function lcg(x: number): number {
  return (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
}

export function numWork(n: number): number {
  const m = new Map<number, number>();
  // Growth, through every move.
  for (let i = 0; i < n; i++) m.set(i * 7, i);
  let h = 0;
  // Gets of what's there.
  for (let i = 0; i < n; i++) h = (h + (m.get(i * 7) ?? 0)) | 0;
  // Sets, gets and deletes mixed over a window of keys.
  const range = n * 7;
  let x = 1;
  for (let i = 0; i < n; i++) {
    x = lcg(x);
    const k = x % range;
    const op = (x >>> 27) & 3;
    if (op <= 1) m.set(k, i);
    else if (op === 2) {
      const v = m.get(k);
      if (v !== undefined) h = (h + v) | 0;
    } else m.delete(k);
  }
  // Iteration, in insertion order.
  for (const [k, v] of m) h = (Math.imul(h, 31) + k + v) | 0;
  const s = new Set<number>();
  for (let i = 0; i < n; i++) s.add((i * 13) % (n >> 1));
  for (const k of s) h = (h + k) | 0;
  return (h + m.size + s.size) | 0;
}
