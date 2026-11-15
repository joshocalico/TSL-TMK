// Rule: discriminated union is a tagged value; a literal-only union is a small integer.
// expect-tir: iconst\.i32
type Shape =
  | { kind: "circle"; r: number }
  | { kind: "rect"; w: number; h: number }
  | { kind: "dot" };
type Colour = "red" | "green" | "blue";
type Level = 1 | 2 | 3;
function area(s: Shape): number {
  switch (s.kind) {
    case "circle":
      return 3 * s.r * s.r;
    case "rect":
      return s.w * s.h;
    case "dot":
      return 0;
  }
}
function pick(n: number): Shape {
  if (n === 0) return { kind: "circle", r: 2 };
  if (n === 1) return { kind: "rect", w: 3, h: 1.5 };
  return { kind: "dot" };
}
function next(c: Colour): Colour {
  return c === "red" ? "green" : c === "green" ? "blue" : "red";
}
export function areaOf(n: number): number {
  return area(pick(n | 0));
}
export function shape(n: number): Shape {
  return pick(n | 0);
}
export function cycle(c: Colour): Colour {
  return next(next(c));
}
export function level(n: number): Level {
  const l: Level = n > 2 ? 3 : n > 1 ? 2 : 1;
  return l;
}
export function isGreen(c: Colour): boolean {
  return c === "green";
}
