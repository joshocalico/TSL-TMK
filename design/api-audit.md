# API audit: the shape and naming of TSL's language and libraries

Status: audit only, 2026-11-08. Nothing here is built and nothing else was changed. About 20 minutes to read: the summary
takes 5. Line numbers are as of this date. `SPEC:n` means SPEC.md line n, and package paths are under `packages/`.

## Summary for the owner

The owner called `atomic.store(this, "idx", …, "release")` cursed. That line has three problems. A field name is passed as a
string. One field can be written two ways, atomically and plainly. And the next line is a barrier for one CPU (`dmbIsh()`),
in a driver that's meant to be portable. This audit looked for the same three problems elsewhere, and for other places where
a TypeScript programmer would be surprised.

**The good news.** Most of the surface is sound. Ordering arguments (`"release"`), error unions (`"bad-magic"`) and union
tags are closed string-literal unions, which is ordinary TypeScript. `offsetOf(T, "flags")` is a compile-time question about
a type, and it leaves no second way to use the field. Loans through closures (`withSlice`) and `forEach` instead of
iterators each have a stated reason. None of these need changing.

**What needs fixing before kernel work starts, because kernel and driver code would copy it** (12 findings):

1. **Atomic fields** (A1). Make `idx = atomic(u16)` a field type, as agreed, and make `fence(order)` the only fence.
2. **Barriers, idle and the clock come out of the CPU package** (A2). A driver should say "this register write
   is ordered after my earlier stores", not "`dmb ish`". The CPU package keeps only privileged, kernel-only instructions.
3. **Trap codes are bare numbers** (A3). The libraries are full of `trap(5)` and `trap(14)`. Give the codes names.
4. **`push` and `add` mean different things in two packages** (A4). In `@tsl/alloc` they report running out of memory, and in
   `@tsl/std` the same names trap. It's the `Map` problem again, and the kernel uses `@tsl/alloc`.
5. **A page source can't say whose pages it hands out** (A5). It must be a plain top-level function, so its quota and address
   space are module variables. The kernel's plan of one heap for each quota (5.3) can't be written this way.
6. **Element types are given in three styles** (A6). There's `new Vec(u32)`, there's `new Vec(ref<Item>())`, and
   `new Slab<Timer>()` gives the type only as a type argument. Settle on one: a value argument, type first.
7. **Register declarations put the width in the name** (A7). `reg.rw32(0x44)` should be `reg.rw(u32, 0x44)`, like
   `array(u16, N)`.
8. **Bitfields silently truncate** (A8). A 3-bit field set to 9 stores 1, with no trap. That breaks the rule that overflow
   traps (D19), and page-table code will lean on bitfields.
9. **System-call errors, rights and map flags are bare numbers** (K1). For example, `asMap(…, 3)` in `ex-pages.ts`.
10. **Notifications mix a bit's index and a mask** (K2). `ntfnSignal` takes a mask, while `domainWatch` and `irqBind` take
    an index. Both are integers, so a mix-up type-checks.
11. **System-call names don't follow one rule** (K3). Some are abbreviated (`ep*`, `ntfn*`, `as*`, with a parameter named
    `as`) and some aren't (`domain*`, `thread*`). None of them match the capability kinds, such as `"addrspace"`.
12. **`debugWrite` uses ambient authority** (K4). It checks a "debug right" the domain holds, rather than taking a
    capability, which goes against D60's "no ambient authority".

**Fix when the code is next touched** (13 findings). These are smaller surprises:

- `ExactMap.forEach` passes the key first and `Map.forEach` passes the value first, so moving between them swaps the
  arguments silently.
- `enumValue` returns `null` for "absent", while `Map.get` returns `undefined`.
- `Str.length` counts bytes, not JS characters.
- `make`, `set`, `of` and `free`/`dispose` each have several meanings.
- Registration functions have different names in TSL and in the native interface.
- The kernel API has some smaller issues: `Sys<0>`, error results on calls that can't fail, and three adjacent `u64`
  arguments to `threadCreate`.
- In the lowered package's extensions (E1 to E11), the main problem is string names: `rt("__rc_new")`, `builtin("Math.max")`
  and `alloc(16, true, "__alloc")`. There's also a `negate` boolean, and `wrap` and `cast` don't mean what TSL's
  `wrapU32` and `Ptr.cast` mean.

**Leave as they are** (11 findings, each with its reason).

**Two decisions for the owner.** First: should an ordered register write be a method, `regs.queueNotify.write(0, "release")`,
or the agreed function, `io.write(reg, v, "release")`? This audit recommends the method, because registers and the new
`Atomic<T>` are already handles with methods (A2). Second: should a page source carry a context word, or should `Heap` be
generic over a source class (A5)?

Priorities are labelled **P1** (fix before kernel work), **P2** (fix when touched) and **P3** (leave).

---

## P1: fix before kernel work

### A1. Atomics take a field name as a string

**Where.**
- `atomic` in `tsl-core/index.ts:613-631` and SPEC:5105-5115.
- Its use at SPEC:455 (`ex-virtq.ts`).
- The rule at SPEC:2715, the string-literal allowance at SPEC:2562, and `Shared<T>` at SPEC:1490.

**Why it's awkward.**
- `atomic.store(this, "idx", v, "release")` reads as reflection, even though `K extends keyof R` checks it.
- `this.idx` stays an ordinary `u16`, so a plain `this.idx = x` beside it compiles. That's a racy write the type system
  could have stopped.
- `R` and `K` are unconstrained, so `atomic.load(someLocal, "x", …)` type-checks on a value that isn't in shared memory.
- `fence(order: RmwOrder)` accepts `"relaxed"`, which as a fence does nothing.

**Proposed** (as agreed):

```ts
export interface Atomic<T> {
  load(order: LoadOrder): T;
  store(v: T, order: StoreOrder): void;
  exchange(v: T, order: RmwOrder): T;
  fetchAdd(v: T, order: RmwOrder): T;
  cas(expected: T, desired: T, order: RmwOrder): bool;
}
export declare function atomic<T>(w: Scalar<T>): Atomic<T>;      // a layout helper, like array(u16, N)
export type FenceOrder = "acquire" | "release" | "acqrel" | "seqcst";
export declare function fence(order: FenceOrder): void;

export class VirtqAvail {
  flags = u16();
  idx = atomic(u16);
  ring = array(u16, QUEUE_SIZE);
  usedEvent = u16();

  publish(regs: VirtioMmio, head: u16): void {
    const idx = this.idx.load("relaxed"); //       only the driver writes idx
    const slot: usize = idx & (QUEUE_SIZE - 1);
    this.ring[slot] = head;
    this.idx.store(wrapU16(idx + 1), "release"); // free-running mod 2^16
    regs.queueNotify.write(0, "release"); //       A2: earlier stores reach the device first
  }
}
```

**Cost.**
- Layout: none. An atomic field is the same size and alignment as its scalar.
- Host: a view's field becomes an object with five methods over the `DataView`, and `new T()` gives the same object over
  8 private bytes.
- tslc: a new layout-helper kind. `Init<T>` (`make`, `set`) can't set an atomic field, so it's initialised with
  `.store(v, "relaxed")`.
- Speed: none. It's the same instructions.
- Compatibility: `ex-virtq.ts`, Appendix A and 3.9's text change. `atomic.*` leaves 3.6's list of string arguments.

**Open point.** Atomic fields exist only in layout classes, because a plain class can't use layout helpers (TSL1015).
Shared kernel state at M12 (a lock word, for instance) would therefore have to be a layout class. That fits D40, which says
threads share only layout classes, but it should be stated.

### A2. CPU-specific barriers, idle and the clock are in portable code

**Where.**
- `import { dmbIsh } from "@tsl/arch-aarch64"` in a driver (SPEC:428, 456).
- "Idle is `wfi`" (SPEC:3463).
- "Use `CNTVCT_EL0`" for timing (SPEC:3657).
- The whole barrier list (SPEC:5172-5179, `tsl-arch-aarch64/index.ts:13-57`).
- 3.8 says "privileged intrinsics exist only in `@tsl/arch-aarch64`" (SPEC:2630), yet the package also holds instructions
  that need no privilege.

**Why it's awkward.**
- A driver is meant to compile unchanged for any placement (5.2), and it now names an ARM instruction.
- `dmb ish` orders memory between CPUs. Whether it's even the right barrier before a device write is an ARM detail the
  driver shouldn't have to judge. Linux uses an outer-shareable store barrier there.
- `tmk audit` counts uses of privileged intrinsics (S8). Because the same package also holds harmless barriers, the count
  can't tell them apart.

**Proposed.** Portable intrinsics in `@tsl/core` with a defined meaning, plus `onArch` where nothing portable exists:

| Today (`@tsl/arch-aarch64`) | Portable form | Defined as |
|---|---|---|
| `dmbIsh`, `dmbIshSt`, `dmbIshLd` | `fence("seqcst" \| "release" \| "acquire")` | Ordering between threads (A1) |
| `dmbOsh*` before a device write | `reg.write(v, "release")` | Every earlier memory store is visible to the device before this write |
| `dmbOsh*` after a device read | `reg.read("acquire")` | No later memory access happens before this read |
| `wfi` | `idle()` | Wait for an interrupt (kernel only) |
| `readCntvctEl0`, `readCntfrqEl0` | `timestamp(): u64`, `timestampHz(): u64` | A monotonic counter and its rate |
| Busy-wait loops (none today) | `spinHint()` | `yield` on ARM, `pause` on x86 |
| `maskIrq` and `unmaskIrq` | See B7 | |
| `dsb*`, `isb`, `tlbi*`, `dc*`, `ic*`, system registers, `eret`, `hvc0`, `svc0`, `wfe`, `sev`, `sb`, `csdb` | Stay in `@tsl/arch-aarch64`, reached through `onArch({ aarch64: () => …, x86_64: () => … })` | Privileged, or meaningful only to one CPU |

**Decision for the owner.** The agreed spelling is `io.write(reg, v, "release")`. Registers are already handles with
`.read()` and `.write(v)`, as in `regs.magic.read()` (SPEC:2705), and `Atomic<T>` will be too. So this audit recommends an
optional ordering argument on the handle: `regs.queueNotify.write(0, "release")`. Either spelling works, but there should
be only one.

**Cost.**
- Five or six new core intrinsics, each one or two instructions on AArch64. Speed is unchanged, or better where `osh` was
  the right barrier all along.
- `@tsl/arch-aarch64` becomes kernel-only, which an import rule can enforce.
- `onArch` needs tslc to pick the arm at compile time, so other architectures' arms are never compiled, and their imports
  never resolved.

### A3. Trap codes are magic numbers

**Where.**
- `trap(5)`, `trap(13)`, `trap(14)` and `trap(2)` appear throughout `tsl-alloc/ex-vec.ts`, `ex-slab.ts`,
  `tsl-gc/ex-gc-rc.ts:748-818`, `tsl-std/*` and `tsl-core/index.ts`.
- The lowered `trapNow("convert", 4)` (`compiler/host/emit-tsl.ts:1845`, `tsl-lowered/index.ts:143`).
- The table is at SPEC:2867-2877.

**Why it's awkward.** Every reader has to look up 3.10's table, and a wrong number type-checks. Every kernel path that
traps will copy the style.

**Proposed.** A numeric enum, which TSL already allows:

```ts
export enum Trap { Overflow = 1, Bounds = 2, DivZero = 3, Conversion = 4, Stale = 5, Null = 6, Assert = 7,
  ShiftCount = 8, Misaligned = 9, Panic = 10, Loan = 13, OutOfMemory = 14, Hole = 15, RcCheck = 16, BadCast = 17 }
export declare function trap(code: Trap | u32): never;   // program codes stay ≥ 1000
if (this.borrows > 0) trap(Trap.Loan);
```

The lowered package becomes `trapNow(Trap.Conversion)`. Its `kind` string carries nothing the code doesn't, and the site
already has its `/*@ file:line */` comment.

**Cost.** None at run time, since an enum member is a constant. It's a mechanical edit of the libraries, and the corpus
outputs are unchanged.

### A4. `Vec` and `Slab` in two packages: same names, different failure behaviour

**Where.**

| Call | `@tsl/alloc` | `@tsl/std` |
|---|---|---|
| `Vec.push(x)` | Returns `false` when out of memory (`tsl-alloc/ex-vec.ts:43`) | Returns `void` and traps 14 (`tsl-std/ex-std-vec.ts:35`) |
| `Slab.add(x)` | Returns `T \| null` (`tsl-alloc/ex-slab.ts:55`) | Returns `T` and traps (`tsl-std/ex-std-slab.ts:17`) |
| Constructor | `new Vec(u32, heap)`, `new Slab(heap, 64)` | `new Vec(u32)` |

**Why it's awkward.**
- D47 split `Map` from `ExactMap` precisely so that "the same name never means two things". Here `push` means "may fail,
  check the result" in one package and "traps" in the other.
- `v.push(x);` with the result ignored drops data silently in `@tsl/alloc`. 3.5 gives exactly that as the reason std traps
  (SPEC:1435).
- The kernel uses `@tsl/alloc`, so this is where the silent drops would be.

**Proposed.** The plain names behave the same in both packages, and only the `try` names report failure:

```ts
// @tsl/alloc
tryPush(v: T): bool;           // was push
tryAdd(item: T): T | null;     // was add
// No trapping push or add in @tsl/alloc: the kernel always handles running out
```

std's `tryPush`, `tryAdd`, `trySet`, `Str.tryOf` and `Rc.tryMake` already follow this rule: `bool` when there's nothing to
return, and `T | null` when there is.

**Cost.**
- A rename in `@tsl/alloc`, its callers in std and gc, `ex-memory.ts`, and 3.7's text, which names `Slab.add` and
  `Vec.push` as allocating.
- Nothing at run time.

### A5. A stored function can't carry context, so page sources and `Rc` stores have to be module state

*2026-11-20 (pipe-dispatch):* option c's mechanism is in TSL proper as D70 (closed-world dispatch interfaces, SPEC 3.4).
`@tsl/alloc`'s `PageSource` itself is still a function: converting it is the API-fixes phase's.

**Where.**
- `type PageSource = (pages: usize) => u64` (`tsl-alloc/ex-heap.ts:9`).
- `setPageSource` "takes a top-level function by name" (TSL5009, SPEC:2633).
- `ex-pages.ts` (SPEC:1242-1262): `let quota`, `let space` and a `setUpPages` setter.
- `new Rc<Node>(releaseNode)`, where `releaseNode` must reach the store through the top-level `const nodes`
  (`design/pipeline.md:181-185`).
- `setLogSink` (`tsl-unsafe/index.ts:117`).

**Why it's awkward.**
- A stored function value is only a code pointer, because a capturing closure can't be stored. So everything a page source
  needs is in globals: the domain's quota, its address space and its next address.
- 5.3 (SPEC:3434) plans "`Slab`s per quota, each over a `Heap` whose page source draws on that quota". With one global
  per source, that can't be written for more than one quota.
- D40 already counts module state as something threads make harder (SPEC:1484).

**Proposed.** Pick one of these:

```ts
// (a) A context word, the C way: one more field in Heap, one more register in the call
export type PageSource = (ctx: u64, pages: usize) => u64;
const h = new Heap(quotaPages, toU64(q));

// (b) Generic over a source class, monomorphised, so no dynamic dispatch
export interface PageSource { pages(n: usize): u64 }
export class Heap<S extends PageSource> { constructor(private source: S) {} }
const h = new Heap(new QuotaPages(q, space));
```

This audit recommends (a). Option (b) is more natural TypeScript, but the type parameter spreads to `Vec<T, S>`,
`Slab<T, S>` and every signature that holds one. `Rc`'s `release` takes the same fix: `release(store: Rc<T>, item: T)`.

**Cost.**
- (a): 8 bytes per `Heap`, and one register for each page request, which happens a page at a time, not per allocation.
  TSL5009 stays.
- (b): no run-time cost, but the type parameter spreads.

### A6. Element types are passed in three styles

**Where.**
- `new Vec(u32)`, `new Map(u32, u32)`, `array(u16, N)` and `ptrAt(u64, a)` take a value token.
- `arrayOf(Elem, N)`, `nested(Other)` and `over(T, …)` take a class value.
- `new Vec(ref<Item>())`, `inlineOf<T>()`, `new Slab<Timer>(heap, 64)`, `new Rc<Node>(f)` and `objectAt<T>(slot)` take only
  a type argument.
- These are at `tsl-unsafe/index.ts:153-155`, `tsl-alloc/ex-slab.ts:20`, `tsl-gc/ex-gc-rc.ts:714` and SPEC:1421-1424.

**Why it's awkward.** `ref<Item>()` and `ref<Other>()` are the same call at run time. What they do depends only on an
erased type argument, which is the reflection smell again in another form. A reader also has to remember which containers
take a token and which don't.

**Proposed.** The rule: whatever describes the element is a value argument, and it comes first.

```ts
new Vec(ref(Item))            // was new Vec(ref<Item>())
new Slab(Timer, heap, 64)     // was new Slab<Timer>(heap, 64); std: new Slab(Timer)
new Rc(Node, releaseNode)     // was new Rc<Node>(releaseNode)
inline(Timer)                 // was inlineOf<T>() inside Slab and Rc
```

`objectAt<T>(slot)` is an unchecked cast in an unsafe module. It may keep its type argument, but it should say what it is,
for example `objectAt(Timer, slot)`.

**Cost.**
- An API change to every collection's constructor. tslc already reads class arguments for `arrayOf`.
- The host ignores the class, as it does today.
- Nothing natively.

### A7. Register descriptors put the width in the name

**Where.** `reg.ro8 … reg.rw64`, twelve names (`tsl-core/index.ts:581-594`, SPEC:5091-5096), used throughout
`ex-mmio.ts` (SPEC:2671-2695).

**Why it's awkward.** Every other layout description takes a type token: `array(u16, N)`, `bits(u16, …)`,
`enumOf(u32, E)` and now `atomic(u16)`. `reg.rw32` is the one place where the type is spelled into the function's name,
and a big-endian or signed register has no spelling at all.

**Proposed.**

```ts
export const VirtioMmioRegs = mmio(0x200, {
  magic: reg.ro(u32, 0x000),
  queueNotify: reg.wo(u32, 0x050),
  status: reg.rw(u32, 0x070),
});
```

**Cost.** MMIO isn't compiled natively yet (SPEC:570), so the only cost is a text change to core, Appendix A and
`ex-mmio.ts`. Every driver will declare registers, so this should be done before the first driver is written.

### A8. Multi-bit fields are typed `number` and wrap silently

**Where.** `bits()` (`tsl-core/index.ts:212-227`, the masking at `:201-206`, and SPEC:393).

**Why it's awkward.**
- A field wider than 1 bit has type `number`, with no flavour, in a language where every integer has a width.
- Setting a 3-bit field to 9 stores 1, both on the host and natively. That's a hidden wrap. D19 says overflow traps unless
  a wrap is written out.
- Page-table and device-descriptor code will be mostly `bits`.

**Proposed.** Type each field with the narrowest unsigned type that holds it (`u8` up to 8 bits, then `u16`, then `u32`).
Setting a field to a value that doesn't fit traps with `Trap.Conversion`. A program that wants the wrap writes
`f.b = x & 7`, which is range-assignable (3.3 rule 6), so the check folds away.

**Cost.** A compare and a branch on writes whose range isn't proved, and none where it is. One host change.

### K1. System-call errors, rights and map flags are bare numbers

**Where.**
- `SysError = u32` and the `E_*` constants (SPEC:3533-3536).
- Rights `READ=1 … RECV=64`, which are defined only in prose (SPEC:3430), with `rightsMask: u8` (SPEC:3550).
- `capInfo` returns `kind: u8; rights: u8` (SPEC:3553).
- `asMap(…, flags: u32)` (SPEC:3558), called as `MAP_READ_WRITE = 3` in `ex-pages.ts` (SPEC:1243).

**Why it's awkward.**
- `Sys<T>` accepts any `u32` as an error.
- `capInfo` turns `CapKind`, which is a type, back into an unnamed `u8`.
- A program has to define its own rights and flags constants, so every program defines different ones.

**Proposed.**

```ts
export enum SysError { BadCap = 1, Rights = 2, NoMem = 3, Inval = 4, Busy = 5, Dead = 6, Range = 7, Cancelled = 8 }
export enum Right { Read = 1, Write = 2, Exec = 4, Grant = 8, Revoke = 16, Call = 32, Recv = 64 }
export enum MapFlag { Read = 1, Write = 2, Exec = 4 }
export type Sys<T> = Result<T, SysError>;
capInfo(c: AnyCap): Sys<{ readonly kind: CapKind; readonly rights: u8 }>;   // a literal union is a small integer (3.5)
asMap(as, f, va, MapFlag.Read | MapFlag.Write);
```

**Cost.** None at run time or in the ABI: the values are the same. It's an edit of `ex-sys.ts` and `ex-pages.ts`.

### K2. Notification bits: some calls take an index, others a mask

**Where.**
- `ntfnSignal(n, bits: u64)` takes a mask (SPEC:3580).
- `ntfnWait` returns a mask (SPEC:3581).
- `domainWatch(…, bit: u32)`, `epWatchCallers(…, bit: u32)` and `irqBind(…, bit: u32)` take an index
  (SPEC:3582-3586).

**Why it's awkward.** A driver binds its interrupt to "bit 3", then tests `got & 3`. Both are integers, so this
type-checks, and it's wrong.

**Proposed.** Use a mask everywhere, with exactly one bit set where one bit is meant (`E_INVAL` otherwise):
`irqBind(irq, n, 1n << 3n)`, then `if ((got & IRQ_BIT) !== 0n)`. If the owner prefers indexes, name the parameter
`bitIndex` and give `ntfnWait`'s result a helper. The point is one convention, visible at the call.

**Cost.** One kernel check per call, and nothing on the IPC path.

### K3. System-call names don't follow one rule

**Where.** SPEC:3527-3594:
- `asCreate(q)` and `asMap(as, …)`: the parameter is named `as`, a TypeScript keyword.
- `ep*`, `ntfn*` and `irq*` are abbreviated, while `domain*`, `thread*` and `frame*` are spelled out.
- The kinds are `"addrspace"`, `"dma"` and `"quota"`, while the objects are `AddressSpace`, `DmaRegion` and `MemQuota`.

**Proposed.** One rule: a call's prefix is its capability kind, word for word.

| Kind | Calls |
|---|---|
| `"space"` | `spaceCreate`, `spaceMap`, `spaceUnmap`, parameter `space` |
| `"endpoint"` | `endpointCreate`, `endpointCall`, `endpointRecv`, `endpointReplyRecv`, `endpointWatchCallers` |
| `"notification"` | `notificationCreate`, `notificationSignal`, `notificationWait` |
| `"quota"`, `"dma"` | Stay, and the object names in 5.3 follow (`Quota`, `Dma`) |

A short abbreviation is fine too, as long as kinds, calls and objects all use the same one.

**Cost.** Names only. Nothing is shipped (D54), so this is the cheapest it will ever be.

### K4. `debugWrite` uses ambient authority

**Where.** `debugWrite(bytes) // Only if the domain holds debug rights` (SPEC:3593). Compare `systemOff(d)`, which does take
the capability that authorises it (SPEC:3594).

**Why it's awkward.** It's the only call whose authority isn't a capability argument. D60 says user space gets "no ambient
authority", and the first call written against this API would be the example everyone copies.

**Proposed.** `debugWrite(log: Cap<"debug">, bytes: Uint8Array): Sys<usize>`, with `"debug"` added to `CapKind`.
`clockNowNs()` can stay ambient, since reading the time is harmless here, but say so in a comment.

**Cost.** One more capability kind, and the init domain hands the capability to whoever should log.

---

## P2: fix when touched

### B1. `ExactMap.forEach` and `Map.forEach` take their arguments in opposite orders

**Where.** `tsl-std/ex-std-map.ts:165` passes `(k, v)` and `:365` passes `(v, k)`. SPEC:1431.

**Why it's awkward.** For `ExactMap<u32, u32>`, switching between the two maps swaps key and value, and it still
type-checks.

**Proposed.** `ExactMap.forEach(f: (v: V, k: K) => void)`, the same as JS and `Map`.

**Cost.** One line, plus its callers in the corpus. Do it soon: it's cheap, and the bug it invites is silent.

### B2. `enumValue` returns `null`; the other nullable scalars return `undefined`

**Where.** `tsl-core/index.ts:241-246` and SPEC:5056. The rule that `a[i]` and `Map.get` give `undefined` is 3.3 rule 12
(SPEC:324-333).

**Why it's awkward.** Of the three ways to get a nullable scalar, one is tested with `=== null` and two with
`=== undefined`. Rule 12 also says `null` on a scalar is TSL1008.

**Proposed.** `enumValue(e, x): E[keyof E] | undefined`. While it's being changed, put the arguments in the same order as
`enumOf`: `enumValue(x, E)`, or reverse `enumOf`.

**Cost.** Text, and its callers.

### B3. `Str.length` and `Str.at` measure bytes

**Where.** `tsl-std/ex-std-str.ts:52-58`.

**Why it's awkward.** In JS, `s.length` counts UTF-16 code units and `s.at(i)` returns a string. Here they return a UTF-8
byte count and a `u8`. Code ported from JS will cut multi-byte characters in half.

**Proposed.** Rename them `byteLength` and `byteAt(i)`, which is what `TextEncoder` users already say. Keep `slice` and
`indexOf`, but document them as working on byte offsets.

**Cost.** Renames in std and in the self-hosted compiler, which will use `Str` from M8 on.

### B4. `make`, `of`, `add` and `set` each mean several things

**Where.**
- `make(T, init)` makes a zeroed stack object (`tsl-core/index.ts:499`).
- `arena.make(T)` makes a view into the arena (`:535`).
- `nodes.make(new Node(1))` counts an object someone else made (`tsl-gc/ex-gc-rc.ts:790`).
- `Str.of(lit(…))`, and the unbuilt `Shared.of(T, init)` (SPEC:1490).
- The free function `set(d, {...})` (`tsl-core/index.ts:510`) has the same name as `Map.set` and `Vec.set`.
- `arena.u32s(n)` (`:534`) is the one array maker that isn't `array(u32, n)`.

**Proposed.**
- `Rc.make` becomes `Rc.add`, mirroring `Slab.add(new T())`, which has the same "moves" shape and returns a reference.
  Keep `tryAdd` as well.
- `set(d, {...})` becomes `assign(d, {...})`, which is what it is on the host (`Object.assign`).
- `arena.u32s(n)` becomes `arena.array(u32, n)`.
- When `Shared<T>` is built, give it `Rc`'s shape: a store with `add`, `share` and `drop`. Not handle methods.

**Cost.** Renames. Do the `Rc` one before D63's `rc` sugar starts printing these calls.

### B5. `free`, `dispose` and `Symbol.dispose` are mixed

**Where.**
- `Map` and `ExactMap` have a public `dispose()` beside `free()` and `[Symbol.dispose]` (`tsl-std/ex-std-map.ts:199`,
  `:405`). `Vec`, `Set` and `Str` have only `free()` and `[Symbol.dispose]`.
- `@tsl/alloc` exports free functions `alloc(heap, e, n)` and `free(heap, e, p, n)` (`tsl-alloc/ex-heap.ts:78-85`) beside
  the methods `heap.allocBytes` and `heap.freeBytes`.

**Proposed.**
- Every container has `free()`, which traps if the container is already freed, and an idempotent `[Symbol.dispose]`.
  Remove the public `dispose()`.
- `alloc` and `free` become `heap.alloc(e, n)` and `heap.free(e, p, n)`.

**Cost.** Small, and only in the libraries.

### B6. Registration hooks: five styles and two names for each

**Where.**

| Thing registered | TSL spelling | Native spelling |
|---|---|---|
| Page source | `setPageSource(f)`, a run-time call | `__page_source_use(code)` |
| Global allocator | `/** @tsl.global-allocator */ const h = globalAllocator(f)`, a tag on a call in a constant | none |
| Hash key | `setHashKey(a, b)` in std | `__hash_key_use(a, b)` |
| Log sink | `setLogSink(f)` | none |
| Freed page runs | `export const keepsRuns: bool = onPageRunFreed(keepRun)` | none |

The last one, at `tsl-std/ex-std-global.ts:60`, is a side effect written as a boolean constant.

**Proposed.**
- Make the native names mirror the TSL names: `__set_page_source`, `__set_hash_key`, `__set_arena`,
  `__set_exc_catch` and so on.
- `onPageRunFreed` takes the same tag form as the global allocator (`/** @tsl.page-runs */`), since tslc binds both at
  compile time. It's internal to std, so this is the lowest priority of the five.

**Cost.** Renames in the native surface, before D54 versions it.

### B7. CPU-specific kernel pieces that have a portable shape

**Where.**
- `maskIrq` and `unmaskIrq` (SPEC:5178-5179).
- Cache maintenance, `dcCvac` and friends (SPEC:2722, 5180).
- `@tsl.export-c` is defined as "Fixed AAPCS64" (SPEC:2619).
- The arch package's host test hooks are keyed by strings: `handlers.set("readCntvctEl0", …)`
  (`tsl-arch-aarch64/index.ts:5-11`).

**Proposed.**
- An unpaired mask/unmask is an easy bug to write. Use a guard that restores the previous state, the same shape as an
  arena: `using _ = irqsMasked();`. Here the scoped form is the safer one.
- Cache maintenance becomes `cache.clean(addr, len)` and `cache.invalidate(addr, len)`, when M12 needs it.
- `@tsl.export-c` means "the platform C convention" (D56).
- The host test hooks become `hostHandle(readCntvctEl0, () => 5n)`, which has the shape of `hostStub(f, impl)`.

**Cost.** `irqsMasked` adds one instruction (`mrs daif`). The rest is text.

### B8. Smaller system-call shape problems

**Where.**
- `Sys<0>` is used for "nothing to return" throughout (SPEC:3551-3588).
- `threadYield(): Sys<0>` and `clockNowNs(): Sys<u64>` can't fail, yet return an error result.
- `threadCreate(d, pc: u64, sp: u64, arg: u64, priority: u8)` takes three `u64`s in a row, so swapping two of them
  type-checks (SPEC:3567).
- `dmaAlloc` returns `physAddr` (SPEC:3589). Behind an SMMU it isn't a physical address.
- `Msg.cap = u32()`, where "0 means none" (SPEC:3545).

**Proposed.**
- `type Status = { readonly ok: true } | Err<SysError>`.
- Infallible calls return their value directly.
- `threadCreate(d, start: { readonly pc: u64; readonly sp: u64; readonly arg: u64 }, priority)`. A value record is three
  words, which fits the limit, and is still registers.
- `deviceAddr` instead of `physAddr`.
- Leave `Msg.cap` as it is: it's the wire image, and should be decoded at the edge.

**Cost.** Names and types only. The ABI is unchanged.

### B9. The lowered package calls its runtime and intrinsics by name, as strings (E8)

**Where.**
- `rt<R>(name: string, …)`, `intrinsic<R>(name, …)` and `builtin<R>(name, …)` (`tsl-lowered/index.ts:39-51`), printed at
  `compiler/host/emit-tsl.ts:1829-1834`.
- `addr(g: Ref | string)` (`:118`).

**Why it's awkward.**
- `rt("__arena_start")` is a declaration written as a string.
- `R` is whatever the caller says, so the printer's claim about the result type isn't checked by `tsc`.
- A typo is found only by tslc.

**Proposed.** Declarations that can be imported, generated from the tables the compiler already has:

```ts
import { __rc_new, __arena_start } from "@tsl/lowered/rt";   // declare function __rc_new(size: usize, desc: u32): Ref;
import { memCopy, fptosiSat } from "@tsl/lowered/intrinsics";
```

**Cost.** One generated `.d.ts` per table, and a printer change. It fits section 9's last step, where the runtime becomes a
TSL package anyway, and `rt(…)` then becomes an ordinary import.

### B10. `wrap`, `cast` and `f2ix` in lowered code (E4, E5, E9)

**Where.** `tsl-lowered/index.ts:128`, `:153` and `:168`. Literal typing is at `compiler/host/emit-tsl.ts:1521-1529`.

**Why it's awkward.**
- In TSL, `wrapU32(x)` truncates, while `wrap<u32>(a + b)` means "proved not to overflow, so no check". They agree only if
  the proof is right.
- `cast<T>` shares a name with `Ptr.cast` and reads like `as`.
- `cast<i32>(2)` gives a literal its type, which is a third meaning.
- `f2ix` is opaque.

**Proposed.**
- `unchecked<i32>(a + b)` for E4.
- `exact<usize>(x)` for E5.
- Typed literals as TSL proper writes them, `toI32(2)`, which tslc folds with no check because the argument is a
  constant. That needs the fold at -O0 too, to keep phase 1's identical-TIR rule.
- `f64Index(x)` instead of `f2ix`.

**Cost.** Printer and elaborator renames, plus one fold of a constant.

### B11. Positional booleans and symbol strings in lowered code (E6, E10, E11)

**Where.**
- `isUndef(v, negate: boolean)` (`tsl-lowered/index.ts:178`, printed at `emit-tsl.ts:1752`): `isUndef(x, true)` means
  "is present".
- `data(size, symbol?)`, `text(s, symbol?)`, `charTable(symbol?)` and `hashKey(symbol?)` (`:98-115`) give a symbol as a
  positional string, while E10 already has the `@tsl.symbol name` tag for the same job.
- The lowered `hashKey()` has the name of std's `hashKey()` key protocol.
- The lowered `type Elem = "u8" | …` (`:23`) has the name of `@tsl/unsafe`'s `Elem<T>`, and in `loadElem<T>(p, i, "f64")`
  it repeats what `T` already says.

**Proposed.**
- `isUndef(v)`, with `!isUndef(v)` for the opposite.
- The symbol always goes in `@tsl.symbol`.
- `hashKeyData()` instead of `hashKey()`.
- Drop the `Elem` argument, or pass the core token (`f64`).

**Cost.** Printer and elaborator only. Lowered code is generated, so nothing hand-written changes.

### B12. The key protocol works by method name, and Appendix A has drifted from the code

**Where.**
- `keyHash` and `keySame` look for methods named `hashKey` and `sameKey` by name (`tsl-unsafe/index.ts:347-365`,
  SPEC:1474).
- Appendix A says `keyHash(): u32` and `genOf` (a `u32` field), but the code returns `number` for both.

**Proposed.**
- Export `interface Keyed<T> { hashKey(): u32; sameKey(o: T): bool }` from core, so that `class Str implements Keyed<Str>`
  says it in the source, and a missing method is a `tsc` error rather than TSL2003.
- Make the return types match Appendix A.

**Cost.** Text. tslc checks the same two names.

### B13. `Counted<T>` is just `T`

**Where.** `export type Counted<T extends object> = T` (`tsl-gc/ex-gc-rc.ts:680`).

**Why it's awkward.** `tsc` sees no difference between `nodes.drop(new Node(1))` and `nodes.drop(h)`. Only tslc's handle
rule and a run-time trap 5 catch the first.

**Proposed.** An optional brand, `T & { readonly [counted]?: true }`, so that a `Counted<T>` can't be passed where a
different store's handle is expected. A full brand would need `as`, which TSL bans, so the brand stays optional and TSL3009
remains the real check.

**Cost.** Small. It mostly documents intent.

---

## P3: leave

| # | What | Where | Why it stays |
|---|---|---|---|
| C1 | Orderings and error kinds as string literals: `"release"`, `"bad-magic"`, `kind: "irq"` | SPEC:2700, 5106-5108 | A closed union of literals is idiomatic TypeScript, `tsc` checks it, and it compiles to a small integer. It names a choice, not a declaration |
| C2 | `offsetOf(T, "flags")` | SPEC:406 | A compile-time question about a type, like `keyof`. Unlike the atomic case, it leaves no second way to use the field |
| C3 | `withSlice` and `withBytes` loans through closures, and `forEach` instead of iterators | SPEC:577-581, 2543 | With no borrow checker, a closure is the loan's scope, and an iterator would need an object that escapes. Both reasons are stated in the spec |
| C4 | `new Map(u32, u32)` taking element descriptors that JS's `Map` doesn't | SPEC:1422 | The host needs element sizes at run time, and the type is std's, not the global one |
| C5 | Attributes as JSDoc tags (`@tsl.moves`, `@tsl.noalloc`) | 3.7 | Decorators aren't erasable (D29) |
| C6 | System-register intrinsics named after ARM's registers (`readIdAa64Pfr0El1`) | SPEC:5186-5201 | A closed list, one-to-one with the ARM ARM and easy to search for. Once A2 moves the barriers out, only the kernel's CPU layer uses them |
| C7 | `Msg.w0…w5`, and `epCall(ep, inout)` writing into a caller's `Msg` | SPEC:3538-3547, 3576 | It's the register image of a message, and typed protocols sit above it (5.9). Writing into the caller's struct avoids an allocation |
| C8 | `Str.of(lit("text"))` | SPEC:1423 | Verbose, but TSL has no run-time strings (3.6), and `lit` makes the static bytes visible |
| C9 | E3's `load`, `store`, `alloc(16, true, "__alloc")`, `loadAt(p, "i32@0,f64@8")` and the open `Allocator` string | `tsl-lowered/index.ts:26-99` | Phase 2 replaces all of it with TSL classes, and tslc decides placement (pipeline.md section 0). Don't carry any of it into phase 2. If E3 lives much longer, close `Allocator` (drop `string & {}`) and make `zero` a literal, `"zeroed"` |
| C10 | `__`-prefixed native ABI symbols (`__rc_release`, `__str_place`) | 4.5 | These are C-level names for native callers. B6 asks only that they mirror the TSL names |
| C11 | `asmFn` bodies in ARM assembly | SPEC:2741-2801 | Assembly is specific to one CPU by nature. When a second architecture arrives, wrap each in `onArch` |

Not findings, but noted in passing: `toF64` is called `to…` but can't trap, and `assert(cond, code)` requires a code even
though 3.10 reserves code 7 for an assert with none. Neither is worth a change by itself.

---

## Counts

| Priority | Findings |
|---|---|
| P1, fix before kernel work | 12: A1-A8, K1-K4 |
| P2, fix when touched | 13: B1-B13 |
| P3, leave | 11: C1-C11 |
