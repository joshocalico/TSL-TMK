// toUpperCase and toLowerCase against V8: every code point, a digest per block, and the sigma's context.
function hash(h: number, s: string): number {
  let d = h;
  for (let i = 0; i < s.length; i++) d = Math.imul(d ^ s.charCodeAt(i), 16777619);
  return d;
}
export function block(from: number, to: number): number {
  let h = 2166136261;
  for (let cp = from; cp < to; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const s = String.fromCodePoint(cp);
    h = hash(h, s.toUpperCase());
    h = hash(h, s.toLowerCase());
  }
  return h;
}
export function lower(s: string): string {
  return s.toLowerCase();
}
export function upper(s: string): string {
  return s.toUpperCase();
}
export function sigmaRandom(seed: number, n: number): number {
  const alpha = ["Σ", "A", "b", " ", ".", "'", "ͅ", "­", "1", "𐐀", "\ud800", "ß", "ﬁ", "İ"];
  let x = seed;
  let h = 2166136261;
  for (let i = 0; i < n; i++) {
    let s = "";
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    const len = x % 8;
    for (let k = 0; k < len; k++) {
      x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
      s += alpha[(x >>> 8) % alpha.length]!;
    }
    h = hash(hash(h, s.toLowerCase()), s.toUpperCase());
  }
  return h;
}
