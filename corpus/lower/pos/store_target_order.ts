// An assignment whose right side reassigns the variable its target is read through (R3): JS reads the target's object
// first, so the value goes into the first object, and tsc's narrowing of the place after it (to what was assigned) is
// about that first object, not the one the variable now holds. Lowered code mustn't trust it.
class Node {
  v: number;
  next: Node | null = null;
  w: number | undefined = undefined;
  constructor(v: number) {
    this.v = v;
  }
}

export function storeNext(a: number, b: number): number {
  let p = new Node(a);
  const first = p;
  const q = new Node(b);
  p.next = ((p = q), new Node(a + b));
  const n = p.next;
  const f = first.next;
  return (
    (p.next === null ? 7007 : 7008) * 10000 + (n === null ? 0 : n.v) * 100 + (f === null ? 0 : f.v)
  );
}

export function storeNumber(a: number, b: number): number {
  let p = new Node(a);
  const first = p;
  const q = new Node(b);
  p.w = ((p = q), a + b);
  const w = p.w;
  return (p.w === undefined ? 1 : 2) * 1000 + (w ?? 3) * 100 + (first.w ?? 4);
}

export function storeDeep(a: number): number {
  const box = { cur: new Node(a) };
  const first = box.cur;
  box.cur.next = ((box.cur = new Node(a + 1)), new Node(a + 2));
  return (box.cur.next === null ? 1 : 2) * 100 + (first.next === null ? 0 : first.next.v);
}

export function storeIndex(n: number): number {
  let xs = [1, 2, 3];
  const first = xs;
  let i = 0;
  xs[i] = ((xs = [7, 8, 9]), (i = 2), n);
  return first[0]! * 1000 + first[2]! * 100 + xs[0]! * 10 + xs[2]!;
}
