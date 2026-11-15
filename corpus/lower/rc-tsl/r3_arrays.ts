// memory-pages: 96
// Arrays in `rc` (R3), each churned far past the memory there is (96 pages, 384 KiB), printed as holders whose first room is
// their own tail (D69) and whose later rooms are the counted heap's: an array, an element or a room that isn't freed runs out
// (trap 14), and an element written past its room overwrites a neighbour, which the sums show.
class Pt {
  constructor(
    public x: number,
    public y: number,
  ) {}
}

class Tag {
  kids: number[] = [];
  constructor(public id: number) {}
}

/** Arrays of every length to 20, by push, beside objects made between: each element read back. */
export function lengths(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    const n = r % 21;
    const ps: Pt[] = [];
    const ns: number[] = [];
    for (let i = 0; i < n; i++) {
      ps.push(new Pt(i, r));
      ns.push(i * 3 + r);
      const spare = new Pt(-1, -1);
      t = (t + spare.x) | 0;
    }
    for (let i = 0; i < ps.length; i++) t = (t + ps[i]!.x * 7 + ps[i]!.y + ns[i]!) | 0;
  }
  return t;
}

/** Literals of a fixed length, as the acyclic benchmark makes, each read from the far end. */
export function literals(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    const a: Pt[] = [new Pt(r, 1), new Pt(r, 2), new Pt(r, 3), new Pt(r, 4), new Pt(r, 5)];
    const b = [r, r + 1, r + 2, r + 3, r + 4, r + 5, r + 6];
    t = (t + a[4]!.y + a[0]!.x + b[6]! - b[0]!) | 0;
  }
  return t;
}

/** Arrays grown into rooms of their own and cut back, with shift and pop: every room goes back. */
export function grownAndCut(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    const tags: Tag[] = [];
    for (let i = 0; i < 12; i++) {
      const g = new Tag(i);
      for (let j = 0; j < (i & 7); j++) g.kids.push(j + r);
      tags.push(g);
    }
    while (tags.length > 3) {
      const g = tags.shift()!;
      t = (t + g.id + g.kids.length) | 0;
      const h = tags.pop()!;
      t = (t + h.id * 2 + (h.kids.length > 0 ? h.kids[h.kids.length - 1]! : 0)) | 0;
    }
    t = (t + tags.length) | 0;
  }
  return t;
}

/** Literals of eight, kept two at a time and pushed past their first room: a write past it would land in the other. */
export function pushedLiterals(rounds: number): number {
  let t = 0;
  let keep: number[] = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let r = 0; r < (rounds | 0); r++) {
    const a = [r, 1, 2, 3, 4, 5, 6, 7];
    const b = [7, 6, 5, 4, 3, 2, 1, r];
    for (let i = 0; i < 8; i++) a.push(b[i]! + i);
    for (let i = 0; i < a.length; i++) t = (t + a[i]! * (i + 1)) | 0;
    t = (t + b[7]! + keep[0]!) | 0;
    keep = b;
  }
  return t;
}
