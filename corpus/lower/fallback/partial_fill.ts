// new Array(n).fill(x, a, b) leaves scalar holes, which scalar slots can't hold.
// expect-fallback: partial unsupported
// expect-lowered: whole
export function partial(): number {
  return new Array<number>(3).fill(1, 0, 1).length;
}
export function whole(): number {
  return new Array<number>(3).fill(1)[2]!;
}
