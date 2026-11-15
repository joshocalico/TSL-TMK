// pop, shift, splice, `length = 0` and an overwrite release what they take out: a WeakRef shows it the moment it happens.
class P {
  constructor(public x: number) {}
}
function holder(n: number): { a: P[]; r: WeakRef<P> } {
  const p = new P(n);
  return { a: [p, new P(n + 1)], r: new WeakRef(p) };
}
const gone = (r: WeakRef<P>): number => (r.deref() === undefined ? 1 : 0);
export function pop(): number {
  const a = [new P(1)];
  const r = new WeakRef(a[0]!);
  a.pop();
  return gone(r);
}
export function shift(): number {
  const h = holder(1);
  h.a.shift();
  return gone(h.r);
}
export function spliceDiscarded(): number {
  const h = holder(1);
  h.a.splice(0, 1);
  // The array splice returned is what holds it. That array's slots are visited when it's freed, which an allocation does.
  const before = gone(h.r);
  let t = 0;
  for (let i = 0; i < 4; i++) t += new P(i).x;
  return before * 10 + gone(h.r) + t - t;
}
export function spliceKept(): number {
  const h = holder(1);
  const kept = h.a.splice(0, 1);
  return gone(h.r) * 10 + kept.length;
}
export function lengthZero(): number {
  const h = holder(1);
  h.a.length = 0;
  return gone(h.r);
}
export function overwrite(): number {
  const h = holder(1);
  h.a[0] = new P(9);
  return gone(h.r);
}
export function stillHeldElsewhere(): number {
  const h = holder(1);
  const other = [h.a[0]!];
  h.a.length = 0;
  const before = gone(h.r);
  other.length = 0;
  return before * 10 + gone(h.r);
}
export function scopeEnd(): number {
  let r: WeakRef<P> | null = null;
  {
    const p = new P(1);
    r = new WeakRef(p);
  }
  return r === null ? -1 : gone(r);
}
export function loopIteration(): number {
  let r: WeakRef<P> | null = null;
  let t = 0;
  for (let i = 0; i < 2; i++) {
    const p = new P(i);
    if (r !== null) t += gone(r);
    r = new WeakRef(p);
  }
  return t;
}
