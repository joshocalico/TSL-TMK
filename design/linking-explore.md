# Linking and ABIs: a design exploration

Status: exploration, written 2026-11-07, for the owner. Nothing here is decided, and nothing in SPEC.md has changed.
It proposes decisions D51 to D58, assuming D51 is still the next free number when the owner reads this (D50 was the last on
2026-11-07). The evidence labels are SPEC.md's, plus one more:

- **CODE** means read in this repo on 2026-11-07, with the file named.
- **SOURCE** means a page fetched for this note on 2026-11-07, with its URL given.
- **MEMORY** means the author's recollection, not checked against a source. Treat it as a lead, not a fact.
- **EST** means an estimate.

---

## Summary (one page)

**Where we are.** Every build is whole-program, from source, into one image. `image.ts` links in memory with four fixup
kinds and writes no object file, symbol table or unwind data (CODE). Most of what makes the output fast and safe comes from
facts about the whole program. Escape and borrow elision, can-throw, class ids, flow-class layouts, the cycle type graph,
the inliner's call graph, and when `gen.chk` can be dropped are all such facts. So is something less obvious:
**down-lowering picks how each parameter is represented (`i32`, `u32` or `f64`, and which struct) from every flow in the
program.** It also links a private copy of the runtime into each module: the `rc` heap, `__exc_on`, the descriptor
indexes and the hash key (CODE, `down.ts` `finish`). Two separately lowered modules today would therefore have two heaps
and two exception slots.

**Main recommendations.**

1. **Make the everyday in-world build an incremental whole-program build, not separate compilation (D51).** Cache a
   summary per module and machine code per function, keyed by content and by the facts each function used. Closed-world
   optimisation is then kept and builds stay fast. Separate compilation becomes a *distribution* mode that produces
   *sealed units*.
2. **Give sealed units their own in-world ABI that does better than C (D52), though it is not a new calling convention.**
   - It uses the registers we already use: up to 8 integer and 8 float arguments and results, with multiple results in
     registers.
   - What it adds is a written boundary contract:
     - canonical representations at the boundary, generalising D32;
     - `rc`'s fixed rule of borrowed arguments and owned results;
     - references as tagged `i64`;
     - exceptions as a flag test after the call;
     - an interface summary with two hashes, one for the ABI and one for promised facts.
   - Inside a unit, inferred facts are used freely. Across a sealed boundary, only *promised* facts count, and everything
     else is conservative.
3. **Split the runtime into one owner per image and thread (D53).** This is the precondition for any in-world linking,
   sealed or incremental across packages. The owner holds the `rc` heap and collector, the exception slot, string and map
   support, the page source and the hash key.
4. **Class identity across sealed units uses descriptor pointers and a display for `instanceof` (D54).** Preorder ranges
   stay, but only inside one closed world. A class that crosses a sealed boundary is either `frozen`, with its layout in
   the summary, or `opaque`, reached through accessors.
5. **Out of world, use the platform's C convention, and trust nothing (D55).** Imports live only in unsafe modules, with
   generated wrappers that restore our invariants. Examples: zero-extending narrow results, stripping generation tags,
   and never letting an exception or a trap cross a C frame. An import is assumed to store, overwrite, allocate and sleep
   unless an audited declaration says otherwise.
6. **Executables (D56).** The order:
   1. Relocatable object files for the system linker. ELF first, then Mach-O, then COFF.
   2. Our own linker for Linux static-PIE, which our position-independent output makes almost free.
   3. Our own Mach-O writer with chained fixups and an ad-hoc signature.
   4. PE.

   Hosted targets need frame records and unwind data, which the backend doesn't emit today (x29 is allocatable).
7. **Reproducibility (D57).** Witnesses cover the unsigned content. Ad-hoc signatures, PE timestamps and build ids are
   derived from content, so even signed output is reproducible.
8. **In our own OS (D58).** Applications are bundled and statically linked by default. A small sealed system layer with a frozen in-world ABI may be shared libraries (owner, 2026-11-07: "no shared libraries" softened to this). Code sharing between domains is off by default, because shared pages
   are a side channel. Plugins are domains, and a JIT for `eval` would be an EL0 client of the sealed ABI.

**Decide now, so nothing is undone later:**

- the summary format and its two hashes;
- the runtime-owner split;
- a symbol-naming scheme;
- per-target frame-pointer policy;
- canonical boundary representations;
- keeping relocation kinds abstract in the code buffer;
- keeping AArch64 out of TIR and the summaries, since x86-64 is coming later (section 8).

**Biggest risk.** Down-lowering's representation choices are global fixed points. Making them incremental means tracking
which facts each function read, which is real compiler work. If it slips, the fallback is coarser caching per
strongly connected component of modules.

---

## 1. What the code does today

Facts this note depends on, all CODE as of 2026-11-07:

- **The linker** (`compiler/backend-aarch64/image.ts`):
  - It merges the program, the runtime TIR, libm and the driver into one module, keeps what is reachable from four
    roots, canonicalises it, emits each function into one `Code` buffer, and resolves four fixup kinds in place: `b26`,
    `bl26`, `adrp` and `add12`.
  - The output is an arm64 Linux-style `Image`, with the `ARM\x64` magic, in `runtime.ts`.
  - There are no relocations in the output, no symbol table besides the in-memory map, no unwind data, and no debug
    information.
- **The code is position-independent by construction.**
  - Addresses come from `adrp`/`add` pairs.
  - Static objects' addresses and generation prefixes are written at run time by `__statics` (SPEC 4.3), and
    `call.indirect` goes through a code pointer in a register. So an image has **no data relocations**.
  - That makes Linux static-PIE and Mach-O rebasing nearly empty, and it's worth keeping (section 5).
- **The internal convention** (`regalloc.ts`, `emit.ts`):
  - Arguments and results go in x0–x7 and d0–d7, then 8-byte slots in the caller's outgoing area, including results past
    eight. That last part is not AAPCS64.
  - x8, x16, x17 and d29–d31 are scratch. x18 is never touched.
  - x29 is an ordinary callee-saved register, with no frame chain.
  - Every integer register holds its value zero-extended to 64 bits. That's an invariant callers and callees both rely
    on, and it's stronger than any C convention promises.
  - Prologues save callee-saved registers in allocation order, in pairs.
- **Representation is inferred** (`down.ts`, SPEC 4.5):
  - A `number` location becomes `i32`, `u32` or `f64` from every flow into it.
  - Types that flow together unify into one struct, a flow class.
  - Closures that can reach one call site share one convention.
  - Exports are pinned: a `number` parameter is `f64` (D32).
- **The runtime is per module** (`down.ts` `finish`):
  - `rcRtFuncs`, `excRtFuncs`, `strRtFuncs` and `hashRtFuncs` are lowered into each module that reaches them, along with
    their globals.
  - `rcDesc` is an index into that module's descriptor table.
  - `__exc_on`, `__exc_val` and `__exc_mode` are that module's globals (`down-exc.ts`).
- **The facts summaries would carry already exist as data.**
  - `tmk lower --report --memory rc` on a 10-line scratch file in /tmp printed "9 of 24 functions can overwrite a counted
    slot", the `overwriters` fact that borrow elision rests on (`down-rc.ts`).
  - It also printed the cycle groups from the type graph, including `$unknown, TmkRangeError`: once a thrown value is an
    `unknown`, error classes can sit in a cycle.
  - Can-throw is a fixed point in `down-exc.ts`. Escape summaries per reference parameter are SPEC 3.5's.

---

## 2. Requirements for an in-world ABI

"In-world" means TSL or lowered code calling TSL or lowered code built at another time. There are two ways to do that,
and they need different things:

- **Incremental whole-program (the default proposed here).** Every module is still visible to one link step, so every
  fact survives. Summaries are a cache, and a stale one is a bug. Rebuild rules are about speed, not compatibility.
- **Sealed units (distribution).** A unit is compiled once and used by programs built later, perhaps by another version
  of the compiler. What crosses has to be written down, and anything not written down is assumed at its worst.

### 2.1 Each closed-world fact at a sealed boundary

| Fact | Lives in | Across a sealed boundary | What the summary carries | A callee change forces callers to rebuild when |
|---|---|---|---|---|
| Escape: is a reference parameter stored, does the result derive from it (3.5) | tslc's per-function summary | **Promised.** It decides whether callers even compile (TSL3001) | Two bits per reference parameter: `stores` and `returns-from` | A parameter goes from not stored to stored. That breaks the *source*, not just the binary, so it's a major version |
| Borrow elision in `rc`: can this callee overwrite a counted slot (D39) | `overwriters` in `down-rc.ts` | **Promised or conservative.** Unknown means "overwrites", so the caller holds its arguments | One bit per function, `nooverwrite` | The bit turns off. If it isn't promised, callers already hold, and nothing breaks |
| Ownership in `rc` | A fixed rule: borrowed arguments, owned result | **Survives unchanged.** It's the same rule everywhere | Nothing per parameter. A `consumes` mark could come later, if measured | Never, while the rule stays fixed |
| Can-throw (D49) | Fixed point in `down-exc.ts` | **Conservative by default:** test `__exc_on` after every call to a sealed unit. D49 measured that at 0.07 ns a call | An optional promised `nothrow` bit | A promised `nothrow` is withdrawn. Without the promise, never |
| `noalloc`, `nosleep` (3.7) | Declared, and checked transitively | **Promised:** they're already declarations | Two bits | One is withdrawn, which is a source break for `noalloc` callers |
| Class ids in preorder (D50) | Numbered over the program's forest of classes | **Can't survive.** Another unit's subclass needs an id inside the base's range | Descriptor or range scheme, 2.4 | With ranges: the reserved range overflows. With descriptors: never |
| Flow-class layouts (D50, 4.5) | Unified from every flow | **Can't survive** for a type that crosses. It has to be `frozen` (offsets written down) or `opaque` | Field offsets and sizes for `frozen` types. Only a size-and-descriptor symbol for `opaque` ones | A `frozen` layout changes (break). `opaque` types are encapsulated |
| Layout classes and plain classes in TSL proper (3.4) | Normative, in declaration order | **Survives:** it's already `repr(C)`-like | The layout, for checking | Any field change |
| Type graph, which types can be in a cycle (D41) | SCCs over fields, captures and environments | **Conservative:** a type whose fields reach into another unit is assumed cyclic unless the summary closes it. SPEC 3.5 says a missing edge can only leak, so being wrong this way is never unsafe | A graph slice: for each exported type, which exported or opaque types its references can reach, plus a `closed` bit | A type's slice grows. Callers then keep barriers they had omitted, which affects speed only if the slice is just an observed fact |
| Inlining (D46) | Whole call graph | **Gone** unless a body is exported | TIR bodies for `@tsl.inlinable` exports, in canonical text | Any change to an exported body. Swift calls this "binary-compatible source-breaking", 3.1 |
| `gen.chk` omission (3.5) | "Could this have come from memory": whole program | **Conservative:** a reference arriving from a sealed unit is checked | Nothing | Never |
| Representation of `number`, unions and closures (4.5) | Inferred per flow | **Pinned to canonical forms**, 2.3 | The canonical signature | The TS signature changes |
| Memory mode (D38) | Per package | **Survives, as a compatibility check** | The mode, and whether `rc` with the collector is on | The mode changes |
| Runtime state (heap, exception slot, hash key, page source) | Per module today | **Needs one owner**, D53 | The runtime's ABI version | The runtime's ABI version changes |

The pattern: **declared facts become promises, inferred facts become conservative assumptions, and identities need an
owner.** That's Swift's split between `@frozen` and `@inlinable` on one side and resilient types on the other, and it's
.NET's version bubble (3.1, 3.4).

### 2.2 Interface summaries

A summary (`.tsli`) is canonical text, like TIR's: sorted, no paths or timestamps, and hashed with SHA-256 like
`tirhash`. It holds:

- **Header:** format version, compiler ABI version, target-independent flags, memory mode, cycle collector on or off, and
  the runtime ABI version.
- **Signatures:** each export's TS-level signature with TSL's flavoured numeric types (`u8` to `u64`, `i32`, `f64`,
  `usize`), and its canonical machine signature: TIR leaves per parameter and result.
- **Facts per function:** escape bits per reference parameter; and `noalloc`, `nosleep`, `nothrow`, `nooverwrite`, each
  marked *promised* or *observed*.
- **Types:**
  - for each exported class, `frozen` (fields with offsets, size, alignment) or `opaque` (a size symbol and a descriptor
    symbol);
  - for a class in a hierarchy, whether it's `open` to subclasses in other units;
  - the class descriptor symbol (2.4);
  - the type-graph slice;
  - the `rc` descriptor symbol, never an index.
- **Bodies:** TIR for `@tsl.inlinable` functions and for generic functions exported for instantiation (2.5).

There are **two hashes, as GHC has.** GHC 9.8's `ModIface` carries `mi_iface_hash`, "Hash of the whole interface", and
`mi_mod_hash`, "Hash of the ABI only" (SOURCE,
https://hackage.haskell.org/package/ghc-9.8.1/docs/src/GHC.Unit.Module.ModIface.html). Ours would be:

- **`abihash`:** everything a caller's machine code depends on. That's canonical signatures, `frozen` layouts, promised
  facts, symbols, and inlinable bodies.
- **`ifacehash`:** that plus observed facts. Incremental whole-program builds key on it. Sealed builds ignore observed
  facts, so they key only on `abihash`.

A program records the `abihash` of every sealed unit it was built against. A loader or linker refuses a mismatch, as
`Verify_*` fixups in ReadyToRun do (3.4). Versioning follows Swift's rule: adding a `frozen` promise is fine, withdrawing
one is a new major version.

### 2.3 Representation at the boundary

The calling convention can stay what the backend already does. That beats C because it returns up to 8 + 8 values in
registers. The Wasm canonical ABI allows one flat result, "MAX_FLAT_RESULTS = 1", because C can't express more (3.3). What
has to be pinned is *representation*:

- **Numbers.** Declared TSL types cross as themselves. A lowered `number` crosses as `f64`, as D32 already does for
  exports. Inside a unit it can be `i32`, with a wrapper converting at the edge. That's Go's ABI-wrapper idea (3.5) applied
  to representation.
- **Integer invariant.** Integers cross zero-extended to 64 bits. This is our own rule, written down so a sealed unit
  compiled later can rely on it. C imports don't get it for free (section 4).
- **Multiple results** in x0–x7 and d0–d7, then the caller's outgoing area. A value record or value union (D26) is
  flattened by 3.5's normative rule: discriminant as `i32`, then the fields, at most 4 words. That's a better ABI than
  any C struct-return rule, and it's already specified.
- **Exceptions.**
  - A call into a unit that can throw is followed by a load of the exception flag and a branch, as D49 does.
  - The flag can't be each module's `__exc_on`. It becomes a runtime symbol, per thread once threads exist (D40), reached
    through `TPIDR_EL0` or one global in a single-threaded image.
  - D49 rejected a second result register inside a module. At a sealed boundary it's worth measuring again, because a
    register test needs no load. But it changes every signature, so the flag is the default.
- **`rc` ownership.** Arguments are borrowed and results owned, exactly D39's native ABI, with `__rc_release` from the
  shared runtime. No mark per parameter is needed while the rule is uniform.
  - Swift and the Wasm component model both have per-parameter ownership (`borrow`/`own` handles in the canonical ABI,
    3.3). They need it because their conventions vary. Ours doesn't, which is simpler, and a `consumes` mark can be
    added later as a pure addition.
- **References** cross as the 64-bit value already used in registers: a 48-bit pointer and a 16-bit generation tag, with
  tag 0 for stack and view origins.
  - The receiver checks `gen.chk` on a reference from a sealed unit unless it was declared non-stored.
  - This assumes user virtual addresses fit in 48 bits. That's true of our kernel. On Linux, AArch64 user space gets
    more than 48 bits only if it asks (MEMORY). Section 4 covers C.
- **Closures.**
  - A lowered closure is a pointer to an environment whose first word is the code pointer. It's called with the
    environment as a hidden first argument (4.5).
  - Within a unit, closures that can meet share an inferred convention. At a boundary the convention is the canonical one
    for the TS type, and a closure crossing out gets a thunk converting from its internal convention.
  - TSL proper's non-escaping closures (code, environment on the stack) cross only as arguments, which already holds.
- **Strings.** One pointer, as D36 and D42 say. The header `[len][hash][off]` is effectively frozen already, because
  native callers read it. Keep it frozen, and say so.
- **`Map` and `Set`: opaque.** Today a native caller reads `keys`, `vals` and `chain` at `DownMeta` offsets (4.5). D47
  plans incremental growth, which will change that layout. That's exactly the change a sealed ABI must not see, so make
  them opaque at sealed boundaries, with runtime functions to read them.
- **Typed arrays** as (pointer, length). Arrays as a header pointer, `frozen` because the header is the runtime's.

### 2.4 Layout and class-id stability across separately compiled hierarchies

Three options:

1. **Closed-world preorder (now).** It's the fastest: `instanceof` is two compares, and dispatch is a switch folded into
   the call site. It's only valid when every class is known. Keep it inside a unit and inside an incremental
   whole-program build.
2. **Ranges per hierarchy.** An `open` class reserves a range of ids, and other units take ids from it. It's still two
   compares. But the reservation is a guess. The id has to be assigned when the program is linked, so it becomes a
   relocation. And running out of range is an ABI break. This is the C++ Itanium ABI's kind of fragility (3.7): it works
   until someone adds one more.
3. **Descriptor pointers and a display.**
   - The class-id word holds a pointer to a read-only class descriptor holding its depth, a display (ancestor
     descriptors indexed by depth), size, `rc` descriptor and method table.
   - `instanceof T` is "depth ≥ T.depth and display[T.depth] == T": two loads and two compares, constant time. This is
     the classic Cohen display technique (MEMORY: Cohen, "Type-extension type tests can be performed in constant time",
     TOPLAS 1991; not checked).
   - A subclass in another unit adds fields after the base's size, read from the base's descriptor at load time. That's
     ReadyToRun's "base-class size from a slot set at load time" (3.4).
   - Dispatch across the boundary goes through the descriptor's method table, with an indirect call that can't be
     inlined. That's D50's rejected alternative, accepted only at the boundary.

**Recommendation:** option 3 for anything `open` across a sealed boundary, and option 1 everywhere else. One flow class
can't mix the two. A hierarchy is either sealed-world, using preorder, or open, using descriptors, and the summary says
which. D50's flow-class union layout is also the wrong layout for an open hierarchy, because it changes when another unit
adds a subclass. An open hierarchy needs prefix layouts (base fields first, each subclass appending), which D50 already
named as the next step if memory measures badly.

### 2.5 Generics

TSL and down-lowering monomorphise, capped at 128 instances (4.5). At a sealed boundary:

- **Monomorphise in the client from an exported body.** This is what C++ templates and Rust generics do, and what
  `@inlinable` does for Swift. It's fast, and a body change rebuilds clients. It fits our model, since it's just an
  inlinable body.
- **Dictionaries, or witness tables.** One compiled body takes a table of operations per type argument. For value
  semantics that's Swift's value witness table, which "records the size, alignment, stride, and other fundamental
  properties" and the functions for "allocating, copying, and destroying values" (SOURCE,
  https://github.com/swiftlang/swift/blob/main/docs/ABI/TypeMetadata.rst). This is the only way to ship generic code
  without its source, and it costs an indirect call per operation and a lot of compiler machinery.
- **Uniform representation for references.** With `T` a class type, every instance is one pointer, and the only
  type-dependent operations are `rc`'s retain and release through a descriptor. Then one body serves all reference
  instantiations. .NET shares code across reference-type instantiations in a similar way (MEMORY).

**Recommendation:** in the first sealed phase, generic exports must be `@tsl.inlinable` and are monomorphised in the
client. Shared bodies for reference-only type parameters can come next, cheaply. Dictionaries only if a real case needs
binary-only generic code, which our own OS doesn't, since domains link statically.

### 2.6 What a callee change forces, in one list

- **Encapsulated in sealed mode:**
  - function bodies, unless `@tsl.inlinable`;
  - observed facts;
  - `opaque` layouts;
  - adding exports;
  - adding a subclass to an `open` hierarchy that uses descriptors;
  - adding fields to an `opaque` class;
  - adding a `Map` growth strategy.
- **Breaks callers' binaries:**
  - a canonical signature change;
  - a `frozen` layout change;
  - withdrawing a promised fact;
  - changing an `@tsl.inlinable` body (callers keep the old copy, which is a semantic break if behaviour matters);
  - a runtime ABI version change.
- **Breaks callers' source:**
  - a parameter becoming stored;
  - `noalloc` or `nosleep` withdrawn;
  - a TS type change.

---

## 3. Prior art

### 3.1 Swift: library evolution and resilience

SOURCES: https://www.swift.org/blog/library-evolution/,
https://github.com/swiftlang/swift-evolution/blob/main/proposals/0260-library-evolution.md,
https://github.com/swiftlang/swift/blob/main/docs/LibraryEvolution.rst,
https://github.com/swiftlang/swift/blob/main/docs/ABI/TypeMetadata.rst.

**What it does:**

- `-enable-library-evolution` is off by default and meant only for frameworks shipped separately from their clients. On
  an already-shipped framework, turning it on is itself a binary break.
- Across the "resilience boundary", a non-frozen type's size, alignment and copy and destroy behaviour are opaque. Clients
  use metadata at run time and compute field offsets at run time, with no boxing.
- `@frozen` on a struct promises its stored properties won't change, so clients can access fields directly. On an enum it
  promises no cases will be added. It can't be added or removed later.
- `@inlinable` exposes a body, and changing it is "binary-compatible source-breaking".
- Library evolution "will have no impact on libraries built and distributed with an app".

**Take:**

- the explicit boundary;
- promises (`@frozen`, `@inlinable`) as opt-in exceptions to opacity;
- and above all the last point: a closed world within the shipped unit costs nothing.

**Avoid:**

- making resilience the default anywhere;
- metadata-driven value witness tables for *values*. Our types that cross are references or frozen layouts, so we don't
  need the general machinery.

### 3.2 Rust: no stable ABI, `repr(C)` and crABI

SOURCES: https://doc.rust-lang.org/reference/type-layout.html, https://github.com/rust-lang/rust/issues/111423,
https://docs.rs/abi_stable/latest/abi_stable/, https://docs.rs/stabby/latest/stabby/.

**What it does:**

- `repr(Rust)` promises almost nothing: "Type layout can be changed with each compilation".
- `repr(C)` is declaration order with C padding.
- crABI (tracking issue #111423, opened 2023-05-10 and still open) aims at "a strict superset of the C ABI support for
  Rust", with niche encodings, tuples and generics among its open questions. It hasn't reached an RFC.
- Crates fill the gap: `abi_stable` adds load-time type checking between Rust libraries, and `stabby` adds stable
  layouts for sum types.

**Take:** the clean split between a free internal layout and an opt-in fixed one. TSL already has it: layout classes are
our `repr(C)`.

**Avoid:**

- leaving the in-world ABI undefined for years, so the ecosystem invents several;
- a "C superset" framing for the in-world ABI. Our boundary contract (ownership, exceptions, generations) is not C's
  problem.

### 3.3 WebAssembly component model, canonical ABI

SOURCE: https://raw.githubusercontent.com/WebAssembly/component-model/main/design/mvp/CanonicalABI.md.

**What it does:**

- `MAX_FLAT_PARAMS = 16` and `MAX_FLAT_RESULTS = 1`. Values past those limits go through linear memory, allocated with a
  `realloc` option of type `(old ptr, old len, align, new len) -> ptr`.
- `post-return` frees what a lift allocated.
- Strings are UTF-8, UTF-16 or Latin-1 plus UTF-16.
- Resources are handles in a per-instance table with `own` and `borrow`. A borrow is scoped to the call, and outstanding
  borrows trap at return. A `borrow` can't be a result.

**Take:**

- borrowed-by-default with a strict scope, which matches D39 exactly;
- results never borrowed;
- the explicit allocator hook, which D36's arena and `__str_place` already resemble.

**Avoid:** copying at the boundary. Components don't share memory, and our in-world units do. The canonical ABI's lifting
and lowering belong between *domains*, not between units of one domain.

### 3.4 .NET: metadata and ReadyToRun version bubbles

SOURCES: https://github.com/dotnet/runtime/blob/main/docs/design/coreclr/botr/readytorun-overview.md,
https://github.com/dotnet/runtime/blob/main/docs/design/coreclr/botr/readytorun-format.md.

**What it does:**

- A version bubble is "a set of DLLs that we are willing to update as a set". Inside a bubble, inlining and
  optimisation are free. Across bubbles, inlining is forbidden except for `[NonVersionable]` methods.
- Calls across bubbles go through lazily fixed-up cells.
- Field access reads a base class's size from a slot filled at load time.
- Adding fields to reference classes is allowed, and changing a public value type's layout is a break.
- Fixups carry checks: `Check_TypeLayout` and `Check_FieldOffset` silently drop the precompiled code on a mismatch, and
  `Verify_*` fails hard.

**Take:**

- the bubble as the unit of closed-world optimisation, which is exactly a sealed unit here;
- the base-size slot for open hierarchies (2.4);
- verifying an assumption at load time and failing loudly.

**Avoid:** the "drop code and fall back to the JIT" path. We have no JIT to fall back on, so a mismatch must be a link or
load error.

### 3.5 Go: ABIInternal, ABI0 and wrappers

SOURCES: https://go.googlesource.com/go/+/refs/heads/master/src/cmd/compile/abi-internal.md,
https://go.googlesource.com/proposal/+/master/design/27539-internal-abi.md.

**What it does:**

- Go code uses ABIInternal, which "is _unstable_ and will change between Go versions".
- Assembly uses ABI0, a frozen stack convention.
- Symbols are (name, ABI) pairs. The compiler generates wrappers where a definition and a reference meet, and the linker
  checks every reference uses the right ABI.
- On arm64, ABIInternal passes up to 16 integer and 16 float values in registers and fixes registers for the closure
  context (R26) and the current goroutine (R28), with R18 reserved and R29 the frame pointer.

**Take:**

- an unstable internal convention free to change, a stable named one for boundaries, and wrappers generated where they
  meet, checked by the linker;
- symbols tagged with their convention;
- making the internal convention explicitly unstable.

**Avoid:** freezing a convention by accident. Go's 27539 says the stack ABI became effectively public because assembly
relied on it. Our internal convention is relied on by `asmFn` and the runtime's hand-written routines today, so name it
before something outside depends on it.

### 3.6 Zig

SOURCES: https://ziglang.org/documentation/master/, https://ziglang.org/download/0.14.0/release-notes.html.

**What it does:**

- "Zig gives no guarantees about the order of fields and the size of the struct". An `extern struct` matches the C ABI,
  and a `packed struct` is its backing integer.
- `export` uses the C ABI and makes a function visible in the object file.
- Analysis of top-level declarations is lazy.
- In 0.14.0, incremental compilation is opt-in (`-fincremental`) and "not ready to be enabled by default", and compiler
  state isn't yet saved between runs.

**Take:**

- Zig's out-of-world choice, which is the owner's: the C ABI and nothing else at the boundary, layouts fixed only where
  asked.
- The lesson that incremental compilation for a lazily analysed language is hard and slow to finish (section 6).

**Avoid:** having no in-world binary story at all. That's fine for Zig, but this project has domains built at different
times from one store.

(MEMORY: Zig builds a whole program as one compilation unit by default. The pages fetched didn't say so explicitly.)

### 3.7 C++ and the Itanium ABI's fragility

SOURCES: https://itanium-cxx-abi.github.io/cxx-abi/abi.html,
https://gcc.gnu.org/onlinedocs/libstdc++/manual/using_dual_abi.html.

**What it does:**

- Virtual function pointers are in declaration order, and a derived class appends its own after its primary base's.
- Data members follow the base at its data size, and the tail padding of non-POD bases can be reused.
- So a field or virtual function added to a base moves offsets and slots that already-compiled derived classes and
  callers have baked in. This is the fragile base class problem. It's an inference from the layout rules: the page read
  doesn't use the phrase.
- GCC 5.1 changed `std::string` and `std::list` and needed a dual ABI: an inline namespace `__cxx11`, chosen per file by
  `_GLIBCXX_USE_CXX11_ABI`.

**Take:** inline namespaces, a version in the symbol name, are a cheap way to make a mismatch a link error rather than a
crash. Our symbols should carry a runtime ABI version for the same reason.

**Avoid:**

- offsets and slots compiled into clients for types that can evolve;
- a standard library whose layouts are public by accident. That's the `Map` point in 2.3.

### 3.8 GHC interface files

SOURCES: https://downloads.haskell.org/ghc/latest/docs/users_guide/separate_compilation.html,
https://downloads.haskell.org/ghc/latest/docs/users_guide/using-optimisation.html, and `ModIface` above. The GHC wiki page
on recompilation avoidance refused automated access.

**What it does:**

- A `.hi` file has exported types and definitions, and under optimisation "unfolding or strictness information".
- GHC fingerprints each interface and each declaration, records the fingerprints of everything it used, and "stops
  compiling early" when they all match.
- `-fomit-interface-pragmas` drops inessential information, so nothing a module exports is inlined elsewhere.
- `-funfolding-creation-threshold` caps the size of exported bodies.

**Take:** this is the model for section 6.

- interface files carrying optimisation facts and bodies;
- fingerprints per declaration, so a dependent rebuilds only when what *it used* changed;
- separate ABI and whole-interface hashes;
- a size cap on exported bodies.

**Avoid:** GHC's history of interface-file churn across compiler versions (MEMORY). Version the summary format and put
the compiler's hash in the key.

---

## 4. Out of world: foreign code

The owner's direction is fixed: the platform's C convention. The questions are which conventions, and what crossing
costs.

### 4.1 Calling conventions on arm64

| | AAPCS64 (Linux, bare metal) | Apple arm64 | Windows on ARM64 |
|---|---|---|---|
| x18 | "The role of register r18 is platform specific", and portable code should avoid it | "The platforms reserve register `x18`. Don't use this register." | In user mode, "points to TEB" |
| Frame pointer x29 | Callee-saved (r19–r29), with a frame chain by platform choice | "must always address a valid frame record" | Required, "for compatibility with fast stack walking used by ETW" |
| Variadic arguments | Like named arguments, with the AAPCS `va_list` | Assigned to 8-byte stack slots, so in effect all on the stack, and `va_list` is `char*` | "SIMD and Floating-point Registers aren't used": the first 64 bytes go in x0–x7 |
| Small integer arguments | "any unused bits in the register have unspecified value", and the callee narrows | "The caller … is responsible for signing or zero-extending any argument with fewer than 32 bits" | Unspecified, as AAPCS64 |
| Stack arguments | 8-byte slots | Packed: slots "not multiples of 8 bytes", so two `char`s sit at `sp` and `sp+1` | As AAPCS64 |
| Red zone | None | 128 bytes | 16 bytes, reserved for tools |
| Large frames | Nothing required | Nothing required (MEMORY) | Allocations of 4 KB or more must probe each page (`__chkstk`) |
| `long double` | Quad precision | Same as `double` | Same as `double` (MEMORY) |

Sources for the table: AAPCS64, https://raw.githubusercontent.com/ARM-software/abi-aa/main/aapcs64/aapcs64.rst; Apple, "Writing
ARM64 code for Apple platforms", read through
https://developer.apple.com/tutorials/data/documentation/xcode/writing-arm64-code-for-apple-platforms.json (the HTML page
rendered empty); Windows, https://learn.microsoft.com/en-us/cpp/build/arm64-windows-abi-conventions. AAPCS64 also makes x16
and x17 (IP0 and IP1) temporaries that linkers and veneers may clobber, and x8 the indirect result register. Apple can also
start a 16-byte-aligned argument in an odd register (`(int, __int128)` uses x1 and x2), which AAPCS64 doesn't.

**What this means for us:**

- **x18.** We never touch it already. Keep that a rule of the backend on every target, including our OS, so one code
  generator serves all.
- **Frame records.** These are needed on Apple and Windows, and wanted everywhere a debugger or sampling profiler runs.
  - The backend makes x29 allocatable. For hosted targets: `stp x29, x30, [sp, #-n]!; mov x29, sp` first, then the
    callee-saved pairs in a canonical order.
  - Cost: one register and two instructions in non-leaf functions (EST: small, but measure it on `tmk bench`).
  - In our own OS this could stay off, but a frame chain is also the cheapest stack sampler. **Open question 3.**
- **Narrow integers.** Our invariant is zero-extension to 64 bits.
  - An import's narrow result has unspecified upper bits on AAPCS64, so the wrapper zero- or sign-extends it.
  - An argument we pass already satisfies every platform, including Apple's 32-bit extension for unsigned types. For
    *signed* narrow types on Apple, the caller must sign-extend to 32 bits. Our zero-extended `i8 -1` (0xff) would be
    wrong, so the wrapper sign-extends.
  - Exports (`@tsl.export-c`) must normalise incoming narrow arguments, since C won't have zero-extended them.
- **Aggregates by value.** TIR has none; it's SROA'd. C struct arguments and returns need the platform's classification:
  - homogeneous float aggregates in v registers;
  - 16 bytes or less in two x registers;
  - larger ones by reference, with x8 holding the indirect result address.

  x8 is our scratch register, so a wrapper that does this must set it after anything else that uses scratch. Support
  layout classes by pointer first, and add by-value structs only for APIs that need them.
- **Variadic calls.** Support `printf`-style imports only through a per-platform lowering. On Apple everything goes on the
  stack, so the import declaration must say which arguments are variadic.
- **Stack probing on Windows.** Our frames can be up to 1 MiB (4.4). On Windows any frame of 4 KB or more must touch each
  page in its prologue, so the backend needs a probe loop there. Our own OS's 2 MiB guard makes this unnecessary at home.
- **x16 and x17** are our scratch registers. Linkers may also use them in veneers between a call and its target. That's
  compatible, as long as we never keep a value in them across a `bl`. We don't.
- **More than 8 results.** Fine internally, never at a C boundary. A C import has at most one result; an aggregate would
  come back through x8.

ARM64EC is Windows' arm64 ABI that's compatible with x64 for mixing emulated x64 code in one process. It's relevant only if
we interoperate with x64 DLLs on Windows, which nothing here asks for. Microsoft: "code built as ARM64EC can interoperate with
x64 code running under emulation in the same process" (SOURCE, the Windows conventions page above).

### 4.2 Crossing is untrusted

An imported C function sees none of our closed-world facts, and we can verify none of its behaviour. So:

- **Where imports live.** They're declared only in unsafe modules (3.8), with `@tsl.import-c name` on a `declare
  function`, and counted by `tmk audit` (S8).
- **Allowed parameter types:** scalars; `Ptr<T>`; layout classes by pointer or view; typed arrays as (pointer, length);
  function pointers to `@tsl.export-c` functions. Not allowed:
  - Stack references and safe class references can't be passed. C would store anything, so TSL3001 applies.
  - Counted `rc` references can't be passed except as an opaque handle the caller retains and releases explicitly.
  - A generation-tagged reference has to have its tag stripped. 16 tag bits are more than Top Byte Ignore's 8, so passing
    one would fault (MEMORY for the TBI detail).
- **Assumed facts for any import:** may store every pointer argument, may overwrite any counted slot it can reach, may
  allocate, may sleep, may not return. A wrapper is therefore:
  - not `noalloc` or `nosleep`, unless the declaration promises it (an audited, trusted claim, like a page source's);
  - a borrow-elision barrier;
  - a point where every `gen.chk` omission is re-proved.
- **Exceptions.** Our exceptions are a flag, so C code can't throw them. An import is `nothrow` in our sense. What it can
  do:
  - `longjmp` past our frames, or let a C++ exception or `abort` through. Any of these skips `rc` releases and `finally`.
    So imports are declared non-unwinding, as crABI's default `extern "crabi"` is (3.2), and crossing is undefined
    behaviour that we document, not support.
  - Crash or `abort`. That's the process's death, like a trap.

### 4.3 Exceptions and traps at the boundary, and callbacks

- **Out of TSL into C.**
  - An exception reaching an `@tsl.export-c` wrapper follows D36: by default the trap path, describing the value, or with
    `__exc_catch_use(1)` a zero result with the exception left pending.
  - A trap inside code C called is the process ending, through our trap handler. On a hosted OS, that's a `brk` or
    `udf` delivered as a signal that our handler reports and then `_exit`s. A fault near address 0 in our text is trap 6.
  - We never unwind C frames. So no TSL trap is catchable across a C frame, and `native.try` must not span one.
- **Callbacks from C.**
  - A C callback is an `@tsl.export-c` top-level function. A closure crosses only as a `(code, void *ctx)` pair whose
    `ctx` is an opaque handle the TSL side retains.
  - Each callback wrapper establishes the runtime state for the calling thread: page source, `rc` heap, exception slot.
    A thread C created has none of that. Under D40 it has to call an attach function first, or the wrapper traps with a
    clear code. That's a new trap code, reserved now.
- **Re-entrancy.** C calling back into a module while one of our calls is in flight is fine for `rc` (counts are
  per-thread and consistent at calls), but D41's collector must not be running a step at the time. It doesn't, since it
  steps only inside allocation.

---

## 5. Executables

### 5.1 What every format needs from the backend first

1. **Relocations kept abstract.**
   - `Code.fixups` already names its kinds: `b26`, `bl26`, `adrp`, `add12`.
   - Each maps to an object-file relocation:
     - ELF: `R_AARCH64_CALL26` (283), `JUMP26` (282), `ADR_PREL_PG_HI21` (275) and `ADD_ABS_LO12_NC` (277) (SOURCE,
       https://raw.githubusercontent.com/ARM-software/abi-aa/main/aaelf64/aaelf64.rst);
     - COFF: `IMAGE_REL_ARM64_BRANCH26` (3), `PAGEBASE_REL21` (4) and `PAGEOFFSET_12A` (6) (SOURCE,
       https://learn.microsoft.com/en-us/windows/win32/debug/pe-format);
     - Mach-O: `ARM64_RELOC_BRANCH26`, `PAGE21` and `PAGEOFF12` (MEMORY).
   - Add a GOT-load form for imports: `adrp` plus `ldr`, the unused `ldr12x`.
2. **Keep position independence with no data relocations.**
   - `__statics` writing addresses at run time is unusual, but it means a static-PIE ELF needs no relative relocations
     and a Mach-O no rebases.
   - The cost is that statics live in writable data. That's already true of their prefixes.
3. **Frame records and a canonical prologue on hosted targets** (4.1).
4. **Unwind data**, generated from the canonical prologue (5.6).
5. **A symbol table and a naming scheme.**
   - Today's names are `f:name` and `g:name`.
   - Proposed external form: `_tsl$<unit>$<name>`, with a runtime ABI version on runtime symbols (`__tslrt3_rc_release`).
     Version tags in names are the C++ dual ABI's lesson (3.7), and Go's symbols-with-ABI (3.5).
   - Mach-O adds a leading underscore on C symbols (MEMORY).
6. **A different start.** The image's start code (MMU, vectors) is bare-metal. A hosted executable starts at an ordinary
   entry: `LC_MAIN` or `_start`. It registers a page source over `mmap` or `VirtualAlloc`, a trap handler over signals or
   vectored exception handling, and a bulk output over `write`.

### 5.2 Mach-O, macOS arm64

- **Signing.** Since macOS 11 on Apple silicon, "any executable must be signed before it's allowed to run", and "a simple
  ad-hoc signature is sufficient". Since Xcode 12, `clang` and `ld` sign at link time. Ad-hoc signatures "cannot pass
  through Gatekeeper", which matters only for distribution. (SOURCE, Big Sur release notes,
  https://developer.apple.com/tutorials/data/documentation/macos-release-notes/macos-big-sur-11_0_1-universal-apps-release-notes.json)
- **System calls.** "Apple does not support statically linked binaries on Mac OS X", and gives no guarantee "at the
  kernel system call interface" (SOURCE, QA1118, https://developer.apple.com/library/archive/qa/qa1118/_index.html, last
  updated 2011). The page doesn't name the library. That it's `libSystem` is MEMORY, though well known. A program calls
  `write`, `mmap` and `exit` through it, so even a "static" Mach-O needs a dynamic import table and `dyld`.
- **The minimum executable:**
  - `__PAGEZERO`, `__TEXT`, `__DATA_CONST` (the import slots) and `__LINKEDIT`;
  - `LC_DYLD_CHAINED_FIXUPS` and `LC_DYLD_EXPORTS_TRIE`. Everything built for macOS 12 or iOS 15 and later "now use[s]
    the chained fixups format" (SOURCE, Xcode 13 release notes,
    https://developer.apple.com/tutorials/data/documentation/xcode-release-notes/xcode-13-release-notes.json). Load-command
    values are in `loader.h`
    (https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/EXTERNAL_HEADERS/mach-o/loader.h);
  - `LC_SYMTAB`, `LC_DYSYMTAB`, `LC_LOAD_DYLINKER`, `LC_UUID`, `LC_BUILD_VERSION`, `LC_MAIN`, `LC_LOAD_DYLIB` for
    libSystem, and `LC_CODE_SIGNATURE` last.
  - Because we have no data relocations, the chained fixups are only *binds* for the handful of libSystem imports.
- **Unwind.** Compact unwind (`__unwind_info`) for frame-based functions, falling back to `__eh_frame` for others
  (5.6).

### 5.3 ELF, Linux arm64

- **System calls.** The Linux system-call ABI is stable, so a static executable with raw `svc #0` calls works, with x8
  holding the system-call number. The kernel's own documentation says the syscall interface "is very stable over time,
  and will not break" (SOURCE, https://www.kernel.org/doc/html/latest/process/stable-api-nonsense.html). Go's linker
  "creates statically-linked binaries by default" (SOURCE, https://go.dev/doc/faq), and Zig shows a Linux build that `ldd`
  calls "not a dynamic executable" (SOURCE, https://ziglang.org/learn/overview/). The `svc #0` and x8 detail is MEMORY.
- **Static non-PIE** (`ET_EXEC`, two `PT_LOAD`s and an entry point) is the smallest correct executable.
- **Static-PIE** (`ET_DYN`, no `PT_INTERP`) is what a hardened distribution wants. Normally it needs a self-relocator for
  `R_AARCH64_RELATIVE`. **We'd have zero of those**, so ours is static non-PIE with a different `e_type` and no extra
  code.
- **For tools:** `.symtab`, `.eh_frame` with `.eh_frame_hdr` (`PT_GNU_EH_FRAME`) for unwinders and profilers, a
  content-derived `.note.gnu.build-id`, and `PT_GNU_STACK` non-executable.

### 5.4 PE/COFF, Windows ARM64

- Machine `IMAGE_FILE_MACHINE_ARM64` (0xAA64), PE32+.
- Windows also has no stable system calls (MEMORY), so the program imports `kernel32` (`VirtualAlloc`, `WriteFile`,
  `ExitProcess`) through an import directory.
- `.pdata` and `.xdata` are needed for any non-leaf function. Without them the OS can't unwind for exceptions or
  debuggers.
- `TimeDateStamp`, the checksum and the debug-directory GUID must be content-derived for reproducibility.
  - The PE format defines `IMAGE_DEBUG_TYPE_REPRO`, under which the time fields "are filled with … a calculated hash"
    and identical input gives bit-identical output (SOURCE, https://learn.microsoft.com/en-us/windows/win32/debug/pe-format).
  - `link.exe` and `lld-link` reach this with `/Brepro`, which seems to be undocumented by Microsoft (LLVM review
    https://reviews.llvm.org/D46966, not fetched in full).
- Authenticode signing isn't needed to run, but unsigned files get SmartScreen's "Windows protected your PC" warning, and
  Smart App Control on Windows 11 "will block execution of unsigned files unless the file has a positive reputation"
  (SOURCE, https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).

### 5.5 Our own linker or the system's

The working rules say to build our own component where an upstream limits the design, with zero runtime dependencies. A
system linker on a developer's Mac is a dev-time tool, like `clang` for the C backend, not a runtime dependency. The
guest never needs one: domains are `TMKIMG01` images, which we link ourselves.

**The smallest correct first step per format:**

| Format | First step | Then |
|---|---|---|
| ELF | Our own static (PIE) `ET_EXEC`/`ET_DYN` writer: headers, two segments, raw syscalls, `.symtab`. About as small as `image.ts` (EST: 300 to 500 lines). Testable under QEMU user mode or a Linux VM | `.eh_frame`, build-id, then `ET_REL` objects for `ld.lld` when C libraries must be linked |
| Mach-O | `MH_OBJECT` relocatable output, linked by the system `ld` against libSystem. `ld` writes the load commands, the fixups and the ad-hoc signature (5.2) | Our own `MH_EXECUTE` writer with chained fixups and a CodeDirectory, once the object path gives us something to compare bytes against |
| PE | COFF `.obj` for `lld-link` or `link.exe` | Our own PE writer, last, only if Windows matters |

**Why ELF gets our own writer first:** it has no dynamic linker requirement, no signature and no imports. It's the one
format where writing it ourselves is *smaller* than integrating with a linker. **Why Mach-O doesn't:** chained fixups and
code signing are two subtle formats whose only documentation is Apple's headers and open-source `ld64`/`dyld` code
(MEMORY). The system `ld` gets both right, and Apple rewrote it for Xcode 15, keeping the classic one as `-ld_classic`
(SOURCE, https://developer.apple.com/tutorials/data/documentation/xcode-release-notes/xcode-15-release-notes.json). `lld`
"supports ELF (Unix), PE/COFF (Windows), Mach-O (macOS) and WebAssembly in descending order of completeness" (SOURCE,
https://lld.llvm.org/), which makes it one cross-platform fallback, weakest on Mach-O.

### 5.6 Unwind information

Our exceptions don't unwind (D49), but debuggers, profilers, crash reporters and Windows' own exception dispatch do.

- **Compact unwind (Apple).**
  - The linker builds `__TEXT,__unwind_info` from per-function 32-bit encodings. The arm64 modes are FRAMELESS, FRAME,
    with a flag per saved pair from x19/x20 to x27/x28 and d8/d9 to d14/d15, and DWARF, which points to an FDE in
    `__eh_frame` (SOURCE,
    https://raw.githubusercontent.com/llvm/llvm-project/main/libunwind/include/mach-o/compact_unwind_encoding.h).
  - Flags per pair can only describe saves in the standard places. Our prologue saves whichever registers allocation used,
    in its order, so the canonical prologue in 4.1 is what makes the compact form possible. Anything else goes through
    DWARF.
- **`.eh_frame` (ELF, and Apple's fallback).** DWARF CFI describes any prologue, so it works with today's prologue too.
  It's the safest first target.
- **`.pdata`/`.xdata` (Windows).**
  - Each `.pdata` record is 8 bytes. Its flag says whether the rest is an `.xdata` reference or packed unwind data.
  - Packed data covers only canonical prologues, in functions up to 8 KB and frames within its field sizes.
  - `.xdata` holds byte codes that map one-to-one onto prologue and epilogue instructions, so a half-run prologue can be
    unwound.
  - A leaf that doesn't touch the stack has no record. (SOURCE,
    https://learn.microsoft.com/en-us/cpp/build/arm64-exception-handling)

**Recommendation:** one canonical prologue and epilogue shape for hosted targets, from which all three forms are generated
by table. Our OS's images can carry `.eh_frame`-like data for an in-guest debugger later; nothing needs it now.

### 5.7 Reproducibility, signing and witnesses (D33)

- **D33's witnesses** say "this image's hash is what this source and compiler give". That works only if every byte is a
  function of the inputs.
- **Ad-hoc Mach-O signature.** It's a SuperBlob holding one CodeDirectory of SHA-256 hashes of 4 KB pages, with constant
  header fields and no time or random input. That's from Go's ad-hoc signer, which says it "uses the same ad-hoc signing
  algorithm as the Darwin linker" (SOURCE, https://go.googlesource.com/go/+/HEAD/src/cmd/internal/codesign/codesign.go).
  No Apple page found says ad-hoc signatures are deterministic. Choose the identifier from the unit name, never a path.
  Go's signer is BSD-licensed, so it can be a reference under the working rules, with a `THIRD_PARTY` notice if anything
  is derived from it.
- **Developer ID signing and notarisation** add a CMS signature with a signing time, and notarisation adds a ticket
  (MEMORY). Neither is reproducible.
  - The rule: the witness covers the *unsigned* image, meaning the bytes with the signature region and `LC_CODE_SIGNATURE`'s
    data zeroed. That's the same idea as Authenticode, whose digest excludes the PE checksum and the certificate-table
    entry (SOURCE, PE format page above).
  - The signed file's hash is recorded beside it, but it isn't the witnessed hash.
- **`LC_UUID`, the ELF build-id and the PE debug GUID** are SHA-256 of the unsigned content, truncated.
- **PE `TimeDateStamp`** is a hash too, under `IMAGE_DEBUG_TYPE_REPRO`. `SOURCE_DATE_EPOCH` is the convention for a
  tool that insists on a time: tools "MUST use this variable for embedded timestamps" (SOURCE,
  https://reproducible-builds.org/specs/source-date-epoch/).
- **Our own OS** keeps D33 as it is: no signatures at boot, only pinned witnesses.

---

## 6. Inside our own OS

Domains are separate `TMKIMG01` images, and the boundary between them is IPC: 6 `u64` registers and at most one
capability, with bulk data through shared frames (5.4 of SPEC). That's an ABI too:

- **IPC interfaces are layout classes.** Layout classes are normative, so they're our `repr(C)`. An interface module
  (layout classes plus the message protocol) gets its own summary hash. Each domain's image records the interface hashes
  it speaks.
- **The policy checks them.** The init domain, or the store's policy, can refuse to grant an endpoint capability between
  domains whose hashes differ. The kernel stays ignorant of types. This is ReadyToRun's verify-at-load idea at domain
  granularity.
- **Sharing code between domains: nothing, by default.** Each domain links its own copy of the runtime. The alternative
  is content-addressed read-only pages: the loader maps identical code pages from one frame. That needs:
  - position-independent code, which we have;
  - page-aligned, self-contained units, in practice the runtime owner from D53, with its mutable state reached through a
    base register or `TPIDR_EL0` rather than PC-relative `adrp`;
  - acceptance of a side channel. Shared physical pages between mutually distrusting domains are what FLUSH+RELOAD-style
    cache attacks exploit (MEMORY: Yarom and Falkner, USENIX Security 2014). D3 already says mutually distrusting code
    never shares an address space, and sharing frames erodes the same boundary.

  So sharing would be opt-in per policy, among same-trust domains, and only if measurement shows the duplicated runtime
  costs real memory. EST: the runtime is tens to a few hundred KiB a domain. M5's test images are 0.26 to 2.1 MB of code,
  but they hold many tests.
- **Plugins and dynamic loading.** A plugin is a domain, started with a capability and spoken to over IPC, never loaded
  into another domain's address space. Code of the same trust that truly needs to be in-process would be a sealed unit
  loaded against its summary, with `abihash` checked, class ids by descriptor (2.4), and the shared runtime. Nothing asks
  for it yet.
- **`eval` and `new Function` (D48, deferred).** Two routes, both at EL0:
  - **An interpreter inside the domain.** It needs no new ABI. It's a big library, and slow.
  - **A JIT.** It needs a capability to turn pages executable, mapped writable then remapped executable, never both. Its
    output calls the program through the sealed ABI, so the JIT is a *client* of section 2. The program has to carry its
    summaries at run time, as .NET carries metadata.
    - `bincheck` can't vet JIT output, so a domain with a JIT has the JIT in its trusted base, which D3 already accepts
      at EL0.

---

## 7. Incremental whole-program builds: the in-world default

The goal: keep every closed-world fact and make rebuilds proportional to what changed. The shape is ThinLTO's (MEMORY:
Johnson et al., "ThinLTO: scalable and incremental LTO", CGO 2017): summaries per module, a cheap global step over them,
then parallel back ends with cross-module imports. GHC adds the fingerprints (3.8).

**Pipeline:**

1. **Per module:** parse and check, then lower to TIR plus a summary. Cache by source hash, plus the `ifacehash`es of its
   imports (TS types flow across modules, so the checker's view of a dependency is an input).
2. **Global step over summaries, not bodies:**
   - escape;
   - can-throw;
   - `overwriters`;
   - the type graph;
   - class numbering;
   - the inliner's call graph with costs;
   - for down-lowering, the flow-class and number-representation fixed point.

   These are fixed points over small per-function records. They must be deterministic and give exactly what today's
   single pass gives (tested by a whole-program build compared byte for byte, as `-O0` against `-O2` is today).
3. **Per function:** optimise and generate code. Cache key: SHA-256 of
   - the compiler hash and options (as 6.3's key already includes);
   - the function's own TIR text;
   - the hash of every fact it *read*: callee summaries it inlined or consulted, layouts it used, the class ids it
     compared against.

   The output is machine code plus abstract fixups (5.1).
4. **Link** with `image.ts` as it is, over cached fragments.

**The hard part is step 2 for down-lowering.** Its walk "repeats until what it knows stops changing" over the whole program
(4.5), and a new flow in one module can change another module's struct layout or turn a `u32` into an `f64`. Two levels of
ambition:

- **Coarse.** Rerun the global step from scratch on every build. It works over summaries, so it's fast, and then reuse
  each function's code if the facts it read are unchanged. Most edits change no facts, so most code is reused. This is
  the right first version.
- **Fine.** Restart the fixed point from the previous solution, and recompute only the strongly connected component of
  modules a non-monotone change touches. It's worth doing only if the coarse version measures slow. Zig's experience,
  incremental compilation still opt-in in 0.14 (3.6), says it's a long road.

**Determinism.** The keys are content hashes, the output is identical to a clean build, and there's no cache of *results*
for tests to trust: D45's rule that only a milestone from `tmk clean` verifies still holds. The cache is a build cache,
not a test cache.

**Sealed units** are then this same pipeline stopped at the unit's edge: summaries exported with promised facts only,
code generated with conservative assumptions about the outside, and a relocatable object written instead of an image.

---

## 8. x86-64, later

The owner wants x86-64 eventually. Nothing above should assume AArch64 outside the backend.

- **Calling conventions.**
  - System V AMD64 (Linux, macOS) passes six integer and eight vector arguments in registers (MEMORY).
  - Microsoft x64 passes four in `RCX`, `RDX`, `R8` and `R9` or `XMM0`–`XMM3` by *position*, so a float in position 2
    uses `XMM1` and consumes `RDX`'s slot. The caller always reserves a 32-byte shadow area. Variadic floats are copied to
    the integer register too. `RBX`, `RBP`, `RDI`, `RSI`, `R12`–`R15` and `XMM6`–`XMM15` are callee-saved. Upper bits of a
    narrow result are undefined. (SOURCE, https://learn.microsoft.com/en-us/cpp/build/x64-calling-convention)
  - Our in-world convention's "8 + 8 in registers" doesn't fit either. Define the in-world ABI per architecture as "the
    first N integer and M float registers of an architecture table", never as x0–x7.
- **What carries over:**
  - The zero-extension invariant, if we pick it on x86-64 too, where 32-bit operations zero-extend for free (MEMORY).
  - The exception flag and the summaries, which are target-independent already (TIR's `ix`).
- **Executables.**
  - ELF x86-64 and PE x64 are the same container code with another machine field and relocation set. So the format
    writers should take relocation kinds from a table per architecture.
  - **Mach-O x86_64 hardly matters.** Apple is phasing Rosetta 2 out from macOS 28 (fall 2027), keeping it only for
    some older games (SOURCE, https://www.macrumors.com/2025/06/10/apple-to-phase-out-rosetta-2/, press coverage of
    Apple's developer documentation, not Apple's page itself). Intel Macs are leaving support too.
- **Unwind information.**
  - ELF x86-64 uses the same `.eh_frame` (DWARF CFI), so that generator is shared.
  - Windows x64 uses `.pdata`/`.xdata` with x64's own unwind codes. Prologues are "highly restricted" so they can be
    described, and leaf functions need none (SOURCE, same Microsoft page).
  - Apple's compact unwind has a different x86_64 encoding (MEMORY).
  - So the unwind generator should be "canonical prologue description → per-format, per-architecture encoder".
- **Testing on this host.**
  - HVF only runs arm64 guests, so an x86-64 guest kernel under QEMU is TCG only: slow, and with no HVF timings for S6 or
    S7.
  - For user-mode binaries: Apple's Virtualization framework (not QEMU) can share Rosetta into an arm64 Linux VM, which
    then runs x86-64 Linux ELF user programs. The guest kernel stays arm64 (SOURCES:
    https://developer.apple.com/tutorials/data/documentation/virtualization/running-intel-binaries-in-linux-vms.md, via
    search, and https://docs.getutm.app/advanced/rosetta/).
  - Whether Linux-VM Rosetta outlives macOS 28's cut wasn't found in any source. Treat it as at risk.
  - Rosetta never runs a kernel. `qemu-x86_64` user mode under a Linux VM is the other route for user binaries (MEMORY).

**Decide now:** relocation kinds, register tables and unwind encoders are per architecture behind one interface. TIR and
summaries never name a register.

---

## 9. Recommendation and phases

### Phase 0: decide now (cheap, and each avoids undoing work later)

1. **The summary format** (2.2): canonical text, two hashes, promised and observed facts. Even before any linking it's
   useful as the `--report` data in machine-readable form, and as the incremental cache's key material.
2. **The runtime owner** (D53): rename and version the runtime's native surface (`__rc_*`, `__exc_*`, `__str_*`,
   `__page_source_use`, `__hash_key_use`) as one ABI with a version. Stop growing module-private state that would have to
   be shared later. In particular, make `__exc_on`/`__exc_val` runtime symbols, not module globals, even while each
   image still has one module.
3. **Canonical boundary representations** (2.3): generalise D32 into a rule for every type that crosses an export.
4. **`Map` and `Set` opaque to native callers** before D47 changes their layout. This is the one existing public layout
   that's about to move.
5. **Frame records on hosted targets:** a backend switch, per target, with the canonical prologue.
6. **Symbol naming with versioned runtime symbols**, and relocations kept abstract and per architecture.

### Phase 1: incremental whole-program builds (host)

The coarse version of section 7: per-module summaries, a global step over them, and per-function code cached by the facts
read. Measure the hit rate on the corpus and on an edit loop over the JPEG decoder.

### Phase 2: hosted executables and C imports

- An ELF static-PIE writer of our own.
- Mach-O objects for the system `ld`.
- `.eh_frame` and compact unwind.
- `@tsl.import-c` and `@tsl.export-c` wrappers per platform (4.1), with the untrusted-import rules (4.2).

This also gives a much faster test loop for code that isn't kernel code: native Mach-O on the host, no QEMU (EST:
milliseconds a case rather than an image boot). That's a D45 question for the owner.

### Phase 3: sealed units

- The `.tslu` unit: relocatable code, summary and inlinable bodies.
- Descriptor-based class identity for `open` hierarchies.
- Load-time and link-time `abihash` checks.

### Phase 4: own Mach-O and PE writers

Only once there's a need not to depend on the system linker, with byte comparisons against Phase 2's output.

### Phase 5: in-OS options

Shared code pages among same-trust domains, an EL0 JIT for `eval`, and in-process sealed units. Each only on
measurement or a real request.

### D-numbers to add

| ID | Decision (default) |
|---|---|
| D51 | In-world builds are incremental whole-program builds with cached per-module summaries. Separate compilation is a distribution mode producing sealed units. |
| D52 | The in-world ABI. The backend's register convention, made explicit per architecture. Canonical boundary representations. `rc` borrowed in and owned out. References as tagged `i64`. Exceptions as a flag test. Summaries with `abihash` and `ifacehash`. Only promised facts count across a sealed boundary. |
| D53 | One runtime owner per image and thread for the `rc` heap and collector, exception state, strings and maps support, page source and hash key. A versioned native surface. |
| D54 | Class identity: preorder ranges inside a closed world, descriptors with a display across sealed units. A crossing class is `frozen` or `opaque`. Open hierarchies use prefix layouts. |
| D55 | Out of world: the platform C convention (AAPCS64, Apple arm64, Windows ARM64). Imports only in unsafe modules, untrusted for every fact. Generated wrappers. No unwinding across C frames. |
| D56 | Executables. ELF static-PIE by our own writer. Mach-O and COFF objects for the system linker first, our own writers later. Frame records and unwind data on hosted targets. |
| D57 | Reproducibility with signing. Witnesses cover unsigned content. Signature, UUID, build-id and timestamps are derived from content. |
| D58 | In our OS, applications are bundled and statically linked by default; a sealed system layer with a frozen in-world ABI may be shared libraries (owner, 2026-11-07). Code sharing between domains is off by default. Plugins are domains. A JIT would be an EL0 client of D52. IPC interfaces are hashed layout-class modules. |

### Risks

1. **The incremental global step isn't cheap enough.** Down-lowering's fixed point runs up to 400 rounds (`MAX_ROUNDS` in
   `down.ts`). If it dominates, incrementality saves only code generation. Mitigation: measure the split first, and keep
   the coarse plan.
2. **Promises freeze too early.** Every `frozen` or `nothrow` in a sealed unit is forever. Mitigation: no sealed units
   until a real consumer exists, which is Phase 3.
3. **Frame records cost speed.** One fewer register in hot code. Mitigation: measure, and keep it per target.
4. **C interop erodes safety claims.** Every import is unchecked trust. Mitigation: unsafe modules, `tmk audit`, and
   generated wrappers, never hand-written ones.
5. **Mach-O details move.** Apple changes `ld` and the fixup formats. Mitigation: rely on the system `ld` until Phase 4.

### Open questions for the owner

1. Is distributing binary-only TSL units a real goal, or is source-only distribution with incremental builds enough? If
   source-only, Phase 3 can wait indefinitely.
2. Should hosted native executables (Phase 2) become a test target, so non-kernel tests skip QEMU? That changes D45's
   numbers.
3. Frame records in our own OS's images: on for debuggability and sampling, or off for the register?
4. Code sharing between domains: is "off, opt-in for same-trust" the right default, given D3?
5. Does `eval` ever need a JIT, or is an interpreter enough? That decides whether D52 needs a run-time form of summaries.
6. Is Windows on ARM a target at all? If not, PE moves past x86-64 in priority, or drops.

---

## Sources

Fetched for this note on 2026-11-07, except where marked MEMORY in the text:

- Swift blog, "Library Evolution in Swift": https://www.swift.org/blog/library-evolution/
- SE-0260: https://github.com/swiftlang/swift-evolution/blob/main/proposals/0260-library-evolution.md
- Swift LibraryEvolution.rst: https://github.com/swiftlang/swift/blob/main/docs/LibraryEvolution.rst
- Swift TypeMetadata.rst: https://github.com/swiftlang/swift/blob/main/docs/ABI/TypeMetadata.rst
- Rust reference, type layout: https://doc.rust-lang.org/reference/type-layout.html
- crABI tracking issue: https://github.com/rust-lang/rust/issues/111423
- abi_stable: https://docs.rs/abi_stable/latest/abi_stable/ ; stabby: https://docs.rs/stabby/latest/stabby/
- Component model canonical ABI: https://raw.githubusercontent.com/WebAssembly/component-model/main/design/mvp/CanonicalABI.md
- ReadyToRun overview and format: https://github.com/dotnet/runtime/blob/main/docs/design/coreclr/botr/readytorun-overview.md,
  https://github.com/dotnet/runtime/blob/main/docs/design/coreclr/botr/readytorun-format.md
- Go internal ABI: https://go.googlesource.com/go/+/refs/heads/master/src/cmd/compile/abi-internal.md ; proposal 27539:
  https://go.googlesource.com/proposal/+/master/design/27539-internal-abi.md
- Zig documentation: https://ziglang.org/documentation/master/ ; 0.14.0 notes: https://ziglang.org/download/0.14.0/release-notes.html
- Itanium C++ ABI: https://itanium-cxx-abi.github.io/cxx-abi/abi.html ; libstdc++ dual ABI:
  https://gcc.gnu.org/onlinedocs/libstdc++/manual/using_dual_abi.html
- GHC user guide, separate compilation and optimisation:
  https://downloads.haskell.org/ghc/latest/docs/users_guide/separate_compilation.html,
  https://downloads.haskell.org/ghc/latest/docs/users_guide/using-optimisation.html ; `ModIface`:
  https://hackage.haskell.org/package/ghc-9.8.1/docs/src/GHC.Unit.Module.ModIface.html
- Microsoft x64 calling convention: https://learn.microsoft.com/en-us/cpp/build/x64-calling-convention
- Rosetta in Linux VMs: https://developer.apple.com/tutorials/data/documentation/virtualization/running-intel-binaries-in-linux-vms.md
  (found by search, not fetched), https://docs.getutm.app/advanced/rosetta/ (found by search, not fetched)
- Rosetta 2 phase-out: https://www.macrumors.com/2025/06/10/apple-to-phase-out-rosetta-2/ (press, found by search)
- AAPCS64: https://raw.githubusercontent.com/ARM-software/abi-aa/main/aapcs64/aapcs64.rst ; ELF for AArch64:
  https://raw.githubusercontent.com/ARM-software/abi-aa/main/aaelf64/aaelf64.rst
- Apple, "Writing ARM64 code for Apple platforms":
  https://developer.apple.com/tutorials/data/documentation/xcode/writing-arm64-code-for-apple-platforms.json
- Windows ARM64 conventions: https://learn.microsoft.com/en-us/cpp/build/arm64-windows-abi-conventions ; ARM64 exception
  handling: https://learn.microsoft.com/en-us/cpp/build/arm64-exception-handling
- Big Sur universal apps release notes (signing):
  https://developer.apple.com/tutorials/data/documentation/macos-release-notes/macos-big-sur-11_0_1-universal-apps-release-notes.json
- QA1118: https://developer.apple.com/library/archive/qa/qa1118/_index.html
- Xcode 13 and 15 release notes:
  https://developer.apple.com/tutorials/data/documentation/xcode-release-notes/xcode-13-release-notes.json,
  https://developer.apple.com/tutorials/data/documentation/xcode-release-notes/xcode-15-release-notes.json
- Mach-O `loader.h`: https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/EXTERNAL_HEADERS/mach-o/loader.h ;
  compact unwind: https://raw.githubusercontent.com/llvm/llvm-project/main/libunwind/include/mach-o/compact_unwind_encoding.h
- Linux stable API: https://www.kernel.org/doc/html/latest/process/stable-api-nonsense.html ; Go FAQ:
  https://go.dev/doc/faq ; Zig overview: https://ziglang.org/learn/overview/
- PE format: https://learn.microsoft.com/en-us/windows/win32/debug/pe-format ; SmartScreen:
  https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- Go ad-hoc code signer: https://go.googlesource.com/go/+/HEAD/src/cmd/internal/codesign/codesign.go
- SOURCE_DATE_EPOCH: https://reproducible-builds.org/specs/source-date-epoch/ ; lld: https://lld.llvm.org/
