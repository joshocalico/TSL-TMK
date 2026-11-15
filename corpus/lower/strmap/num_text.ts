// Numbers to text and back, against V8. Random doubles come from a generator both sides run, and a digest over the text
// shows any one difference. The `case` functions print single values, so a difference can be found by bisecting.
function next(st: Uint32Array): number {
  let x = st[0]!;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  st[0] = x;
  return x >>> 0;
}

/** A double from random bits, in the given exponent range. kind 0: uniform bits. 1: near 1. 2: subnormal. 3: integers past 2^53. 4: short decimals. */
function randomDouble(st: Uint32Array, kind: number): number {
  const hi = next(st);
  const lo = next(st);
  if (kind === 4) return ((hi % 2000001) - 1000000) / [1, 10, 100, 1000, 10000, 3, 7][lo % 7]!;
  const m = (hi & 0xfffff) * 4294967296 + lo;
  const sign = hi >= 0x80000000 ? -1 : 1;
  if (kind === 2) return sign * m * scale(-1074);
  let e: number;
  if (kind === 0) e = ((hi >>> 20) & 0x7ff) % 2047;
  else if (kind === 1) e = 1023 - 8 + (lo & 15);
  else e = 1023 + 53 + (lo & 31);
  if (e === 0) return sign * m * scale(-1074);
  return sign * (m + 4503599627370496) * scale(e - 1075 + 52 - 52);
}

/** 2^e exactly, for any e a double can hold, multiplying through a range that never rounds. */
function scale(e: number): number {
  let r = 1;
  let k = e;
  while (k > 0) {
    r *= 2;
    k--;
  }
  while (k < 0) {
    r /= 2;
    k++;
  }
  return r;
}

function digestInto(h: number, s: string): number {
  let d = h;
  for (let i = 0; i < s.length; i++) d = Math.imul(d ^ s.charCodeAt(i), 16777619);
  return d;
}

export function digestToString(seed: number, n: number, kind: number): number {
  const st = new Uint32Array(1);
  st[0] = seed;
  let h = 2166136261;
  for (let i = 0; i < n; i++) h = digestInto(h, String(randomDouble(st, kind)));
  return h;
}

/** Text to number: each double's own text must read back to it, and truncated or noisy text must read as V8 reads it. */
export function digestRoundTrip(seed: number, n: number, kind: number): number {
  const st = new Uint32Array(1);
  st[0] = seed;
  let h = 2166136261;
  for (let i = 0; i < n; i++) {
    const x = randomDouble(st, kind);
    const s = String(x);
    const y = Number(s);
    if (y !== x && x === x) return -1 - i;
    const z = parseFloat(`${s}1`);
    h = digestInto(h, String(z));
    h = digestInto(h, String(Number(s.slice(0, Math.max(1, s.length - 2)))));
  }
  return h;
}

export function digestDecimal(seed: number, n: number): number {
  const st = new Uint32Array(1);
  st[0] = seed;
  let h = 2166136261;
  const digits = "0123456789";
  for (let i = 0; i < n; i++) {
    const nd = 1 + (next(st) % 40);
    let s = "";
    for (let k = 0; k < nd; k++) {
      s += digits[next(st) % 10]!;
      if (k === 0) s += ".";
    }
    const e = (next(st) % 660) - 340;
    s += `e${e}`;
    h = digestInto(h, String(Number(s)));
  }
  return h;
}

export function digestFixed(seed: number, n: number): number {
  const st = new Uint32Array(1);
  st[0] = seed;
  let h = 2166136261;
  for (let i = 0; i < n; i++) {
    const x = randomDouble(st, next(st) % 5);
    h = digestInto(h, x.toFixed(next(st) % 21));
  }
  return h;
}

export function digestRadix(seed: number, n: number): number {
  const st = new Uint32Array(1);
  st[0] = seed;
  let h = 2166136261;
  for (let i = 0; i < n; i++) {
    const kind = [1, 2, 4][next(st) % 3]!;
    const x = randomDouble(st, kind);
    const r = 2 + (next(st) % 35);
    h = digestInto(h, x.toString(r));
  }
  return h;
}

export function digestParseInt(seed: number, n: number): number {
  const st = new Uint32Array(1);
  st[0] = seed;
  let h = 2166136261;
  const alpha = "0123456789abcdefghijklmnopqrstuvwxyzABC";
  for (let i = 0; i < n; i++) {
    const r = 2 + (next(st) % 35);
    const exact = r === 10 || (r & (r - 1)) === 0;
    const nd = exact ? 1 + (next(st) % 40) : 1 + (next(st) % 9);
    let s = "";
    for (let k = 0; k < nd; k++) s += alpha[next(st) % alpha.length]!;
    h = digestInto(h, String(parseInt(s, r)));
    if (s.length < 3 || s[1] !== "x") h = digestInto(h, String(parseInt(`0x${s}`)));
  }
  return h;
}

export function text(x: number): string {
  return String(x);
}
export function concatNum(x: number): string {
  return `${x}`;
}
export function toStr(x: number): string {
  return x.toString();
}
export function fixed(x: number, d: number): string {
  return x.toFixed(d);
}
export function radix(x: number, r: number): string {
  return x.toString(r);
}
export function back(s: string): number {
  return Number(s);
}
export function pf(s: string): number {
  return parseFloat(s);
}
export function pi(s: string, r: number): number {
  return parseInt(s, r);
}
export function ints(a: number): string {
  return String(a | 0);
}
