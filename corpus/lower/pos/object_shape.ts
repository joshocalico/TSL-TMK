// Rule: object shape with fixed fields: struct in the arena, or a value record when it can't escape.
// expect-note: alloc-arena
type Point = { x: number; y: number };
type Rect = { min: Point; max: Point; tag: string extends never ? never : "a" | "b" };
function make(x: number, y: number): Point {
  return { x, y };
}
function area(r: Rect): number {
  return (r.max.x - r.min.x) * (r.max.y - r.min.y);
}
export function rectArea(a: number, b: number): number {
  return area({ min: make(0, 0), max: make(a, b), tag: "a" });
}
export function valueRecord(a: number): number {
  const p = { x: a | 0, y: 4 };
  p.x += 1;
  return p.x * p.y;
}
export function inLoop(n: number): number {
  let sum = 0;
  for (let i = 0; i < (n | 0); i++) {
    const p = { x: i, y: i * 2 };
    sum = (sum + p.x + p.y) | 0;
  }
  return sum;
}
export function returned(a: number): Point {
  return make(a, a * 2);
}
export function aliased(a: number): number {
  const p = make(a, 1);
  const q = p;
  q.x = 9;
  return p.x + q.y;
}
