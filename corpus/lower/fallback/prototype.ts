// expect-fallback: patch prototype-mutation
class C {
  v = 1;
}
export function patch(): number {
  C.prototype.v = 2;
  return new C().v;
}
