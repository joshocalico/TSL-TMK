// memory-pages: 256
// @tsl/jsrt's JsArray written by hand in a `leak` package (D66): JS's push, pop, shift, length, growth and holes, with the
// expected values JS gives. Lowered programs print their arrays as this same class.
import { f64, i32, toF64, toI32, toU32, toUsize, u32, type usize } from "@tsl/core";
import { JsArray } from "@tsl/jsrt";
import { ref } from "@tsl/std";

class Item {
  constructor(public id: i32) {}
}

/** Pushes 0..n-1 through every doubling and reads each back: growth keeps every element, the last included. */
export function grows(n: u32): i32 {
  const a = new JsArray(i32, 0, true);
  for (let i: i32 = 0; i < toI32(n); i++) a.push(i * 3);
  let bad: i32 = 0;
  for (let i: usize = 0; i < a.length; i++) if (a.get(i) !== toI32(toU32(i)) * 3) bad++;
  return bad * 1000000 + toI32(toU32(a.length));
}

/** The last element pushed before each doubling, read straight after it. */
export function lastAfterGrowth(): i32 {
  const a = new JsArray(f64, 0, true);
  let bad: i32 = 0;
  for (let i: i32 = 0; i < 70; i++) {
    a.push(toF64(i) + 0.5);
    if (a.get(a.length - 1) !== toF64(i) + 0.5) bad++;
  }
  return bad;
}

/** JS: `[].pop()` is undefined, and the array stays empty; then a push gives length 1. */
export function popEmpty(): i32 {
  const a = new JsArray(i32, 0, true);
  const x = a.pop(-1);
  const y = a.pop(-1);
  a.push(7);
  return x * 100 + y * 10 + toI32(toU32(a.length));
}

/** Pops in reverse order, then one more on empty. */
export function popAll(n: u32): i32 {
  const a = new JsArray(i32, 0, true);
  for (let i: i32 = 1; i <= toI32(n); i++) a.push(i);
  let s: i32 = 0;
  for (let k: i32 = 1; k <= toI32(n); k++) s = s * 3 + a.pop(0) - k;
  return s + a.pop(-9) + toI32(toU32(a.length));
}

/** JS: `const a = []; a[3] = x;` leaves holes at 0, 1 and 2, which read as undefined. */
export function holes(): i32 {
  const a = new JsArray(ref<Item | null>(), 0, true);
  a.reserve(4);
  a.setLength(4);
  a.set(3, new Item(5));
  let n: i32 = 0;
  for (let i: usize = 0; i < 3; i++) if (a.get(i) === null) n++;
  const last = a.get(3);
  return n * 10 + (last === null ? 0 : last.id);
}

/** A buffer that was used and given back, taken again by a new array: its holes still read as holes. */
export function holesInReusedBuffer(): i32 {
  const first = new JsArray(ref<Item | null>(), 0, true);
  for (let i: i32 = 0; i < 5; i++) first.push(new Item(i + 1)); // the 4-slot buffer went back dirty
  const a = new JsArray(ref<Item | null>(), 0, true);
  a.setLength(3);
  a.set(2, new Item(9));
  let n: i32 = 0;
  for (let i: usize = 0; i < 2; i++) if (a.get(i) === null) n++;
  return n * 100 + toI32(toU32(first.length));
}

/**
 * Growth into a buffer given back dirty: what isn't copied reads as holes, the first of them included. `first` gives back
 * a 32-byte buffer holding 1 to 8; `b` grows into it keeping 4 elements, and slots 4 to 7 must read 0, not 5 to 8.
 */
export function holesPastTheCopy(): i32 {
  const first = new JsArray(i32, 0, true);
  for (let i: i32 = 1; i <= 9; i++) first.push(i);
  const b = new JsArray(i32, 0, true);
  for (let i: i32 = 0; i < 4; i++) b.push(100 + i);
  b.reserve(5);
  b.setLength(8);
  let s: i32 = 0;
  for (let i: usize = 4; i < 8; i++) s = s * 10 + b.get(i);
  return s * 1000 + b.get(3) + toI32(toU32(first.length));
}

/** JS: `a.length = 1` then `a[2] = x` leaves a hole at 1, not the old element. */
export function shrinkThenGrow(): i32 {
  const a = new JsArray(ref<Item | null>(), 0, true);
  a.push(new Item(1));
  a.push(new Item(2));
  a.push(new Item(3));
  a.setLength(1);
  a.setLength(3);
  a.set(2, new Item(4));
  const mid = a.get(1);
  return mid === null ? 1 : 100 + mid.id;
}

/** Shift moves everything down, and on empty gives `none`. */
export function shifts(): i32 {
  const a = new JsArray(i32, 0, true);
  for (let i: i32 = 1; i <= 6; i++) a.push(i * 10);
  const x = a.shift(-1);
  const y = a.shift(-1);
  let s: i32 = 0;
  a.forEach((v, i) => {
    s = s + v * toI32(toU32(i + 1));
  });
  const e = new JsArray(i32, 0, true);
  return x + y * 1000 + s * 10 + e.shift(-1) * 100000;
}

/** `new Array(n)`: n holes, then filled. */
export function sized(n: u32): i32 {
  const a = new JsArray(i32, toUsize(n), true);
  let z: i32 = 0;
  for (let i: usize = 0; i < a.length; i++) z = z + a.get(i);
  for (let i: usize = 0; i < a.length; i++) a.set(i, 2);
  for (let i: usize = 0; i < a.length; i++) z = z + a.get(i);
  return z;
}

/** Past the end traps 2, as `a[i]!` does on a hole that isn't there. */
export function pastTheEnd(): i32 {
  const a = new JsArray(i32, 0, true);
  a.push(1);
  return a.get(1);
}
