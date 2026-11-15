// memory-pages: 512
// @tsl/jsrt's JsMap and JsSet written by hand in a `leak` package (D72): JS's Map and Set, with the expected values JS's own
// give (each function here has a twin over JS's Map in tools/js-map-oracle.ts, which wrote the cases). Insertion order,
// SameValueZero keys, objects by identity, growth that moves a few entries an operation, and every change during an
// iteration. Lowered programs print their maps as this same class. String keys (strkeys): `JsString`, a dispatch
// interface, is a key through its own `hashKey` and `sameKey`, which keyHash and keySame reach by its class id (D70).
import { f64, idiv, lit, toF64, toI32, toU32, toUsize, u32, u64, type i32 } from "@tsl/core";
import { JsFlat, JsMap, JsSet, jsKeyNum, jsMapKey, jsNumKey, type JsString } from "@tsl/jsrt";
import { ref } from "@tsl/std";

class Item {
  constructor(public id: u32) {}
}

function mix(h: u32, x: u32): u32 {
  return Math.imul((h ^ x) >>> 0, 16777619) >>> 0;
}

/** A number key's code for a digest: an integer as itself, -0, NaN and the rest as their own codes. */
function code(x: f64): u32 {
  if (x !== x) return 0xdead;
  if (x === 0 && 1 / x < 0) return 0xbeef;
  return toU32(x);
}

/** Number keys, n in and then `ops` rounds of every operation, through moves; every answer in the digest. */
export function numbers(n: u32, ops: u32): i32 {
  const m = new JsMap(u64, f64, true, false);
  for (let i: u32 = 0; i < n; i++) m.set(jsNumKey(toF64(i * 7)), toF64(i));
  let h: u32 = 0x811c9dc5;
  for (let r: u32 = 0; r < ops; r++) {
    m.set(jsNumKey(toF64(100000 + r)), toF64(r));
    const k = jsNumKey(toF64(((r * 37) % n) * 7));
    if (r % 4 === 0) h = mix(h, m.delete(k) ? 1 : 0);
    else if (r % 4 === 1) m.set(k, toF64(r) + 0.5);
    else if (r % 4 === 2) {
      const v = m.get(k);
      h = mix(h, v === undefined ? 12345 : toU32(v * 2));
    } else {
      m.delete(k);
      m.set(k, toF64(r));
    }
    for (let i: u32 = 0; i < n; i += 5) h = mix(h, m.has(jsNumKey(toF64(i * 7))) ? 7 : 3);
    h = mix(h, m.size);
  }
  const c = m.cursor();
  while (m.advance(c)) h = mix(mix(h, code(jsKeyNum(m.keyAt(c)))), toU32(m.valAt(c) * 2));
  return toI32(h >>> 1);
}

/** -0 is +0, and NaN is NaN, whatever its bits: one entry each, and -0 comes back as +0. */
export function sameValueZero(): i32 {
  const m = new JsMap(u64, f64, true, false);
  m.set(jsNumKey(-0), 1);
  m.set(jsNumKey(0), 2);
  m.set(jsNumKey(NaN), 3);
  m.set(jsNumKey(0 / 0), 4);
  m.set(jsNumKey(-NaN), 5);
  let h: u32 = mix(0, m.size);
  h = mix(h, m.has(jsNumKey(-0)) ? 1 : 0);
  const v = m.get(jsNumKey(NaN));
  h = mix(h, v === undefined ? 99 : toU32(v));
  const c = m.cursor();
  while (m.advance(c)) h = mix(mix(h, code(jsKeyNum(m.keyAt(c)))), toU32(m.valAt(c)));
  m.delete(jsNumKey(0));
  h = mix(h, m.size);
  return toI32(h >>> 1);
}

/** Objects by identity: two items with the same id are two keys, and the same item is one. */
export function objects(n: u32): i32 {
  const items = new JsMap(u32, ref<Item | null>(), true, false);
  const m = new JsMap(ref<Item | null>(), u32, true, false);
  for (let i: u32 = 0; i < n; i++) {
    const a = new Item(i % 7);
    items.set(i, a);
    m.set(a, i);
  }
  let h: u32 = mix(0, m.size);
  for (let i: u32 = 0; i < n; i += 3) {
    const a = items.get(i);
    if (a !== undefined && a !== null) {
      h = mix(h, m.delete(a) ? 1 : 0);
      h = mix(h, m.has(a) ? 1 : 0);
      m.set(a, i + 1000);
    }
  }
  h = mix(h, m.has(new Item(1)) ? 1 : 0);
  const c = m.cursor();
  while (m.advance(c)) {
    const k = m.keyAt(c);
    h = mix(mix(h, k === null ? 77 : k.id), m.valAt(c));
  }
  return toI32(h >>> 1);
}

/** An LRU cache: a hit is deleted and set again, so it goes to the end; past `cap`, the first entry goes. */
export function lru(n: u32, cap: u32): i32 {
  const m = new JsMap(u32, u32, true, false);
  let h: u32 = 0;
  for (let i: u32 = 0; i < n; i++) {
    const k = ((i * 7) % 13) + ((i * 3) % 29);
    const v = m.get(k);
    if (v !== undefined) {
      m.delete(k);
      m.set(k, v + 1);
      h = mix(h, v);
    } else {
      m.set(k, i);
      if (m.size > cap) {
        const c = m.cursor();
        if (m.advance(c)) m.delete(m.keyAt(c));
      }
    }
    h = mix(h, m.size);
  }
  const c = m.cursor();
  while (m.advance(c)) h = mix(mix(h, m.keyAt(c)), m.valAt(c));
  return toI32(h >>> 1);
}

/**
 * One change while iterating a map of n entries (0 to n - 1, value 10 * key), made when the iteration reaches `at`:
 * 0 deletes the current entry, 1 the next, 2 the one before, 3 the last; 4 adds a new key; 5 deletes and sets the current
 * one again; 6 clears; 7 clears and adds; 8 sets the next one's value; 9 deletes everything after; 10 adds n new keys, so
 * the table grows and moves under the cursor; 11 deletes every other entry, so a move skips them; 12 deletes then adds
 * again everything before. Every entry visited, and the order, is in the digest.
 */
export function mutate(n: u32, change: u32, at: u32): i32 {
  const m = new JsMap(u32, u32, true, false);
  for (let i: u32 = 0; i < n; i++) m.set(i, i * 10);
  let h: u32 = 0x811c9dc5;
  let seen: u32 = 0;
  const c = m.cursor();
  while (m.advance(c) && seen < 10000) {
    const k = m.keyAt(c);
    h = mix(mix(h, k), m.valAt(c));
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
        for (let j: u32 = 0; j < n; j++) m.set(1000 + j, j);
      } else if (change === 11) {
        for (let j: u32 = 0; j < n; j += 2) m.delete(j);
      } else if (change === 12) {
        for (let j: u32 = 0; j < k; j++) m.delete(j);
        for (let j: u32 = 0; j < k; j++) m.set(j, j + 1);
      }
    }
    seen++;
  }
  // Finished stays finished: what's added now isn't seen by this cursor.
  m.set(9999, 1);
  h = mix(h, m.advance(c) ? 1 : 0);
  return toI32(mix(mix(h, seen), m.size) >>> 1);
}

/** Two cursors at once, through moves made by inserts and deletes, each seeing what JS's iterators see. */
export function twoCursors(n: u32): i32 {
  const m = new JsMap(u32, u32, true, false);
  for (let i: u32 = 0; i < n; i++) m.set(i, i);
  const a = m.cursor();
  const b = m.cursor();
  let h: u32 = 0;
  let steps: u32 = 0;
  let more = true;
  while (more && steps < 100000) {
    more = false;
    if (m.advance(a)) {
      more = true;
      const k = m.keyAt(a);
      h = mix(h, k);
      if (k % 3 === 0) m.delete(k + 2);
      if (k < n) m.set(k + n, k);
    }
    if (steps % 2 === 0 && m.advance(b)) {
      more = true;
      const k = m.keyAt(b);
      h = mix(h, k + 7);
      if (k % 5 === 1) m.delete(k);
    }
    steps++;
  }
  return toI32(mix(mix(h, steps), m.size) >>> 1);
}

/** JsSet: add, has, delete, clear, and iteration with an add and a delete during it. */
export function sets(n: u32): i32 {
  const s = new JsSet(u32, false);
  for (let i: u32 = 0; i < n; i++) s.add((i * 5) % (n + 3));
  let h: u32 = mix(0, s.size);
  for (let i: u32 = 0; i < n; i += 4) h = mix(h, s.delete(i) ? 1 : 0);
  h = mix(h, s.has(5) ? 1 : 0);
  const c = s.cursor();
  while (s.advance(c)) {
    const k = s.keyAt(c);
    h = mix(h, k);
    if (k === 10) s.add(n + 50);
    if (k === 15) s.delete(20);
  }
  s.clear();
  s.add(3);
  h = mix(h, s.size);
  return toI32(h >>> 1);
}

/** forEach, value first, seeing what the callback adds and not what it deletes first. */
export function forEachChanges(n: u32): i32 {
  const m = new JsMap(u32, u32, true, false);
  for (let i: u32 = 0; i < n; i++) m.set(i, i + 1);
  let h: u32 = 0;
  m.forEach((v: u32, k: u32) => {
    h = mix(mix(h, k), v);
    if (k === 2) m.delete(3);
    if (k < 3) m.set(k + n, 0);
  });
  return toI32(mix(h, m.size) >>> 1);
}

// --- string keys (strkeys, D72): JsString's hashKey and sameKey, through dispatch

/** A string of the units u0, u1 (u1 < 0 for one unit), made fresh: a lone surrogate is a literal UTF-8 can't say. */
function units2(u0: i32, u1: i32): JsString {
  const s = JsFlat.zeroed(u1 < 0 ? 1 : 2);
  s.put(0, u0);
  if (u1 >= 0) s.put(1, u1);
  return s;
}

/** "w" and i's decimal digits, a new object each time. */
function word(i: u32): JsString {
  let digits: i32 = 1;
  for (let x: u32 = i; x >= 10; x = idiv(x, 10)) digits++;
  const s = JsFlat.zeroed(digits + 1);
  s.put(0, 119);
  let x: u32 = i;
  for (let d: i32 = digits; d >= 1; d--) {
    s.put(toUsize(d), 48 + toI32(x % 10));
    x = idiv(x, 10);
  }
  return s;
}

/** 40 units of a 48-unit string from its 5th: a view, which shares its owner's units, or (flat) a copy of them. */
function forty(flat: boolean): JsString {
  const n: i32 = flat ? 40 : 48;
  const s = JsFlat.zeroed(n);
  const from: i32 = flat ? 4 : 0;
  for (let i: i32 = 0; i < n; i++) s.put(toUsize(i), 97 + ((i + from) % 26));
  return flat ? s : s.sub(4, 40);
}

/**
 * The awkward keys, each made anew: "" (the shared one, or a new one), non-ASCII, a pair, lone surrogates, a NUL, and
 * 40 units as a view or as a flat copy. `other` makes the same text as another object, of the other class for the view.
 */
function special(j: u32, other: boolean): JsString {
  if (j === 0) return other ? JsFlat.zeroed(0) : JsFlat.empty();
  if (j === 1) return JsFlat.of(lit("héllo"));
  if (j === 2) return JsFlat.of(lit("日本語"));
  if (j === 3) return JsFlat.of(lit("😀"));
  if (j === 4) return units2(0xd800, -1);
  if (j === 5) return units2(0xdc00, -1);
  if (j === 6) return units2(0x61, 0xd800);
  if (j === 7) return units2(0xdfff, 0x61);
  if (j === 8) return forty(other);
  if (j === 9) return units2(0, -1);
  if (j === 10) return JsFlat.of(lit("héllO"));
  return units2(0xd800, 0xdc00); // "😀" by its units
}

const SPECIALS: u32 = 12;

/** A digest of a string's units: its length, then each unit. */
function codeOf(s: JsString | null): u32 {
  if (s === null) return 0x5eed;
  let c: u32 = toU32(s.len());
  for (let i: i32 = 0; i < s.len(); i++) c = mix(c, toU32(s.unit(toUsize(i))));
  return c;
}

/**
 * String keys: the awkward ones and n words, set through one set of objects and looked up, deleted and set again through
 * others with the same units (`swap` the other way round), then iterated. Every answer in the digest.
 */
export function stringKeys(n: u32, rounds: u32, swap: u32): i32 {
  const m = new JsMap(ref<JsString | null>(), u32, true, false);
  for (let j: u32 = 0; j < SPECIALS; j++) m.set(special(j, swap === 1), j);
  for (let i: u32 = 0; i < n; i++) m.set(word(i * 7), i + 100);
  let h: u32 = mix(0x811c9dc5, m.size);
  for (let j: u32 = 0; j < SPECIALS; j++) {
    const v = m.get(special(j, swap !== 1));
    h = mix(h, v === undefined ? 777 : v);
  }
  for (let r: u32 = 0; r < rounds; r++) {
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
  const c = m.cursor();
  while (m.advance(c)) h = mix(mix(h, codeOf(m.keyAt(c))), m.valAt(c));
  return toI32(h >>> 1);
}

/** A Set of strings: one entry per text, whichever object or class says it. */
export function stringSet(n: u32): i32 {
  const s = new JsSet(ref<JsString | null>(), false);
  for (let i: u32 = 0; i < n; i++) {
    s.add(word(i % 17));
    s.add(special(i % SPECIALS, (i & 1) === 1));
  }
  let h: u32 = mix(0, s.size);
  h = mix(h, s.has(JsFlat.of(lit(""))) ? 1 : 0);
  h = mix(h, s.has(units2(0xd800, 0xdc00)) ? 1 : 0);
  h = mix(h, s.delete(JsFlat.of(lit("😀"))) ? 1 : 0);
  h = mix(h, s.has(units2(0xd800, 0xdc00)) ? 1 : 0);
  const c = s.cursor();
  while (s.advance(c)) h = mix(h, codeOf(s.keyAt(c)));
  return toI32(h >>> 1);
}

/**
 * Each string's hash (D42's keyed HalfSipHash-1-3, 30 bits) under the key (k0, k1), as compiler/rt's strHash gives it:
 * worked out, then read back from the hash word. The key goes back to the default after.
 */
export function stringHashes(k0: i32, k1: i32, n: u32): i32 {
  jsMapKey(k0, k1);
  let h: u32 = 0;
  for (let j: u32 = 0; j < SPECIALS + n; j++) {
    // Never the shared "": its hash was kept under the key it was first hashed with, as D42 says a key is set first.
    const s = j < SPECIALS ? special(j, j === 0 || (j & 1) === 1) : word(j * 31);
    const a = s.hashKey();
    h = mix(mix(h, a), a === s.hashKey() ? 1 : 0);
  }
  jsMapKey(0x243f6a88, -2052912941);
  return toI32(h >>> 1);
}
