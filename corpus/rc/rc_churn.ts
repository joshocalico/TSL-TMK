// memory-pages: 64
// Churn far past the memory there is (SPEC 3.5, D39, D74): 256 KiB of pages, and lists of 100 nodes made and dropped
// 2,000 times, about 6 MiB of objects in all. In `rc` it completes, as each list's nodes are freed by the allocations
// after it. corpus/std/leak/churn_leak.ts is this program in a `leak` package, where it traps 14.
import { type u32 } from "@tsl/core";
import { rcSetWalk } from "@tsl/gc";

class Node {
  next: Node | null = null;
  constructor(public v: u32) {}
}

let head: Node | null = null;

export function churn(rounds: u32): u32 {
  rcSetWalk(false); // a cycle has to go before exhaustion would need the heap walk (R1d)
  let sum: u32 = 0;
  for (let r: u32 = 0; r < rounds; r++) {
    head = null;
    for (let i: u32 = 0; i < 100; i++) {
      const n = new Node(i);
      n.next = head;
      head = n;
    }
    for (let p = head; p !== null; p = p.next) sum += p.v;
  }
  head = null;
  return sum;
}
