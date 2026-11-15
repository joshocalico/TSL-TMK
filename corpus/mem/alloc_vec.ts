// Vec from safe code: this module imports nothing unsafe (SPEC 3.5).
import { Heap, Slab, Vec, ref } from "@tsl/alloc";
import { toU32, u32, u64, u8, type bool, type usize } from "@tsl/core";
import { limitPages, pages } from "./pages.ts";

const heap = new Heap(pages);

export function growScalars(n: usize): u32 {
  const v = new Vec(u32, heap);
  for (let i = 0; i < n; i++) {
    if (!v.push(toU32(i * 2))) return 0xffffffff;
  }
  let sum: u32 = 0;
  for (let i = 0; i < n; i++) sum = (sum + v.get(i)) >>> 0;
  const r = (sum + toU32(v.length)) >>> 0;
  v.free();
  return r;
}

export function growBytes(n: usize): u32 {
  using v = new Vec(u8, heap);
  for (let i = 0; i < n; i++) v.push(toU32(i) & 0xff);
  v.set(3, 200);
  return v.get(n - 1) + toU32(v.get(3)) * 1000;
}

export function bigElements(): u64 {
  using v = new Vec(u64, heap);
  for (let i: usize = 0; i < 100; i++) v.push(0x8000000000000000n);
  return v.get(99);
}

class Item {
  constructor(public id: u32) {}
}

const items = new Slab<Item>(heap, 8);

export function growRefs(n: usize): u32 {
  using v = new Vec(ref<Item>(), heap);
  for (let i = 0; i < n; i++) {
    const it = items.add(new Item(toU32(i)));
    if (it === null || !v.push(it)) return 0xffffffff;
  }
  let sum: u32 = 0;
  for (let i = 0; i < n; i++) sum = (sum + v.get(i).id) >>> 0;
  return sum;
}

export function refsIdentityAcrossGrowth(): bool {
  using v = new Vec(ref<Item>(), heap);
  const first = items.add(new Item(1000))!;
  v.push(first);
  for (let i: usize = 0; i < 200; i++) v.push(items.add(new Item(0))!);
  return v.get(0) === first;
}

export function bound(i: usize): u32 {
  using v = new Vec(u32, heap);
  v.push(1);
  return v.get(i);
}

export function setBound(i: usize): u32 {
  using v = new Vec(u32, heap);
  v.push(1);
  v.set(i, 2);
  return v.get(0);
}

export function popAndEmpty(): u32 {
  using v = new Vec(u8, heap);
  v.push(9);
  const a = v.pop();
  return a + v.pop();
}

export function sliceWrites(): u32 {
  using v = new Vec(u32, heap);
  for (let i: usize = 0; i < 10; i++) v.push(toU32(i));
  let sum: u32 = 0;
  v.withSlice((s) => {
    for (const x of s) sum += x;
    s[0] = 100;
    s[9] = 200;
  });
  return sum + v.get(0) + v.get(9);
}

export function pushDuringLoan(): u32 {
  const v = new Vec(u32, heap);
  v.push(1);
  v.withSlice(() => {
    v.push(2);
  });
  return 0;
}

export function popDuringLoan(): u32 {
  const v = new Vec(u32, heap);
  v.push(1);
  v.withSlice(() => {
    v.pop();
  });
  return 0;
}

export function freeDuringLoan(): u32 {
  const v = new Vec(u32, heap);
  v.push(1);
  v.withSlice(() => {
    v.free();
  });
  return 0;
}

export function nestedLoan(): u32 {
  using v = new Vec(u32, heap);
  v.push(5);
  let sum: u32 = 0;
  v.withSlice((a) => {
    v.withSlice((b) => {
      sum = a[0]! + b[0]!;
    });
  });
  v.push(6);
  return sum + v.get(1);
}

export function useAfterFree(): usize {
  const v = new Vec(u8, heap);
  v.push(1);
  v.free();
  return v.length;
}

export function doubleFree(): u32 {
  const v = new Vec(u8, heap);
  v.free();
  v.free();
  return 0;
}

export function usingFreesAtScopeEnd(): bool {
  const a = sameBlockAfterScope();
  return a;
}

function sameBlockAfterScope(): bool {
  let first = 0;
  {
    using v = new Vec(u32, heap);
    v.push(1);
    first = v.length;
  }
  return first === 1;
}

// `using` runs on every way out of its scope.
class Tracker {
  constructor(private c: Count) {}
  [Symbol.dispose](): void {
    this.c.disposed++;
  }
}
class Count {
  disposed: u32 = 0;
}
const count = new Count();

function earlyReturn(x: u32): u32 {
  using t = new Tracker(count);
  void0(t);
  if (x > 1) return x;
  return 0;
}
function void0(_t: Tracker): void {}

export function usingOnReturn(): u32 {
  const before = count.disposed;
  const r = earlyReturn(5);
  return r + (count.disposed - before) * 100;
}

export function usingOnBreak(): u32 {
  const before = count.disposed;
  for (let i: u32 = 0; i < 5; i++) {
    using t = new Tracker(count);
    void0(t);
    if (i === 1) continue;
    if (i === 3) break;
  }
  return count.disposed - before;
}

export function usingOrder(): u32 {
  const o = new Order();
  orderScope(o);
  return o.seen;
}
class Order {
  seen: u32 = 0;
}
class Step {
  constructor(
    private o: Order,
    private d: u32,
  ) {}
  [Symbol.dispose](): void {
    this.o.seen = this.o.seen * 10 + this.d;
  }
}
const orderHome = new Slab<Order>(heap, 1);
function orderScope(_o: Order): void {
  const home = orderHome.add(new Order())!;
  stepScope(home);
  _o.seen = home.seen;
}
function stepScope(o: Order): void {
  using a = new Step(o, 1);
  using b = new Step(o, 2);
  void1(a);
  void1(b);
}
function void1(_s: Step): void {}

export function vecInASlab(): u32 {
  const holders = new Slab<Holder>(heap, 2);
  const h = holders.add(new Holder())!;
  h.xs.push(4);
  h.xs.push(5);
  return h.xs.get(1) + h.owned();
}
class Holder {
  xs = new Vec(u32, heap);
  owned(): u32 {
    return toU32(this.xs.length);
  }
}

export function outOfMemory(): u32 {
  limitPages(0);
  const starving = new Vec(u32, starvingHeap);
  const pushed = starving.push(1);
  return pushed ? 1 : 0;
}
const starvingHeap = new Heap(pages);

export function outOfMemoryLeavesItEmpty(): u32 {
  const starving = new Vec(u32, starvingHeap);
  starving.push(1);
  return starving.get(0);
}

// `using` runs on the host while a trap unwinds, and this dispose traps too, so JS reports a SuppressedError where
// native code traps once and never runs the dispose.
export function trapInLoanUnderUsing(): u32 {
  using v = new Vec(u32, heap);
  v.push(1);
  v.withSlice(() => {
    v.push(2);
  });
  return 0;
}
