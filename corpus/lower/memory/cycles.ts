// Objects with cycles, kept across calls and returned: the reader sees the same object twice (SPEC 4.5).
class Peer {
  other: Peer | null = null;
  constructor(public id: number) {}
}
type Ring = { id: number; next: Ring | null; back: Ring | null };

let a: Peer | null = null;
let ring: Ring | null = null;

export function link(x: number, y: number): number {
  const p = new Peer(x);
  const q = new Peer(y);
  p.other = q;
  q.other = p;
  a = p;
  return p.other.other!.id;
}

export function walkPeers(steps: number): number {
  let c = a;
  let t = 0;
  for (let i = 0; i < (steps | 0) && c !== null; i++) {
    t = t * 3 + c.id;
    c = c.other;
  }
  return t;
}

export function makeRing(n: number): number {
  let first: Ring | null = null;
  let last: Ring | null = null;
  for (let i = 0; i < (n | 0); i++) {
    const r: Ring = { id: i, next: null, back: last };
    if (first === null) first = r;
    if (last !== null) last.next = r;
    last = r;
  }
  if (first !== null && last !== null) {
    last.next = first;
    first.back = last;
  }
  ring = first;
  return n | 0;
}

export function ringSum(steps: number): number {
  let c = ring;
  let t = 0;
  for (let i = 0; i < (steps | 0) && c !== null; i++) {
    t += c.id;
    c = c.back;
  }
  return t;
}

export function selfLoop(v: number): Ring {
  const r: Ring = { id: v, next: null, back: null };
  r.next = r;
  r.back = r;
  return r;
}

export function pair(): { left: { v: number; up: unknownUp | null }; right: { v: number } } {
  const right = { v: 2 };
  const left = { v: 1, up: null as unknownUp | null };
  return { left, right };
}
type unknownUp = { z: number };
