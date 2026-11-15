// expect-fallback: remember escape-global
// expect-fallback: recall shared-state
// expect-fallback: grow escape-global
// expect-lowered: scalarState
let kept: { v: number } | null = null;
let n = 0;
const list: { v: number }[] = [];
export function remember(v: number): void {
  kept = { v };
}
export function recall(): number {
  return kept?.v ?? -1;
}
export function grow(v: number): number {
  list.push({ v });
  return list.length;
}
export function scalarState(): number {
  return ++n;
}
