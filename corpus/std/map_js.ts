// `@tsl/std`'s `Map` and `Set` are JS's (D47): a missing key gives `undefined`, and changing one during `forEach` does what JS
// does. tools/std-map-oracle.ts works out every digest here with JS's own Map and Set, which share nothing with @tsl/std.
import { toU32, u32, type bool } from "@tsl/core";
import { Map, ref, Set, Str, StrBuilder, Vec } from "@tsl/std";

class Rng {
  constructor(public x: u32) {}
  next(): u32 {
    this.x = (Math.imul(this.x, 1664525) + 1013904223) >>> 0;
    return this.x >>> 8;
  }
}

class Digest {
  h: u32 = 0x811c9dc5;
  add(x: u32): void {
    this.h = Math.imul((this.h ^ x) >>> 0, 0x01000193) >>> 0;
  }
}

/** What `op` does to a map, when a forEach reaches the position it's asked for. */
function change(m: Map<u32, u32>, n: u32, op: u32, a: u32): void {
  if (op === 0) m.set(a * 10, 99);
  else if (op === 1) m.set(1000 + a, 7);
  else if (op === 2) m.delete(a * 10);
  else if (op === 3) {
    m.delete(a * 10);
    m.set(a * 10, 5);
  } else if (op === 4) m.clear();
  else if (op === 5) {
    m.clear();
    m.set(77, 1);
    m.set(78, 2);
  } else if (op === 6) {
    for (let j: u32 = 0; j < 20; j++) m.set(2000 + j, j);
  } else if (op === 7) {
    for (let j: u32 = 0; j < n; j++) m.delete(j * 10);
    for (let j: u32 = 0; j < 12; j++) m.set(3000 + j, j);
  } else if (op === 8) {
    for (let j: u32 = 0; j < n; j += 2) m.delete(j * 10);
    for (let j: u32 = 0; j < 9; j++) m.set(4000 + j, j);
  }
}

/** A map of n entries, iterated, with `op` done when the forEach reaches position `pos`: every entry seen, then the map. */
export function mutateDuring(n: u32, op: u32, a: u32, pos: u32): u32 {
  using m = new Map(u32, u32);
  for (let i: u32 = 0; i < n; i++) m.set(i * 10, i);
  const d = new Digest();
  let at: u32 = 0;
  m.forEach((v, k) => {
    d.add(k);
    d.add(v);
    if (at === pos) change(m, n, op, a);
    at++;
  });
  d.add(toU32(m.size));
  m.forEach((v, k) => {
    d.add(k);
    d.add(v);
  });
  return d.h;
}

/** The same, from inside a forEach inside another. */
export function mutateNested(n: u32, op: u32, a: u32, pos: u32): u32 {
  using m = new Map(u32, u32);
  for (let i: u32 = 0; i < n; i++) m.set(i * 10, i);
  const d = new Digest();
  let at: u32 = 0;
  m.forEach((v, k) => {
    d.add(k + v);
    let inner: u32 = 0;
    m.forEach((w, j) => {
      d.add(j);
      d.add(w);
      if (at === pos && inner === 1) change(m, n, op, a);
      inner++;
    });
    at++;
  });
  d.add(toU32(m.size));
  return d.h;
}

export function setMutateDuring(n: u32, op: u32, a: u32, pos: u32): u32 {
  using s = new Set(u32);
  for (let i: u32 = 0; i < n; i++) s.add(i);
  const d = new Digest();
  let at: u32 = 0;
  s.forEach((k) => {
    d.add(k);
    if (at === pos) {
      if (op === 0) s.add(100 + a);
      else if (op === 1) s.delete(a);
      else if (op === 2) {
        s.delete(a);
        s.add(a);
      } else if (op === 3) s.clear();
      else if (op === 4) {
        s.clear();
        s.add(50);
      } else if (op === 5) {
        for (let j: u32 = 0; j < 20; j++) s.add(200 + j);
      }
    }
    at++;
  });
  d.add(toU32(s.size));
  return d.h;
}

/** `get` of a missing key, tested and defaulted, on a scalar value. */
export function getMissing(n: u32, k: u32): u32 {
  using m = new Map(u32, u32);
  for (let i: u32 = 0; i < n; i++) m.set(i, i * 3);
  const v = m.get(k);
  if (v === undefined) return 1000000 + (m.get(k + 1) ?? 7);
  return v + (m.get(k) !== undefined ? 1 : 0);
}

/** And on a reference: a Str, or nothing. */
export function getMissingRef(n: u32, k: u32): u32 {
  using m = new Map(u32, ref<Str>());
  const made = new Vec(ref<Str>());
  for (let i: u32 = 0; i < n; i++) {
    using b = new StrBuilder();
    b.appendU32(i * 11);
    const s = b.finish();
    made.push(s);
    m.set(i, s);
  }
  const s = m.get(k);
  let out: u32 = 0;
  if (s === undefined) out = 77;
  else out = toU32(s.length) * 100 + s.at(0);
  made.forEach((x) => {
    x.free();
  });
  made.free();
  return out;
}

/** Random sets, deletes, gets, clears and forEach with changes inside it, over a table that grows and compacts. */
export function randomJs(seed: u32, ops: u32, keys: u32): u32 {
  const r = new Rng(seed);
  const d = new Digest();
  using m = new Map(u32, u32);
  for (let i: u32 = 0; i < ops; i++) {
    const k = r.next() % keys;
    const op = r.next() % 16;
    if (op < 6) m.set(k, i);
    else if (op < 9) d.add(m.delete(k) ? 1 : 0);
    else if (op < 12) d.add(m.get(k) ?? 0xffffffff);
    else if (op < 13) d.add(m.has(k) ? 1 : 0);
    else if (op < 14 && r.next() % 32 === 0) m.clear();
    else {
      // A forEach that changes the map as it goes, by a plan drawn now.
      const every = 1 + (r.next() % 4);
      const what = r.next() % 4;
      let at: u32 = 0;
      m.forEach((v, key) => {
        d.add(key);
        d.add(v);
        if (at % every === 0) {
          if (what === 0) m.set(keys + at, at);
          else if (what === 1) m.delete(key);
          else if (what === 2) m.delete((key + 1) % keys);
          else m.set((key + 3) % keys, v + 1);
        }
        at++;
        if (at > 4 * keys) m.clear();
      });
    }
    d.add(toU32(m.size));
  }
  m.forEach((v, k) => {
    d.add(k);
    d.add(v);
  });
  return d.h;
}

export function usesEveryImport(): bool {
  return new Rng(1).next() !== 0;
}
