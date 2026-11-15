// A layout class made with a -0 initialiser keeps its sign: -0 isn't a zero a zeroed object already holds (SPEC 3.5),
// so make() stores it. Observed through 1 / x, which is -Infinity for -0 and Infinity for +0.
import { f32, f64, make, type i32 } from "@tsl/core";

export class Pair {
  a = f64();
  b = f32();
}

const NEG = -0;

export function signs(): i32 {
  const p = make(Pair, { a: -0, b: -0 });
  const q = make(Pair, { a: NEG, b: 0 });
  return (
    (1 / p.a < 0 ? 1 : 0) + (1 / p.b < 0 ? 2 : 0) + (1 / q.a < 0 ? 4 : 0) + (1 / q.b < 0 ? 8 : 0)
  );
}
