// Strings under `leak` and `manual`, for the strings' step of class printing (D67): `tmk bench memory --classes
// --strings` runs each through both routes. strmap's string work without its maps and number text, sized so 121 runs fit a bench image that frees nothing, which class printing
// doesn't take yet: appends of one unit (the shared tail), short joins of literals (the flat copy), substrings that share
// and that copy, a scan by unit, equality, and split and join. Each takes a size and gives a digest.
export function appendWork(n: number): number {
  let s = "";
  for (let i = 0; i < n; i++) s += "abcdefgh"[i & 7]!;
  return (s.length + s.charCodeAt(n >> 1)) | 0;
}

export function joinSmall(n: number): number {
  let t = 0;
  for (let i = 0; i < n >> 2; i++) {
    const s = "key" + (i & 1 ? "-" : "+") + "value";
    t = (t + s.length + s.charCodeAt(3)) | 0;
  }
  return t;
}

export function subWork(n: number): number {
  let s = "";
  for (let i = 0; i < n; i++) s += "the quick brown fox "[i % 20]!;
  let t = 0;
  for (let i = 0; i + 48 < s.length; i += 12) {
    const a = s.slice(i, i + 48);
    const b = s.substring(i + 4, i + 9);
    const c = a.slice(4, 9);
    if (b === c) t = (t + 1) | 0;
    t = (t + a.charCodeAt(7) + b.length) | 0;
  }
  return t;
}

export function scanWork(n: number): number {
  let s = "";
  for (let i = 0; i < n >> 2; i++) s += "é😀ab"[i & 3]!;
  let t = 0;
  for (let k = 0; k < 4; k++) for (let i = 0; i < s.length; i++) t = (t * 31 + s.charCodeAt(i)) | 0;
  let p = 0;
  for (const c of s) p = (p + c.length) | 0;
  return (t + p) | 0;
}

export function splitJoin(n: number): number {
  let s = "";
  for (let i = 0; i < n; i++) s += "one two three four "[i % 19]!;
  const words = s.split(" ");
  const back = words.join("-");
  let t = words.length;
  for (let i = 0; i < words.length; i++) if (words[i] === "three") t = (t + 1) | 0;
  return (t + back.length) | 0;
}
