// expect-fallback: keys reflection
// expect-fallback: viaEval reflection
// expect-fallback: viaProxy reflection
// expect-fallback: viaTypeof reflection
// expect-fallback: viaInstanceof reflection
export function keys(o: { a: number }): number {
  return Object.keys(o).length;
}
export function viaEval(): number {
  return eval("1 + 1") as number;
}
export function viaProxy(o: { a: number }): number {
  return new Proxy(o, {}).a;
}
export function viaTypeof(x: number): number {
  return typeof x === "number" ? 1 : 2;
}
export function viaInstanceof(x: Uint8Array): number {
  return x instanceof Uint8Array ? 1 : 2;
}
