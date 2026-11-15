// Integers past i32 and past 2^53 (SPEC 4.5): a `number` is an i32 only where its range is proved to fit, and an f64, which is
// JS's number exactly, where it isn't. Counters bounded by a parameter, sums, products and a factorial, against V8, with
// cases well past 2^31 and 2^53. A check that trapped here would be a wrong answer, not an allowed divergence.
export function sumSquares(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += i * i;
  return s;
}

export function sumTo(n: number): number {
  let s = 0;
  let i = 0;
  while (i < n) {
    i++;
    s += i;
  }
  return s;
}

export function product(n: number, k: number): number {
  let p = 1;
  for (let i = 0; i < k; i++) p *= n;
  return p;
}

export function factorial(n: number): number {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}

/** A counter bounded only by a parameter, starting high, and one going down past i32's least. */
export function countFrom(start: number, steps: number): number {
  let c = start;
  for (let i = 0; i < steps; i++) c++;
  return c;
}

export function countDown(start: number, steps: number): number {
  let c = start;
  for (let i = steps; i > 0; i--) c -= 3;
  return c;
}

/** Doubling: 2^k for k past 31 and past 53, where the f64 rounds as V8's does. */
export function doubling(k: number): number {
  let x = 1;
  for (let i = 0; i < k; i++) x = x * 2 + (i % 2);
  return x;
}

/** An array-bounded loop: its counter stays an integer, and the sum of large elements doesn't. */
export function sumBig(n: number): number {
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.push(2147483000 + i);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]!;
  return s;
}

/** Negation of the least i32, and a difference that leaves i32. */
export function negLeast(x: number): number {
  const m = (x | 0) - 2147483647 - 1;
  return -m;
}
