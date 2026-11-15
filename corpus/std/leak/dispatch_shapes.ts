// memory-pages: 64
// Dispatch interfaces (3.4, D70): three classes reach Shape through every kind of flow (arguments, initialisers,
// returns, `=`, `??`, a conditional, a field, a list of them), none says `implements`, and each call is a class-id
// compare and a direct call. Natively against V8.
import { toF64, type bool, type f64, type i32, type u32 } from "@tsl/core";

export interface Shape {
  area(): f64;
  scale(by: f64, twice: bool): void;
  sides(): u32;
  bigger(than: Shape): bool;
}

class Square {
  constructor(private s: f64) {}
  area(): f64 {
    return this.s * this.s;
  }
  scale(by: f64, twice: bool): void {
    this.s = twice ? this.s * by * by : this.s * by;
  }
  sides(): u32 {
    return 4;
  }
  bigger(than: Shape): bool {
    return this.area() > than.area();
  }
}

class Tri {
  constructor(
    private b: f64,
    private h: f64,
  ) {}
  area(): f64 {
    return (this.b * this.h) / 2;
  }
  scale(by: f64, twice: bool): void {
    const k = twice ? by * by : by;
    this.b = this.b * k;
    this.h = this.h * k;
  }
  sides(): u32 {
    return 3;
  }
  bigger(than: Shape): bool {
    return this.area() > than.area();
  }
}

class Circle {
  calls: i32 = 0;
  constructor(private r: f64) {}
  area(): f64 {
    this.calls += 1;
    return 3 * this.r * this.r;
  }
  scale(by: f64, twice: bool): void {
    this.r = twice ? this.r * by * by : this.r * by;
  }
  sides(): u32 {
    return 0;
  }
  bigger(than: Shape): bool {
    return this.area() > than.area();
  }
}

class Holder {
  held: Shape | null = null;
  constructor(public first: Shape) {}
}

function make(k: i32): Shape {
  if (k === 0) return new Square(2);
  if (k === 1) return new Tri(4, 3);
  return new Circle(1);
}

class Link {
  constructor(
    public s: Shape,
    public next: Link | null,
  ) {}
}

function total(xs: Link | null): f64 {
  let s: f64 = 0;
  for (let x = xs; x !== null; x = x.next) s += x.s.area();
  return s;
}

/** Each kind made, its area, scaled, and its sides: one value per class, so a wrong arm shows. */
export function each(k: i32): f64 {
  const s = make(k);
  const a = s.area();
  s.scale(2, false);
  const b = s.area();
  s.scale(3, true);
  return a * 1000000 + b * 1000 + s.area() / 9 + toF64(s.sides());
}

/** A field, a nullable field set by `=`, `??`, a conditional, and identity. */
export function held(pick: bool): f64 {
  const h = new Holder(new Tri(2, 2));
  const c = new Circle(2);
  h.held = pick ? c : new Square(5);
  const got = h.held ?? h.first;
  const same: f64 = got === c ? 1 : 0;
  const other: Shape | null = null;
  const fallback = other ?? h.first;
  return got.area() * 100 + fallback.area() + same * 0.5 + toF64(c.calls) * 0.01;
}

/** A list of shapes, summed through the interface, and each compared with the next through it. */
export function mixed(n: i32): f64 {
  let xs: Link | null = null;
  for (let i: i32 = 0; i < n; i++) xs = new Link(make(i % 3), xs);
  let wins: f64 = 0;
  for (let x = xs; x !== null; x = x.next) {
    const nx = x.next;
    if (nx !== null && x.s.bigger(nx.s)) wins += 1;
  }
  return total(xs) * 100 + wins;
}
