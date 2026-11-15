// A safe API over raw references: what crosses out of the package is a value, and a stale handle is caught here
// (SPEC 3.5). This is how a strict package uses a manual one.
import { type u32 } from "@tsl/core";
import { unsafeFree } from "@tsl/unsafe";

class Entry {
  next: Entry | null = null;
  constructor(
    public key: u32,
    public value: u32,
  ) {}
}

let head: Entry | null = null;

export function put(key: u32, value: u32): void {
  const e = new Entry(key, value);
  e.next = head;
  head = e;
}

export function get(key: u32): u32 {
  for (let c = head; c !== null; c = c.next) if (c.key === key) return c.value;
  return 0;
}

export function removeAll(): u32 {
  let n: u32 = 0;
  while (head !== null) {
    const c = head;
    head = c.next;
    // SAFETY: the list was the only holder of c, and it's just been unlinked.
    unsafeFree(c);
    n++;
  }
  return n;
}
