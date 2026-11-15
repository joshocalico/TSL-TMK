// A cast of an `unknown` that lies (D49, 3.10): `(e as Error).message` is a narrowing with the class id checked, so a
// value that isn't what it was cast to traps 17, where V8 would read on and find undefined (divergence 1). No V8 to compare
// with: each case pins its value or its trap. The truthful ones are in corpus/lower/exc/cast_unknown.ts.
class AppError extends Error {
  code = 3;
}

function thrown(k: number): unknown {
  try {
    if (k === 0) throw "a string";
    if (k === 1) throw new Error("plain");
    if (k === 2) throw new AppError("app");
    if (k === 3) throw 12;
    throw null;
  } catch (e) {
    return e;
  }
}

export function messageLength(k: number): number {
  const e = thrown(k);
  return (e as Error).message.length;
}

export function appCode(k: number): number {
  const e = thrown(k);
  return (e as AppError).code;
}

export function plusOne(k: number): number {
  const e = thrown(k);
  return (e as number) + 1;
}
