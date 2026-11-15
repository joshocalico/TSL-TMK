// Exceptions in lowered code (SPEC 4.5, D49): throw, try, catch and finally.
function thrower(a: number): number {
  if (a > 0) throw new Error(`positive ${a}`);
  return a;
}
export function guarded(a: number): number {
  try {
    return thrower(a);
  } catch {
    return -1;
  }
}
export function message(a: number): string {
  try {
    thrower(a);
    return "none";
  } catch (e) {
    if (e instanceof Error) return e.message;
    return "other";
  }
}
export function withFinally(a: number): number {
  let n = 0;
  try {
    n += thrower(a);
  } catch {
    n += 10;
  } finally {
    n += 100;
  }
  return n;
}
export function uncaught(a: number): number {
  return thrower(a) + 1;
}
