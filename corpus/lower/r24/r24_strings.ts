// R24: strings in `rc` with a view's fields given to its constructor, a unit read with its length and start taken as their
// bits, and `a + b` and `s[i]` inlined where they're called: appends and prepends past 64 units (a buffer's views), views of
// views, substrings that share a buffer and that copy, the units of each read at every index, `s[i]` at indices below 0, at
// and past the length, fractional, negative zero and NaN, and strings kept while more are made into the slots freeing gave
// back. A view's start or length read wrong, or a string freed under its holder, shows in the results.
function code(s: string, i: number): number {
  const c = s.charCodeAt(i);
  return c !== c ? -1 : c;
}

function digest(s: string): number {
  let t = s.length;
  for (let i = -1; i <= s.length; i++) t = (t * 31 + code(s, i)) | 0;
  return t;
}

/** Appends and prepends past 64 units, then views of what they made, each read at every index. */
export function views(n: number): number {
  let a = "";
  let b = "";
  for (let i = 0; i < n; i++) {
    a += "abcdé😀"[i % 7]!;
    b = "xyz"[i % 3]! + b;
  }
  const parts = [
    a,
    b,
    a.slice(3, 70),
    a.substring(n >> 1),
    b.slice(1, n - 1),
    a + b,
    b + a,
    a.slice(40, 45),
  ];
  let t = 0;
  for (const p of parts) t = (t * 7 + digest(p)) | 0;
  return t;
}

/** `s[i]` at every kind of index, over a view and a flat string. */
export function indexed(n: number): number {
  let s = "";
  for (let i = 0; i < n; i++) s += "pqrs"[i & 3]!;
  const flat = "hé😀" + n;
  const xs = [0, 1, n - 1, n, n + 1, -1, 0.5, -0.0, NaN, n / 3];
  let t = 0;
  for (const x of xs) {
    const c = s[x];
    const d = flat[x];
    t =
      (t * 13 +
        (c === undefined ? -1 : c.charCodeAt(0)) +
        (d === undefined ? -7 : d.length * 100)) |
      0;
  }
  return t;
}

/** Strings kept in an array while more are made and dropped, so freed slots are taken again, then read. */
export function kept(n: number): number {
  const keep: string[] = [];
  let s = "";
  for (let i = 0; i < n; i++) {
    s += "mnop"[i & 3]!;
    if (i % 9 === 0) keep.push(s.slice(i >> 1));
    const tmp = s + "!" + i;
    if (tmp.length < 0) keep.push(tmp);
  }
  let t = 0;
  for (const k of keep) t = (t * 5 + digest(k)) | 0;
  return t;
}
