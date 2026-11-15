// Strings in `rc` through the TSL route (R10, D42, D74): what class printing prints a lowered `rc` program's strings as.
//
// In `leak` and `manual` a string is @tsl/jsrt's `JsString` (D67), which a `leak` package makes and never frees. In `rc`
// it's two classes of the program's own, printed into it as an array's holder is (R2), so tslc's `rc` expansion counts
// them as it counts every other class: one counting implementation, and nothing added to TSL. `JsStr` is a string: its
// units its own tail (D69) where `buf` is null, a flat string, or `n` units of a `JsStrBuf` from `start`, a view, which is
// what concatenation and a long substring make. `JsStrBuf` is a concatenation's buffer, which appends and prepends write
// into outside every view's units (D42's rule), and which holds nothing, so the type graph has no cycle through strings
// (a string is never a candidate, D41) and freeing one is a slot and a block (D39's per-step bound). The units are read
// and copied as the tails' own slices, with `.set` and `.subarray`, and hashed from them, so nothing here is unsafe; the
// one address taken is for a native caller to write a string argument's units at (`unitsAddr`, 4.5's ABI).
//
// What differs from JsString, by design: a substring of a flat string copies where JsString's would share it (a view's
// owner here is always a buffer, as a string holding a string would put strings in a cycle of the type graph); and a
// one-unit string is made each time, where JsString keeps a table of them. Neither shows in a result.

/** The names the printing gives the string runtime, reserved before anything of the program's is named. */
export const RC_STR_NAMES = [
  "JsStr",
  "JsStrBuf",
  "jsStrZeroed",
  "jsStrEmpty",
  "jsStrNone",
  "jsStrOf",
  "jsStrOfUnits",
  "jsStrOfUnit",
  "jsStrJoined",
  "jsStrView",
  "jsStrEq",
  "jsStrHash",
  "toU64",
];

/** What the runtime takes from @tsl/core: values, then types. */
export const RC_STR_CORE = [
  "tail",
  "toI32",
  "toU64",
  "toUsize",
  "Trap",
  "trap",
  "u16",
  "withTail",
  "wrapI32",
  "wrapU16",
  "wrapU32",
  "bool",
  "i32",
  "u32",
  "u64",
  "usize",
];

/**
 * A bug put into the string runtime on purpose, each to be caught (R10, tools/r10-tests.ts): `rcstr-append-shared` appends
 * in place to a buffer whatever view ends there, so two strings built from one prefix write over each other's tails.
 */
function fault(): string {
  return process.env.TMK_TEST_EMIT ?? "";
}

/** The string runtime's text: the two classes and the functions the printing calls in place of JsString's statics. */
export function rcStrRuntime(key: [string, string] | null): string[] {
  // the hash key (D42): the module's own two words where a native caller can set them, otherwise their first values
  const [k0, k1] = key !== null ? key : ["608135816", "-2052912941"];
  const appendCheck =
    fault() === "rcstr-append-shared"
      ? "at + lb <= wrapI32(ab.units.length)"
      : "at === ab.end && at + lb <= wrapI32(ab.units.length)";
  return `/**
 * A concatenation's buffer (R10, D42): room for units in its tail, those from \`head\` to \`end\` read by strings, which
 * appends and prepends write outside of. Never a string itself, and holds nothing.
 */
class JsStrBuf {
  head: i32 = 0;
  end: i32 = 0;
  units = tail(u16);
}

/**
 * A JS string in \`rc\` (R10, D42), counted as the program's classes are (D74): \`n\` UTF-16 units, its own tail where \`buf\`
 * is null, or \`buf\`'s from \`start\`. Nothing changes once it's made but the hash word, and a flat string's units, which
 * whoever made it with \`jsStrZeroed\` writes before anyone else has it.
 */
class JsStr {
  hw: i32 = 0; // 2 if concatenation made it; bit 0 once the hash is known, which is in the bits above bit 1
  start: i32 = 0; // where its units start in its buffer
  buf: JsStrBuf | null = null; // a view's buffer
  constructor(public n: i32) {}
  units = tail(u16);

  /** @tsl.inline */
  len(): i32 {
    return this.n;
  }

  /** The units it reads: its own tail, or its run of its buffer's. */
  /** @tsl.inline */
  all(): Uint16Array {
    const b = this.buf;
    if (b === null) return this.units;
    const s = toUsize(this.start);
    return b.units.subarray(s, s + toUsize(this.n));
  }

  /** The code unit at i, which is below the length. */
  /** @tsl.inline */
  unit(i: usize): i32 {
    if (i >= toUsize(this.n)) trap(Trap.Bounds);
    const b = this.buf;
    if (b === null) return toI32(this.units[i]!);
    return toI32(b.units[toUsize(this.start) + i]!);
  }

  /** Writes unit i of a string jsStrZeroed just made; a view has none of its own, so it traps. */
  /** @tsl.inline */
  put(i: usize, u: i32): void {
    this.units[i] = wrapU16(u);
  }

  /** Copies n units of s from si into this string, made by jsStrZeroed and no one else's yet, from di. */
  copyFrom(di: usize, s: JsStr, si: usize, n: usize): void {
    if (si + n > toUsize(s.n)) trap(Trap.Bounds);
    this.units.set(s.all().subarray(si, si + n), di);
  }

  /** Unit 0's address, where a native caller writes a string argument's units (4.5's ABI). */
  unitsAddr(): u64 {
    return toU64(cast<usize>(part<Ref>(this.all(), 0, 1)));
  }

  /** How many units the code point at i takes, 1 or 2; a lone surrogate is one. */
  cpLen(i: i32): i32 {
    const n = this.n;
    if (i < 0 || i >= n) trap(Trap.Bounds);
    const u = this.all();
    const c = toI32(u[toUsize(i)]!);
    if (c < 0xd800 || c > 0xdbff || i + 1 >= n) return 1;
    const d = toI32(u[toUsize(i + 1)]!);
    return d >= 0xdc00 && d <= 0xdfff ? 2 : 1;
  }

  /**
   * \`this + b\`, whose length the caller has checked is within JS's. Up to 64 units it copies; an append to a view that ends
   * where its buffer's used units end, or a prepend to one that starts where they start, writes in place where there's
   * room; the second concatenation onto a string made by one makes a buffer of twice the room. So \`s += x\` is linear.
   */
  concat(b: JsStr): JsStr {
    const la = this.n;
    const lb = b.n;
    if (la === 0) return b;
    if (lb === 0) return this;
    const n = la + lb;
    if (n <= 64) return jsStrJoined(this, b, n);
    const ab = this.buf;
    if (ab !== null) {
      const at = this.start + la;
      if (${appendCheck}) {
        ab.units.set(b.all(), toUsize(at));
        ab.end = at + lb;
        return jsStrView(ab, this.start, n, 2);
      }
    }
    const bb = b.buf;
    if (bb !== null) {
      const head = b.start;
      if (head === bb.head && head >= la) {
        const h = head - la;
        bb.units.set(this.all(), toUsize(h));
        bb.head = h;
        return jsStrView(bb, h, n, 2);
      }
    }
    const ga = (this.hw & 2) !== 0;
    if (!ga && (b.hw & 2) === 0) return jsStrJoined(this, b, n);
    const cap = n >= 268435456 ? (n > 536870888 ? n : 536870888) : n * 2;
    const nb = withTail(toUsize(cap), new JsStrBuf());
    const at = ga ? 0 : cap - n;
    nb.units.set(this.all(), toUsize(at));
    nb.units.set(b.all(), toUsize(at + la));
    nb.head = at;
    nb.end = at + n;
    return jsStrView(nb, at, n, 2);
  }

  /** The n units from i, which are within it: shared with its buffer if they're at least 32 and a quarter of its room. */
  sub(i: i32, n: i32): JsStr {
    const len = this.n;
    if (i < 0 || n < 0 || i + n > len) trap(Trap.Bounds);
    if (n === len) return this;
    if (n === 0) return jsStrEmpty();
    if (n === 1) return jsStrOfUnit(this.unit(toUsize(i)));
    const b = this.buf;
    if (b !== null && n >= 32 && n * 4 >= wrapI32(b.units.length))
      return jsStrView(b, this.start + i, n, 0);
    const r = jsStrZeroed(n);
    r.units.set(this.all().subarray(toUsize(i), toUsize(i + n)), 0);
    return r;
  }

  /** By code unit, as JS orders strings: negative, zero or positive. */
  compare(b: JsStr): i32 {
    const ua = this.all();
    const ub = b.all();
    const la = this.n;
    const lb = b.n;
    const n = toUsize(la < lb ? la : lb);
    for (let i: usize = 0; i < n; i++) {
      const d = toI32(ua[i]!) - toI32(ub[i]!);
      if (d !== 0) return d;
    }
    return la - lb;
  }

  /** D42's hash word: compiler/rt's strHash keeps its hash here. */
  /** @tsl.inline */
  hashWord(): i32 {
    return this.hw;
  }

  /** Keeps the hash word strHash worked out; whether concatenation made it stays the string's own. */
  setHashWord(w: i32): void {
    this.hw = (w & ~2) | (this.hw & 2);
  }

  /** A map key's hash (D72): D42's keyed hash of the units, kept in the hash word. */
  hashKey(): u32 {
    const w = this.hw;
    if ((w & 1) !== 0) return wrapU32(w) >>> 2;
    const h = jsStrHash(this.all(), ${k0}, ${k1});
    this.hw = ((wrapI32((h << 2) >>> 0) | 1) & ~2) | (w & 2);
    return h;
  }

  /** A map key's equality: the same units, as JS's \`===\`; two known hashes that differ say no first. */
  sameKey(b: JsStr): bool {
    const ha = this.hw;
    const hb = b.hw;
    if ((ha & hb & 1) !== 0 && (ha | 3) !== (hb | 3)) return false;
    return jsStrEq(this, b);
  }

  /** Whether it reads a buffer's units: what tests of the sharing bound look at. */
  isView(): bool {
    return this.buf !== null;
  }
}

/** \`""\`, once made, kept. */
let jsStrNone: JsStr | null = null;

/** \`n\` units, each zero, for a builder to \`put\` and \`copyFrom\` into before anyone else sees it. */
function jsStrZeroed(n: i32): JsStr {
  if (n < 0 || n > 536870888) trap(Trap.OutOfMemory);
  return withTail(toUsize(n), new JsStr(n));
}

/** \`""\`. */
function jsStrEmpty(): JsStr {
  const e = jsStrNone;
  if (e !== null) return e;
  const s = jsStrZeroed(0);
  jsStrNone = s;
  return s;
}

/** A view of n units of a buffer from start. */
function jsStrView(b: JsStrBuf, start: i32, n: i32, hw: i32): JsStr {
  const r = withTail(0, new JsStr(n));
  r.start = start;
  r.buf = b;
  r.hw = hw;
  return r;
}

/** a's units then b's, n in all, copied into a flat string made by concatenation. */
function jsStrJoined(a: JsStr, b: JsStr, n: i32): JsStr {
  const r = jsStrZeroed(n);
  r.units.set(a.all(), 0);
  r.units.set(b.all(), toUsize(a.n));
  r.hw = 2;
  return r;
}

/** A literal from its UTF-8 bytes: the text as JS has it, for every literal that's well-formed UTF-16. */
function jsStrOf(bytes: Uint8Array): JsStr {
  let n: i32 = 0;
  for (let i: usize = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b < 0x80 || b >= 0xc0) n += b >= 0xf0 ? 2 : 1;
  }
  const s = jsStrZeroed(n);
  let k: usize = 0;
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
      s.put(k, 0xd800 + ((c - 0x10000) >> 10));
      s.put(k + 1, 0xdc00 + ((c - 0x10000) & 0x3ff));
      k += 2;
    } else {
      s.put(k, c);
      k += 1;
    }
  }
  return s;
}

/** A literal from its units, for one UTF-8 can't say: a lone surrogate. */
function jsStrOfUnits(u: Uint16Array): JsStr {
  const s = jsStrZeroed(wrapI32(u.length));
  s.units.set(u, 0);
  return s;
}

/** The string of one unit. */
function jsStrOfUnit(u: i32): JsStr {
  const s = jsStrZeroed(1);
  s.put(0, u);
  return s;
}

/**
 * D42's string hash: HalfSipHash-1-3 of the units, two to a word, under the hash key, in 30 bits, as @tsl/jsrt's
 * jsUnitsHash and compiler/rt's strHash give it, read from the units as they are, with no address.
 */
function jsStrHash(at: Uint16Array, k0: i32, k1: i32): u32 {
  const len: u32 = wrapU32(wrapI32(at.length));
  let v0: u32 = wrapU32(k0);
  let v1: u32 = wrapU32(k1);
  let v2: u32 = (0x6c796765 ^ v0) >>> 0;
  let v3: u32 = (0x74656462 ^ v1) >>> 0;
  let i: u32 = 0;
  while (i + 2 <= len) {
    const m: u32 = (wrapU32(toI32(at[toUsize(i)]!)) | (wrapU32(toI32(at[toUsize(i + 1)]!)) << 16)) >>> 0;
    v3 = (v3 ^ m) >>> 0;
    v0 = (v0 + v1) >>> 0;
    v1 = ((v1 << 5) | (v1 >>> 27)) >>> 0;
    v1 = (v1 ^ v0) >>> 0;
    v0 = ((v0 << 16) | (v0 >>> 16)) >>> 0;
    v2 = (v2 + v3) >>> 0;
    v3 = ((v3 << 8) | (v3 >>> 24)) >>> 0;
    v3 = (v3 ^ v2) >>> 0;
    v0 = (v0 + v3) >>> 0;
    v3 = ((v3 << 7) | (v3 >>> 25)) >>> 0;
    v3 = (v3 ^ v0) >>> 0;
    v2 = (v2 + v1) >>> 0;
    v1 = ((v1 << 13) | (v1 >>> 19)) >>> 0;
    v1 = (v1 ^ v2) >>> 0;
    v2 = ((v2 << 16) | (v2 >>> 16)) >>> 0;
    v0 = (v0 ^ m) >>> 0;
    i += 2;
  }
  const last: u32 = ((len << 25) | (i < len ? wrapU32(toI32(at[toUsize(i)]!)) : 0)) >>> 0;
  v3 = (v3 ^ last) >>> 0;
  for (let r: u32 = 0; r < 4; r++) {
    v0 = (v0 + v1) >>> 0;
    v1 = ((v1 << 5) | (v1 >>> 27)) >>> 0;
    v1 = (v1 ^ v0) >>> 0;
    v0 = ((v0 << 16) | (v0 >>> 16)) >>> 0;
    v2 = (v2 + v3) >>> 0;
    v3 = ((v3 << 8) | (v3 >>> 24)) >>> 0;
    v3 = (v3 ^ v2) >>> 0;
    v0 = (v0 + v3) >>> 0;
    v3 = ((v3 << 7) | (v3 >>> 25)) >>> 0;
    v3 = (v3 ^ v0) >>> 0;
    v2 = (v2 + v1) >>> 0;
    v1 = ((v1 << 13) | (v1 >>> 19)) >>> 0;
    v1 = (v1 ^ v2) >>> 0;
    v2 = ((v2 << 16) | (v2 >>> 16)) >>> 0;
    if (r === 0) {
      v0 = (v0 ^ last) >>> 0;
      v2 = (v2 ^ 0xff) >>> 0;
    }
  }
  return (v1 ^ v3) & 0x3fffffff;
}

/** \`a === b\` for strings that may be \`undefined\` (null): the same units, or both missing. */
function jsStrEq(a: JsStr | null, b: JsStr | null): bool {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const n = a.n;
  if (n !== b.n) return false;
  const ua = a.all();
  const ub = b.all();
  for (let i: usize = 0; i < toUsize(n); i++) if (ua[i]! !== ub[i]!) return false;
  return true;
}`.split("\n");
}
