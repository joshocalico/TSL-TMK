// JS % on floats: TIR's frem, exact for all inputs, with the dividend's sign.
import { type f64 } from "@tsl/core";

export function rem(a: f64, b: f64): f64 {
  return a % b;
}
