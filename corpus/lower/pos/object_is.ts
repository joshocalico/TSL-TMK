// Object.is on scalars of a known type (SPEC 4.5): `===`, except that NaN is itself and -0 isn't +0.
export function nums(a: number, b: number): boolean {
  return Object.is(a, b);
}

export function ints(a: number, b: number): boolean {
  const x = a | 0;
  const y = b | 0;
  return Object.is(x, y);
}

export function mixed(a: number): boolean {
  const x = a | 0;
  return Object.is(x, a);
}

export function bools(a: boolean, b: boolean): boolean {
  return Object.is(a, b);
}

export function zeroes(): number {
  let n = 0;
  if (Object.is(0, -0)) n += 1;
  if (Object.is(-0, -0)) n += 2;
  if (Object.is(NaN, NaN)) n += 4;
  if (Object.is(0, 0)) n += 8;
  if (Object.is(NaN, 0)) n += 16;
  if (Object.is(1.5, 1.5)) n += 32;
  return n;
}

export function evaluatedOnce(a: number): number {
  let n = a;
  const same = Object.is((n += 0.5), (n += 0.5));
  return same ? n : n * 2;
}
