// expect-fallback: weakInStrict weakref
// WeakRef says when a target has gone, and only a count can (SPEC 3.5). It's a fallback in every other mode.
class P {
  constructor(public x: number) {}
}
export function weakInStrict(n: number): number {
  const p = new P(n | 0);
  const r = new WeakRef(p);
  return r.deref() === undefined ? -1 : p.x;
}
