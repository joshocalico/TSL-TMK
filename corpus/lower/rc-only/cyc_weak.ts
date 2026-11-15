// A weak reference to something in a garbage cycle (SPEC 3.5, 3.10 item 9, D41). Until the collector decides, deref can give
// the target, and that count makes it live again, legitimately: nothing has been decided yet. Once it has decided, deref gives
// undefined, including while the cycle is partway through being freed, and never gives the target again.
class C {
  next: C | null = null;
  constructor(public v: number) {}
}
class Tick {
  constructor(public t: number) {}
}
let sink: Tick | null = null;
let w: WeakRef<C> | null = null;
let hold: C | null = null;
let grown: Tick[] = [];

function tick(k: number): void {
  for (let i = 0; i < k; i++) sink = new Tick(i);
}
/** Allocation the heap has to grow for, which is what pays for the collector in a release build. */
function grow(k: number): void {
  for (let i = 0; i < k; i++) grown.push(new Tick(i));
  grown = [];
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
function sum(c: C, steps: number): number {
  let t = 0;
  let p: C | null = c;
  for (let i = 0; i < steps && p !== null; i++) {
    t = (t + p.v) | 0;
    p = p.next;
  }
  return t;
}
function isGone(): boolean {
  return w === null || w.deref() === undefined;
}
export function clearedInTheEnd(): number {
  w = new WeakRef(ring(5, 1));
  let n = 0;
  while (!isGone() && n < 50) {
    grow(4000);
    n++;
  }
  return isGone() ? 1 : 0;
}
export function staysCleared(): number {
  grow(4000);
  return isGone() ? 1 : 0;
}
/** deref at every k: if it gives the target, the whole ring is there, and stays there while that count lasts. */
export function partway(from: number, to: number): number {
  let good = 0;
  for (let k = from | 0; k < (to | 0); k++) {
    const r = ring(5, 10);
    w = new WeakRef(r.next!);
    hold = r;
    hold = null;
    tick(k);
    const x = w.deref();
    if (x !== undefined) {
      hold = x;
      tick(k);
      if (sum(hold, 5) !== 60) return -1;
      hold = null;
    }
    good++;
  }
  return good;
}
/** The target only gets cleared from a decision. A held ring's weak reference keeps giving the target. */
export function heldRingStaysVisible(n: number): number {
  hold = ring(4, 1);
  w = new WeakRef(hold);
  for (let i = 0; i < (n | 0); i++) {
    tick(8);
    const x = w.deref();
    if (x === undefined || x.v !== 1) return -1;
  }
  hold = null;
  return 1;
}
/** deref that comes back undefined once must do so for good, whatever else gets allocated in the block. */
export function neverComesBack(n: number): number {
  w = new WeakRef(ring(3, 1));
  grow(4000);
  const first = isGone();
  for (let i = 0; i < (n | 0); i++) {
    const r = ring(3, i);
    if (r.v !== i) return -1;
    if (first && !isGone()) return -2;
  }
  return 1;
}
