// Numbers to strings and back (SPEC 3.10, 4.5, D42), in ordinary TS, lowered by down.ts. Exact everywhere, with integers:
//  - Number to string is free-format printing as in Burger and Dybvig, "Printing Floating-Point Numbers Quickly and
//    Accurately" (PLDI 1996), which is Steele and White's method with a better start. It's shortest, and closest among the
//    shortest, as ECMAScript's Number::toString asks. What V8 does when its Grisu3 gives up is this same algorithm, and
//    Grisu3 only answers when its answer is provably this one.
//  - String to number takes a close estimate and corrects it by comparing exactly against the midpoints of neighbouring
//    doubles, as Clinger's AlgorithmR does ("How to Read Floating Point Numbers Accurately", PLDI 1990).
//  - numToRadix and strParseInt's other radices follow V8's own conversions.cc (BSD-3-Clause, see THIRD_PARTY), since
//    ECMAScript leaves those digits to the implementation.
// A bignum is an Int32Array on the stack: its length in limbs at [0], then little-endian limbs of 24 bits.
import {
  __f64_hi,
  __f64_lo,
  __f64_make,
  __f_ceil,
  __f_floor,
  __f64,
  __trap,
  Trap,
  __f_trunc,
  __s_alloc,
  __s_len,
  __s_put,
  __s_unit,
} from "./intrinsics.ts";
import { isSpace } from "./str.ts";
const LIMB = 16777216;
const MASK = 16777215;

function bigSet(a: Int32Array, hi: number, lo: number): void {
  // hi * 2^32 + lo, with hi below 2^21 and lo an unsigned 32-bit value held in an i32.
  const l0 = lo & MASK;
  const l1 = ((lo >>> 24) | (hi << 8)) & MASK;
  const l2 = (hi >>> 16) & MASK;
  a[1] = l0;
  a[2] = l1;
  a[3] = l2;
  a[0] = l2 !== 0 ? 3 : l1 !== 0 ? 2 : l0 !== 0 ? 1 : 0;
}

function bigSetSmall(a: Int32Array, v: number): void {
  a[1] = v;
  a[0] = v !== 0 ? 1 : 0;
}

function bigCopy(d: Int32Array, s: Int32Array): void {
  const n = s[0]!;
  for (let i = 0; i <= n; i = (i + 1) | 0) d[i] = s[i]!;
}

/** Multiplies by m, below 128. */
function bigMul(a: Int32Array, m: number): void {
  const n = a[0]!;
  let carry = 0;
  for (let i = 1; i <= n; i = (i + 1) | 0) {
    const x = (a[i]! * m + carry) | 0;
    a[i] = x & MASK;
    carry = x >>> 24;
  }
  if (carry !== 0) {
    a[(n + 1) | 0] = carry;
    a[0] = (n + 1) | 0;
  }
}

function bigPow10(a: Int32Array, k: number): void {
  let left = k;
  while (left >= 2) {
    bigMul(a, 100);
    left = (left - 2) | 0;
  }
  if (left === 1) bigMul(a, 10);
}

function bigShl(a: Int32Array, bits: number): void {
  const n = a[0]!;
  if (n === 0) return;
  const words = (bits / 24) | 0;
  const rest = (bits - words * 24) | 0;
  let top = (n + words) | 0;
  if (rest === 0) {
    for (let i = n; i >= 1; i = (i - 1) | 0) a[(i + words) | 0] = a[i]!;
  } else {
    const over = a[n]! >>> (24 - rest);
    if (over !== 0) {
      top = (top + 1) | 0;
      a[top] = over;
    }
    for (let i = n; i >= 2; i = (i - 1) | 0) {
      a[(i + words) | 0] = ((a[i]! << rest) | (a[(i - 1) | 0]! >>> (24 - rest))) & MASK;
    }
    a[(1 + words) | 0] = (a[1]! << rest) & MASK;
  }
  for (let i = 1; i <= words; i = (i + 1) | 0) a[i] = 0;
  a[0] = top;
}

function bigCmp(a: Int32Array, b: Int32Array): number {
  const n = a[0]!;
  const m = b[0]!;
  if (n !== m) return n < m ? -1 : 1;
  for (let i = n; i >= 1; i = (i - 1) | 0) {
    const x = a[i]!;
    const y = b[i]!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** a + b against c, with no temporary: the top limbs usually decide it. */
function bigPlusCmp(a: Int32Array, b: Int32Array, c: Int32Array, t: Int32Array): number {
  bigCopy(t, a);
  bigAdd(t, b);
  return bigCmp(t, c);
}

function bigAdd(a: Int32Array, b: Int32Array): void {
  const n = a[0]!;
  const m = b[0]!;
  const top = n > m ? n : m;
  let carry = 0;
  for (let i = 1; i <= top; i = (i + 1) | 0) {
    const x = ((i <= n ? a[i]! : 0) + (i <= m ? b[i]! : 0) + carry) | 0;
    a[i] = x & MASK;
    carry = x >>> 24;
  }
  if (carry !== 0) {
    a[(top + 1) | 0] = carry;
    a[0] = (top + 1) | 0;
  } else a[0] = top;
}

/** a - b, with a >= b. */
function bigSub(a: Int32Array, b: Int32Array): void {
  const n = a[0]!;
  const m = b[0]!;
  let borrow = 0;
  for (let i = 1; i <= n; i = (i + 1) | 0) {
    let x = (a[i]! - (i <= m ? b[i]! : 0) - borrow) | 0;
    if (x < 0) {
      x = (x + LIMB) | 0;
      borrow = 1;
    } else borrow = 0;
    a[i] = x;
  }
  let top = n;
  while (top > 0 && a[top] === 0) top = (top - 1) | 0;
  a[0] = top;
}

function digitsToString(neg: boolean, buf: Int32Array, nd: number, n: number): string {
  // ECMAScript's Number::toString, with k = nd digits and the point after n of them.
  let len = neg ? 1 : 0;
  const expForm = !(n >= -5 && n <= 21);
  const e = (n - 1) | 0;
  const ae = e < 0 ? -e | 0 : e;
  const edigits = ae >= 100 ? 3 : ae >= 10 ? 2 : 1;
  if (!expForm) {
    if (nd <= n) len = (len + n) | 0;
    else if (n > 0) len = (len + nd + 1) | 0;
    else len = (len + 2 - n + nd) | 0;
  } else {
    len = (len + nd + (nd > 1 ? 1 : 0) + 2 + edigits) | 0;
  }
  const r = __s_alloc(16, len);
  let at = 0;
  if (neg) {
    __s_put(r, 0, 45);
    at = 1;
  }
  if (!expForm) {
    if (nd <= n) {
      for (let i = 0; i < nd; i = (i + 1) | 0) {
        __s_put(r, at, (48 + buf[i]!) | 0);
        at = (at + 1) | 0;
      }
      for (let i = nd; i < n; i = (i + 1) | 0) {
        __s_put(r, at, 48);
        at = (at + 1) | 0;
      }
    } else if (n > 0) {
      for (let i = 0; i < nd; i = (i + 1) | 0) {
        if (i === n) {
          __s_put(r, at, 46);
          at = (at + 1) | 0;
        }
        __s_put(r, at, (48 + buf[i]!) | 0);
        at = (at + 1) | 0;
      }
    } else {
      __s_put(r, at, 48);
      __s_put(r, (at + 1) | 0, 46);
      at = (at + 2) | 0;
      for (let i = n; i < 0; i = (i + 1) | 0) {
        __s_put(r, at, 48);
        at = (at + 1) | 0;
      }
      for (let i = 0; i < nd; i = (i + 1) | 0) {
        __s_put(r, at, (48 + buf[i]!) | 0);
        at = (at + 1) | 0;
      }
    }
    return r;
  }
  __s_put(r, at, (48 + buf[0]!) | 0);
  at = (at + 1) | 0;
  if (nd > 1) {
    __s_put(r, at, 46);
    at = (at + 1) | 0;
    for (let i = 1; i < nd; i = (i + 1) | 0) {
      __s_put(r, at, (48 + buf[i]!) | 0);
      at = (at + 1) | 0;
    }
  }
  __s_put(r, at, 101);
  __s_put(r, (at + 1) | 0, e < 0 ? 45 : 43);
  at = (at + 2) | 0;
  let div = edigits === 3 ? 100 : edigits === 2 ? 10 : 1;
  let rest = ae;
  while (div > 0) {
    __s_put(r, at, (48 + ((rest / div) | 0)) | 0);
    rest = (rest % div) | 0;
    div = (div / 10) | 0;
    at = (at + 1) | 0;
  }
  return r;
}

export function i32Str(x: number): string {
  if (x === 0) return "0";
  const buf = new Int32Array(12);
  const neg = x < 0;
  // By the negative side, which holds every i32.
  let v = neg ? x : -x | 0;
  let i = 12;
  while (v !== 0) {
    i = (i - 1) | 0;
    buf[i] = -(v % 10) | 0;
    v = (v / 10) | 0;
  }
  const nd = (12 - i) | 0;
  const r = __s_alloc(16, neg ? (nd + 1) | 0 : nd);
  let at = 0;
  if (neg) {
    __s_put(r, 0, 45);
    at = 1;
  }
  for (let k = i; k < 12; k = (k + 1) | 0) {
    __s_put(r, at, (48 + buf[k]!) | 0);
    at = (at + 1) | 0;
  }
  return r;
}

/** An integer value below 2^53: every digit counts, in two parts an i32 can hold. */
function intStr(neg: boolean, x: number): string {
  const buf = new Int32Array(24);
  const hi = __f_floor(x / 1000000000);
  let lo = (x - hi * 1000000000) | 0;
  let h = hi | 0; // hi is below 2^53 / 1e9, about 9 million
  let i = 24;
  let parts = h !== 0 ? 9 : 0;
  while (lo !== 0 || parts > 0) {
    i = (i - 1) | 0;
    buf[i] = (lo % 10) | 0;
    lo = (lo / 10) | 0;
    if (parts > 0) parts = (parts - 1) | 0;
    if (lo === 0 && parts === 0) break;
  }
  while (h !== 0) {
    i = (i - 1) | 0;
    buf[i] = (h % 10) | 0;
    h = (h / 10) | 0;
  }
  const nd = (24 - i) | 0;
  const r = __s_alloc(16, neg ? (nd + 1) | 0 : nd);
  let at = 0;
  if (neg) {
    __s_put(r, 0, 45);
    at = 1;
  }
  for (let k = i; k < 24; k = (k + 1) | 0) {
    __s_put(r, at, (48 + buf[k]!) | 0);
    at = (at + 1) | 0;
  }
  return r;
}

export function numStr(x: number): string {
  if (x !== x) return "NaN";
  if (x === 0) return "0";
  if (x === Infinity) return "Infinity";
  if (x === -Infinity) return "-Infinity";
  const neg = x < 0;
  const a = neg ? -x : x;
  if (a < 9007199254740992 && __f_floor(a) === a) return intStr(neg, a);
  return shortest(neg, a);
}

/** Free-format printing, by exact integers. a is positive and finite. */
function shortest(neg: boolean, a: number): string {
  const hi = __f64_hi(a);
  const lo = __f64_lo(a);
  const be = (hi >>> 20) & 2047;
  const fhi = hi & 1048575;
  const f1 = be === 0 ? fhi : fhi | 1048576;
  const e = be === 0 ? -1074 : (be - 1075) | 0;
  const even = (lo & 1) === 0;
  const lowerClose = be > 1 && fhi === 0 && lo === 0; // a power of two: the gap below is half the gap above
  const r = new Int32Array(56);
  const s = new Int32Array(56);
  const mp = new Int32Array(56);
  const mm = new Int32Array(56);
  const t = new Int32Array(56);
  bigSet(r, f1, lo);
  bigSetSmall(s, 1);
  bigSetSmall(mp, 1);
  bigSetSmall(mm, 1);
  if (e >= 0) {
    bigShl(mp, e);
    bigShl(mm, e);
    bigShl(r, (e + 1) | 0);
    bigShl(s, 1);
  } else {
    bigShl(r, 1);
    bigShl(s, (1 - e) | 0);
  }
  if (lowerClose) {
    bigShl(mp, 1);
    bigShl(r, 1);
    bigShl(s, 1);
  }
  // k: where the first digit is. A low estimate of log10, off by at most one, which the test below settles.
  const bitlen = be === 0 ? bitsOf(f1, lo) : 53;
  let k = __f_ceil(((e + bitlen - 1) | 0) * 0.30102999566398114 - 1e-10) | 0;
  if (k >= 0) bigPow10(s, k);
  else {
    const up = -k | 0;
    bigPow10(r, up);
    bigPow10(mp, up);
    bigPow10(mm, up);
  }
  const hiCmp = bigPlusCmp(r, mp, s, t);
  if (even ? hiCmp >= 0 : hiCmp > 0) k = (k + 1) | 0;
  else {
    bigMul(r, 10);
    bigMul(mp, 10);
    bigMul(mm, 10);
  }
  const buf = new Int32Array(24);
  let nd = 0;
  for (;;) {
    let d = 0;
    while (bigCmp(r, s) >= 0) {
      bigSub(r, s);
      d = (d + 1) | 0;
    }
    const low = bigCmp(r, mm);
    const high = bigPlusCmp(r, mp, s, t);
    const tc1 = even ? low <= 0 : low < 0;
    const tc2 = even ? high >= 0 : high > 0;
    if (!tc1 && !tc2) {
      buf[nd] = d;
      nd = (nd + 1) | 0;
      bigMul(r, 10);
      bigMul(mp, 10);
      bigMul(mm, 10);
      continue;
    }
    let up = tc2 && !tc1;
    if (tc1 && tc2) {
      const c = bigPlusCmp(r, r, s, t);
      up = c > 0 || (c === 0 && (d & 1) !== 0);
    }
    buf[nd] = up ? (d + 1) | 0 : d;
    nd = (nd + 1) | 0;
    break;
  }
  return digitsToString(neg, buf, nd, k);
}

function bitsOf(hi: number, lo: number): number {
  let n = 0;
  let w = hi !== 0 ? hi : lo;
  while (w !== 0) {
    n = (n + 1) | 0;
    w = w >>> 1;
  }
  return hi !== 0 ? (n + 32) | 0 : n;
}

// --- toFixed: the exact value, rounded half up

export function numToFixed(x: number, digits: number): string {
  const f = digits !== digits ? 0 : __f_trunc(digits);
  if (f < 0 || f > 100) throw new RangeError("toFixed() digits argument must be between 0 and 100");
  if (x !== x) return "NaN";
  const neg = x < 0 || (x === 0 && 1 / x < 0 && false);
  const a = neg ? -x : x;
  if (a >= 1e21) return numStr(x);
  const fd = f | 0;
  const hi = __f64_hi(a);
  const lo = __f64_lo(a);
  const be = (hi >>> 20) & 2047;
  const fhi = hi & 1048575;
  const e = be === 0 ? -1074 : (be - 1075) | 0;
  // n = floor(a * 10^f + 1/2), so n = floor((2 * m * 10^f * 2^e + 1) / 2) as integers, at whichever scale e allows.
  const n = new Int32Array(64);
  bigSet(n, be === 0 ? fhi : fhi | 1048576, lo);
  bigPow10(n, fd);
  if (e >= 0) bigShl(n, e);
  else {
    // Add a half of what's being shifted away, then shift it away.
    const half = new Int32Array(64);
    bigSetSmall(half, 1);
    bigShl(half, (-e - 1) | 0);
    bigAdd(n, half);
    bigShr(n, -e | 0);
  }
  const buf = new Int32Array(160);
  let nd = 0;
  while (n[0]! > 0) {
    buf[nd] = bigDiv10(n);
    nd = (nd + 1) | 0;
  }
  while (nd <= fd) {
    buf[nd] = 0;
    nd = (nd + 1) | 0;
  }
  const len = ((neg ? 1 : 0) + nd + (fd > 0 ? 1 : 0)) | 0;
  const r = __s_alloc(16, len);
  let at = 0;
  if (neg) {
    __s_put(r, 0, 45);
    at = 1;
  }
  for (let i = (nd - 1) | 0; i >= 0; i = (i - 1) | 0) {
    __s_put(r, at, (48 + buf[i]!) | 0);
    at = (at + 1) | 0;
    if (i === fd && fd > 0) {
      __s_put(r, at, 46);
      at = (at + 1) | 0;
    }
  }
  return r;
}

function bigShr(a: Int32Array, bits: number): void {
  const n = a[0]!;
  const words = (bits / 24) | 0;
  const rest = (bits - words * 24) | 0;
  if (words >= n) {
    a[0] = 0;
    return;
  }
  const top = (n - words) | 0;
  for (let i = 1; i <= top; i = (i + 1) | 0) {
    const w = a[(i + words) | 0]! >>> rest;
    const up = i < top && rest > 0 ? (a[(i + words + 1) | 0]! << (24 - rest)) & MASK : 0;
    a[i] = w | up;
  }
  let t = top;
  while (t > 0 && a[t] === 0) t = (t - 1) | 0;
  a[0] = t;
}

/** Divides by 10 and gives the remainder. 10 * 2^24 fits an i32. */
function bigDiv10(a: Int32Array): number {
  let rem = 0;
  const n = a[0]!;
  for (let i = n; i >= 1; i = (i - 1) | 0) {
    const cur = ((rem << 24) | a[i]!) >>> 0;
    const q = __f_floor(cur / 10);
    a[i] = q | 0;
    rem = (cur - q * 10) | 0;
  }
  let t = n;
  while (t > 0 && a[t] === 0) t = (t - 1) | 0;
  a[0] = t;
  return rem;
}

// --- toString(radix), as V8's DoubleToRadixCString
const RADIX_RANGE = "toString() radix argument must be between 2 and 36"; // V8's words
const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";

export function numToRadix(x0: number, radixArg: number): string {
  const radix0 = radixArg !== radixArg ? 0 : __f_trunc(radixArg);
  if (radix0 < 2 || radix0 > 36) throw new RangeError(RADIX_RANGE);
  if (radix0 === 10) return numStr(x0);
  if (x0 !== x0) return "NaN";
  if (x0 === Infinity) return "Infinity";
  if (x0 === -Infinity) return "-Infinity";
  if (x0 === 0) return "0";
  const radix = radix0 | 0;
  const neg = x0 < 0;
  const value = neg ? -x0 : x0;
  const buf = new Int32Array(2200);
  const mid = 1100;
  let intAt = mid;
  let fracAt = mid;
  let integer = __f_floor(value);
  let fraction = value - integer;
  const hi = __f64_hi(value);
  const lo = __f64_lo(value);
  const next = lo === -1 ? __f64_make((hi + 1) | 0, 0) : __f64_make(hi, (lo + 1) | 0);
  let delta = 0.5 * (next - value);
  if (delta < 5e-324) delta = 5e-324;
  if (fraction >= delta) {
    buf[fracAt] = 46;
    fracAt = (fracAt + 1) | 0;
    do {
      fraction = fraction * radix;
      delta = delta * radix;
      const digit = __f_floor(fraction) | 0;
      buf[fracAt] = __s_unit(DIGITS, digit);
      fracAt = (fracAt + 1) | 0;
      fraction = fraction - digit;
      if (fraction > 0.5 || (fraction === 0.5 && (digit & 1) !== 0)) {
        if (fraction + delta > 1) {
          for (;;) {
            fracAt = (fracAt - 1) | 0;
            if (fracAt === mid) {
              integer = integer + 1;
              break;
            }
            const c = buf[fracAt]!;
            const dg = c > 57 ? (c - 97 + 10) | 0 : (c - 48) | 0;
            if (((dg + 1) | 0) < radix) {
              buf[fracAt] = __s_unit(DIGITS, (dg + 1) | 0);
              fracAt = (fracAt + 1) | 0;
              break;
            }
          }
          break;
        }
      }
    } while (fraction >= delta);
  }
  // Past 2^53 ECMAScript leaves the digits to the implementation, and V8's aren't reproduced: a trap, not a silent difference.
  if (integer >= 9007199254740992) __trap(Trap.Conversion);
  do {
    const rem = integer % radix;
    intAt = (intAt - 1) | 0;
    buf[intAt] = __s_unit(DIGITS, rem | 0);
    integer = (integer - rem) / radix;
  } while (integer > 0);
  const total = ((neg ? 1 : 0) + fracAt - intAt) | 0;
  const r = __s_alloc(16, total);
  let at = 0;
  if (neg) {
    __s_put(r, 0, 45);
    at = 1;
  }
  for (let i = intAt; i < fracAt; i = (i + 1) | 0) {
    __s_put(r, at, buf[i]!);
    at = (at + 1) | 0;
  }
  return r;
}

// --- string to number

const MAX_DIGITS = 800; // past this, a sticky digit stands for the rest: 767 significant digits decide any double

function pow10(k: number): number {
  let r = __f64(1);
  let b = __f64(10);
  let n = k;
  while (n > 0) {
    if ((n & 1) !== 0) r = r * b;
    b = b * b;
    n = n >> 1;
  }
  return r;
}

/**
 * digits[0 .. nd) * 10^exp10, correctly rounded to even. The digits have no leading zero, and aren't all zero.
 * Bignums here hold up to 800 digits scaled by a double's range, about 3700 bits.
 */
function decimalToDouble(digits: Int32Array, nd: number, exp10: number): number {
  // Where the point is, so overflow and underflow answer at once.
  const point = (nd + exp10) | 0;
  if (point > 310) return Infinity;
  if (point < -326) return 0;
  // Exact when the digits fit a double and so does the power (Clinger's fast path).
  if (nd <= 15 && exp10 >= -22 && exp10 <= 22) {
    let v = __f64(0);
    for (let i = 0; i < nd; i = (i + 1) | 0) v = v * 10 + digits[i]!;
    if (exp10 < 0) return v / pow10(-exp10 | 0);
    return v * pow10(exp10);
  }
  // An estimate from the first 17 digits, good to a few units in the last place.
  let v = __f64(0);
  const lead = nd < 17 ? nd : 17;
  for (let i = 0; i < lead; i = (i + 1) | 0) v = v * 10 + digits[i]!;
  const e = (exp10 + nd - lead) | 0;
  let z =
    e >= 0
      ? e > 308
        ? v * pow10(308) * pow10((e - 308) | 0)
        : v * pow10(e)
      : e < -308
        ? v / pow10(308) / pow10((-e - 308) | 0)
        : v / pow10(-e | 0);
  if (z === Infinity) z = 1.7976931348623157e308;
  if (z === 0) z = 5e-324;
  const x = new Int32Array(180);
  const y = new Int32Array(180);
  // Moving by one double at a time from there: a bounded number of exact comparisons.
  for (let guard = 0; guard < 2200; guard = (guard + 1) | 0) {
    // The midpoint above z, and the one below.
    const hi = __f64_hi(z);
    const lo = __f64_lo(z);
    const be = (hi >>> 20) & 2047;
    const fhi = hi & 1048575;
    const e2 = be === 0 ? -1074 : (be - 1075) | 0;
    const f1 = be === 0 ? fhi : fhi | 1048576;
    const up = compareMid(digits, nd, exp10, f1, lo, e2, 1, x, y);
    const odd = (lo & 1) !== 0;
    if (up > 0 || (up === 0 && odd)) {
      const nx = stepUp(hi, lo);
      if (nx === Infinity) return Infinity;
      if (up === 0) return nx;
      z = nx;
      continue;
    }
    if (up === 0) return z;
    const lowerClose = be > 1 && fhi === 0 && lo === 0;
    const down = compareMid(digits, nd, exp10, f1, lo, e2, lowerClose ? -2 : -1, x, y);
    if (down < 0 || (down === 0 && odd)) {
      const nx = stepDown(hi, lo);
      if (down === 0 || nx === 0) {
        if (nx === 0) return down < 0 || odd ? 0 : z;
        return nx;
      }
      z = nx;
      continue;
    }
    return z;
  }
  return z;
}

function stepUp(hi: number, lo: number): number {
  return lo === -1 ? __f64_make((hi + 1) | 0, 0) : __f64_make(hi, (lo + 1) | 0);
}

function stepDown(hi: number, lo: number): number {
  return lo === 0 ? __f64_make((hi - 1) | 0, -1) : __f64_make(hi, (lo - 1) | 0);
}

/**
 * Compares digits * 10^exp10 with (2m + side/|side|...) at z's scale: side 1 is z + half a gap, -1 is z - half a gap,
 * and -2 is z - a quarter of a gap, for a power of two. Gives the sign of digits*10^exp10 - that.
 */
function compareMid(
  digits: Int32Array,
  nd: number,
  exp10: number,
  mhi: number,
  mlo: number,
  e2: number,
  side: number,
  x: Int32Array,
  y: Int32Array,
): number {
  bigSetSmall(x, 0);
  // x = the digits
  for (let i = 0; i < nd; i = (i + 1) | 0) {
    bigMul(x, 10);
    const d = digits[i]!;
    if (d !== 0) bigAddSmall(x, d);
  }
  // y = 4m + 2 (side 1), 4m - 2 (side -1), 4m - 1 (side -2), at a scale of 2^(e2 - 2)
  bigSet(y, mhi, mlo);
  bigShl(y, 2);
  if (side === 1) bigAddSmall(y, 2);
  else bigSubSmall(y, side === -1 ? 2 : 1);
  const s2 = (e2 - 2) | 0;
  if (exp10 >= 0) bigPow10(x, exp10);
  else bigPow10(y, -exp10 | 0);
  if (s2 >= 0) bigShl(y, s2);
  else bigShl(x, -s2 | 0);
  return bigCmp(x, y);
}

function bigAddSmall(a: Int32Array, v: number): void {
  let i = 1;
  let carry = v;
  const n = a[0]!;
  while (carry !== 0 && i <= n) {
    const s = (a[i]! + carry) | 0;
    a[i] = s & MASK;
    carry = s >>> 24;
    i = (i + 1) | 0;
  }
  if (carry !== 0) {
    a[(n + 1) | 0] = carry;
    a[0] = (n + 1) | 0;
  }
}

function bigSubSmall(a: Int32Array, v: number): void {
  let i = 1;
  let borrow = v;
  const n = a[0]!;
  while (borrow !== 0 && i <= n) {
    const s = (a[i]! - borrow) | 0;
    if (s < 0) {
      a[i] = (s + LIMB) | 0;
      borrow = 1;
    } else {
      a[i] = s;
      borrow = 0;
    }
    i = (i + 1) | 0;
  }
  let t = n;
  while (t > 0 && a[t] === 0) t = (t - 1) | 0;
  a[0] = t;
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

/** The longest decimal literal at i, as StrDecimalLiteral: gives the value, and leaves where it ended in `endAt[0]`. */
function parseDecimal(s: string, from: number, to: number, endAt: Int32Array): number {
  let i = from;
  let neg = false;
  if (i < to) {
    const c = __s_unit(s, i);
    if (c === 43 || c === 45) {
      neg = c === 45;
      i = (i + 1) | 0;
    }
  }
  // Infinity
  if (i < to && __s_unit(s, i) === 73 && matchInf(s, i, to)) {
    endAt[0] = (i + 8) | 0;
    return neg ? -Infinity : Infinity;
  }
  const digits = new Int32Array(801);
  let nd = 0;
  let seen = false;
  let exp10 = 0;
  let sticky = false;
  let intPart = true;
  for (;;) {
    while (i < to && isDigit(__s_unit(s, i))) {
      const d = (__s_unit(s, i) - 48) | 0;
      seen = true;
      if (nd === 0 && d === 0) {
        // A leading zero: it only moves the point.
        if (!intPart) exp10 = (exp10 - 1) | 0;
      } else if (nd < MAX_DIGITS) {
        digits[nd] = d;
        nd = (nd + 1) | 0;
        if (!intPart) exp10 = (exp10 - 1) | 0;
      } else {
        if (d !== 0) sticky = true;
        if (intPart) exp10 = (exp10 + 1) | 0;
      }
      i = (i + 1) | 0;
    }
    if (intPart && i < to && __s_unit(s, i) === 46) {
      const after = (i + 1) | 0;
      if (seen || (after < to && isDigit(__s_unit(s, after)))) {
        intPart = false;
        i = after;
        continue;
      }
    }
    break;
  }
  if (!seen) {
    endAt[0] = -1;
    return NaN;
  }
  if (i < to && (__s_unit(s, i) === 101 || __s_unit(s, i) === 69)) {
    let j = (i + 1) | 0;
    let eneg = false;
    if (j < to && (__s_unit(s, j) === 43 || __s_unit(s, j) === 45)) {
      eneg = __s_unit(s, j) === 45;
      j = (j + 1) | 0;
    }
    if (j < to && isDigit(__s_unit(s, j))) {
      let ev = 0;
      while (j < to && isDigit(__s_unit(s, j))) {
        if (ev < 100000) ev = (ev * 10 + __s_unit(s, j) - 48) | 0;
        j = (j + 1) | 0;
      }
      exp10 = eneg ? (exp10 - ev) | 0 : (exp10 + ev) | 0;
      i = j;
    }
  }
  endAt[0] = i;
  while (nd > 0 && digits[(nd - 1) | 0] === 0 && !sticky) {
    nd = (nd - 1) | 0;
    exp10 = (exp10 + 1) | 0;
  }
  if (nd === 0) return neg ? -0 : 0;
  if (sticky) {
    digits[nd] = 1;
    nd = (nd + 1) | 0;
    exp10 = (exp10 - 1) | 0;
  }
  const v = decimalToDouble(digits, nd, exp10);
  return neg ? -v : v;
}

function matchInf(s: string, i: number, to: number): boolean {
  if (((i + 8) | 0) > to) return false;
  const word = "Infinity";
  for (let k = 0; k < 8; k = (k + 1) | 0) {
    if (__s_unit(s, (i + k) | 0) !== __s_unit(word, k)) return false;
  }
  return true;
}

export function strParseFloat(s: string): number {
  const n = __s_len(s);
  let i = 0;
  while (i < n && isSpace(__s_unit(s, i))) i = (i + 1) | 0;
  const end = new Int32Array(1);
  const v = parseDecimal(s, i, n, end);
  return end[0] === -1 ? NaN : v;
}

function digitVal(c: number): number {
  if (c >= 48 && c <= 57) return (c - 48) | 0;
  if (c >= 97 && c <= 122) return (c - 87) | 0;
  if (c >= 65 && c <= 90) return (c - 55) | 0;
  return 99;
}

/** Digits in a power-of-two radix, rounded to even: exact, however many there are. */
function parsePow2(s: string, from: number, to: number, bits: number): number {
  let i = from;
  while (i < to && __s_unit(s, i) === 48) i = (i + 1) | 0;
  if (i === to) return 0;
  // Up to 53 significant bits in two parts, then one rounding bit, and whether anything was set after that.
  let mhi = 0;
  let mlo = 0;
  let nb = 0;
  let round = 0;
  let sticky = false;
  let dropped = 0;
  for (; i < to; i = (i + 1) | 0) {
    const d = digitVal(__s_unit(s, i));
    for (let b = (bits - 1) | 0; b >= 0; b = (b - 1) | 0) {
      const bit = (d >>> b) & 1;
      if (nb === 0 && bit === 0) continue;
      if (nb < 53) {
        mhi = (mhi << 1) | (mlo >>> 31);
        mlo = (mlo << 1) | bit;
        nb = (nb + 1) | 0;
      } else if (nb === 53) {
        round = bit;
        nb = 54;
        dropped = 1;
      } else {
        if (bit !== 0) sticky = true;
        dropped = (dropped + 1) | 0;
      }
    }
  }
  let v = mhi * 4294967296 + (mlo >>> 0);
  if (round !== 0 && (sticky || (mlo & 1) !== 0)) v = v + 1;
  if (dropped > 1023) return Infinity;
  return v * pow2(dropped);
}

function pow2(n: number): number {
  let r = __f64(1);
  for (let i = 0; i < n; i = (i + 1) | 0) r = r * 2;
  return r;
}

export function strParseInt(s: string, radixArg: number | undefined): number {
  const n = __s_len(s);
  let i = 0;
  while (i < n && isSpace(__s_unit(s, i))) i = (i + 1) | 0;
  let neg = false;
  if (i < n) {
    const c = __s_unit(s, i);
    if (c === 43 || c === 45) {
      neg = c === 45;
      i = (i + 1) | 0;
    }
  }
  let radix = radixArg === undefined ? 0 : radixArg | 0;
  let strip = true;
  if (radix !== 0) {
    if (radix < 2 || radix > 36) return NaN;
    if (radix !== 16) strip = false;
  } else radix = 10;
  if (strip && ((i + 1) | 0) < n && __s_unit(s, i) === 48) {
    const x = __s_unit(s, (i + 1) | 0);
    if (x === 120 || x === 88) {
      i = (i + 2) | 0;
      radix = 16;
    }
  }
  let end = i;
  while (end < n && digitVal(__s_unit(s, end)) < radix) end = (end + 1) | 0;
  if (end === i) return NaN;
  let v: number;
  if (radix === 10) {
    const stop = new Int32Array(1);
    v = parseDecimal(s, i, end, stop);
  } else if ((radix & ((radix - 1) | 0)) === 0) {
    const bits = radix === 2 ? 1 : radix === 4 ? 2 : radix === 8 ? 3 : radix === 16 ? 4 : 5;
    v = parsePow2(s, i, end, bits);
  } else {
    v = parseOther(s, i, end, radix);
    // Past 2^53 this radix is an approximation in ECMAScript too, and V8's last bit depends on its host's fused multiply.
    if (v >= 9007199254740992) __trap(Trap.Conversion);
  }
  return neg ? -v : v;
}

/** V8's: parts of up to what fits 32 bits, multiplied in. Past 2^53 this accumulates error, and V8's is the same error. */
function parseOther(s: string, from: number, to: number, radix: number): number {
  let i = from;
  let v = __f64(0);
  let done = false;
  while (!done) {
    let multiplier = __f64(1);
    let part = __f64(0);
    for (;;) {
      const m = multiplier * radix;
      if (m > 119304647) break; // 0xFFFFFFFF / 36
      if (i >= to) {
        done = true;
        break;
      }
      part = part * radix + digitVal(__s_unit(s, i));
      multiplier = m;
      i = (i + 1) | 0;
      if (i >= to) {
        done = true;
        break;
      }
    }
    v = v * multiplier + part;
  }
  return v;
}

/** Number(string), as StringToNumber. */
export function strToNumber(s: string): number {
  let i = 0;
  let n = __s_len(s);
  while (i < n && isSpace(__s_unit(s, i))) i = (i + 1) | 0;
  while (n > i && isSpace(__s_unit(s, (n - 1) | 0))) n = (n - 1) | 0;
  if (i === n) return 0;
  if (((i + 2) | 0) < n && __s_unit(s, i) === 48) {
    const x = __s_unit(s, (i + 1) | 0);
    const bits =
      x === 120 || x === 88 ? 4 : x === 111 || x === 79 ? 3 : x === 98 || x === 66 ? 1 : 0;
    if (bits !== 0) {
      const radix = 1 << bits;
      for (let k = (i + 2) | 0; k < n; k = (k + 1) | 0) {
        if (digitVal(__s_unit(s, k)) >= radix) return NaN;
      }
      return parsePow2(s, (i + 2) | 0, n, bits);
    }
  }
  const end = new Int32Array(1);
  const v = parseDecimal(s, i, n, end);
  return end[0] === n ? v : NaN;
}
