import { type i32, type u32, type u64, type usize } from "@tsl/core";

export enum Op {
  Add = 0,
  Sub = 1,
  Mul = 2,
  Neg = -7,
}

export type Mode = "fast" | "safe" | "off";

export function byEnum(op: Op, a: i32, b: i32): i32 {
  switch (op) {
    case Op.Add:
      return (a + b) | 0;
    case Op.Sub:
      return (a - b) | 0;
    case Op.Mul:
      return Math.imul(a, b);
    case Op.Neg:
      return (0 - a) | 0;
  }
}

export function byMode(m: Mode): u32 {
  switch (m) {
    case "fast":
      return 1;
    case "safe":
      return 2;
    default:
      return 3;
  }
}

export function fallThrough(x: u32): u32 {
  let n: u32 = 0;
  switch (x) {
    case 0:
      n += 1;
    case 1:
      n += 10;
      break;
    default:
      n += 100;
    case 2:
      n += 1000;
  }
  return n;
}

export function isSafe(m: Mode): boolean {
  return m === "safe";
}

export function nextMode(m: Mode): Mode {
  return m === "fast" ? "safe" : m === "safe" ? "off" : "fast";
}

let current: Mode = "safe"; // a mutable global literal union: a small integer in memory
let selected: Op = Op.Sub;

export function swapMode(m: Mode): Mode {
  const before = current;
  current = m;
  return before;
}

export function selectOp(o: Op): Op {
  const before = selected;
  selected = o;
  return before;
}

const FIRST: Mode = "off"; // an annotated constant stays typed

export function firstMode(): Mode {
  return FIRST;
}

type BinOp = (a: i32, b: i32) => i32;

function add(a: i32, b: i32): i32 {
  return (a + b) | 0;
}
function sub(a: i32, b: i32): i32 {
  return (a - b) | 0;
}
const mul = (a: i32, b: i32): i32 => Math.imul(a, b);

const OPS: readonly BinOp[] = [add, sub, mul];

export function byTable(i: usize, a: i32, b: i32): i32 {
  return OPS[i]!(a, b);
}

function apply(f: BinOp, a: i32, b: i32): i32 {
  return f(a, b);
}

export function viaParam(which: u32, a: i32, b: i32): i32 {
  const chosen = which === 0 ? add : sub;
  return apply(chosen, a, b) + apply(mul, a, 2);
}

export function bigSwitch(x: u64): u32 {
  switch (x) {
    case 0n:
      return 1;
    case 18446744073709551615n:
      return 2;
    default:
      return 3;
  }
}
