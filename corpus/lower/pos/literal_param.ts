// Rule: parameter with a literal-union type: one copy per constant, then const-fold.
// expect-tir: func @scaled\$1
// expect-tir: func @scaled\$8
// expect-no-tir: @scaled\$8[^\n]*\n(?:(?!\nfunc )[\s\S])*fdiv
function scaled(n: number, scale: 1 | 8): number {
  const block = 8 / scale;
  return n * block;
}
function outer(n: number, scale: 1 | 8): number {
  return scaled(n, scale) + (scale === 8 ? 1 : 2);
}
export function atConstant(n: number): number {
  return scaled(n | 0, 8);
}
export function atRunTime(n: number, big: boolean): number {
  const scale = big ? 8 : 1;
  return outer(n | 0, scale);
}
