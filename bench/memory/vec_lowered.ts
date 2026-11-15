// Arrays under `leak` and `manual`, for the vectors' step of class printing (D66): n numbers pushed through every
// doubling, read back by index, popped by half, and an array of objects pushed and walked, with a hole read at its end.
class Cell {
  constructor(public value: number) {}
}

export function vecWork(n: number): number {
  const m = n | 0;
  const a: number[] = [];
  for (let i = 0; i < m; i++) a.push((i * 7) | 0);
  let t = 0;
  for (let i = 0; i < a.length; i++) t = (t + a[i]!) | 0;
  for (let i = 0; i < m >> 1; i++) t = (t ^ (a.pop() ?? 0)) | 0;
  const cells: Cell[] = [];
  for (let i = 0; i < m >> 2; i++) cells.push(new Cell(i));
  for (let i = 0; i < cells.length; i++) t = (t + cells[i]!.value) | 0;
  return (t + (cells[cells.length + 1] === undefined ? 1 : 0)) | 0;
}
