// `tmk bench alloc`: the allocation library, natively. bench/alloc/alloc.c does the same work by hand.
import { Heap, Slab, Vec, ref } from "@tsl/alloc";
import {
  array,
  toU32,
  toU64,
  u32 as u32f,
  u64 as u64f,
  u8,
  type u32,
  type u64,
  type usize,
} from "@tsl/core";
import { addrOf, sliceOf, staticView } from "@tsl/unsafe";

const POOL_BYTES: usize = 0x1000000;
class Pool {
  bytes = array(u8, POOL_BYTES);
}
class BootPool {
  bytes = array(u8, 0x100000);
}
// SAFETY: this module's storage: pages() hands out runs of it, and reset takes them all back.
const POOL = staticView(Pool, 4096);
// SAFETY: storage for what outlives one run.
const BOOT = staticView(BootPool, 4096);

let used: usize = 0;
let bootUsed: usize = 0;

function pages(n: usize): u64 {
  if ((used + n) * 4096 > POOL_BYTES) return 0n;
  // SAFETY: POOL is static, so it has an address, and this run of it is handed out once per reset.
  const at = addrOf(POOL) + toU64(used * 4096);
  used += n;
  // A page source hands out zeroed pages, and these get used again after a reset.
  // SAFETY: this run of the pool is ours until the next reset.
  sliceOf(u64f, at, n * 512).fill(0n);
  return at;
}

function bootPages(n: usize): u64 {
  // SAFETY: BOOT is static, so it has an address, and this run of it is handed out once.
  const at = addrOf(BOOT) + toU64(bootUsed * 4096);
  bootUsed += n;
  return at;
}

const boot = new Heap(bootPages);
const rigs = new Slab<Heap>(boot, 1);

/** Vec.push from empty, through growth, then free. */
export function vecPush(n: usize): u32 {
  used = 0;
  const h = rigs.add(new Heap(pages))!;
  const v = new Vec(u32f, h);
  for (let i = 0; i < n; i++) v.push(toU32(i));
  const r = v.get(n - 1) + toU32(v.length);
  v.free();
  rigs.remove(h);
  return r;
}

class Item {
  constructor(
    public a: u64,
    public b: u32,
    public c: u32,
  ) {}
}

/** Slab.add and Slab.remove: `rounds` times, fill with n objects and empty it again. */
export function slabCycle(rounds: usize, n: usize): u32 {
  used = 0;
  const h = rigs.add(new Heap(pages))!;
  const s = new Slab<Item>(h, 64);
  const refs = new Vec(ref<Item>(), h);
  for (let i = 0; i < n; i++) refs.push(s.add(new Item(toU64(i), 1, 2))!);
  let sum: u32 = 0;
  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < n; i++) s.remove(refs.get(i));
    for (let i = 0; i < n; i++) refs.set(i, s.add(new Item(toU64(i), toU32(round) & 0xff, 2))!);
    sum = (sum + refs.get(round % n).b) >>> 0;
  }
  refs.free();
  rigs.remove(h);
  return sum;
}

class Node {
  next: Node | null = null;
  constructor(public val: u64) {}
}

const nodes = new Slab<Node>(boot, 256);
let head: Node | null = null;

/** Field access through a stored reference: a walk where every step loads one and reads through it. */
export function walkList(n: usize, rounds: usize): u64 {
  if (head === null) {
    for (let i = 0; i < n; i++) {
      const node = nodes.add(new Node(toU64(i)))!;
      node.next = head;
      head = node;
    }
  }
  let sum: u64 = 0n;
  for (let r = 0; r < rounds; r++) {
    for (let cur = head; cur !== null; cur = cur.next) sum += cur.val;
  }
  return sum;
}
