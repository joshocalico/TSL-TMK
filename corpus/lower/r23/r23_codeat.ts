// R23: `charCodeAt` in `rc` inlined where it's called, over strings of every kind: literals, one-unit strings, strings
// made by appending (a buffer's view), substrings that share a buffer and that copy, joins, surrogate pairs, and indices
// below 0, at and past the length, fractional, NaN and infinite. A unit read from the wrong place, or NaN where a unit is,
// shows in the results.
function code(s: string, i: number): number {
  const c = s.charCodeAt(i);
  return c !== c ? -1 : c;
}

/** Every index of strings made each way, by an integer index. */
export function units(n: number): number {
  let s = "";
  for (let i = 0; i < n; i++) s += "aé😀Z"[i & 3]!;
  const parts = [s, s.slice(1, 9), s.substring(3), "lit" + s.length, "q", ""];
  let t = 0;
  for (const p of parts) for (let i = -2; i < p.length + 2; i++) t = (t * 31 + code(p, i)) | 0;
  return t;
}

/** Indices that aren't integers: fractional, negative zero, NaN, infinite, and past 2^31. */
export function odd(k: number): number {
  const s = "héllo wörld 😀" + k;
  const xs = [0.5, 1.9, -0.0, -0.4, NaN, Infinity, -Infinity, 2147483648, s.length - 0.5, k / 3];
  let t = 0;
  for (const x of xs) t = (t * 17 + code(s, x)) | 0;
  return t;
}
