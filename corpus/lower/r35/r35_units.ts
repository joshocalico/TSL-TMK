// memory-pages: 48
// R35 (SPEC 3.5, 4.3, 4.4): strings in `rc` through the TSL route where R35 changed them. A one-unit string past the
// one-unit table (a unit of 256 or more: accented letters past Latin-1, surrogate halves, emoji's halves) is made where it's
// asked for, its length known when it's compiled (`jsStrUnitNew`), where it was `jsStrUnitMade`'s call; a unit below 256
// still comes from the table, made the first time. Short joins of two and three strings copy each part after the runs before
// it at their lengths (`jsStrJoined`, `jsStrJoined3`), flat strings and views alike. And at -O1 the unit read of `s[j]` by
// a float index tested into range loses its own test by range.ts's one round, as at -O2. Here: units read one at a time
// and joined back, across the table's edge (255, 256), lone surrogates and pairs, the empty string, views of long strings
// built by appending, and three-part joins; every answer is V8's, at every level, and what's made is let go of many times
// over in a small memory.
function mix(h: number, x: number): number {
  return Math.imul(h ^ x, 16777619) >>> 0;
}

function codeOf(s: string): number {
  let c = s.length;
  for (let i = 0; i < s.length; i++) c = mix(c, s.charCodeAt(i));
  return c;
}

/** Each unit of s read by a float index and joined back, `rounds` times: the copy is s, unit for unit. */
export function rebuild(s: string, rounds: number): number {
  let h = 0;
  for (let r = 0; r < rounds; r++) {
    let c = "";
    for (let j = 0; j < s.length; j++) c += s[j]!;
    h = mix(h, codeOf(c));
    h = mix(h, c === s ? 1 : 0);
  }
  return h;
}

/** A float index tested into range, from below 0 to past the end, `step` apart, over a view of s built long. */
export function scan(s: string, n: number, step: number): number {
  let long = "";
  for (let i = 0; i < n; i++) long += s;
  let h = 0;
  for (let j = -1; j <= long.length + 1; j += step) {
    const c = long[j];
    h = mix(h, c === undefined ? 7 : c.charCodeAt(0) + c.length);
  }
  return h;
}

/** One-unit strings from units across the table's edge and past it, each kept in an array and read back after. */
export function units(from: number, count: number): number {
  const kept: string[] = [];
  for (let u = from; u < from + count; u++) kept.push(String.fromCharCode(u));
  let h = mix(0, kept.length);
  for (let i = 0; i < kept.length; i++) h = mix(h, codeOf(kept[i]!) + kept[i]!.length);
  for (let i = 0; i + 1 < kept.length; i++) h = mix(h, kept[i] === kept[i + 1] ? 1 : 0);
  return h;
}

/** Short joins of two and three parts, flat and views, kept and compared. */
export function joins(a: string, b: string, c: string, n: number): number {
  let h = 0;
  let long = a;
  for (let i = 0; i < n; i++) {
    const two = a + b;
    const three = a + b + c;
    long += c;
    const view = long.slice(1);
    const mixed = view.slice(0, 3) + b + c;
    h = mix(h, codeOf(two));
    h = mix(h, codeOf(three));
    h = mix(h, codeOf(mixed));
    h = mix(h, two + c === three ? 1 : 0);
  }
  return mix(h, codeOf(long));
}
