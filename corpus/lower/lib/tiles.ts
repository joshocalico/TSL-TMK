// Imported by corpus/lower/pipe/two_squares.ts: a class, a function and module state named as corpus/lower/lib/shapes.ts's are.
export class Square {
  side: number;
  constructor(s: number) {
    this.side = (s + 1) | 0;
  }
  area(): number {
    return (2 * this.side * this.side) | 0;
  }
}

let made = 0;

export function measure(s: Square): number {
  made = (made + 2) | 0;
  return s.area();
}

export function count(): number {
  return made;
}
