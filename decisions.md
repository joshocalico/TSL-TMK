# Decisions log

Running log of decisions made while the owner is away. The owner handed over the reins on 2026-11-19 ("follow your recommendations but log them"). Each entry says what was decided, why, and what was rejected, so any of it can be reversed. SPEC.md stays the source of truth: anything here that changes the language or the design also lands there as a D-number.

Newest first.

---

## The plan (the pile), in order

Pipeline work, so ordinary TS → TSL → TIR → output becomes the only route:

1. **Tails.** Variable-length class tails (`units = tail(u16)`), heap-only, held by reference, a compile error wherever TSL copies by fixed size. Then `JsString` keeps its units in a tail, and strings and exceptions switch on where they're no slower. *In progress.*
2. **Printed TSL runs on V8**, plus naming and housekeeping:
   - a third route in the differential: printed TSL on V8 must match the source on V8 and native;
   - every printed construct made runnable on the host, simulated or replaced, with `@tsl/lowered` extensions deleted as they go unused;
   - "runs on V8" becomes a switch-over condition;
   - a `Trap` enum, with a rule rejecting bare trap numbers;
   - `JsArray` moved to `@tsl/jsrt`.
3. **`JsMap` and `JsSet`** printed as TSL runtime classes.
*(Reordered 2026-11-24: optimiser phase B now comes before item 4. See the log.)*
4. **`rc` through `@tsl/gc`:**
   - `tslc` expands `new` and field writes into `Rc` calls;
   - the cycle collector ported into `@tsl/gc`;
   - D39's per-step freeing bound kept exactly;
   - `WeakRef`.

   Probably 2–3 steps.
5. **Closures as values:** environment classes, a kind tag and a call switch.
6. **Exported functions taking or giving objects,** with D36 layouts moved and listed.
7. **Class printing in `strict`:** the JPEG decoder and others.
8. **Typed arrays made inside functions** (number-to-text), arrays of booleans, optional fields. *Built in R9 in `leak` and `manual`, forced only (`AUTO_R9`); number text waits on strings.*
9. **Reshaped programs:** a confidence rule, or removing the reshaping.
10. **Loop versioning:** recover the JPEG decoder's speed correctly.
11. **Retire the direct route:** `compiler/rt` goes through the pipeline, then the direct route is deleted.

If the pile runs out before the owner returns (owner, 2026-11-19): look at the gaps against our corpora. That means:
- `tmk coverage` (local) and `tmk coverage --real`, by root cause;
- the D48 list (dynamic values first);
- whatever blocks the most functions next.

Then, from earlier agreements:
- **Check elimination** for provably safe arithmetic (optimiser phase B).
- **The API-fixes phase:** design/api-audit.md's 12 "fix before kernel work" items, page sources as objects (prototype in /tmp/tmk-pagesrc), `atomic(u16)`, portable intrinsics and `onArch`.
- **Then the kernel.**

Standing rules for every step:
- No switch-over unless no slower than the direct route at -O1 and -O2. -O0 is exempt.
- Desugar into TSL rather than extend it.
- Strict null checking stays on.
- The kernel stays `strict` and `noStd`.
- Never weaken a test.
- Builders run the full gate only at the end of a chunk. I verify each one with `tmk verify-manifest` and `tmk gate --sample`.

The nightly full run stays paused until the owner agrees the pipeline is fixed.

---

## 2026-12-25

**Coordinator: R14 verified** (manifest MATCH, tree b918d320cb253fd4; sample 8/8 the same, seed 16253; gate 93.4 min, 269 of 269).
- *A correction to the builder's note on `pre-std-tirhash.json`:* those pins are built at -O0 (tools/pre-std-hashes.ts sets `TMK_OPT=0`). So the 4 moved pins (`app_text.ts` and `app_wordcount.ts` in `leak`/`manual`) show the reshaped -O0 TIR the TSL route now gives them, not the direct route's code. -O0 is exempt from the speed rule, and box 47 checks the byte-identical claim at -O1 and -O2. Accepted.
- The rule is narrower than "trust reshapes": four kinds, only in phase 1's printing, and only where every touched build has the direct route's exact code at -O1/-O2. So the speed rule holds by construction rather than by timing. Exceptions are held back on purpose (`R14_TRUST_EXC`), as is `rc`, which has no phase 1 printing.
- **The JPEG decoder is now `auto`'s** through the TSL route, at the direct route's speed.
- Builder broke one rule (a single `pgrep -f` check, nothing killed). Noted; it's repeated in the next brief.

**Decision: R15 takes pile item 10, loop versioning** (with check elimination where it serves it). R13 found that class printing pays a double array-read check at computed indices (`toRgba`), and R14 found that class printing makes a callback's array on every loop turn. Those two costs keep class printing, and with it `rc` and the remaining reshaped programs, out of `auto`.
- Measure first on the JPEG decoder's class printing and the R14 benchmarks R14 found slow (operandWork, acyclicWork).
- Versioning must be sound: a guarded fast loop and the original as the fallback, with every check either proven or kept.
- The same speed rule, JPEG and S4 not slower, and injected bugs that the gate catches.
- *Next:* item 11, retiring the direct route; and `rc`'s reshaped programs once class printing is no slower.

## 2026-12-24

**R14 is built (builder's report; for the coordinator to verify).** Pile item 9, the reshaped programs, as a confidence rule: `auto` takes a program phase 1 printed reshaped only by four kinds it trusts. SPEC D62, 4.5, 8.3 and M5's R14 record. Nothing was added to TSL; no check or case was dropped; no limit moved.
- **Measured first** (`reshapedWhy`, -O2): four kinds are the lowering's statement-expressions inside an expression (statements before an operand, after a sequence's first part, in a conditional's arm, on a logical operator's right side). They nearly always come together, and together they alone held back 17 of `strict`'s 18 reshaped programs, 117 of `leak`'s and `manual`'s 139, and 132 of `rc`'s 155. Every other kind alone frees at most 2 programs, so they were left.
- **The rule** (tslc.ts `TRUSTED_RESHAPES`, `TRUSTED_IN`, switch `R14_TRUST`):
  - *Order:* each kind keeps JS's order, argued in D62; four injected bugs, one per kind, each caught on `auto`'s own builds (box 48).
  - *Trusted only in phase 1's printing,* where all 198 builds they touch give the direct route's TIR at -O1 and -O2, byte for byte (box 47 checks each), so the speed rule holds as a fact.
  - *Not in class printing:* touched benchmarks there were 1.05–1.34× (a callback's array made each turn as a class), `leak` programs 1.01–1.05×, `rc` up to 2.2×. That's the classes' cost, not the reshape's. A reshaped class printing falls back to phase 1's; `rc` has no phase 1, so takes nothing reshaped.
  - *Not with exceptions* (`R14_TRUST_EXC` off): all print reshaped, none was ever `auto`'s, and their throws were 1.00–1.02× in `leak`. Without this guard 84 programs per mode would have switched by accident.
- **Coverage** (`auto` takes the TSL route, -O2, exact + reshaped): `strict` 30+0 → 30+18; `leak` and `manual` 62+4 → 63+43; `rc` 19+0 → 19+0. Left reshaped: exceptions (84 per mode), `rc`'s class printing, closures (9), a multi-key switch clause (3), a loop condition/step (1).
- **JPEG and S4:** the JPEG decoder now goes through the TSL route by default (phase 1, the direct route's TIR, so the same speed: native/V8 1.075× at -O1, 1.098× at -O2). S4 1.177× and 1.129×. TSL proper pins untouched.
- **Found and fixed:** phase 1 lost D73's invariant mark on class-id loads (`load<i32>(o, 0, "invariant")`); R13's carried TSL1008 (`nullRef()` in `leak`/`manual` class printing), plus a TIR verifier error it hid (a null array's value in a conditional).
- **Pins:** 52 of 3,862 moved, none of TSL proper's, none unexplained (`tools/r14-pins.ts`, `tools/r14-moved.ts`): 48 by the invariant mark (pipe-tirhash.json, re-pinned), 4 by the trust (pre-std-tirhash.json).
- **Harness additions:** the dual route can compare `auto`'s own build (`dualRoute`'s `auto`); a timing image (`RcHarness.timePasses`) and `tools/r14-time.ts` time or instruction-count a program's cases through both routes; `tmk bench memory --classes --reshapes`; route-blockers reports what `auto` takes.
- *Rejected:* trusting the kinds in class printing (measured slower, as above); trusting "a field read through a computed base" and "a null array's value" (they'd put the JPEG decoder's class printing, 1.002–1.006× at -O1, into `auto`).
- *Next:* item 10, loop versioning; class printing's per-iteration arrays (what made reshaped class printings slower) is the lever for taking those programs with classes.

## 2026-12-23

**Coordinator: R13 verified** (manifest MATCH, tree 04e1283a8e4a06dd; sample 8/8 the same, seed 15511; gate about 90 min, 267 of 267).
- I read both relaxed harness comparisons. `bothNullRead` needs both engines to throw a `TypeError` for a read of null or undefined, with the same arguments, and counts it as a named divergence (1). The Wasm check requires a case's declared `lowered_trap` code exactly. Neither skips a case. Accepted.
- The JPEG decoder now prints whole and agrees everywhere, but stays forced-only: it's reshaped (121 sites) and 1.002–1.006× at -O1. That's the double check in `toRgba` at computed indices, which is item 10's.
- **Owner review:** `JsArenaArray` (a new library class, only for lowered packages), and the `stateHazard` refusal (TSL3001) for module state reaching what was made after `__init`.
- Carried forward: the TSL1008 typed-array-against-null printing in `leak`/`manual` (fixed in `strict` only).

**Decision: R14 takes pile item 9, the reshaped programs.** What "reshaped" means today: the printer had to hoist statements into temporaries or restructure a loop or branch (emit-tsl.ts `reshape`), so the TSL route's TIR can differ from the direct route's. `auto` refuses all of those (tslc.ts, D62), so a correct and verified print still goes the old way.
- *First, measure:* the reshape kinds across all four modes and how many programs each one alone holds back (`reshapedWhy`, route-blockers).
- *Then, kind by kind, the cheaper of:*
  - **remove the reshape**, by printing the shape the direct route makes (or making both routes make the same one, since the direct route is retiring); or
  - **a confidence rule:** a kind is trusted when (a) it keeps JS's evaluation order (argued in SPEC, with an injected bug that breaks the order and gets caught), (b) the three-way differential agrees on every program it touches, and (c) it's no slower: a micro-benchmark per kind, plus every touched program's cases timed or its code compared at -O1 and -O2. `auto` then takes a program whose reshapes are all trusted kinds.
- *Rejected:* trusting all reshapes at once (the speed rule must hold kind by kind); per-program allow-lists (they don't generalise); timing each program in `auto` at compile time.
- The speed rule, JPEG and S4 stand. The JPEG decoder joins `auto` only if it passes the speed rule; if not, it waits for item 10.
- *Next:* item 10, loop versioning.

## 2026-12-22

**R13 is built (builder's report; for the coordinator to verify).** Pile item 7 finished as far as `strict` allows: arrays print in `strict` lowered code, and the JPEG decoder goes through the TSL route (forced). SPEC D36, D62, D66, 3.5's `// file: ex-jsrt-arena.ts`, 4.5's "Arrays in `strict`" and M5's R13 record. Nothing was added to TSL; no check or case was dropped; no limit moved.
- **The class:** `@tsl/jsrt`'s `JsArenaArray<T>` in a module of its own (`@tsl/jsrt/arena`, so it links no `@tsl/std`), `JsArray`'s rules and surface, its buffers only from the call arena (`callRegionBytes`), never given back (the caller resets the arena, D36). Growth doubles and traps 14 where the arena runs out. Only a lowered package can import it (TSL1023), so the kernel's `strict` TSL can't depend on it. On the host the arena is simulated memory.
- **Placing (region.ts, `strict` only):** an export's arguments and result live in the caller's arena until it resets it, as the direct route's do, so they no longer make a class long; module state may hold what `__init` made before it commits the arena, and tslc refuses (TSL3001) a package where something made later can reach module state (`stateHazard`). The lowering already keeps such programs on the direct route, so this is tested on hand-written lowered packages.
- **Printing in `strict`:** arrays, typed arrays made in functions (R9's views), arrays of typed arrays (R7's holders), closure values and exports taking or giving objects. A constant-index read check folds into `get`'s, as R6 folded a variable's.
- **The JPEG decoder:** prints whole, agrees with V8 natively (136 of 136, M2's pins, 200 corrupt inputs) and as Wasm on V8 and JSC. Its printing is reshaped (121 sites), and natively it's 1.002 to 1.006× the direct route at -O1 (0.973 to 0.985× at -O2), as Wasm on V8 up to 1.03×, so it stays forced-only. Where -O1's time went: `toRgba`'s pixel loop checked each array read twice (the lowering's check and `get`'s); folding constant indices took it from 1.03× to about 1.005×; the rest is the same double check at computed indices, for check elimination and loop versioning (pile item 10).
- **`auto`:** takes arrays in `strict` where the printing is exact (`AUTO_STRICT_ARRAYS`): the arrays benchmark 0.58× and 0.86×, the typed arrays one 0.998 to 0.9996×, at -O1 and -O2, two quiet runs. S4 isn't touched (TSL proper, no pin moved): see M5's record.
- **The 17 reshaped `strict` programs:** none becomes exact. 16 now class-print, all still reshaped by the lowering's statement-expressions (pile item 9); one refuses (a string field crossing an export).
- **Pins:** 9 of 3,862 moved, all `strict` builds of generics_mono.ts and adv_temporaries.ts (`tools/r13-moved.ts`); none of TSL proper's.
- **Harness changes to note:** the third route's V8-against-JSC comparison now allows a read of null each engine words its own way (`bothNullRead`, as corpus.ts already does for the source); R12's Wasm runs check a case's declared trap (`lowered_trap`) rather than V8's exception, as the corpus's Wasm runs do. Neither drops a case.
- **The first full gate** failed 3 of 267 jobs, all fixed: generics_mono.ts unlisted in two older pin lists (pipe-c box 5, pipe-d box 7), and a race where pipe-c box 4's momentary `.two_squares_reordered.ts` was listed by R12's box 44 and gone when compiled (`listPrograms` now skips dot-files).
- **Found, not fixed:** in `leak`/`manual` class printing, a typed array's pointer compared with null prints `null` against a Ref (TSL1008), so those programs stay on phase 1's printing; fixed in `strict` only, to move no pin.
- *Rejected:* a second array class for module state (class identity as the only way to tell module state's arrays apart); letting `strict` link `JsArray` and `@tsl/std`'s heap; refusing every program with module state (the JPEG decoder has `AAN_SCALE`).
- *Next:* pile item 9, the reshaped programs: it's what keeps the JPEG decoder and 16 of `strict`'s 18 reshaped programs off the TSL route now.

## 2026-12-21

**Coordinator: R12 verified** (manifest MATCH, sample 8/8, seed 14229; gate 88.5 min).
- **The CPU budget works:** one token per core across every process, and at most 9.8 of 10 cores busy. Load averages above 100 now mostly count V8's waiting helper threads, not oversubscription.
- **The memory margin is restored:** the dual route is capped at 2, and the highest peak in the gate was 2.32 GiB.
- **Box 21's root cause:** a V8 reference run's timeout used a wording R7's check didn't recognise ("wall-clock limit"). So under load the reference went missing, and every case of `cyc_giveup.ts` and `cyc_interleave.ts` counted as a wrong answer. Fixed, and other fault boxes now print wrong answers, not raw failure counts. The count is 223 even at full load.
- **Class printing in `strict` is on in `auto`:** 0.68–0.99× in every cell. JPEG and S4 are unchanged, and the JPEG decoder's code is byte-identical. 9 pins moved, all `strict` lowered builds.
- **Coverage:** `strict` 30 / 17 / 0, `leak`/`manual` 64 / 139 / 14, `rc` 25 / 155 / 42.
- **I checked one claim myself:** the builder reported that a compiler edit selects all 266 jobs in `--changed`. That run's changes included harness files (gate.ts, qemu-run.ts), which deliberately select everything. A compiler-only edit selects the quick steps that reach it (gate.ts `selectFor`). No regression.

**Decision: R13 finishes pile item 7 with an array class for `strict` lowered code whose storage comes only from the call arena,** so the JPEG decoder and other `strict` programs with arrays print through the TSL route.
- It's a library class (in the style of `@tsl/jsrt`, with no `@tsl/std` heap), not a language extension, so it's within "desugar, don't extend".
- It's only for lowered packages; the kernel's own `strict` TSL doesn't use it.
- An array that could outlive the export call refuses printing, as R12 does for objects.
- The speed rule applies, and JPEG is the benchmark that matters. Loop versioning (item 10) is what recovers JPEG's speed, so if the TSL route is slower, it stays forced-only.
- **Owner review:** a new library class.
- *Next:* pile item 9, the reshaped programs (139 in `leak`/`manual`, 155 in `rc`). That's the largest remaining coverage lever before the direct route can retire.

## 2026-12-20

**R12 is built (builder's report; for the coordinator to verify).** Harness fixes first, then pile item 7 as far as `strict` allows (SPEC D62, D76, 8.3 and M5's R12 record). Nothing was added to TSL, no check or case was dropped, and no limit moved.
- **A CPU budget** (`tools/cpu-budget.ts`): the pool serves a token a core, and every leaf of every job takes one while it runs (a compile on a worker, a QEMU run, a compile batch, a reference engine's or pins tool's run), the longest job's first, before its time limit starts. A token is a socket connection, so a process that dies gives its tokens back, and nothing holding one waits for another.
  - *Measured:* at most 9.8 cores busy in a 266-job run. The host's load average still read 70 to 196: it counts every ready thread (V8's helpers included), not busy cores, so the manifest now records cores busy too.
  - *Not reached:* a faster gate. The host is CPU-bound either way; the budget changes who waits, not how much work there is.
- **Memory margin:** at most two of the dual route's builds at once in a process (pipe-a box 3 alone: 2.63 GiB with three, 2.29 GiB with two), and `lang-a` box 10 two suites at once (2.54 → 1.68 GiB).
- **Box 21, at the root.** The extra wrong answers under load were every case of `cyc_giveup.ts` and `cyc_interleave.ts` counted against "V8 gave undefined". Their expansion's run on V8 (6.7 s quiet, 10.7 s with the bug) passed its 30 s limit, and guarded-run's wording ("over the 30000 ms wall-clock limit") wasn't one `ranOutOfTime` knew.
  - *Fixed:* that wording counts as out of time; a program with no finished reference isn't compared case by case (its pins still are); a case a dual-route run never reached because it ran out of time says so; and boxes that printed `failures.length` for a bug print its wrong answers.
  - *Measured:* six copies of the run at once give 223 each with the budget (the quiet figure), 209 without.
  - *Test:* `tools/fault-time.test.ts`.
- **Class printing in `strict`:** objects print as TSL classes and nothing else of phase 2 (arrays, strings, maps, closures and `Dyn` need `@tsl/jsrt`/`@tsl/std`, which `strict` code doesn't have). tslc puts what escapes its function in the call arena, as the direct route does, and refuses the printing if an object could outlive the export call. The Wasm backend learned a reference's conversions and `gen.chk`.
  - `auto` takes it where the printing is exact and the program has a class: 0.68–0.99× the direct route on its benchmark, two quiet runs at -O1 and -O2.
  - 9 pins moved (class_struct.ts, adv_control_paths.ts in `strict`), listed in `tools/r12-moved.ts`.
  - Three injected bugs, each caught (pipe-d boxes 43 and 44).
- **The JPEG decoder doesn't move:** it has arrays, so it prints as phase 1 did, its TIR and Wasm byte-identical with R12 on and off; S4 is TSL proper, untouched.
- *Proposed, not built:* an arena-only array class for `strict`, so programs with arrays (the JPEG decoder) can class-print without a heap. It's a new library surface, so it's the owner's call.
- *Rejected:* letting `strict` link `JsArray` (it brings `@tsl/std`'s heap into `strict` code); a higher reference time limit for box 21.

## 2026-12-19

**Coordinator: T2 verified** (manifest MATCH; sample 7/8, seed 13171). The eighth was pipe-d box 21 again: the injected bug "a drop at a scope's exit left out" gave 410 wrong answers in the gate and 223 in my sample. The gate ran at load 82–90 and the sample at a lower load; 223 is the long-standing quiet figure. So this count depends on load even with timeouts excluded (R7's fix). It's not a T2 regression, but it's the third false alarm from this box, so it's fixed at the root in R12.

T2's results:
- **Gate:** 93 → 87 min, at much higher load (82–90 against T1's 36).
- **Per-compile CPU:** −17%. Every output is identical, and 1,551 cold checks in the gate gave 0 mismatches.
- **The floor jobs are split.** pipe-d/40 went from 2,015 s to 480 s alone.
- **The dual route compiles on workers.** Workers now take every `TMK_*`/`TSL_*` variable, which closes a gap where injected printer bugs could have vanished.
- **Native output is buffered:** `adv_exc_drop` went from 1.05 s to 0.10 s.
- **A correction:** the library modules' type checking was only 2–5% of a compile. The checker's cost is the program's own code.
- **Two problems T2 introduced:**
  - The gate is now oversubscribed, with load 80–150 and 89 processes at once. Jobs that rely on single children got slower.
  - pipe-a/3 peaked at 2.81 GiB against the 3 GiB watchdog.

**Decision: R12 opens with harness fixes, then pile item 7.**
1. **Harness:**
   - A CPU budget so that gate lanes × workers × parts stay within the machine's cores.
   - The dual route capped at 3 workers, to restore the memory margin.
   - Box 21's count made load-independent at the root: find which answers change under load, and compare only what can't.
2. **Pile item 7:** class printing in `strict`, the JPEG decoder and others. JPEG and S4 must not get slower.
- *Rejected:* a T3 speed round. Further gate gains are now in the optimiser's own cost (the inliner re-runs whole-function passes per site), which is real compiler work for a later round. The inner loop (`--changed`) is already fast.

## 2026-12-18

**T2 is built (builder's report; for the coordinator to verify).** Compiles cheaper, the dual route off the test thread, the floor jobs split, and the native lane's slow programs fixed. Nothing is tested less, and no limit moved (D76, SPEC 8.3 and the T2 record).
- **Cheaper compiles** (compiler/host/program.ts, tslc.ts):
  - the libraries' parsed and bound modules, and module and lib resolution from them, are reused within a process, keyed by text;
  - a package's `tsl.json` is read once a compile, not once a question (it was 12% of a classes-route compile);
  - the printer's rounds of `!` sites stop before elaboration (only tsc's errors name sites; the final printing is checked in full).
  - *Measured:* 19 sample compiles, 17% less CPU warm and 15% cold, every output the same; the classes route 22–30% less.
  - *Checked, not trusted:* one compile in 16 is made again with all of it off (`TMK_COMPILE_REUSE=off` takes exactly the old paths) and compared; a difference is a store mismatch. One `tmk test`: 120 checked, 0 different.
  - *Honest finding:* checking the library modules was only 2–5% of a compile. T1's 36% is mostly tsc checking the program's own code, which can't be reused. The optimiser (the inliner most) is now the biggest part.
- **A reference run on Node no longer loads typescript.js:** the transpile is kept in the run's store, checked 1 in 16 (0.78 → 0.06 CPU-s a printed run).
- **The dual route builds on the compile workers** (fix 4), a few programs ahead, each worker taking every `TMK_*`/`TSL_*` variable the test process has; the memo of six is now keyed on all of them too (it missed `TMK_R*_OFF` and some `TMK_EMIT_*`). A fault's builds are byte-identical to the in-process ones; box 13's caught counts are word for word.
  - *Found:* the 60 s QEMU limit T1 hit was the test thread busy compiling, not QEMU (a run of box 40's images takes 50 ms): a finished run's timer fired before its exit was seen.
- **Floor jobs, each alone:** `pipe-d` box 40 2,015 → 480 s (workers alone); box 13 1,137 → 171 s (four parts, two at once); `native-f` box 10 1,018 → 514 s (seven parts). Details word for word the same.
- **The native lane:** `adv_exc_drop` 1.05 → 0.10 s. It wrote 500,000 lines of its memory with one `write` each; the hosted runtime now writes when its 64 KiB buffer fills and at exit. Bare-metal images: 132 of 132 identical to the compiler before T2.
- **Quick tier:** 308 s at load 29–45 (Spotlight was indexing), 2,524 CPU-s against T1's 2,919. *Not reached:* under 4 minutes. One step, the -O2 `rc` poisoning build (157 compiles in four batches at once), is 200–300 s alone.
- **The final gate's time and `--changed` after a compiler edit** are in the covering report and the manifest.
- *Rejected:*
  - a cache of library checking across processes (2–5% of a compile, and it would outlive a run);
  - stopping the `!` rounds before the `rc` expansion (not provably the same);
  - more than two parts at once.
- *Next lever:* the optimiser's cost (the inliner's per-site whole-function passes), then giving the quick tier's last step more lanes once the rest is done.

## 2026-12-17

**Coordinator: T1 verified** (manifest MATCH, sample 8/8, seed 12011).

| | Before | After |
|---|---|---|
| `--changed` after a new box | 35–56 min | 27 s |
| Full gate | 116 min | 92 min |
| Quick tier | 6.9 min | 5.8 min |

- **The build store's cold checks:** 1,587 reuses rebuilt cold and compared, with 0 mismatches.
- **Mach-O is merged:** bare-metal images are byte-identical, and macho-tests pass 1,316 of 1,316.
- **The QEMU-against-native diff is identical:** 621 programs and 27,945 cases. Native running is slower today (70 s against 11 s), because a few programs take about 1 s each natively.
- **opt-a box 12's parts:** I accept them inside one job rather than as separate manifest jobs. The box fails if any part doesn't finish, and the job keys stay simple.

**Decision: T2, a short second speed round, then R12.** Progress speed is the owner's priority, and the levers are measured.
1. **Make a compile cheaper.** Reuse TypeScript's checking of library modules (36% of a compile), keyed by the module's content and the compiler's hash, giving identical diagnostics.
2. **Split the jobs that now set the gate's floor:** pipe-d/40, pipe-d/13 and native-f/10.
3. **Move the dual route's compiles onto the workers** (fix 4).
4. **Find out why a few programs take about 1 s natively,** and fix it if it's cheap.
- *Target:* gate around 60 min, quick tier under 4 min.
- *Rejected:* stopping at T1. 92 min per gate still sets the pace of every round.

## 2026-12-16

**T1 is built (builder's report; for the coordinator to verify).** Tests made faster by doing each thing once; nothing is tested less (D76, SPEC 8.3 and the T1 record).
- **The Mach-O work is merged** (D57a). Its added files are in, its patch to shared files applied cleanly, and SPEC.md was backed up first (`SPEC.md.bak-pre-t1`). `macho-bare-check`: 132 of 132 bare-metal images identical, before and after. `macho-tests`: 1,316 programs pass natively in 303.6 s.
- **Fix 0, `--changed` by declaration:** a new box selects 1 gate job instead of 41, an edit inside a box 1 instead of 40, a comment 0. Edits to a module's shared setup, a compiler file or the harness still select everything they did. V8's coverage of 19 jobs agrees with the analysis.
- **The build store:** within one run, each compile and each pure child's output (the pins tools, V8 and JSC references) is made once. It is removed when the run ends. One reuse in 16 is made again and compared; a difference fails the run, and `verify-manifest` rejects it. Units that measure, time compiles or need a still host run without it. Every QEMU run still happens. `tmk test` went from 416 s and 3,168 CPU-s to 352 s and 2,919 CPU-s, with 84 checks and no mismatch.
- **opt-a box 12 in parts:** 28 parts, each in its own process and build directory. Four at once took 1,079 s alone, and its detail is word for word R11's. In the first gate, four at once loaded the host enough that a pipe-d box 40 program ran past its 60 s limit, so it's two at once now. The parts are inside the one job, so the manifest's job list is unchanged. A part that doesn't finish fails the box.
- **The first gate** took 93 min (5,577 s) against R11's 116 min. It reused 13,074 compiles and 7,349 child outputs, with 1,360 checks and no mismatch. It failed 3 jobs: the time limit above, and native-a 5-9 at both levels. That box checks that no backend file starts a process, and the Mach-O merge had put a linker-running test there. The test is now `tools/macho.test.ts`, and the unit tests run it.
- **The sampler** compares a speed box by its verdict and the decisions its registry entry names (`AUTO_RC on`). R11's false alarm is a test (`tools/gate-sample.test.ts`).
- **The watchdog** samples memory with one `ps` per period for all the children a process guards, with the same period and the same 3 GiB limit.
- **QEMU against native (`tools/lane-diff.ts`):** 621 programs and 27,945 cases, all the same, addresses included. Native is no faster today: running takes 70 s against QEMU's 11 s, because a few programs take about 1 s each natively. Compiling, which both lanes share, is most of the time. So nothing moves to the native lane for speed; it's an equivalence check, as agreed.
- **The final gate's time is in this report's covering message and its manifest.** It runs from clean at default settings, after these records, so the manifest's tree includes them.
- *Not done, honestly:* the quick tier at ≤ 2 min. It is CPU-bound (8.3 cores) and its longest step is 157 compiles that don't repeat. That needs cheaper compiles, starting with tsc's checker on library modules (approved in principle; not started). Also not done: compiles off the test process's thread for the dual route, and scheduling by measured load.
- *Rejected:* results reused across runs; a store that outlives a run; reusing QEMU runs; the bugs as gate jobs of their own (job keys are parsed throughout); a larger V8 young generation (2% of a compile's CPU).

## 2026-12-15

**R11 verified** (manifest MATCH; sample 7/8, seed 11657). The eighth, pipe-d box 26, a timed box, differed only by a line that appears when a quick cell reads 1.00× and is measured again in full ("quick 1.00x, in full 0.95x"). Rerun alone, it passes. That's a false alarm from load, so T1 also makes the sampler compare timed boxes by their result and the decisions they assert, not their measurement lines.
- **`auto`'s maps and sets in `rc` are fixed.** A map's tables now keep the counted heap's pace: each table takes one allocation's freeing steps. Running out in `@tsl/std` drains the counted heap first. A map holding nothing counted is freed in one step.
  - The churn probes for sets and maps are permanent. `rc_churn.ts` is out of `RC_TSL_ROUTE_OOM`.
  - Every maps cell `auto` takes is 0.94–0.997×, so `auto` keeps printing maps in `rc`.
  - *Rejected by the builder after trying it:* counted tables. `@tsl/gc` rounds sizes up to a power of two, so a 4 KiB table takes 12 KiB, and the probe ran out of memory.
- **Exceptions in `rc` print:** 82 of 83 programs agree, and live counts are exact.
  - Four general fixes to the expansion. The narrowed-global counting bug could have hit any `rc` program.
  - They stay forced-only: throws are 1.15–1.35×.
- **Coverage, `rc`:** 25 exact / 153 reshaped / 42 blocked, from 23 / 69 / 125. 112 pins moved, all from `@tsl/gc`'s new export.
- **Gate time:** 116 min, near the 2-hour limit on background commands.

**Owner, 2026-11-16: "the test suite takes days to make progress." Decision: T1, a test-speed round, comes before any more pipeline work.** Its measured analysis:
- The gate is limited by compiling, not by QEMU: CPU is 86–100% busy, and QEMU is 2–5% of it. My first theory, that the harness starves its own event loop, is real, but it makes jobs longer rather than wasting the machine.
- At least 40% of runs exactly repeat another job's. That covers the direct route rebuilt in every side-by-side comparison, and the pin-hash tools run about 30 times for about 6 outputs.
- `tmk test --changed` took 35–56 min, because editing one test file selected 40–90 gate jobs.

**T1's plan:**
- **Fix 0:** `--changed` selects by declaration, not by file. Already built: a new box selects 1 job instead of 41. It's checked against V8 coverage of what actually runs.
- **The Mach-O merge.**
- **A gate-scoped store of compile outputs.** `tmk clean` empties it, and a sample of 1 in 16 is rebuilt cold and compared byte for byte on every gate.
- **Reference-engine results reused within a gate** (approved, with the same sampled re-check).
- **The longest fault-loop jobs split into parallel parts** (approved; `verify-manifest` requires every part).
- **Smaller items:** scheduling, the watchdog's cost, and cached type checking of library modules if it's sound.
- **Unchanged:** every check runs; no limit is raised.
- **Targets:** gate 40–50 min (30 isn't reachable with every check kept unless the compiler gets faster), `--changed` ≤ 5 min.
- *Rejected:* a smaller test matrix; a resident QEMU runtime (a QEMU run costs about 60 ms).

**M8 motivation (owner agreed, 2026-11-16):** a self-hosted native `tslc` may compile much faster than `tslc-host` on V8. Reasons: no start-up or JIT warm-up, no garbage collection with `leak`-mode arenas, layout classes, and no TypeScript checker, which is 36% of a compile today. So M8 benchmarks the native `tslc` against `tslc-host` on V8 as one of its goals.

**Next after T1:** R12, pile item 7 (class printing in `strict`, the JPEG decoder). The builder also suggests cheaper throws in `rc` (`AUTO_RC_EXC`), the map runtime in `rc` (9 programs), and counting a map's first buffers.

## 2026-12-14

**R11 is built (builder's report; for the coordinator to verify).** `auto`'s maps and sets in `rc` fixed, and exceptions in
`rc` through the TSL route. Nothing was added to TSL.
- **Maps and sets in `rc`:** the tables stay `@tsl/std`'s, made at the counted heap's pace. A map's holder makes it with
  `tablesIn(rcAllocSteps, rcCollect)`: each table first takes one allocation's freeing steps (`@tsl/gc`'s new `rcAllocSteps`,
  within `RC_BUDGET`), and where `@tsl/std` has nothing left (`JsArray`'s new `tryReserve`), the counted heap frees everything
  waiting before asking again. A map holding nothing counted is freed in one step (a set of numbers was a step a position,
  which is what really let freeing fall behind). D39's per-allocation bound is unchanged.
- *Why not counted tables:* built first (a room per table) and measured: `@tsl/gc`'s power-of-two classes with a prefix, and
  chunks of whole pages never given back past a page, made tables up to three times their size, and a set-heavy probe ran out
  through the TSL route where the direct route didn't. Paced `@tsl/std` tables passed it.
- **Probes, permanent:** r11_set_churn.ts and r11_map_churn.ts (corpus/lower/rc-tsl), taken by `auto` in `rc`, agree through
  both routes; rc_churn.ts left `RC_TSL_ROUTE_OOM` (region.ts alone is left). r11_paced.ts reads a table's steps off a native
  caller's counters (1,088 for one set's growth, 32 without R11); r11_drain.ts needs the drain to fit.
- **Speed:** every cell `auto` takes is under 1.00× (number keys 0.94–0.97×, object keys 0.94–0.95×, two quiet runs at -O1
  and -O2, load 4.5–6.1), so **`auto` still prints maps in `rc`**.
- **Nothing else `auto` prints in `rc` allocates outside the counted heap** but the map's own first buffers (made before its
  holder is counted, with no drain) and `@tsl/jsrt`'s generations and cursors (reused, bounded by what's open at once).
- **Exceptions in `rc`:** printed as in `leak` (D68), counted by the expansion; a native caller gives a taken exception back
  with `__exc_release`. Four general fixes to the expansion: module state that tsc narrowed to `null` counted by its declared
  type; a definite-assignment field with no initialiser visited as nullable when freed; a never-returning call or an
  always-jumping block ends its statement list; arguments spilled in order where it refused. corpus/lower/exc: 82 of 83
  programs print in `rc` and agree (exc_paths.ts stops at the map runtime); live counts after each case in two rounds at
  -O0/-O1/-O2 are only what module state keeps. **Forced only** (`AUTO_RC_EXC`): throws are 1.15–1.35× the direct route.
- **Coverage, `rc`:** 25 / 153 / 42 (exactly / reshaped / blocked) from 23 / 69 / 125; the exceptions blocker (84) is gone,
  83 of them now reshaped and one at the map runtime (9). `leak`, `manual` and `strict` unchanged but for the three probes.
- **Pins:** 112 of 3,862 moved, all by the libraries (`rcAllocSteps` is an export of `@tsl/gc`, which 14 `rc` programs without
  maps link and keep); none by printing, expansion or exceptions (tools/r11-moved.ts).
- **Injected bugs:** nine, all caught (pipe-d box 42, tools/r11-tests.ts).
- **New boxes:** pipe-d 38 (maps), 39 and 40 (exceptions, the generated programs apart and two at a time: four at once under a
  gate's load ran both routes past the 60 s image limit), 41 (live counts), 42 (bugs).
- *Rejected:* tables in the counted heap (above); `@tsl/jsrt` importing `@tsl/gc` (it would link the counted heap into every
  `leak` program with a map); switching exceptions on at 1.15–1.35×.

**Owner's request: a parallel side project for a macOS (Apple Silicon) Mach-O target.** Phase 1 is a native executable that runs on this Mac and prints what the QEMU target prints. It follows D56/D57 as proposed: our own Mach-O object writer, the system `ld` (which also signs it), libSystem for output, memory and exit, and a signal handler turning faults into traps.
- **Its own copy of the tree,** at `~/projects/ts-microkernel-macho`. The repo has no commits, so a git worktree would start empty, and new files in the main tree would break R11's gate manifest. The agent lists every file it adds or changes in `MACHO_CHANGES.md`, and I merge after R11 is verified, then gate.
- **Light on the machine:** native runs only, no gate or milestone runs, so R11's single-heavy-job rule still holds.
- The bare-metal output must stay byte-identical.
- *Rejected:* waiting until the pile is done. Phase 1 touches only the backend's output format and a hosted runtime, not the pipeline, and it gives a fast native test loop.

**Phase 1 done** (in the copy, not merged): 1,316 programs and all their cases pass natively in about 5.5 min with no QEMU. Bare-metal images are byte-identical (132 hashed before and after). I built and ran one myself.

**Owner's direction (2026-11-15):** "if they're functionally equivalent then we should be able to test on macOS and then eventually test on the microkernel's userspace." **Decision:**
- **Native macOS becomes the fast lane for user-space code:** the corpus, lowered TS and the standard library. It's added as a tier, with QEMU kept for what only bare metal can test: the kernel, `strict`/`noStd` kernel code, devices, interrupts, page tables, and the speed rule's timed runs on Apple's virtualisation.
- **Equivalence is measured, not assumed.** Before any QEMU job moves to the native lane, both lanes run the same programs and their outputs are diffed. Raw addresses are the one known, expected difference (guest memory below 4 GiB, a macOS heap above it). Any other difference blocks the move. That diff stays as a periodic check.
- **Later:** the same suite runs as user-space programs on our own kernel, as the third target for the same tests.
- *Order:*
  1. Merge after R11 verifies.
  2. A like-for-like timing of QEMU against native on the same 1,316 programs.
  3. The equivalence diff.
  4. Then the `tmk test` tier.

## 2026-12-13

**R10 is built (builder's report; for the coordinator to verify).** Strings in `rc` through the TSL route, and a diagnosis
of the two cells that sit at 1.00×. Nothing was added to TSL.
- **Strings in `rc`** are two classes the printer puts in the program itself, `JsStr` and `JsStrBuf`
  (compiler/host/emit-rcstr.ts), the way an array's holder is printed, so tslc's `rc` expansion counts them like any other
  class: one counting implementation. A flat string's units are its own tail; a view reads a run of a concatenation's
  buffer. The buffer holds nothing, so strings can't be in a cycle and are never collector candidates; objects in cycles
  that hold strings are freed with them. Units are read, copied and hashed through the tails' own slices, so nothing is
  unsafe. By design, a substring of a flat string copies, and a one-unit string is made each time.
- **The ABI:** a string crosses as a `JsStr` at a newly published layout (`DownMeta.rcStr.layout`); D36's couldn't be kept
  because `rc` packages have no dispatch interface or unsafe module. Counted by R8's pattern: `__rc_retain_str` and
  `__rc_release_str`.
- **Not in `auto`** (`AUTO_RC_STRINGS` off): 1.54–2.34× the direct route at -O1 and -O2 (two runs, load 5.8–6.6). The
  cost is allocation: 1,374 counted allocations to 877 in the scan benchmark (one-unit strings), each dearer, plus zeroing
  each tail before it's copied into.
- **The 1.00× cells:** the boundary benchmark's hot functions are the same machine code through both routes, instruction for
  instruction; the only difference is 0.24% more instructions making the 64 bodies (`JsArray` push and grow). So level is
  the expected outcome, and no cleanup of printed code can put it under. The typed-array cell is 69% the same `__frem.f64`.
  The TSL route saves the direct route's zeroing and pays in the boolean sieve: a byte compare on read, a second bounds
  check on write, an unrotated loop and a 2^53 check in `push`. Nothing fixed, because folding the write's check moves
  every printed array's pins and wouldn't move the boundary cell.
- **Refused by name in `rc`, with the direct route building them as before:**
  - exceptions (84 programs now stop there, having first reached them once strings printed);
  - compiler/rt's map runtime where a map can't be a `JsMap` (8 programs; new with strings, and it broke drop_moving.ts).
- **`RC_TSL_ROUTE_OOM` widened** to corpus/lower/strmap/rc_churn.ts. Its sets of numbers, not its strings, run out:
  `JsSet`'s tables come from @tsl/std, so building them does no counted freeing steps. **This is a real gap in `auto`'s maps
  in `rc`**: a program churning sets alone would run out through `auto`'s route where the direct route doesn't. For the
  coordinator to judge, like `RC_TSL_ROUTE_OOM` before it.
- **Coverage, `rc`:** 23 / 69 / 125 (exactly / reshaped / blocked) from 23 / 49 / 144. `leak`, `manual` and `strict` unchanged but for rc_strings.ts.
- **Pins:** 8 of 3,862 moved, all a dead `return 0;` no longer printed in two `rc` programs (tools/r10-moved.ts).
- **Injected bugs:** six, all caught (tools/r10-tests.ts, pipe-d box 37; boxes 35 and 36 are the dual route and the counts, split three ways to stay well under the 3 GiB watchdog after one job hit it in a gate). SPEC's R9 record count corrected to 23,262 of 23,268.
- *Rejected:*
  - keeping `JsString` in @tsl/jsrt with hand-written counts (a second counting implementation);
  - one string class whose views point at strings (a type-graph cycle, so every string would be a collector candidate);
  - getting the hash through an address (doesn't run on the host).
- *Next (proposed):* exceptions in `rc` (84 programs); then maps' tables in the counted heap (rc_churn.ts, and `auto`'s gap);
  then a one-unit string table and unzeroed tails for strings in `rc`.

**Coordinator: R10 verified** (manifest MATCH, sample 8/8, seed 10391; gate at the default width of 4, 258 jobs). The 1.00× diagnosis is convincing: the boundary's hot code is identical machine code on both routes, so `AUTO_BOUNDARY` can't go under 1.00 by tuning the printer. It waits until the direct route is retired (item 11). I confirmed the set-churn gap in the code: in `rc`, `auto` prints maps and sets as `JsMap`/`JsSet` under `AUTO_RC` (tslc.ts, the `maps` choice), and their tables come from `@tsl/std` outside the counted heap. **That's a gap in something already switched on (since R4), so it outranks coverage.** I don't accept `rc_churn.ts` in `RC_TSL_ROUTE_OOM` as permanent.

**Decision: R11 fixes `auto`'s maps and sets in `rc`, then exceptions in `rc`.**
1. Put `JsMap`/`JsSet` tables under the counted heap's freeing steps in `rc`, so churning maps or sets frees as the direct route does. Either the tables become counted (a tail, as strings do) or allocating a table does the D39 freeing steps. Add the sets-only probe as a permanent test through `auto`, and remove `rc_churn.ts` from `RC_TSL_ROUTE_OOM`. Re-measure the `rc` maps benchmarks: if they go over 1.00×, `auto` stops printing maps in `rc` (sending them back to the direct route) until they're under. Correct first, then fast.
2. Exceptions in `rc` through the TSL route (84 programs).
- *Rejected:*
  - Leaving the gap for a later round: it's switched on today.
  - Turning maps off in `auto` for `rc` straight away, without trying the fix. That stays the fallback if the fix measures slower.

## 2026-12-12

**R9 is built (builder's report; for the coordinator to verify).** Pile item 8 in `leak` and `manual`, through the TSL route,
desugared into TSL with nothing added to TSL.
- **A typed array made in a function** is a view of an object's storage, as TSL makes one: a layout class's `array(i32, 8)`
  for a constant length up to 64 KiB (`new Int32Array_8().items`), a tail otherwise (`withTail(n, new Float64Array_n()).items`).
  tslc places them: the stack where escape analysis allows, the heap where a view outlives its function (escape.ts now follows
  a view's pointer, and a pointer kept as an integer moves its object off the stack), and the per-call region for a heap object
  no export call outlives (region.ts now follows views, and takes objects with tails).
- **Module state that's a typed array** is R7's runtime class in a static object. **Arrays of booleans and of nothing** are
  `JsArray<u8>`; D36's boolean slot was already 1 byte, so no layout moved.
- **Not in `auto`** (`AUTO_R9` off): the new benchmark, in two quiet runs (load 4.3–5.5), is 0.990–1.006× (-O1 `leak` 1.000,
  0.990; `manual` 1.006, 0.993; -O2 `leak` 0.999, 1.002; `manual` 1.006, 1.002): level, but three cells over 1.00. 0 of 3,862
  pins moved.
- **Coverage, `leak` and `manual`:** 59 / 138 / 14 from 54 / 118 / 37. `rc`: 23 / 49 / 144 from 20 / 47 / 147.
- **A named difference** (`AFTER_EXHAUSTION`): exhaust_drains.ts's last case in `leak` and `manual`, after both routes ran
  out of memory, fits in one route's leftover heap and not the other's. Counted apart, never as agreeing. For the owner to
  judge, as R8's `RC_TSL_ROUTE_OOM` was.
- *Rejected:* a `bool` element descriptor for `JsArray<bool>` (extends TSL; bytes say the same); printing typed arrays in a
  function through `@tsl/lowered`'s `alloc` as phase 1 does (not TSL proper); per-flow-class holder classes (finer region
  placement, more classes; class-level is sound and level in the benchmark); typed arrays in `rc` (a view of a counted object
  needs the holder counted while the view lives: a design of its own).
- *Next (proposed):* strings in `rc` (R10), as planned; then a vector of typed arrays and typed arrays in `rc`.

**Coordinator: R9 verified** (manifest MATCH, sample 8/8, seed 9437; gate at the default width of 4, 255 jobs). I accept `AFTER_EXHAUSTION` on the same terms as `RC_TSL_ROUTE_OOM`: it's named and counted apart, never as agreeing, and should be emptied later. Things noted for later:
- **Negative typed-array lengths:** `new Float64Array(-1)` traps out of memory on both routes, where JS throws a `RangeError`. That predates R9, and the builder only removed the case from its own new test. It's a semantic gap to add to the D48-style list, not a regression.
- **A stale count in SPEC.md's R9 record:** 23,268 of 23,274 should read 23,262 of 23,268. Fix it at R10's SPEC edit; SPEC.md is part of the manifest, so it can't be changed after a gate.
- **A pattern across rounds:** `AUTO_BOUNDARY` (R7) and `AUTO_R9` both sit at about 1.00×, level but not under. Both pass through the same boundary and view code, which suggests one shared cost rather than noise.

**Decision: R10 is strings in `rc`, plus a diagnosis.**
1. Print `JsString` in `rc`, counted the way R8 counts objects: literals, building, crossing an export, and string fields. This unblocks the 18 programs stopped at a string crossing, plus the string literals behind much of `rc`'s 144.
2. Profile (`tmk profile --instructions`, TSL against direct) the cells that sit at 1.00×: the boundary in `leak` at -O1 and R9's typed arrays at -O2. Report where the extra instructions are. Fix the cause only if it's small and general; otherwise report it, and it becomes the next round's opener.
- *Rejected:* forcing either switch on at "level". The rule says no slower, and noise of ±1% doesn't count as under.

## 2026-12-11

**R8 is built and verified** (manifest MATCH, sample 8/8, seed 8291). The gate passed from clean at the default width of 4, at load 47–83, with nothing rerun, so the headroom work did its job.
- **Counted objects cross an export in `rc` through the TSL route.** Ownership is unchanged from the direct route: a result's count is the caller's, arguments are borrowed, and the caller gives back each count it holds. The caller's functions are printed as plain TSL, so the `rc` expansion counts them like any other code and there is still one counting implementation:
  - `__rc_place_<id>` is `return new C()`;
  - `__rc_retain_<id>(p)` is `return p`;
  - `__rc_release_<id>` is an empty function whose parameter is taken over with `@tsl.moves`.
- **A counted reference is now a plain address,** with no generation in its top 16 bits. Since R1b and R1f, no check reads that generation for classes the expansion counts, so this is sound. `Weak` and `count` read from the slot instead. 24 pins moved, all `rc` builds through the TSL route. **Owner review:** this is part of the open "generation-check boundary" flag, and `@tsl.moves` on a counted parameter widens what an `rc` package may write.
- **Not in `auto`:** the `rc` boundary benchmark is 0.97/1.05× at -O1 and 1.17/1.18× at -O2. `rc`'s own benchmarks stay under 1.00× in every cell.
- **Headroom, with no limit moved:**
  - `frag.ts` on JSC: 64 s → 28 s. The host simulation of `@tsl/unsafe` scanned every memory region on each address lookup; it now uses a sorted search with a last-hit cache.
  - lang-a box 5 runs 2 suites at once instead of 4: 2.78 GB → 1.86–2.2 GiB.
  - Four jobs still sit at about 2.05–2.22 GiB against the 3 GiB watchdog: native-e box 3 at -O2, test/23, lang-a box 10 and native-d box 4 at -O0. If the gate flakes again, these are the first suspects.
- **A named exception:** `region.ts` runs out of memory through the TSL route in `rc` only (`RC_TSL_ROUTE_OOM`). Its `grow` case runs out by design. The direct route made those objects in the arena, which the next case resets, but counted objects held when a trap happens stay held. I accept this for now because it's a test-harness artefact of traps ending a case, not a leak in a program that runs to completion. It should be emptied, as R6 emptied `TSL_ROUTE_OOM`.
- **Coverage:**

  | Mode | Exactly | Reshaped | Blocked |
  |---|---|---|---|
  | `leak` | 54 | 118 | 37 |
  | `manual` | 54 | 118 | 37 |
  | `rc` (from 17 / 40 / 156) | 20 | 47 | 147 |

  The counted-object blocker went from 35 programs to 0. Most of those now stop at a string crossing an export (18), because `rc` doesn't print strings.

**Decision: R9 is pile item 8, as planned:**
1. typed arrays made inside functions, including number-to-text;
2. module state that's a typed array;
3. arrays of booleans and of `void`.

These are the main blockers left in `leak` and `manual` (about 23 programs), and they show up in `rc` too.
- *Next:* strings in `rc` (printing `JsString` counted the same way; 18 programs at the boundary, plus the string literals behind many of `rc`'s 147), then pile item 7. I'll also profile `rc`'s boundary benchmark at -O2 then.
- *Rejected:* doing strings in `rc` first. It's the bigger `rc` win, but it touches the same printer paths as item 8's typed arrays. Item 8 is smaller, already planned, and clears most of what's left in `leak` and `manual`.

## 2026-12-10

**R7 is built and verified** (manifest MATCH, sample 8/8, seed 6113). One deviation: the passing gate ran 3 jobs at a time, not the default 4. The two default-width runs each lost one job to load or memory, not to R7. `frag.ts`'s printed TSL on JSC ran past 120 s at load 40–100 (65 s when quiet, and byte-identical with R7 off). lang-a box 5 hit the 3 GiB watchdog (2.78 GB alone, and 2.85 GB without R7). No limit was relaxed. I accepted the run because the manifest checks the tree, not the width, but a gate that only passes at width 3 is a problem to fix, so it's in R8.
- **Bounds check proved by the loop's own test** (`compiler/tir/passes/loopbounds.ts`, -O1): this is for all TSL, and moved the -O1 pins of 9 hand-written TSL programs plus lowered ones. -O1 compile time is 1.13× -O0, against the 1.25× limit.
- **The null check left to the next load is in the AArch64 backend, not the optimiser.** The fault didn't give the same trap everywhere: outside a test case it's a fatal report, and on Wasm a load near 0 doesn't fault. So the image lists the loads that stand in for a check (`__rt_null_pcs`), and the fault handler turns a fault at exactly such a load into the check's own trap 6. Anything else reports as before. The TIR is unchanged.
- **Effect:** JPEG is unchanged within 0.3% (code 160 bytes smaller). S4 median vs clang is 1.178× (1.175× off), and sha256 0.542 ms (0.552 ms off). The `rc` ratios are unchanged.
- **`AUTO_BOUNDARY` stays off.** The cells are 0.965–1.022× in time and 0.996–1.002× in instructions: level, but not under 1.00 in every timed cell. The direct route also gained from the null change, so -O2 lost R6's lead. Run-to-run noise is larger than the gap, so another cleanup won't settle it. It switches on when some later change gives the TSL route a real margin.
- **Optional scalar and typed-array fields print**, as a flag plus a value and as a runtime class held in place, at D36's offsets. They also print crossing an export.
- **Maps and sets cross an export** as `JsMap` and `JsSet`. Their layout is published in the build metadata for native callers. `move_ops.ts` now prints, with 540/540 cases agreeing.
- **Fault counts:** `rcTslFaultRun`, `gcFaultRun` and `r2FaultRun` report `answers`, which the sampler compares exactly. Box 21 reads 223.
- **Pins:** 40 of 3,862 moved (30 loop bounds, 10 `class_struct.ts` taking the TSL route), listed in `tools/r7-moved.ts`.
- **Coverage, `leak` and `manual`:** 53 printed exactly, 118 reshaped and 37 blocked, from 51 / 113 / 44. R6's "50" was a rounding error: the builder's recount gave 51. `rc`: 17 / 40 / 156.

**Decision: R8 is `rc` handles at the boundary, plus gate headroom.**
1. Objects held by `rc` crossing an export: printed counterparts of `__rc_new`, `__rc_retain` and `__rc_release`, so a native caller and the printed TSL agree on who owns what. This blocks 35 programs.
2. Make the two load-sensitive gate jobs lighter, so the default 4-at-a-time gate passes again: `frag.ts`'s JSC run and lang-a box 5's memory. Do it by making the work smaller or splitting it, not by raising limits, and without dropping what they check.
- *Next:* pile item 8 (typed arrays made inside functions, 8 programs; module-level typed arrays, 5; arrays of void, 6, and of booleans, 4), then item 7.
- *Rejected:* forcing `AUTO_BOUNDARY` on at "level". The rule says no slower, and two timed cells were over.

## 2026-12-09

**R6 is built and verified** (manifest MATCH). The sample matched 7 of 8. The eighth was pipe-d box 21, where an injected bug was caught by 410 cases against 223. Rerun alone on a quiet machine it gave 223, matching the manifest. The count includes cases that run out of time when drops are left out, so it depends on load: the same kind of false alarm R2 fixed for another suite.
- **D36 now uses TSL's own layout,** per the owner's ruling. A `bool` is 1 byte, and an optional scalar is a flag then its value. R5's padding is gone.
  - 1,073 pins moved across 117 programs, each checked to lay out a `bool`, a re-rounded size or an optional scalar.
  - The 343 pins of hand-written TSL are unchanged, and there's no kernel package yet.
  - The direct route stays within 1.5% everywhere, and JPEG and S4 within 0.5%.
- **Array reads:** a bounds-checked read prints as `v.get(i)` alone. That brought the boundary benchmark to 0.91× at -O2 and 1.005–1.015× in `leak` at -O1. So `AUTO_BOUNDARY` stays off; what's left is a bound the loop's own test already ensures, and a null check before a load that would fault anyway.
- **The per-call region** (`compiler/host/region.ts`): tslc places allocations of classes nothing long-lived can reach in the module's call arena, which is given back at each export's return. The printed TSL has no annotation. The analysis works class by class, so it's coarse but sound, and an injected bug that puts an escaping class in the region is caught.
  - `cyc_churn.ts` now agrees, and `TSL_ROUTE_OOM` is empty.
  - One slower cell: strmap word count, `manual`, TSL route, 1.03×. Maps aren't `auto`'s choice there.
- **Closures are on in `auto` for `leak` and `manual`.** The builder's eight runs had two single runs over 1.00, so I re-measured it myself: three full runs at each level, load about 5, gave 0.97–1.00× in every cell. Accepted.
- **Coverage, `leak` and `manual`:** 50 printed exactly, 114 reshaped and 44 blocked (R5: 40 / 111 / 54). The closure blocker went from 22 to 0.

**Decision: R7 finishes the boundary in `leak` and `manual`.**
1. Two cheap -O1 cleanups, which help all TSL: drop a bounds check the loop's own test already proves, and drop an explicit null check when the next load faults with the same trap. Stay within -O1's compile-time limit. Then switch `AUTO_BOUNDARY` on if it meets the rule.
2. Print optional scalars as two fields, and typed-array fields as a runtime class. Their layouts are ready.
3. Maps and sets crossing an export.
4. Make the load-dependent fault counts (box 21's `rcTslFaultRun`, and any like it) compare only results that don't depend on load, as R2 did for `faultRun`.
- *Next:* `rc` handles at the boundary (30 programs), then pile items 7–8.
- *Rejected:* doing `rc` handles in the same round. They need printed counterparts of `__rc_new`, `__rc_retain` and `__rc_release`, which is a separate design.

## 2026-12-08

**R5 is built and verified** (manifest MATCH, sample 8/8). The builder was interrupted twice by API authentication errors and resumed cleanly.
- **What prints now:** exported functions taking or giving objects print as TSL classes in `leak` and `manual`. Arrays crossing the boundary are `JsArray`s, which a caller places with the module's own `__vec_place_<id>`.
- **Coverage:** in `leak` and `manual`, 9 of the 23 programs it blocked now print. 7 stop at boundary parts not yet built (maps and sets, optional fields, typed-array fields). The new `tools/route-blockers.ts` counts blockers in every mode.
- **Speed:** the new boundary benchmark is 1.00–1.01× at -O1 and 0.99–1.00× at -O2. Leak at -O1 misses by under 1%, from bounds and null checks repeated on array reads that -O2 merges. So `AUTO_BOUNDARY` stays off.
- **No pins moved.** All 4 injected bugs are caught.
- **Found:** closures aren't really what's missing in `leak` and `manual`. The TSL route has no call arena at all, so any churny program printed by classes can run out of memory where the direct route doesn't. 4 of the 6 failing `cyc_churn.ts` functions have no closures.

**Correction to R5:** it kept D36's old layout, with padding fields to match. The owner ruled otherwise on 2026-11-09 (D62): "lowered objects take TSL's own layout rules, with no lowered layout (a `bool` its TSL size, …), so D36's published layouts change to match, nothing having shipped." The builder flagged this rather than hiding it. But the ruling is explicit, so R6 follows it.

**On the call arena:** I checked the same ruling. Placement is "tslc's own escape analysis with no annotation beside `new`, the mode saying what the heap is, and the call arena retired for lowered code if that measures no slower." tslc placing provably call-bounded allocations in a per-call region is that escape analysis, so it's within the ruling. It needs no owner decision. Retiring the arena for lowered code stays conditional on it measuring no slower.

**Decision: R6.**
1. D36 moves to TSL's layout. The direct route's `layoutOf` changes, the padding goes, and pins are re-pinned with the reason stated.
2. Remove the duplicate array-read checks at -O1, then switch `AUTO_BOUNDARY` on if it meets the rule.
3. tslc places allocations its escape analysis bounds by the export call in a per-call region in `leak` and `manual`. Then switch closures on there where they're no slower, and drop `cyc_churn.ts` from `TSL_ROUTE_OOM`.
- *Deferred:* `rc` handles at the boundary (30 programs), and maps and sets crossing it. They come next, once the layout question is settled.
- *Rejected:* keeping D36's layout because it's cheaper now. It contradicts a ruling, and keeping it only adds callers that would need to move later.

## 2026-12-07

**R4 is built and verified** (manifest MATCH, sample 8/8). **`AUTO_RC` is on.** All 14 cells meet the rule in two quiet runs, and the printed TSL passes on V8 and JSC. Pile item 4 is done.

| Lowered `rc`, TSL ÷ direct | -O1 | -O2 |
|---|---|---|
| list | 0.71× | 0.79× |
| churn | 0.88× | 0.98× |
| cycles | 0.94× | 0.92× |
| arrays | 0.70× | 0.91× |
| acyclic | 0.92× | 0.88× |
| number / object-keyed maps | 0.97× / 0.96× | 0.98× / 0.98× |

**The changes:**
- New rooms are zeroed only past what's copied in.
- Leaf objects are given back as soon as their last count goes, when the budget has a step to spare. D39's per-step bound still holds: one step per block given back, one per slot visited.
- Small release functions and `@tsl/gc` helpers are inlined at -O1. -O1 compile time is 1.12× -O0, against the 1.25× limit.
- In the backend (all TSL), small 4-byte-remainder copies are inlined.
- `JsMap.grow` now allocates before it moves anything, with a test.
- Box 28's exception is pinned to `cyc_churn.ts` by name.

**Notes:**
- `auto` takes the TSL route only for programs the printer prints exactly. Cycles, arrays and acyclic meet the rule but are reshaped, so they stay on the direct route until pile item 9.
- 50 pins moved (13 programs), all because `auto` now builds them through the TSL route. They're listed in `tools/r4-pins.ts`.
- Box 26 now re-measures a quick cell over 1.00 with the full settings before it counts. I checked it: a failed re-measure still fails, so the rule isn't loosened.

**Decision: R5 is pile item 6,** exported functions taking or giving objects, with D36 layouts moved and listed. It's the largest blocker (30 programs). Closure environments freed in `leak` and `manual` ride along, so closures can switch on there.
- *Rejected:* item 9 (reshaped programs) first. It moves three benchmarks onto the TSL route, but item 6 unblocks ten times as many programs.

## 2026-12-06

**R3 is built and verified** (manifest MATCH, sample 8/8). The first R3 builder stalled overnight: its helpers' completion notices reached me and I didn't pass them on. A second builder finished it from the tree.
- **Closures as values** print through the TSL route in `rc`: environment classes, a `kind` field and a call that tests it. A changed capture becomes a shared cell class. The cycle collector frees cycles through environments, and the cycles benchmark now prints.
- **Arrays in `rc`** are one counted allocation (`JsRoomArray`, in a new module, `packages/tsl-gc/ex-gc-roomarray.ts`) until they outgrow their tail.
- **`@tsl/jsrt`'s bookkeeping** is freed in `rc`. That turned out to be every map's four arrays, not just the old table, plus cursors and generations.
- **The store-order bug** was really tsc's narrowing being trusted after a reassignment. Fixed in the lowering.
- **Coverage:** 45 lowered `rc` programs build through the TSL route, the same as direct. All 12 injected bugs are caught.

| Lowered `rc`, TSL ÷ direct | -O1 | -O2 |
|---|---|---|
| list | 0.77× | 0.84× |
| churn | 0.95× | 1.02× |
| cycles | 1.00× | 0.98× |
| arrays | 0.84× | 1.07× |
| acyclic | 1.10× | 0.99× |
| number / object-keyed maps | 1.04× / 1.06× | 1.00× / 1.01× |

- **`AUTO_RC` stays off:** 6 of 14 cells miss.
- **The causes, by instruction counts, are all in freeing and room handling:**
  - a new room is zeroed whole, then copied over;
  - at -O1, `giveBack` and the release functions aren't inlined;
  - churn's 2% is in `@tsl/gc` itself.
- **Closures stay off in `leak` and `manual`** for a correctness reason. The TSL route never frees an environment, where the direct route's call arena does, so `cyc_churn.ts` runs out of memory through the TSL route alone.
- **The two suspected compiler bugs:**
  - The -O2 `||`-chain bug couldn't be reproduced, so the workaround stays.
  - The `manual` trap 2 isn't memory corruption. `JsMap.grow` moves its buffers aside before allocating, so running out of memory partway leaves the map broken for the next case.
- **Box 28** accepts out-of-memory through the TSL route anywhere in `corpus/lower/rc/`. That's narrow, but wider than the one known file.

**Decision: R4 is a short `@tsl/gc` freeing round aimed at `AUTO_RC`.**
1. Zero only the part of a new room that isn't copied into.
2. Cheaper freeing of arrays of plain objects, within D39's per-step bound exactly.
3. Get `giveBack` and the release functions inlined at -O1, within -O1's compile-time limit.
4. Churn's `@tsl/gc` code shape.
5. Make `JsMap.grow` allocate before it moves anything.
6. Pin box 28's exception to the named file.

Switch `AUTO_RC` on if all 14 cells meet the rule.
- *Why now:* every remaining miss is in one small area of the runtime, and switching `rc` on completes pile item 4.
- *Rejected:* moving on to item 6 (exported object functions) and leaving `rc` for later. That's 30 programs blocked, and the biggest coverage gap, but the `rc` switch is one short round away.
- *Next after R4:* item 6, with closure environments freed in `leak` and `manual`.

## 2026-12-05

**R2 is built and verified** (manifest MATCH, sample 8/8). Lowered `rc` programs build through the TSL route when it's forced. That's 34 programs, the same through both routes. The printed TSL runs on V8 and JSC for all 34, and 14 injected bugs are all caught. Maps of counted objects neither leak nor free twice. The sampler's caught-count false alarm is fixed.

| Lowered `rc`, TSL ÷ direct | -O1 | -O2 |
|---|---|---|
| list | 0.77× | 0.84× |
| churn | 0.95× | 1.03× |
| arrays | 0.93× | 1.14× |
| acyclic | 1.40× | 1.23× |
| number / object-keyed maps | 1.05× / 1.05× | 0.99× / 1.01× |
| cycles | doesn't print (needs closures as values) | |

- **Nothing switched on** (`AUTO_RC` is off).
- Churn's 3% at -O2 is in `@tsl/gc`'s own code shape, not the printing; profiled.
- Arrays and acyclic are slow by design. Array buffers live in `@tsl/std`'s heap, and freeing an array makes one release call per element.
- **Found:**
  - a direct-route bug: `p.next = ((p = q), new P(…))` stores through the wrong object, in `strict` and `rc`;
  - `@tsl/jsrt`'s bookkeeping isn't freed in `rc`: cursors, generations, and each map's first old table.

**Decision: R3 is one round covering pile item 5 (closures as values) and array buffers in the counted heap,** an array becoming a counted class with a tail (D69). Two small fixes ride along: the direct-route store bug, and freeing `@tsl/jsrt`'s bookkeeping in `rc`. Then re-measure all the lowered `rc` rows, and switch `AUTO_RC` on only if every row meets the rule.
- *Why together:* cycles needs closures before it can print, and arrays and acyclic need the buffer change. Both must land before `rc` can switch.
- *Rejected:* switching `rc` on per benchmark. The switch is per mode, so a program would silently get the slower route.

## 2026-12-04

**B3 is built and verified** (manifest MATCH; sample 7 of 8 the same, the eighth a known false alarm, below). All five backend changes landed, and the direct route and the kernel get them too.

| TSL route against direct (time) | -O2 | -O1 |
|---|---|---|
| `rc` list | 0.83× (0.91) | 0.76× (0.84) |
| `rc` churn | 1.03× (1.15) | 0.94× (1.06) |
| `rc` cycles | 0.97× (1.03) | 0.98× (1.06) |
| String appends | 1.14–1.25× (1.28–1.36) | 1.18–1.22× |
| Maps | 0.99–1.22× | 0.99–1.29× |
| Exceptions | 0.94–1.07× | 0.88–1.03× |

- JPEG went from 1.10× to 1.08× V8's time, with code 4% smaller. The S4 median was flat, at 1.13× clang's time.
- Nothing switched on. `rc` waits on R2. Strings and maps still miss the rule, and exceptions print together with strings.
- The builder found the native corpus suites had been testing -O0 code at every level, because TIR text doesn't carry the level. That's fixed with `.opt` files.
- A new test, `corpus/rc/rc_steps_nocc.ts`, pins the freeing bound with no collector linked.
- **The false alarm:** native-g box 6's "named allocator ignored" injected bug counted 3 catching cases against 17 in the manifest. `tools/std-tests.ts` already explains why: under load at -O0, one image times out and 14 more cases count as caught. The load-independent count (`answers`) was 3 both times. The sampler compares the wrong field, so that's queued as a fix in R2's housekeeping.
- **Still open:** churn at -O2 (1.03×), appends, the map gaps, `vec_push` (cause not found), and `sort` 2% slower.

**Decision: R2 next,** as planned: lowered `rc` programs build through the TSL route, with JsMap slot clearing ported. The switch-over conditions are the speed rule at -O1 and -O2 and the third route on V8. If churn at -O2 still misses, R2 diagnoses it with `tmk profile` rather than switching anyway.
- *Rejected:* another backend round first. The remaining gaps are small and scattered, with no shared cause shown, and R2 is what unblocks the pile.

## 2026-12-03

**R1f is built and verified** (manifest MATCH, sample 8/8). The profile showed the gap was code generation for bit arithmetic: divisions by powers of two, and guarded shifts by constants. It wasn't the collector's logic, whose steps match the direct route's within 5%.
- **Two new optimiser rules** (a strength reduction in `simplify`) help every TSL program.
- **Then measured `@tsl/gc` fast paths.**
- **The new `tmk profile` tool** gives time sampling on HVF and exact instruction counts on TCG.

| Benchmark, TSL `rc` against direct | Time at -O2 | Instructions at -O2 | Time at -O1 |
|---|---|---|---|
| List | 0.91× | 0.70× | 0.83× (meets the rule) |
| Churn | 1.15× | 0.99× | 1.05× |
| Cycles | 1.02× | 0.96× | 1.06× |

What remains is code shape in the backend, not instructions. The same backend causes showed up in earlier steps:
- global reads at three instructions each;
- compare results turned into values before a branch;
- spills of invariant values (string appends);
- branch layout (`vec_push`);
- weak inlining at -O1.

**Decision: one backend round next (B3), aimed at those shared causes, before R2.**
1. Cheaper global access.
2. Fusing a compare into its branch when the result is only branched on.
3. Rematerialising invariant or cheap values instead of spilling them.
4. A loop-layout pass with fewer taken branches.
5. Revisiting -O1's inlining for small hot callees, within -O1's compile-time limit.

Each is measured with `tmk profile` on churn, cycles, string appends, `vec_push`, S4 and JPEG. Plus the test gap R1f found: unbounded freeing with no collector linked is caught by nothing.
- *Why now:* one round lifts several held-back features at once and helps all TSL, kernel included. R2 needs churn and cycles under the rule anyway.
- *Rejected:* starting R2 now and switching it on later. That's possible, but it piles up more held-back work behind the same cause.

## 2026-12-02

**R1e is built and verified** (manifest MATCH, sample 8/8).
- **The decision as written in my 2026-12-01 entry was unsound.** Edges a scan had already counted *from* a given-up object stay counted, so a target could be decided garbage while still referenced, then freed twice. The builder built that as an injected bug, and the tests catch it.
- **The fix:** the scan makes no decision while anything it gave up still has references to drop. With it, D41's argument holds, written as case (6) in 3.5.
- **The direct route had the same latent fault** under its existing one-free-per-allocation rule. It's fixed the same way, with its own test.
- 158 of the direct route's `rc` tirhash pins moved at -O0 and -O2 because its runtime changed, not because of an optimiser level. `tools/r1e-pins.ts` shows the old runtime reproduces them all.

| Benchmark | Before R1e | After R1e |
|---|---|---|
| List | 1.56× | 1.10× |
| Churn | 1.18× | 1.62× (the scan uses freeing's leftover budget on live objects) |
| Cycles | 1.55× | 1.48× |

**For the owner's review:**
- D41 now has the decision-wait rule.
- My first version of the rule was wrong, and the written-proof requirement caught it before shipping. That's the process working, but worth knowing.

**Decision: R1f profiles the collector's per-step cost rather than guessing.** Two guesses in a row were wrong: the indirect call (R1c) and the per-slot reloads (R1d). R1f then fixes what the profile shows, aiming to bring churn and cycles under the speed rule. It reuses the PC-sampling profiler built in the class-id round (/tmp/clsid), and the profiler is brought into the repo as a tool if it proves useful. R2 follows.

## 2026-12-01

**R1d is built and verified** (manifest MATCH, sample 8/8). Wound down after it as the owner asked, and resumed about 5 hours later.

TSL `rc` against the direct route with its collector on, -O2:

| Benchmark | Before R1d | After R1d |
|---|---|---|
| Churn | 2.03× | 1.18× |
| List | 1.62× | 1.56× |
| Cycles | 1.51× | 1.55× |

- **Release dispatch by class:** gained little. The indirect call wasn't the cost R1c estimated.
- **The pacing rule removed:** that's where churn's gain came from. Pacing is proved to keep up by a new test switch, under which needing the heap walk traps.
- **A new unreached-function pass:** at -O2, compiled functions went from 7,142 to 2,322 and code from 32% to 49% smaller across the measured corpora. Acyclic programs no longer carry the collector.
- **Not kept: one free per allocation.**
  - It fixed the list (1.12×) but broke `rc_shared.ts`.
  - The cause, diagnosed: a scan holding a list that's being freed, because a node whose count reached zero mid-scan stays in the scan.
  - The real fix needs D41 to let a scan give up such an object.

**Decision: let a scan give up an object whose count reaches zero during the scan, then keep one free per allocation.**
- *Condition:* the builder must first write the soundness argument into 3.5 and check it against D41's.
  - An object with count zero has no counted references.
  - Removing it from the scan can only lower other objects' edge counts.
  - So it can only make them look more "held", never free a live one. The builder must show this in the argument and with interleaving tests at every budget.
- *If the argument fails, don't ship it,* and accept the list gap until later.
- *Why decide now rather than wait for the owner:*
  - It's within the "follow your recommendations" hand-over.
  - It's reversible.
  - It's gated on a written proof plus tests.
  - The direct route already frees one object per allocation (and probably has the same latent problem, which the builder should also check).
- *Flagged for the owner's review.*

**Also in the same step:**
- inline `make`'s fast path and the candidate-table operations;
- cut the scan's per-slot reloads.

Then R2.

## 2026-11-30

**Owner, 2026-11-30: wind down after R1d completes, and continue after about 5 hours.** After R1d: verify it, log the result, start nothing new, and resume about 5 hours later with R2, or whatever R1d leaves open.


**R1c is built and verified:** D41's cycle collector now runs in `@tsl/gc` as TSL (manifest MATCH, sample 8/8).
- **Correctness:** 343 `rc` cases pass, including interleavings at budgets 1–32 and 180 weak reads at every point of a scan. The TSL fuzzer agrees with V8, and all six injected collector bugs are caught.
- **Acyclic programs:** reach identical code with the collector on or off.
- **Latency:** the median stays at 42 ns while a 100,000-node ring is collected, and no allocation does more than 32 steps.
- **A gap in R1's expansion was found and closed:** `this` passed to another `new` inside a constructor is now TSL9001.

**But churn is now 2.0–2.15× the direct route with its collector on** (4× R1b). The cyclic class makes every allocation a candidate:
- the table bookkeeping costs 0.245 ms;
- scans cost 0.545 ms, about one every 32 allocations, at about 9 ns per step through the release function's indirect call.

**Decision: fix the collector's cost (step R1d) before R2.** R2 can't switch lowered `rc` over at this speed.
- **Cheaper steps:** release and scan visits go through closed-world dispatch (D70) on the class, not an indirect call through a table.
- **Pacing:** remove the "16 times faster below 16 candidates" speed-up that makes churn scan every 32 allocations, or justify a better rule, measured.
- **Free one object per allocation when the collector is linked,** as the direct route does (D41's phase-E fix, which keeps list order). This keeps D39's per-step bound but changes TSL's pinned step counts. The direct route already does it, so matching it is "at least where it is now".
- **A pass removing unreached functions,** so acyclic modules don't carry the collector as dead code. It helps all TSL's code size.
- *Rejected:* accepting 2× on churn.

## 2026-11-29

**R1b is built and verified** (manifest MATCH, sample 8/8). TSL `rc` is now close to the direct route:

| Benchmark | Before R1b | After R1b |
|---|---|---|
| List | 1.34× | about 1.05× |
| Churn | 2.12× | about 1.1× |

- **The function-value compiler bug is fixed properly,** with a test, and R1's workaround is removed.
- **One shared counted heap:** an exhaustion test that trapped 14 on R1's design passes.
- **Generation checks are dropped, with a proof, only for classes declared in an `rc` package,** enforced by new boundary rules. Checks stay for hand-written `Rc`, `Weak` and unsafe code.
- **Also fixed:** an unswitching bug the new code exposed.

**Decision: accept the generation-check proof and its boundary rules.**
- `rc` modules can't name `Rc`, `Weak` or `Counted`, or import `@tsl/unsafe`. Modules outside `rc` packages can't hold counted classes.
- *Why:* the proof is sound only with that boundary, and user-space `rc` code needs neither raw counts nor unsafe code.
- *Cost, accepted for now:* hand-written `Rc` users, kernel code included, pay a check at every use, which is slower than R1.
- *Revisit:* if the kernel ends up using `Rc` heavily, reconsider.

**Next: R1c.**
- the D41 cycle collector in `@tsl/gc`, in TSL;
- the `rc-fuzz` TSL generator;
- the latency port;
- collector interleavings at budgets 1 to 3;
- the barrier fault.

Then R2 (lowered `rc` through the TSL route).

## 2026-11-28

**R1 (D74) is built and verified, without the collector** (manifest MATCH; sample 7/8, the difference being `native-g` box 8, a benchmark box).
- **What works:**
  - in an `rc` package, plain classes and `new` expand into explicit `Rc` calls, shown by `--emit tsl`;
  - freeing is bounded per step, with a cursor;
  - `WeakRef` never resurrects.
- **Tests:** 27 cases agree on V8, JSC and native, and all five applicable injected bugs are caught.
- **Not built:** the cycle collector, the `rc-fuzz` TSL generator, and the latency port.

**Decision: fix three problems before the collector** (step R1b):
1. **A compiler bug:** a function value written to raw memory (`ptrAt(ref<F>())`) produces invalid TIR. The builder worked around it instead of fixing it. A compiler bug gets fixed, with a test.
2. **A design regression: per-class `Rc` stores mean freed memory can only be reused by its own class.**
   - The direct route shares size classes across all classes (D39), so near exhaustion the new design fails sooner.
   - **Fix:** one counted heap of size classes shared by every counted class. A store becomes per-class description (release, step, type-graph facts), not a per-class memory pool.
   - *Rejected:* keeping per-class pools. That's worse exhaustion behaviour than today, against "at least where it is now".
3. **Speed:** lists 1.3–1.45×, churn 2.1–2.4× against the direct route.
   - **Suspects:**
     - every count operation checking the slot's owner and generation;
     - freeing through function values;
     - share-then-drop when building.
   - Diagnose with evidence. In particular, decide whether generation checks are needed on references the expansion counts. If counts are exact, a counted object can't go stale while referenced, so the checks may be droppable as D64 dropped prefixes for plain classes. That needs proof, not a guess.

Then R1c (the D41 collector in TSL, the fuzzer, the latency port), then R2.

**Hygiene, finally done properly:** rather than flag benchmark boxes one by one, `tmk gate --sample` treats any box whose detail has a benchmark header (`host: N CPUs …`) as measuring. Folded into R1b.

## 2026-11-27

**The class-id round is built and verified** (manifest MATCH, sample 8/8). Class-id loads are marked unchangeable after construction (`load.T.inv`, from a new `invariant` pass). It's mostly diagnosis; nothing switched on:
- **Appends** didn't move (1.36×). Class ids were already loaded once per object. The cost is the register allocator spilling a class test and reloading it, plus one test only the path makes redundant.
- **`vec_push`'s 16%:** branch layout in the CPU's front end, not worse code. Putting back two never-taken branches restores it.
- **Object-keyed maps (1.14×):** memory stalls on lookups that grow with table size, not the allocator. The direct route's advantage partly comes from the benchmark rewinding its arena between calls. The full cause isn't shown.

**For the owner's review: the first optimiser assumption about unsafe code.** Unsafe code must not write a live object's class id (SPEC 3.8). Until now the optimiser only relied on what it proves.
- *Why accepted:* the alternative is never sharing class tests. Writing a class id is already meaningless in safe code, and unsafe code is audited.
- *Revisit:* if the owner prefers, the `invariant` pass can be limited to classes no unsafe module touches.

**Logged as backend follow-ups, not chased now:**
- reload an invariant load instead of spilling it;
- range facts after a dispatch, to drop the repeated id test;
- a loop-layout pass, for `vec_push`.

**Decision: resume the pile with `rc` through `@tsl/gc`, as decided on 2026-11-26.** It's split into two steps:
- **R1, in TSL proper:**
  - `tslc`'s `rc` mode expands plain classes and `new` into `Rc` calls;
  - D41's pause-free cycle collector is ported into `@tsl/gc`;
  - D39's per-step freeing bound is kept exactly, with per-slot steps for large arrays;
  - `WeakRef`.
- **R2, lowered code:** lowered `rc` builds take the TSL route (the printer emits plain TSL in an `rc` package), with `JsMap` slot clearing ported. Measured against the direct `rc` route.
- *Why this order:* R1 makes `rc` real TSL that hand-written code can use, including user-space programs (D60). R2 then needs only the printer.

## 2026-11-26

**Optimiser phase B (D73) is built and verified** (manifest MATCH; sample 7/8, the difference being `native-c` box 1, whose detail text embeds a build path and output that vary, so the sampler needs a fix).

| Benchmark | Before | After |
|---|---|---|
| `sha256` against `clang` | 1.57× | 1.24× |
| `matmul` against `clang` | 3.75× | 2.62× |
| JPEG against V8 | 1.33× | 1.17×, 13% faster |
| S4 median against `clang` | 1.13× | unchanged |

**Nothing switched on.** The direct route goes through the same optimiser and gained as much, so the ratios between the two routes barely moved. Appends are still about 1.37×, object-keyed maps about 1.15×.

**One builder incident:** it ran a `pkill`, against the standing rule. It matched nothing, and it then stopped the shell by its PID. Noted, and the rule is repeated in every brief.

**Decision: accept check elimination's use of D23 (usize at most 2⁵³−1) to prove `k + 1` can't overflow under `k < n`.**
- *Why:* D23 is a spec'd invariant of the language, and every way a usize is made enforces it. Removing the check relies on a guaranteed fact, not a guess.
- *Flagged for the owner's review* in case they'd rather the optimiser rely only on TIR-level facts.

**Decision: next, a short step on the remaining causes, all shown in the machine code:**
1. Treat a class id as immutable after construction, so value numbering can share class tests across stores that can't alias it. It's a hidden field nothing writes after construction, which addresses the five class tests per append.
2. Diagnose `vec_push`, 16% slower after check elimination although its code only lost checks.
3. Diagnose the object-keyed map gap.
4. Fix the sampler for `native-c` box 1.

Then re-check the switch-over. Whatever happens, the pile resumes after that at `rc` through `@tsl/gc`.
- *Why not chase further:* each round now buys a few percent, while `rc` is the production mode and the largest remaining piece.

## 2026-11-25

**String keys for maps are built and verified** (manifest MATCH; sample 7/8, with `opt-a` box 13 matching on a rerun with enough time). The one difference is `native-a` box 14, a benchmark box whose text gains a "load is high" warning line. That's another measuring box to flag, folded into phase B.

**No map benchmark met the speed rule,** so nothing switched on:

| Map keys | Ratio at -O2, `leak` |
|---|---|
| Number | 1.05× |
| Object | 1.16× |
| String | 1.19–1.22× |

The machine code shows array lengths reloaded on every step of a lookup's chain walk, a bounds check the hash mask already guarantees, and a checked subtraction.

The builder also fixed four printer bugs, including a missing object key trapping instead of giving `undefined`.

**Decision: start optimiser phase B now.** It's in two parts, each a clean stopping point:
- **B1:** value numbering (sharing repeated loads and class tests) and loop-invariant code motion.
- **B2:** check elimination: bounds and overflow checks proved unable to fire, ranges from masks, and induction variables.

Then re-measure strings, exceptions and all four map benchmarks, and switch on whatever passes. S4, `matmul`, `sha256` and JPEG are re-measured too.
- *Why this split:* B1 targets the class tests that held back strings and the reloaded lengths in maps. B2 targets checked arithmetic.
- *Rule carried over from D44 and D46:* no pass changes results or trap codes. A check goes only when proved unable to fire. The -O0 output stays byte-identical.

## 2026-11-24

**`JsMap` and `JsSet` (D72) are built and verified** (manifest MATCH, sample 8/8).
- **What it is:** a line-by-line port of the map runtime.
- **Printing:** an LRU cache printed in 95 lines instead of 692, because the runtime is no longer pasted into every program.
- **Correctness:** 637 hand-written cases are checked against JS's own `Map`, and 2,548 cases agree through all three routes. All four injected bugs are caught.
- **`assert`'s code is now under TSL1026.**
- **`optIndex`, `loadAt` and `storeAt` are deleted,** after the printer was made unable to emit them.
- **Nothing switched on:** both map benchmarks use string keys, and string keys can't print through the new route yet. `JsString`'s hash isn't reached through dispatch.

**Decision: reorder the pile and bring optimiser phase B forward, ahead of `rc` through `@tsl/gc`.**
- *Why:*
  - Three finished features are now built, correct and printable, but held back only by speed:
    - strings;
    - exceptions, which wait on strings;
    - string-keyed maps.
  - The diagnosed causes are repeated class tests and length checks that the optimiser can't hoist or share. Loop-invariant code motion and value numbering fix that, and check elimination removes the checked-arithmetic overhead seen in strings.
  - Phase B helps the kernel and all TSL, not just the pipeline.
  - Doing `rc` first would pile more correct but held-back work behind the same cause.
- *Rejected:* continuing pile order (rc next), which leaves the three features stuck.

**New order:**
1. A small step: `keyHash`/`keySame` through dispatch, so `JsString` keys work. Add a number-keyed and an object-keyed map benchmark, so those maps can be judged on their own and switched on if they're fast enough.
2. Optimiser phase B: check elimination, loop-invariant code motion, value numbering.
3. Re-measure, and switch on strings, exceptions and maps where they now pass.
4. `rc` through `@tsl/gc`, which needs D42's slot clearing on move and delete ported to `JsMap` (noted by the builder).
5. The rest of the pile as before.

## 2026-11-23

**The V8 route, `Trap` and the `JsArray` move are built and verified** (manifest MATCH, sample 8/8; no bare `trap(<number>)` left in packages or `compiler/rt`).
- **Printed TSL now runs on V8 and JSC.** A third route in the differential: 56 printed builds and 7,384 cases. Every difference is a named allowed divergence (memory, `Math.pow`'s last unit in the last place, V8 against JSC on maths).
- **Every `@tsl/lowered` extension now runs on the host.** None is native-only.
- **`Trap` names codes 1–18.** A numeric literal as a trap code is now compile error TSL1026; 52 were replaced.
- **`JsArray` now lives in `@tsl/jsrt`.**

**Decision: bring `assert`'s code under TSL1026 too.**
- The printer still emits `builtin("assert", c, cast<i32>(2))`.
- *Why:* the owner wants no numeric trap codes long term. `assert`'s code is a trap code by another route, so the same rule should apply.
- *Rejected:* leaving `assert` outside the rule.
- *When:* folded into the next step.

**Decision: delete `optIndex`, `loadAt` and `storeAt`** from `@tsl/lowered` once the printer can no longer emit them, which today nothing in the corpora does. Confirm before deleting that the printer can't produce them. Same step.

**Next: pile item 3, `JsMap` and `JsSet`** printed as TSL runtime classes in `@tsl/jsrt`, with the speed rule and the V8 route as switch-over conditions.

## 2026-11-22

**String split built and verified** (manifest MATCH, sample 8/8). `JsString` is now an interface over `JsFlat` (12-byte header, units inline) and `JsView`, with `JsBuf` for concatenation buffers. The published string layout is now `DownMeta.strLayout`.

| String benchmark, -O2 | Before the split | After the split |
|---|---|---|
| Short joins, `manual` | 1.18× | **0.97×** |
| Short joins, `leak` | 1.17× | 1.08× |
| Appends | 1.14–1.22× | **1.28–1.33×** (five class tests per append) |
| Scan, split and join | | 1.03–1.14× |

The cause is clear: nothing in the optimiser hoists or shares a repeated class test, because there's no loop-invariant code motion, value numbering or unswitching yet.

**Decision: strings stay forced-only and work moves on, per the 2026-11-21 rule.** Next is the pile's next item: printed TSL on V8, the `Trap` enum, and the `JsArray` move.

**Decision: keep the split rather than revert it.**
- It's the right shape once the optimiser can share and hoist class tests, which phase B brings: LICM and value numbering, alongside check elimination.
- It already wins short joins in `manual`.
- Reverting costs a builder step for a layout we expect to want back.
- Strings are off by default, so no default program pays for it.
- *Revisit:* after optimiser phase B, re-measure. If strings still miss the speed rule, either print `strConcat`'s length check without going through the interface (the builder's cheaper idea), or revert to the single class.
- *Rejected:* reverting now.

**Decision: when optimiser phase B comes (check elimination), include LICM and value numbering of repeated class and length tests.** The string work shows they're needed, not just check elimination.

## 2026-11-21

**Closed-world interface dispatch (D70) is built and verified.**
- Verification: manifest MATCH. `--sample 8` gave 7/8; the difference is `native-f` box 12, a benchmark box whose text still differs after numbers are normalised, so the sampler needs another fix.
- What's in:
  - **Dispatch:** a methods-only interface; classes matched structurally from whole-program flow; one class gives a direct call, several give a class-id switch; an unknown id traps with new code 18; TSL3010 and TSL1025 for what can't be decided or dispatched.
- **The two append fixes:**
  - an unsigned-constant fold in the optimiser;
  - `concat` without its second length check.

  Appends went from 1.21× to 1.14× in `leak`. The string split was designed but not built.

**Decision: build the string split as designed (flat and view classes behind a dispatch interface), then decide by the numbers.**
- If every string benchmark then meets the speed rule at -O1 and -O2, switch strings and exceptions on in `auto`.
- If not, stop chasing strings for now. Keep them forced-only, and move on to the next item on the pile: printed TSL on V8, the `Trap` enum and the `JsArray` move.
- Revisit the string gap after check elimination (optimiser phase B). Much of the remaining append cost is checked arithmetic that check elimination targets.
- *Why:* strings are correct and printable already. Only the default is held back, and the rest of the pile doesn't depend on it.
- *Rejected:* continuing to tune strings indefinitely before anything else moves.

## 2026-11-20

**Tails (D69) built and verified.**
- Verification: `verify-manifest` MATCH. `--sample 8` gave 7/8; the one difference is `native-f` box 11 listing the same items in a different order, a sampler flaw, now queued.
- What's in: syntax `units = tail(u16)`, creation `withTail(n, new T(…))`, and `Rc` stores with `makeTail`.
- Strings still miss the speed rule: short joins 1.17×, appends 1.21× at -O2 in `leak`. Strings and exceptions stay off in `auto`.

**Decision: accept `makeTail`'s fixed-size temporary copy.**
- It copies only the fixed fields of an object that has no tail yet, and whose constructor can't read the tail, so it's construction in place in effect. It doesn't break "tails never on the stack".
- Rejected: forbidding `Rc` stores for tail classes, which would block counted strings in `rc`.

**Decision: close the short-join gap by giving flat strings and views different classes, not one class with unused fields.**
- *The cause, measured:* a flat string carries a view's 16 bytes (owner and start), so a short join allocates 96 bytes per step against 64.
- *The fix:* land the closed-world interface dispatch prototyped in /tmp/tmk-pagesrc (option c of api-audit A5: structural typing, dispatch set from whole-program flow, direct call for one class, class-id switch for several, compile error when unknown). It goes into TSL proper now rather than in the API-fixes phase. Then split `JsString` into a flat class and a view class behind one interface.
- *Why now:* the page-source work needs it anyway (A5). It's a TSL proper feature hand-written code gains from, and it's a desugaring-friendly fix rather than a layout extension.
- *Rejected:*
  - per-object layouts for one class: a bigger language change;
  - a small-string optimisation: the owner chose tails over it.

**Decision: also do the two smaller append fixes,** both in TSL proper:
- the optimiser folds unsigned compares of constants above 2^31;
- `concat` drops its second length check.

Then switch strings and exceptions on in `auto` if the speed rule is met.

**Queued hygiene:** `tmk gate --sample` should compare unordered box lists as sets (`native-f` box 11).

## 2026-11-19

**Owner decisions, recorded before the hand-over:**
- Build variable-length tails, heap only, rather than a small-string optimisation. Owner: "you've made a good case for tails".
- A `Slab` with a declared maximum tail would also work. That's noted as a possible later addition, not in the first build.
- Audit long term for numeric trap codes: a `Trap` enum, enforced by a rule.
- Printed lowered TSL must run on V8, as all TSL must, enforced by a third differential route.
- `@tsl/lowered`'s extensions are fenced from the kernel (TSL1023), so none of the pipeline's extensions affect kernel code.
