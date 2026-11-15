// memory-pages: 96
// Maps and sets iterated in a loop in `rc` (R3), far past the memory there is (96 pages, 384 KiB): whatever an iteration,
// a move or a clear leaves behind that isn't freed runs out (trap 14). Through the direct route, and printed as TSL, where
// @tsl/jsrt's own bookkeeping (a cursor an iteration, a generation a move or clear while one is on, each map's first old
// table and its arrays) has to go back as the map's keys and values do.
class Item {
  constructor(public v: number) {}
}

const live = new Map<number, Item>();
const byItem = new Map<Item, number>();
const members = new Set<Item>();

function fill(n: number): void {
  for (let i = 0; i < n; i++) live.set(i, new Item(i));
}

/** Entries, keys and values iterated each round: a cursor each. */
export function iterLoop(rounds: number): number {
  live.clear();
  fill(8);
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    for (const [k, v] of live) t = (t + k + v.v) | 0;
    for (const k of live.keys()) t = (t + k) | 0;
    for (const v of live.values()) t = (t + v.v) | 0;
  }
  live.clear();
  return t;
}

/** An iteration left early, by `break` and by `return` from a function that iterates. */
function firstOver(m: Map<number, Item>, x: number): number {
  for (const [k, v] of m) if (v.v > x) return k;
  return -1;
}

export function iterBreak(rounds: number): number {
  live.clear();
  fill(16);
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    for (const [k] of live) {
      if (k === (r & 7)) break;
      t = (t + 1) | 0;
    }
    t = (t + firstOver(live, r & 15)) | 0;
  }
  live.clear();
  return t;
}

/** Grown during an iteration, which sees what's added, so each round moves the table while a cursor reads it. */
export function iterGrow(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    live.clear();
    fill(4);
    for (const [k, v] of live) {
      if (k < 40) live.set(k + 4, new Item(v.v + 1));
      t = (t + v.v) | 0;
    }
    t = (t + live.size) | 0;
  }
  live.clear();
  return t;
}

/** Entries deleted during an iteration, and the map cleared in the middle of one and filled again. */
export function iterClear(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    fill(12);
    for (const [k, v] of live) {
      if (k === 3) live.delete(5);
      if (k === 6) {
        live.clear();
        live.set(100, new Item(r));
      }
      t = (t + k + v.v) | 0;
    }
    t = (t + live.size) | 0;
    live.clear();
  }
  return t;
}

/** Many short-lived maps, each grown past its first table, iterated and dropped. */
export function shortMaps(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    const m = new Map<number, Item>();
    for (let i = 0; i < 9; i++) m.set(i, new Item(i + r));
    for (const [k, v] of m) t = (t + k + v.v) | 0;
    m.delete(2);
    t = (t + m.size) | 0;
  }
  return t;
}

/** Sets and object keys iterated, with `forEach`, and a set grown during its own iteration. */
export function setIter(rounds: number): number {
  let t = 0;
  members.clear();
  byItem.clear();
  for (let i = 0; i < 6; i++) {
    const it = new Item(i);
    members.add(it);
    byItem.set(it, i * 2);
  }
  for (let r = 0; r < (rounds | 0); r++) {
    for (const m of members) t = (t + m.v) | 0;
    byItem.forEach((v, k) => {
      t = (t + v + k.v) | 0;
    });
    const s = new Set<number>();
    s.add(1);
    for (const x of s) if (x < 12) s.add(x + 1);
    t = (t + s.size) | 0;
  }
  members.clear();
  byItem.clear();
  return t;
}

/** Something does run out: a map that only grows, iterated as it does. */
export function reallyOut(n: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    live.set(5000 + i, new Item(i));
    if ((i & 1023) === 0) for (const [k] of live) t = (t + k) | 0;
  }
  return (live.size + t) | 0;
}
