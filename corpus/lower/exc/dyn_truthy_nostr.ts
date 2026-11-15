// JS's ToBoolean of an `unknown` in a module with no run-time strings (D49): nothing here can box a string, so the test
// leaves that case out, and every other falsy value is still falsy. See dyn_truthy.ts for the module with strings.
class Thing {
  n = 1;
}

function raise(k: number): void {
  if (k === 0) throw false;
  if (k === 1) throw 0;
  if (k === 2) throw -0;
  if (k === 3) throw NaN;
  if (k === 4) throw null;
  if (k === 5) throw undefined;
  if (k === 6) throw true;
  if (k === 7) throw 1;
  if (k === 8) throw -0.5;
  if (k === 9) throw new Thing();
  throw Infinity;
}

function caught(k: number): unknown {
  try {
    raise(k);
  } catch (e) {
    return e;
  }
  return 42;
}

export function viaIf(k: number): number {
  const e = caught(k);
  if (e) return 1;
  return 0;
}

export function viaNot(k: number): boolean {
  return !caught(k);
}

export function viaCond(k: number): number {
  const e = caught(k);
  return e && k >= 0 ? 5 : 6;
}

export function viaBoolean(k: number): boolean {
  return Boolean(caught(k));
}
