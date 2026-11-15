// memory-pages: 2
// A leak package out of pages traps with code 14. V8 has no limit, so this is divergence 4 (SPEC 3.10).
import { type u32 } from "@tsl/core";

export class Big {
  next: Big | null = null;
  a: u32 = 0;
  b: u32 = 0;
}

let head: Big | null = null;

export function grow(n: u32): u32 {
  for (let i: u32 = 0; i < n; i++) {
    const b = new Big();
    b.a = i;
    b.next = head;
    head = b;
  }
  return n;
}

export function last(): u32 {
  return head === null ? 0 : head.a;
}
