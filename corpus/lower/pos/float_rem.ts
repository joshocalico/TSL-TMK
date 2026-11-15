// Float %: TIR's frem, exact for all inputs, where x - trunc(x / y) * y isn't.
// expect-tir: frem\.f64
export function rem(a: number, b: number): number {
  return a % b;
}
export function remAssign(a: number, b: number): number {
  let x = a * 1.5;
  x %= b;
  return x;
}
function intRem(a: number, b: number): number {
  return a % b;
}
export function intRemZero(a: number): number {
  return 1 / intRem(a | 0, 2);
}
