// Array methods that needed strings or a comparator's semantics to lower (SPEC 4.5, D42), in ordinary TS.
import {
  __f_trunc,
  __is_str,
  __join_str,
  __s_alloc,
  __s_copy,
  __s_len,
  __v_at,
  __v_clear,
  __v_hole,
  __v_put,
} from "./intrinsics.ts";
import { strCmp, strConcat } from "./str.ts";

/** Stable, as JS requires. By merging, so every comparator call is one a stable sort could make. */
export function arrSort<T>(a: T[], cmp: (x: T, y: T) => number): T[] {
  const n = a.length;
  const buf: T[] = [];
  let live = 0;
  for (let i = 0; i < n; i = (i + 1) | 0) {
    if (!__v_hole(a, i)) {
      buf.push(__v_at(a, i));
      live = (live + 1) | 0;
    }
  }
  const tmp: T[] = [];
  for (let i = 0; i < live; i = (i + 1) | 0) tmp.push(__v_at(buf, i));
  let src = buf;
  let dst = tmp;
  for (let w = 1; w < live; w = (w * 2) | 0) {
    for (let lo = 0; lo < live; lo = (lo + w * 2) | 0) {
      const mid = lo + w < live ? (lo + w) | 0 : live;
      const hi = lo + w * 2 < live ? (lo + w * 2) | 0 : live;
      let i = lo;
      let j = mid;
      let k = lo;
      while (k < hi) {
        if (j >= hi) {
          __v_put(dst, k, __v_at(src, i));
          i = (i + 1) | 0;
        } else if (i >= mid || cmp(__v_at(src, i), __v_at(src, j)) > 0) {
          __v_put(dst, k, __v_at(src, j));
          j = (j + 1) | 0;
        } else {
          __v_put(dst, k, __v_at(src, i));
          i = (i + 1) | 0;
        }
        k = (k + 1) | 0;
      }
    }
    const t = src;
    src = dst;
    dst = t;
  }
  // A hole sorts past every element, as JS has it, and reads as one: in a reference slot, the slots after `live`.
  for (let i = 0; i < live; i = (i + 1) | 0) __v_put(a, i, __v_at(src, i));
  for (let i = live; i < n; i = (i + 1) | 0) __v_clear(a, i);
  return a;
}

export function defaultCompare<T>(x: T, y: T): number {
  return strCmp(__join_str(x), __join_str(y));
}

export function arrReverse<T>(a: T[]): T[] {
  let i = 0;
  let j = (a.length - 1) | 0;
  while (i < j) {
    const t = __v_at(a, i);
    __v_put(a, i, __v_at(a, j));
    __v_put(a, j, t);
    i = (i + 1) | 0;
    j = (j - 1) | 0;
  }
  return a;
}

export function arrJoin<T>(a: T[], sep: string): string {
  const n = a.length;
  if (n === 0) return "";
  if (__is_str<T>()) return joinStrings(a, sep, n);
  let r = __join_str(__v_at(a, 0));
  for (let i = 1; i < n; i = (i + 1) | 0) {
    r = strConcat(strConcat(r, sep), __join_str(__v_at(a, i)));
  }
  return r;
}

/** Sizes it once, and copies once. */
function joinStrings<T>(a: T[], sep: string, n: number): string {
  const m = __s_len(sep);
  let total = (m * (n - 1)) | 0;
  for (let i = 0; i < n; i = (i + 1) | 0) {
    total = (total + __s_len(__join_str(__v_at(a, i)))) | 0;
  }
  const r = __s_alloc(16, total);
  let at = 0;
  for (let i = 0; i < n; i = (i + 1) | 0) {
    if (i > 0) {
      __s_copy(r, at, sep, 0, m);
      at = (at + m) | 0;
    }
    const e = __join_str(__v_at(a, i));
    const l = __s_len(e);
    __s_copy(r, at, e, 0, l);
    at = (at + l) | 0;
  }
  return r;
}

export function arrConcat<T>(a: T[], b: T[]): T[] {
  const r: T[] = [];
  const n = a.length;
  for (let i = 0; i < n; i = (i + 1) | 0) r.push(__v_at(a, i));
  const m = b.length;
  for (let i = 0; i < m; i = (i + 1) | 0) r.push(__v_at(b, i));
  return r;
}

export function arrSortDefault<T>(a: T[]): T[] {
  return arrSort<T>(a, (x, y) => defaultCompare<T>(x, y));
}

export function arrAt<T>(a: T[], x: number): T | undefined {
  const n = a.length;
  const t = x !== x ? 0 : __f_trunc(x);
  const k = t < 0 ? t + n : t;
  if (k < 0 || k >= n) return undefined;
  return __v_at(a, k | 0);
}
