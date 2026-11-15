// A count reaching zero during a scan, on the direct route (SPEC 3.5, 4.5, D41, R1e): corpus/rc/cyc_giveup.ts for lowered
// `rc`. Built with no pacing and a budget of b (tools/rc-tests.ts `interleave`, every budget it's given), one allocation
// is b steps, so `tick(k)` puts the drop of an object's last count after k allocations: a root of a scan, a member reached
// only through another, the nodes of a list being freed, an object with many slots, and a holder of a ring member that
// stays. Going through every k in a range puts the drop at every phase of a scan. What the given-up object held was
// counted as edges, so a scan deciding before it was freed would free that too, and the drop would free it again. The
// digest is read from objects made after the drop; in the poisoning build a freed object used again traps 16.
class N {
  next: N | null = null;
  other: N | null = null;
  kids: N[] = [];
  constructor(public v: number) {}
}
class Tick {
  constructor(public t: number) {}
}
let sink: Tick | null = null;
let g0: N | null = null;
let g1: N | null = null;
const M = 1000003;
const SETTLE = 200;

function tick(k: number): void {
  for (let i = 0; i < k; i++) sink = new Tick(i);
}
function mix(t: number, x: number): number {
  return (t * 31 + x) % M;
}
function ring(len: number, seed: number): N {
  const first = new N(seed);
  let last = first;
  for (let i = 1; i < len; i++) {
    const r = new N(seed + i);
    last.next = r;
    last = r;
  }
  last.next = first;
  return first;
}
function sum(c: N | null, steps: number): number {
  let t = 0;
  let p = c;
  for (let i = 0; i < steps && p !== null; i++) {
    t = (t * 3 + p.v) % M;
    p = p.next;
  }
  return t;
}
function after(seed: number): number {
  let head: N | null = null;
  for (let i = 0; i < 12; i++) {
    const n = new N(seed * 13 + i);
    n.next = head;
    head = n;
  }
  let t = 0;
  for (let p = head; p !== null; p = p.next) t = (t * 7 + p.v) % M;
  return t;
}

function buildRoot(k: number): void {
  const x = new N(k);
  x.other = ring(4, k);
  g0 = x;
}
export function rootGivenUp(from: number, to: number): number {
  let t = 0;
  for (let k = from; k < to; k++) {
    buildRoot(k);
    tick(k);
    g0 = null;
    tick(k & 3);
    t = mix(t, after(k));
    tick(SETTLE);
  }
  return t;
}

function buildMember(k: number): void {
  const r = new N(k);
  r.other = new N(k + 1);
  r.other.other = ring(3, k);
  r.other.next = ring(2, k + 7);
  g0 = r;
}
export function memberGivenUp(from: number, to: number): number {
  let t = 0;
  for (let k = from; k < to; k++) {
    buildMember(k);
    tick(k);
    g0!.other = null;
    tick(k & 3);
    t = mix(t, after(k) + g0!.v);
    g0 = null;
    tick(SETTLE);
  }
  return t;
}

function buildList(n: number, k: number): void {
  for (let i = 0; i < n; i++) {
    const a = new N(i + k);
    a.next = g0;
    g0 = a;
  }
}
export function listGivenUp(n: number, to: number): number {
  let t = 0;
  for (let k = 0; k < to; k++) {
    buildList(n, k);
    tick(k);
    g0 = null;
    tick(k & 3);
    t = mix(t, after(k));
    tick(SETTLE);
  }
  return t;
}

function buildMany(k: number): void {
  const m = new N(k);
  for (let i = 0; i < 10; i++) m.kids.push(ring(2, i + k));
  g0 = m;
}
export function manyGivenUp(from: number, to: number): number {
  let t = 0;
  for (let k = from; k < to; k++) {
    buildMany(k);
    const v = g0!.v;
    tick(k);
    g0 = null;
    tick(k & 3);
    t = mix(t, after(k) + v);
    tick(SETTLE);
  }
  return t;
}

function buildHolder(k: number): void {
  const r = ring(5, k);
  g1 = r.next!.next;
  const h = new N(k + 100);
  h.other = r.next;
  g0 = h;
}
export function holderGivenUp(from: number, to: number): number {
  let t = 0;
  for (let k = from; k < to; k++) {
    buildHolder(k);
    tick(k);
    g0 = null;
    tick(k & 3);
    t = mix(t, sum(g1, 6));
    t = mix(t, after(k));
    g1 = null;
    tick(SETTLE);
  }
  return t;
}

export function last(): number {
  g0 = null;
  g1 = null;
  sink = null;
  return 0;
}
