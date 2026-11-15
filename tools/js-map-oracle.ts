// The expected values of corpus/std/leak/js_map.ts (D72), from JS's own Map and Set: each function here is the TSL one's
// twin, so what @tsl/jsrt's JsMap and JsSet give is judged against V8's, not against themselves.
// `node tools/js-map-oracle.ts` rewrites corpus/std/leak/js_map.cases.json.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./corpus.ts";

const mix = (h: number, x: number): number => Math.imul((h ^ x) >>> 0, 16777619) >>> 0;

function code(x: number): number {
  if (x !== x) return 0xdead;
  if (x === 0 && 1 / x < 0) return 0xbeef;
  return x >>> 0;
}

function numbers(n: number, ops: number): number {
  const m = new Map<number, number>();
  for (let i = 0; i < n; i++) m.set(i * 7, i);
  let h = 0x811c9dc5;
  for (let r = 0; r < ops; r++) {
    m.set(100000 + r, r);
    const k = ((r * 37) % n) * 7;
    if (r % 4 === 0) h = mix(h, m.delete(k) ? 1 : 0);
    else if (r % 4 === 1) m.set(k, r + 0.5);
    else if (r % 4 === 2) {
      const v = m.get(k);
      h = mix(h, v === undefined ? 12345 : (v * 2) >>> 0);
    } else {
      m.delete(k);
      m.set(k, r);
    }
    for (let i = 0; i < n; i += 5) h = mix(h, m.has(i * 7) ? 7 : 3);
    h = mix(h, m.size);
  }
  for (const [k, v] of m) h = mix(mix(h, code(k)), (v * 2) >>> 0);
  return h >>> 1;
}

function sameValueZero(): number {
  const m = new Map<number, number>();
  m.set(-0, 1);
  m.set(0, 2);
  m.set(NaN, 3);
  m.set(0 / 0, 4);
  m.set(-NaN, 5);
  let h = mix(0, m.size);
  h = mix(h, m.has(-0) ? 1 : 0);
  const v = m.get(NaN);
  h = mix(h, v === undefined ? 99 : v);
  for (const [k, x] of m) h = mix(mix(h, code(k)), x);
  m.delete(0);
  h = mix(h, m.size);
  return h >>> 1;
}

class Item {
  id: number;
  constructor(id: number) {
    this.id = id;
  }
}

function objects(n: number): number {
  const items = new Map<number, Item>();
  const m = new Map<Item, number>();
  for (let i = 0; i < n; i++) {
    const a = new Item(i % 7);
    items.set(i, a);
    m.set(a, i);
  }
  let h = mix(0, m.size);
  for (let i = 0; i < n; i += 3) {
    const a = items.get(i);
    if (a !== undefined) {
      h = mix(h, m.delete(a) ? 1 : 0);
      h = mix(h, m.has(a) ? 1 : 0);
      m.set(a, i + 1000);
    }
  }
  h = mix(h, m.has(new Item(1)) ? 1 : 0);
  for (const [k, v] of m) h = mix(mix(h, k.id), v);
  return h >>> 1;
}

function lru(n: number, cap: number): number {
  const m = new Map<number, number>();
  let h = 0;
  for (let i = 0; i < n; i++) {
    const k = ((i * 7) % 13) + ((i * 3) % 29);
    const v = m.get(k);
    if (v !== undefined) {
      m.delete(k);
      m.set(k, v + 1);
      h = mix(h, v);
    } else {
      m.set(k, i);
      if (m.size > cap) {
        const first = m.keys().next();
        if (first.done !== true) m.delete(first.value);
      }
    }
    h = mix(h, m.size);
  }
  for (const [k, v] of m) h = mix(mix(h, k), v);
  return h >>> 1;
}

function mutate(n: number, change: number, at: number): number {
  const m = new Map<number, number>();
  for (let i = 0; i < n; i++) m.set(i, i * 10);
  let h = 0x811c9dc5;
  let seen = 0;
  const it = m.entries();
  for (;;) {
    const r = it.next();
    if (r.done === true || !(seen < 10000)) break;
    const [k, v] = r.value;
    h = mix(mix(h, k), v);
    if (seen === at) {
      if (change === 0) m.delete(k);
      else if (change === 1) m.delete(k + 1);
      else if (change === 2) m.delete((k - 1) >>> 0);
      else if (change === 3) m.delete(n - 1);
      else if (change === 4) m.set(n + 100, 7);
      else if (change === 5) {
        m.delete(k);
        m.set(k, 5);
      } else if (change === 6) m.clear();
      else if (change === 7) {
        m.clear();
        m.set(500, 1);
        m.set(501, 2);
      } else if (change === 8) m.set(k + 1, 999);
      else if (change === 9) {
        for (let j = k + 1; j < n; j++) m.delete(j);
      } else if (change === 10) {
        for (let j = 0; j < n; j++) m.set(1000 + j, j);
      } else if (change === 11) {
        for (let j = 0; j < n; j += 2) m.delete(j);
      } else if (change === 12) {
        for (let j = 0; j < k; j++) m.delete(j);
        for (let j = 0; j < k; j++) m.set(j, j + 1);
      }
    }
    seen++;
  }
  m.set(9999, 1);
  h = mix(h, it.next().done === true ? 0 : 1);
  return mix(mix(h, seen), m.size) >>> 1;
}

function twoCursors(n: number): number {
  const m = new Map<number, number>();
  for (let i = 0; i < n; i++) m.set(i, i);
  const a = m.keys();
  const b = m.keys();
  let h = 0;
  let steps = 0;
  let more = true;
  while (more && steps < 100000) {
    more = false;
    const ra = a.next();
    if (ra.done !== true) {
      more = true;
      const k = ra.value;
      h = mix(h, k);
      if (k % 3 === 0) m.delete(k + 2);
      if (k < n) m.set(k + n, k);
    }
    if (steps % 2 === 0) {
      const rb = b.next();
      if (rb.done !== true) {
        more = true;
        const k = rb.value;
        h = mix(h, k + 7);
        if (k % 5 === 1) m.delete(k);
      }
    }
    steps++;
  }
  return mix(mix(h, steps), m.size) >>> 1;
}

function sets(n: number): number {
  const s = new Set<number>();
  for (let i = 0; i < n; i++) s.add((i * 5) % (n + 3));
  let h = mix(0, s.size);
  for (let i = 0; i < n; i += 4) h = mix(h, s.delete(i) ? 1 : 0);
  h = mix(h, s.has(5) ? 1 : 0);
  for (const k of s) {
    h = mix(h, k);
    if (k === 10) s.add(n + 50);
    if (k === 15) s.delete(20);
  }
  s.clear();
  s.add(3);
  h = mix(h, s.size);
  return h >>> 1;
}

function forEachChanges(n: number): number {
  const m = new Map<number, number>();
  for (let i = 0; i < n; i++) m.set(i, i + 1);
  let h = 0;
  m.forEach((v, k) => {
    h = mix(mix(h, k), v);
    if (k === 2) m.delete(3);
    if (k < 3) m.set(k + n, 0);
  });
  return mix(h, m.size) >>> 1;
}

// --- string keys (strkeys): JS's own strings, and compiler/rt's strHash for the hashes

function word(i: number): string {
  return `w${i}`;
}

function special(j: number, other: boolean): string {
  const forty = Array.from({ length: 40 }, (_, i) => String.fromCharCode(97 + ((i + 4) % 26))).join(
    "",
  );
  void other; // the same text either way: JS can't tell the objects apart, which is the point
  return [
    "",
    "héllo",
    "日本語",
    "😀",
    "\ud800",
    "\udc00",
    "a\ud800",
    "\udfffa",
    forty,
    "\u0000",
    "héllO",
    "\ud800\udc00",
  ][j]!;
}

const SPECIALS = 12;

function codeOf(s: string): number {
  let c = s.length;
  for (let i = 0; i < s.length; i++) c = mix(c, s.charCodeAt(i));
  return c;
}

function stringKeys(n: number, rounds: number, swap: number): number {
  const m = new Map<string, number>();
  for (let j = 0; j < SPECIALS; j++) m.set(special(j, swap === 1), j);
  for (let i = 0; i < n; i++) m.set(word(i * 7), i + 100);
  let h = mix(0x811c9dc5, m.size);
  for (let j = 0; j < SPECIALS; j++) {
    const v = m.get(special(j, swap !== 1));
    h = mix(h, v === undefined ? 777 : v);
  }
  for (let r = 0; r < rounds; r++) {
    const k = word(((r * 13) % (n + 5)) * 7);
    if (r % 3 === 0) h = mix(h, m.delete(k) ? 1 : 0);
    else if (r % 3 === 1) m.set(k, r);
    else {
      const v = m.get(k);
      h = mix(h, v === undefined ? 555 : v);
    }
    if (r % 5 === 0) h = mix(h, m.delete(special(r % SPECIALS, true)) ? 11 : 13);
    if (r % 7 === 0) m.set(special((r * 3) % SPECIALS, false), r);
    h = mix(h, m.has(word(r)) ? 2 : 3);
    h = mix(h, m.size);
  }
  for (const [k, v] of m) h = mix(mix(h, codeOf(k)), v);
  return h >>> 1;
}

function stringSet(n: number): number {
  const s = new Set<string>();
  for (let i = 0; i < n; i++) {
    s.add(word(i % 17));
    s.add(special(i % SPECIALS, (i & 1) === 1));
  }
  let h = mix(0, s.size);
  h = mix(h, s.has("") ? 1 : 0);
  h = mix(h, s.has("\ud800\udc00") ? 1 : 0);
  h = mix(h, s.delete("😀") ? 1 : 0);
  h = mix(h, s.has("\ud800\udc00") ? 1 : 0);
  for (const k of s) h = mix(h, codeOf(k));
  return h >>> 1;
}

/** compiler/rt/str.ts's strHash, D42's HalfSipHash-1-3 in 30 bits, under the key (k0, k1). */
function strHash(s: string, k0: number, k1: number): number {
  const n = s.length;
  let v0 = k0 | 0;
  let v1 = k1 | 0;
  let v2 = 0x6c796765 ^ v0;
  let v3 = 0x74656462 ^ v1;
  const round = (): void => {
    v0 = (v0 + v1) | 0;
    v1 = (v1 << 5) | (v1 >>> 27);
    v1 = v1 ^ v0;
    v0 = (v0 << 16) | (v0 >>> 16);
    v2 = (v2 + v3) | 0;
    v3 = (v3 << 8) | (v3 >>> 24);
    v3 = v3 ^ v2;
    v0 = (v0 + v3) | 0;
    v3 = (v3 << 7) | (v3 >>> 25);
    v3 = v3 ^ v0;
    v2 = (v2 + v1) | 0;
    v1 = (v1 << 13) | (v1 >>> 19);
    v1 = v1 ^ v2;
    v2 = (v2 << 16) | (v2 >>> 16);
  };
  let i = 0;
  while (i + 2 <= n) {
    const m = s.charCodeAt(i) | (s.charCodeAt(i + 1) << 16);
    v3 = v3 ^ m;
    round();
    v0 = v0 ^ m;
    i += 2;
  }
  const last = (n << 25) | (i < n ? s.charCodeAt(i) : 0);
  v3 = v3 ^ last;
  for (let r = 0; r < 4; r++) {
    round();
    if (r === 0) {
      v0 = v0 ^ last;
      v2 = v2 ^ 0xff;
    }
  }
  return (v1 ^ v3) & 0x3fffffff;
}

function stringHashes(k0: number, k1: number, n: number): number {
  let h = 0;
  for (let j = 0; j < SPECIALS + n; j++) {
    const s = j < SPECIALS ? special(j, j === 0 || (j & 1) === 1) : word(j * 31);
    h = mix(mix(h, strHash(s, k0, k1)), 1);
  }
  return h >>> 1;
}

const fns: Record<string, (...a: number[]) => number> = {
  numbers,
  sameValueZero,
  objects,
  lru,
  mutate,
  twoCursors,
  sets,
  forEachChanges,
  stringKeys,
  stringSet,
  stringHashes,
};
const calls: [string, number[]][] = [
  ["numbers", [40, 300]],
  ["numbers", [1000, 2000]],
  ["numbers", [3, 50]],
  ["sameValueZero", []],
  ["objects", [10]],
  ["objects", [500]],
  ["lru", [200, 5]],
  ["lru", [3000, 17]],
  ["twoCursors", [7]],
  ["twoCursors", [100]],
  ["sets", [30]],
  ["sets", [400]],
  ["forEachChanges", [6]],
  ["stringKeys", [5, 40, 0]],
  ["stringKeys", [5, 40, 1]],
  ["stringKeys", [300, 900, 0]],
  ["stringKeys", [300, 900, 1]],
  ["stringSet", [40]],
  ["stringHashes", [0x243f6a88, -2052912941, 20]],
  ["stringHashes", [12345, -559038737, 20]],
  ["stringHashes", [0, 0, 5]],
];
// Every change at every place, in tables of sizes either side of a growth (a move starts at the 5th, 9th, 17th and 33rd
// entry from empty), so each happens before, during and after a move.
for (const n of [1, 2, 4, 5, 8, 9, 17, 33]) {
  const ats = [...new Set([0, 1, n >> 1, n - 2, n - 1, n, n + 3].filter((x) => x >= 0))];
  for (let change = 0; change <= 12; change++)
    for (const at of ats) calls.push(["mutate", [n, change, at]]);
}
const rows = calls.map(([fn, args]) => ({ fn, args, expect: fns[fn]!(...args) }));
writeFileSync(
  join(ROOT, "corpus/std/leak/js_map.cases.json"),
  `[\n${rows.map((r) => `  ${JSON.stringify(r).replace(/,/g, ", ").replace(/:/g, ": ")}`).join(",\n")}\n]\n`,
);
console.log(`${rows.length} cases`);
