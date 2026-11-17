// R21: one-unit strings below 256 from a table, as the direct route takes them from its static one. Every unit to 300 is
// made as a one-unit string in each way the runtime makes one (`charAt`, an index, `String.fromCharCode`, a one-unit
// `substring` and `slice`, `for...of`), in an order that makes units 128 apart one after the other, and read back weighted by
// position, so a string given for the wrong unit, or a unit at or past 256 taken for the table's, shows. The table's strings
// are shared, so each is also used where sharing could show: kept in an array that's let go of, as map keys (their hash
// word is cached in the shared string), joined and appended to, and compared with `===` against one made another way.
function digest(s: string): number {
  let t = s.length;
  for (let i = 0; i < s.length; i++) t = (t * 31 + s.charCodeAt(i) * (i + 1)) | 0;
  return t;
}

/** Every unit below `n` by `String.fromCharCode`, low and high halves of each 256 interleaved: u, u + 128, u + 1, ... */
export function fromCodes(n: number): number {
  let t = 0;
  for (let i = 0; i < 128; i++)
    for (const u of [i, i + 128, i + 256]) {
      if (u >= n) continue;
      const s = String.fromCharCode(u);
      t = (t * 7 + s.length * 1000 + s.charCodeAt(0) * (u + 1)) | 0;
    }
  return t;
}

/** Each unit of a string of every unit below `n`, by `charAt`, an index, `substring`, `slice` and `for...of`. */
export function readBack(n: number): number {
  let s = "";
  for (let u = n - 1; u >= 0; u--) s += String.fromCharCode(u);
  let t = 0;
  for (let i = 0; i < s.length; i++) {
    const a = s.charAt(i);
    const b = s[i]!;
    const c = s.substring(i, i + 1);
    const d = s.slice(i, i + 1);
    t =
      (t * 31 + a.charCodeAt(0) + b.charCodeAt(0) * 3 + c.charCodeAt(0) * 5 + d.charCodeAt(0) * 7) |
      0;
    if (a !== b || b !== c || c !== d) t = (t + 100000) | 0;
  }
  for (const c of s) t = (t * 17 + c.charCodeAt(0)) | 0;
  return t;
}

/** One-unit strings kept in an array, let go of, made again: the table's are the same strings, still right. */
export function keptAndDropped(n: number): number {
  let t = 0;
  for (let round = 0; round < 3; round++) {
    let xs: string[] = [];
    for (let u = 0; u < n; u++) xs.push(String.fromCharCode((u * 37 + round) % 300));
    for (let i = 0; i < xs.length; i++) t = (t * 5 + xs[i]!.charCodeAt(0) * (i + 1)) | 0;
    xs = [];
    t = (t + xs.length) | 0;
  }
  return t;
}

/** One-unit strings as map keys, counted: a key's hash is kept in the string, which the table shares. */
export function asKeys(text: string): number {
  const counts = new Map<string, number>();
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let t = counts.size;
  counts.forEach((v, k) => {
    t = (t * 13 + v * 7 + k.charCodeAt(0)) | 0;
  });
  for (let i = 0; i < text.length; i++) t = (t + (counts.get(text[i]!) ?? 0)) | 0;
  return t;
}

/** Strings built from one-unit strings: an append to "" gives the table's own string, then joins and appends past it. */
export function builtUp(n: number): number {
  let w = "";
  let t = 0;
  for (let i = 0; i < n; i++) {
    const c = String.fromCharCode(32 + ((i * 7) % 240));
    w += c;
    const x = c + c;
    const y = "<" + c + ">";
    t = (t * 3 + digest(x) + digest(y)) | 0;
    if (w.length % 50 === 0) {
      t = (t + digest(w)) | 0;
      w = "";
    }
  }
  return (t + digest(w)) | 0;
}

/** The same unit made each way is `===`, and units either side of 256 aren't. */
export function sameEachWay(n: number): number {
  let t = 0;
  const s = "aéÿĀāz";
  for (let k = 0; k < n; k++)
    for (let i = 0; i < s.length; i++) {
      const u = s.charCodeAt(i);
      const a = String.fromCharCode(u);
      const b = s.charAt(i);
      if (a === b) t = (t + 1) | 0;
      if (a === String.fromCharCode(u ^ 1)) t = (t + 1000) | 0;
      t = (t * 3 + a.charCodeAt(0)) | 0;
    }
  return t;
}
