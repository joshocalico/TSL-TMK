// The two gaps from review: a constructor parameter property used by name in the body, and a class inside a function.
class C {
  v: number;
  next: C | null = null;
  constructor(v: number) {
    this.v = v;
  }
}
function ring(n: number, k: number): C {
  const first = new C(k);
  let cur = first;
  for (let i = 1; i < n; i++) {
    cur.next = new C(k + i);
    cur = cur.next;
  }
  cur.next = first;
  return first;
}
class B {
  inner: C;
  doubled: number;
  constructor(
    public k: number,
    public name: string = "dflt",
  ) {
    this.inner = ring(3, k);
    this.doubled = k * 2;
    k = k + 1;
    this.doubled += k;
  }
}
export function paramProp(k: number): number[] {
  const b = new B(k);
  return [b.k, b.doubled, b.inner.next!.next!.v, b.name.length];
}
export function paramPropClosure(k: number): number {
  class Holder {
    f: () => number;
    constructor(public n: number) {
      this.f = () => n + 1;
    }
  }
  const h = new Holder(k);
  return h.f() + h.n;
}
export function localClass(n: number): number {
  class Point {
    constructor(
      public x: number,
      public y: number,
    ) {}
    sum(): number {
      return this.x + this.y;
    }
  }
  let t = 0;
  for (let i = 0; i < n; i++) t += new Point(i, 2).sum();
  return t;
}
export function localGeneric(n: number): string[] {
  class Box<T> {
    constructor(public v: T) {}
    get(): T {
      return this.v;
    }
  }
  return [String(new Box<number>(n).get()), new Box<string>("s").get()];
}
