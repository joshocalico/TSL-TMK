// `Map` and `Set`: SameValueZero, insertion order, every method, every way of iterating, keys of every kind.
class Obj {
  constructor(public id: number) {}
}

export function basics(): number[] {
  const m = new Map<number, number>();
  m.set(1, 10).set(2, 20).set(3, 30);
  const a = m.get(2)!;
  const had = m.has(9) ? 1 : 0;
  const del = m.delete(1) ? 1 : 0;
  const delAgain = m.delete(1) ? 1 : 0;
  return [a, had, del, delAgain, m.size, m.get(1) === undefined ? -1 : 0];
}
export function sameValueZero(): (number | undefined)[] {
  const m = new Map<number, number>();
  m.set(NaN, 1);
  m.set(0, 2);
  m.set(-0, 3);
  m.set(1.5, 4);
  const out: (number | undefined)[] = [
    m.get(NaN),
    m.get(0),
    m.get(-0),
    m.get(1.5),
    m.get(2.5),
    m.size,
  ];
  for (const k of m.keys()) out.push(1 / k);
  return out;
}
export function setSameValueZero(): number[] {
  const s = new Set<number>([NaN, NaN, 0, -0, 1, 1, 2]);
  const out: number[] = [s.size];
  for (const k of s) out.push(1 / k);
  return out;
}
export function strKeys(): string[] {
  const m = new Map<string, number>();
  m.set("a", 1);
  m.set("é", 2);
  m.set("a" + "", 3);
  m.set("x".repeat(100), 4);
  m.set("x".repeat(50) + "x".repeat(50), 5);
  m.set("", 6);
  m.set("\ud800", 7);
  const out: string[] = [];
  for (const [k, v] of m) out.push(`${k.length > 10 ? "long" : k}=${v}`);
  return out;
}
export function boolKeys(): number[] {
  const m = new Map<boolean, number>();
  m.set(true, 1);
  m.set(false, 2);
  m.set(true, 3);
  return [m.get(true)!, m.get(false)!, m.size];
}
export function objKeys(): number[] {
  const a = new Obj(1);
  const b = new Obj(1);
  const m = new Map<Obj, number>();
  m.set(a, 10);
  m.set(b, 20);
  m.set(a, 30);
  const out = [m.get(a)!, m.get(b)!, m.size];
  for (const k of m.keys()) out.push(k.id);
  return out;
}
export function arrKeys(): number {
  const a = [1];
  const b = [1];
  const s = new Set<number[]>();
  s.add(a);
  s.add(b);
  s.add(a);
  return s.size + (s.has(a) ? 10 : 0) + (s.has([1]) ? 100 : 0);
}
export function nullKeys(): (number | undefined)[] {
  const m = new Map<string | null, number>();
  m.set(null, 1);
  m.set("null", 2);
  m.set("", 3);
  return [m.get(null), m.get("null"), m.get(""), m.size];
}
export function undefKeys(): (number | undefined)[] {
  const m = new Map<number | undefined, number>();
  m.set(undefined, 1);
  m.set(0, 2);
  m.set(NaN, 3);
  return [m.get(undefined), m.get(0), m.get(NaN), m.size];
}
export function iterAll(): string[] {
  const m = new Map<string, number>([
    ["a", 1],
    ["b", 2],
    ["c", 3],
  ]);
  const out: string[] = [];
  for (const [k, v] of m) out.push(`e${k}${v}`);
  for (const k of m.keys()) out.push(`k${k}`);
  for (const v of m.values()) out.push(`v${v}`);
  for (const [k, v] of m.entries()) out.push(`n${k}${v}`);
  m.forEach((v, k) => {
    out.push(`f${k}${v}`);
  });
  for (const e of m) out.push(`w${e[0]}${e[1]}`);
  return out;
}
export function setAll(): string[] {
  const s = new Set<string>(["x", "y"]);
  const out: string[] = [];
  for (const v of s) out.push(v);
  for (const v of s.keys()) out.push(v);
  for (const v of s.values()) out.push(v);
  for (const [a, b] of s.entries()) out.push(a + b);
  s.forEach((v) => {
    out.push(`f${v}`);
  });
  return out;
}
export function spreads(): number[][] {
  const m = new Map<number, number>([
    [1, 2],
    [3, 4],
  ]);
  const s = new Set<number>([5, 6, 5]);
  return [
    [...m.keys()],
    [...m.values()],
    [...s],
    Array.from(s),
    Array.from(m.values()),
    Array.from(s, (x) => x * 2),
  ];
}
export function spreadPairs(): [number, string][] {
  const m = new Map<number, string>([
    [1, "a"],
    [2, "b"],
  ]);
  return [...m];
}
export function arrayFromMap(): [string, number][] {
  const m = new Map<string, number>([
    ["a", 1],
    ["b", 2],
  ]);
  return Array.from(m);
}
export function fromMap(): number[] {
  const m = new Map<number, number>([[1, 2]]);
  const n = new Map(m);
  n.set(3, 4);
  const s = new Set(m.keys());
  const t = new Set(s);
  t.add(9);
  return [m.size, n.size, s.size, t.size];
}
export function explicitIter(): string {
  const m = new Map<number, number>([
    [1, 10],
    [2, 20],
  ]);
  const it = m.keys();
  const a = it.next();
  const b = it.next();
  const c = it.next();
  m.set(3, 30);
  const d = it.next();
  return `${a.done} ${a.value} ${b.done} ${b.value} ${c.done} ${c.value} ${d.done} ${d.value}`;
}
export function firstKey(): number | undefined {
  const m = new Map<number, number>([
    [7, 1],
    [8, 2],
  ]);
  return m.keys().next().value;
}
export function firstOfEmpty(): number | undefined {
  const m = new Map<number, number>();
  return m.keys().next().value;
}
export function narrowDone(): number {
  const it = new Set<number>([4]).values();
  const r = it.next();
  if (!r.done) return r.value + 1;
  return -1;
}
export function entriesIter(): string[] {
  const m = new Map<string, number>([["a", 1]]);
  const it = m.entries();
  const out: string[] = [];
  for (;;) {
    const r = it.next();
    if (r.done) break;
    const [k, v] = r.value;
    out.push(k + v);
  }
  return out;
}
export function growAndDelete(n: number): number[] {
  const m = new Map<number, number>();
  for (let i = 0; i < n; i++) m.set(i, i * 2);
  for (let i = 0; i < n; i += 2) m.delete(i);
  for (let i = n; i < n + n / 2; i++) m.set(i, i);
  let sum = 0;
  let first = -1;
  let count = 0;
  for (const [k, v] of m) {
    if (first < 0) first = k;
    sum += v;
    count++;
  }
  return [m.size, first, sum, count];
}
export function clearAndReuse(): number[] {
  const m = new Map<string, number>();
  for (let i = 0; i < 50; i++) m.set(`k${i}`, i);
  m.clear();
  const a = m.size;
  m.set("again", 1);
  return [a, m.size, m.get("again")!, m.has("k1") ? 1 : 0];
}
export function arg(m: Map<string, number>, k: string): number {
  return m.get(k) ?? -1;
}
export function argSet(s: Set<number>, k: number): boolean {
  return s.has(k);
}
export function roundTrip(m: Map<string, number>): Map<string, number> {
  m.set("added", 99);
  m.delete("gone");
  return m;
}
export function makeSet(a: string[]): Set<string> {
  return new Set(a);
}
export function makeMap(a: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of a) m.set(s, (m.get(s) ?? 0) + 1);
  return m;
}
export function holdsMaps(): number {
  const m = new Map<string, Map<number, number>>();
  m.set("a", new Map<number, number>([[1, 1]]));
  m.get("a")!.set(2, 2);
  return m.get("a")!.size;
}
export function tuples(): string {
  const t: [string, number] = ["a", 1];
  const [s, n] = t;
  return `${s}${n}${t[0]}${t[1]}`;
}
export function sortPairs(): [string, number][] {
  const m = new Map<string, number>([
    ["a", 3],
    ["b", 1],
    ["c", 2],
    ["d", 1],
  ]);
  return [...m].sort((x, y) => x[1] - y[1]);
}
export function sortDefault(): string[][] {
  return [["b", "a", "é", "B"].sort(), [10, 9, 1].map((x) => String(x)).sort()];
}
export function sortNums(): number[] {
  return [10, 9, 1, 100].sort();
}
export function revConcat(): number[] {
  return [1, 2].reverse().concat([3], [4, 5]);
}
/** Addresses change with what was allocated first, and nothing that comes out may. */
export function addressFree(junk: number, n: number): string {
  const hold: Obj[] = [];
  for (let i = 0; i < junk; i++) hold.push(new Obj(-i));
  const keys: Obj[] = [];
  for (let i = 0; i < n; i++) {
    keys.push(new Obj(i));
    if (i % 3 === 0) hold.push(new Obj(i));
  }
  const m = new Map<Obj, number>();
  const s = new Set<Obj>();
  for (let i = n - 1; i >= 0; i--) {
    m.set(keys[i]!, i);
    s.add(keys[(i * 7) % n]!);
  }
  for (let i = 0; i < n; i += 5) m.delete(keys[i]!);
  let out = "";
  for (const [k, v] of m) out += `${k.id}:${v},`;
  for (const k of s) out += `${k.id};`;
  return out + hold.length;
}
