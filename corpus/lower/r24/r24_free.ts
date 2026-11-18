// R24: objects of no slots, one slot and several freed in `rc` with no collector linked (no class here can be in a cycle),
// where an allocation's freeing frees an object of one slot in place, leaves the cursor at slot 1 where the budget runs out,
// and hands an object of more slots to the rest of its slots in a function of its own. Some of what each object holds is kept
// past it, shared with an array, so a slot visited twice frees a child still held, and one never visited keeps its child;
// more objects are then made into the slots freeing gave back, and everything kept is read again.
class Leaf {
  constructor(public v: number) {}
}

class One {
  constructor(public a: Leaf) {}
}

class Two {
  constructor(
    public a: Leaf,
    public b: Leaf,
  ) {}
}

class Five {
  constructor(
    public a: Leaf,
    public b: Leaf,
    public c: Leaf,
    public d: Leaf,
    public e: Leaf,
  ) {}
}

/** Objects of each width made and dropped in turn, every third child kept, then fresh objects made and all read. */
export function widths(n: number): number {
  const keep: Leaf[] = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    const l = new Leaf(i);
    if (i % 3 === 0) keep.push(l);
    const k = i % 3;
    if (k === 0) t += new One(l).a.v;
    else if (k === 1) t += new Two(l, new Leaf(i + 1)).b.v;
    else t += new Five(new Leaf(1), l, new Leaf(2), l, new Leaf(3)).d.v;
  }
  for (let i = 0; i < n; i++) t += new Leaf(i * 2).v & 1;
  for (const l of keep) t = (t * 3 + l.v) | 0;
  return t;
}

/** Many objects dropped at once, so freeing runs past the budget and the cursor stops part way through one. */
export function burst(n: number): number {
  const all: Five[] = [];
  const keep: Leaf[] = [];
  for (let i = 0; i < n; i++) {
    const s = new Leaf(i);
    keep.push(s);
    all.push(new Five(new Leaf(i), s, new Leaf(i + 1), s, new Leaf(i + 2)));
  }
  let t = 0;
  for (const f of all) t = (t + f.a.v + f.e.v) | 0;
  all.length = 0;
  for (let i = 0; i < n * 3; i++) t = (t + new One(new Leaf(i)).a.v) | 0;
  for (const l of keep) t = (t * 7 + l.v) | 0;
  return t;
}
