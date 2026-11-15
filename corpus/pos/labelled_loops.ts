import { type i32, type u32 } from "@tsl/core";

export function firstPair(limit: u32, target: u32): u32 {
  let found: u32 = 0;
  outer: for (let a: u32 = 1; a < limit; a++) {
    for (let b: u32 = 1; b < limit; b++) {
      if (a * b === target) {
        found = a * 1000 + b;
        break outer;
      }
    }
  }
  return found;
}

export function skipRows(rows: u32, cols: u32): u32 {
  let count: u32 = 0;
  rows: for (let r: u32 = 0; r < rows; r++) {
    for (let c: u32 = 0; c < cols; c++) {
      if (c === r) continue rows;
      count++;
    }
    count += 100;
  }
  return count;
}

export function whileLabel(n: i32): i32 {
  let i = 0;
  let total = 0;
  scan: while (i < n) {
    i++;
    let j: i32 = 0;
    do {
      j++;
      if (j > i) continue scan;
      if (total > 1000) break scan;
      total += j;
    } while (j < 5);
    total += 1000;
  }
  return total;
}

export function blockBreak(x: i32): i32 {
  let r: i32 = 0;
  done: {
    if (x < 0) break done;
    r = 1;
    if (x === 0) break done;
    r = 2;
  }
  return r;
}

export function swapInLoop(n: u32): u32 {
  let a: u32 = 1;
  let b: u32 = 2;
  for (let i: u32 = 0; i < n; i++) {
    const t = a;
    a = b;
    b = t;
  }
  return a * 10 + b;
}
