// Module state: scalars and statics live in memory across calls, and initialisers run once.
// expect-tir: func @__init
let counter = 0;
const FIXED = 3;
const TABLE = new Uint8Array([1, 2, 3]);
const SIZED = new Int32Array(4);
const LOOKUP = [0.5, 1.5];
const POINTS = [{ x: 1 }, { x: 2 }];
const COMPUTED = build(5);
let ratio = 1;
function build(n: number): Uint16Array {
  const t = new Uint16Array(n);
  for (let i = 0; i < n; i++) t[i] = i * i;
  return t;
}
for (let i = 0; i < SIZED.length; i++) SIZED[i] = i + 10;
export function next(): number {
  counter++;
  return counter + FIXED;
}
export function bumpTable(i: number): number {
  TABLE[i | 0] = TABLE[i | 0]! + 1;
  return TABLE[i | 0]!;
}
export function reads(i: number): number[] {
  return [LOOKUP[i | 0]!, POINTS[i | 0]!.x, COMPUTED[i | 0]!, SIZED[i | 0]!];
}
export function setRatio(x: number): number {
  ratio *= x;
  return ratio;
}
