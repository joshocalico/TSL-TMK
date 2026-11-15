// Random operations, whose digests tools/std-oracle.ts works out with JS's own Map, Set, Array and strings: an oracle that shares
// nothing with @tsl/std, as running @tsl/std on V8 can't be (SPEC 3.10, D43).
import { lit, toU32, u32, wrapU32, type bool, type usize } from "@tsl/core";
import { ExactMap, Map, ref, Set, Str, StrBuilder, Vec } from "@tsl/std";

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

export function mapModel(seed: u32, ops: u32, keys: u32): u32 {
  const r = new Rng(seed);
  const d = new Digest();
  using m = new Map(u32, u32);
  for (let i: u32 = 0; i < ops; i++) {
    const k = r.next() % keys;
    const op = r.next() % 16;
    if (op < 7) m.set(k, i);
    else if (op < 10) d.add(m.delete(k) ? 1 : 0);
    else if (op < 13) d.add(m.get(k) ?? 0xffffffff);
    else if (op < 15) d.add(m.has(k) ? 1 : 0);
    else if (r.next() % 64 === 0) m.clear();
    else {
      m.forEach((b, a) => {
        d.add(a);
        d.add(b);
      });
    }
    d.add(toU32(m.size));
  }
  m.forEach((b, a) => {
    d.add(a);
    d.add(b);
  });
  return d.h;
}

/** The same operations on an ExactMap (D47), which nothing changes during its forEach: the same digests as mapModel. */
export function exactModel(seed: u32, ops: u32, keys: u32): u32 {
  const r = new Rng(seed);
  const d = new Digest();
  using m = new ExactMap(u32, u32);
  for (let i: u32 = 0; i < ops; i++) {
    const k = r.next() % keys;
    const op = r.next() % 16;
    if (op < 7) m.set(k, i);
    else if (op < 10) d.add(m.delete(k) ? 1 : 0);
    else if (op < 13) d.add(m.has(k) ? m.get(k) : 0xffffffff);
    else if (op < 15) d.add(m.has(k) ? 1 : 0);
    else if (r.next() % 64 === 0) m.clear();
    else {
      m.forEach((a, b) => {
        d.add(a);
        d.add(b);
      });
    }
    d.add(toU32(m.size));
  }
  m.forEach((a, b) => {
    d.add(a);
    d.add(b);
  });
  return d.h;
}

export function setModel(seed: u32, ops: u32, keys: u32): u32 {
  const r = new Rng(seed);
  const d = new Digest();
  using s = new Set(u32);
  for (let i: u32 = 0; i < ops; i++) {
    const k = r.next() % keys;
    const op = r.next() % 8;
    if (op < 4) s.add(k);
    else if (op < 6) d.add(s.delete(k) ? 1 : 0);
    else d.add(s.has(k) ? 1 : 0);
    d.add(toU32(s.size));
  }
  s.forEach((a) => {
    d.add(a);
  });
  return d.h;
}

export function vecModel(seed: u32, ops: u32): u32 {
  const r = new Rng(seed);
  const d = new Digest();
  using v = new Vec(u32);
  for (let i: u32 = 0; i < ops; i++) {
    const op = r.next() % 16;
    const n = v.length;
    const at: usize = n === 0 ? 0 : r.next() % toU32(n);
    if (op < 6) v.push(r.next());
    else if (op < 8 && n > 0) d.add(v.pop());
    else if (op < 10) v.insert(at, r.next());
    else if (op < 12 && n > 0) d.add(v.removeAt(at));
    else if (op < 13 && n > 0) d.add(v.swapRemove(at));
    else if (op < 14 && n > 0) v.set(at, r.next());
    else if (op < 15 && n > 1) v.swap(at, (at + 1) % n);
    else if (r.next() % 32 === 0) {
      v.sortInPlace((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }
    d.add(toU32(v.length));
  }
  v.forEach((x) => {
    d.add(x);
  });
  return d.h;
}

const ALPHABET = lit("ab c");

function text(r: Rng, n: u32): Str {
  using b = new StrBuilder();
  for (let i: u32 = 0; i < n; i++) b.appendByte(ALPHABET[r.next() % 4]!);
  return b.finish();
}

function addStr(d: Digest, s: Str): void {
  d.add(toU32(s.length));
  s.withBytes((a) => {
    for (const x of a) d.add(x);
  });
}

export function strModel(seed: u32, ops: u32): u32 {
  const r = new Rng(seed);
  const d = new Digest();
  for (let i: u32 = 0; i < ops; i++) {
    const a = text(r, r.next() % 24);
    const b = text(r, r.next() % 4);
    const c = a.concat(b);
    addStr(d, c);
    const from = r.next() % (toU32(a.length) + 1);
    const to = from + (r.next() % (toU32(a.length) - from + 1));
    const sub = a.slice(from, to);
    addStr(d, sub);
    d.add(wrapU32(a.indexOf(b, from)));
    d.add(wrapU32(a.compare(b)));
    d.add(a.equals(b) ? 1 : 0);
    using parts = new Vec(ref<Str>());
    a.split(32, parts);
    d.add(toU32(parts.length));
    parts.forEach((p) => {
      addStr(d, p);
      p.free();
    });
    a.free();
    b.free();
    c.free();
    sub.free();
  }
  return d.h;
}

export function strKeyModel(seed: u32, ops: u32): u32 {
  const r = new Rng(seed);
  const d = new Digest();
  using m = new Map(ref<Str>(), u32);
  const all = new Vec(ref<Str>());
  for (let i: u32 = 0; i < ops; i++) {
    const k = text(r, 1 + (r.next() % 3));
    all.push(k);
    const op = r.next() % 8;
    if (op < 5) m.set(k, i);
    else if (op < 7) d.add(m.delete(k) ? 1 : 0);
    else d.add(m.getOr(k, 0xffffffff));
    d.add(toU32(m.size));
  }
  m.forEach((v, k) => {
    addStr(d, k);
    d.add(v);
  });
  all.forEach((s) => {
    s.free();
  });
  all.free();
  return d.h;
}

export function usesEveryImport(): bool {
  return new Rng(1).next() !== 0;
}
