// WeakRef while its target is strongly held, which is all V8 and rc have to agree on (SPEC 3.10, item 9). The cleared
// case can't be here: V8 may keep a target alive for longer. It's in corpus/lower/rc-only.
class P {
  constructor(public x: number) {}
}
const keep = new P(11);
const w = new WeakRef(keep);
class Cache {
  ref: WeakRef<P> | null = null;
}
export function fromGlobal(): number {
  const t = w.deref();
  return t === undefined ? -1 : t.x;
}
export function local(n: number): number {
  const p = new P(n | 0);
  const r = new WeakRef(p);
  const q = r.deref();
  return q === undefined ? -1 : q.x + p.x;
}
export function inField(n: number): number {
  const p = new P(n | 0);
  const c = new Cache();
  c.ref = new WeakRef(p);
  const q = c.ref.deref();
  return q === undefined ? -1 : q.x + p.x;
}
export function twoRefs(n: number): number {
  const p = new P(n | 0);
  const a = new WeakRef(p);
  const b = new WeakRef(p);
  const x = a.deref();
  const y = b.deref();
  return x !== undefined && y !== undefined && x === y ? x.x + p.x : -1;
}
export function ofArray(n: number): number {
  const a = [n | 0];
  const r = new WeakRef(a);
  const b = r.deref();
  return b === undefined ? -1 : b[0]! + a.length;
}
