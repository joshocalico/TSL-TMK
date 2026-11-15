// A nullable field keeps its null whichever object literal met its class first: reading it back as anything else shows
// V8 a missing field where it has `null` (SPEC 4.5). No other strict program pins this.
type Inner = { id: number };
type Box = { id: number; next: Inner | null };
function withNull(id: number): Box {
  return { id, next: null };
}
function plainLiteral(id: number): { id: number; next: Inner } {
  return { id, next: { id: id + 1 } };
}
export function literalFirst(flag: boolean): Box {
  const a = plainLiteral(2);
  const b: Box = flag ? a : withNull(1);
  return b;
}
export function nullFirst(flag: boolean): Box {
  const b: Box = flag ? withNull(1) : plainLiteral(2);
  return b;
}
export function assignedLater(): Box {
  const lit = { id: 5, next: { id: 6 } };
  const b: Box = lit;
  b.next = null;
  return b;
}
export function arrayOfThem(): Box[] {
  return [plainLiteral(7), withNull(8)];
}
