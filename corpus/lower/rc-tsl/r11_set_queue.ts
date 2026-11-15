// memory-pages: 256
// R11: garbage that's slow to free, then sets that are quick to make (forced through the TSL route by the differential;
// `auto` doesn't take it, as the printer reshapes its branches). `leak` and `manual` run out, with code 14.
class Bit {
  v: number;
  constructor(v: number) {
    this.v = v;
  }
}

class Node {
  s: Set<number>;
  bits: Bit[];
  next: Node | null;
  constructor(s: Set<number>, next: Node | null) {
    this.s = s;
    this.bits = [];
    this.next = next;
  }
}

class Link {
  s: Set<number>;
  next: Link | null;
  constructor(s: Set<number>, next: Link | null) {
    this.s = s;
    this.next = next;
  }
}

function bigSet(seed: number, n: number): Set<number> {
  const s = new Set<number>();
  for (let j = 0; j < n; j++) s.add(seed * 1000 + j);
  return s;
}

/**
 * Garbage that's slow to free, then sets that are quick to make: a list whose nodes each hold a set and 40 objects is let
 * go of, so freeing it takes thousands of steps, and then a list of big sets is built, which makes few counted objects
 * and many tables. While the first list waits to be freed its sets' tables are held; each table made after has to take
 * freeing steps, or the heap running out has to free what's waiting, or this runs out where the direct route doesn't.
 */
export function queuedTables(rounds: number): number {
  let t = 0;
  for (let r = 0; r < rounds; r++) {
    let a: Node | null = null;
    for (let i = 0; i < 24; i++) {
      const nd: Node = new Node(bigSet(i + r, 300), a);
      for (let k = 0; k < 40; k++) nd.bits.push(new Bit(k));
      a = nd;
    }
    t += a === null ? 0 : a.s.size + a.bits.length;
    a = null;
    let b: Link | null = null;
    for (let i = 0; i < 24; i++) b = new Link(bigSet(i + r + 7, 300), b);
    t += b === null ? 0 : b.s.size;
  }
  return t;
}
