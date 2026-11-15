// Ordinary text programs, of the kind nobody writes with this compiler in mind.
export function anagrams(words: string[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const w of words) {
    const key = w.split("").sort().join("");
    const g = groups.get(key);
    if (g) g.push(w);
    else groups.set(key, [w]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

export function levenshtein(a: string, b: string): number {
  let prev: number[] = [];
  for (let j = 0; j <= b.length; j++) prev.push(j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur.push(Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

const ROMAN: [number, string][] = [
  [1000, "M"],
  [900, "CM"],
  [500, "D"],
  [400, "CD"],
  [100, "C"],
  [90, "XC"],
  [50, "L"],
  [40, "XL"],
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
];
export function roman(n: number): string {
  let out = "";
  let left = n;
  for (const [v, s] of ROMAN) {
    while (left >= v) {
      out += s;
      left -= v;
    }
  }
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function base64(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i += 3) {
    const a = s.charCodeAt(i) & 255;
    const b = i + 1 < s.length ? s.charCodeAt(i + 1) & 255 : 0;
    const c = i + 2 < s.length ? s.charCodeAt(i + 2) & 255 : 0;
    const x = (a << 16) | (b << 8) | c;
    out += B64[(x >> 18) & 63]! + B64[(x >> 12) & 63]!;
    out += i + 1 < s.length ? B64[(x >> 6) & 63]! : "=";
    out += i + 2 < s.length ? B64[x & 63]! : "=";
  }
  return out;
}

class Row {
  cells: string[] = [];
  get(i: number): string {
    return this.cells[i] ?? "";
  }
}
export function csv(text: string): string[] {
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const r = new Row();
    let cur = "";
    let quoted = false;
    for (const c of line) {
      if (c === '"') quoted = !quoted;
      else if (c === "," && !quoted) {
        r.cells.push(cur);
        cur = "";
      } else cur += c;
    }
    r.cells.push(cur);
    rows.push(r);
  }
  const header = rows[0]!;
  const index = new Map<string, number>();
  header.cells.forEach((h, i) => {
    index.set(h, i);
  });
  const out: string[] = [];
  for (const r of rows.slice(1)) {
    const name = r.get(index.get("name") ?? 0);
    const age = Number(r.get(index.get("age") ?? 1));
    out.push(
      `${name.toUpperCase()} is ${age >= 18 ? "an adult" : "a minor"} (${(age / 7).toFixed(1)})`,
    );
  }
  return out;
}

export function capitalize(s: string): string {
  return s
    .split(" ")
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}

export function histogram(s: string): string {
  const m = new Map<string, number>();
  for (const c of s) m.set(c, (m.get(c) ?? 0) + 1);
  const keys = Array.from(m.keys()).sort();
  return keys.map((k) => `${k}:${"#".repeat(m.get(k)!)}`).join(" ");
}

interface Item {
  name: string;
  tags: string[];
  price: number;
}
export function inventory(): string[] {
  const items: Item[] = [
    { name: "pen", tags: ["office", "cheap"], price: 1.5 },
    { name: "desk", tags: ["office"], price: 150 },
    { name: "apple", tags: ["food", "cheap"], price: 0.25 },
  ];
  const byTag = new Map<string, Item[]>();
  for (const it of items) {
    for (const t of it.tags) {
      const l = byTag.get(t) ?? [];
      l.push(it);
      byTag.set(t, l);
    }
  }
  const out: string[] = [];
  for (const [t, l] of byTag) {
    const total = l.reduce((a, b) => a + b.price, 0);
    out.push(`${t}: ${l.map((x) => x.name).join("+")} = ${total}`);
  }
  return out;
}

function fib(n: number, memo: Map<number, number>): number {
  if (n < 2) return n;
  const hit = memo.get(n);
  if (hit !== undefined) return hit;
  const r = fib(n - 1, memo) + fib(n - 2, memo);
  memo.set(n, r);
  return r;
}
export function memoFib(n: number): number {
  return fib(n, new Map<number, number>());
}

export function topoSort(edges: [string, string][]): string[] {
  const out = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const [a, b] of edges) {
    if (!out.has(a)) out.set(a, []);
    if (!out.has(b)) out.set(b, []);
    out.get(a)!.push(b);
    indeg.set(b, (indeg.get(b) ?? 0) + 1);
    if (!indeg.has(a)) indeg.set(a, 0);
  }
  const q: string[] = [];
  for (const [k, d] of indeg) if (d === 0) q.push(k);
  const order: string[] = [];
  while (q.length > 0) {
    const u = q.shift()!;
    order.push(u);
    for (const v of out.get(u)!) {
      const d = indeg.get(v)! - 1;
      indeg.set(v, d);
      if (d === 0) q.push(v);
    }
  }
  return order;
}

class Trie {
  kids = new Map<string, Trie>();
  end = false;
  add(w: string): void {
    let t: Trie = this;
    for (const c of w) {
      let k = t.kids.get(c);
      if (k === undefined) {
        k = new Trie();
        t.kids.set(c, k);
      }
      t = k;
    }
    t.end = true;
  }
  words(prefix: string, out: string[]): void {
    if (this.end) out.push(prefix);
    for (const [c, k] of this.kids) k.words(prefix + c, out);
  }
}
export function trie(words: string[]): string[] {
  const t = new Trie();
  for (const w of words) t.add(w);
  const out: string[] = [];
  t.words("", out);
  return out;
}
