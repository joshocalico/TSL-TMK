// R22: objects of two, three and four reference slots freed in `rc` with the collector linked (a class that can be in a
// cycle is here), where an allocation frees two steps' worth and the second step, a slot's visit, is taken in place. Some of
// what each object holds is kept past it, shared with an array, so a slot visited twice frees a child still held, and one
// never visited keeps its child forever; more objects are then made into the slots freeing gave back, and everything kept
// is read again.
class Leaf {
  constructor(public v: number) {}
}

class Pair {
  constructor(
    public a: Leaf,
    public b: Leaf,
  ) {}
}

class Triple {
  constructor(
    public a: Leaf,
    public b: Leaf,
    public c: Leaf,
  ) {}
}

class Quad {
  constructor(
    public a: Leaf,
    public b: Leaf,
    public c: Leaf,
    public d: Leaf,
  ) {}
}

class Ring {
  next: Ring | null = null;
  constructor(public v: number) {}
}

function ring(n: number): number {
  const first = new Ring(0);
  let last = first;
  for (let i = 1; i < n; i++) {
    const r = new Ring(i);
    last.next = r;
    last = r;
  }
  last.next = first;
  let t = 0;
  let at: Ring | null = first;
  for (let i = 0; i < n * 2 && at !== null; i++) {
    t = (t + at.v) | 0;
    at = at.next;
  }
  return t;
}

/** Objects of each width made and let go of, every seventh's middle children kept, then the slots reused and all read. */
export function widths(n: number): number {
  const keep: Leaf[] = [];
  let t = ring(5);
  for (let i = 0; i < n; i++) {
    const p = new Pair(new Leaf(i), new Leaf(i + 1));
    const q = new Triple(new Leaf(i * 2), new Leaf(i * 2 + 1), new Leaf(i * 2 + 2));
    const r = new Quad(
      new Leaf(i * 3),
      new Leaf(i * 3 + 1),
      new Leaf(i * 3 + 2),
      new Leaf(i * 3 + 3),
    );
    if (i % 7 === 0) keep.push(p.b, q.b, q.c, r.b, r.c, r.d);
    t = (t + p.a.v + q.a.v + r.a.v) | 0;
  }
  for (let i = 0; i < n; i++) {
    const r = new Quad(new Leaf(-i), new Leaf(-i - 1), new Leaf(-i - 2), new Leaf(-i - 3));
    t = (t ^ (r.b.v + r.c.v)) | 0;
  }
  for (const l of keep) t = (t * 3 + l.v) | 0;
  return (t + ring(3)) | 0;
}

/** Holders nested in holders: a four-slot object whose slots are three-slot ones, freed a slot a step. */
export function nested(n: number): number {
  const keep: Triple[] = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    const a = new Triple(new Leaf(i), new Leaf(i + 1), new Leaf(i + 2));
    const b = new Triple(new Leaf(i + 3), new Leaf(i + 4), new Leaf(i + 5));
    const outer = new Pair(a.b, b.c);
    if (i % 5 === 0) keep.push(b);
    t = (t + outer.a.v * 2 + outer.b.v) | 0;
  }
  for (let i = 0; i < n * 2; i++) {
    const q = new Quad(new Leaf(i), new Leaf(i), new Leaf(i), new Leaf(i));
    t = (t + q.d.v) | 0;
  }
  for (const b of keep) t = (t * 5 + b.a.v + b.b.v * 2 + b.c.v * 3) | 0;
  return t;
}
