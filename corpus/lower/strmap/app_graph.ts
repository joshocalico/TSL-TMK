// Graph algorithms on Map<number, number[]>, group-by and dedupe.
type Graph = Map<number, number[]>;

function makeGraph(n: number, seed: number): Graph {
  const g: Graph = new Map<number, number[]>();
  let x = seed;
  for (let i = 0; i < n; i++) g.set(i, []);
  for (let i = 0; i < n * 3; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const a = x % n;
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const b = x % n;
    g.get(a)!.push(b);
    g.get(b)!.push(a);
  }
  return g;
}

export function bfs(n: number, seed: number): number[] {
  const g = makeGraph(n, seed);
  const dist = new Map<number, number>();
  dist.set(0, 0);
  const q: number[] = [0];
  let head = 0;
  while (head < q.length) {
    const u = q[head++]!;
    const d = dist.get(u)!;
    for (const v of g.get(u)!) {
      if (!dist.has(v)) {
        dist.set(v, d + 1);
        q.push(v);
      }
    }
  }
  let far = 0;
  for (const d of dist.values()) if (d > far) far = d;
  return [dist.size, far, q[q.length - 1]!];
}

export function dfsOrder(n: number, seed: number): number[] {
  const g = makeGraph(n, seed);
  const seen = new Set<number>();
  const order: number[] = [];
  const visit = (u: number): void => {
    seen.add(u);
    order.push(u);
    for (const v of g.get(u)!) if (!seen.has(v)) visit(v);
  };
  visit(0);
  return order.slice(0, 10);
}

export function components(n: number, seed: number): number {
  const g = new Map<number, number[]>();
  let x = seed;
  for (let i = 0; i < n; i++) g.set(i, []);
  for (let i = 0; i < n / 2; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const a = x % n;
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const b = x % n;
    g.get(a)!.push(b);
    g.get(b)!.push(a);
  }
  const seen = new Set<number>();
  let count = 0;
  for (const start of g.keys()) {
    if (seen.has(start)) continue;
    count++;
    const stack = [start];
    while (stack.length > 0) {
      const u = stack.pop()!;
      if (seen.has(u)) continue;
      seen.add(u);
      for (const v of g.get(u)!) stack.push(v);
    }
  }
  return count;
}

export function dedupe(a: string[]): string[] {
  return [...new Set(a)];
}
export function dedupeNums(a: number[]): number[] {
  return Array.from(new Set(a));
}

class Rec {
  constructor(
    public city: string,
    public age: number,
  ) {}
}
export function groupBy(cities: string[], ages: number[]): string[] {
  const recs = cities.map((c, i) => new Rec(c, ages[i]!));
  const groups = new Map<string, Rec[]>();
  for (const r of recs) {
    const g = groups.get(r.city);
    if (g === undefined) groups.set(r.city, [r]);
    else g.push(r);
  }
  const out: string[] = [];
  for (const [city, rs] of groups) {
    const total = rs.reduce((t, r) => t + r.age, 0);
    out.push(`${city}: ${rs.length} avg ${(total / rs.length).toFixed(2)}`);
  }
  return out;
}
export function invert(m: Map<string, number>): Map<number, string[]> {
  const out = new Map<number, string[]>();
  m.forEach((v, k) => {
    const l = out.get(v) ?? [];
    l.push(k);
    out.set(v, l);
  });
  return out;
}
