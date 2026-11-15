// memory-pages: 256
// R11: sets churned far past the memory there is (256 pages, 1 MiB), with no string and no object in them: each set's
// tables have to be freed with it, as `auto` builds it in `rc`. Before R11 a JsSet's tables were @tsl/std's, outside the
// counted heap, so making them took no freeing steps and this ran out through the TSL route alone within its first
// 1,000 sets. `leak` and `manual` run out, with code 14.
export function churnSets(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) {
    const s = new Set<number>();
    for (let j = 0; j < 100; j++) s.add(j * i);
    t += s.size;
  }
  return t;
}

/** Sets that grow in steps, are cleared, and grow again, so each holds tables it outgrew while a move was on. */
export function growClear(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) {
    const s = new Set<number>();
    for (let j = 0; j < 300; j++) {
      s.add(j + i);
      if (j === 150) {
        t += s.size;
        s.clear();
      }
    }
    for (let j = 0; j < 300; j += 3) s.delete(j + i);
    t += s.size;
  }
  return t;
}

/** One long-lived set whose tables are replaced again and again as it grows and shrinks. */
export function longSet(n: number): number {
  const s = new Set<number>();
  let t = 0;
  for (let i = 0; i < n; i++) {
    s.add(i);
    if (i >= 500) s.delete(i - 500);
    if (i % 5000 === 4999) s.clear();
    t += s.size;
  }
  return t;
}
