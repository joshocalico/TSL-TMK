// R25: objects of one slot freed in `rc` with no collector linked (no class here can be in a cycle) where a budget runs out
// between an object's two steps, so the cursor is left at its block: the next allocation takes that step first, then frees
// on; and with one step left, a waiting object's slot 0 is visited and the cursor left at slot 1. Many are let go of at
// once by an array, as a split's words are, so freeing runs on over many allocations; some of what each holds is kept past
// it, shared with another array, so a block given back twice or a step skipped shows when what's kept is read again.
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

/** An array of one-slot objects let go of at once, every other child kept, then objects made one at a time and read. */
export function ones(n: number): number {
  const all: One[] = [];
  const keep: Leaf[] = [];
  for (let i = 0; i < n; i++) {
    const l = new Leaf(i);
    if (i % 2 === 0) keep.push(l);
    all.push(new One(l));
  }
  let t = 0;
  for (const o of all) t = (t + o.a.v) | 0;
  all.length = 0;
  for (let i = 0; i < n * 2; i++)
    t = (t + new Leaf(i).v + (i % 5 === 0 ? new One(new Leaf(i)).a.v : 0)) | 0;
  for (const l of keep) t = (t * 7 + l.v) | 0;
  return t;
}

/** One- and two-slot objects in turn, let go of by an array, so the budget's stops land at blocks and at slots. */
export function mixed(n: number): number {
  const all: (One | null)[] = [];
  const twos: Two[] = [];
  const keep: Leaf[] = [];
  for (let i = 0; i < n; i++) {
    const l = new Leaf(i);
    if (i % 3 !== 1) keep.push(l);
    all.push(new One(l));
    if (i % 2 === 0) twos.push(new Two(l, new Leaf(i + 7)));
  }
  let t = 0;
  for (const o of all) t = (t + (o === null ? 0 : o.a.v)) | 0;
  for (const w of twos) t = (t + w.b.v) | 0;
  all.length = 0;
  twos.length = 0;
  for (let i = 0; i < n; i++) t = (t + new Two(new Leaf(i), new Leaf(1)).a.v) | 0;
  for (const l of keep) t = (t * 3 + l.v) | 0;
  return t;
}

/** A split's words let go of by their array, some kept, with appends between so freeing runs on, then read back. */
export function wordsKept(n: number): number {
  const keep: string[] = [];
  let t = 0;
  for (let r = 0; r < n; r++) {
    let s = "";
    for (let i = 0; i < 40 + r; i++) s += "ab cde f gh "[i % 12]!;
    const w = s.split(" ");
    if (r % 3 === 0) keep.push(w[r % w.length]!);
    t = (t + w.length) | 0;
  }
  for (const k of keep) {
    t = (t * 31 + k.length) | 0;
    for (let i = 0; i < k.length; i++) t = (t * 7 + k.charCodeAt(i)) | 0;
  }
  return t;
}
