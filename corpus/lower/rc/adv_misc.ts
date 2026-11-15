// Everything else that holds a reference: accessors, recursive closures, destructuring, spreads, unions, optional calls,
// arrays of arrays, typed arrays and views on temporaries, labelled loops around closures, module state.
class P {
  constructor(public x: number) {}
  get twice(): P {
    return new P(this.x * 2);
  }
}
class Acc {
  private _p: P = new P(0);
  get p(): P {
    return this._p;
  }
  set p(v: P) {
    this._p = v;
  }
  bump(): Acc {
    this._p = new P(this._p.x + 1);
    return this;
  }
}
class A {
  b = new P(1);
  c: P;
  d: P[] = [new P(2)];
  constructor(n: number) {
    this.c = new P(n);
    this.d.push(this.c);
  }
}
type U = { kind: "a"; p: P } | { kind: "b"; q: P; r: P };
function churn(): number {
  let s = 0;
  for (let i = 0; i < 64; i++) s += new P(i).x;
  return s;
}
function make(n: number): P {
  return new P(n);
}
function maybe(n: number): P | null {
  return n > 0 ? new P(n) : null;
}
export function lifted(n: number): number {
  const p = new P(n | 0);
  const rec = (k: number): number => (k <= 0 ? p.x : rec(k - 1) + p.x);
  return rec(3) + churn() - churn();
}
export function liftedBox(n: number): number {
  let p = new P(n | 0);
  const rec = (k: number): number => {
    if (k <= 0) return p.x;
    p = new P(p.x + 1);
    return rec(k - 1);
  };
  return rec(3);
}
export function accessor(n: number): number {
  const a = new Acc();
  a.p = new P(n | 0);
  const q = a.p;
  a.p = new P(1);
  churn();
  return q.x + a.p.x + a.bump().bump().p.x + make(3).twice.twice.x;
}
export function destructure(n: number): number {
  const o = { a: new P(n | 0), b: new P(2) };
  const { a, b } = o;
  o.a = new P(9);
  churn();
  const [x, y = new P(100)] = [a];
  return a.x + b.x + x!.x + y.x;
}
export function spreads(n: number): number {
  const o = { a: new P(n | 0), b: new P(2) };
  const c = { ...o, b: new P(3) };
  const d = { ...c };
  o.a = new P(0);
  c.a = new P(0);
  const arr = [new P(1), new P(2)];
  const brr = [...arr, new P(3), ...arr];
  arr.length = 0;
  churn();
  return d.a.x + d.b.x + brr.length + brr[4]!.x;
}
export function arraysOfArrays(n: number): number {
  const m: P[][] = [];
  for (let i = 0; i < 3; i++) {
    const r: P[] = [];
    for (let j = 0; j < 3; j++) r.push(new P(i * j + (n | 0)));
    m.push(r);
  }
  const first = m[0]!;
  const t = first[2]!;
  m[0] = [];
  first.pop();
  m.shift();
  churn();
  return t.x + m.length + m[0]![1]!.x;
}
export function typedInObjects(n: number): number {
  const o = { a: new Uint8Array(8), v: new Float64Array(2) };
  o.a[3] = n | 0;
  const view = o.a.subarray(2, 6);
  const end = o.a.subarray(8);
  o.a = new Uint8Array(1);
  churn();
  const list = [view, view.subarray(1), new Uint8Array(4).subarray(1)];
  view[0] = 7;
  return list[1]![0]! + list[0]![0]! + list[2]!.length + end.length;
}
function retView(n: number): Uint8Array {
  const b = new Uint8Array(16);
  b[5] = n;
  return b.subarray(4, 8);
}
export function returnedView(n: number): number {
  const v = retView(n | 0);
  churn();
  return v[1]!;
}
export function higherOrder(n: number): number {
  const a = [new P(1), new P(2), new P(n | 0)];
  const big = a.filter((p) => p.x > 1);
  const objs = a.map((p) => ({ p, y: new P(p.x + 1) }));
  const hit = a.find((p) => {
    const t = new P(p.x);
    return t.x === 2;
  });
  const sum = a.reduce((acc, p) => new P(acc.x + p.x), new P(0));
  const every = a.every((p) => {
    const t = make(p.x);
    return t.x > 0;
  });
  const some = a.some((p) => {
    const t = make(p.x);
    return t.x > 100;
  });
  a.length = 0;
  churn();
  return (
    big.length +
    objs[1]!.y.x +
    (hit === undefined ? 0 : hit.x) +
    sum.x +
    (every ? 1 : 0) +
    (some ? 1 : 0)
  );
}
export function unions(n: number): number {
  const mk = (k: number): U =>
    k > 0 ? { kind: "a", p: new P(k) } : { kind: "b", q: new P(5), r: new P(6) };
  let u = mk(n | 0);
  const v = u;
  u = mk(-1);
  churn();
  const f = (w: U): number => (w.kind === "a" ? w.p.x : w.q.x + w.r.x);
  return f(v) * 100 + f(u);
}
export function ternaryStores(n: number): number {
  const a = new A(n | 0);
  const fresh = new P(7);
  a.b = (n | 0) > 1 ? a.c : fresh;
  a.c = (n | 0) > 1 ? new P(8) : a.b;
  const seq = (churn(), a.c);
  a.c = new P(9);
  churn();
  return a.b.x + seq.x + a.d[1]!.x;
}
export function optionalCalls(n: number): number {
  class_holder.f =
    (n | 0) > 0
      ? (): number => {
          class_holder.f = null;
          churn();
          return 5;
        }
      : null;
  const r = class_holder.f?.() ?? -1;
  const m = maybe(n | 0)?.x;
  return r + (m === undefined ? 0 : m);
}
const class_holder: { f: (() => number) | null } = { f: null };
export function closureSelect(n: number): number {
  const p = new P(1);
  const q = new P(2);
  let f = (n | 0) > 0 ? (): number => p.x : (): number => q.x;
  const r = f();
  f = (): number => p.x + q.x;
  return r * 10 + f();
}
export function closureOfClosure(n: number): number {
  const mkAdder = (k: number): ((j: number) => () => number) => {
    const held = new P(k);
    return (j: number) => {
      const h2 = new P(j);
      return () => held.x + h2.x;
    };
  };
  const f = mkAdder(n | 0)(2);
  churn();
  return f();
}
export function perIterBox(n: number): number {
  const fs: (() => P)[] = [];
  for (let p = new P(0); p.x < (n | 0); p = new P(p.x + 1)) fs.push(() => p);
  churn();
  let t = 0;
  for (const f of fs) t += f().x;
  return t;
}
export function labelledInline(n: number): number {
  const a = [make(1), make(2), make(3)];
  let t = 0;
  outer: for (const x of a) {
    const h = make(x.x);
    const g = (k: P): number => {
      if (k.x === 2) return -1;
      const s = make(k.x * 2);
      return s.x;
    };
    const v = g(h);
    if (v < 0) {
      a.length = 0;
      churn();
      continue outer;
    }
    t += v + h.x;
  }
  return t + (n | 0);
}
const ga = new P(1);
const gb = { p: ga, q: [ga, new P(2)] };
let gc = gb.p;
export function globalsChain(n: number): number {
  gb.p = new P(n | 0);
  gb.q[0] = gb.p;
  const old = gc;
  gc = gb.q[1]!;
  churn();
  return old.x + gc.x + gb.q[0]!.x;
}
export function voidArrow(n: number): number {
  const f = (): P => make(n | 0);
  f();
  const g = (): void => {
    f();
  };
  g();
  return f().x;
}
export function selfArrayStore(n: number): number {
  const a: (P | null)[] = [new P(n | 0), null];
  a[1] = a[0]!;
  a[0] = null;
  churn();
  a[0] = a[1]!;
  a[1] = a[1]!;
  return a[0]!.x;
}
export function returnsParam(n: number): number {
  const id = (p: P): P => p;
  const twice = (p: P): P => id(id(p));
  let q = twice(new P(n | 0));
  q = twice(q);
  churn();
  return q.x;
}
type Cell = { v: P; next: Cell | null };
function recursiveList(k: number, tail: Cell | null): number {
  if (k === 0) return tail === null ? 0 : tail.v.x;
  const cell = { v: new P(k), next: tail };
  return recursiveList(k - 1, cell) + cell.v.x;
}
export function recursion(n: number): number {
  return recursiveList(n | 0, null);
}
