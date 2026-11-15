// String keys (strkeys, D72): `Map<string, …>` and `Set<string>` printed as @tsl/jsrt's JsMap and JsSet over JsString keys,
// which keyHash and keySame reach through the string's class id (D70): its hashKey D42's keyed HalfSipHash, its sameKey
// its units. Non-ASCII, a surrogate pair, lone surrogates and the empty string, in arguments and literals, and keys equal
// by content but made apart: sliced, joined, built a unit at a time, flat and as views.
function mix(h: number, x: number): number {
  return Math.imul(h ^ x, 16777619) >>> 0;
}

function codeOf(s: string): number {
  let c = s.length;
  for (let i = 0; i < s.length; i++) c = mix(c, s.charCodeAt(i));
  return c;
}

/** Each space-separated word counted: every key is a slice, so a key and its next lookup are different objects. */
export function wordCounts(text: string): number {
  const m = new Map<string, number>();
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text.charCodeAt(i) === 32) {
      const w = text.slice(start, i);
      m.set(w, (m.get(w) ?? 0) + 1);
      start = i + 1;
    }
  }
  let h = mix(0, m.size);
  for (const [k, v] of m) h = mix(mix(h, codeOf(k)), v);
  return h;
}

/** The awkward keys as literals, looked up by the arguments, by pieces joined, and by a pair made from its halves. */
export function lookups(a: string, b: string): number {
  const m = new Map<string, number>();
  m.set("", 1);
  m.set("héllo", 2);
  m.set("😀", 3);
  m.set("\ud800", 4);
  m.set("\udc00", 5);
  m.set("a\ud800", 6);
  m.set(a, 7);
  let h = mix(0, m.size);
  h = mix(h, m.get(a) ?? 99);
  h = mix(h, m.get(b) ?? 98);
  h = mix(h, m.get(a + b) ?? 97);
  h = mix(h, m.get(b + "llo") ?? 96);
  h = mix(h, m.get(a.slice(0, 1) + b) ?? 95);
  h = mix(h, m.has(a.slice(0, 0)) ? 1 : 0);
  h = mix(h, m.delete(b) ? 1 : 0);
  m.set(b + b, 8);
  h = mix(h, m.get(b + b) ?? 94);
  for (const [k, v] of m) h = mix(mix(h, codeOf(k)), v);
  return h;
}

/** Long keys: 40-unit slices of a long string, views of it, looked up by the same text built a unit at a time. */
export function views(s: string, n: number): number {
  const m = new Map<string, number>();
  let long = "";
  for (let i = 0; i < n; i++) long += s;
  for (let i = 0; i + 40 <= long.length; i += 7) m.set(long.slice(i, i + 40), i);
  let h = mix(0, m.size);
  for (let i = 0; i + 40 <= long.length; i += 5) {
    let c = "";
    for (let j = i; j < i + 40; j++) c += long[j]!;
    h = mix(h, m.get(c) ?? 1234);
    if (i % 3 === 0) h = mix(h, m.delete(c) ? 1 : 0);
  }
  for (const [k, v] of m) h = mix(mix(h, codeOf(k)), v);
  return h;
}

/** A Set of strings, one entry per text: each word added as a slice and as a copy, then iterated and deleted from. */
export function stringSet(text: string, n: number): number {
  const s = new Set<string>();
  for (let r = 0; r < n; r++) {
    let start = 0;
    for (let i = 0; i <= text.length; i++) {
      if (i === text.length || text.charCodeAt(i) === 32) {
        s.add(text.slice(start, i));
        s.add(text.slice(start, i) + "");
        start = i + 1;
      }
    }
    s.add(`${r % 5}`);
  }
  let h = mix(0, s.size);
  for (const k of s) h = mix(h, codeOf(k));
  h = mix(h, s.delete("") ? 1 : 0);
  h = mix(h, s.has("0") ? 1 : 0);
  return mix(h, s.size);
}

/** String values beside number keys, and keys that differ only in their last unit, which a hash must tell apart. */
export function lastUnit(prefix: string, n: number): number {
  const m = new Map<string, string>();
  for (let i = 0; i < n; i++) m.set(prefix + String.fromCharCode(0xd7f0 + (i % 32)), `${i}`);
  let h = mix(0, m.size);
  for (let i = 0; i < 40; i++) {
    const v = m.get(prefix + String.fromCharCode(0xd7f0 + i));
    h = mix(h, v === undefined ? 7777 : codeOf(v));
  }
  for (const [k, v] of m) h = mix(mix(h, codeOf(k)), codeOf(v));
  return h;
}
