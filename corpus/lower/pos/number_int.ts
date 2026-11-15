// Rule: number used only with integer ops, .length, integer literals and index positions: i32 where its range is proved to
// fit, and f64, which is JS's number exactly, where it isn't (SPEC 4.5). The counter, bounded by an i32, stays an integer,
// with no check left; the sum and the doubling, which can pass i32, are f64, and give what V8 gives.
// expect-tir: @sumTo\(%0: i32\)[^}]*add\.i32
// expect-tir: @sumTo\(%0: i32\) -> \(f64\)
function sumTo(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s = s + i;
  return s;
}
function viaIndex(a: Uint8Array): number {
  let at = 0;
  let sum = 0;
  while (at < a.length) {
    sum += a[at]!;
    at += 2;
  }
  return sum;
}
export function total(n: number): number {
  return sumTo(n | 0);
}
export function indexed(a: Uint8Array): number {
  return viaIndex(a);
}
function grow(n: number): number {
  let x = n;
  for (let i = 0; i < 40; i++) x = x * 2;
  return x;
}
export function overflow(n: number): number {
  return grow(n | 0);
}
function sub(a: number, b: number): number {
  return a - b;
}
export function negative(a: number, b: number): number {
  return sub(a | 0, b | 0);
}
export function zeroProduct(a: number): number {
  const z = (a | 0) * -1;
  return 1 / z;
}
