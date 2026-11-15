// Rule: destructure and spread of a known shape: field-wise copy. A tuple from a conditional: scalars.
// expect-no-tir: @tupleScalars[^\n]*\n(?:(?!\nfunc )[\s\S])*__vec_new
type A = { x: number; y: number };
export function destructure(o: A): number {
  const { x, y: why } = o;
  return x - why;
}
export function defaulted(o: { a?: number; b: number }): number {
  const { a = 5, b } = o;
  return a * b;
}
export function spread(o: A): { x: number; y: number; z: number } {
  return { ...o, y: 10, z: o.x + 1 };
}
export function spreadCopies(o: A): number {
  const c = { ...o };
  c.x = 100;
  return o.x + c.x;
}
function tupleScalars(flag: boolean, a: number): number {
  const [p, q, r] = flag ? [a - 1, a - 2, a - 3] : [a, 2, 3];
  return p * 100 + q * 10 + r;
}
export function tuple(flag: boolean, a: number): number {
  return tupleScalars(flag, a);
}
export function fromArray(a: number[]): number {
  const [p, q] = a;
  return (p ?? 1) + (q ?? 2);
}
function param({ x, y }: A, [m, n]: [number, number]): number {
  return x * m + y * n;
}
export function patterns(a: number): number {
  return param({ x: a, y: 2 }, [3, 4]);
}
export function nestedPattern(o: { p: A }): number {
  const {
    p: { x },
  } = o;
  return x;
}
