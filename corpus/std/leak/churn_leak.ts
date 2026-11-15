// memory-pages: 64
// Churn far past the memory there is (SPEC 3.5, D39, D74): 256 KiB of pages, and lists of 100 nodes made and dropped
// 2,000 times, about 6 MiB of objects in all. In `leak` nothing is freed, so natively it traps 14, where V8's own
// collector lets it finish. corpus/rc/rc_churn.ts is the same program in `rc`, where it completes natively too.
import { type u32 } from "@tsl/core";

class Node {
  next: Node | null = null;
  constructor(public v: u32) {}
}

let head: Node | null = null;

export function churn(rounds: u32): u32 {
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
