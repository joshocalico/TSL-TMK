// Rule: class without inheritance or reflection: struct + functions, fields inferred from plain number.
// expect-tir: func @Counter\.bump
class Counter {
  private total = 0;
  scale = 2.5;
  constructor(
    private readonly step: number,
    public label: number,
  ) {}
  bump(): number {
    this.total += this.step;
    return this.total;
  }
  get doubled(): number {
    return this.total * 2;
  }
  set doubled(v: number) {
    this.total = v / 2;
  }
  scaled(): number {
    return this.total * this.scale;
  }
  self(): Counter {
    return this;
  }
}
class Reader {
  at = 0;
  data: Uint8Array;
  constructor(data: Uint8Array) {
    this.data = data;
  }
  next(): number {
    return this.data[this.at++] ?? -1;
  }
}
export function counter(step: number, n: number): number {
  const c = new Counter(step | 0, 7);
  for (let i = 0; i < (n | 0); i++) c.bump();
  c.doubled = c.doubled + 4;
  return c.self().scaled() + c.label;
}
export function reader(bytes: Uint8Array): number {
  const r = new Reader(bytes);
  let sum = 0;
  for (let b = r.next(); b !== -1; b = r.next()) sum += b;
  return sum;
}
