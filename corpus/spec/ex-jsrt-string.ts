// file: ex-jsrt-string.ts
import {
  tail,
  toI32,
  toU64,
  toUsize,
  Trap,
  trap,
  u16,
  withTail,
  wrapI32,
  wrapU16,
  wrapU32,
  type bool,
  type i32,
  type u32,
  type u64,
  type usize,
} from "@tsl/core";
import { copyBytes, ptrAt, ref, sourcePages, tailAddr } from "@tsl/unsafe";
import { jsUnitsHash } from "./ex-jsrt-map.ts";

const MAX_LEN: i32 = 536870888; // V8's limit; JS throws RangeError past it, which the caller checks for first
const SHARE_MIN: i32 = 32; // shorter than this, a substring copies
const CONCAT_FLAT_MAX: i32 = 64; // this short, concatenation always copies
const GROWN: i32 = 2; // in `hw`: made by concatenation, so a second append makes a buffer

// A string is one of two classes behind the dispatch interface `JsString` (D70): `JsFlat`, its units its own tail (D69),
// or `JsView`, which reads units another object owns. What a view reads is a `JsOwner`: a flat string, or a `JsBuf`, a
// concatenation's buffer, which is never a string itself. Nothing a string holds is freed in `leak` or `manual` (3.5,
// D42), and a buffer outgrown by concatenation stays for the views made into it. The one-unit table has its own page.

// A count or index of units, from 0 to MAX_LEN, in bytes: below 2^30 twice over, so nothing here can overflow, and
// there's nothing to check (`toUsize(n) * 2` would check it twice).
function bytesOf(n: i32): u64 {
  return toU64((n << 1) >>> 0);
}

// SAFETY: both runs are units of live strings, n of them, within the strings' lengths (each caller checks).
function copyUnits(to: u64, from: u64, n: i32): void {
  if (n > 0) copyBytes(to, from, toUsize(bytesOf(n)));
}

// SAFETY: i is below the length of the units at p, which the caller has checked.
function unitAt(p: u64, i: usize): i32 {
  return ptrAt(u16, p).add(i).read();
}

let empty: JsFlat | null = null;
let chars: u64 = 0n; // 256 references, null until each one-unit string is made

/**
 * A JavaScript string (D42, D67): immutable UTF-16 code units, lone surrogates kept, one reference. Each is a `JsFlat`
 * or a `JsView`, told apart by a class id (D70); a call on one is a compare of its id and a direct call. Concatenation
 * appends in place where the left side ends at its buffer's end, so `s += x` in a loop is linear with no flattening. A
 * substring shares only when it's at least a quarter of what it would keep alive. Lowered programs print their strings
 * as this interface (`tmk lower --emit tsl`).
 */
export interface JsString {
  /** The length in units. */
  len(): i32;
  /** The code unit at i, which is below the length (`charCodeAt` past it is JS's NaN, and the caller says so). */
  unit(i: usize): i32;
  /** Writes unit i of a string `JsFlat.zeroed` just made, before anything else has it: strings are immutable after. */
  put(i: usize, u: i32): void;
  /** Copies n units of s from si into this string, made by `JsFlat.zeroed` and no one else's yet, from di. */
  copyFrom(di: usize, s: JsString, si: usize, n: usize): void;
  /** The address of units si to si + n, which are checked to be within it: a run of reads after one class test. */
  unitsAt(si: usize, n: usize): u64;
  /** How many units the code point at i takes, 1 or 2: `for...of` steps by these. A lone surrogate is one. */
  cpLen(i: i32): i32;
  /** `this + b`, whose length the caller has checked is within JS's (it throws RangeError past it). */
  concat(b: JsString): JsString;
  /** `a + this`, `concat`'s second step, once a's class is known. */
  concatOntoFlat(a: JsFlat): JsString;
  /** `a + this`, likewise. */
  concatOntoView(a: JsView): JsString;
  /** The n units from i, which are within it. */
  sub(i: i32, n: i32): JsString;
  /** By code unit, as JS orders strings: negative, zero or positive. */
  compare(b: JsString): i32;
  /** D42's hash word: bit 0 when the hash is known, the hash in the bits above 1, and GROWN. compiler/rt's strHash. */
  hashWord(): i32;
  /** Keeps the hash word strHash worked out; how the string was made (GROWN) stays the class's own. */
  setHashWord(w: i32): void;
  /** Whether this reads another object's units, a view (D42): what tests of the sharing bound look at. */
  isView(): bool;
  /** Unit 0's address, where a native caller writes a string argument's units (`__str_units`, 4.5). */
  unitsAddr(): u64;
  /** A map key's hash (D72): D42's keyed HalfSipHash of the units, kept in the hash word. `keyHash` calls it. */
  hashKey(): u32;
  /** A map key's equality: the same units, as JS's `===`. `keySame` calls it. */
  sameKey(b: JsString): bool;
  /** Whether its units are the n at p, where hw, the other string's hash word, may say no first: sameKey's second step. */
  sameUnits(p: u64, n: i32, hw: i32): bool;
}

/** What a view reads units from: a flat string, or a concatenation's buffer. Only a buffer has room to grow into. */
export interface JsOwner {
  /** How many units it holds, used or not: what a view of it keeps alive. */
  room(): i32;
  /** Appends n units from `from` at `at`, if at is where its used units end and there's room: whether it did. */
  appendAt(at: i32, from: u64, n: i32): bool;
  /** Puts n units from `from` just before `head`, if head is where its used units start and there's room. */
  prependAt(head: i32, from: u64, n: i32): bool;
}

/** `a === b` for strings that may be `undefined` (null): the same units, or both missing. */
export function jsEq(a: JsString | null, b: JsString | null): bool {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const n = a.len();
  if (n !== b.len()) return false;
  const pa = a.unitsAt(0, toUsize(n));
  const pb = b.unitsAt(0, toUsize(n));
  for (let i: usize = 0; i < toUsize(n); i++) if (unitAt(pa, i) !== unitAt(pb, i)) return false;
  return true;
}

/** A hash word strHash worked out, with how the string was made (GROWN) kept from the word it had. */
function keptHash(w: i32, hw: i32): i32 {
  return (w & ~GROWN) | (hw & GROWN);
}

/** The hash word that keeps h, a key's hash jsUnitsHash worked out (D72), and how the string was made from hw. */
function hashWordOf(h: u32, hw: i32): i32 {
  return keptHash(wrapI32((h << 2) >>> 0) | 1, hw);
}

/** Two strings' units the same, by JS's `===`; two hash words that both have the hash and differ say no first. */
// SAFETY: la and lb are the lengths of the units at pa and pb.
function unitsSame(pa: u64, la: i32, ha: i32, pb: u64, lb: i32, hb: i32): bool {
  if (la !== lb) return false;
  if ((ha & hb & 1) !== 0 && (ha | 3) !== (hb | 3)) return false;
  if (pa === pb) return true;
  for (let i: usize = 0; i < toUsize(la); i++) if (unitAt(pa, i) !== unitAt(pb, i)) return false;
  return true;
}

// SAFETY: n is p's length, so i and i + 1 are read only below it.
function cpLenAt(p: u64, n: i32, i: i32): i32 {
  if (i < 0 || i >= n) trap(Trap.Bounds);
  const c = unitAt(p, toUsize(i));
  if (c < 0xd800 || c > 0xdbff || i + 1 >= n) return 1;
  const d = unitAt(p, toUsize(i + 1));
  return d >= 0xdc00 && d <= 0xdfff ? 2 : 1;
}

// SAFETY: la and lb are the lengths of the units at pa and pb.
function compareAt(pa: u64, la: i32, pb: u64, lb: i32): i32 {
  const n = la < lb ? la : lb;
  for (let i: usize = 0; i < toUsize(n); i++) {
    const d = unitAt(pa, i) - unitAt(pb, i);
    if (d !== 0) return d;
  }
  return la - lb;
}

/**
 * `a + b` once both classes are known: la and pa are a's length and units, av is a when it's a view, and likewise for b;
 * ga and gb say whether each was made by concatenation. Inlined into each of the four pairs, where the nulls fold.
 */
/** @tsl.inline */
// SAFETY: an append writes past a buffer's end or before its head, which no view reads (each reads only its own n
// units), and only where it's within the buffer's room.
function joinParts(
  a: JsString,
  la: i32,
  pa: u64,
  av: JsView | null,
  ga: bool,
  b: JsString,
  lb: i32,
  pb: u64,
  bv: JsView | null,
  gb: bool,
): JsString {
  if (la === 0) return b;
  if (lb === 0) return a;
  // The caller has checked n against MAX_LEN (JS's RangeError): not again here (pipe-dispatch). Past it, nothing is
  // written out of bounds: a buffer is at least n, and an append in place checks its room.
  const n = la + lb;
  if (n <= CONCAT_FLAT_MAX) return JsFlat.joined(pa, la, pb, lb);
  if (av !== null && av.owner.appendAt(av.start + la, pb, lb))
    return JsView.grown(av.owner, av.start, n, pa);
  if (bv !== null && bv.owner.prependAt(bv.start, pa, la))
    return JsView.grown(bv.owner, bv.start - la, n, pb - bytesOf(la));
  if (!ga && !gb) return JsFlat.joined(pa, la, pb, lb);
  // The second append to the same string: from here on it pays to have room. Doubling makes it linear in all.
  const cap = n >= 268435456 ? (n > MAX_LEN ? n : MAX_LEN) : n * 2;
  const buf = withTail(toUsize(cap), new JsBuf());
  const at = ga ? 0 : cap - n;
  const base = buf.unitsAddr();
  copyUnits(base + bytesOf(at), pa, la);
  copyUnits(base + bytesOf(at + la), pb, lb);
  buf.head = at;
  buf.end = at + n;
  return JsView.grown(buf, at, n, base + bytesOf(at));
}

/**
 * A flat string: its units are its own tail (D69), one allocation of 12 bytes and its units (the class id, the hash word
 * and the tail's length, which is the string's). As an owner it has no room past its units, so nothing is ever appended
 * to it in place.
 */
export class JsFlat {
  hw: i32 = 0; // GROWN, or nothing: what D42's hash word says of how it was made; the module's own
  private units = tail(u16);

  /** `n` units, each zero, for a builder to `put` and `copyFrom` into before anyone else sees it. */
  /** @tsl.inline */
  static zeroed(n: i32): JsFlat {
    if (n < 0 || n > MAX_LEN) trap(Trap.OutOfMemory);
    return withTail(toUsize(n), new JsFlat());
  }

  /** A literal from its UTF-8 bytes: the text as JS has it, for every literal that's well-formed UTF-16. */
  // SAFETY: the count pass and the writing pass decode the same bytes the same way, so k never passes n.
  static of(bytes: Uint8Array): JsFlat {
    let n: i32 = 0;
    for (let i: usize = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      if (b < 0x80 || b >= 0xc0) n += b >= 0xf0 ? 2 : 1;
    }
    const s = JsFlat.zeroed(n);
    let k: i32 = 0;
    let i: usize = 0;
    while (i < bytes.length) {
      const b = toI32(bytes[i]!);
      let c: i32 = b;
      let more: usize = 0;
      if (b >= 0xf0) {
        c = b & 7;
        more = 3;
      } else if (b >= 0xe0) {
        c = b & 15;
        more = 2;
      } else if (b >= 0xc0) {
        c = b & 31;
        more = 1;
      }
      for (let j: usize = 1; j <= more; j++) c = (c << 6) | (toI32(bytes[i + j]!) & 63);
      i += more + 1;
      if (c >= 0x10000) {
        s.put(toUsize(k), 0xd800 + ((c - 0x10000) >> 10));
        s.put(toUsize(k + 1), 0xdc00 + ((c - 0x10000) & 0x3ff));
        k += 2;
      } else {
        s.put(toUsize(k), c);
        k += 1;
      }
    }
    return s;
  }

  /** A literal from its units, for one UTF-8 can't say: a lone surrogate. */
  static ofUnits(u: Uint16Array): JsFlat {
    const s = JsFlat.zeroed(toI32(u.length));
    for (let i: usize = 0; i < u.length; i++) s.put(i, toI32(u[i]!));
    return s;
  }

  /** The string of one unit: below 256, one kept string each, as JS engines keep them. */
  /** @tsl.inline */
  // SAFETY: u is below 256, so its slot is in the table, which holds only these strings or null.
  static ofUnit(u: i32): JsFlat {
    const tab = chars;
    if (tab !== 0n && u >= 0 && u < 256) {
      const slot = ptrAt(ref<JsFlat | null>(), tab).add(toUsize(u >>> 0));
      const had = slot.read();
      if (had !== null) return had;
    }
    return JsFlat.unitMade(u);
  }

  // SAFETY: as ofUnit; the table is a zeroed page no one else has, from the registered page source (3.8), never given
  // back, so every slot starts null.
  // Never inlined: it's the table's miss, and a copy of its checks in each caller made `ofUnit`'s callers too big to
  // inline themselves (pipe-h).
  /** @tsl.noinline */
  private static unitMade(u: i32): JsFlat {
    if (u >= 0 && u < 256) {
      if (chars === 0n) {
        const page = sourcePages(1);
        if (page === 0n) trap(Trap.OutOfMemory);
        chars = page;
      }
      const slot = ptrAt(ref<JsFlat | null>(), chars).add(toUsize(u >>> 0));
      const had = slot.read();
      if (had !== null) return had;
      const c = JsFlat.zeroed(1);
      c.put(0, u);
      slot.write(c);
      return c;
    }
    const s = JsFlat.zeroed(1);
    s.put(0, u);
    return s;
  }

  /** `""`, one string of none. */
  static empty(): JsFlat {
    const e = empty;
    if (e !== null) return e;
    const s = JsFlat.zeroed(0);
    empty = s;
    return s;
  }

  /** la units at pa and lb at pb, copied into a new flat string made by concatenation. */
  /** @tsl.inline */
  // SAFETY: the runs are la and lb units of live strings, and the new string holds la + lb.
  static joined(pa: u64, la: i32, pb: u64, lb: i32): JsFlat {
    const r = JsFlat.zeroed(la + lb);
    const p = r.unitsAddr();
    copyUnits(p, pa, la);
    copyUnits(p + bytesOf(la), pb, lb);
    r.hw = GROWN;
    return r;
  }

  len(): i32 {
    return wrapI32(this.units.length); // at most MAX_LEN, as `zeroed` made it
  }

  // SAFETY: a flat string's units are its own tail, which lives as long as it does.
  unitsAddr(): u64 {
    return tailAddr(this);
  }

  // SAFETY: i is below the length, so the unit is in this string's units.
  unit(i: usize): i32 {
    if (i >= this.units.length) trap(Trap.Bounds);
    return unitAt(this.unitsAddr(), i);
  }

  // SAFETY: i is below the length, so the unit is in this string's own units.
  put(i: usize, u: i32): void {
    if (i >= this.units.length) trap(Trap.Bounds);
    ptrAt(u16, this.unitsAddr()).add(i).write(wrapU16(u));
  }

  // SAFETY: both ranges are checked to be within their strings, s's by unitsAt.
  copyFrom(di: usize, s: JsString, si: usize, n: usize): void {
    if (di + n > this.units.length) trap(Trap.Bounds);
    const from = s.unitsAt(si, n);
    if (n > 0) copyBytes(ptrAt(u16, this.unitsAddr()).add(di).addr, from, n * 2);
  }

  // SAFETY: the range is checked to be within the units.
  unitsAt(si: usize, n: usize): u64 {
    if (si + n > this.units.length) trap(Trap.Bounds);
    return ptrAt(u16, this.unitsAddr()).add(si).addr;
  }

  cpLen(i: i32): i32 {
    return cpLenAt(this.unitsAddr(), this.len(), i);
  }

  /** @tsl.inline */
  concat(b: JsString): JsString {
    return b.concatOntoFlat(this);
  }

  /** @tsl.inline */
  concatOntoFlat(a: JsFlat): JsString {
    const ga = (a.hw & GROWN) !== 0;
    const gb = (this.hw & GROWN) !== 0;
    return joinParts(
      a,
      a.len(),
      a.unitsAddr(),
      null,
      ga,
      this,
      this.len(),
      this.unitsAddr(),
      null,
      gb,
    );
  }

  /** @tsl.inline */
  concatOntoView(a: JsView): JsString {
    const ga = (a.hw & GROWN) !== 0;
    const gb = (this.hw & GROWN) !== 0;
    return joinParts(a, a.n, a.data, a, ga, this, this.len(), this.unitsAddr(), null, gb);
  }

  /** A view keeps its owner alive, so only one at least a quarter of it shares. */
  sub(i: i32, n: i32): JsString {
    const len = this.len();
    if (i < 0 || n < 0 || i + n > len) trap(Trap.Bounds);
    if (n === len) return this;
    if (n === 0) return JsFlat.empty();
    const p = this.unitsAddr();
    if (n === 1) return JsFlat.ofUnit(unitAt(p, toUsize(i)));
    if (n >= SHARE_MIN && n * 4 >= len) return new JsView(n, i, p + bytesOf(i), this);
    const r = JsFlat.zeroed(n);
    copyUnits(r.unitsAddr(), p + bytesOf(i), n);
    return r;
  }

  compare(b: JsString): i32 {
    const lb = b.len();
    const la = this.len();
    return compareAt(this.unitsAddr(), la, b.unitsAt(0, toUsize(la < lb ? la : lb)), lb);
  }

  hashWord(): i32 {
    return this.hw;
  }

  setHashWord(w: i32): void {
    this.hw = keptHash(w, this.hw);
  }

  hashKey(): u32 {
    const w = this.hw;
    if ((w & 1) !== 0) return wrapU32(w) >>> 2; // the hash is known
    const h = jsUnitsHash(this.unitsAddr(), this.len());
    this.hw = hashWordOf(h, w);
    return h;
  }

  sameKey(b: JsString): bool {
    return b.sameUnits(this.unitsAddr(), this.len(), this.hw);
  }

  sameUnits(p: u64, n: i32, hw: i32): bool {
    return unitsSame(this.unitsAddr(), this.len(), this.hw, p, n, hw);
  }

  isView(): bool {
    return false;
  }

  room(): i32 {
    return this.len();
  }

  /** A flat string has no room past its units: nothing is appended to it in place. */
  appendAt(_at: i32, _from: u64, _n: i32): bool {
    return false;
  }

  /** Nor before them. */
  prependAt(_head: i32, _from: u64, _n: i32): bool {
    return false;
  }
}

/**
 * A view: n units another object owns, from its unit `start`, at `data`. 32 bytes: the class id, the hash word, the
 * length, the start, unit 0's address and the owner. Its fields are the module's own, and never change after it's made
 * but for the hash word.
 */
export class JsView {
  hw: i32 = 0; // GROWN, or nothing, and strHash's cache
  constructor(
    public n: i32, // the length in units
    public start: i32, // the first unit in its owner
    public data: u64, // unit 0's address, in its owner's units
    public owner: JsOwner, // the flat string or buffer whose units it reads
  ) {}

  /** A view made by concatenation, into a buffer that may have room for the next append. */
  /** @tsl.inline */
  static grown(owner: JsOwner, at: i32, n: i32, data: u64): JsView {
    const r = new JsView(n, at, data, owner);
    r.hw = GROWN;
    return r;
  }

  len(): i32 {
    return this.n;
  }

  unitsAddr(): u64 {
    return this.data;
  }

  // SAFETY: i is below n, so the unit is in the units this view reads.
  unit(i: usize): i32 {
    if (i >= toUsize(this.n >>> 0)) trap(Trap.Bounds);
    return unitAt(this.data, i);
  }

  /** A view has no units of its own to write: every index is past them. */
  put(_i: usize, _u: i32): void {
    trap(Trap.Bounds);
  }

  /** Likewise. */
  copyFrom(_di: usize, _s: JsString, _si: usize, _n: usize): void {
    trap(Trap.Bounds);
  }

  // SAFETY: the range is checked to be within the units this view reads.
  unitsAt(si: usize, n: usize): u64 {
    if (si + n > toUsize(this.n >>> 0)) trap(Trap.Bounds);
    return ptrAt(u16, this.data).add(si).addr;
  }

  cpLen(i: i32): i32 {
    return cpLenAt(this.data, this.n, i);
  }

  /** @tsl.inline */
  concat(b: JsString): JsString {
    return b.concatOntoView(this);
  }

  /** @tsl.inline */
  concatOntoFlat(a: JsFlat): JsString {
    const ga = (a.hw & GROWN) !== 0;
    const gb = (this.hw & GROWN) !== 0;
    return joinParts(a, a.len(), a.unitsAddr(), null, ga, this, this.n, this.data, this, gb);
  }

  /** @tsl.inline */
  concatOntoView(a: JsView): JsString {
    const ga = (a.hw & GROWN) !== 0;
    const gb = (this.hw & GROWN) !== 0;
    return joinParts(a, a.n, a.data, a, ga, this, this.n, this.data, this, gb);
  }

  /** A view of a view is judged against, and reads, the first owner: what a share would keep alive is all of it. */
  sub(i: i32, n: i32): JsString {
    const len = this.n;
    if (i < 0 || n < 0 || i + n > len) trap(Trap.Bounds);
    if (n === len) return this;
    if (n === 0) return JsFlat.empty();
    if (n === 1) return JsFlat.ofUnit(unitAt(this.data, toUsize(i)));
    if (n >= SHARE_MIN) {
      const room = this.owner.room();
      if (n * 4 >= room) return new JsView(n, this.start + i, this.data + bytesOf(i), this.owner);
    }
    const r = JsFlat.zeroed(n);
    copyUnits(r.unitsAddr(), this.data + bytesOf(i), n);
    return r;
  }

  compare(b: JsString): i32 {
    const lb = b.len();
    const la = this.n;
    return compareAt(this.data, la, b.unitsAt(0, toUsize(la < lb ? la : lb)), lb);
  }

  hashWord(): i32 {
    return this.hw;
  }

  setHashWord(w: i32): void {
    this.hw = keptHash(w, this.hw);
  }

  hashKey(): u32 {
    const w = this.hw;
    if ((w & 1) !== 0) return wrapU32(w) >>> 2; // the hash is known
    const h = jsUnitsHash(this.data, this.n);
    this.hw = hashWordOf(h, w);
    return h;
  }

  sameKey(b: JsString): bool {
    return b.sameUnits(this.data, this.n, this.hw);
  }

  sameUnits(p: u64, n: i32, hw: i32): bool {
    return unitsSame(this.data, this.n, this.hw, p, n, hw);
  }

  isView(): bool {
    return true;
  }
}

/**
 * A concatenation's buffer: room for units in its tail, of which those from `head` to `end` are used, by views only. It
 * is never a string, so only a view reaches it, and appends and prepends write outside what any view of it reads.
 */
export class JsBuf {
  head: i32 = 0; // the first unit used; the module's own
  end: i32 = 0; // one past the last unit used
  private units = tail(u16);

  // SAFETY: the buffer's units are its own tail, which lives as long as it does.
  unitsAddr(): u64 {
    const base = tailAddr(this);
    return base;
  }

  room(): i32 {
    return wrapI32(this.units.length); // at most MAX_LEN or the result's length, as `joinParts` made it
  }

  // SAFETY: at + n is within the room, and past every unit a view of this buffer reads.
  appendAt(at: i32, from: u64, n: i32): bool {
    if (at === this.end && at + n <= this.room()) {
      copyUnits(this.unitsAddr() + bytesOf(at), from, n);
      this.end = at + n;
      return true;
    }
    return false;
  }

  // SAFETY: head - n is at least 0, and before every unit a view of this buffer reads.
  prependAt(head: i32, from: u64, n: i32): bool {
    if (head === this.head && head >= n) {
      const h = head - n;
      copyUnits(this.unitsAddr() + bytesOf(h), from, n);
      this.head = h;
      return true;
    }
    return false;
  }
}
