// User code between collector steps (SPEC 3.5, D41, M5 Phase E). Built with no pacing and a budget of b, one allocation is b
// steps of the collector, so `tick(k)` puts a change after k allocations: with b = 1, at every step there is. Each function
// goes through every k in a range, and returns a digest that V8 has to agree with. In the poisoning build, an object freed
// while reachable traps 16 on the next count or field access through it.
class C {
  next: C | null = null;
  other: C | null = null;
  peers: C[] | null = null;
  cb: (() => number) | null = null;
  constructor(public v: number) {}
}
class Tick {
  constructor(public t: number) {}
}
class Up {
  parent: Up | null = null;
  kids: Up[] = [];
  constructor(public v: number) {}
}
let sink: Tick | null = null;
let g0: C | null = null;
let g1: C | null = null;
let gu: Up | null = null;

function tick(k: number): void {
  for (let i = 0; i < k; i++) sink = new Tick(i);
}
function ring(len: number, seed: number): C {
  const first = new C(seed);
  let last = first;
  for (let i = 1; i < len; i++) {
    const r = new C(seed + i);
    last.next = r;
    last = r;
  }
  last.next = first;
  return first;
}
function sum(c: C | null, steps: number): number {
  let t = 0;
  let p = c;
  for (let i = 0; i < steps && p !== null; i++) {
    t = (t * 3 + p.v) | 0;
    p = p.next;
  }
  return t;
}
const SETTLE = 400;

/** A ring with a holder dropped and re-held at k. */
export function heldThroughout(from: number, to: number): number {
  let t = 0;
  for (let k = from | 0; k < (to | 0); k++) {
    g0 = ring(5, k);
    g1 = g0.next;
    g0 = null; // a candidate, still held through g1
    tick(k);
    t = (t + sum(g1, 7)) | 0;
    tick(k >> 1);
    t = (t + sum(g1, 3)) | 0;
    g1 = null;
    tick(SETTLE);
  }
  return t;
}
/** The only holder moves to another at step k: a count taken before the old one goes. */
export function holderMoves(from: number, to: number): number {
  let t = 0;
  for (let k = from | 0; k < (to | 0); k++) {
    g0 = ring(6, k);
    g1 = g0.next!.next;
    g0 = null;
    tick(k);
    g0 = g1!.next; // another member held
    g1 = null;
    tick(k);
    t = (t + sum(g0, 8)) | 0;
    g0 = null;
    tick(SETTLE);
  }
  return t;
}
/** A garbage-looking ring made reachable again from a candidate: an edge from something a scan has been through. */
export function reachableAgain(from: number, to: number): number {
  let t = 0;
  for (let k = from | 0; k < (to | 0); k++) {
    const a = ring(4, k);
    const b = ring(4, k + 100);
    g0 = a;
    g1 = b;
    g1 = null; // b's last holder is its local
    tick(k);
    a.other = b; // b hangs from a from here
    tick(k);
    t = (t + sum(a.other, 5)) | 0;
    g0 = null;
    tick(SETTLE);
    t = (t + sum(a, 2) + sum(b, 2)) | 0;
  }
  return t;
}
/** An edge taken out of a scanned object into a holder at k, then the rest dropped. */
export function edgeTakenOut(from: number, to: number): number {
  let t = 0;
  for (let k = from | 0; k < (to | 0); k++) {
    const a = ring(3, k);
    a.other = ring(3, k + 50);
    g0 = a;
    tick(k);
    g1 = a.other;
    a.other = null;
    g0 = null;
    tick(k);
    t = (t + sum(g1, 4)) | 0;
    g1 = null;
    tick(SETTLE);
    t = (t + a.v) | 0;
  }
  return t;
}
/** A holder taken and let go of at every step of the scan. */
export function flickering(from: number, to: number): number {
  let t = 0;
  for (let k = from | 0; k < (to | 0); k++) {
    g0 = ring(7, k);
    g1 = g0;
    g0 = null;
    for (let i = 0; i < k; i++) {
      g0 = g1;
      tick(1);
      g1 = g0!.next;
      g0 = null;
      tick(1);
    }
    t = (t + sum(g1, 9)) | 0;
    g1 = null;
    tick(SETTLE);
  }
  return t;
}
function peers(n: number, seed: number): C[] {
  const a: C[] = [];
  for (let i = 0; i < n; i++) {
    const c = new C(seed + i);
    c.peers = a;
    a.push(c);
  }
  return a;
}
/** Elements moved inside an array a scan is partway through: moved up, one can be read twice. */
export function movedWhileScanned(from: number, to: number): number {
  let t = 0;
  for (let k = from | 0; k < (to | 0); k++) {
    g0 = peers(12, k)[3]!; // the array's last holders are its members
    g1 = g0.peers![6]!;
    tick(k);
    // Inserting moves everything from 1 up by one, and taking it out moves it back. Neither changes their counts.
    const ps = g0.peers!;
    ps.splice(1, 0, new C(1000 + k));
    tick(k >> 2);
    ps.splice(1, 1);
    tick(k >> 2);
    const first = ps.shift()!;
    tick(k >> 2);
    ps.push(first);
    g0 = null;
    tick(k >> 1);
    t = (t + g1!.v + g1!.peers!.length) | 0;
    for (const p of g1!.peers!) t = (t + p.v) | 0;
    g1 = null;
    tick(SETTLE);
  }
  return t;
}
/** A closure over `this` called, kept and let go of at k. */
export function closureCalled(from: number, to: number): number {
  let t = 0;
  for (let k = from | 0; k < (to | 0); k++) {
    const c = new C(k);
    c.cb = (): number => c.v + 1;
    g0 = c;
    tick(k);
    t = (t + g0.cb!()) | 0;
    const f = g0.cb!;
    g0 = null;
    tick(k);
    t = (t + f()) | 0;
    tick(SETTLE);
    t = (t + c.v) | 0;
  }
  return t;
}
/** A subtree cut out of a tree whose nodes point at their parents: it goes, and the tree it still points into stays. */
export function subtreeCut(from: number, to: number): number {
  let t = 0;
  for (let k = from | 0; k < (to | 0); k++) {
    const r = new Up(k);
    for (let i = 0; i < 4; i++) {
      const u = new Up(i);
      u.parent = r;
      r.kids.push(u);
      const w = new Up(i * 2);
      w.parent = u;
      u.kids.push(w);
    }
    gu = r;
    r.kids.pop();
    tick(k);
    t = (t + gu.kids.length + gu.kids[0]!.kids[0]!.parent!.parent!.v) | 0;
    gu = null;
    tick(SETTLE);
    t = (t + r.kids.length) | 0;
  }
  return t;
}
/** Everything at once: more rings than the scan takes in one go, some of them kept. */
export function several(from: number, to: number): number {
  let t = 0;
  for (let k = from | 0; k < (to | 0); k++) {
    const keep = ring(3, k);
    for (let i = 0; i < 4; i++) {
      const r = ring(3 + i, i);
      if (i === 2) keep.other = r;
    }
    g0 = keep;
    tick(k);
    t = (t + sum(g0.other, 6)) | 0;
    g0 = null;
    tick(SETTLE);
    t = (t + keep.v) | 0;
  }
  return t;
}
export function last(): number {
  g0 = null;
  g1 = null;
  gu = null;
  sink = null;
  return 0;
}
