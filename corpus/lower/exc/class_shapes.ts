// Classes with inheritance (SPEC 4.5, D50): extends, super(), overriding with dynamic dispatch, abstract classes,
// protected members, instanceof across a hierarchy, and getters.
abstract class Shape {
  protected readonly label: string;
  constructor(label: string) {
    this.label = label;
  }
  abstract area(): number;
  perimeter(): number {
    return 0;
  }
  get kind(): string {
    return "shape";
  }
  describe(): string {
    return `${this.label} ${this.kind} area=${this.area().toFixed(2)} p=${this.perimeter().toFixed(2)}`;
  }
}

class Circle extends Shape {
  r: number;
  constructor(r: number) {
    super("circle");
    this.r = r;
  }
  area(): number {
    return Math.PI * this.r * this.r;
  }
  override perimeter(): number {
    return 2 * Math.PI * this.r;
  }
  override get kind(): string {
    return "round";
  }
}

class Rect extends Shape {
  constructor(
    public w: number,
    public h: number,
  ) {
    super("rect");
  }
  area(): number {
    return this.w * this.h;
  }
  override perimeter(): number {
    return 2 * (this.w + this.h);
  }
}

class Square extends Rect {
  constructor(s: number) {
    super(s, s);
  }
  override describe(): string {
    return "square: " + super.describe();
  }
}

class Tri extends Shape {
  a = 3;
  b = 4;
  area(): number {
    return (this.a * this.b) / 2;
  }
}

function make(k: number, n: number): Shape {
  if (k === 0) return new Circle(n);
  if (k === 1) return new Rect(n, n + 1);
  if (k === 2) return new Square(n);
  return new Tri("tri");
}

export function totalArea(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) t += make(i % 4, i + 1).area();
  return Math.round(t * 1000) / 1000;
}

export function describeAll(n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(make(i % 4, i + 1).describe());
  return out.join("; ");
}

export function kinds(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) {
    const x = make(i % 4, 2);
    s += x instanceof Square ? "S" : x instanceof Rect ? "R" : x instanceof Circle ? "C" : "T";
    if (x instanceof Shape) s += "+";
  }
  return s;
}

export function widths(n: number): number {
  let w = 0;
  for (let i = 0; i < n; i++) {
    const x = make(i % 4, i);
    if (x instanceof Rect) w += x.w;
    else if (x instanceof Circle) w += x.r * 10;
  }
  return w;
}
