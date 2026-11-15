// Checks inside functions the optimiser inlines trap with the same code at every level (SPEC 3.10, D44, D46): an
// overflow, an index, a division, and the program's own code, each from inside a small callee.
import { type i32, idiv, trap, type u32, type usize } from "@tsl/core";

/** @tsl.inline */
function square(x: i32): i32 {
  return x * x;
}

function at(xs: Uint8Array, i: usize): u32 {
  return xs[i]!;
}

function ratio(a: i32, b: i32): i32 {
  return idiv(a, b);
}

function check(x: u32): u32 {
  if (x === 13) trap(Code.Thirteen);
  return x;
}

export function squareBig(x: i32): i32 {
  return square(x) + 1;
}

export function pastEnd(xs: Uint8Array, i: usize): u32 {
  return at(xs, i) + 1;
}

export function divide(a: i32, b: i32): i32 {
  return ratio(a, b) + 1;
}

export function unlucky(x: u32): u32 {
  return check(x) + 1;
}

export function ignored(xs: Uint8Array, i: usize): u32 {
  at(xs, i);
  return 7;
}

/** This program's own trap code (3.10: from 1000, named). */
enum Code {
  Thirteen = 1013,
}
