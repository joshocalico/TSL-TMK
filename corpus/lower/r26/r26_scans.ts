// R26: scans whose checks and loads the optimiser now proves or moves (range.ts, loopbounds.ts, -O2's copying rounds), and
// `charCodeAt` printed in integers in `rc`. Each loop's index starts at 0, below 0 and past the end, and runs to the
// length, one short of it and one past it, over flat strings and views (appends past 64 units), with a string a scan
// reads shorter than the one its test measures; arrays the same; and a loop test by a constant inside a loop. A check
// proved where it can fire, a test answered the wrong way, or a loop copy taking the other way's reads shows in the results.
function made(n: number, parts: string): string {
  let s = "";
  for (let i = 0; i < n; i++) s += parts[i % parts.length]!;
  return s;
}

function mix(t: number, c: number): number {
  return c !== c ? (t * 7 + 3) | 0 : (t * 31 + c) | 0;
}

/** `charCodeAt` from `from` up to `s.length + past`, over a view and over a flat copy of it. */
export function scans(n: number, from: number, past: number): number {
  const v = made(n, "aé😀b");
  const f = v.slice(0, n) + "";
  let t = 0;
  for (let k = 0; k < 2; k++) {
    const s = k === 0 ? v : f;
    for (let i = from | 0; i < s.length + (past | 0); i++) t = mix(t, s.charCodeAt(i));
    for (let i = 0; i < s.length; i++) t = (t * 31 + s.charCodeAt(i)) | 0;
  }
  return t;
}

/** A loop measured by one string reading another, shorter or longer. */
export function twoStrings(n: number, m: number): number {
  const a = made(n, "xyz");
  const b = made(m, "pq😀");
  let t = 0;
  for (let i = 0; i < a.length; i++) t = mix(t, b.charCodeAt(i));
  for (let i = 0; i <= b.length; i++) t = mix(t, b.charCodeAt(i));
  return t;
}

/** Arrays read by their own length and by another's: past the end the lowering traps (trap 2) where V8 reads undefined. */
export function arrays(n: number, m: number): number {
  const a: number[] = [];
  const b: number[] = [];
  for (let i = 0; i < (n | 0); i++) a.push(i * 3);
  for (let i = 0; i < (m | 0); i++) b.push(i * 5 + 1);
  let t = 0;
  for (let i = 0; i < a.length; i++) t = (t * 31 + a[i]!) | 0;
  for (let i = 0; i < a.length; i++) t = (t * 31 + b[i]!) | 0;
  return t;
}

/** An array read from `from`, which may be below 0: there the lowering traps (trap 2) where V8 reads undefined. */
export function arraysFrom(n: number, from: number): number {
  const a: number[] = [];
  for (let i = 0; i < (n | 0); i++) a.push(i * 7 + 2);
  let t = 0;
  for (let i = from | 0; i < a.length; i++) t = (t * 31 + a[i]!) | 0;
  return t;
}

/** A test by a constant in a loop from 0, which also reads an array by its own length: only `i < 0` is false every turn. */
export function firsts(n: number): number {
  const xs: number[] = [];
  for (let i = 0; i < (n | 0); i++) xs.push(i + 1);
  let t = 0;
  for (let i = 0; i < xs.length; i++) {
    t += xs[i]!;
    if (i < 1) t += 100;
    if (i < 3) t += 10;
    if (i < 0) t += 1000;
    t += i;
  }
  return t;
}
