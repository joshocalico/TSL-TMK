// Imported by corpus/lower/pipe/two_squares.ts: a class, a function and module state named as corpus/lower/lib/tiles.ts's are.
export class Square {
  side: number;
  constructor(s: number) {
    this.side = s | 0;
  }
  area(): number {
    return (this.side * this.side) | 0;
  }
}

let made = 0;

export function measure(s: Square): number {
  made = (made + 1) | 0;
  return s.area();
}

export function count(): number {
  return made;
}
