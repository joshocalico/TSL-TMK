# The pipeline: ordinary TS → TSL → TIR → output

Status: phase 1 built (`tmk milestone pipe-a`); phase 2's first step built (`tmk milestone pipe-b`: memory modes as
desugarings, `@tsl/gc`, handles and TSL3009), and classes (D64); zeroed construction and one TSL module per source module
(`tmk milestone pipe-c`, D65); arrays as `@tsl/std`'s `JsArray` (`tmk milestone pipe-d`, D66), the default in `leak` and
`manual` since their growth was made as fast (pipe-e); strings as `@tsl/jsrt`'s `JsString` (D67, step 8.2, pipe-f), printed with
classes forced and not yet `auto`'s choice, being 1.0 to 1.4× the direct route; exceptions desugared by the printer (D68, pipe-g),
with classes and strings forced; pipe-h closed most of the gaps of both (unit chunks that grow, `strHash`, a 56-byte `Dyn`, strings 1.0 to 1.25× the direct route), and neither is `auto`'s choice yet; variable-length tails on TSL classes (D69, pipe-tails) give a flat string one allocation, and strings are still 1.02 to 1.25× (short joins by the bytes a flat string's 32-byte header allocates, appends by checks spread over the path); closed-world interface dispatch (D70, pipe-dispatch) and the append fixes are in, and the flat/view split they're for (pipe-split), which made short joins faster and the rest slower, so strings stay forced-only; printed TSL runs on V8 and JSC, `@tsl/lowered` simulated on the host, held to native by the differential's third route, trap codes named by `@tsl/core`'s `Trap` (TSL1026), and `JsArray` in `@tsl/jsrt` (v8route, D71, section 3); `Map` and `Set` as `@tsl/jsrt`'s `JsMap` and `JsSet` (D72), printed with classes forced and not yet `auto`'s choice; string keys since strkeys, `keyHash` and `keySame` reaching `JsString`'s `hashKey` and `sameKey` through its class id, and number-keyed and object-keyed maps judged on benchmarks of their own and still 1.05× to 1.25× the direct route, so not switched; `assert`'s code under TSL1026, and `optIndex`, `loadAt` and `storeAt` deleted; the rest of phase 2 decided in shape and not built; the backend round B3 (D75: global access, branch threading and fusion, rematerialisation, loop layout, and -O1 inlining of small leaves in loops) helps both routes, narrows strings and maps against the direct route without bringing either under the speed rule, and switches nothing in `auto` (M5's B3 record). Decisions D62 to D68 in
SPEC.md. About 20 minutes to read.

## 0. Phase 2: what the owner decided, 2026-11-09

Phase 1's TSL is TIR in TSL syntax: untyped `Ref`, `load<f64>(this_, 0)`, `alloc(16, …)`, behind E1 to E11. Phase 2 makes the
lowering emit idiomatic TSL, desugared from the TS itself, in this shape:

1. **Classes stay TSL classes.** A hierarchy is one class: base fields first, a class-id field, dispatch through switch
   functions, `instanceof` an id comparison or a range for a subtree. A class with no inheritance prints as a plain TSL class,
   with `new` and `this.x`, never byte offsets.
2. **Escaping closures** are an environment class per closure kind, a kind tag and a call switch over the known lifted
   functions; a mutated capture is a shared cell class; each loop iteration gets its own environment. A closure that doesn't
   escape stays TSL's own, where TSL allows it.
3. **Exceptions** are a flag check after each call that can throw, and labelled blocks with a completion code for `try` and
   `finally`, desugared by the printer, not by down-exc.ts, so the two routes have their own implementations to compare.
4. **Memory modes are desugarings onto TSL (D63).** `strict`: nothing escapes without a library (`Slab`, `Vec`, arenas, `Rc`).
   `leak`: a plain `new` from a never-free allocator. `manual`: a plain `new` and `unsafeFree`. `rc`: sugar for `@tsl/gc`'s
   `Rc`, which tslc desugars into exactly the `make`, `share`, `take`, `replace` and `drop` calls a person could write, and
   `--emit tsl` can show. One counting implementation, the library's. Section 4 below.
5. **Loop versioning** with overflow-reporting intrinsics, and better ranges for fields and offsets: the JPEG decoder back to
   about 0.81x V8 from about 1.25x (section 8).
6. **Strings, `Map`, `Set` and `unknown`** as TSL runtime classes (`Str`, `JsMap`, `JsSet`, `Dyn`) with JS's semantics in
   TSL, and `compiler/rt` going through this same pipeline.

And three rulings on what that needs:

- **No lowered layout.** Objects take TSL's own layout rules: a `bool` takes TSL's size (1, where the lowering's is 4), a
  typed-array field becomes a field of a TSL runtime class holding the pointer and length (`F64Array` and kin), and a
  nullable scalar field becomes two fields, a `bool` flag and the value. D36's published native layouts change to match,
  since nothing has shipped. Every layout that moves is to be listed when it's built. Only if that measurably costs speed or
  breaks something does it go back to the owner, with numbers. R5 kept D36's layouts for what crosses an export and padded TSL's
  classes to them; R6 followed the ruling instead: D36 is TSL's own layout (a `bool` a byte, an optional scalar a `bool` flag
  then its value), the padding is gone, and every pin it moved is listed with why (SPEC M5's R6 record, `tools/r6-pins.ts`).
- **Null checks stay on.** Every printed file stays legal strict TypeScript (3.10's refinement rule). The printer emits
  narrowing where the source had it (`const n = p.next; if (n !== null) { … }`), and `!` only where the lowering proved a
  value non-null and no narrowing form exists; tslc and the optimiser have to remove the checks that are proved, so the speed
  rule still holds, and if they can't, that's reported, not worked round by turning checking off.
- **Placement by tslc.** No annotation beside `new`: tslc's own escape analysis says stack or heap, as TSL already does, and
  the package's mode says what heap means. The call arena is retired for lowered code if measurement shows no speed loss;
  if it costs speed, the smallest TSL-level form is proposed, with numbers. R6 built that form: tslc places what no export
  call outlives in a per-call region, the call arena given back at each export's return, since with the heap alone a
  churning call ran out of memory where the direct route doesn't (SPEC 4.5's "The per-call region", M5's R6 record).

- **Printed TSL runs on V8 (owner, 2026-11-19, D71).** Every TSL file does (SPEC 2.2), lowered ones included: `@tsl/lowered`'s
  words are simulated on the host, and the differential's third route runs each printed program on V8 and JSC against native
  and the source on V8. A printed program that can't run on V8 doesn't count as switched over, whatever its speed.
- **-O0 is exempt from the speed rule (owner, 2026-11-15, D44).** -O0 means no optimisation. A feature switches to the
  TSL route when every benchmark on it is no slower than the direct route at -O1 and -O2; what it costs at -O0, where
  nothing is inlined and a class's methods are calls, is measured and said, and decides nothing.

The order, each step leaving the gate green: the modes as desugarings with `@tsl/gc` (first step, built); classes and
inheritance (second step, built, and the default in `leak` and `manual` once its cost was recovered in TSL proper;
section 9); exceptions; closures; `rc` builds through `@tsl/gc`; loop versioning and ranges; the runtime in TSL. A feature
switches to the TSL route only when the dual-route differential agrees on every case it applies to, natively in every mode
at -O0 and -O2, its printed programs run on V8 and agree there (the third route, D71), and no benchmark on it is slower at
-O1 and -O2 (-O0 is exempt, above).

## 1. What changes, and what doesn't

Until now down-lowering (`compiler/host/down*.ts`) walked ordinary TS with the checker's types and built the typed tree that
tslc's own elaborator builds from TSL, then lowered that tree straight to TIR. TSL was never written down. The owner always
meant the route to be TS → TSL → TIR, so that TSL is the one language everything below the front end compiles, the
lowering's output can be read, checked and diffed, and the kernel's language and user space's are the same thing at two
levels of restriction.

The new route keeps the lowering's analysis and moves its output:

```text
ordinary TS --down.ts (types, numbers, escape, layouts, can-throw: analysis and desugaring)--> lowered tree
            --emit-tsl.ts (print)--> TSL package ("lowered" in its tsl.json)
            --tslc (parse, check, elaborate)--> typed tree --lower.ts--> TIR --> optimiser --> backends
```

The direct route, lowered tree → TIR, stays as the reference until everything has moved, and `tmk milestone pipe-a`'s
dual-route differential runs both on every program the new route takes. `tmk lower --emit tsl` prints the program;
`--route direct|tsl|auto` picks the route, and `auto`, the default, takes the TSL route wherever the printer printed the
program exactly (below), and falls back to the direct route rather than fail.

Phase 1's rule for the printer is that each construct prints as the TSL that tslc elaborates back into the *same node* of the
typed tree. So what tslc reaches is the TIR the direct route reaches, byte for byte, wherever the printer could print the
tree exactly, and that is checked: every program printed exactly gives identical TIR at -O0 and -O2. Where the printer had to
reshape something, a loop whose condition has statements in it or an operand moved past a statement-expression, the TIR can
differ, so those agree on every case in the differential but stay on the direct route by default until that difference is
shown not to cost anything. Identical TIR is identical machine code, so for what switched over the switch can't change a
result or a time.

## 2. Each lowered feature in TSL

The owner's rule: desugar into TSL wherever possible, and extend TSL only where desugaring can't express something correctly
or fast enough. Phase 1 desugars what it can, and where it can't yet, says so with a call into `@tsl/lowered` (section 3),
each of which is one node of the tree the lowering already built, so nothing new is meant by it.

**Numbers.** A `number` location's representation is its declared TSL type: `i32`, `u32` or `f64`, decided by the lowering's
range facts (4.5). An integer operation the lowering proved stays in range has no overflow check, and prints as
`wrap<i32>(a + b)`: TSL proper says the same with `(a + b) | 0` or `Math.imul`, which -O1 folds to the same instruction, but
costs an `or` at -O0 and has no spelling for `usize`. An operation whose range isn't proved is `f64`, exactly as JS computes
it, and prints as `f64` arithmetic. Conversions the lowering proved exact print as `cast<T>(x)`; int to `f64` is TSL proper's
`toF64`. Literals carry their type where TSL would otherwise give them one by context (`cast<usize>(16)`), and two literals
in one operation are typed so tslc doesn't fold what the lowering didn't, which would change -O0's TIR.

**Control flow.** `if`, loops, `switch`, labels, `break` and `continue` are TSL proper. A statement-expression (the lowering's
`blockexpr`, from an inlined callback, `a.pop()`, a destructuring) prints as a comma expression when its statements are
plain assignments, with its temporaries declared at the top of the function, and otherwise as statements before the
statement that holds it, with earlier operands evaluated into temporaries first so nothing runs out of order. A loop whose
condition needs statements becomes `while (true) { …; if (c) {} else break; … }`, and a `for` whose step does becomes a
block, a `while (true)`, and a labelled block for the body, so a `continue` breaks to the step. A variable the lowering
declares on two paths, or reads after the block that declared it, is declared at the function's top.

**Typed arrays.** A view, `(pointer, length)`, as in TSL. A read with `!` is TSL's checked read. JS's out-of-bounds write is
a no-op, so it's already `if (i < a.length) …` in the tree. Allocating one in a function, which TSL bans (TSL1001), is
`pack<Uint8Array>(alloc(...), n)` in phase 1. **R9** (SPEC M5's R9 record): class printing makes it as TSL does, a view of
an object's storage: `new Int32Array_8().items` (a layout class's `array(i32, 8)`) for a constant length up to 64 KiB and
`withTail(n, new Float64Array_n()).items` (a tail, D69) for any other, placed by tslc (the stack where escape analysis
allows, else the heap, and the per-call region where no view outlives the export call); module state that's a typed array
is R7's runtime class in a static object; arrays of booleans and of nothing are `JsArray<u8>`. Forced only (`AUTO_R9`).

**Objects, vectors and module state.** The lowering's flow classes have layouts it chose and `DownMeta` publishes (D36).
Phase 1 prints their fields as `load<f64>(p, 8)` and `store<f64>(p, 8, v)`, an allocation as `allocStack`, `alloc(size, zero,
"__alloc")` (the call arena) or the mode's allocator, a vector through the runtime's `__vec_*` functions, and module state as
`const g = data(16, "g.counter")`. This is the part that is unsafe in phase 1, and the next phases replace it (section 3, E3).

**Exceptions (D49) become flag globals and labelled blocks with a completion code.** `down-exc.ts` already does exactly
this, before the tree is printed, so the printed TSL has `__exc_on` and `__exc_val` as module state, a test after each call
that can throw, and a `try` as labelled blocks and a completion code: TSL proper control flow, which phase 1 prints, so the
exceptions corpus goes through TSL. Phase 2 moves the desugaring into the printer, so the two routes have their own
implementations and the differential compares them, and that's when the injected `finally`-order bug has something to
catch: today a bug in `down-exc.ts` is in both routes alike.

**Inheritance (D50) becomes one flattened class with a class id and switch dispatch.** Also already in the tree, and printed
as a `switch` on `load<i32>(p, 0)` with a direct call in each arm, a range test for `instanceof`, and the derived
constructor calling the base's. `corpus/lower/pipe/class_dispatch.ts` runs it through both routes, and the injected
wrong-arm bug is caught (pipe-a box 5).

**Closures become lifted functions and environment classes, and a stored or escaping function value is a tag and a switch
over the known lifted functions.** A closure that's known is already inlined or lambda-lifted. The direct route's value form
is an environment `[code pointer][captures]` and `call.indirect`. In a closed world every function value's targets are a
fixed point the lowering already computes (`cloOf` in down.ts: the lifted functions per function flow class), so the printer
can give each lifted function of a flow class a small integer, store that instead of a code pointer, and print a call as a
`switch` on it with a direct call in each arm, as class dispatch is. That's TSL proper apart from the environment's layout,
it lets every arm inline at -O2, and a single-target flow class needs no switch at all. Two costs to measure before it's the
default: a flow class with many targets is a long switch where `call.indirect` is one instruction, so above some count
(proposed: 8 arms) a jump table, which TIR already has for `switch`; and the native ABI returns a closure as a pointer to its
environment with its code at offset 0 (4.5), so the tag goes in the first word and a native caller calls through an exported
`__closure_call$N` per flow class instead. **Built in R3** (SPEC M5's R3 record): an environment class per flow class with a `kind` field and a `call` method testing it, each arm a direct call (no jump table yet); in `rc` only when the route is forced, as `AUTO_RC` is off, and in `leak` and `manual` only with `TMK_EMIT_CLOS=1`, as the TSL route doesn't free environments where the direct route's call arena does. R5 found that's not about environments: `cyc_churn.ts`'s functions with no closure run out through the TSL route too, as it has no call arena at all; the fix proposed is tslc placing in the call arena what its own escape analysis finds bounded by the export call (SPEC M5's R5 record).

**`unknown` becomes a tagged value.** It is one already: a pointer to a class instance, whose first word is its class id, or
to a box of a primitive, which is a class like any other in `compiler/rt/exc.ts`, or null for `undefined`. `typeof`,
`instanceof`, casts and now truthiness are tests of the id. The falsy bug (section 7) was that truthiness tested the pointer.

**Strings, `Map` and `Set` (D42).** These are `compiler/rt`, ordinary TS lowered into the module, so they're already in the
tree like the program's own code, and print like it. A literal is static data with a header the lowering lays out, and
prints as `const strlit_0 = text("…", "__strlit_0")`, which tslc lays out by the same function the lowering uses, so the text
is in the TSL; the one-unit strings and the hash key are `charTable()` and `hashKey()`. The string, hash and exception
runtimes are named in the lowered package's `"runtime"` for tslc to link. With classes (step 8.2, D67) a string is
`@tsl/jsrt`'s `JsString` instead, section 9, and (D72) a map `@tsl/jsrt`'s `JsMap` or `JsSet`, map.ts in TSL, with a number key
held as its bits (`jsNumKey`), so `keyHash`'s integer compare is SameValueZero, and a string key a `JsString`, whose
`hashKey` (D42's keyed HalfSipHash, kept in its hash word) and `sameKey` (its units) `keyHash` and `keySame` reach through
its class id (D70, strkeys).

## 3. What TSL gains

All of it is fenced: only a package whose tsl.json has `"lowered"` can import `@tsl/lowered` or use its forms (TSL1023), and
`tmk lower` is what writes one. Nothing a person writes is lowered, the kernel's packages say `noStd` and `strict`, and a
`"lowered"` block with any other package setting beside it is an error. Each extension below, with why desugaring wasn't
enough, for the owner to judge one by one.

| | Extension | Why desugaring isn't enough | Phase |
|---|---|---|---|
| E1 | The `"lowered"` package setting and the `@tsl/lowered` module | The fence everything else hangs on | Stays |
| E2 | `Ref`: a pointer with no generation, compared by address | TSL's references are 64-bit with a generation checked on a load from memory (3.5). A lowered object is never freed while anything reaches it (`leak` never frees, the call arena outlives the export call, `rc` frees at zero), so the check would be dead weight, and the published layouts (D36) have 8-byte pointers | Phase 1; goes as lowered objects become TSL classes (phase 2's classes step) |
| E3 | `load`, `store`, `alloc`, `allocStack`, `elemAddr`, `loadElem`, `storeElem`, `data`, `addr` | TSL's classes have its own layout rules, no typed-array fields (TSL1001), no escaping stack references and no call arena. Desugaring objects into TSL classes needs lowered classes (E3′ below) first. **This is the unsafe part** | Phase 1; replaced by TSL classes, not by lowered classes (section 0) |
| E3′ | Lowered classes: `/** @tsl.lowered */ class P { x: f64; y: f64 }`, laid out by the lowering's rule (fields in order, natural alignment), references being `Ref`s, placement chosen by which allocation makes them | What replaces E3, so that field access is checked by tslc and the printed program reads like the TS it came from. Not desugaring: TSL proper's layout rules and reference representation are different on purpose (3.4, 3.5) | **Rejected by the owner, 2026-11-09:** TSL's own layout rules instead, D36's published layouts changing to match (section 0) |
| E4 | `wrap<T>(a op b)`: integer arithmetic with no overflow check, any integer type | TSL's wrap contexts are `| 0`, `>>> 0` and `& K` on 32-bit values (3.3 rule 7), which say "JS wraps here", not "proved in range", and none exists for `usize` | Stays |
| E5 | `cast<T>(x)`: a conversion the lowering proved exact | TSL's `toI32` and kin check, which is a cost and a different TIR. `toF64` is used where it's the same | Stays |
| E6 | `Opt<T>` as a value in a local or a field | TSL allows a nullable scalar only as a function's result (3.3 rule 12); lowering keeps them in locals and fields (`a[i]` that's tested later, an optional field) | Stays |
| E7 | `pack<T>` and `part<T>`: a value from its leaves, and leaves of a value | A typed array the lowering allocated is a pointer and a length; a nullable scalar is a flag and a value | Shrinks with E3′ |
| E8 | `rt`, `intrinsic`, `builtin`: calls into the lowering's runtime (TIR, `down-rt.ts`) and to TIR intrinsics | The runtime is TIR today. Moving it into an audited TSL package (`manual`, listed in `unsafeModules`) is section 9's last step | Shrinks |
| E9 | `throwJs`, `trapNow`, `nonNull`, `f2ix`, `unreachable` | JS semantics on trap paths with their messages (4.5's native `throw`), a null test that traps 6, an index from a double, and a function end tsc can't prove unreachable | Stays |
| E10 | `@tsl.symbol name` and `/*@ file.ts:3:9 */` | The lowering's symbols aren't all identifiers (`Acc.add`, `g.counter`), and a trap should name the TS it came from. Tooling, no meaning | Stays |
| E11 | `text("…")`, `charTable()`, `hashKey()` | Static data with a layout the lowering chose (a counted header that can't reach zero, then UTF-16), which TSL proper has no literal for: TSL's run-time strings are `Str` in `@tsl/std` (3.6). Desugaring into bytes would hide the text | Stays |

**On the host (D71).** Every word above runs on V8 and JSC now, as `@tsl/unsafe`'s do, so printed TSL keeps the refinement
rule; none is native-only. Phase 1's printing, which prints whatever class printing can't take, still uses most of them;
`optIndex`, `loadAt` and `storeAt` it couldn't, and they're deleted (D72): the lowering never makes an `optindex`, and a load
or store whose leaves aren't its type's own is a printing refusal, which no program in the corpora reaches (598 printings of
230 programs, phase 1 and classes, used none of the three before). How each runs:

| Word | On the host |
|---|---|
| `Ref`, `Opt` (types) | A number, an address in the simulation; a nullable scalar is its leaves, a flag and a value |
| `load`, `store` | Cells: each allocation a block, each stored value kept at its offset as the JS value it is, read back by a load there; never stored reads as zero. A type argument is erased on the host, so bytes can't be used; leaves listed are read and written one by one |
| `alloc`, `allocStack`, `data`, `addr` | A new block (a frame slot is one too, and the host's memory is the host's); `addr` of a runtime global, a block by its name |
| `elemAddr`, `loadElem`, `storeElem` | Address arithmetic; an element by its named type, kept as a store of that width keeps it; a typed array TSL proper made is its own storage, at an address of its own |
| `pack`, `part` | Leaves; a pointer and a length is a typed array view that TSL proper indexes (`a.length`, `a[i]!`), its element type the block's, learned from the elements read and written |
| `cast`, `wrap`, `f2ix` | `wrap` is JS's own arithmetic, which it is in the source; `cast` the value, or for an integer conversion the target it's printed with (`cast<usize>(i, "usize")`), or for `"opt"` TSL proper's `V \| undefined` as a nullable scalar's leaves (D72's `JsMap.get`); `f2ix` the index or past every length |
| `rt`, `intrinsic`, `builtin` | The call arena's start and commit (nothing) and down-rt.ts's vectors; `mem.copy`, JS's `Math`, `native.sp` (never below the limit: V8's stack is the host's, divergence 14); `assert`, `fptosi.sat`, `toI32`, `wrapI32` and the bit operations on doubles TIR has |
| `text`, `charTable`, `hashKey` | D42's static data, laid out in cells as down.ts lays out the bytes |
| `nonNull`, `trapNow`, `unreachable`, `throwJs` | `TslTrap` 6 and the code given; an error (it can't be reached); what the native trap path reports, a JS error of the constructor named or the uncaught value described |
| `isUndef`, `optPayload` | A nullable scalar's leaves, read |

The simulation runs out, trapping 14, past 128 MiB of simulated bytes or 4 million stored values, which keeps a process under
its 3 GiB watchdog (divergence 4).

## 4. How `rc` is expressed in TSL

**Decided by the owner, 2026-11-09 (D63): a memory mode is a desugaring onto TSL, and `rc` is sugar for a library.** Phase 1
proposed a hidden tslc mode that would run down-rc.ts's pass on lowered packages, so that no count is ever written in TSL. The
owner chose the opposite: the counts are explicit TSL, calls into `@tsl/gc` that a person could have written, and tslc's
desugaring of an `rc` package writes them, so `--emit tsl` can show them. One counting implementation, the library's.

**Built (pipe-b).** `@tsl/gc` (`packages/tsl-gc`, one audited unsafe module, SPEC 3.5's `// file: ex-gc-rc.ts`):

```ts
import { Rc, type Counted } from "@tsl/gc";

class Node {
  next: Counted<Node> | null = null;
  constructor(public v: u32) {}
}
function releaseNode(n: Node): void {
  const next = n.next;
  if (next !== null) nodes.drop(next);
}
const nodes = new Rc<Node>(releaseNode);

export function push(head: Counted<Node> | null, v: u32): Counted<Node> {
  const n = nodes.make(new Node(v)); //                      count 1
  n.next = head === null ? null : nodes.take(head); //       head's count moves into the field
  return n;
}
```

`Rc<T>` is a store per class, as `Slab<T>` is: TSL proper has no generic static methods, so `Rc.make` is `nodes.make` on a
store the program names. `Counted<T>` is a reference into one of its slots with the `Slab` prefix, so it carries the slot's
generation and every stored-reference rule holds. `drop` to zero queues the object through its own slot; each `make` frees up
to `RC_BUDGET` (32) of them first, calling the store's `release` on each; `collect` frees everything waiting.

**The safety argument, as built.** No `unsafe` in a program using it. A copy of a handle made without `share` holds no count:
once the object goes, using it from memory traps 5 (the generation), and a stale local reads stale, well-typed data, 3.10's
divergence 5, as for `Slab`. A missing `drop` is a leak, which is safe. A use after `drop` or `take` doesn't compile: a type
alias tagged `@tsl.handle` is a handle type; a `@tsl.moves` parameter of a handle type consumes the caller's local; reading it
again before it's assigned, on any path, is TSL3009 at the read (`compiler/host/consume.ts`, a may-analysis over each
function's statements, loops to a fixed point). What `@tsl.moves` meant for a class-typed parameter, copy an object into place
from a direct `new` (TSL3006), is unchanged.

**What TSL itself gained:** the `@tsl.handle` tag on a type alias, the consuming meaning of `@tsl.moves` for a handle-typed
parameter, and TSL3009. Nothing else.

**Built since (R1, SPEC D74):** (1) and (3) below, and `WeakRef`. tslc expands an `rc` package's plain classes and `new` into
these calls (`compiler/host/expand-rc.ts`), with a store, a release function and a stepping function per class declared beside
it, borrows where nothing in a local's region can give up a count, and `tmk compile --emit tsl` printing the expansion. The
library frees D39's way: a release function visits one slot a call, a store keeps a cursor in the object it's freeing, every
allocation spends its budget across every store with work (each registered by a `StoreLink` placed in heap memory, as TSL
proper has no bound methods and no generic function values), and everything waiting is freed before an allocation gives up.
`new WeakRef(x)` is `@tsl/gc`'s `Weak<T>`: a slot and generation, no count, `undefined` from count zero. Tested in
corpus/rc on V8 (as written and expanded), JSC, HVF and TCG at -O0 and -O2, with five injected bugs caught (`tmk milestone
pipe-d` boxes 20 and 21). Left: (2), D41's collector, and (4), which is R2.

**Since (R1b, SPEC D74):** one counted heap of size classes every class shares, in place of a pool per class; no stepping
function and no `StoreLink` (freeing finds each store's release function in a table, through the slot's prefix, now that a
function value can be written to raw memory, which R1 couldn't do: a compiler bug, fixed); counted objects kept in their
package, and with that no generation checks on what the expansion counts (SPEC 3.5's proof). The list and churn went from 1.34x
and 2.12x the direct route to about 1.05x and 1.1x.

**Since (R1c, SPEC 3.5, D41):** D41's cycle collector is in `@tsl/gc`, in TSL, for `rc` packages and hand-written `Rc` users
alike. The type graph is a constant per class, `cycleGroup<T>()`, from tslc's graph of classes and their fields (a table by
class name on the host), so a class in no cycle has no barrier and a program with no counted class in a cycle never reaches the
collector: at -O1 and -O2 it reaches exactly the code it did before. A scan's state is in the slot prefix's spare bits, visits go
through the release functions' `op`, the barrier is in the count operations and in the expansion's vector moves, the budget is
shared with freeing (D39's bound and its pinned step counts unchanged), and exhaustion walks chunks each size class's fresh slots
are cut from. Tested by D41's corpus ported to TSL (`corpus/rc/cyc_*.ts`), random TSL programs with cycles, the latency port, and
six injected bugs (`tmk milestone pipe-d` boxes 22 and 23). Left: (4), R2, built since (below).

**R1d (SPEC 3.5, D41, D63, D73):** the collector's cost, before R2. Release functions are a closed set, those named at
`new Rc<T>(f)`, called by a comparison of the store's number for one and a direct call (`callRelease`, D70's form), so nothing
calls through a function pointer. The wait after a fruitless scan no longer goes 16 times faster below 16 candidates, which made
churn scan every 32 allocations (2.03x the direct route, now 1.17x); the cycle churn tests forbid the heap walk, so pacing that
falls behind traps 14. A TIR pass removes functions and globals nothing reaches from a module's exports and the runtime's `__`
names, at -O1 and -O2 for tslc's modules, so an acyclic program carries no collector. Measured and not kept: freeing one object an
allocation with the collector linked (the direct route's phase-E rule), which helped the list and hurt churn, and ran
corpus/rc/rc_shared.ts out of memory, as a scan holds a list being freed that it has joined. M5's R1d record has the numbers.

**R1e (SPEC 3.5, D39, D41, D74):** a scan gives up an object whose count reaches zero before it decides: the object goes on the
freeing queue like any other and the scan passes over it, and the scan decides nothing until freeing has dropped every reference
the object held, since the scan had already counted those as edges (3.5's argument, case (6): without that wait it isn't sound,
and an injected bug shows it). With that, `@tsl/gc` frees one object an allocation with the collector linked, as the direct route
does, and corpus/rc/rc_shared.ts completes. The direct route had the same latent fault, shown by corpus/lower/rc/rc_shared.ts, and
is fixed the same way. The scan finds a release function once an object, and the candidate table's operations are inlined; an
inlined `make` fast path was measured and not kept. M5's R1e record has the numbers.

**R1f (SPEC 3.5, 4.3, D41, D74):** where the collector's time went, found with a profiler (`tmk profile`: the guest's program
counter sampled through the QEMU monitor for time, and every translated block QEMU runs counted for exact instructions), after
two guesses (the indirect release call, the per-slot reloads) had been wrong. Most of the gap was TSL's code for the slot
prefix's arithmetic: `% 0x100_0000` compiled to a division, `>> 32n` and `<< 32n` on a `u64` to a guarded variable shift, and a
checked `<<`'s test for lost bits kept where the value is masked. The optimiser now reduces those, for every TSL program. The rest
was in `@tsl/gc`: freeing's loop for the one object an allocation frees (now `quickFree`, the same two steps), a call after each
allocation to a collector with nothing to do, generation bits checked on references counted exactly, and the phase dispatch
(most frequent first, inlined, with `setNext` and `nextOf`). Steps and step counts are unchanged. M5's R1f record has the numbers.

**R2 (SPEC D72, D74):** lowered `rc` programs build through the TSL route when it's forced. The printer prints the lowered tree
before down-rc.ts counts it, with classes, in a lowered package whose mode is `rc`, and tslc expands that package as it does any
`rc` package's: the counts are `@tsl/gc` calls it adds, which `tmk compile --emit tsl` shows. What the expansion counts it counts in a
statement of its own, so the printer's `rc` form puts a reference made, held, stored or given by a call in a statement of its own,
and prints a copy as what it copies where nothing reassigns either, so no share and drop is spent on it. Arrays and maps are held
in place by classes of the program's own, `JsArr_C` and `JsMap_K_V`, counted as any class is; their elements, keys and values
are counted by the expansion, through JsMap's `put`, `cut` and `entryAt`, which hand back what the map stops holding (slot clearing,
as the direct route's `__v_clear`), and freed a slot or a position a step. Strings, exceptions' `unknown`, closures as values,
`WeakRef` and a program of several modules with arrays or maps still take the direct route. M5's R2 record has the coverage, the
speed table and the injected bugs; `auto` doesn't take it (`AUTO_RC`), as churn and arrays are slower than the direct route.

**Not built, in order.** (1) The `rc` mode as tslc's desugaring of plain classes and `new` in an `rc` package into these calls,
with borrow elision as a handle passed without `share`, which the move checking has to prove sound. That needs the classes
step first: lowered objects have to be TSL classes before tslc can count them. (2) D41's collector inside the library, with
its barrier on `share` and `drop` of a type that can be in a cycle (built, R1c). (3) D39's per-slot freeing steps: the library's step is one
object and its `release`, where D39's is one reference slot, so a freed 1,000,000-element array is one step, not a million;
to match, `release` becomes incremental. (4) Lowered `rc` builds switched to the TSL route, only when every `rc` benchmark
(memory, strmap, exc, maps) is no slower than D39's heap by the direct route.

## 5. The lowering's analyses become the TSL it emits

| Analysis | Today | In the TSL |
|---|---|---|
| Number representation (4.5) | A type on every location | The declared type: `let s: f64`, `i: i32`; `wrap` where a range is proved |
| Escape and placement | `alloc` with a stack slot, the arena or the mode's allocator | `allocStack`, `alloc(…, "__alloc")` or the mode's; with lowered classes, `new` with a placement tag |
| Can-throw (D49) | Which calls are followed by a test of `__exc_on` | The test itself, printed |
| Borrow elision (D39) | down-rc.ts, on the finished tree | The same pass in tslc on the elaborated tree (section 4) |
| Layouts (D36, D50) | `layoutOf` over flow classes | Field offsets now; lowered class declarations next, whose field order is the layout |
| Class ids and dispatch (D50) | Preorder ids, switches | Printed as they are |

## 6. TIR-level tricks

*The `keep` rule (4.3).* The optimiser keeps a load that -O0 used, so a fault that -O0 takes is taken at every level. It works
from -O0's TIR, so it survives as long as -O0's TIR is the same, which the printer is built to keep: a read of a variable
whose value nothing uses is still printed, because in the direct route that read is what makes a merge carry the value of a
load (found by the differential: `pushPop`'s discarded `a.pop()`).

*The collector's barrier (D41) and borrow elision (D39).* For TSL proper both are tslc's now: borrow elision in the `rc`
expansion (R1), and the barrier in `@tsl/gc`'s count operations and the expansion's vector moves (R1c). Lowered `rc` packages
get both when they take the TSL route (R2); until then down-rc.ts's pass is what lowered code has.

## 7. The falsy `unknown` bug, fixed first

`if (e)` on an `unknown` tested the pointer, so a boxed `false`, `0`, `-0`, `NaN` or `""` was truthy, where V8 says falsy.
Truthiness of an `unknown` is now `tmkDynTruthy` in `compiler/rt/exc.ts` (a version with no string case where the module has
no run-time strings, as no string can be boxed there). Regression programs: `corpus/lower/exc/dyn_truthy.ts`,
`dyn_truthy_nostr.ts` and `dyn_truthy_param.ts`, every falsy value and a truthy one of each kind through `if`, `!`, `&&`,
`||`, `?:`, `Boolean()` and a loop, against V8, in `rc`, `leak` and `manual`; the parameter program also through the new
route. Each fails with the fix taken out.

## 8. Performance through the new route

The owner's requirement is that nothing switches over until every benchmark on it is no slower. Where the TIR is identical
the machine code is, so the measurement is the TIR comparison itself, and the benchmark numbers are taken both ways anyway
(SPEC M5's pipeline record). Today: the JPEG decoder lowers through the new route to the same TIR at -O2 as the direct route
(2,568 lines of TSL, 645 of them memory operations); S4, `@tsl/alloc` and `@tsl/std` are TSL proper and never went through
lowering; `rc`'s benchmarks (memory, strmap, exc, maps) don't take the new route yet.

**Loop versioning, the recovery.** The maps step made a loop's integer arithmetic `f64` where its range isn't proved,
because a checked `i32` trapped where JS gives a result. The fix is a loop in two copies: an integer one in which each such
operation is done in `i32` with an overflow test, and an `f64` one; the integer copy's overflow branch carries every live
variable, converted, into the `f64` copy, which continues at the same point. In TSL proper that's: the integer copy computes
`r = wrap<i32>(a + b)` and tests `((a ^ r) & (b ^ r)) < 0` (both operands' sign differs from the result's), for `*` compares
`Math.imul` with the `f64` product; the overflow arm assigns the `f64` variables and `break`s to a labelled block that
enters the `f64` loop's body at the same statement, which is a `switch` on a resume point if the loop has more than one
overflow site. Nothing new in TSL. The integer copy is chosen statically where a loop's integer variables are those the
lowering made `f64` only because of a possible overflow, and only for loops; the second copy doubles a loop's code. Not
built in this phase: the new route has to carry the decoder first, which it now does.

**Better ranges.** The decoder's checked operations are mostly offsets and fields such as a bit reader's position, which the
analysis can't bound because a field is one location for the whole program. Two additions, both in down.ts's fact
propagation: a field written only from expressions bounded by a typed array's length (a position into its buffer) gets that
bound, since lengths are below 2^31; and a field whose every write is `x + k` guarded by a comparison with a bounded value
gets the guard's bound. Proposed with versioning.

## 9. The switch-over order

Phase 1's order, as revised by section 0 (owner, 2026-11-09). Each step leaves the gate green.

1. **Built (phase 1):** `strict`, `leak` and `manual` programs without closure values: scalars, typed arrays, objects,
   vectors, module state, inheritance, strings, `Map`, `Set` and exceptions. The default route where the printer printed it
   exactly.
2. **Built (pipe-b):** the memory modes as desugarings (D63): `@tsl/gc`'s `Rc`, handles, `@tsl.moves` consuming a handle,
   TSL3009.
3. **Built, and the default in `leak` and `manual` (D64, pipe-b boxes 7 to 9 and 11):** classes and inheritance as TSL
   classes in TSL's own layout, with narrowing kept and `!` only where tsc can't see it, and placement by tslc. 14 programs
   agree on every case (13,344 cases at -O0 and -O2 in `leak` and `manual`), and the wrong class-id arm and a wrong field
   read are both caught. First 1.44×, 1.25× and 1.16× the direct route, from TSL's `leak` reference; then recovered in TSL
   proper (plain classes with no prefix and untagged references, masks merged, zero initialisers not stored) to 0.98–1.02×,
   0.97–1.00× and 0.93–0.94×, so `auto` takes it where it prints a program unreshaped. In the gate the list then measured
   1.07×: its constructor still stored the class's zero initialisers, which `new`'s rule didn't reach, and once those were
   gone an empty constructor left the code 4 bytes out of place. **Built (pipe-c):** zeroed construction (SPEC 3.5: no
   constructor stores a zero initialiser where every object of its class starts zeroed, with each path that reuses memory
   checked and tested, and an empty constructor not emitted), so the list's image is the direct route's byte for byte
   (1.01× standalone); and one TSL module per source module (D65), with the source's imports, names that are each
   module's own, and nothing depending on the order of the imports. **Built (pipe-d), and the default in `leak` and `manual` since pipe-e:** arrays as
   `@tsl/std`'s `JsArray` (`@tsl/jsrt`'s since D71) (D66, step 8.1), a TSL class with JS's rules that a person can write too; class printing prints
   a vector as it, `xs.push(v)`, `xs.get(i)`, `xs.length`, `xs.setLength(n)`, in place of `__vec_*` calls and loads at
   the lowering's offsets. 27 programs class-print where 15 did with classes forced (12 of the 44 that vectors blocked;
   the rest stop next at strings, exported objects or closures), agreeing on all 14,648 cases at -O0 and -O2 in `leak`
   and `manual`, and bugs put into the class (growth losing the last element, `pop` on empty, a hole read wrongly) are
   caught. It first measured 1.76× the direct route in `leak` and 2.29× in `manual` on the arrays benchmark. pipe-e
   diffed the machine code of each loop through both routes and timed each operation alone: the read's second length
   check, the pop's extra checks and clear, and a push's overflow check on the new length cost nothing measurable
   (taking `get`'s check out moved no time); growth was the gap. `grow` zeroed the whole new buffer a word at a time
   before copying into it, and `@tsl/std`'s global allocator zeroed a reused run of pages a byte at a time, because a
   byte array's `fill` was a store per byte. Fixed in TSL proper: a byte array's `fill` is one memset, and `grow` copies
   what it keeps and zeroes only the rest. Then 0.91× in `leak` and 0.84× in `manual`, the list and churn unchanged
   (0.93–0.99×) and the JPEG decoder's TIR the same, so `auto` prints arrays (at -O0, which inlines nothing, they're
   1.6×, with `push` and `get` calls; whether `auto` should take them there is the owner's call): 19 programs class-print in each of
   `leak` and `manual` where 13 did (the other 8 that print with classes forced are reshaped). A fill put a byte late
   is caught. **Built (pipe-f), with classes forced, and not `auto`'s choice:** strings as `@tsl/jsrt`'s `JsString` (D67,
   step 8.2), a TSL class with D42's representation (flat or a view, UTF-16 with lone surrogates, appends in place at a
   buffer's tail, substrings sharing within 4×), not `@tsl/std`'s `Str`, which is TSL proper's UTF-8. The string
   runtime's core is the class (`s.concat(t)`, `s.sub(i, n)`, `s.cpLen(i)`, `JsString.eq`, `s.compare(t)`,
   `JsString.ofUnit(u)`), the rest of `compiler/rt` prints as TSL over its units (`s.length`, `s.unit(i)`,
   `JsString.flat(n)`, `s.put(i, u)`, `s.copyFrom(…)`), and a literal is `JsString.of(lit("héllo"))`, made in `__init`.
   Everything with classes forced agrees with the direct route (116 builds, 14,952 cases at -O0 and -O2 in `leak` and
   `manual`), and the injected bugs (a pair split, a tail shared, a view past its bound) are caught. It doesn't meet the
   speed rule yet (M5's pipe-f record has the numbers and where the rest of the gap is), so `AUTO_STRINGS` is off. Left,
   in order: closing that gap; number text, whose `compiler/rt/num.ts` makes typed arrays in functions (printed as
   phase 1 prints them in the runtime's own functions since pipe-g); exceptions (step 4, built since); maps; exported objects, with D36's layouts moving and listed. **R5** (SPEC M5's R5 record): exported objects print in `leak` and `manual`, D36's layout listed and kept rather than moved (each class that crosses padded to it, checked by tslc; an array placed by a `__vec_place_<id>` export), not `auto`'s choice yet (`AUTO_BOUNDARY`: -O1 in `leak` 1.01x); `rc`'s counted handles at the boundary aren't built. Moving D36 to TSL's own layout, as section 0's ruling allowed, is left to the owner.

4. **Built (pipe-g), with classes and strings forced, and not `auto`'s choice:** exceptions' desugaring in the printer
   (D68, `compiler/host/emit-exc.ts`), written apart from down-exc.ts, which the direct route keeps, from the tree as it
   was before it. `__exc_on: bool` and `__exc_val: Dyn | null` are module state; `if (__exc_on)` follows each call that
   can throw; `try` and `finally` are labelled blocks (`$try1: { … }`, `$finally2: { … }`, a label on a plain block being
   TSL as it is) with a completion code taking each `break`, `continue` and `return` out through the `finally` code. The
   thrown value is `Dyn`, the program's one class for `unknown`: TSL has neither unions nor inheritance, so everything an
   `unknown` can hold is flattened into one class with a class id, as D50 flattens a hierarchy. 47 of 139 programs
   class-print in `leak` at -O2 where 29 did, and all 77 of the exceptions corpus that print (63 of them the generated
   `finally` programs) agree on 12,180 of 12,184 cases in `leak` and `manual` at -O0 and -O2; the other 4 are
   `exc_exhaust.ts` in `manual`, whose 32 pinned pages run out sooner because JsString takes its units 16 pages at a time
   (D67). A `finally` run in the wrong order, a missed flag check and a rethrow losing its value are caught. Where nothing
   throws, 1.00× to 1.01× the direct route at -O1 and -O2; the throw benchmarks run out of memory through the TSL route
   in `leak`, its thrown object being 72 bytes to the direct route's 56. Not switched over: every exception program has
   strings, which `auto` doesn't print yet. **pipe-h** (M5's pipe-h record): JsString's unit chunks start at a page and
   double to 16, so `exc_exhaust.ts` agrees in `manual`, pipe-b box 7 and pipe-d box 3 cover corpus/lower/exc again, and
   box 12 lists nothing (80 programs, 12,352 cases, all the same); `strHash` prints over the class (`s.hashWord`, the key
   as module state), so `app_interp`, `app_parser` and `app_visitor` print (`app_events` stops next at an exported
   object); `Dyn`'s fields share storage by type, with a `u16` class id, so a thrown `Fail` is 56 bytes, the direct
   route's size, and a field reached through a local only ever set to `this` prints on `this`. Throws in a 1 GiB guest,
   1, 10 and 100 frames up: `leak` 1.02×, 1.02×, 1.00× at -O1 and 1.01×, 1.02×, 0.94× at -O2, `manual` 0.90× to
   1.00×. Strings at -O2 in `leak`: appends 1.22×, short joins 1.19× (shown to be the units' own allocation), the rest
   1.04× to 1.09×. Neither switched over: strings miss the speed rule, and exceptions need strings and are 1–2% slower
   in `leak`. Left, in order: the appended unit's write into the buffer (appends, cause not found); the short joins'
   second allocation, which needs the owner's decision on variable-length class tails (proposed, not built, in M5's
   pipe-h record); the two literal loads on the throw path. **pipe-tails (D69):** the owner decided on tails, and they're
   built: `units = tail(u16)`, `withTail(n, new T())` on the heap only, held by reference only (TSL3011 wherever TSL copies
   by a fixed size), `Rc.makeTail` by size class, `manual` freeing at the real size. `JsString` keeps a flat string's units
   in its tail, so it's one allocation. Short joins stay 1.17×, not pipe-h's predicted 0.93×: that prediction kept units
   inside the 32-byte object, a tail puts them after it, and a short join then allocates 96 bytes a step to the direct
   route's 64, which measured as the gap (16 more bytes a string: 1.27×). Appends stay 1.21×: 11% more instructions a step,
   spread over checks (M5's pipe-tails record), not the 2-byte copy, which both routes make. So `AUTO_STRINGS` stays off,
   and exceptions with it. Left, in order: a smaller flat-string header, folding the constant compares and the double
   length check in appends, then switch strings and exceptions on. **pipe-dispatch (D70):** closed-world interface
   dispatch is in TSL proper (a methods-only interface, its classes from the whole program's flow, a direct call for one
   class and a class-id compare per class for several, trap 18 for none, TSL3010 and TSL1025), and both append fixes are
   in: unsigned compares of constants below 2^32 fold, and `concat` leaves the length check to its caller. Appends are
   1.07× the direct route in instructions (237.7 a step to 221.5) and 1.14× (`leak`) and 1.22× (`manual`) in time at
   -O2. The split of `JsString` into a flat class and a view class behind a dispatch interface is designed (M5's
   pipe-dispatch record: a 12-byte flat header, so a short join allocates 56 bytes a step to 64) and not built, so strings
   and exceptions stay off in `auto`. Left, in order: that split, then the appends' time gap beyond their instructions, then
   the switch. **pipe-split (D67, D70):** built as designed: `JsString` a dispatch interface over `JsFlat` (12 bytes and
   its units) and `JsView` (32 bytes), a concatenation's buffer `JsBuf` behind a second interface, `JsOwner`, with
   `JsFlat`; the printer prints `JsFlat.of(lit("…"))`, `s.len()`, `s.hashWord()` and `jsEq(a, b)`; D36's string ABI is the
   layout the build publishes (`DownMeta.strLayout`). Short joins gained (`leak` 1.17× to 1.08× at -O2), and everything
   else lost to the class tests (appends 1.33×, split and join 1.14×, at -O2 in `leak`; five tests on an append in place,
   none hoisted or shared, as the optimiser has no loop-invariant motion, unswitching or GVN). So by decisions.md's rule
   strings stay forced-only, and exceptions with them; the string gap is to be looked at again after check elimination
   (optimiser phase B), with what GVN or unswitching would take off these tests.
5. Closures as environment classes, tags and call switches, with the injected shared-capture-slot bug.
6. `rc` builds through `@tsl/gc` (section 4): tslc's desugaring, then the collector and per-slot steps in the library, with
   the injected missing-`share` (poisoning) and missing-`drop` (no-leak) bugs in the desugaring. **R1 built in TSL proper (D74):**
   the desugaring, per-slot steps, `WeakRef`, and the injected bugs (a missing share, a missing drop, a borrow kept across a store
   that clears the only holder, a whole-object freeing step, a resurrecting `WeakRef`), each caught. **R1c:** D41's collector in
   the library (SPEC 3.5), with six injected bugs caught. **R2:** lowered `rc` builds through the printer in a lowered `rc`
   package, with `JsMap` slot clearing (section 4's R2); not `auto`'s choice yet (`AUTO_RC`).
7. Loop versioning and field ranges, through the new route, measured per benchmark, with the injected lost-state bug.
8. The runtime (`compiler/rt`, `down-rt.ts`) as TSL runtime classes, `Str`, `JsMap`, `JsSet`, `Dyn`, through the same
   pipeline. **Built (pipe-jsmap, D72), with classes forced, and not `auto`'s choice:** `JsMap<K, V>` and `JsSet<K>` in
   `@tsl/jsrt`, compiler/rt/map.ts ported into TSL (insertion order, a chained table of positions and tombstones, growth 4
   positions an operation, cursors through generations, keyed hashing), printed as `new JsMap(u64, f64, true, false)`,
   `m.get(jsNumKey(k))`, `m.cursor()`, `m.advance(c)`, `jsKeyNum(m.keyAt(c))`. By hand against JS's own Map and Set (637
   cases) and through both routes and on V8 and JSC (`corpus/lower/pipe/maps.ts`, 2,548 cases), all the same; the injected
   bugs are caught. **String keys (strkeys):** `keyHash` and `keySame` on a dispatch interface call its classes'
   `hashKey` and `sameKey` through the class-id switch (D70), and `JsString` has both: D42's keyed HalfSipHash in 30 bits,
   kept in the hash word as `strHash` keeps it, and `===` on units with the hash words saying no first. String-keyed maps
   print (`new JsMap(ref<JsString | null>(), f64, true, false)`), both string-keyed benchmarks with them, and
   `corpus/lower/pipe/strkeys.ts` agrees through all three routes. **Judged apart, not switched:** new number-keyed and
   object-keyed benchmarks (`bench/maps/num_lowered.ts`, `obj_lowered.ts`; `tmk bench memory --classes --maps`) are 1.05×
   and 1.16× the direct route at -O2 and 1.13× and 1.24× at -O1, so `AUTO_MAPS` stays off. In the machine code, `seek`'s
   chain loop is 13 instructions a step to the direct route's 9: `JsArray.get`'s bounds check on the keys and on the chain,
   each reloading its array's length, which the loop doesn't change, and before it a checked `heads.length - 1` and a
   bounds check `& (b - 1)` already ensures. Taking `get`'s check out (a measurement only) brings -O1 to 1.06× and 1.16×
   and -O2 to 1.04× and 1.14×, so the checks are most of -O1's gap and little of -O2's; the rest of the object-keyed gap
   isn't found. Optimiser phase B (check elimination, loop-invariant motion, value numbering) is aimed at the first part.
9. The direct route retired, when the differential has nothing left only it can compile.

The reshaped programs of phase 1 (make the reshaping give the direct route's TIR, or measure that it costs nothing) are folded
into step 3, as the printer is rewritten there.

## 10. Measured in phase 1

Corpus coverage, programs the TSL route takes of those the direct route lowers with no fallback (pipe-a box 2): the
lowered-rule corpus 29 of 29 in `strict` and 28 of 29 in `leak` and `manual`; the native corpus 1 of 1; the fallback corpus
8 of 10 in `leak` and `manual`; memory 5 of 9; `rc`'s adversarial corpus 3 of 3 in `strict` and 9 of 15 in `leak` and
`manual`; exceptions 20 of 20; strings and maps 15 of 21; maps 1 of 3; `rc-only` 3 of 3; and no `rc` build. Everything
left out is a closure value. Taken by default, being printed exactly: at -O2, 23 builds in `strict` and 36 in each of `leak`
and `manual`.

The dual-route differential: 498 program builds, at -O0 and -O2 in three modes on HVF and at -O2 on TCG, 35,117 cases, all
the same through both routes. 341 of the 436 HVF builds give identical TIR, and every one of the 190 printed exactly does; the
95 that don't were reshaped and stay on the direct route by default.

Compile time: 84 builds 1.8 s straight to TIR and 3.2 s through TSL in one process; the JPEG decoder 233 ms and 460 ms at
-O2, of which printing is 7 ms and tslc 254 ms, parsing and checking 2,568 lines. `tmk coverage --real`, which counts what
lowers rather than which route it takes, is unchanged by this phase: 484 functions of the real projects lower, 7.7%, before
and after (the falsy fix lowers what it did, correctly).
