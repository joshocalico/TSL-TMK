// The TSL route (D62) on a class hierarchy (D50): a call reaching several overrides is a switch on the class id, with a
// direct call in each arm, and the printer prints that switch. Three subclasses and a base in one flow class, `instanceof`
// as an id range, a derived constructor after its base's, and an override calling its base's method. No strings, so it
// lowers in leak and manual with nothing from compiler/rt.
class Shape {
  scale: number;
  constructor(scale: number) {
    this.scale = scale;
  }
  area(): number {
    return 0;
  }
  weight(): number {
    return this.area() * this.scale;
  }
}

class Square extends Shape {
  side: number;
  constructor(side: number, scale: number) {
    super(scale);
    this.side = side;
  }
  override area(): number {
    return this.side * this.side;
  }
}

class Rect extends Shape {
  w: number;
  h: number;
  constructor(w: number, h: number) {
    super(2);
    this.w = w;
    this.h = h;
  }
  override area(): number {
    return this.w * this.h;
  }
}

class Tall extends Rect {
  constructor(w: number) {
    super(w, w * 3);
  }
  override area(): number {
    return super.area() + 1;
  }
  override weight(): number {
    return -super.weight();
  }
}

function make(k: number): Shape {
  if (k === 0) return new Square(3, 1);
  if (k === 1) return new Rect(2, 5);
  if (k === 2) return new Tall(2);
  return new Shape(7);
}

export function areaOf(k: number): number {
  return make(k).area();
}

export function weightOf(k: number): number {
  return make(k).weight();
}

export function kinds(n: number): number {
  let squares = 0;
  let rects = 0;
  let talls = 0;
  for (let i = 0; i < n; i++) {
    const s = make(i % 4);
    if (s instanceof Tall) talls++;
    if (s instanceof Rect) rects++;
    if (s instanceof Square) squares++;
  }
  return squares * 10000 + rects * 100 + talls;
}

export function mixed(n: number): number {
  const all: Shape[] = [];
  for (let i = 0; i < n; i++) all.push(make((i * 7) % 4));
  let sum = 0;
  for (const s of all) sum += s.area() * 1000 + s.weight();
  return sum;
}
