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

## 2027-01-09

**Coordinator: R21 verified after one fix of my own.** Builder's gate: 282 of 283. The one failure was native-a/1-4's unit test "a descendant dies with its parent's group" (tools/guarded-run.test.ts), which R21 didn't touch.
- **Why it failed:** the test gave a parent 800 ms to start a child and print its pid. Under the gate's load, two Node starts can take longer, and then there's no pid. It also checked the child was gone the instant after the kill, with no time for the system to reap an orphan.
- **The fix:** a 3 s window, then up to 2 s for the descendant to disappear. The descendant still has to die with its parent's group, so the test is no weaker. The fixed test passed 3 of 3 on its own.
- **My re-gate:** from clean, 283 of 283 in 93.1 min. Manifest MATCH, tree ac4a2b6cf42008a3; sample 8/8 the same, seed 23719. Committed locally, not pushed.
- **R21's results:**
  - strings in `rc` 1.23–1.58 the direct route (from 1.6–2.0);
  - calls that can throw 1.00 at -O1 and -O2 (backend `shrinkwrap`; both routes now 7 instructions a call);
  - `--help` no longer starts runs;
  - `test --changed` no longer reports FAIL with every job passed.
- **Pins:** r10/r11's live counts moved by the one-unit table, each explained. No TSL proper pins moved.
- **`auto`:** nothing new.
- **Process note:** the builder used `pgrep` once (read-only, killed nothing) despite the brief. The next brief repeats the rule more strongly.

**Decision: R22 takes `rc`'s remaining per-object costs, the ones every program pays.**
- **First, `freeFlat`'s cost per call:** it saves twelve registers. See whether R21's `shrinkwrap` or a lighter frame can drop most of them, without changing D39's steps.
- **Then freeing a thrown object** (throws are 1.22–1.25).
- **Then short joins** (1.56/1.58): copy once instead of zero-fill plus two copies, where that's done with checked operations. Leaving a tail unzeroed needs a proof, so it waits with option 1.
- **Then the five reshaped `rc` programs** still over 1.00, if these changes reach them.
- *Rejected:* unzeroed allocation (unchecked without a proof; the owner's ruling); option 1 (the owner said later).
- *Next:* item 11, retiring the direct route, once `rc` is close enough for `auto` to take strings and exceptions.

## 2027-01-08

**R21 is built (builder's report; for the coordinator to verify).** Strings in `rc` class printing (one-unit strings from a table, cheaper freeing and making), -O1's calls that can throw (shrink-wrapping in the backend), and two harness fixes. SPEC 3.5 (the strings paragraph and `ex-gc-rc.ts`'s block), 8.3 (pipe-d boxes 61 and 62), 9.3 (`test`, `gate`), D75 and M5's R21 record; README's `--help` line. No check, case or fault was dropped or weakened, and no limit, timeout or watchdog moved. Nothing was added to TSL, and no unchecked operation to anything lowered code can import.

- **Measured first** (instructions; TCG, `TMK_ICOUNT=1`; "before" from a copy of commit 5c58fe0): strings as R20 left them, 1.58–1.97 the direct route at -O1 and -O2. Scans at -O2, after the table: freeing 105k in `freeFlat` plus 26k in `runSteps` (41 instructions a call only to hand over to `freeFlat`), against 68k; `freeFlat` dispatched a one-slot object (a `JsStr`) on its release function twice; a tail's make worked out its owner word with a checked multiply and add each time (14 instructions); a table hit cost 41 instructions out of line, a third of it the holder's own count; an append of one unit was a copy's call for 2 bytes. -O1's `risky`: 16 instructions a call against 11, three register pairs and the frame slot set up and taken down on calls that don't throw.
- **Built:**
  - One-unit strings below 256 from a table in the printed `rc` string runtime (`JsStrUnits`, a `JsRoomArray` of the program's own `JsStr | null`, module state), made on first use and held, as the direct route's static table holds its 256. The coordinator's "a `@tsl/jsrt` static": in `rc` the string runtime is the program's own printed copy of `JsString`'s (emit-rcstr.ts), as the expansion has to count it, so the table lives there, as checked module state, not in `@tsl/jsrt`. The hit is inlined; an append or prepend of one unit is a checked store.
  - `@tsl/gc`: a tail's owner word kept with its size class; a one-slot object dispatched once in `freeFlat`; `runSteps` handing the first waiting object straight to `freeFlat`.
  - The backend's `shrinkwrap` (D75, -O1 and -O2): an entry that tests and returns at once does so before the prologue, where nothing on that way calls or touches the stack or a callee-saved register.
- **Why sound:** the same freeing steps in the same order (D39, D41 unchanged: `runSteps` hands over where it did; the `s > 1` test skips a loop that couldn't run; the owner word is the same value). A table string is held by module state like a literal, so it's never counted down to zero or freed, which is the direct route's static rule; the table's read is bounds-checked. Shrink-wrapping's quick way writes only registers the caller doesn't need kept and never the stack; everything else is reached after the prologue.
- **Moved counts** (each pinned again by case, none in bulk): rc_strings.ts live past the base +2 from case 10 (`slices("a",3)`: "a" and the holder), +10 from case 14 (`words`: t h e space c n d b), +17 from case 17 (`sorted`: p r , l f i g), +17 throughout round two; r11_exc_counts.ts +12 from case 11 (`escapes(6)`'s description quotes "Failure", "Error", "boom": 11 strings and the holder). Result counts and step counts didn't move (2 and 2 steps an allocation; 552 live after letting go of 500 strings, 535 before: the table's 17).
- **Tried and not built:** a throw's construction printed out of line (it would make the TSL route's `risky` 11 like the direct route's, print a function per class-printed throw in every mode and move their pins; shrink-wrapping makes both routes 7 and moves none); `make` and `tailFast` calling `freeFlat` themselves in place of `runSteps` (strings 4–8% cheaper, but objects with no slots paid `freeFlat`'s twelve saved registers: corpus/lower/rc/adv_forof_mutation.ts 0.76 → 0.97 at -O1 and 0.96 → 1.23 at -O2, and escape_global.ts, which `auto` takes, 0.997 → 1.003; taken out, both back as they were).
- **After** (TSL / direct, -O1 and -O2, before → after): appends 1.96/1.95 → 1.32/1.28, short joins 1.58/1.63 → 1.56/1.58, substrings 1.67/1.65 → 1.26/1.23, scans 1.97/1.97 → 1.58/1.51, split and join 1.70/1.65 → 1.32/1.25. Strings' freeing at -O2 (scans): 219 instructions an object → 134 (187 a freeing call against the direct route's 108); making 107k → 86k against 78k. Calls that can throw at -O1 1.19 → 1.00 (`risky` 16 → 7, the direct route's 11 → 7), `try` 1.17 → 1.00, `try`/`finally` 1.14 → 1.00; -O2 stays 1.00. Throws 1.21–1.25, 0.6% more than before (with the collector, `freeSteps` two instructions more a call). `AUTO_RC`'s benchmarks: none worse (acyclic 0.82/0.86 → 0.79/0.83).
- **`auto`:** nothing new. `AUTO_RC_STRINGS` stays off (strings 1.23 to 1.58 the direct route); `AUTO_RC_EXC` stays off (throws 1.22 to 1.25, though -O1's calls that can throw, `try` and `try`/`finally` are now 1.00 at both levels); `TRUSTED_IN`'s `rc` class printing stays off: tools/r14-time.ts over the 33 reshaped `rc` programs it times (`TMK_TRUST_IN=rc:classes`), before → after, read_checks 1.014 / 1.107 → 0.998 / 1.088, reshape_order 1.069 / 1.038 → 1.062 / 1.031, relative_import 1.003 / 1.001, map_grow_oom 2.19 / 2.16 and cyc_exhaust 1.42 / 1.32 unchanged: four over 1.00 at -O1 (five before) and five at -O2, and none worse by more than 0.006 (adv_*'s at -O1, all under 0.88). The other switches are untouched by R21 but for the backend's change, which is both routes'. Coverage (`node tools/route-blockers.ts`, -O2) the same before and after, line for line: `strict` 30 exact + 18 reshaped, `leak` and `manual` 63 + 43, `rc` 19 + 0.
- **Injected bugs** (box 62), each caught by wrong answers: the one-unit table filed by a unit's low 7 bits (7), the table taken for unit 256 (6, a bounds trap), shrink-wrapping taking a callee-saved register as free (28; also in `OPT_FAULTS`, opt-a box 12).
- **Pins:** 20 of 3,864 moved, none TSL proper's, none unexplained, all by `@tsl/gc` (tools/r21-pins.ts, stage `gc`; tools/r21-moved.ts), in the five lowered `rc` programs R19's library change moved too (bench/memory/list_lowered.ts and churn_lowered.ts, corpus/lower/fallback/escape_global.ts and closure_outlives.ts, corpus/lower/memory/store_closure.ts), at -O0 (pre-std 5, pre-strings 5), -O1 and -O2 (opt 10): a library change, which D44 allows. The printing's stage moved none (`auto` doesn't take strings in `rc`), and the backend's change is machine code. 15 pinned again; the 5 in the read-only pre-strings file set aside by key (`r21Moved`, in maps-pins' `mapsMoved`).
- **Harness:** `tmk test --changed` now plans the gate's tops for any picked job the quick tier's plan hasn't got (it checked the milestone name, so `test/1@1` was picked and never run); a genuinely skipped job still marks a run incomplete. `tmk test --help` and `tmk gate --help` print usage and exit 0 without starting anything.
- **Gate:** this entry was finished before the final gate, as the round asks; the result is in the builder's report.
- *Rejected:* unzeroed string memory (the owner's ruling); the maps' fresh-allocation proof (deferred by the owner); an unchecked table read.
- *Next:* short joins (1.56/1.58: the tail's zero fill then two copies, and a size class worked out for each new length), then freeing's per-call cost (`freeFlat`'s twelve saved registers), freeing a thrown object, then item 11.

## 2027-01-07

**Coordinator: R20 verified** (manifest MATCH, tree f026d23c4a057eba; gate from clean 281 of 281 in 90.9 min; sample 8/8 the same, seed 22643). Highest per-job peak 2.33 GiB. Committed locally, not pushed.
- **The determinism fix holds:** this was the first sample since R19's ordering-only differences, and it matched exactly. One sample isn't proof, so I'll keep watching.
- **For the owner:** two TSL proper pins moved at -O2 (`run_memory.ts`'s `Timers.arm`, `builder.ts`'s `Str.hashKey`), both because partial inlining now handles an entry that reserves a stack slot. That's an optimiser change at -O2 with its reason recorded, which D44 allows. I accept it, but flag it.
- **`auto`:** nothing new. Exceptions in `rc` are now level with the direct route at -O2 (calls that can throw 1.45 → 1.00), but not at -O1 (1.19). Strings are still 1.6–2.0× at both levels.

**Decision: R21 takes strings in `rc`, then exceptions at -O1.**
- **One-unit strings from a static table, as the direct route does.** R20 found about 500 extra allocations a call in the scans benchmark. I take the table even though it moves r10-tests' pinned live, result and step counts. Those pins record when memory is freed, not whether a program is right. The direct route already keeps these strings forever, so the TSL route matches it. Each moved count is to be explained, never loosened in bulk. The table is a `@tsl/jsrt` static, so nothing unchecked is added.
- **Then strings' freeing (219 instructions an object against 108) and making,** measured first.
- **Then -O1 calls that can throw** (16 instructions against 11). Make a throw's construction out of line, or have the backend save registers only on the paths that need them, whichever measures better.
- **Harness fixes found in R20:**
  - `tmk test --changed` reports FAIL when every job passed, if a new `.test.ts` file can't be reached;
  - `tmk test --help` (like `gate --help`) starts a real run. Make both `--help`s print usage.
- *Rejected:* leaving string memory unzeroed (an unchecked write unless tslc proves it; the owner's ruling).
- *Next:* freeing a thrown object, arrays' last costs, then item 11.

## 2027-01-06

**R20 is built (builder's report; for the coordinator to verify).** The gate's box details made deterministic at their source, then strings and exceptions in `rc` class printing measured, with what was sound built: the runtime's short copies and fills, and partial inlining past a frame slot. SPEC 4.3, 8.3 (boxes 59 and 60, and opt-a box 12's new bug), D46 and M5's R20 record. No check, case or fault was dropped or weakened, and no limit, timeout or watchdog moved; tools/gate.ts's comparison is untouched. Nothing was added to TSL, to the printing, or to anything lowered code can import.

- **Determinism first.** lang-a box 9 quoted the first failure pushed by a suite running on a pool, and pipe-d box 39 printed a divergence map in the order cases finished. Now every runner that collects failures on a pool returns them sorted (file, mode, level, then function and case index, digits as numbers: tools/stable.ts), `dualRoute` also sorts its programs and rows and keys its divergence counts in that order, and every "first failure" a box or fault row quotes is the first in that order (lang-a 9, and the fault runs in gc-, std-, rc- and r2/r8/r10–r14/r16–r19-tests). Integer-keyed count maps (`trapCodes`) already print in key order; lists joined with `, ` or `; ` were already compared as sets.
- **Measured first** (instructions; TCG, `TMK_ICOUNT=1`; "before" from a copy of commit 1009698):
  - *Strings in `rc`:* 1.55–2.09 the direct route at -O1 and -O2. Scans at -O2, 679,367 a call to 326,331: freeing 191k to 68k (219 an object to 108), making strings 107k to 78k, the runtime's copy and fill 92k to 25k (their last bytes a byte at a time, 7 instructions a byte), and about 500 one-unit strings a call the direct route takes from a static table.
  - *Exceptions in `rc`:* calls that can throw and `try`s nothing throws through 1.14–1.19 at -O1 and 1.31–1.45 at -O2; throws 1.26–1.43. At -O2 the direct route inlines the throwing callee and the TSL route couldn't: a throw's `Dyn` is built in a frame slot of the callee's entry (tslc's `make`), and partial inlining refused any entry with a slot. A throw a frame up, 1,092 to 761: copying the 56-byte `Dyn` into its slot 187 (the last 24 bytes a byte at a time), freeing it 573 to 378 (five slots a step each, and the collector's candidate handling).
- **Built:**
  - `__rt_memmove`'s last bytes (under 32) and `__rt_memset`'s (under 16) by the bits of the count, a step each, each step loaded whole before it's stored, upward or downward as before. Both routes use them; no TIR changes.
  - Partial inlining (-O2) takes a callee whose entry gives a frame slot the copied paths don't use, leaving the slot out of the copy (inline.ts; `TMK_R20_OFF=alloca` for the pins tool).
- **Why sound:** the copies move the same bytes, with overlap handled as before (each step read before written, in the direction of the copy). Partial inlining's prefix is still checked free of effects instruction by instruction, a kept path still calls nothing, and a slot any copied instruction or edge uses refuses the plan; a slot does nothing when it runs, and the bail calls the whole function with its own. D39 and D41 unchanged: `@tsl/gc`, the expansion and the printing aren't touched, so every allocation takes the same steps in the same order.
- **Tried and not built:** a one-unit string table in `rc` (module state holding `JsStr`s: every one stays live from its first use, moving r10-tests' pinned live counts, result counts and D39 step counts, and it allocates what the direct route keeps static; for the owner to weigh); unzeroed string tails (unchecked unless tslc proved the writes: the owner's ruling); a throw's construction printed out of line (helps -O1 too, but changes every class-printed exceptions program in every mode: next).
- **After** (TSL / direct, -O1 and -O2, before → after): strings: appends 2.09/2.07 → 1.96/1.95, short joins 1.55/1.59 → 1.58/1.63 (the direct route's copies got cheaper too), substrings 1.74/1.72 → 1.67/1.65, scans 2.09/2.09 → 1.97/1.97, split and join 1.77/1.72 → 1.70/1.65. Exceptions: calls that can throw 1.19/1.45 → 1.19/1.00, `try` 1.17/1.42 → 1.17/1.00, `try`/`finally` 1.14/1.31 → 1.14/1.00, throws 1, 10 and 100 up 1.39/1.43, 1.36/1.39, 1.26/1.27 → 1.21/1.24, 1.21/1.23, 1.21/1.22. At -O1 the throwing callee isn't inlined through either route and the TSL route's costs 16 instructions a call to 11 (callee-saved registers and the frame slot saved on the fast path: no shrink-wrapping). `AUTO_RC`'s benchmarks: the same instructions before and after in every cell at both levels.
- **`auto`: nothing new.** `AUTO_RC_STRINGS` and `AUTO_RC_EXC` stay off (strings 1.58–1.97; throws 1.21–1.24, and -O1's calls that can throw 1.14–1.19). Coverage (`route-blockers`, -O2) is the same before and after, line for line: `strict` 30 + 18, `leak` and `manual` 63 + 43, `rc` 19 + 0.
- **Arrays' last costs:** didn't fall out, so nothing was built for them: tools/r14-time.ts over the reshaped `rc` programs (`TMK_TRUST_IN=rc:classes`), before → after, the same five over 1.00 at each level within 0.1% (read_checks 1.014/1.107, relative_import, reshape_order, map_grow_oom, cyc_exhaust); grow_reuse 0.726/0.943 → 0.729/0.949, as the direct route's copies got cheaper too.
- **Injected bugs** (box 60), each caught by a wrong answer: a copy's last bytes missing their 4-byte step (13), a copy up over itself missing its last byte (1), a short fill missing its 2-byte store (1), partial inlining taking an entry with a frame slot as free of effects (2; also opt-a box 12's, whose first step is now R20's program).
- **Pins:** 76 of 3,864 moved, all at -O2, none unexplained, all by partial inlining (tools/r20-pins.ts, tools/r20-moved.ts): two TSL proper at -O2 (corpus/spec/run_memory.ts, `Timers.arm` inlined partially into four callers; corpus/std/builder.ts, `Str.hashKey` into two), which D44 allows with its reason, and 74 of 18 lowered programs (corpus/lower/exc's six, maps/move_ops, strmap's eleven), most of them direct-route builds, whose strings and exceptions runtime builds objects in slots on rare paths. The JPEG decoder's TIR is the same at -O1 and -O2 with and without it, and S4's programs' pins didn't move. All pinned again; none in the read-only file.
- **Gate:** this entry was finished before the final gate, as the round asks; the result is in the builder's report.
- *Rejected:* loosening `normalizeDetail` or `sameListedItems` for the two R19 jobs (it would hide real order changes); switching `AUTO_RC_EXC` on at -O2 alone (the rule is -O1 and -O2).
- *Next:* a throw's construction printed out of line, or shrink-wrapping in the backend, for -O1's calls that can throw; then the freeing of a `Dyn` (five slots a step, every class's fields) and of strings (219 instructions an object to 108), and a one-unit string table if the owner accepts its live counts; then item 11.

## 2027-01-05

**Coordinator: R19 verified** (manifest MATCH, tree 674cfa6c126e5e6a; gate from clean 279 of 279 in 96.6 min). Highest per-job peak 2.66 GiB (pipe-d/47, 2.11 in R18), still under the 3 GiB watchdog.
- **Sample, seed 20521: 6/8 the same.** The two that differed had every count identical:
  - lang-a/9 named a different first failure among the same 269 and 54;
  - pipe-d/39 printed the same divergence counts in a different key order.

  That's nondeterministic ordering in the harness's details, not a change in what was compiled or caught. A second sample (seed 21587) was 8/8 the same. I accept R19 on that basis, and the ordering gets fixed at its source (see R20), not by loosening the comparison.
- **Committed and pushed R15–R19 together** (owner: "Wait and push"). R15–R18 couldn't go alone: R19 had already changed files R18's gate verified, and no copy of them was kept. From now on each verified round is committed locally straight away (owner: "commit on verify is fine"), and pushed only when the owner asks.
- **`auto`:** nothing new in `rc` (19 exact, 0 reshaped). Maps need the owner's deferred fresh-allocation proof (option 1); I'm leaving it deferred until the owner says "now".

**Decision: R20.**
- First, make the harness details deterministic: sort the keys of divergence maps, and pick the "first failure" by a stable order, not by which job finished first.
- Then strings and exceptions in `rc` class printing (the next item in the order), measured first against the speed rule.
- Arrays' last costs (a holder freed in about 90 instructions against 68, a fresh object 155 against 114) if they fall out of that work.
- *Rejected:* starting option 1 now (the owner said later); the collector's exhaustion path (algorithmic, waits).
- *Next:* item 11.

## 2027-01-04

**R19 is built (builder's report; for the coordinator to verify).** `rc` class printing's remaining measured costs: arrays growing by rooms, closure calls through the kind switch, and maps' tables; then the speed rule on whether `auto` takes reshaped `rc` programs. SPEC 3.4 (R19's invariance rule), 3.5 ("`rc` class printing's remaining costs", the `ex-gc-rc.ts` block), 8.3 (boxes 57 and 58), D39, D41, D64, D73, D74, D75 and M5's R19 record. No check, case or fault was dropped or weakened, and no limit, timeout or watchdog moved. Nothing was added to TSL, and nothing to anything lowered code can import.

- **Measured first** (instructions; TCG, `TMK_ICOUNT=1`; "before" from a copy of R18's tree):
  - *Arrays.* read_checks.ts's cases are small arrays, and 7 of its 12 trap (an index past the end), each leaving what it made, so every pass makes fresh objects: a trapping `objAt` 1,200 direct against 2,100, a fresh object 116 against 241 (every fresh slot was one `allocBytes` of the heap below). Rooms of new lengths, and holders of alternating lengths (reshape_order's literals), went out of line to `tailMake`; a holder was freed through `freeSteps`' frame, 163 instructions against 77.
  - *Closures.* closure_selected's `select`, per turn: 14.5 direct against 28.5 (-O1) and 17.5 (-O2): `call` wasn't inlined (the caller's growth limit, used up by the `make`s), and the kind was loaded and compared every call.
  - *Maps.* map_grow_oom and r2_maps' `reallyOut` run a map until memory runs out, and class printing holds twice the entries in the same pages (8,192 against 4,096; 4,096 against 2,048), so its pass does twice the work. At equal work, a local map's build and reads are 1.047 (-O1) and 1.086 (-O2), a set of an existing key 0.990 and 1.030: two bounds checks a chain step, the checks the owner's ruling keeps (R17's 3a, deferred).
  - *cyc_exhaust* (out of scope): its trapping case's figure, the collector's exhaustion path (6,858 objects held at trap 14 against 7,808).
- **Built:**
  - `@tsl/gc`: `tailFast` makes a tail of any length in line; without the collector a fresh slot is cut from a page of its size class (`pageSlot`, `freshSlot`), as the direct route cuts its small blocks; `runSteps` hands an object whose release function isn't empty to `freeFlat`, `freeSteps`' loop without its frame.
  - Closures: in `rc`, an environment's `call` (several kinds), and each kind's small method, print `@tsl.inline`; tslc notes a lowered `rc` package's counted class's fields that only its constructor stores invariant (D73): the kind is read once for a loop, and at -O2 the loop is unswitched on it.
  - The backend leaves a `!` to the load through a reference's address, as through the reference (D75).
- **Sound, D39/D41 unchanged:** the same freeing steps, in the same order, with the same effects (every pinned step count holds); a fresh slot is taken where it was, everything waiting freed before trap 14; the collector's code, chunks and walk untouched. The invariance rule is tslc's proof: the objects are a store's slots, reused only once no reference is left, and a lowered package can't import `@tsl/unsafe`.
- **The owner's ruling:** no unchecked operation added to anything lowered code can import; `@tsl/gc`'s changes are internal, behind the SAFETY reasoning they had. What the maps need (bounds checks proved away) is the owner's deferred 3a: not built, reported.
- **Tried and taken out:**
  - masking dropped from a lowered `rc` package's counted references: R19's own test faulted at -O0, as freeing gives a release function its object tagged (`objectAt<Counted0>`). relative_import keeps its one `ubfx`;
  - `roomDrop` inlined: it made `freeSteps` spill (773 → 984 a call on the object-keyed maps benchmark);
  - -O1's inliner taking a call copied into a loop as in it: not needed, and it would have moved hand-written TSL's -O1 code.
- **After** (before → after, -O1/-O2): read_checks 1.298/1.398 → 1.014/1.107, reshape_order 1.098/1.078 → 1.069/1.038, closure_selected 1.013/1.005 → 0.987/0.986, r3_arrays 0.925/1.005 → 0.915/0.993, grow_reuse 0.766/1.000 → 0.726/0.943, relative_import 1.004/1.002 → 1.003/1.001, cyc_exhaust 1.440/1.328 → 1.424/1.316, map_grow_oom unchanged. Over 1.00: 6 → 5 at -O1, 7 → 5 at -O2.
- **`auto`: nothing new.** `TRUSTED_IN` is unchanged. Five programs still miss at each level: maps' two (capacity, and checks the ruling keeps) and the collector's (out of scope) can't be taken this round, and read_checks, reshape_order and relative_import are arrays' last costs. A rule by construct would leave out nearly every reshaped program, so I don't propose one. Coverage (`route-blockers`, -O2) is the same before and after, line for line: `strict` 30 + 18, `leak` and `manual` 63 + 43, `rc` 19 + 0.
- **JPEG and S4:** the same TIR, with no `ref.addr` for the backend's change to read: the same machine code.
- **`AUTO_RC`'s benchmarks** (`tmk bench memory --classes --rc`, instructions, class printing / direct, before → after): unchanged within 0.2% but acyclic (0.83 → 0.82 at -O1, 0.89 → 0.86 at -O2) and arrays at -O2 (0.86 → 0.84). *Found:* two cells were already over 1.00 in instructions before R19 and still are: cycles at -O1 (1.045, +0.05% now) and number-keyed maps at -O2 (1.002, unchanged). Box 26 decides on time, where both pass; for you to judge.
- **Injected bugs** (box 58), each caught by a wrong answer: a room array's growth copying one element short (7), the inlined call switch's first two kinds swapped (3), tslc's invariance rule missing a store a method makes (6, r19_fields.ts's pins at -O1 and -O2), a map table's growth leaving the entry its move puts first out of every chain (1), a freed literal of two objects given back with its second still counted (12, trap 14), a tail of a new length made at the last length's size class (6), a fresh slot cut half a slot past the last (19). Two older bugs now patch `freeFlat`'s copy of `freeSteps`' text as well (`times: 2`), as most freeing is `freeFlat`'s; each is still caught.
- **Pins:** 20 of 3,864 moved, none TSL proper's, none unexplained (tools/r19-pins.ts, tools/r19-moved.ts): five lowered `rc` programs (list and churn benchmarks, escape_global and store_closure by `@tsl/gc` at every level, a library change D44 allows; closure_outlives also by the printing's `@tsl.inline`, and store_closure and closure_outlives by the invariance rule at -O1 and -O2). 15 pinned again, 5 in the read-only pre-strings file set aside by key.
- **Gate:** this entry was finished before the final gate, as the round asks; the gate's result, time and peaks are in the builder's report. (decisions.md isn't one of the manifest's inputs, tools/registry.ts's INPUT_ROOT_FILES; SPEC.md is.)
- *Rejected:* trusting reshapes in `rc` class printing (five programs over at each level); a by-construct trust rule; an unchecked map read (the owner's ruling).
- *Next:* maps in `rc` need the deferred proof (or the owner's word); the collector at exhaustion; arrays' last costs (a holder freed about 90 to the direct route's 68, a fresh object 155 to 114 at -O2); then strings and exceptions in `rc`, then item 11.

## 2027-01-03

**Coordinator: R18 verified** (manifest MATCH, tree 0e404b78b20c8295; gate from clean 277 of 277 in 98.7 min, restarted once because of my own mid-start edit; sample 8/8 the same, seed 19463). Highest per-job peak 2.38 GiB.
- **Fault integrity fixed:** one patcher (`compiler/host/test-patch.ts`), exact match counts, and a non-applying patch is now a harness failure. All 227 injected bugs are registered and checked by a unit test in every `--changed` run. The audit repaired 7 stale or ambiguous bugs (`no-norm` had been out of the build since R6, `grow-last` since R16, plus `pop-empty` and four std map bugs that patched the wrong copy of repeated text). It also found and closed a real gap: JS Map's "trySet leaves a key on out-of-memory" was caught by nothing (`std_js_map_safety.ts` now catches it).
- **`rc` stack objects:** an `@tsl.stack` class is placed and checked by tslc's own escape analysis, not the printer's word (a wrong tag is refused), and it stays uncounted. It adds no unchecked operation, within the owner's ruling. relative_import and closure_selected are now at about 1.00, and `inheritance.ts` (already `auto`'s) went from 1.05/1.14 to 1.00/1.00. `auto` takes nothing new in `rc`.
- **Owner ruling applied:** a lowered package listing `"unsafeModules"` is now refused (TSL1023). It used to compile, though nothing used it.
- After the gate, I changed one SPEC sentence ("for a later round" to "temporary", per the owner's softened ruling; backup `SPEC.md.bak-pre-r18-coord`). It's wording only, but it changes the tree hash, so the next gate covers it.

**Decision: R19 takes `rc` class printing's remaining measured costs:** arrays growing by rooms (read_checks 1.30/1.40, reshape_order), closure calls through the kind switch (10–12 instructions against 5), and maps' tables from `@tsl/std` (map_grow_oom 2.19, r2_maps). The collector on 6,000-object rings (cyc_exhaust's `largeRings`, 3.67×) is algorithmic and waits. The speed rule then decides whether `TRUSTED_IN` extends to `rc` class printing.
- *Next:* strings and exceptions in `rc`, then item 11.

## 2027-01-02

**R18 is built (builder's report; for the coordinator to verify).** Fault-injection integrity first, then stack placement in `rc` class printing. SPEC 3.5 ("Stack objects in `rc` class printing"), 8.3 (the fault rule, and boxes 55 and 56), D39, D64, D74 and M5's R18 record. No check, case or fault was dropped or weakened, and no limit, timeout or watchdog moved. Nothing was added to TSL; the `@tsl.stack` tag means something only in a lowered `rc` package.

- **The fault rule.** An injected bug that isn't in the build is a harness failure of its box, never "caught":
  - one place applies a patch, `compiler/host/test-patch.ts`: the text must be there exactly as many times as the patch says (once unless `times`), or the build throws `TSL_TEST_PATCH: …`; a file is named at a `/`;
  - every runner (std-tests, gc-tests, r2/r11/r16/r17 tests, pipe-d boxes 4, 11, 18 and 19, quick's `--catch-rate`) takes its patch from `tools/faults.ts`'s `patchEnv`, which checks it against the source first, and passes its failures through `faultFailures`, which throws on a build that says a patch didn't apply; both throw `FaultHarnessError`, which fails the box and says why;
  - `registeredFaults` lists all 227 bugs the tools know (84 by patch, 143 by name through a `TMK_TEST_*` or `TMK_OPT_FAULT` hook), and tools/faults.test.ts, a unit test (so `tmk test --changed`'s first job, selected by every change), checks each patch's text and each name's hook. An edit that orphans a bug now fails in seconds.
- **What the audit found** (each repaired to target the same code as it is now, and run as its box runs it):

  | Bug | Box | File | Not in the build since | Caught now |
  |---|---|---|---|---|
  | `grow-last` | pipe-d 4 | ex-jsrt-array.ts | R16 (growth reads `old`) | by hand 5, dual 8 |
  | `no-norm` | pipe-d 18 | ex-jsrt-map.ts | R6 (scratch word read into `s`) | by hand 1, dual 4 |
  | `pop-empty` | pipe-d 4 | ex-jsrt-array.ts | text twice (pop's, shift's) since pipe-d; pop's patched, as meant | by hand 2 |
  | a deleted entry left visible | native-g 6 | ex-std-map.ts | text 3 times since the maps step (D47); ExactMap's patched | 13 |
  | trySet leaving a key behind | native-g 6 | ex-std-map.ts | twice since the maps step; ExactMap's | 1 |
  | a stale key reaching a closure | native-g 6 | ex-std-map.ts | twice since the maps step; ExactMap's | 1 |
  | compaction losing values | native-g 6 | ex-std-map.ts | twice since the maps step; ExactMap's | 12 |
  | (R17's) a freeing step visiting every slot | pipe-d 21 | ex-gc-rc.ts | R4 to R16 | caught (R17) |

  - The four map bugs now name ExactMap's code by the text around it, and each has a new counterpart in JS's Map (whose code is the same text again).
  - **Finding:** JS's Map `trySet` leaving a key behind when out of memory was caught by nothing: no case ran JS's Map out of memory. New corpus/std/std_js_map_safety.ts (two cases, every small page limit) now catches it (1). The other three counterparts: 681, 1, 39.
- **Measured first** (instructions; TCG, `TMK_ICOUNT=1`; `tmk profile --instructions` now takes `--args`). The 29 reshaped `rc` programs (`TMK_TRUST_IN=rc:classes`, tools/r14-time.ts) were over 1.00 on 6 at -O1 and 9 at -O2, plus r2_maps and r3_closures whose traps differ. Placement explained only part of it:
  - relative_import's `viaImport`: 21 direct, 92 + a 58-instruction freeing step printed. closure_selected's `reassign`: 19 against 129 + 92 (two empty closure environments counted).
  - The rest isn't placement. read_checks: arrays growing by rooms (`numAt`, n 20: 1,535 against 2,152). reshape_order: array literals' freeing (184 against 136 a call). closure_selected's `select`: closure calls through the kind switch (10 to 12 against 5). cyc_exhaust: the figure is its trapping case's; `largeRings` alone is 3.67x (the collector on rings of 6,000). Maps' tables (map_grow_oom 2.19, r2_maps): left for the maps round.
- **Built:**
  - class printing in `rc` tags `@tsl.stack` a class the lowering keeps every object of on the stack (`planStack`: each `new` placed on the stack, not long, holding only numbers, booleans and other such classes, held by nothing counted);
  - tslc's expansion leaves it uncounted, its `new` a plain `new`, its constructor and methods expanded as any function's, and refuses a tagged class holding anything else (TSL9001);
  - tslc's escape checking places that `new` on the stack and refuses one that could outlive its frame (TSL3001/3002);
  - such an object is zeroed by one `mem.fill`, which scalar replacement takes; and the backend makes a constant zero fill of up to 64 bytes stores, not a call to `__rt_memset`'s byte loop.
- **Sound, and D39/D41 unchanged** (3.5): a stack object can't be reached after its frame (tslc's escape checking refuses the program, whatever the printer said), can't be counted or released (no store; nothing counted holds it), and the collector never meets it (it scans counted fields of counted objects and the counted heap's pages). `@tsl/gc` is untouched.
- **Found on the way and fixed:** the expansion's first form copied a tagged class's methods as written, so corpus/lower/exc/exc_effects.ts's method that throws made its counted error a stack object, which tslc refused. `route-blockers` before and after showed the one program going from printed to blocked; methods are now expanded, and it prints as before.
- **After** (before → after, -O1/-O2): relative_import 1.062/1.130 → 1.004/1.002, closure_selected 1.067/1.061 → 1.013/1.005, closure_escape 0.996/1.004 → 0.972/0.983, grow_reuse 0.806/1.058 → 0.766/1.000, r3_arrays 0.946/1.029 → 0.925/1.005, read_checks 1.323/1.426 → 1.298/1.398; map_grow_oom, cyc_exhaust, reshape_order unchanged. Over 1.00: 6 → 6 at -O1, 9 → 7 at -O2.
- **`auto`: nothing new.** `TRUSTED_IN` is unchanged. read_checks, reshape_order, cyc_exhaust and the maps are over by more than placement gives, and what's left there is arrays' rooms, closure calls, the collector on large rings and maps. Coverage unchanged (`route-blockers`, -O2): `strict` 30 + 18, `leak` and `manual` 63 + 43, `rc` 19 + 0. Of `rc`'s 19 exact, inheritance.ts now keeps its object on the stack: 1.046/1.136 → 1.000/1.000.
- **JPEG and S4:** JPEG's TIR is unchanged; its constant zero fills are now stores: 0.9983 to 1.0000 of the instructions, every fixture, both levels (tower-portrait 91,975,815 → 91,975,394 at -O1). S4 (TSL proper, no such fill) is the same machine code.
- **Injected bugs** (box 56), each caught:
  - an escaping object placed on the stack: tslc refuses the build (1); with the escape checking also off, wrong answers (2);
  - a stack object reachable from a heap object the collector scans: refused (1); with the checking off, wrong answers (3);
  - a stack object released by `@tsl/gc`: a wrong answer and trap 18 (1);
  - the escape checking off alone: corpus/neg/lowered-rc not refused (3); the expansion taking a tagged class holding a reference: the same (1).
- **The owner's ruling (2027-01-01) applied:** R18 adds no unchecked operation to anything lowered code can import, and no raw `load`/`store`/`alloc`/`allocStack`/`elemAddr` to class printing. A stack object is a plain `new` that tslc's escape checking places and checks; the tag only lets the expansion leave a class uncounted, and tslc refuses a wrong one; the `mem.fill` and the backend's stores are tslc's lowering of that `new`.
  - *`@tsl/unsafe` from a lowered package:* TSL5001 unless the module is listed under `"unsafeModules"`, but a lowered package's tsl.json **could** list it (a probe compiled, asking only for `// SAFETY:` comments). The printer never writes that setting and no lowered package in the repo has one, so refusing it moves no pin: it's now TSL1023 with the other settings a lowered package can't take (compiler/host/program.ts, corpus/neg/lowered-unsafe).
- **Pins:** 4 of 3,864 moved, none TSL proper's (inheritance.ts in `rc` at -O0, -O1, -O2; tools/r18-pins.ts, tools/r18-moved.ts), one set aside in the read-only pre-strings file.
- **Gate:** one full gate from clean at default settings, 277 of 277 jobs passing in 98.7 min (5,922.5 s; load 66 to 84, at most 228, on 10 CPUs), tree 0e404b78b20c8295; `node tools/tmk.ts verify-manifest`: MATCH. The coordinator's edit to decisions.md (outside the manifest's inputs) landed as the first gate started; that gate was stopped and this one started fresh. Highest per-job peaks: native-f/6@2 2.38 GiB, pipe-d/3 2.21, pipe-b/7 2.17, pipe-a/3 2.14, pipe-d/47 2.11. `tmk test --changed` before it: 43 of 43.
- *Rejected:* trusting reshapes in `rc` class printing (7 programs over at -O2); keeping a class on the stack per site rather than per class (a reference's count would need the site, which a class's references don't carry); counting stack objects with a pinned count (count operations the direct route doesn't pay).
- *Next:* `rc` arrays' rooms (read_checks, reshape_order), closure calls through the kind switch, the collector on large rings, then maps in `rc`, then strings and exceptions in `rc`.

## 2027-01-01 (owner ruling)

**Owner: "Lowered TSL should have no way of violating memory safety."** On 3a: option 1 (the optimiser rule: fresh-allocation separation plus per-call write summaries), but later. No lowered-only unchecked read, ever.
- *What this means for the current design (coordinator):* phase 1's printing breaks the rule today. `@tsl/lowered`'s `load`, `store`, `alloc`, `allocStack` and `elemAddr` are unchecked raw memory operations, "trusted exactly as much as the direct route" (its header comment). `auto` currently uses that printing for most `leak`/`manual` programs, all 18 trusted-reshape `strict` programs, and the JPEG decoder.
- *Note:* phase 1's raw-memory printing is temporary (softened by the owner below: a note, not a hard steer).
- *Standing rule for every builder from now on:* add no unchecked operation to anything lowered code can import. A lowered package's only escape hatch would be `@tsl/unsafe`, which lowered packages must not import (check that TSL1023-style rules enforce it).
- **Owner, clarifying: "I never asked for any of that to be outside of unsafe."** That's correct. Putting raw `load`/`store`/`alloc`/`allocStack`/`elemAddr` in `@tsl/lowered` (D62 phase 1) gave lowered code unsafe power without `@tsl/unsafe`'s gate (`unsafeModules`) or its rules. That was the builders' design and my review missed it. It was never the owner's.
- **Owner, on how hard to steer:** "raw-memory printing is temporary" is enough, not a hard steer. So there is no relabelling round and no reordering. Phase 1's raw operations are noted as transitional and retire on the normal path toward item 11. The one firm rule left is to add no new unchecked operation that lowered code can import.
- *Order:* unchanged.

## 2026-12-31

**Coordinator: R17 verified** (manifest MATCH; gate from clean 275 of 275 in 96.4 min; sample 8/8 the same, seed 18451). Highest per-job peak 2.46 GiB.
- `@tsl/gc`'s freeing step went from 144 to 58 instructions (the direct route's is 65), and making an object costs the same as the direct route. D39/D41 are unchanged: a skipped `return 0` release is the same step, in the same order, still counted. `rc_steps_leaves.ts` pins exact step counts at four budgets and agrees with the host simulation.
- `rc` reshaped programs over 1.00× went from 19/21 to 7/10 (-O1/-O2). `auto` takes nothing new yet. What's left is mostly objects the direct route keeps on the stack while class printing counts every one, plus maps.
- `JsArray` gets a `holes` flag. A direct-route bug was found and fixed along the way: in `leak`/`manual`, a pop left the dropped reference in its slot, so lengthening the array again read it back where JS gives `undefined`.
- **3a (the fresh-allocation rule) is deferred, for the owner.** It can't reach operandWork's or sequenceWork's reads without per-call write summaries and cross-function tracking of `JsArray.data`, and its soundness would rest on every `@tsl/unsafe` module's promises. The alternative, a lowered-only unchecked `get`, is a new API. *Owner review:* both options. The cost is about 2–12% on two benchmarks in class printing only.
- **Test-integrity problem found (R17 surprise, widened by me):** `compiler/host/program.ts` throws `TSL_TEST_PATCH: no <from> in <file>` when an injected bug's text no longer matches the source. Older fault boxes count any failure as "caught", so a stale fault passes while testing nothing. R17 found two (box 21's since R4, and JsMap's `no-norm`). Its own runner excludes this, but nothing else does.

**Decision: R18 first fixes fault integrity, then stack placement in `rc` class printing.**
1. *Integrity:* one shared rule: a fault whose patch doesn't apply is a harness failure, never "caught". This applies to every place faults are injected (`TSL_TEST_PATCH`, patch lists in milestones, quick.ts, std-tests, gc-tests, r*-tests). Audit every fault list, repair each stale patch so it targets real code again, and report each one found (name, box, since when, and whether it's caught now). A fault that is genuinely no longer caught is a finding, not something to hide.
2. *Then:* keep non-escaping objects on the stack in `rc` class printing, as the direct route does (the remaining `rc` cost). Then the speed rule decides what `auto` takes in `rc`.
- *Next:* maps in `rc` (`@tsl/std` tables), strings and exceptions in `rc`, then item 11.

## 2026-12-30

**R17 is built (builder's report; for the coordinator to verify).** `rc` class printing's freeing step and allocation, and two array costs. SPEC 3.5 (`ex-gc-rc.ts`, `ex-gc-roomarray.ts`, `ex-jsrt-array.ts`, `ex-jsrt-map.ts` blocks), 8.3, D39, D66 and M5's R17 record. No check or case was dropped; no limit moved. Nothing was added to TSL itself; `@tsl/unsafe` gained `releaseIsEmpty` (below).
- **Measured first** (instructions; TCG, `tmk profile --instructions`):

  | What | Direct route | Class printing, R16 | R17 |
  |---|---|---|---|
  | Freeing an object with no slots, one step (adv_forof_mutation.ts), -O1 / -O2 | 65 / 65.5 | 144.2 / 143.2 | 58.3 / 58.3 |
  | Freeing with the collector linked (adv_temporaries.ts), an allocation | 70.0 | 113.9 + 60.5 | 87.4 |
  | Making one, -O2 (`churn`'s turn: a `new`, its drop, the loop) | 59.2 | 23 + `make` 19.2 + `tryMake` 54 | 59.3 |
  | Counts (`share`, `drop`) | inlined | inlined, the same work | unchanged |
  | adv_forof_mutation.ts's `replaceCurrent`, a call, -O1 / -O2 | 31,958 / 24,893 | 44,357 / 46,373 | 23,915 / 23,889 |

  Where the 143 went: 12 registers saved, the `stepping` flag, the cursor's three words read and written back every call, `spare` set and read back around the release function's call (which, inlined, was `return 0`), a compare chain, a tagged reference made, and checked usize arithmetic at four instructions each (the budget, the index, `stepsTaken`, `liveObjects`, the freed count, the generation).
- **Built:**
  - `@tsl/gc`: a store whose release function is `return 0;` alone (tslc's `releaseIsEmpty`) is marked in its entry, and `runSteps` frees such objects in a loop that calls nothing, handing the rest of the budget to `freeSteps` (the general loop) at the first object that isn't one.
  - The budget is counted down unchecked, the step count wraps, and each store's made and freed counts live in its entry (`rcLive` adds them up).
  - `make`, `makeTail` and `makeTailKeep` are inlined, with their slot taken in line. `quickFree` skips the empty call too. `sizeClass` uses leading zeros.
  - tslc no longer evaluates an `objectAt` given straight to `retireObject`.
  - `JsRoomArray`'s `push`, `setLength` and `clear` are inlined.
- **D39 and D41 unchanged:** the skipped call does nothing and gives 0, and freeing takes the same step for it, in the same order, counted. The quick path stops at the first object with slots, or one a scan gave up. The collector's code isn't touched. corpus/rc/rc_steps_leaves.ts pins the counts (budgets 32, 1, 2, 3), with the host, which calls every release function, agreeing. Every existing count, and box 21's and native-e's boxes, are unchanged.
- **3a, `get`'s check: the fresh-allocation rule can't reach it, so neither it nor the fallback is built; that needs the owner.**
  - In operandWork's loop, the store between the lowering's length and `get`'s check goes through a buffer address loaded from the array's `data` each turn. The turn's full path also calls `pushGrow`. sequenceWork's reload of `bag.items` is the same.
  - The rule needs the store's address known to be fresh. A loaded field that a call may replace isn't, and a call's writes aren't visible stores at all.
  - Reaching it would take per-call write summaries (trusting the allocator's contract) and cross-function points-to for `JsArray.data`. That is a bigger rule, and its soundness against `@tsl/unsafe` code would rest on every unsafe module's SAFETY promises.
- **3b, `JsArray`'s `holes` flag:**
  - A fourth constructor argument. False for an array of numbers or bytes: a pop is the length's store, and growth zeroes nothing past the copy.
  - A longer length zeroes what it adds when there are no holes, so a slot below the length never reads anything but what was written or zero.
  - The first form left that to the lowering and broke compiler/rt's map, which lengthens its buckets expecting zeros (app_lru.ts trapped 2). `JsRoomArray` had that assumption too; nothing reached it, and now it zeroes the same way.
  - **Found and fixed:** in `leak` and `manual` the direct route's pop didn't clear the slot it drops from an array of references, so a longer length read the popped object back where JS reads a hole. Its pop now clears in every mode, as shift and a shorter length already did (r17_free.ts's `objectPopHole`).
- **After** (class printing / direct, instructions):
  - The 29 reshaped `rc` programs over 1.00: 19/21 at -O1/-O2 before, 7/10 after.
  - Still over: small programs whose objects the direct route keeps on the stack while tslc's `rc` counts every object (read_checks 1.32/1.43, relative_import, closure_selected, reshape_order, cyc_exhaust); maps' tables (map_grow_oom 2.19, r2_maps); and at -O2, grow_reuse 1.06, r3_arrays 1.03 and closure_escape 1.004.
  - sequenceWork 1.207/1.592 → 1.000/1.296 (`bag` in the call region, read again each turn). operandWork `leak` 1.024/1.181 → 0.975/1.119, `manual` 1.028/1.186 → 0.979/1.124.
- **`auto`: nothing new.** `TRUSTED_IN` is unchanged. Coverage is unchanged (`route-blockers`, -O2): `strict` 30 + 18, `leak` and `manual` 63 + 43 each, `rc` 19 + 0.
- **JPEG and S4:** JPEG's TIR is byte-identical at every level through both routes, and no TSL proper pin moved.
- **Injected bugs**, each caught by a wrong answer (box 54):
  - quick path one past the budget: 10 cases;
  - quick path's step not taken (the decrement skipped): 6;
  - every release taken as empty: 10;
  - `JsArray.pop` leaving a reference whatever the flag: 1;
  - a no-holes longer length not zeroing: 1.

  The brief's "fresh rule on a non-fresh reference" has no rule to put it in.
- **Pins:** 180 of 3,864 moved, none TSL proper's, none unexplained (tools/r17-pins.ts, tools/r17-moved.ts). 39 of them are in the read-only pre-strings file, set aside by key.
- **Harness:**
  - Box 21's "a freeing step doing a whole object's slots at once" had targeted text R4 removed, so from R4 to R16 its patch threw and the box counted that as caught. It now runs against `freeSteps`.
  - The same is true today of pipe-d's JsMap bug `no-norm`: its text is `scratch`, the source's is `s`. I left it for you, not R17's.
  - pipe-d box 5's expected printing now has `JsArray`'s fourth argument.
- *Rejected:* trusting `rc` class printing (still over 1.00 on 7 and 10 programs); the lowered-only unchecked read (owner's call); counting leaves' freeing as zero steps (D39).
- *Next:* placement in `rc` class printing (stack objects, as the direct route does), which is most of what's left in `rc`; the call region's `bag` in sequenceWork; the owner's ruling on 3a.

## 2026-12-29

**Coordinator: R15 and R16 verified together** (manifest MATCH, tree 446d4b094911848a; gate from clean 273 of 273 in 93.2 min; sample 8/8 the same, seed 17389). Highest per-job peak 2.51 GiB (pipe-d/47); native-e/3 down from 2.84 to 1.69/1.87 GiB.
- Box 9 now compares medians over iterations 180–199 with the same inequalities and same-page thresholds. It's not weaker: a wrong verdict needs 10 of 20 samples wrong, not one, and two injected diagnosis bugs still fail it. Accepted.
- `JsArray`/`JsArenaArray`: the constructor makes one block, `push`/`setLength`/`clear` are inlined, and the printer drops a dead length re-read after a push. operandWork went from 1.32× to 1.03× at -O1; acyclicWork and vecWork are now below 1.00. JPEG is byte-identical and no hand-written TSL pin moved. 97 lowered pins moved, each explained.
- `auto` takes nothing new: operandWork at -O2 (1.11–1.19) and sequenceWork (1.21/1.59) still lose.
- The builder used `pgrep -qf` once more (it only observed). That's two rounds running; the brief now says why: it matches its own command line.
- Not pushed: the owner's one push was used on 2026-12-25. R15 and R16 wait for the owner.

**Decision: R17 takes `rc` class printing's costs, since that's what `rc` needs.** `leak`/`manual` already get their reshaped programs through phase 1's printing, so class printing's remaining losses there cost speed, not coverage. In `rc`, class printing is the only TSL route (19 exact, 0 reshaped taken).
- *First:* `@tsl/gc`'s freeing step (143 instructions against the direct route's 65), measured and brought down. Same D39 bound and same collector behaviour.
- *Then, the two array costs R16 found,* which `rc` class printing pays too:
  - (a) `get`'s check on a read the lowering already proved in bounds. **I'm choosing the optimiser rule over a lowered-only unchecked read.** The rule is that memory from a fresh allocation can't be what an older reference points to, so a store into it can't change an older array's length. It's general, helps hand-written TSL too, and adds no API. A lowered-only `getUnchecked` is the fallback only if the rule can't reach it, and it would need owner review.
  - (b) a "never has holes" flag on `JsArray` (as `JsRoomArray` has), so `pop` on an array of numbers skips the capacity check and slot clearing.
- The speed rule decides what `auto` newly takes in `rc` (and, with (a) and (b), reshaped class printing in `leak`/`manual`).
- *Next:* strings and exceptions in `rc`, then item 11.

## 2026-12-28

**R16 is built (builder's report; for the coordinator to verify).** `JsArray` construction and `push` in class printing, native-e box 9's timing check, and native-e box 3's memory. SPEC 3.5 (both array classes' `// file:` blocks), 3.7, 8.3, D66 and M5's R16 record. Nothing was added to TSL; no check or case was dropped; no limit moved.
- **Measured first** (instructions a call, class printing forced / direct, -O1 and -O2, `manual`):

  | Program | -O1 | -O2 | Where the difference went |
  |---|---|---|---|
  | operandWork | 1.321 | 1.574 | `grow` 351 calls a call at 76 to 88 (201 from the constructor), `push` a call each (1,100 at 18.8); the rest the same |
  | acyclicWork | 1.127 | 1.194 | a literal made by the constructor plus a growth, not one block |
  | vecWork | 1.064 | 0.870 | `push` a call; a `pop` two (`setLength` 18, `clear` 13) |
  | churn's arrays / arraysOfObjects | 1.50 / 1.59 | 1.57 / 1.75 | `grow` 73, and `@tsl/std`'s `Heap.allocBytes` 55 to 66 against `__heap_alloc`'s 44 |
  | churn's arraysGrowing | 1.07 | 1.02 | `push` a call |

- **Built:** both array classes are made at their final size in one step by an inlined constructor (one zeroed block, no growth); `push` inlined, a store and the length raised while there's room, growth a call out of line; `setLength` and `clear` inlined; growth leaner. A constructor now takes `@tsl.inline`/`@tsl.noinline` (a hint only; no constructor had either before, so nothing moved by it). The printing leaves out the length read after a push whose value nothing uses.
- **After:** operandWork 1.028 and 1.186 (`leak` 1.024, 1.181); acyclicWork 0.835, 0.922; vecWork 0.733, 0.793; arraysGrowing 0.759, 0.967 (`leak` 1.016, 1.337); arrays 1.216, 1.295; arraysOfObjects 1.364, 1.527 (those two are `@tsl/std`'s heap, TSL proper, not changed here).
- **`auto`: nothing new.** Over the reshape benchmarks (counted, strict/leak/manual): operandWork 0.96/1.02/1.03 at -O1 and 1.11/1.18/1.19 at -O2, sequenceWork 1.21 and 1.59. What's left in operandWork is `get`'s check on a read the lowering made unchecked (6,000 instructions a call) and the growth path; in sequenceWork, `pop`'s room check and clearing of the popped slot. `TRUSTED_IN` is unchanged and so is coverage (`node tools/route-blockers.ts`, -O2, `auto`'s take: `strict` 30 exact + 18 reshaped, `leak` and `manual` 63 + 43 each, `rc` 19 + 0, as R15). JPEG: the same TIR at every level; S4: no TSL proper pin moved.
- **Box 9:** the same two inequalities over each variant's median of iterations 180 to 199, the page shares as before; two bugs put into the diagnosis each fail it (in the box every run). Argued in 8.3.
- **Box 3's memory:** 2.06 to 2.17 GiB alone → 1.81 and 1.85: `rcPrograms`' lowering of every program moved to a child process, and a compile worker past 512 MiB let go after its job (the workers' 640 MiB limit doesn't hold under `--max-old-space-size`).
- **Pins:** 97 of 3,864 moved, all lowered, none of TSL proper's, none unexplained (75 pinned again, 22 in the read-only pre-strings file set aside by key).
- *Rejected:* an unchecked read for lowered code (an API or rule change, the owner's call); changing `@tsl/alloc`'s heap (TSL proper's, and its pins mustn't move).
- *Next:* the read the lowering proved, and `pop` in an array of numbers (a `holes` flag as `JsRoomArray` has), before `auto` can take reshaped class printing; then `@tsl/gc`'s step cost.

## 2026-12-27

**Coordinator: R15 not yet verified.** Its gate passed 270 of 271 jobs (93.8 min) and verify-manifest says NO MATCH. The failure is native-e/9@2.
- What box 9 checks: `reused.ms > paced.ms`, comparing ONE wall-clock sample each (iteration 199). A single 6.8 ms hiccup at load 165 in the "budget 2" run flipped it. The program is built at -O0 explicitly, so R15's passes can't reach it, and it passed twice alone.
- That is a fragile check, not an R15 bug, but "no MATCH, no acceptance" stands. Nothing is pushed until a gate matches.
- *Decision:* R16 makes box 9's comparison robust without weakening it: the same inequality, over the median of the last N iterations of each variant instead of one sample. It argues in SPEC why that's at least as strong, and shows the check still fails when the diagnosis is broken (an injected bug). R16's gate from clean then verifies R15 and R16 together.
- Accepted from R15's report: `conds` and `version` as designed (soundness argued in D73; four injected bugs caught; a new trap program with 30 cases); 842 pins moved, all at -O1/-O2 and every one re-pinned exactly; S4 -O2 median from 1.129× to 1.040× clang (matmul 2.53× to 1.05×); JPEG not slower.
- The unit test change ("with `checks` off the bounds check stays" now also turns off `conds` and `version`) is not a weakening: the claim it tests is about `checks`, its assertions are unchanged, and -O1 assertions were added.
- R13's "double bounds check" was really a repeated null test, which `conds` removes. operandWork and acyclicWork's cost is `JsArray` construction and an un-inlined `push`; `rc`'s is `@tsl/gc`'s freeing step (143 instructions against 65).
- Memory margin: native-e/3@0 peaks at 2.84 GiB against the 3 GiB watchdog (R12 reported 2.32 as the highest). It's the same in the previous manifest, so it isn't R15's, but the margin is thin.

**Decision: R16 takes `JsArray` construction and `push` in class printing**, the cost that keeps class printing slower than the direct route in `leak`/`manual` (operandWork 1.34–1.58×, acyclicWork 1.13–1.20×).
- Build array literals at their final size in one step (no general growth), and give `push` a fast path the inliner takes, as the direct route's `__vec_new` and push do.
- The -O0 pins of lowered programs using `JsArray` will move (D44 allows that for a library change; each is listed).
- Also: the box 9 fix above, and native-e/3's memory margin (find what peaks; bring it back under about 2.5 GiB without raising the watchdog).
- *Next:* `@tsl/gc`'s per-step cost (R17), then `rc` class printing in `auto`, then item 11.

## 2026-12-26

**R15 is built (builder's report; for the coordinator to verify).** Pile item 10, loop versioning, with check elimination where it serves it. SPEC 4.3 (`conds`, `version`), D44, D73 and M5's R15 record. Nothing was added to TSL; no check or case was dropped; no limit moved. `auto` takes nothing new (below).
- **Measured first** (instruction counts, TCG with `TMK_ICOUNT=1`, and `tmk profile --instructions`):

  | Program, -O1 unless said | Class printing / direct | Where the difference goes |
  |---|---|---|
  | JPEG decoder, one decode of tower-portrait | 94,163,802 / 93,415,815 = 1.0080 | 730,000 of the 748,000 extra in `toRgba`'s pixel loop: three null tests per pixel, each the second test of one SSA value on a path the first had decided (the rest: arena arrays made and grown, 28,000) |
  | JPEG decoder at -O2 | 0.9978 | |
  | operandWork, `manual` | 1.344 (-O2 1.576) | `JsArray`: `push` a call each element (18.8 instructions), growth from the constructor 68 to 88 a time against `__vec_new`'s 32 to 51; the same allocations in both routes |
  | acyclicWork, `manual` | 1.127 (-O2 1.195) | the array literal built by the constructor and a growth, not one exact allocation |
  | `rc` class printing, 29 programs | 18 of 29 over 1.00 at -O1, 19 at -O2, up to 2.19 | `@tsl/gc`'s freeing steps (`runSteps` 143 instructions a step against `__rc_work`'s 65) and `tryMake` (adv_forof_mutation.ts) |

  So checks were the cost only in the JPEG decoder's class printing, and there not the double bounds check R13 named but a repeated null test.
- **Built** (compiler/tir/passes/conds.ts, version.ts; manager.ts):
  - `conds`, -O1 and -O2: a test a test above it answered goes. Facts come from an edge into a block reached by that edge alone (the entry block excepted) and from a bounds check passed; they hold in every block that block dominates. A branch on a known value becomes a jump, an integer compare the facts decide becomes its constant, a bounds check with `i < n` known goes. One walk of the dominator tree.
  - `version`, -O2: loop versioning. A guard in the preheader (plain arithmetic and compares of values from outside the loop, a divisor made at least 1) chooses a fast copy without the checks it proves, or the loop as it was. Indices: from outside the loop, the counter plus an offset, or the counter times a stride plus an offset, against a length from outside the loop. Sound by construction: the fallback is untouched, the guard can't trap or write, and its values can't change in the loop. Not the "hoisting with a guard" D73 rejects: no check moves or runs earlier.
- **After** (instruction counts): the JPEG decoder's class printing at -O1 is 1.0003 to 1.0029 the direct route over six fixtures (was 1.0080 on tower), 0.990 to 0.994 at -O2; the direct route itself 1.5% fewer instructions at -O1 and 1.7% at -O2. Timed on HVF, two runs, load 5.5 to 6.5: within the timer's noise at -O1, 0.95 to 0.99 at -O2. operandWork and acyclicWork in class printing still 1.09 to 1.38 (their cost is `JsArray`'s, not checks'). S4's median native/clang at -O2 1.040 in both runs (1.129 with the passes off): matmul 2.53 to 1.05× clang, its fast inner loop free of checks; at -O1 1.181 and 1.177 (1.173 off), every S4 program's -O1 TIR byte-identical with and without the passes, so that's noise. The JPEG decoder against V8 1.076/1.081 at -O1 and 1.102/1.103 at -O2 (1.078 and 1.099 off). Nothing slower. -O1 compiles in 1.158× -O0's time (1.152× off).
- **`auto`:** takes nothing new. In `leak` and `manual` a reshaped class printing already falls back to phase 1's, which `auto` takes. The JPEG decoder's class printing has reshape kinds `auto` doesn't trust. `rc`'s class printing is still slower for reasons that aren't checks. Coverage is unchanged: `strict` 30 exact + 18 reshaped, `leak` and `manual` 63 + 43 each, `rc` 19 + 0.
- **Not done, needs its own step:** the per-turn array cost. Both routes allocate the same per turn, so stack placing or hoisting wouldn't close the gap. The gap is `JsArray`'s code: construction through the general growth, and `push` not inlined. Changing `JsArray` moves -O0 pins of every lowered program that uses it, so it should be a round of its own.
- **Injected bugs**, each caught by corpus/trap/loop_versions.ts at -O2 (pipe-d box 50; opt-a box 12 through a new first step): a fact from an edge that doesn't dominate (1 case), the guard one turn short (7), a bound or length the loop changes read once for the guard (2), every guard against the first check's length (1).
- **Pins:** 842 of 3,862 moved, all at -O1 or -O2, none at -O0, none unexplained, 53 of them TSL proper's. Each is pinned again in its file, so every pin is still compared exactly. tools/r15-moved.ts lists each one with the pass that moved it and that pass's counts for the build (`R15_REPINNED`).
- **Harness:** pipe-d boxes 49 and 50, tools/r15-tests.ts, tools/r15-pins.ts. tslc's `TMK_TRUST_IN` lets tools/r14-time.ts time what `auto` would take (measurement only). One existing unit test's assertion now also turns `conds` and `version` off: they prove the same check `checks` does, and the test is about `checks`.
- *Rejected:* versioning at -O1 (copies are -O2's, D73); trusting `rc` class printing (measured slower); changing `JsArray` this round (above).
- *Next:* `JsArray`'s construction and `push` in class printing, then `@tsl/gc`'s step cost, before item 11.

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
