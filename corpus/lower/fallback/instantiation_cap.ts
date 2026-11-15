// Polymorphic recursion has no finite set of instantiations.
// expect-fallback: grow instantiation-cap
// expect-fallback: start callee
function grow<T>(x: T, n: number): number {
  return n <= 0 ? 0 : grow<{ v: T }>({ v: x }, n - 1) + 1;
}
export function start(n: number): number {
  return grow(1, n);
}
