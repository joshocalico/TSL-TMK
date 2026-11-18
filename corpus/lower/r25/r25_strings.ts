// R25: strings in `rc` with `indexOf`'s search over the two strings' runs of units (JsStr's `indexFrom`), a code point's
// length read through `unit`, a substring's common ways inlined with its copy read from the buffer straight, a join's
// copies of one unit stored, and equality's quick answers inlined: searches of flat strings and views for patterns of one
// unit and more, at every start, found at the first unit, the last place, nowhere, and past the end; splits on separators
// of one unit and more, at both ends and side by side, with a limit; joins with separators empty, of one unit and longer;
// `for...of` over surrogate pairs and lone surrogates, at the end too; slices and substrings of views and flat strings at
// every kind of index; and equality of strings the same length that differ only at the last unit. A unit read from the
// wrong place, a search that stops a unit early or late, or a substring copied from the wrong start, shows in the results.
function code(s: string, i: number): number {
  const c = s.charCodeAt(i);
  return c !== c ? -1 : c;
}

function digest(s: string): number {
  let t = s.length;
  for (let i = 0; i < s.length; i++) t = (t * 31 + code(s, i)) | 0;
  return t;
}

/** A view (appends past 64 units) and a flat string, each of n units from `parts`. */
function made(n: number, parts: string): string {
  let s = "";
  for (let i = 0; i < n; i++) s += parts[i % parts.length]!;
  return s;
}

/** `indexOf` and `includes` over a view and a flat copy of it, for patterns of one unit and more, from every start. */
export function searches(n: number): number {
  const v = made(n, "abcab😀ca");
  const f = v.slice(0, 20) + "";
  const pats = ["a", "ab", "cab", "😀", "\ude00", "bca", "zz", "", v.slice(n - 3), "abcab😀cab"];
  let t = 0;
  for (const p of pats) {
    for (let k = -2; k <= n + 2; k += 3) {
      t = (t * 7 + v.indexOf(p, k) + 3 * f.indexOf(p, k)) | 0;
      if (v.includes(p, k)) t = (t + 11) | 0;
    }
    t = (t * 5 + v.indexOf(p) + f.indexOf(p) + v.lastIndexOf(p)) | 0;
  }
  return t;
}

/** Splits on separators of one unit and more, at the ends and side by side, with a limit, then joins back. */
export function splits(n: number): number {
  const s = made(n, "--ab-c--d😀-");
  let t = 0;
  for (const sep of ["-", "--", "c", "😀", "x", "ab-c"]) {
    const w = s.split(sep);
    t = (t * 31 + w.length) | 0;
    for (const x of w) t = (t * 7 + digest(x)) | 0;
    for (const j of ["", "+", "<>", "😀"]) t = (t * 3 + digest(w.join(j))) | 0;
    t = (t + s.split(sep, 3).length) | 0;
  }
  const flat = "a,bb,,ccc,";
  for (const x of flat.split(",")) t = (t * 5 + x.length) | 0;
  return t;
}

/** `for...of` over surrogate pairs, lone surrogates (one at the very end), and plain units, in views and flat strings. */
export function codePoints(n: number): number {
  const v = made(n, "x😀\ud83dy\ude00é");
  const ends = [v + "\ud83d", "\ude00" + v, "😀", "\ud83d", "ab😀"];
  let t = 0;
  for (const s of [v, ...ends]) {
    let k = 0;
    for (const c of s) {
      t = (t * 31 + c.length * 1000 + c.charCodeAt(0) + code(c, 1)) | 0;
      k++;
    }
    t = (t + k) | 0;
  }
  return t;
}

/** Slices and substrings of a view and a flat string at every kind of index, each read whole and compared. */
export function substrings(n: number): number {
  const v = made(n, "the quick 😀 brown ");
  const f = "flat é string 😀 here";
  const xs = [0, 1, 3, -1, -5, n - 2, n, n + 4, 0.5, -0.0, NaN, 31, 33, 40];
  let t = 0;
  for (const s of [v, f]) {
    for (const a of xs) {
      for (const b of [2, 5, -3, 48, 70, s.length]) {
        const x = s.slice(a, b);
        const y = s.substring(a, b);
        t = (t * 31 + digest(x) + 3 * digest(y)) | 0;
        if (x === y) t = (t + 1) | 0;
      }
    }
  }
  return t;
}

/** Equality of strings the same length: alike, differing at the first or only the last unit, views and flat strings. */
export function equal(n: number): number {
  const a = made(n, "abcdefg");
  const b = made(n, "abcdefg");
  const c = made(n - 1, "abcdefg") + "z";
  const d = "z" + made(n - 1, "bcdefga");
  const e = a.slice(0, 8);
  const g = "abcdefga";
  let t = 0;
  for (const x of [a, b, c, d, e, g])
    for (const y of [a, b, c, d, e, g]) t = t * 2 + (x === y ? 1 : 0);
  return t | 0;
}
