// The inliner's rules on a program every engine and level runs (SPEC D46): `@tsl.inline` and `@tsl.noinline`, recursion
// and mutual recursion, several results, a `@tsl.noalloc` caller, and checks inside what's inlined,
// whose traps must keep their codes at every level.
import { type i32, type u32, type usize } from "@tsl/core";

type Span = { readonly lo: i32; readonly hi: i32 };

/** @tsl.inline */
function square(x: i32): i32 {
  return x * x;
}

/** @tsl.noinline */
function bump(x: i32): i32 {
  return x + 1;
}

function even(n: u32): boolean {
  return n === 0 ? true : odd(n - 1);
}
function odd(n: u32): boolean {
  return n === 0 ? false : even(n - 1);
}

function depth(n: u32): u32 {
  return n === 0 ? 0 : 1 + depth(n - 1);
}

function span(a: i32, b: i32): Span {
  return a < b ? { lo: a, hi: b } : { lo: b, hi: a };
}

/** @tsl.noalloc */
function addTo(acc: i32, x: i32): i32 {
  return acc + x;
}

function at(xs: Uint8Array, i: usize): u32 {
  return xs[i]!;
}

export function squares(a: i32, b: i32): i32 {
  return square(a) + square(b);
}

export function bumped(x: i32): i32 {
  return bump(bump(x));
}

export function parity(n: u32): u32 {
  return even(n) ? 1 : 0;
}

export function deep(n: u32): u32 {
  return depth(n);
}

export function width(a: i32, b: i32): i32 {
  const s = span(a, b);
  return s.hi - s.lo;
}

/** @tsl.noalloc */
export function sumTo(n: i32): i32 {
  let s: i32 = 0;
  for (let i: i32 = 0; i < n; i++) s = addTo(s, i);
  return s;
}

export function pick(xs: Uint8Array, i: usize, j: usize): u32 {
  return at(xs, i) + at(xs, j);
}
