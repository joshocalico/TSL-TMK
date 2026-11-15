// Without noStd there's no rule, and @tsl/std is an ordinary import: tsc says it has no such export. It said it couldn't
// find the package, until the package existed.
// expect: TS2305 at 4:10
import { x } from "@tsl/std";
export function f(): number {
  return x;
}
