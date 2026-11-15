// A program whose cycles are real, for `tmk bench memory`: n objects in total, as rings of 16, doubly linked lists of 16, and
// objects with a closure over `this`. With the collector off these leak, as far as the memory lasts. V8 has its collector.
class Ring {
  next: Ring | null = null;
  constructor(public v: number) {}
}
class Link {
  prev: Link | null = null;
  next: Link | null = null;
  constructor(public v: number) {}
}
class Box {
  op: () => number;
  constructor(public k: number) {
    this.op = (): number => this.k;
  }
}
export function cycleWork(n: number): number {
  let t = 0;
  const rounds = (n | 0) >> 6;
  for (let i = 0; i < rounds; i++) {
    const first = new Ring(i);
    let last = first;
    for (let j = 1; j < 16; j++) {
      const r = new Ring(j);
      last.next = r;
      last = r;
    }
    last.next = first;
    t = (t + first.next!.v) | 0;
    const head = new Link(i);
    let tail = head;
    for (let j = 1; j < 16; j++) {
      const c = new Link(j);
      c.prev = tail;
      tail.next = c;
      tail = c;
    }
    t = (t + tail.prev!.v) | 0;
    for (let j = 0; j < 16; j++) t = (t + new Box(j).op()) | 0;
  }
  return t | 0;
}
