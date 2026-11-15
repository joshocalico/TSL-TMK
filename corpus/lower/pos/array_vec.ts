// Rule: Array<T> of known element type: arena-backed vector, with nullable slots for holes.
// expect-tir: __vec_reserve
type Item = { id: number };
export function pushPop(n: number): number[] {
  const a: number[] = [];
  for (let i = 0; i < (n | 0); i++) a.push(i * 2);
  a.pop();
  return a;
}
export function floats(): number[] {
  const a = [1, 2.5];
  a.push(3);
  return a;
}
export function intsStayInts(a: number): number {
  const ints = [1, 2, 3];
  const fracs = [0.5, 0.25];
  return ints[a | 0]! + fracs[0]!;
}
export function holes(): (Item | undefined)[] {
  const a: Item[] = [];
  a[2] = { id: 7 };
  return a;
}
export function holeRead(i: number): number {
  const a: Uint16Array[] = [];
  a[3] = new Uint16Array(2);
  return a[i | 0]?.length ?? -1;
}
export function holeBang(i: number): number {
  const a: Item[] = [];
  a[1] = { id: 1 };
  return a[i | 0]!.id;
}
export function outOfRange(a: number[], i: number): number {
  return a[i | 0] ?? -5;
}
export function assignPast(n: number): number {
  const a = [1, 2];
  a[2] = 3;
  a[n | 0] = 4;
  return a.length;
}
export function mutateArg(a: number[]): void {
  a[0] = 9;
  a.push(1);
}
export function nestedVec(): number[][] {
  return [[1], [2, 3], []];
}
export function spreadLit(a: number[]): number[] {
  return [0, ...a, 9];
}
export function filled(n: number): number[] {
  return new Array<number>(n | 0).fill(4);
}
