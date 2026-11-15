// bench/memory/churn_lowered.ts in `rc` TSL (D74): n small objects in all, at most 64 alive. Against C, and beside the
// direct route's lowered churn in rc (`tmk bench memory`).
import { type u32 } from "@tsl/core";

class Node {
  next: Node | null = null;
  constructor(public value: u32) {}
}

let window: Node | null = null;

export function listCycle(n: u32): u32 {
  let t: u32 = 0;
  let live: u32 = 0;
  for (let i: u32 = 0; i < n; i++) {
    const c = new Node(i);
    c.next = window;
    window = c;
    live++;
    if (live === 64) {
      window = null;
      live = 0;
    }
    t = (t + c.value) >>> 0;
  }
  window = null;
  return t;
}
