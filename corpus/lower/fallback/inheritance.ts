// expect-fallback: subclass inheritance
class Base {
  v = 1;
}
class Derived extends Base {
  w = 2;
}
export function subclass(): number {
  const d = new Derived();
  return d.v + d.w;
}
