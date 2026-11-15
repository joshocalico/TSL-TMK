// Run-time strings (SPEC 3.5, 4.5, D42), in ordinary TS, lowered by down.ts into the module that reaches them.
//
// A string is immutable UTF-16, one pointer: [len: u32][hash: u32][off: i64][...], with its units at `s + off`.
//  - flat:   off = 16, units inline. Every literal is one, in static data with a count that never reaches zero.
//  - view:   [owner: ptr @16][start: u32 @24], units in the owner's memory. A substring, or a concat into a buffer.
//  - buffer: never a value: [tail: u32][cap: u32][off = 24][head: u32 @16], the owner of views made by concatenation.
// Appending to a view that ends at its buffer's tail writes in place, and old views can't see past their own length, so
// `s += x` in a loop is linear, with no flattening, and every read is one add and one load.
import {
  __f_trunc,
  __fault,
  __hash_k,
  __s_alloc,
  __s_char,
  __s_copy,
  __s_get,
  __s_len,
  __s_null,
  __s_owner,
  __s_put,
  __s_same,
  __s_set,
  __s_unit,
  __s_view,
} from "./intrinsics.ts";

const FLAT_HDR = 16;
const BUF_HDR = 24;
const W_HASH = 4; // bit 0: the hash is known; bit 1: made by concatenation
const W_OFF = 8;
const W_HEAD = 16; // a buffer's first used unit
const W_START = 24; // a view's first unit, in its owner
const MAX_LEN = 536870888; // V8's limit, above which it throws RangeError
const SHARE_MIN = 32; // shorter than this, a substring copies
const CONCAT_FLAT_MAX = 64; // this short, concatenation always copies

function isView(s: string): boolean {
  return __s_get(s, W_OFF) !== FLAT_HDR;
}

function isBuffer(owner: string): boolean {
  return __s_get(owner, W_OFF) === BUF_HDR;
}

function newFlat(n: number): string {
  return __s_alloc(FLAT_HDR, n);
}

export function strChar(u: number): string {
  if (u < 256) return __s_char(u);
  const r = newFlat(1);
  __s_put(r, 0, u);
  return r;
}

export function strConcat(a: string, b: string): string {
  const la = __s_len(a);
  const lb = __s_len(b);
  if (la === 0) return b;
  if (lb === 0) return a;
  const n = (la + lb) | 0;
  if (n > MAX_LEN || n < 0) throw new RangeError("Invalid string length");
  if (n <= CONCAT_FLAT_MAX) return concatFlat(a, b, la, lb, n);
  if (isView(a)) {
    const buf = __s_owner(a);
    if (isBuffer(buf)) {
      const start = __s_get(a, W_START);
      const end = (start + la) | 0;
      if (
        (end === __s_len(buf) || __fault("append-anywhere")) &&
        ((end + lb) | 0) <= __s_get(buf, W_HASH)
      ) {
        __s_copy(buf, end, b, 0, lb);
        __s_set(buf, 0, (end + lb) | 0);
        return grownView(buf, start, n);
      }
    }
  }
  if (isView(b)) {
    const buf = __s_owner(b);
    if (isBuffer(buf)) {
      const start = __s_get(b, W_START);
      if (start === __s_get(buf, W_HEAD) && start >= la) {
        const head = (start - la) | 0;
        __s_copy(buf, head, a, 0, la);
        __s_set(buf, W_HEAD, head);
        return grownView(buf, head, n);
      }
    }
  }
  const grownA = (__s_get(a, W_HASH) & 2) !== 0;
  const grownB = (__s_get(b, W_HASH) & 2) !== 0;
  if (!grownA && !grownB) return concatFlat(a, b, la, lb, n);
  // The second append to the same string: from here on it pays to have room. Doubling makes it linear in all.
  const cap = n >= 268435456 ? MAX_LEN : (n * 2) | 0;
  const buf = __s_alloc(BUF_HDR, cap);
  __s_set(buf, W_HASH, cap);
  const at = grownA ? 0 : (cap - n) | 0;
  __s_copy(buf, at, a, 0, la);
  __s_copy(buf, (at + la) | 0, b, 0, lb);
  __s_set(buf, W_HEAD, at);
  __s_set(buf, 0, (at + n) | 0);
  return grownView(buf, at, n);
}

function grownView(buf: string, at: number, n: number): string {
  const r = __s_view(buf, at, n);
  __s_set(r, W_HASH, 2);
  return r;
}

function concatFlat(a: string, b: string, la: number, lb: number, n: number): string {
  const r = newFlat(n);
  __s_copy(r, 0, a, 0, la);
  __s_copy(r, la, b, 0, lb);
  __s_set(r, W_HASH, 2);
  return r;
}

/** s[i .. i + n), with i and n known good. A view keeps its owner alive, so only one at least a quarter of it may share. */
export function strSub(s: string, i: number, n: number): string {
  const len = __s_len(s);
  if (n === len) return s;
  if (n === 0) return "";
  if (n === 1) return strChar(__s_unit(s, i));
  if (n >= SHARE_MIN) {
    if (isView(s)) {
      const owner = __s_owner(s);
      const cap = isBuffer(owner) ? __s_get(owner, W_HASH) : __s_len(owner);
      if (n >= cap / 4) return __s_view(owner, (__s_get(s, W_START) + i) | 0, n);
    } else if (n >= len / 4) return __s_view(s, i, n);
  }
  const r = newFlat(n);
  __s_copy(r, 0, s, i, n);
  return r;
}

// --- comparison, and the hash (HalfSipHash-1-3, from the SipHash paper's description)

export function strEq(a: string, b: string): boolean {
  if (__s_same(a, b)) return true;
  if (__s_null(a) || __s_null(b)) return false;
  const n = __s_len(a);
  if (n !== __s_len(b)) return false;
  const ha = __s_get(a, W_HASH);
  const hb = __s_get(b, W_HASH);
  if ((ha & hb & 1) !== 0 && (ha | 3) !== (hb | 3)) return false;
  for (let i = 0; i < n; i = (i + 1) | 0) {
    if (__s_unit(a, i) !== __s_unit(b, i)) return false;
  }
  return true;
}

/** By code unit, as JS orders strings: negative, zero or positive. */
export function strCmp(a: string, b: string): number {
  const la = __s_len(a);
  const lb = __s_len(b);
  const n = la < lb ? la : lb;
  for (let i = 0; i < n; i = (i + 1) | 0) {
    const d = (__s_unit(a, i) - __s_unit(b, i)) | 0;
    if (d !== 0) return d;
  }
  return (la - lb) | 0;
}

export function strHash(s: string): number {
  const w = __s_get(s, W_HASH);
  if ((w & 1) !== 0) return w >>> 2;
  const n = __s_len(s);
  let v0 = __hash_k(0);
  let v1 = __hash_k(1);
  let v2 = 0x6c796765 ^ v0;
  let v3 = 0x74656462 ^ v1;
  let i = 0;
  while (((i + 2) | 0) <= n) {
    const m = __s_unit(s, i) | (__s_unit(s, (i + 1) | 0) << 16);
    v3 = v3 ^ m;
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
    v0 = v0 ^ m;
    i = (i + 2) | 0;
  }
  const last = (n << 25) | (i < n ? __s_unit(s, i) : 0);
  v3 = v3 ^ last;
  for (let r = 0; r < 4; r = (r + 1) | 0) {
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
    if (r === 0) {
      v0 = v0 ^ last;
      v2 = v2 ^ 0xff;
    }
  }
  const h = (v1 ^ v3) & 0x3fffffff;
  __s_set(s, W_HASH, (h << 2) | (w & 2) | 1);
  return h;
}

// --- indexing, by JS's conversions

/** ToIntegerOrInfinity, then relative to the end if it's negative, within [0, len]. */
function relIndex(x: number, len: number): number {
  if (x !== x) return 0;
  const t = __f_trunc(x);
  if (t < 0) {
    const r = t + len;
    return r < 0 ? 0 : r | 0;
  }
  return t > len ? len : t | 0;
}

/** ToIntegerOrInfinity, then within [0, len]. */
function absIndex(x: number, len: number): number {
  if (x !== x) return 0;
  const t = __f_trunc(x);
  if (t < 0) return 0;
  return t > len ? len : t | 0;
}

export function strCharCodeAt(s: string, x: number): number {
  if (x !== x) return __s_len(s) > 0 ? __s_unit(s, 0) : NaN;
  const t = __f_trunc(x);
  if (t < 0 || t >= __s_len(s)) return NaN;
  return __s_unit(s, t | 0);
}

export function strCharAt(s: string, x: number): string {
  if (x !== x) return __s_len(s) > 0 ? strChar(__s_unit(s, 0)) : "";
  const t = __f_trunc(x);
  if (t < 0 || t >= __s_len(s)) return "";
  return strChar(__s_unit(s, t | 0));
}

export function strIndex(s: string, x: number): string | undefined {
  if (!(x >= 0) || x >= __s_len(s) || __f_trunc(x) !== x) return undefined;
  return strChar(__s_unit(s, x | 0));
}

export function strAt(s: string, x: number): string | undefined {
  const n = __s_len(s);
  const t = x !== x ? 0 : __f_trunc(x);
  const k = t < 0 ? t + n : t;
  if (k < 0 || k >= n) return undefined;
  return strChar(__s_unit(s, k | 0));
}

export function strCodePointAt(s: string, x: number): number | undefined {
  const n = __s_len(s);
  const t = x !== x ? 0 : __f_trunc(x);
  if (t < 0 || t >= n) return undefined;
  const i = t | 0;
  const c = __s_unit(s, i);
  if (c < 0xd800 || c > 0xdbff || ((i + 1) | 0) === n) return c;
  const d = __s_unit(s, (i + 1) | 0);
  if (d < 0xdc00 || d > 0xdfff) return c;
  return (((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000) | 0;
}

/** How many units the code point at i takes: for...of on a string goes by these. */
export function strCpLen(s: string, i: number): number {
  const c = __s_unit(s, i);
  if (c < 0xd800 || c > 0xdbff || ((i + 1) | 0) >= __s_len(s)) return 1;
  const d = __s_unit(s, (i + 1) | 0);
  return d >= 0xdc00 && d <= 0xdfff ? 2 : 1;
}

export function strSlice(s: string, a: number | undefined, b: number | undefined): string {
  const n = __s_len(s);
  const from = a === undefined ? 0 : relIndex(a, n);
  const to = b === undefined ? n : relIndex(b, n);
  return from >= to ? "" : strSub(s, from, (to - from) | 0);
}

export function strSubstring(s: string, a: number | undefined, b: number | undefined): string {
  const n = __s_len(s);
  const x = a === undefined ? 0 : absIndex(a, n);
  const y = b === undefined ? n : absIndex(b, n);
  const from = x < y ? x : y;
  const to = x < y ? y : x;
  return strSub(s, from, (to - from) | 0);
}

// --- searching

function matchAt(s: string, p: string, i: number, m: number): boolean {
  for (let k = 0; k < m; k = (k + 1) | 0) {
    if (__s_unit(s, (i + k) | 0) !== __s_unit(p, k)) return false;
  }
  return true;
}

export function strIndexOf(s: string, p: string, from: number | undefined): number {
  const n = __s_len(s);
  const m = __s_len(p);
  const start = from === undefined ? 0 : absIndex(from, n);
  if (m === 0) return start;
  const last = (n - m) | 0;
  const c0 = __s_unit(p, 0);
  for (let i = start; i <= last; i = (i + 1) | 0) {
    if (__s_unit(s, i) === c0 && matchAt(s, p, i, m)) return i;
  }
  return -1;
}

export function strLastIndexOf(s: string, p: string, from: number | undefined): number {
  const n = __s_len(s);
  const m = __s_len(p);
  const limit = from === undefined || from !== from ? n : absIndex(from, n);
  const top = (n - m) | 0;
  for (let i = limit < top ? limit : top; i >= 0; i = (i - 1) | 0) {
    if (matchAt(s, p, i, m)) return i;
  }
  return -1;
}

export function strIncludes(s: string, p: string, from: number | undefined): boolean {
  return strIndexOf(s, p, from) >= 0;
}

export function strStartsWith(s: string, p: string, pos: number | undefined): boolean {
  const n = __s_len(s);
  const m = __s_len(p);
  const at = pos === undefined ? 0 : absIndex(pos, n);
  return ((at + m) | 0) <= n && matchAt(s, p, at, m);
}

export function strEndsWith(s: string, p: string, end: number | undefined): boolean {
  const n = __s_len(s);
  const m = __s_len(p);
  const e = end === undefined ? n : absIndex(end, n);
  const at = (e - m) | 0;
  return at >= 0 && matchAt(s, p, at, m);
}

export function strSplit(s: string, sep: string | undefined, limit: number | undefined): string[] {
  const out: string[] = [];
  const lim = limit === undefined ? 4294967295 : limit >>> 0;
  if (lim === 0) return out;
  if (sep === undefined) {
    out.push(s);
    return out;
  }
  const n = __s_len(s);
  const m = __s_len(sep);
  if (m === 0) {
    for (let i = 0; i < n && i < lim; i = (i + 1) | 0) out.push(strChar(__s_unit(s, i)));
    return out;
  }
  let from = 0;
  for (;;) {
    const at = strIndexOf(s, sep, from);
    if (at < 0) break;
    out.push(strSub(s, from, (at - from) | 0));
    if (out.length >= lim) return out;
    from = (at + m) | 0;
  }
  out.push(strSub(s, from, (n - from) | 0));
  return out;
}

// --- whitespace, as JS's WhiteSpace and LineTerminator: a short list, with no tables

export function isSpace(c: number): boolean {
  if (c < 128) return c === 32 || (c >= 9 && c <= 13);
  if (c < 0x1680) return c === 0xa0;
  if (c >= 0x2000 && c <= 0x200a) return true;
  return (
    c === 0x1680 ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

export function strTrim(s: string): string {
  return strTrimStart(strTrimEnd(s));
}

export function strTrimStart(s: string): string {
  const n = __s_len(s);
  let i = 0;
  while (i < n && isSpace(__s_unit(s, i))) i = (i + 1) | 0;
  return strSub(s, i, (n - i) | 0);
}

export function strTrimEnd(s: string): string {
  let n = __s_len(s);
  while (n > 0 && isSpace(__s_unit(s, (n - 1) | 0))) n = (n - 1) | 0;
  return strSub(s, 0, n);
}

export function strRepeat(s: string, x: number): string {
  const t = x !== x ? 0 : __f_trunc(x);
  if (t < 0 || t === Infinity) throw new RangeError(`Invalid count value: ${x}`);
  const m = __s_len(s);
  if (t === 0 || m === 0) return "";
  if (t * m > MAX_LEN) throw new RangeError("Invalid string length");
  const k = t | 0;
  const r = newFlat((k * m) | 0);
  for (let i = 0; i < k; i = (i + 1) | 0) strCopy(r, (i * m) | 0, s, m);
  return r;
}

function strCopy(r: string, at: number, s: string, n: number): void {
  for (let i = 0; i < n; i = (i + 1) | 0) __s_put(r, (at + i) | 0, __s_unit(s, i));
}

function strPad(s: string, x: number, fill: string, atStart: boolean): string {
  const n = __s_len(s);
  const t = x !== x ? 0 : __f_trunc(x);
  const m = __s_len(fill);
  if (t <= n || m === 0) return s;
  if (t > MAX_LEN) throw new RangeError("Invalid string length");
  const total = t | 0;
  const r = newFlat(total);
  const pad = (total - n) | 0;
  const at = atStart ? 0 : n;
  for (let i = 0; i < pad; i = (i + 1) | 0) {
    __s_put(r, (at + i) | 0, __s_unit(fill, i % m));
  }
  strCopy(r, atStart ? pad : 0, s, n);
  return r;
}

export function strPadStart(s: string, x: number, fill: string | undefined): string {
  return strPad(s, x, fill === undefined ? " " : fill, true);
}

export function strPadEnd(s: string, x: number, fill: string | undefined): string {
  return strPad(s, x, fill === undefined ? " " : fill, false);
}

/** What `replace` puts in, by GetSubstitution with no captures: $$, $&, $` and $'. */
function replacement(s: string, at: number, m: number, r: string): string {
  const n = __s_len(r);
  let i = 0;
  while (i < n && __s_unit(r, i) !== 36) i = (i + 1) | 0;
  if (i === n) return r;
  let out = strSub(r, 0, i);
  while (i < n) {
    const c = __s_unit(r, i);
    if (c === 36 && ((i + 1) | 0) < n) {
      const d = __s_unit(r, (i + 1) | 0);
      if (d === 36) {
        out = strConcat(out, "$");
        i = (i + 2) | 0;
        continue;
      }
      if (d === 38) {
        out = strConcat(out, strSub(s, at, m));
        i = (i + 2) | 0;
        continue;
      }
      if (d === 96) {
        out = strConcat(out, strSub(s, 0, at));
        i = (i + 2) | 0;
        continue;
      }
      if (d === 39) {
        const after = (at + m) | 0;
        out = strConcat(out, strSub(s, after, (__s_len(s) - after) | 0));
        i = (i + 2) | 0;
        continue;
      }
    }
    out = strConcat(out, strChar(c));
    i = (i + 1) | 0;
  }
  return out;
}

export function strReplace(s: string, p: string, r: string): string {
  const at = strIndexOf(s, p, 0);
  if (at < 0) return s;
  const m = __s_len(p);
  const after = (at + m) | 0;
  return strConcat(
    strConcat(strSub(s, 0, at), replacement(s, at, m, r)),
    strSub(s, after, (__s_len(s) - after) | 0),
  );
}

export function strReplaceAll(s: string, p: string, r: string): string {
  const m = __s_len(p);
  const step = m > 0 ? m : 1;
  const n = __s_len(s);
  let out = "";
  let end = 0;
  let at = strIndexOf(s, p, 0);
  while (at >= 0) {
    out = strConcat(strConcat(out, strSub(s, end, (at - end) | 0)), replacement(s, at, m, r));
    end = (at + m) | 0;
    if (((at + step) | 0) > n) break;
    at = strIndexOf(s, p, (at + step) | 0);
  }
  return end < n ? strConcat(out, strSub(s, end, (n - end) | 0)) : out;
}

export function strFromCode(x: number): string {
  return strChar((x >>> 0) & 0xffff);
}

export function strFromCodePoint(x: number): string {
  if (!(x >= 0 && x <= 0x10ffff) || __f_trunc(x) !== x)
    throw new RangeError(`Invalid code point ${x}`);
  const c = x | 0;
  if (c < 0x10000) return strChar(c);
  const r = newFlat(2);
  const d = (c - 0x10000) | 0;
  __s_put(r, 0, (0xd800 + (d >> 10)) | 0);
  __s_put(r, 1, (0xdc00 + (d & 1023)) | 0);
  return r;
}

export function boolStr(b: boolean): string {
  return b ? "true" : "false";
}

// --- ASCII case: anything else needs Unicode's tables (see case-tables.ts, reached only when input isn't ASCII)

export function asciiOnly(s: string): boolean {
  const n = __s_len(s);
  for (let i = 0; i < n; i = (i + 1) | 0) if (__s_unit(s, i) >= 128) return false;
  return true;
}
