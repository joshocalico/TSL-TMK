// memory-pages: 96
// Rooms and leaves in `rc` (R4). A room an array grows into is zeroed only past what growth copies into it, and only
// where a slot can be read as a hole (an array of references): here a slot a longer length reaches must read as a hole
// although the room it's in held references before, in an array freed just before. And an element with no slots of its own
// (a leaf) is given back at once by freeing that has a step to spare, where an element that holds something isn't: each
// must still be freed exactly once, which arrays of each churned past the memory there is (96 pages) show.
class Pt {
  constructor(public x: number) {}
}

class Pair {
  constructor(
    public a: Pt,
    public b: Pt | null,
  ) {}
}

/** A room that held 64 references, freed, then taken by a short array lengthened to 64: every new slot is a hole. */
export function holesAfterReuse(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    const big: Pt[] = [];
    for (let i = 0; i < 64; i++) big.push(new Pt(i + r));
    t = (t + big[63]!.x) | 0;
    // the array above is freed a step at a time by these allocations
    for (let i = 0; i < 100; i++) t = (t + new Pt(i).x) | 0;
    const small: Pt[] = [new Pt(1), new Pt(2), new Pt(3), new Pt(4), new Pt(5)];
    small.length = 64;
    let holes = 0;
    for (let i = 5; i < 64; i++) if (small[i] === undefined) holes++;
    t = (t + holes * 1000 + small[4]!.x) | 0;
  }
  return t;
}

/** Arrays of leaves and of objects holding leaves, each freed whole, far past memory: nothing freed twice or kept. */
export function leavesAndPairs(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    const pts: Pt[] = [];
    const pairs: Pair[] = [];
    for (let i = 0; i < 40; i++) {
      const p = new Pt(i + r);
      pts.push(p);
      pairs.push(new Pair(new Pt(i), i % 3 === 0 ? p : null));
    }
    for (let i = 0; i < 40; i++) {
      const q = pairs[i]!;
      t = (t + pts[i]!.x + q.a.x + (q.b === null ? 0 : q.b.x)) | 0;
    }
  }
  return t;
}

/** Numbers grown through every doubling, whose rooms are never zeroed: every element read back is the one written. */
export function numbersGrown(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    const ns: number[] = [];
    for (let i = 0; i < 300; i++) ns.push(i * 5 + r);
    for (let i = 0; i < ns.length; i++) t = (t + ns[i]! * (i + 1)) | 0;
    while (ns.length > 10) ns.pop();
    ns.push(7);
    t = (t + ns[10]! + ns.length) | 0;
  }
  return t;
}

class Tri {
  constructor(
    public a: number,
    public b: number,
    public c: number,
  ) {}
}

class One {
  constructor(public n: number) {}
}

/** Objects of one and of three integers in arrays, made and read back: every field placed whole in its slot. */
export function smallObjects(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    const k = r & 1023;
    const xs: Tri[] = [];
    for (let i = 0; i < 8; i++) xs.push(new Tri(i, k, i ^ k));
    const os: One[] = [];
    for (let i = 0; i < 8; i++) os.push(new One(k + i));
    for (let i = 0; i < xs.length; i++) t = (t + xs[i]!.a + xs[i]!.b * 3 + xs[i]!.c * 7) | 0;
    for (let i = 0; i < os.length; i++) t = (t + os[i]!.n) | 0;
  }
  return t;
}
