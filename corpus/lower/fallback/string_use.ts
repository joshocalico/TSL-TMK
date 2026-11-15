// expect-fallback: concat string-use
// expect-fallback: compareVar string-from-spread
// expect-fallback: template string-use
// expect-fallback: jsonish string-use
// expect-fallback: lengthOf string-use
export function concat(a: string): string {
  return a + "x";
}
const OTHER: string = "JFIF";
export function compareVar(b: Uint8Array): boolean {
  return String.fromCharCode(...b) === OTHER;
}
export function template(n: number): string {
  return `n=${n}`;
}
export function jsonish(n: number): string {
  return JSON.stringify({ n });
}
export function lengthOf(s: string): number {
  return s.length;
}
