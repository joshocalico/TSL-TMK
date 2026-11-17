// What `tmk milestone pipe-b` asks of @tsl/gc (SPEC 3.5, D63): each bug put into it has to be caught by its corpus,
// corpus/std/rc_gc.ts, which runs on V8 and JSC unpatched and natively patched, so a patched result that differs is caught.
import { runNative, wrongAnswers, type Engines } from "./corpus.ts";
import { faultFailures, patchEnv } from "./faults.ts";
import type { Fault } from "./std-tests.ts";
import { firstInOrder } from "./stable.ts";

const RC = "packages/tsl-gc/ex-gc-rc.ts";

export const GC_FAULTS: Fault[] = [
  {
    // What a missing `Rc.share` does: a second handle with no count of its own, so the first drop frees what it still
    // reaches. The generation is what catches it, as the poisoning build catches it in lowered `rc`.
    name: "Rc.share left out (a handle with no count)",
    file: RC,
    from: "c.write(n + 1n);",
    to: "",
  },
  {
    // What a missing `Rc.drop` does: nothing is ever freed. The no-leak checks catch it.
    name: "Rc.drop left out (a count never given back)",
    file: RC,
    from: "c.write(waiting | WAITING);\n    waiting = slot;",
    to: "",
  },
  {
    name: "release not called, so what a freed object held leaks",
    file: RC,
    // R4: runSteps finds the release function once an object, as rel. R17: freeSteps' first visit of an object, which says
    // how many slots it has, made to say none without the call, so the object is given back with what it holds unvisited.
    // R19: and freeFlat's, the same visit in the same words, which takes an object freeing starts with the cursor idle
    // (freeSteps then takes only an object part freed, or one a scan gave up): both, or the bug wouldn't be where freeing is
    times: 2,
    from: "s = callRelease(rel, item, 0, Visit.Drop);",
    to: "s = 0;",
  },
  {
    name: "freeing not bounded: a make frees everything waiting",
    file: RC,
    // every freeing call runs until nothing waits, on the path a make with the collector linked takes (R1c added the
    // collector's): since R1f that's freeOne, whose usual object quickFree frees outside runSteps' loop, so the bug is put
    // there, where it was caught before (corpus/std/rc_gc.ts's bounded freeing, whose Node can be in a cycle)
    // (R17: freeOne counts the steps it takes from what quickFree and runSteps give back)
    from: "  let took: u64 = cur === 0n && slot !== 0n && b >= FREES_STEPS ? quickFree(slot) : 0n;\n  if (took === 0n) took = runSteps(b < FREES_STEPS ? b : FREES_STEPS);",
    to: "  let took: u64 = 0n;\n  while (waiting !== 0n || cur !== 0n) took = BigInt.asUintN(64, took + runSteps(0x10_0000));",
  },
  {
    name: "a freed slot's generation left as it was, so a stale handle reads its next object",
    file: RC,
    from: "g.write(gen); // even",
    to: "// even",
  },
];

/**
 * Bugs put into `rc` as TSL (D74), for corpus/rc: three in the expansion, by TMK_TEST_RC_TSL, and one in @tsl/gc's freeing,
 * by patch. Each has to be caught: by a case disagreeing with the program as written on V8, by the host's poisoning of a
 * freed object (trap 5), by a no-leak check, or by a pinned count of steps.
 */
export const RC_TSL_FAULTS: (Fault & {
  env?: string;
  tslEnv?: string;
  optFault?: string;
  also?: string;
})[] = [
  { name: "a share left out by the expansion", file: "", from: "", to: "", env: "no-share" },
  {
    name: "a drop at a scope's exit left out by the expansion",
    file: "",
    from: "",
    to: "",
    env: "no-drop",
  },
  {
    name: "a borrow kept across a call that clears the only other holder",
    file: "",
    from: "",
    to: "",
    env: "elide",
  },
  {
    name: "a freeing step that visits every slot of an object at once",
    file: RC,
    // R17: put into freeSteps' loop over an object's slots after its first. (From R4 to R16 its text was runSteps' before R4,
    // which TSL_TEST_PATCH couldn't find, so the patch threw, and the box counted the thrown build as caught.) R19: and into
    // freeFlat's, the same loop in the same words (see the bug above)
    times: 2,
    from: "        callRelease(rel, item, a, Visit.Drop);\n        left = spare;\n        spare = 0n;\n        a++;\n      }",
    to: "        callRelease(rel, item, a, Visit.Drop);\n        for (let j = a + 1; j < s; j++) callRelease(rel, item, j, Visit.Drop);\n        left = spare;\n        spare = 0n;\n        a = s;\n      }",
  },
  {
    // B3: with no collector linked (every class in no cycle), an allocation frees everything waiting at once, not
    // RC_BUDGET steps of it. Results don't change, only the bound, so nothing caught it until corpus/rc/rc_steps_nocc.ts.
    name: "unbounded freeing at an allocation with no collector linked",
    file: RC,
    // R17: on the path `make` takes, which is inlined and takes its slot in line, so tryMake's own isn't on it
    from: "      else if (waiting !== 0n || cur !== 0n) runSteps(budget);\n      const head = ptrAt(u64, heads).add(this.k);",
    to: "      else if (waiting !== 0n || cur !== 0n) runSteps(0x10_0000);\n      const head = ptrAt(u64, heads).add(this.k);",
  },
  {
    // what a WeakRef that resurrects does: deref hands out an object whose count already reached zero
    name: "a weak reference resurrecting an object waiting to be freed",
    file: RC,
    from: "if (n === 0n || n >= WAITING) return undefined;\n    countAt(slot).write(n + 1n);",
    to: "if (n === 0n) return undefined;\n    countAt(slot).write(n + 1n);",
  },
  {
    // R1b: what a wrong size class does: every class in the smallest slots, so an object bigger than that overlaps the
    // next slot's prefix and fields. corpus/rc/rc_shared.ts's mixed sizes catch it.
    name: "two classes of different sizes in one size class",
    file: RC,
    from: "this.k = sizeClass(SLOT_PREFIX + elemSize(this.elem));",
    to: "this.k = sizeClass(SLOT_PREFIX);",
  },
  {
    // R1b: a generation check dropped where a reference can go stale: every class taken as one the expansion counts
    // exactly, hand-written stores included. corpus/std/rc_gc.ts's stale copies catch it.
    name: "a generation check dropped on a reference that can go stale",
    file: "",
    from: "",
    to: "",
    tslEnv: "exact-all",
    also: "rc_gc",
  },
  {
    // R1b: the compiler bug fixed in R1b, put back: a function value written to raw memory as an i64 (@tsl/gc's table of
    // release functions, and corpus/mem/fnval_mem.ts). The TIR verifier rejects what it makes.
    name: "a function value in raw memory written as an i64 (R1's compiler bug)",
    file: "",
    from: "",
    to: "",
    tslEnv: "fnval-i64",
    also: "fnval_mem",
  },
  {
    // R1d: closed-world release dispatch (D70's form) with each number calling the next function's release, so freeing
    // and the collector visit an object through another class's release function.
    name: "the release dispatch calling the wrong class's release function",
    file: "",
    from: "",
    to: "",
    tslEnv: "release-wrong-arm",
  },
  {
    // R1d: the unreached-function pass taking only exports as roots, so it removes what the runtime and the drivers call
    // by name (`__init`, `__statics`, the page source's `__pages_*`): the image can't be built, or runs without them.
    name: "the unreached-function pass removing a function the runtime calls by name",
    file: "",
    from: "",
    to: "",
    optFault: "unreached-drop-runtime",
  },
];

/**
 * Bugs put into @tsl/gc's cycle collector (R1c, D41), by patch, and one into the expansion's barrier on a vector's moves.
 * Each has to be caught by corpus/rc (the churn, shapes, interleavings at budgets 1 to 32, and the large shapes), natively:
 * a live object freed shows as a wrong digest or a trap, and a collector that stops collecting as trap 14 under the churn's
 * page limit. The host runs the library as written, so it's what the patched native build is compared with.
 */
export const RC_CC_FAULTS: (Fault & { env?: string })[] = [
  {
    name: "the collector's barrier skipped: a count operation on an object in a scan doesn't mark it held",
    file: RC,
    from: "  if ((n & ST_MASK) !== ST_WHITE) return;\n  ca.write((n & NOT_ST_MASK) | ST_HELD);\n  ccDirty = true;\n  ccTouched++;",
    to: "  if ((n & ST_MASK) !== ST_WHITE || n === n) return;",
  },
  {
    name: "an object's count not compared with the edges found to it",
    file: RC,
    from: "(n & COUNT) !== (n & EDGES) >> 32n) {",
    to: "(n & COUNT) !== (n & COUNT)) {",
  },
  {
    name: "what a held object refers to not followed",
    file: RC,
    from: "  if ((n & ST_MASK) !== ST_WHITE) return;\n  ca.write((n & NOT_ST_MASK) | ST_HELD);\n  ccDirty = true;\n}",
    to: "  if ((n & ST_MASK) !== ST_WHITE || n === n) return;\n}",
  },
  {
    name: "a touch not asking for another marking pass",
    file: RC,
    from: "  ca.write((n & NOT_ST_MASK) | ST_HELD);\n  ccDirty = true;\n  ccTouched++;",
    to: "  ca.write((n & NOT_ST_MASK) | ST_HELD);\n  ccTouched++;",
  },
  {
    name: "deref not asking whether the collector has decided its target is garbage",
    file: RC,
    from: "      if ((ccPhase === 3 || ccPhase === 4) && (m & ST_MASK) === ST_WHITE) return undefined; // decided: garbage (D41)\n",
    to: "",
  },
  {
    // R1d: pacing that never starts a scan, so only exhaustion collects; the churn tests forbid the heap walk
    // (rcSetWalk), so the garbage cycles whose candidates the full table forgot run the heap out: trap 14.
    name: "pacing that never starts a scan",
    file: RC,
    from: "    if (ccPhase === 0 && (ccTop === 0 || (pacing && ccGap > 0 && !ccExh))) break;",
    to: "    if (ccPhase === 0 && !ccExh) break;",
  },
  {
    // R1e: a scan giving up an object a decrement left a count on, as if it had reached zero, so freeing frees an
    // object something still holds.
    name: "a scan giving up an object whose count isn't zero",
    file: RC,
    from: "    ca.write(n - 1n);\n    if (n >= ST_WHITE) {\n      touch(x);",
    to: "    ca.write(n - 1n);\n    if (n >= ST_WHITE && ccPhase !== 3 && ccPhase !== 4 && waiting <= QLINK) {\n      ca.write(WAITING | ST_GONE | ((n - 1n) & LINK_A) | waiting);\n      waiting = x;\n      ccPending++;\n    } else if (n >= ST_WHITE) {\n      touch(x);",
  },
  {
    // R1e: the decision taken while an object the scan gave up still holds references the scan counted as edges, so
    // what it holds can be decided garbage and freed, and then freed again when freeing drops it (3.5's argument).
    name: "a scan deciding before what it gave up has been freed",
    file: RC,
    from: "    if (!ccDirty && ccPending !== 0) {",
    to: "    if (!ccDirty && ccPending !== 0 && ccPending === 0) {",
  },
  {
    // R1e: finding edges through an object the scan gave up, whose references freeing may already have dropped, so an
    // edge is counted that no count stands for.
    name: "a scan finding edges through an object it gave up",
    file: RC,
    from: "  if ((countAt(ccCur).read() & ST_MASK) < ST_GONE) {",
    to: "  if ((countAt(ccCur).read() & ST_MASK) < ST_GONE || ccCur !== 0n) {",
  },
  {
    name: "the expansion's barrier on a vector's moved elements left out",
    file: "",
    from: "",
    to: "",
    env: "no-move-touch",
  },
  {
    // R1f: freeing's fast path (quickFree) leaving the cursor of an object with more than one reference slot at its first
    // slot again, so runSteps visits it twice: the count it held dropped twice.
    name: "freeing's fast path visiting an object's first slot twice",
    file: RC,
    from: "    cur = slot;\n    at = 1;\n    slots = s;",
    to: "    cur = slot;\n    at = 0;\n    slots = s;",
  },
];

/** One R1 fault: how many of corpus/rc's cases are caught, natively or on the host, with it in. */
export async function rcTslFaultRun(
  f: Fault & { env?: string; tslEnv?: string; optFault?: string; also?: string },
  accel: "hvf" | "tcg",
  jobs: number,
  engines: Engines,
): Promise<{ caught: number; answers: number; first: string; broken: boolean }> {
  if (f.env !== undefined) process.env.TMK_TEST_RC_TSL = f.env;
  else if (f.tslEnv !== undefined) process.env.TMK_TEST_TSL = f.tslEnv;
  else if (f.optFault !== undefined) process.env.TMK_OPT_FAULT = f.optFault;
  // a patch checked against the source first (SPEC 8.3): one that doesn't apply throws, failing the box, never caught
  else
    process.env.TSL_TEST_PATCH = patchEnv({
      file: f.file,
      from: f.from,
      to: f.to,
      ...(f.times !== undefined ? { times: f.times } : {}),
    });
  try {
    const r = await runNative("rc", [accel], jobs, undefined, engines);
    const failures = [...r.failures];
    // a hand-written store's program (corpus/std), or a program of corpus/mem, where the fault is meant to show
    if (f.also !== undefined) {
      const kind = f.also === "fnval_mem" ? "mem" : "std";
      failures.push(...(await runNative(kind, [accel], jobs, f.also, engines)).failures);
    }
    faultFailures(failures, f.name);
    // the function-value fault is caught by the TIR verifier, which is a compile failure by design
    const verifier = f.tslEnv === "fnval-i64";
    const counted = verifier ? failures.filter((x) => x.includes("TIR verifier")) : failures;
    return {
      caught: counted.length,
      // R7: what's caught by a wrong answer, not by running out of time. A bug that leaves a drop out leaks until cases
      // time out, and how many do depends on the host's load (box 21 saw 410 under load where a quiet run gave 223), so the
      // sampler compares this exactly and `caught` only as above zero (gate.ts's loadFreeCounts).
      answers: wrongAnswers(counted),
      first: (firstInOrder(failures) ?? "").slice(0, 200),
      // broken: the bug only ever stopped compiling, so nothing ran to show it. A bug whose expansion one program's checks
      // refuse (R1c: a share left out makes cyc_shapes.ts read a moved local, TSL3009) and others catch running is caught.
      broken:
        !verifier && failures.length > 0 && failures.every((x) => /"code":"(TS|TSL)\d+"/.test(x)),
    };
  } finally {
    delete process.env.TMK_TEST_RC_TSL;
    delete process.env.TMK_TEST_TSL;
    delete process.env.TMK_OPT_FAULT;
    delete process.env.TSL_TEST_PATCH;
  }
}

/** One fault: how many of the corpus's cases differ from V8 natively, with it in. */
export async function gcFaultRun(
  f: Fault,
  accel: "hvf" | "tcg",
  jobs: number,
  engines: Engines,
): Promise<{ caught: number; answers: number; first: string; broken: boolean }> {
  process.env.TSL_TEST_PATCH = patchEnv({
    file: f.file,
    from: f.from,
    to: f.to,
    ...(f.times !== undefined ? { times: f.times } : {}),
  });
  try {
    const r = await runNative("std", [accel], jobs, "rc_gc", engines);
    faultFailures(r.failures, f.name);
    const seen = r.failures.filter((x) => x.includes(` on ${accel}:`));
    return {
      caught: seen.length,
      answers: wrongAnswers(seen), // R7: as rcTslFaultRun's
      first: (firstInOrder(seen) ?? firstInOrder(r.failures) ?? "").slice(0, 200),
      broken: r.failures.some((x) => /"code":"TS\d+"/.test(x)),
    };
  } finally {
    delete process.env.TSL_TEST_PATCH;
  }
}
