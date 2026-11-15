// A cast that isn't an upcast may name a field the object lacks: V8 reads undefined, and a struct has
// no way to say so. The function stays JS, so it can't silently read 0 (SPEC 3.10, 4.5).
// expect-fallback: lies unsound-cast
// expect-fallback: nullDropped unsound-cast
// expect-lowered: honest
type Narrow = { a: number };
type Wide = { a: number; b: number };
export function lies(flag: boolean): boolean {
  const n: Narrow = { a: flag ? 1 : 2 };
  const w = n as Wide;
  return w.b === undefined;
}
export function nullDropped(o: Narrow | null): boolean {
  return (o as Narrow).a === 1;
}
export function honest(flag: boolean): number {
  const w: Wide = { a: flag ? 1 : 2, b: 3 };
  const n = w as Narrow;
  return n.a;
}
