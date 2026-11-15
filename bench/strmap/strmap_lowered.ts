// What `tmk bench strmap` measures: ordinary TS, natively in `rc` and on V8. Each takes a size and gives a digest, which the
// harness compares across engines, so the work can't be optimised away and can't silently differ.
function lcg(x: number): number {
  return (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
}
const WORDS: string[] = [];
function vocab(): string[] {
  if (WORDS.length > 0) return WORDS;
  for (let i = 0; i < 500; i++) WORDS.push(`w${i * 7}x`);
  return WORDS;
}

export function concatWork(n: number): number {
  let s = "";
  for (let i = 0; i < n; i++) s += "abcdefgh"[i & 7]!;
  return (s.length + s.charCodeAt(n >> 1)) | 0;
}

export function concatSmall(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) {
    const s = "key" + (i & 1 ? "-" : "+") + "value";
    t = (t + s.length) | 0;
  }
  return t;
}

export function splitJoinWork(n: number): number {
  const parts: string[] = [];
  let x = 1;
  const v = vocab();
  for (let i = 0; i < n; i++) {
    x = lcg(x);
    parts.push(v[x % 500]!);
  }
  const text = parts.join(" ");
  return text.split(" ").join("-").length | 0;
}

export function numTextShort(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) t = (t + String(i * 0.25).length) | 0;
  return t;
}

export function numTextRandom(n: number): number {
  let t = 0;
  let x = 1;
  for (let i = 0; i < n; i++) {
    x = lcg(x);
    t = (t + String((x * 3.7) / 1024).length) | 0;
  }
  return t;
}

export function intText(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) t = (t + String(i).length) | 0;
  return t;
}

export function textNum(n: number): number {
  let t = 0;
  let x = 1;
  for (let i = 0; i < n; i++) {
    x = lcg(x);
    t = (t + (Number(`${x % 100000}.${x % 97}`) | 0)) | 0;
  }
  return t;
}

export function mapMix(n: number): number {
  const m = new Map<number, number>();
  const range = (n >> 1) + 1;
  let x = 1;
  let h = 0;
  for (let i = 0; i < n; i++) {
    x = lcg(x);
    const k = x % range;
    const op = (x >>> 27) & 3;
    if (op <= 1) m.set(k, i);
    else if (op === 2) {
      const v = m.get(k);
      if (v !== undefined) h = (h + v) | 0;
    } else m.delete(k);
  }
  return (h + m.size) | 0;
}

export function mapStrMix(n: number): number {
  const v = vocab();
  const m = new Map<string, number>();
  let x = 1;
  let h = 0;
  for (let i = 0; i < n; i++) {
    x = lcg(x);
    const k = v[x % 500]!;
    const op = (x >>> 27) & 3;
    if (op <= 1) m.set(k, i);
    else if (op === 2) {
      const got = m.get(k);
      if (got !== undefined) h = (h + got) | 0;
    } else m.delete(k);
  }
  return (h + m.size) | 0;
}

export function wordCount(n: number): number {
  const v = vocab();
  let text = "";
  let x = 1;
  for (let i = 0; i < n; i++) {
    x = lcg(x);
    text += v[x % 500]!;
    text += " ";
  }
  const m = new Map<string, number>();
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 32) {
      const w = text.slice(start, i);
      m.set(w, (m.get(w) ?? 0) + 1);
      start = i + 1;
    }
  }
  let t = 0;
  for (const c of m.values()) t = (t + c * c) | 0;
  return t;
}

export function setDedupe(n: number): number {
  const s = new Set<number>();
  let x = 1;
  for (let i = 0; i < n; i++) {
    x = lcg(x);
    s.add(x % (n >> 2));
  }
  let t = 0;
  for (const k of s) t = (t + k) | 0;
  return t;
}

/** Two sizes either side of a doubling: the difference is what one growth costs, in one `set`. */
export function mapBuild(n: number): number {
  const m = new Map<number, number>();
  for (let i = 0; i < n; i++) m.set(i, i);
  return m.size;
}
