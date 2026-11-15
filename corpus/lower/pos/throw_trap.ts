// Rule: throw with no catch: trap, and the export glue rethrows new Error(msg) with scalar parts.
// expect-tir: trap t\d+
type K = "a" | "b";
function check(n: number): number {
  if (n > 10) throw new Error(`too big (${n}×${n * 2})`);
  return n;
}
export function plain(n: number): number {
  if (n < 0) throw new Error("negative");
  return check(n | 0);
}
export function typed(n: number): number {
  if (n === 1) throw new RangeError("out of range");
  if (n === 2) throw new TypeError(`bad ${n / 4}`);
  return 0;
}
export function withLit(k: K, flag: boolean): number {
  if (flag) throw new Error(`kind ${k} flag ${flag}`);
  return 1;
}
export function inClosure(n: number): number[] {
  return Array.from({ length: 2 }, (_, i) => {
    if (i === n) throw new Error(`stopped at ${i}`);
    return i;
  });
}
export function writesBeforeThrow(a: Uint8Array): void {
  a[0] = 42;
  throw new Error("after write");
}
export function neverReturns(n: number): number {
  const fail = (): never => {
    throw new Error("always");
  };
  return n > 0 ? n : fail();
}
