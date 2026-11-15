// expect-fallback: throwsNumber throw-non-error
// expect-fallback: errorValue throw-non-error
export function throwsNumber(): number {
  throw 5;
}
export function errorValue(): boolean {
  const e = new Error("x");
  return e.message === "x";
}
