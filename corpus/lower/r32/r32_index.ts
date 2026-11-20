// R32 (SPEC 4.3, 4.5): range.ts's facts from a float compare's edge, and `s[x]` printed in `rc` as three tests one inside
// the other. A float index tested `x >= 0`, then below the length (`x < n`, or `!(x >= n)` once x isn't NaN), then
// `Math.trunc(x) === x`, makes `x | 0` an integer from 0 to below the length, so the unit read's own test of it goes, by
// proof, and its ToInt32 is a plain truncation. Here every way a float reaches such tests: in range, at the length and one
// past, below 0, -0, NaN, fractions, the infinities and floats past 2^31, through flat strings and views, and tests that
// differ from the proved shape by one thing each (`<=` for `<`, a fraction above 0, NaN through two failed compares, ToInt32
// with no upper bound), so a fact taken one step too far answers differently from V8.
function digest(h: number, c: number): number {
  return (Math.imul(h, 31) + c) | 0;
}

/** `s[x]` for one float index, every way JS reads it. */
export function at(s: string, x: number): string {
  const c = s[x];
  return c === undefined ? "none" : `${c}:${c.charCodeAt(0)}`;
}

/** A scan by float index from below 0 to past the end, `step` apart, of a flat string and of a view of a long one. */
export function scan(s: string, n: number, step: number): number {
  let long = "";
  for (let i = 0; i < n; i++) long += s;
  const v = long.slice(1, long.length - 1);
  let h = 0;
  for (let j = -1.5; j <= v.length + 1; j += step) {
    const c = v[j];
    h = digest(h, c === undefined ? 7 : c.charCodeAt(0));
  }
  for (let j = -1; j <= s.length; j++) {
    const c = s[j];
    h = digest(h, c === undefined ? 11 : c.charCodeAt(0));
  }
  return h;
}

/** `x <= n` lets the length through: the test below it must still see it fail. */
export function upTo(x: number, s: string): number {
  if (x >= 0) {
    if (x <= s.length) {
      const i = x | 0;
      if (i < s.length) return 1;
      return 2;
    }
  }
  return 3;
}

/** A fraction above 0 truncates to 0: only an integer above 0 is at least 1. */
export function above(x: number, s: string): number {
  if (x > 0) {
    if (x < s.length) {
      const i = x | 0;
      if (i >= 1) return 1;
      return 2;
    }
  }
  return 3;
}

/** An integer above 0 is at least 1, and below the length. */
export function aboveInt(x: number, s: string): number {
  if (x > 0) {
    if (x < s.length) {
      if (Math.trunc(x) === x) {
        const i = x | 0;
        if (i >= 1 && i < s.length) return s.charCodeAt(i - 1);
        return -2;
      }
    }
  }
  return -3;
}

/** NaN gets through two compares that fail, each the other way: only a compare that held says x isn't NaN. */
export function failedBoth(x: number, s: string): number {
  if (!(x < 0)) {
    if (!(x >= s.length)) {
      const i = x | 0;
      if (i < s.length) return 1;
      return 2;
    }
  }
  return 3;
}

/** ToInt32 with only a lower bound: floats past 2^31 wrap, as JS's do. */
export function wrapAbove(x: number): number {
  if (x >= 0) return x | 0;
  return -1;
}

/** ToInt32 between two constants: a plain truncation there. */
export function between(x: number): number {
  if (x >= 2.5) {
    if (x < 1000.25) return (x | 0) * 3;
  }
  return -1;
}

let kept = "a";

function bump(): string {
  kept = `${kept}b`;
  return "c";
}

/** A literal and module state each read before a later operand's call, which assigns the module state: JS reads them first. */
export function order(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out = out + ("<" + bump()) + (kept + bump());
  return out;
}
