// file: ex-pages.ts
import { toU64, type u64, type usize } from "@tsl/core";
import { asMap, frameAlloc, type Cap } from "./ex-sys.ts";
import { PAGE, type PageSource } from "./ex-heap.ts";

const HEAP_BASE: u64 = 0x10_0000_0000n;
const MAP_READ_WRITE = 3;

let quota: Cap<"quota"> = 0;
let space: Cap<"addrspace"> = 0;
let next: u64 = HEAP_BASE;

export function setUpPages(q: Cap<"quota">, as: Cap<"addrspace">): void {
  quota = q;
  space = as;
}

export const domainPages: PageSource = (pages: usize): u64 => {
  const frame = frameAlloc(quota, pages);
  if (!frame.ok) return 0n; // the domain's quota is exhausted
  const at = next;
  const mapped = asMap(space, frame.value, at, MAP_READ_WRITE);
  if (!mapped.ok) return 0n;
  next = at + toU64(pages * PAGE);
  return at;
};
