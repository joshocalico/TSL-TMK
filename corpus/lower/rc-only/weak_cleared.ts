// What only rc can pin: a target's count hits zero, and deref gives undefined from that moment, whether or not it has
// been freed yet. V8 may keep it alive for longer (SPEC 3.10, item 9), so this isn't compared with V8.
class P {
  constructor(public x: number) {}
}
class Holder {
  p: P | null = null;
}
const h = new Holder();
let w: WeakRef<P> | null = null;
function isGone(): boolean {
  return w === null || w.deref() === undefined;
}
export function clearedWhileQueued(n: number): number {
  h.p = new P(n | 0);
  w = new WeakRef(h.p);
  const alive = isGone() ? 0 : 1;
  h.p = null; // the count is zero now, and with no allocation since, nothing has been freed
  return alive * 10 + (isGone() ? 1 : 0);
}
export function staysCleared(): number {
  let t = 0;
  for (let i = 0; i < 2000; i++) t += new P(i).x;
  return t > 0 && isGone() ? 1 : 0;
}
export function neverResurrected(n: number): number {
  h.p = new P(n | 0);
  w = new WeakRef(h.p);
  const again = w.deref()!;
  h.p = null;
  const stillHeld = isGone() ? 0 : 1; // `again` still has a count
  return stillHeld * 100 + again.x;
}
export function afterLastLocal(): number {
  return isGone() ? 1 : 0;
}
export function derefKeepsItAlive(n: number): number {
  h.p = new P(n | 0);
  w = new WeakRef(h.p);
  const strong = w.deref();
  h.p = null;
  let t = 0;
  for (let i = 0; i < 2000; i++) t += new P(i).x;
  return strong === undefined || t === 0 ? -1 : strong.x;
}
export function closure(n: number): number {
  const p = new P(n | 0);
  let f: (() => number) | null = (): number => p.x;
  const r = new WeakRef(f);
  const alive = r.deref() === undefined ? 0 : 1;
  f = null;
  return alive * 10 + (r.deref() === undefined ? 1 : 0);
}
export function refOutlivesTarget(): number {
  const r = make();
  let t = 0;
  for (let i = 0; i < 100; i++) t += new P(i).x;
  return r.deref() === undefined && t > 0 ? 1 : 0;
}
function make(): WeakRef<P> {
  return new WeakRef(new P(1));
}
