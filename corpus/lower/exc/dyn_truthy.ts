// JS's ToBoolean of an `unknown` (D49): `if (e)` on a caught value. A primitive is in a box, and a box is an object, so the
// test once read the pointer and called a boxed false, 0, -0, NaN and "" true, where V8 calls them false. Every falsy value,
// and a truthy one of each kind, through each form a condition takes: `if`, `!`, `&&`, `||`, `?:`, `Boolean()`, a loop.
class Thing {
  n = 1;
}

function raise(k: number): void {
  if (k === 0) throw false;
  if (k === 1) throw 0;
  if (k === 2) throw -0;
  if (k === 3) throw NaN;
  if (k === 4) throw "";
  if (k === 5) throw null;
  if (k === 6) throw undefined;
  if (k === 7) throw true;
  if (k === 8) throw 1;
  if (k === 9) throw -0.5;
  if (k === 10) throw "0";
  if (k === 11) throw " ";
  if (k === 12) throw new Error("");
  if (k === 13) throw new Thing();
  if (k === 14) throw Infinity;
  throw "false";
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
  const e = caught(k);
  return !e;
}

export function viaAnd(k: number): number {
  const e = caught(k);
  return e && k >= 0 ? 1 : 2;
}

export function viaOr(k: number): number {
  const e = caught(k);
  return e || k < 0 ? 3 : 4;
}

export function viaCond(k: number): string {
  const e = caught(k);
  return e ? "truthy" : "falsy";
}

export function viaBoolean(k: number): boolean {
  return Boolean(caught(k));
}

export function viaWhile(k: number): number {
  let e = caught(k);
  let n = 0;
  while (e && n < 3) {
    n++;
    if (n === 2) e = caught(0);
  }
  return n;
}

export function inCatch(k: number): string {
  try {
    raise(k);
    return "none";
  } catch (e) {
    if (!e) return "falsy";
    return "truthy";
  }
}

export function countFalsy(from: number, to: number): number {
  let n = 0;
  for (let k = from; k <= to; k++) if (!caught(k)) n++;
  return n;
}
