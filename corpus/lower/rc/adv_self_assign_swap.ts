// Self-assignment and swaps: a slot's new value must be counted before its old one is let go of.
class N {
  n: N | null = null;
  constructor(public v: number) {}
}
function churn(): number {
  let s = 0;
  for (let i = 0; i < 64; i++) s += new N(i).v;
  return s;
}
export function selfField(k: number): number {
  const x = new N(1);
  x.n = new N(k | 0);
  for (let i = 0; i < 4; i++) x.n = x.n;
  churn();
  return x.n!.v;
}
export function selfLocal(k: number): number {
  let x = new N(k | 0);
  x = x;
  churn();
  return x.v;
}
const g = { a: new N(3) };
export function selfGlobalField(): number {
  g.a = g.a;
  churn();
  return g.a.v;
}
export function selfElement(k: number): number {
  const a = [new N(k | 0)];
  a[0] = a[0]!;
  churn();
  return a[0]!.v;
}
export function swapFields(p: number, q: number): number {
  const a = new N(0);
  const b = new N(0);
  a.n = new N(p | 0);
  b.n = new N(q | 0);
  [a.n, b.n] = [b.n, a.n];
  churn();
  return a.n!.v * 100 + b.n!.v;
}
export function swapLocals(p: number, q: number): number {
  let a = new N(p | 0);
  let b = new N(q | 0);
  [a, b] = [b, a];
  churn();
  return a.v * 100 + b.v;
}
export function swapElements(p: number, q: number): number {
  const a = [new N(p | 0), new N(q | 0)];
  [a[0], a[1]] = [a[1]!, a[0]!];
  churn();
  return a[0]!.v * 100 + a[1]!.v;
}
export function swapByTemp(p: number, q: number): number {
  const a = new N(0);
  const b = new N(0);
  a.n = new N(p | 0);
  b.n = new N(q | 0);
  const t = a.n;
  a.n = b.n;
  b.n = t;
  churn();
  return a.n!.v * 100 + b.n!.v;
}
export function assignThroughOldValue(k: number): number {
  const a = new N(1);
  a.n = new N(2);
  a.n.n = new N(k | 0);
  a.n = a.n.n;
  churn();
  return a.n!.v;
}
export function chained(k: number): number {
  const a = new N(0);
  const b = new N(0);
  a.n = b.n = new N(k | 0);
  churn();
  return a.n!.v + b.n!.v;
}
