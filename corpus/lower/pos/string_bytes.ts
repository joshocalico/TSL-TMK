// Rule: String.fromCharCode(...bytes) === "lit": a byte comparison with no string.
export function isJfif(a: Uint8Array, at: number): boolean {
  return String.fromCharCode(...a.subarray(at | 0, (at | 0) + 4)) === "JFIF";
}
export function notAdobe(a: Uint8Array): boolean {
  return String.fromCharCode(...a.subarray(0, 5)) !== "Adobe";
}
export function reversed(a: Uint8Array): number {
  return "ok" === String.fromCharCode(...a) ? 1 : 0;
}
export function emptyLit(a: Uint8Array): boolean {
  return String.fromCharCode(...a.subarray(0, 0)) === "";
}
