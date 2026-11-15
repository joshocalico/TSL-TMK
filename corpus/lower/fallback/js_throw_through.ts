// On a JS host, a lowered function that calls a fallback which throws: the exception goes through the Wasm frame to the
// caller as the same JS exception (SPEC 4.5, D49). In a memory mode, all of it lowers, and natively it's the same.
// expect-fallback: helper try-catch
// expect-lowered: outer
// expect-lowered: twice
function helper(n: number): number {
  try {
    if (n < 0) throw new RangeError("negative");
    return n + 1;
  } finally {
    n = 0;
  }
}

export function outer(n: number): number {
  return helper(n) * 2;
}

export function twice(n: number): number {
  return outer(n) + outer(n - 5);
}
