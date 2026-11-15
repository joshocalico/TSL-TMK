// pop, shift, splice, `length = 0` and overwriting elements: what's taken out is released, and what's still there isn't.
class P {
  constructor(public x: number) {}
}
function churn(): number {
  let s = 0;
  for (let i = 0; i < 64; i++) s += new P(i).x;
  return s;
}
function fill(n: number): P[] {
  const a: P[] = [];
  for (let i = 0; i < n; i++) a.push(new P(i));
  return a;
}
function sum(a: P[]): number {
  let t = 0;
  for (const p of a) t += p.x;
  return t;
}
export function popKeeps(n: number): number {
  const a = fill(n | 0);
  const p = a.pop()!;
  churn();
  return p.x * 1000 + sum(a) + a.length;
}
export function popDiscards(n: number): number {
  const a = fill(n | 0);
  a.pop();
  a.pop();
  churn();
  return sum(a) + a.length;
}
export function popEmpty(): number {
  const a: P[] = [];
  const p = a.pop();
  return p === undefined ? -1 : p.x;
}
export function shiftKeeps(n: number): number {
  const a = fill(n | 0);
  const p = a.shift()!;
  churn();
  return p.x * 1000 + sum(a) + a.length;
}
export function shiftEmpty(): number {
  const a: P[] = [];
  const p = a.shift();
  return p === undefined ? -1 : p.x;
}
export function shiftQueue(n: number): number {
  const q: P[] = [];
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    q.push(new P(i));
    q.push(new P(i + 1));
    t += q.shift()!.x;
  }
  while (q.length > 0) t += q.shift()!.x;
  return t;
}
export function shiftScalars(n: number): number {
  const q: number[] = [];
  for (let i = 0; i < (n | 0); i++) q.push(i * 2);
  let t = 0;
  while (q.length > 0) t = t * 3 + (q.shift() ?? 0);
  return t;
}
export function shiftEmptyScalar(): boolean {
  const q: number[] = [];
  return q.shift() === undefined;
}
export function spliceRemoves(n: number): number {
  const a = fill(n | 0);
  const r = a.splice(1, 2);
  churn();
  return sum(r) * 1000 + sum(a) + a.length * 100000;
}
export function spliceDiscards(n: number): number {
  const a = fill(n | 0);
  a.splice(0, 1);
  churn();
  return sum(a);
}
export function spliceInserts(n: number): number {
  const a = fill(n | 0);
  a.splice(1, 1, new P(50), new P(60), new P(70));
  churn();
  return sum(a) * 100 + a.length;
}
export function spliceInsertsOnly(n: number): number {
  const a = fill(n | 0);
  const r = a.splice(2, 0, new P(50));
  churn();
  return sum(a) * 100 + a.length + r.length * 7;
}
export function spliceToEnd(n: number): number {
  const a = fill(n | 0);
  const r = a.splice(2);
  churn();
  return sum(r) * 100 + a.length;
}
export function spliceNegative(n: number): number {
  const a = fill(n | 0);
  const r = a.splice(-2, 1);
  churn();
  return r[0]!.x * 100 + a.length;
}
export function spliceScalars(n: number): number {
  const a: number[] = [];
  for (let i = 0; i < (n | 0); i++) a.push(i);
  const r = a.splice(1, 2, 90, 91, 92);
  let t = 0;
  for (const x of a) t = t * 2 + x;
  return t * 10 + r.length;
}
export function lengthZero(n: number): number {
  const a = fill(n | 0);
  const first = a[0]!;
  a.length = 0;
  churn();
  return first.x + a.length;
}
export function lengthShrinks(n: number): number {
  const a = fill(n | 0);
  a.length = 2;
  churn();
  return sum(a) + a.length * 10;
}
export function lengthGrows(n: number): number {
  const a = fill(n | 0);
  a.length = 10;
  a[9] = new P(5);
  let holes = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === undefined) holes++;
  return holes * 100 + a[9]!.x;
}
export function lengthScalars(n: number): number {
  const a: number[] = [];
  for (let i = 0; i < (n | 0); i++) a.push(i);
  a.length = 1;
  a.push(9);
  return a.length * 100 + a[1]!;
}
export function overwrite(n: number): number {
  const a = fill(n | 0);
  a[0] = new P(100);
  a[1] = a[0];
  churn();
  return a[0].x + a[1].x;
}
export function fillOverwrites(n: number): number {
  const a = fill(n | 0);
  const p = new P(3);
  a.fill(p);
  churn();
  return sum(a);
}
export function typedArrayField(n: number): number {
  const o = { b: new Float64Array(4), c: new Uint8Array(8) };
  o.b[1] = n | 0;
  const view = o.c.subarray(2, 4);
  view[0] = 9;
  o.c = new Uint8Array(1);
  churn();
  return o.b[1]! + view[0]! + view.length;
}
