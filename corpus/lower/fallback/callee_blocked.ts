// A caller falls back only because of its callee, and the report says which and why.
// expect-fallback: holdsMap map-set
// expect-fallback: objectCaller callee
// expect-fallback: objectResult callee
// expect-fallback: objectMaker map-set
// expect-blocked: objectTaker objectCaller
// expect-fallback: objectTaker map-set
// expect-lowered: scalarCaller
// expect-fallback: touch map-set
// expect-warning: TSLD0100
function holdsMap(a: number): number {
  return new Map([[1, a]]).get(1)!;
}
function objectTaker(o: { a: number }): number {
  return new Map([[1, o.a]]).get(1)!;
}
function objectMaker(a: number): { a: number } {
  return new Map([[1, { a }]]).get(1)!;
}
export function objectCaller(a: number): number {
  return objectTaker({ a });
}
export function objectResult(a: number): number {
  return objectMaker(a).a;
}
export function scalarCaller(n: number): number {
  let s = 0;
  for (let i = 0; i < (n | 0); i++) s += holdsMap(i);
  return s;
}
export function arrayShim(a: Uint8Array): number {
  return touch(a) + a[0]!;
}
function touch(a: Uint8Array): number {
  const m = new Map([[0, a]]);
  m.get(0)![0] = 200;
  return a.length;
}
