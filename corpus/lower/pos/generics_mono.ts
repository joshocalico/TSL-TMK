// Rule: generic function/type, monomorphised per concrete instantiation.
// expect-tir: func @first\$?\d*\(
type Box<T> = { value: T; count: number };
function first<T>(a: T[]): T {
  return a[0]!;
}
function wrap<T>(value: T, count: number): Box<T> {
  return { value, count };
}
function pair<A, B>(a: A, b: B, pick: (x: A, y: B) => number): number {
  return pick(a, b);
}
export function nums(n: number): number {
  const b = wrap(n * 0.5, 2);
  return first([b.value, 1, 2]) + b.count;
}
export function flags(x: number): boolean {
  const b = wrap(x > 3, 1);
  return first([b.value, false]);
}
export function shapes(x: number): number {
  const p = wrap({ a: x | 0, b: 2 }, 1);
  return first([p]).value.a + p.value.b;
}
export function hof(x: number): number {
  return pair(x | 0, 2.5, (a, b) => a * b);
}
