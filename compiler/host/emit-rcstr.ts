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
// owner here is always a buffer, as a string holding a string would put strings in a cycle of the type graph), which
// doesn't show in a result. A one-unit string below 256 comes from a table, as JsString's and the direct route's do (R21):
// here the table is module state, an array of the program's own JsStr (`JsStrUnits`, counted as any holder is), each
// made the first time it's asked for and kept from then on, so never freed, as the direct route's static ones never are.

/** The names the printing gives the string runtime, reserved before anything of the program's is named. */
/** The one-unit string as it was before R21's table (TMK_R21_OFF=units): made each time. */
const UNITS_BEFORE = `/** The string of one unit. */
function jsStrOfUnit(u: i32): JsStr {
  const s = jsStrZeroed(1);
  s.put(0, u);
  return s;
}

`;

export const RC_STR_NAMES = [
  "JsStr",
  "JsStrBuf",
  "jsStrZeroed",
  "jsStrEmpty",
  "jsStrNone",
  "jsStrOf",
  "jsStrOfUnits",
  "jsStrOfUnit",
  "jsStrUnitMade",
  "JsStrUnits",
  "jsStrUnits",
  "jsStrJoined",
  "jsStrJoined3",
  "jsStrGrown",
  "jsStrView",
  "jsStrEq",
  "jsStrSame",
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
 * in place to a buffer whatever view ends there, so two strings built from one prefix write over each other's tails. R21
 * (tools/r21-tests.ts): `rcstr-unit-low7` files a one-unit string in the table by its unit's low 7 bits, so units 128 apart
 * share a slot and the second is given the first's string; `rcstr-unit-past` takes the table for units to 256 inclusive,
 * so unit 256 reads past the table's 256 slots (a bounds trap, never another string). R24 (tools/r24-tests.ts):
 * `r24-view-start` gives a view's constructor its start one on, and `r24-unit-start` reads a view's unit from its length's
 * bits where its start's are.
 */
function fault(): string {
  return process.env.TMK_TEST_EMIT ?? "";
}

/**
 * R21's printing put back as it was, for tools/r21-pins.ts (`TMK_R21_OFF=units`): a one-unit string made each time, and an
 * append of one unit copied. Never set otherwise.
 */
export function r21UnitsOff(): boolean {
  return (process.env.TMK_R21_OFF ?? "").split(",").includes("units");
}

/**
 * R22's printing put back as it was, for tools/r22-pins.ts (`TMK_R22_OFF=concat`, or `join3`): concatenation whole, out of
 * line. Never set otherwise.
 */
export function r22Off(part: string): boolean {
  return (process.env.TMK_R22_OFF ?? "").split(",").includes(part);
}

/**
 * R24's printing put back as it was, for tools/r24-pins.ts (`TMK_R24_OFF=strings`): a view's fields stored after it's made,
 * its constructor taking only its length, a unit read with its length and start checked, and `a + b` and `s[i]` not tagged
 * inline (emit-tsl.ts). Never set otherwise.
 */
export function r24Off(part: string): boolean {
  return (process.env.TMK_R24_OFF ?? "").split(",").includes(part);
}

/**
 * R30's printing put back as it was, for tools/r30-pins.ts (`TMK_R30_OFF=zeroed`, or `copy`): jsStrZeroed's length tested
 * as an i32 twice and checked again by toUsize, and compiler/rt's `strCopy` printed whole, a checked unit at a time. Never
 * set otherwise.
 */
export function r30Off(part: string): boolean {
  return (process.env.TMK_R30_OFF ?? "").split(",").includes(part);
}

/**
 * R25's printing put back as it was, for tools/r25-pins.ts (`TMK_R25_OFF=strings`): `cpLen` reading its units through
 * `all()`, `sub` and `copyFrom` out of line, and no `indexFrom` (compiler/rt's strIndexOf printed whole, emit-tsl.ts). Never
 * set otherwise.
 */
export function r25Off(part: string): boolean {
  return (process.env.TMK_R25_OFF ?? "").split(",").includes(part);
}

/** The string runtime's text: the two classes and the functions the printing calls in place of JsString's statics. */
export function rcStrRuntime(key: [string, string] | null, join3 = false): string[] {
  const off = r21UnitsOff();
  // the hash key (D42): the module's own two words where a native caller can set them, otherwise their first values
  const [k0, k1] = key !== null ? key : ["608135816", "-2052912941"];
  const appendCheck =
    fault() === "rcstr-append-shared"
      ? "at + lb <= wrapI32(ab.units.length)"
      : "at === ab.end && at + lb <= wrapI32(ab.units.length)";
  // R21: one unit is a checked store, not a copy's call
  const appendOne = off
    ? "ab.units.set(b.all(), toUsize(at));"
    : "if (lb === 1) ab.units[toUsize(at)] = wrapU16(b.unit(0));\n        else ab.units.set(b.all(), toUsize(at));";
  const prependOne = off
    ? "bb.units.set(this.all(), toUsize(h));"
    : "if (la === 1) bb.units[toUsize(h)] = wrapU16(this.unit(0));\n        else bb.units.set(this.all(), toUsize(h));";
  // R22: concatenation's short cases inlined where it's called (strConcat), and the rest out of line, so a short join no
  // longer goes through the long cases' frame (twelve registers saved and two spilled) to reach jsStrJoined
  const concatHead = `concat(b: JsStr): JsStr {`;
  // R22: a new buffer made out of line (jsStrGrown), so that concatenation's own frame is an append's or a prepend's
  const grownBody = `const ga = (a.hw & 2) !== 0;
  if (!ga && (b.hw & 2) === 0) return jsStrJoined(a, b, n);
  const cap = n >= 268435456 ? (n > 536870888 ? n : 536870888) : n * 2;
  const nb = withTail(toUsize(cap), new JsStrBuf());
  const at = ga ? 0 : cap - n;
  nb.units.set(a.all(), toUsize(at));
  nb.units.set(b.all(), toUsize(at + ${fault() === "r22-grown-offset" ? "b" : "a"}.n));
  nb.head = at;
  nb.end = at + n;
  return jsStrView(nb, at, n, 2);`;
  const grownTail = r22Off("concat")
    ? grownBody
        .replace("toUsize(at + a.n)", "toUsize(at + la)")
        .replace(/\ba\b(?=[.,)])/g, "this")
        .replace(/\n/g, "\n  ")
    : "return jsStrGrown(this, b, n);";
  const grownFn = r22Off("concat")
    ? ""
    : `/**
 * R22: \`a + b\` past 64 units where neither can be written in place: copied flat, or the second concatenation onto a string
 * one made, into a new buffer of twice the room. Out of line, as \`concat\`'s common way is an append in place.
 */
/** @tsl.noinline */
function jsStrGrown(a: JsStr, b: JsStr, n: i32): JsStr {
  ${grownBody}
}

`;
  // R24 (TMK_R24_OFF=strings puts these back as they were, for tools/r24-pins.ts)
  const r24 = !r24Off("strings");
  const jsStrCtor = r24
    ? `  // R24: a view's fields given to its constructor, whose stores to them give up nothing (a fresh object's fields hold
  // nothing yet), so a function that makes views can still hold borrowed strings without counting them (3.5's quiet rule)
  /** @tsl.inline */
  constructor(
    public n: i32,
    start: i32,
    buf: JsStrBuf | null,
    hw: i32,
  ) {
    this.start = start;
    this.buf = buf;
    this.hw = hw;
  }
`
    : "  constructor(public n: i32) {}\n";
  const unitBody = r24
    ? `// R24: n and start are never negative (every maker checks them), so each is its u32's bits, with no check of its own:
    // were one ever negative, the index past it would be huge, and the units' own bounds check would trap
    if (i >= toUsize(wrapU32(this.n))) trap(Trap.Bounds);
    const b = this.buf;
    if (b === null) return toI32(this.units[i]!);
    return toI32(b.units[toUsize(wrapU32(this.${fault() === "r24-unit-start" ? "n" : "start"})) + i]!);`
    : `if (i >= toUsize(this.n)) trap(Trap.Bounds);
    const b = this.buf;
    if (b === null) return toI32(this.units[i]!);
    return toI32(b.units[toUsize(this.start) + i]!);`;
  const viewBody = r24
    ? `return withTail(0, new JsStr(n, ${fault() === "r24-view-start" ? "start + 1" : "start"}, b, hw));`
    : `const r = withTail(0, new JsStr(n));
  r.start = start;
  r.buf = b;
  r.hw = hw;
  return r;`;
  // R25 (TMK_R25_OFF=strings puts these back as they were, for tools/r25-pins.ts)
  const r25 = !r25Off("strings");
  // R25: a code point's length read through \`unit\`, inlined, where \`all()\` worked out the units' run (a subarray's
  // clamps) on every call: for...of over a string calls it once a code point
  const cpLenText = r25
    ? `  /** @tsl.inline */
  cpLen(i: i32): i32 {
    const n = this.n;
    if (i < 0 || i >= n) trap(Trap.Bounds);
    const c = this.unit(toUsize(i));
    if (c < 0xd800 || c > 0xdbff || i + 1 >= n) return 1;
    const d = this.unit(toUsize(i + ${fault() === "r25-cplen-next" ? "2" : "1"}));
    return d >= 0xdc00 && d <= 0xdfff ? 2 : 1;
  }`
    : `  cpLen(i: i32): i32 {
    const n = this.n;
    if (i < 0 || i >= n) trap(Trap.Bounds);
    const u = this.all();
    const c = toI32(u[toUsize(i)]!);
    if (c < 0xd800 || c > 0xdbff || i + 1 >= n) return 1;
    const d = toI32(u[toUsize(i + 1)]!);
    return d >= 0xdc00 && d <= 0xdfff ? 2 : 1;
  }`;
  // R25: a substring's common ways (the whole, empty, one unit) inlined where it's taken, the copy and the view out of line
  const subHead = r25
    ? `  /** @tsl.inline */
  sub(i: i32, n: i32): JsStr {
    const len = this.n;
    if (i < 0 || n < 0 || i + n > len) trap(Trap.Bounds);
    if (n === len) return this;
    if (n === 0) return jsStrEmpty();
    if (n === 1) return jsStrOfUnit(this.unit(toUsize(i)));
    return this.subMade(i, n);
  }

  /** \`sub\`'s copy or view: n units from i, at least 2, within it and fewer than all of it. */
  /** @tsl.noinline */
  subMade(i: i32, n: i32): JsStr {`
    : `  sub(i: i32, n: i32): JsStr {
    const len = this.n;
    if (i < 0 || n < 0 || i + n > len) trap(Trap.Bounds);
    if (n === len) return this;
    if (n === 0) return jsStrEmpty();
    if (n === 1) return jsStrOfUnit(this.unit(toUsize(i)));`;
  // R25: a copy or a view read from the buffer's units straight, where it went through \`all()\`'s run, then a run of that
  const subBody = r25
    ? `    const b = this.buf;
    if (b !== null) {
      if (n >= 32 && n * 4 >= wrapI32(b.units.length)) return jsStrView(b, this.start + i, n, 0);
      const r = jsStrZeroed(n);
      const at = toUsize(this.start + i${fault() === "r25-sub-start" ? " + 1" : ""});
      r.units.set(b.units.subarray(at, at + toUsize(n)), 0);
      return r;
    }
    const r = jsStrZeroed(n);
    r.units.set(this.units.subarray(toUsize(i), toUsize(i + n)), 0);
    return r;`
    : `    const b = this.buf;
    if (b !== null && n >= 32 && n * 4 >= wrapI32(b.units.length))
      return jsStrView(b, this.start + i, n, 0);
    const r = jsStrZeroed(n);
    r.units.set(this.all().subarray(toUsize(i), toUsize(i + n)), 0);
    return r;`;
  // R25: inlined (a join copies each part and each separator), one unit a checked store, not a copy's call (as R21 made
  // an append of one), and a whole string its run, with no run of that
  const copyFromText = r25
    ? `  /** @tsl.inline */
  copyFrom(di: usize, s: JsStr, si: usize, n: usize): void {
    const sn = toUsize(s.n);
    if (si + n > sn) trap(Trap.Bounds);
    if (n === 1) {
      this.units[${fault() === "r25-copy-one" ? "di > 0 ? di - 1 : di" : "di"}] = wrapU16(s.unit(si));
      return;
    }
    const u = s.all();
    this.units.set(si === 0 && n === sn ? u : u.subarray(si, si + n), di);
  }`
    : `  copyFrom(di: usize, s: JsStr, si: usize, n: usize): void {
    if (si + n > toUsize(s.n)) trap(Trap.Bounds);
    this.units.set(s.all().subarray(si, si + n), di);
  }`;
  // R30: k copies of a string's units (compiler/rt's strRepeat, emit-tsl.ts's repeatBody): s's once, then what's written so
  // far copied after itself, doubling, each copy one checked run of units
  const repeatFromText = r30Off("copy")
    ? ""
    : `
  /**
   * k copies of s's units, from unit 0, into this string, made by jsStrZeroed and no one else's yet (R30): s's once, then
   * what's written copied after itself, so a long repeat is a few copies of many units.
   */
  repeatFrom(s: JsStr, k: usize): void {
    const m = toUsize(s.n);
    const all = m * k;
    if (all === 0) return;
    this.units.set(s.all(), 0);
    let done = m;
    while (done < all) {
      const n = done <= all - done ? done : all - done;
      this.units.set(this.units.subarray(0, ${fault() === "r30-repeat-short" ? "n - 1" : "n"}), done);
      done += n;
    }
  }
`;
  // R25: equality's quick answers (the same string, one missing, the lengths differ) inlined where it's asked, the units
  // compared out of line
  const eqText = r25
    ? `/** \`a === b\` for strings that may be \`undefined\` (null): the same units, or both missing. */
/** @tsl.inline */
function jsStrEq(a: JsStr | null, b: JsStr | null): bool {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.n !== b.n) return false;
  return jsStrSame(a, b);
}

/** Whether two strings of the same length have the same units. */
/** @tsl.noinline */
function jsStrSame(a: JsStr, b: JsStr): bool {
  const ua = a.all();
  const ub = b.all();
  const n = ua.length;
  if (ub.length !== n) return false;
  for (let i: usize = 0; i < n; i++) if (ua[i]! !== ub[${fault() === "r25-eq-shift" ? "i + 1 < n ? i + 1 : i" : "i"}]!) return false;
  return true;
}`
    : `/** \`a === b\` for strings that may be \`undefined\` (null): the same units, or both missing. */
function jsStrEq(a: JsStr | null, b: JsStr | null): bool {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const n = a.n;
  if (n !== b.n) return false;
  const ua = a.all();
  const ub = b.all();
  for (let i: usize = 0; i < toUsize(n); i++) if (ua[i]! !== ub[i]!) return false;
  return true;
}`;
  // R25: compiler/rt's strIndexOf past its empty pattern's case (emit-tsl.ts prints its body's rest as this call): the units
  // read as the two strings' runs, each read checked against its run's length, where the loop's own test proves the first
  const indexFromText = r25
    ? `  /** Where p's units are first found in this at or after \`from\`, or -1: compiler/rt's strIndexOf for a pattern not empty. */
  /** @tsl.inline */
  indexFrom(p: JsStr, from: i32): i32 {
    const us = this.all();
    const up = p.all();
    const n = us.length;
    const m = up.length;
    if (m === 0) return from;
    if (m > n) return -1;
    const last = n - m;
    const c0 = up[0]!;
    for (let i: usize = toUsize(from); i < n; i++) {
      if (i > last) break;
      if (us[i]! === c0) {
        let k: usize = 1;
        while (k < m && us[i + k]! === up[${fault() === "r25-index-match" ? "k - 1" : "k"}]!) k++;
        if (k === m) return toI32(i);
      }
    }
    return -1;
  }

`
    : "";
  // R30: one test of the length, as a u32, which a negative one fails as one too long does (the same trap), where the test
  // of each and toUsize's own of the sign were three; and the length a u32 from there on, so the size class's arithmetic is
  // known to stay small
  const zeroedBody = r30Off("zeroed")
    ? `if (n < 0 || n > 536870888) trap(Trap.OutOfMemory);
  return withTail(toUsize(n), new JsStr(${r24Off("strings") ? "n" : "n, 0, null, 0"}));`
    : `const u = wrapU32(n);
  if (u > 536870888) trap(Trap.OutOfMemory);
  return withTail(toUsize(u), new JsStr(${r24Off("strings") ? "n" : "n, 0, null, 0"}));`;
  const unitSlot = fault() === "rcstr-unit-low7" ? "u & 127" : "u";
  const unitLimit = fault() === "rcstr-unit-past" ? "<= 256" : "< 256";
  const unitLimitNot = fault() === "rcstr-unit-past" ? "> 256" : ">= 256";
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
${jsStrCtor}  units = tail(u16);

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
    ${unitBody}
  }

  /** Writes unit i of a string jsStrZeroed just made; a view has none of its own, so it traps. */
  /** @tsl.inline */
  put(i: usize, u: i32): void {
    this.units[i] = wrapU16(u);
  }

  /** Copies n units of s from si into this string, made by jsStrZeroed and no one else's yet, from di. */
${copyFromText}
${repeatFromText}
  /** Unit 0's address, where a native caller writes a string argument's units (4.5's ABI). */
  unitsAddr(): u64 {
    return toU64(cast<usize>(part<Ref>(this.all(), 0, 1)));
  }

  /** How many units the code point at i takes, 1 or 2; a lone surrogate is one. */
${cpLenText}

  /**
   * \`this + b\`, whose length the caller has checked is within JS's. Up to 64 units it copies; an append to a view that ends
   * where its buffer's used units end, or a prepend to one that starts where they start, writes in place where there's
   * room; the second concatenation onto a string made by one makes a buffer of twice the room. So \`s += x\` is linear.
   */
  ${concatHead}
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
        ${appendOne}
        ab.end = at + lb;
        return jsStrView(ab, this.start, n, 2);
      }
    }
    const bb = b.buf;
    if (bb !== null) {
      const head = b.start;
      if (head === bb.head && head >= la) {
        const h = head - la;
        ${prependOne}
        bb.head = h;
        return jsStrView(bb, h, n, 2);
      }
    }
    ${grownTail}
  }

  /** The n units from i, which are within it: shared with its buffer if they're at least 32 and a quarter of its room. */
${subHead}
${subBody}
  }

${indexFromText}  /** By code unit, as JS orders strings: negative, zero or positive. */
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
  ${zeroedBody}
}

/** \`""\`. */
function jsStrEmpty(): JsStr {
  const e = jsStrNone;
  if (e !== null) return e;
  const s = jsStrZeroed(0);
  jsStrNone = s;
  return s;
}

${grownFn}/** A view of n units of a buffer from start. */
function jsStrView(b: JsStrBuf, start: i32, n: i32, hw: i32): JsStr {
  ${viewBody}
}

/** a's units then b's, n in all, copied into a flat string made by concatenation. */
function jsStrJoined(a: JsStr, b: JsStr, n: i32): JsStr {
  const r = jsStrZeroed(n);
  r.units.set(a.all(), 0);
  r.units.set(b.all(), toUsize(a.n));
  r.hw = 2;
  return r;
}

${
  join3
    ? `/**
 * R22: a, b and c's units, n in all, copied into one flat string made by concatenation: \`a + b + c\` made once where
 * it's short (the printing's strConcat3), each part's units copied once.
 */
function jsStrJoined3(a: JsStr, b: JsStr, c: JsStr, n: i32): JsStr {
  const r = jsStrZeroed(n);
  const la = toUsize(a.n);
  r.units.set(a.all(), 0);
  r.units.set(b.all(), la);
  r.units.set(c.all(), la + toUsize(b.n));
  r.hw = 2;
  return r;
}

`
    : ""
}/** A literal from its UTF-8 bytes: the text as JS has it, for every literal that's well-formed UTF-16. */
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

${
  off
    ? UNITS_BEFORE
    : `/**
 * The one-unit strings below 256 (R21), as the direct route's static table and @tsl/jsrt's hold them: each made the first
 * time it's asked for, then kept by the table from then on. A holder of the program's own, counted as an array's is (R2,
 * R3), its 256 slots its tail, so reading one is \`JsRoomArray.get\`'s checked read.
 */
class JsStrUnits {
  v: JsRoomArray<JsStr | null>;
  room = tail(u64);

  constructor() {
    this.v = new JsRoomArray(ref<JsStr | null>(), 256, true);
  }
}

/** The table, made with its first string. */
let jsStrUnits: JsStrUnits | null = null;

/**
 * The string of one unit: below 256 the table's, else a new one. Inlined: the table's hit is a checked read and the
 * string's count; anything else is \`jsStrUnitMade\`'s, out of line.
 */
/** @tsl.inline */
function jsStrOfUnit(u: i32): JsStr {
  if (u >= 0 && u ${unitLimit} && jsStrUnits !== null) {
    const s = jsStrUnits.v.get(toUsize(${unitSlot}));
    if (s !== null) return s;
  }
  return jsStrUnitMade(u);
}

/**
 * The string of unit u that the table hasn't got: below 256 made and kept by the table (and the table made, the first
 * time), else made. Out of line.
 */
/** @tsl.noinline */
function jsStrUnitMade(u: i32): JsStr {
  const s = jsStrZeroed(1);
  s.put(0, u);
  if (u < 0 || u ${unitLimitNot}) return s;
  let t = jsStrUnits;
  if (t === null) {
    const nt: JsStrUnits = withTail(256, new JsStrUnits());
    nt.v.attach(nt, 256);
    jsStrUnits = nt;
    t = nt;
  }
  t.v.set(toUsize(${unitSlot}), s);
  return s;
}

`
}/**
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

${eqText}`.split("\n");
}
