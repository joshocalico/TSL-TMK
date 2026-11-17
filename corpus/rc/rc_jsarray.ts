// memory-pages: 64
// @tsl/jsrt's JsArray and JsMap held in place by classes of an `rc` package (R2): what a lowered rc package's holders
// are, written by hand, so the expansion's rules for them are tested apart from the printer. Each churns far past the
// memory there is (64 pages, 256 KiB): an element a JsArray cuts, overwrites or gives up, a key or value a JsMap stops
// holding, or a buffer, that isn't freed runs out (trap 14); and each checks nothing is left counted after rcCollect.
import { toU32, toU64, u32, u64, type bool } from "@tsl/core";
import { rcCollect, rcLive } from "@tsl/gc";
import { ref } from "@tsl/std";
import { JsArray, JsMap } from "@tsl/jsrt";

class Item {
  constructor(public v: u32) {}
}

class Bag {
  v: JsArray<Item | null>;
  constructor() {
    this.v = new JsArray(ref<Item | null>(), 0, true, true);
  }
}

class Nums {
  v: JsArray<u32>;
  constructor() {
    this.v = new JsArray(u32, 0, true, true);
  }
}

class Index {
  m: JsMap<u64, Item | null>;
  constructor() {
    this.m = new JsMap(u64, ref<Item | null>(), true, true);
    this.m.freesTables();
  }
}

class ByItem {
  m: JsMap<Item | null, u32>;
  constructor() {
    this.m = new JsMap(ref<Item | null>(), u32, true, true);
    this.m.freesTables();
  }
}

let kept: Bag | null = null;

/** What `cuts` kept last, so the array lives past its round. */
export function keptLength(): u32 {
  return kept === null ? 0 : toU32(kept.v.length);
}

/** A shorter length cuts live elements off, pop and shift move one out, set replaces one: each has to be freed. */
export function cuts(rounds: u32): u32 {
  rcCollect(); // what a case before left waiting to be freed is counted until it is
  const base = rcLive();
  let t: u32 = 0;
  for (let r: u32 = 0; r < rounds; r++) {
    const b = new Bag();
    for (let i: u32 = 0; i < 16; i++) b.v.push(new Item(i));
    b.v.setLength(6);
    const x = b.v.pop(null);
    if (x !== null) t += x.v;
    const y = b.v.shift(null);
    if (y !== null) t += y.v;
    b.v.set(0, new Item(r));
    t += toU32(b.v.length);
    kept = b;
  }
  kept = null;
  rcCollect();
  return t + (rcLive() === base ? 0 : 1_000_000);
}

/** Holes, and an array of numbers whose buffer alone has to go back. */
export function holesAndNumbers(rounds: u32): u32 {
  let t: u32 = 0;
  for (let r: u32 = 0; r < rounds; r++) {
    const b = new Bag();
    b.v.reserve(8);
    b.v.setLength(8);
    b.v.set(5, new Item(r));
    const n = new Nums();
    for (let i: u32 = 0; i < 100; i++) n.v.push(i);
    const h = b.v.get(2);
    t += (h === null ? 1 : 0) + n.v.get(99);
  }
  return t;
}

/**
 * Values replaced and deleted, and keys that are objects, in two maps held across rounds and made again every 100, so the
 * old ones are freed with what they hold. Few maps are made: a map's own bookkeeping, its generations and the arrays of
 * a table it moves out of, is @tsl/jsrt's, which isn't freed (R2), and isn't what's tested here.
 */
export function maps(rounds: u32): u32 {
  rcCollect();
  const base = rcLive();
  let t: u32 = 0;
  let ix: Index | null = null;
  let by: ByItem | null = null;
  for (let r: u32 = 0; r < rounds; r++) {
    if (r % 100 === 0) {
      ix = new Index();
      by = new ByItem();
    }
    t += churnMaps(ix!, by!);
  }
  ix = null;
  by = null;
  rcCollect();
  return t + (rcLive() === base ? 0 : 1_000_000);
}

function churnMaps(ix: Index, by: ByItem): u32 {
  let t: u32 = 0;
  for (let i: u32 = 0; i < 12; i++) {
    const it = new Item(i);
    ix.m.set(toU64(i & 3), it);
    by.m.set(it, i);
    by.m.set(it, i + 1);
  }
  const got = ix.m.getOr(toU64(1), null);
  if (got !== null) t += got.v;
  const gone: bool = ix.m.delete(toU64(2));
  t += gone ? 1 : 0;
  t += by.m.size;
  by.m.clear();
  return t;
}
