import { type f64, type i32, type u16, type u32, type u64, type u8 } from "@tsl/core";

type Pair = { readonly lo: u32; readonly hi: u32 };
export type Point = { readonly x: f64; readonly y: f64 };
type Mixed = { readonly a: u8; readonly b: u64; readonly c: f64; readonly d: i32 };
type Nested = { readonly p: Pair; readonly tag: u32 };
type Narrow = { readonly lo: u16; readonly hi: u16 };

export function split(x: u32): Pair {
  return { lo: x & 0xffff, hi: x >>> 16 };
}

export function join(p: Pair): u32 {
  return ((p.hi << 16) | p.lo) >>> 0;
}

export function roundTrip(x: u32): u32 {
  return join(split(x));
}

export function destructured(x: u32): u32 {
  const { lo, hi: high } = split(x);
  return lo + high;
}

export function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function dot(a: Point, b: Point): f64 {
  return a.x * b.x + a.y * b.y;
}

export function mixed(a: u8, b: u64, c: f64, d: i32): Mixed {
  return { a, b, c, d };
}

export function nested(x: u32): Nested {
  return { p: split(x), tag: 7 };
}

export function nestedSum(n: Nested): u32 {
  return n.p.lo + n.p.hi + n.tag;
}

export function reassign(x: u32, flip: boolean): Pair {
  let p: Pair = split(x);
  if (flip) p = { lo: p.hi, hi: p.lo };
  return p;
}

export function loopRecord(n: u32): u32 {
  let p: Pair = { lo: 0, hi: 1 };
  for (let i: u32 = 0; i < n; i++) {
    p = { lo: p.hi, hi: p.lo + p.hi };
  }
  return p.lo;
}

export function widened(n: Narrow): Pair {
  return n; // u16 fields widen to u32 field by field
}

export function callOrder(x: u32): Pair {
  return { hi: bump(x), lo: bump(x) };
}

let counter: u32 = 0;

function bump(x: u32): u32 {
  counter++;
  return x + counter;
}
