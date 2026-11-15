// memory-pages: 96
// Maps and sets of counted objects in `rc` (R2), churned far past the memory there is (96 pages, 384 KiB): a key or value
// a map stops holding that isn't freed runs out (trap 14). Through the direct route, whose map runtime clears each slot
// it stops holding (`__v_clear`), and printed as TSL, where JsMap hands back what it stops holding (`put`, `cut`,
// `entryAt`) and tslc's expansion drops it (D74). What @tsl/jsrt itself makes for a map, its iterations, moves and
// clears is freed or reused too since R3 (r3_map_iter.ts tests it on its own).
class Item {
  constructor(public v: number) {}
}

class Owner {
  byId = new Map<number, Item>();
  seen = new Set<Item>();
  constructor(public tag: number) {}
}

const live = new Map<number, Item>();
const tags = new Map<Item, number>();
const members = new Set<Item>();
let owner: Owner | null = null;

/** Values replaced under the same keys: each old value has to go. */
export function overwrite(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    live.set(r & 15, new Item(r));
    t = (t + live.get(r & 15)!.v) | 0;
  }
  return (t + live.size) | 0;
}

/** Entries deleted: their values go. */
export function addDelete(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    live.set(1000 + r, new Item(r));
    if (live.delete(1000 + r - 8)) t++;
  }
  for (let r = 0; r < 8; r++) live.delete(1000 + (rounds | 0) - 1 - r);
  return (t + live.size) | 0;
}

/** Object keys: a key the map holds goes when it's deleted, and one already there isn't held twice. */
export function objectKeys(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    const k = new Item(r);
    tags.set(k, r);
    tags.set(k, r + 1);
    t = (t + tags.get(k)!) | 0;
    tags.delete(k);
  }
  return (t + tags.size) | 0;
}

/** A set of objects: added twice, deleted once. */
export function sets(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    const m = new Item(r);
    members.add(m);
    members.add(m);
    if (members.has(m)) t++;
    members.delete(m);
  }
  return (t + members.size) | 0;
}

/** Grown well past its first table, iterated, then cleared: what it held, the tables it outgrew and its cursors go. */
export function growClear(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    for (let i = 0; i < 200; i++) live.set(i, new Item(i + r));
    let s = 0;
    for (const [, v] of live) s = (s + v.v) | 0;
    for (let i = 0; i < 200; i++) s = (s + live.get(i)!.v) | 0;
    t = (t + s) | 0;
    live.clear();
  }
  return (t + live.size) | 0;
}

/** Maps in an object's fields, freed with it. */
export function fieldMaps(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    const o = new Owner(r);
    for (let i = 0; i < 1000; i++) {
      const it = new Item(i);
      o.byId.set(i, it);
      o.seen.add(it);
    }
    owner = o;
    t = (t + o.byId.size + o.seen.size + o.byId.get(999)!.v) | 0;
  }
  owner = null;
  return t;
}

class Heavy {
  a = 0;
  b = 0;
  c = 0;
  d = 0;
  e = 0;
  f = 0;
  g = 0;
  constructor(public v: number) {}
}

class Holder {
  byId = new Map<number, Heavy>();
}

let holder: Holder | null = null;

/**
 * A map freed in the middle of growing: its ninth entry starts a move of the other eight into a bigger table, four an
 * insert or delete, so when its holder goes most of what it holds is still in the old table, and has to be freed from
 * there. Each map made here is freed whole, its tables' arrays and their buffers included (R3), so it churns past memory.
 */
export function midMove(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    const o = new Holder();
    for (let i = 0; i < 9; i++) o.byId.set(i, new Heavy(i + r));
    holder = o;
    t = (t + o.byId.get(2)!.v + o.byId.size) | 0;
  }
  holder = null;
  return t;
}

/** Something does run out: a map that only grows. */
export function reallyOut(n: number): number {
  for (let i = 0; i < (n | 0); i++) live.set(5000 + i, new Item(i));
  return live.size;
}
