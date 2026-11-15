// Every way to export: named, renamed, default, const arrow; and a class, which only JS can provide.
// expect-lowered: plain
// expect-lowered: inner
// expect-lowered: arrow
// expect-lowered: fallbackName
// expect-fallback: Thing.constructor export-signature
function inner(a: number): number {
  return a + 1;
}
function plain(a: number): number {
  return a + 2;
}
export { inner as renamed, plain };
export const arrow = (a: number): number => a + 3;
export default function fallbackName(a: number): number {
  return a + 4;
}
export class Thing {
  v = 1;
}
