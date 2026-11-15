// A top-level initialiser lowered code can't run keeps its readers in JS, with the root cause.
// expect-fallback: reader global-init
// expect-lowered: free
const SIZE = new Map([[1, 2]]).size;
export function reader(): number {
  return SIZE + 1;
}
export function free(a: number): number {
  return a + 1;
}
