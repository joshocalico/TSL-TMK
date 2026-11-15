// The second module of rc_features.ts: its classes' stores are exported beside them, and rc_features.ts imports both.
import { type u32 } from "@tsl/core";
import { ref, Vec } from "@tsl/std";

export class Circle {
  constructor(public r: u32) {}
}

export class Square {
  constructor(public s: u32) {}
}

export class Group {
  circles = new Vec(ref<Circle>());
  squares = new Vec(ref<Square>());
  first: Circle | null = null;
}

export function total(g: Group): u32 {
  let t: u32 = 0;
  g.circles.forEach((c) => {
    t += c.r;
  });
  g.squares.forEach((s) => {
    t += s.s * 2;
  });
  g.first = g.circles.length > 0 ? g.circles.get(0) : null;
  return t + (g.first === null ? 0 : 100);
}
