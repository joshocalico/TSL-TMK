// JS's ToBoolean of an `unknown` parameter in a module with no run-time strings and no exceptions (D49), where the test
// takes the version with no string case: a boxed false, 0, -0 and NaN are falsy, as are null and undefined.
class Thing {
  n = 1;
}

function t(x: unknown): number {
  return x ? 1 : 0;
}

function n(x: unknown): number {
  if (!x) return 1;
  return 0;
}

export function numbers(k: number): number {
  return t(k) + t(k - k) * 2 + t(-(k - k)) * 4 + t((k - k) / (k - k)) * 8 + t(k * 0.5) * 16;
}

export function bools(k: number): number {
  return t(k > 1) + t(k < 1) * 2 + n(k === 3) * 4 + n(k !== 3) * 8;
}

export function objects(k: number): number {
  return (
    t(k > 2 ? new Thing() : null) +
    t(undefined) * 2 +
    n(null) * 4 +
    n(k > 0 ? new Thing() : undefined) * 8
  );
}
