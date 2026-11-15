// toUpperCase and toLowerCase (SPEC 4.5, D42): Unicode's full mapping, locale-free, including the final-sigma rule, from
// tables generated from V8 itself. ASCII never reaches them, but they're linked whenever either method is used.
import {
  CASED,
  IGNORABLE,
  LOW_DATA,
  LOW_RUNS,
  LOW_SPECIAL,
  UP_DATA,
  UP_RUNS,
  UP_SPECIAL,
} from "./case-tables.ts";
import { __s_alloc, __s_len, __s_put, __s_unit } from "./intrinsics.ts";

function inRanges(t: Int32Array, cp: number): boolean {
  let lo = 0;
  let hi = ((t.length >> 1) - 1) | 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (cp < t[(mid * 2) | 0]!) hi = (mid - 1) | 0;
    else if (cp > t[(mid * 2 + 1) | 0]!) lo = (mid + 1) | 0;
    else return true;
  }
  return false;
}

function mapped(runs: Int32Array, cp: number): number {
  let lo = 0;
  let hi = ((runs.length >> 2) - 1) | 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const at = (mid * 4) | 0;
    if (cp < runs[at]!) hi = (mid - 1) | 0;
    else if (cp > runs[(at + 1) | 0]!) lo = (mid + 1) | 0;
    else {
      const stride = runs[(at + 2) | 0]!;
      if (stride === 2 && ((cp - runs[at]!) & 1) !== 0) return cp;
      return (cp + runs[(at + 3) | 0]!) | 0;
    }
  }
  return cp;
}

function specialAt(index: Int32Array, cp: number): number {
  let lo = 0;
  let hi = ((index.length / 3) | 0) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const at = (mid * 3) | 0;
    if (cp < index[at]!) hi = (mid - 1) | 0;
    else if (cp > index[at]!) lo = (mid + 1) | 0;
    else return at;
  }
  return -1;
}

function cpAt(s: string, i: number, n: number): number {
  const c = __s_unit(s, i);
  if (c >= 0xd800 && c <= 0xdbff && ((i + 1) | 0) < n) {
    const d = __s_unit(s, (i + 1) | 0);
    if (d >= 0xdc00 && d <= 0xdfff) return (((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000) | 0;
  }
  return c;
}

function cpBefore(s: string, i: number): number {
  const d = __s_unit(s, (i - 1) | 0);
  if (d >= 0xdc00 && d <= 0xdfff && i >= 2) {
    const c = __s_unit(s, (i - 2) | 0);
    if (c >= 0xd800 && c <= 0xdbff) return (((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000) | 0;
  }
  return d;
}

/** Unicode's Final_Sigma: after a cased letter with only case-ignorables between, and not before another one. */
function finalSigma(s: string, at: number, n: number): boolean {
  let i = at;
  let before = false;
  while (i > 0) {
    const cp = cpBefore(s, i);
    i = (i - (cp >= 0x10000 ? 2 : 1)) | 0;
    if (inRanges(IGNORABLE, cp)) continue;
    before = inRanges(CASED, cp);
    break;
  }
  if (!before) return false;
  i = (at + 1) | 0;
  while (i < n) {
    const cp = cpAt(s, i, n);
    i = (i + (cp >= 0x10000 ? 2 : 1)) | 0;
    if (inRanges(IGNORABLE, cp)) continue;
    return !inRanges(CASED, cp);
  }
  return true;
}

function measure(
  s: string,
  n: number,
  upper: boolean,
  runs: Int32Array,
  index: Int32Array,
): number {
  let i = 0;
  let total = 0;
  while (i < n) {
    const cp = cpAt(s, i, n);
    const w = cp >= 0x10000 ? 2 : 1;
    if (!upper && cp === 0x3a3) total = (total + 1) | 0;
    else {
      const sp = cp < 128 ? -1 : specialAt(index, cp);
      if (sp >= 0) total = (total + index[(sp + 2) | 0]!) | 0;
      else total = (total + (mapped(runs, cp) >= 0x10000 ? 2 : 1)) | 0;
    }
    i = (i + w) | 0;
  }
  return total;
}

function convert(s: string, upper: boolean): string {
  const n = __s_len(s);
  let i = 0;
  // What doesn't change at all stays the same string.
  for (; i < n; i = (i + 1) | 0) {
    const c = __s_unit(s, i);
    if (c >= 128) break;
    if (upper ? c >= 97 && c <= 122 : c >= 65 && c <= 90) break;
  }
  if (i === n) return s;
  const runs = upper ? UP_RUNS : LOW_RUNS;
  const index = upper ? UP_SPECIAL : LOW_SPECIAL;
  const data = upper ? UP_DATA : LOW_DATA;
  // Sized by one pass, and written by another.
  const r = __s_alloc(16, measure(s, n, upper, runs, index));
  let at = 0;
  i = 0;
  while (i < n) {
    const cp = cpAt(s, i, n);
    const w = cp >= 0x10000 ? 2 : 1;
    if (!upper && cp === 0x3a3) {
      __s_put(r, at, finalSigma(s, i, n) ? 0x3c2 : 0x3c3);
      at = (at + 1) | 0;
    } else {
      const sp = cp < 128 ? -1 : specialAt(index, cp);
      if (sp >= 0) {
        const from = index[(sp + 1) | 0]!;
        const len = index[(sp + 2) | 0]!;
        for (let k = 0; k < len; k = (k + 1) | 0) {
          __s_put(r, at, data[(from + k) | 0]!);
          at = (at + 1) | 0;
        }
      } else {
        const m = mapped(runs, cp);
        if (m >= 0x10000) {
          const d = (m - 0x10000) | 0;
          __s_put(r, at, (0xd800 + (d >> 10)) | 0);
          __s_put(r, (at + 1) | 0, (0xdc00 + (d & 1023)) | 0);
          at = (at + 2) | 0;
        } else {
          __s_put(r, at, m);
          at = (at + 1) | 0;
        }
      }
    }
    i = (i + w) | 0;
  }
  return r;
}

export function strUpper(s: string): string {
  return convert(s, true);
}

export function strLower(s: string): string {
  return convert(s, false);
}
