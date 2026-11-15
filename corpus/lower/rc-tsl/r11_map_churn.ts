// memory-pages: 256
// R11: maps churned far past the memory there is (256 pages, 1 MiB), with no strings: number keys to numbers, and number
// keys to objects, each map's tables freed with it as `auto` builds it in `rc`. Before R11 a JsMap's tables were
// @tsl/std's, outside the counted heap, and making them took no freeing steps. `leak` and `manual` run out, with code 14.
class Cell {
  v: number;
  constructor(v: number) {
    this.v = v;
  }
}

export function churnNumMaps(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) {
    const m = new Map<number, number>();
    for (let j = 0; j < 100; j++) m.set(j * i, j);
    m.delete(3 * i);
    t += m.size + (m.get(7 * i) ?? 0);
  }
  return t;
}

export function churnObjMaps(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) {
    const m = new Map<number, Cell>();
    for (let j = 0; j < 60; j++) {
      const c = new Cell(i + j);
      m.set(j, c);
    }
    m.delete(5);
    t += m.size;
    const got = m.get(9);
    if (got !== undefined) t += got.v;
  }
  return t;
}

/** Maps iterated while they grow, so a cursor's generation keeps an old table's positions until the iteration ends. */
export function iterGrow(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) {
    const m = new Map<number, number>();
    for (let j = 0; j < 8; j++) m.set(j, j);
    for (const [k, v] of m) {
      if (k < 40) m.set(k + 8, v + 1);
      t += v;
    }
  }
  return t;
}
