// expect-fallback: stored closure-escape
// expect-fallback: returned closure-escape
// expect-fallback: viaField closure-escape
// expect-fallback: captureMutated closure-recursive
export function stored(a: number): number {
  const fs = [(x: number): number => x + a];
  return fs[0]!(1);
}
export function returned(a: number): number {
  const mk = (k: number) => (x: number) => x + k;
  return mk(a)(1);
}
export function viaField(a: number): number {
  const o = { f: (x: number): number => x * a };
  return o.f(2);
}
export function captureMutated(n: number): number {
  let total = 0;
  function walk(k: number): void {
    if (k > 0) {
      total += k;
      walk(k - 1);
    }
  }
  walk(n);
  return total;
}
