// The optimiser's pass manager (SPEC 4.1, 4.3, D44, D46). -O0 is the TIR as lowered, untouched. -O1 is the passes that look
// at one function at a time and a few instructions at once: folding, branch folding and block merging, dead code, and
// inlining only where the call is the bigger of the two. -O2 adds what looks at the whole program: the call graph, inlining
// by cost, partial inlining of fast paths, calls through a known pointer, and the cleanup rounds after them. The verifier
// runs on the input and the output always, and after every pass in a test build. Any pass can be switched off by name.
import { appendFileSync } from "node:fs";
import { canonicalize, ValMap, type Cfg, type Func, type Instr, type Module } from "../ir.ts";
import { printFunc } from "../text.ts";
import { verifyFuncIn, verifyModule } from "../verify.ts";
import { Ranges, setRangeFaults } from "../range.ts";
import type { Loop } from "./loops.ts";
import { cfgFunc, type CfgStats } from "./cfg.ts";
import { checksFunc, type ChecksStats } from "./checks.ts";
import { condsFunc, type CondsStats } from "./conds.ts";
import { dceFunc, type DceStats } from "./dce.ts";
import { gvnFunc, type GvnStats } from "./gvn.ts";
import {
  inlineModule,
  type InlineFaults,
  type InlineStats,
  type OptLevel,
  type Remark,
} from "./inline.ts";
import { keepLoads, markDeadAtO0 } from "./keep.ts";
import { licmFunc, type LicmStats } from "./licm.ts";
import { loopBoundsFunc, type LoopBoundsStats } from "./loopbounds.ts";
import { setSepFaults, writeSummaries } from "./memory.ts";
import { unswitchFunc, type CopyRound, type UnswitchStats } from "./unswitch.ts";
import { versionFunc, type VersionStats } from "./version.ts";
import { simplifyFunc, type FoldFaults, type SimplifyStats } from "./simplify.ts";
import { r30Off, sroaFunc, type SroaStats } from "./sroa.ts";
import { removeUnreached, type UnreachedStats } from "./unreached.ts";
import { cloneModule, r26Off, r28Off, r35Off } from "./util.ts";

export type { OptLevel, Remark } from "./inline.ts";

/** Every pass by the name `--no-pass` and `TMK_OPT_DISABLE` take. */
export const PASSES = [
  "simplify",
  "cfg",
  "dce",
  "inline",
  "partial",
  "devirtualize",
  "sroa",
  "gvn",
  "licm",
  "unswitch",
  "peel",
  "checks",
  "loopbounds", // R7: -O1's bounds checks its loops' own tests prove (loopbounds.ts); -O2's `checks` proves them and more
  "conds", // R15: a test a test above it answered (conds.ts), at -O1 and -O2
  "version", // R15: loop versioning, -O2's (version.ts)
  "keep",
  "invariant",
  "unreached",
  // The AArch64 backend's -O1 and -O2 code shape (D75): the optimiser ignores these, and the TIR is the same without them.
  "globals",
  "thread",
  "fuse",
  "remat",
  "layout",
  "nullchecks", // R7: an explicit null check left to the next load's fault (shape.ts's implicitNullChecks)
  "shrinkwrap", // R21: the entry's quick way out before the prologue (emit.ts's shrinkWrap)
  "coldsplit", // R30: values live across cold calls only kept in their slots around them (regalloc.ts's coldCalls)
] as const;

/** Bugs that can be put into the passes, to show the tests catch them (`tmk milestone opt-a`, D46). */
export const OPT_FAULTS = [
  "fold-wrong", // a constant add folds to one more than it is
  "fold-drop-check", // a checked operation that overflows is folded as if it didn't
  "fold-self-compare", // an integer compared with itself folds as though the two differed (pipe-h)
  "fold-pow2-mask", // an unsigned remainder by 2^k becomes an and with 2^k, not 2^k - 1 (R1f)
  "fold-shift-back", // a shift left and back is folded as lossless whatever the value's width: `<<` loses its trap (R1f)
  "dce-drop-store", // a store of a constant is removed as if it had no effect
  "inline-swap-args", // the first two parameters of the same type are swapped
  "inline-drop-check", // an inlined check becomes its operand: its trap can't happen
  "inline-ret-order", // a callee's results come back reversed
  "inline-impure-prefix", // partial inlining counts stores as free of effects, so a slow path runs them twice
  "inline-drop-rc-store", // a store in an inlined `rc` runtime function is left out: a count missed
  "inline-alloca-pure-block", // R20: partial inlining takes a block with a frame slot as free of effects, whatever follows it
  "keep-off", // a load the optimiser left unused isn't kept, so a fault it would have taken doesn't happen
  "dce-drop-live", // dead code removal takes a value something still uses: TIR the verifier rejects, naming the pass
  "gvn-across-store", // value numbering merges two loads either side of a store that changes what they read (D73)
  "licm-hoist-written", // loop-invariant code motion moves a load out of a loop that writes to it (D73)
  "licm-above-guard", // loop-invariant code motion moves a load that can fault above its loop's test (D73)
  "checks-drop-bounds", // check elimination removes a bounds check whose index may equal the length (D73)
  "checks-off-by-one", // check elimination removes an overflow check whose result may be one past its limit (D73)
  "loopbounds-inclusive", // -O1's loop bounds proof takes a test `k <= m` for `k < m`, so a check that fires on the last turn goes (R7)
  "conds-not-dominating", // a fact from a branch's edge is used where that edge's block is reached from elsewhere too (R15)
  "version-off-by-one", // loop versioning's guard lets the fast copy run one turn more than its checks allow (R15)
  "version-bound-in-loop", // loop versioning reads a length the loop can change once before it, for its guard (R15)
  "version-wrong-length", // loop versioning's guard checks every index against the first check's length (R15)
  "clsid-ignore-store", // tslc's rule for fields nothing writes after construction misses a store after it (D73, 3.4)
  "unreached-drop-runtime", // the unreached-function pass takes only exports as roots, not what the runtime calls by name (R1d)
  // The AArch64 backend's -O1 and -O2 code shape (B3, D75): read by the backend from the same variable.
  "b3-global-addend", // a global's PC-relative access is 8 bytes past the field it means
  "b3-thread-invert", // branch threading sends an edge where the second test would not have taken it
  "b3-fuse-invert", // a compare with zero fused into its branch is cbz where it should be cbnz, and the reverse
  "b3-remat-stale", // a rematerialised value's operands aren't kept live to its uses, so their registers can be reused first
  "b3-layout-stale-next", // after loop rotation, a block falls through to the next block in TIR order, not in layout order
  "b3-null-past-store", // a null check is left to a load that comes after a store, so the store runs where -O0 trapped first (R7)
  "r21-shrinkwrap-callee", // shrink-wrapping takes a callee-saved register as free, so the quick way writes it unsaved (R21)
  "r23-range-lo", // a 32-bit signed range check whose upper bound is the type's own loses its lower bound too (R23)
  "r25-add-narrow", // a checked unsigned 64-bit add with one operand 64 bits wide loses its tests, as if both were 32 (R25)
  "r26-rel-any", // range.ts reads a signed loop test as the unsigned one whatever either side's sign (R26)
  "r26-fcmp-swap", // range.ts decides a float compare of two converted i32s from the integers the other way round (R26)
  "r26-lb-const", // -O1's loopbounds takes `k < c` as false for any constant c, not only 0 (R26)
  "r26-round-swap", // in -O2's second or later copying round, an unswitched loop's two copies take each other's way (R26)
  "r27-summary-miss", // a call's write summary misses a write: a store anywhere but a frame slot taken as one into a block (R27)
  "r27-alias-any", // the separation misses an alias: every 64-bit word loaded taken as a separated field's block (R27)
  "r28-consts-any", // dominating conditions take any two integer constants of a type as the same operand (R28)
  "r28-tag-keep-wrong", // `ref.addr (or x, tag)` folded to the tag's pointer, not x's: the address dropped (R28)
  "r28-shrink-store", // a callee only the no-growth rule lets in is copied without its first store (R28)
  "r28-version-again", // -O2's second versioning pass lets the fast copy run one turn past what its checks allow (R28)
  "r29-inb-any", // the inliner takes a callee's leading bounds check out of every call, not only those tslc proved in bounds (R29)
  "r30-copy-stale", // a copy out of a promoted frame slot stores each field as the fill left it, not its last value (R30)
  "r30-split-norestore", // a value split around a cold call is stored before it but never loaded back after (R30)
  "r30-split-save-late", // a value split around a cold call is stored after the call's arguments are moved, not before (R30)
  "r30-split-callee-free", // a value across cold calls only takes a callee-saved register the prologue doesn't save (R30)
  "r32-float-le", // range.ts takes a float's `x <= n` (n a converted i32) as `x < n`, so ToInt32 of it as below n (R32)
  "r32-float-int", // range.ts takes every float as an integer, so `x > 0` puts its ToInt32 at 1 or more (R32)
  "r32-float-nan", // range.ts takes a failed ordered float compare's opposite whether or not x may be NaN (R32)
  "r32-sat-any", // check elimination makes every js.toint32 the saturating conversion, proved in range or not (R32)
  "r35-round-header", // -O1's one round takes a loop header's parameter from its edges before the loop alone (R35)
  "r35-save-block-only", // a value split around a cold call is saved only where its block reads it after the call (R35)
  "r36-licm-stale", // LICM keeps the graph and loops after a loop had something moved out, so later loops are misread (R36)
  "r36-constkeys-shared", // value numbering's constant table kept from one function to the next (R36)
  "r36-consume-always", // every module optimised where it is, given up by its caller or not (R36)
] as const;

export interface OptOptions {
  level: OptLevel;
  verifyEach?: boolean;
  /** A measurement, never a build anyone ships: each call in the module adds one to `__rc_s_calls` first (SPEC D46). */
  countCalls?: boolean;
  disable?: readonly string[];
  faults?: readonly string[];
  /**
   * The module's producer names its roots the pass manager's way (exports marked `export`, the runtime's names starting
   * `__`), so at -O1 and -O2 what nothing reaches from them is removed (unreached.ts, R1d). tslc's modules do.
   */
  prune?: boolean;
  /**
   * R36: the caller gives the module up, and reads nothing of it afterwards (tslc's `compileTyped` and `lowerFile`, whose
   * module is made for this call alone): at -O1 and -O2 it's optimised where it is, not copied first. The result is the
   * same module either way (the copy was a deep one), and -O0 returns the input as always.
   */
  consume?: boolean;
}

export interface PassRun {
  pass: string;
  ms: number;
}

export interface OptReport {
  level: OptLevel;
  passes: PassRun[];
  remarks: Remark[];
  inline: InlineStats;
  simplify: SimplifyStats;
  cfg: CfgStats;
  dce: DceStats;
  sroa: SroaStats;
  gvn: GvnStats;
  licm: LicmStats;
  unswitch: UnswitchStats;
  checks: ChecksStats;
  loopBounds: LoopBoundsStats;
  conds: CondsStats;
  version: VersionStats;
  keptLoads: number;
  unreached: UnreachedStats;
  callsBefore: number; // call and call.indirect instructions in the module, before and after
  callsAfter: number;
  costBefore: number;
  costAfter: number;
  ms: number;
}

// For the test harness only (SPEC 8.3, D51): with TMK_LEVEL_TRACE naming a file, a level this process takes from the
// environment, rather than one it was given, is noted there, once per value. It's how `tmk gate` proves a suite can't depend
// on the level. It changes nothing else, and a note that can't be written fails the compile, so none goes missing.
const levelNoted = new Set<string>();

function noteEnvLevel(file: string, raw: string | undefined): void {
  const k = raw ?? "unset";
  if (levelNoted.has(k)) return;
  levelNoted.add(k);
  appendFileSync(file, `${process.pid} TMK_OPT=${k}\n`);
}

// For the test harness's build store (tools/store.ts): how many times this thread took the level from the environment, so a
// stored build can say whether making it did, and a reuse can note it in the level trace as making it would have.
let envLevelReads = 0;
export function envLevelReadCount(): number {
  return envLevelReads;
}

/** The level and switches the environment asks for: what `tmk` sets for everything it runs (SPEC 9.2). */
export function optFromEnv(given?: OptLevel): OptOptions {
  const env = process.env;
  const raw = env.TMK_OPT;
  const trace = env.TMK_LEVEL_TRACE;
  if (given === undefined) envLevelReads++;
  if (given === undefined && trace !== undefined && trace !== "") noteEnvLevel(trace, raw);
  const level = given ?? (raw === "1" ? 1 : raw === "2" ? 2 : 0);
  const list = (s: string | undefined): string[] =>
    s === undefined || s.trim() === "" ? [] : s.split(",").map((x) => x.trim());
  return {
    level,
    verifyEach: env.TMK_OPT_VERIFY === "1",
    countCalls: env.TMK_OPT_COUNT_CALLS === "1",
    disable: list(env.TMK_OPT_DISABLE),
    faults: list(env.TMK_OPT_FAULT),
  };
}

function countCalls(m: Module): number {
  let n = 0;
  for (const f of m.funcs) {
    for (const b of f.blocks)
      for (const ins of b.instrs) if (ins.op === "call" || ins.op === "call.indirect") n++;
  }
  return n;
}

function moduleCost(m: Module): number {
  let n = 0;
  for (const f of m.funcs) for (const b of f.blocks) n += b.instrs.length + 1;
  return n;
}

/**
 * Optimises a module at a level. -O0 returns it unchanged, the same object, so its tirhash can't move. Otherwise the result
 * is canonical, and is the same for the same module, level and switches on every host.
 */
export function optimizeModule(
  input: Module,
  o: OptOptions,
): { module: Module; report: OptReport } {
  const t0 = performance.now();
  const report: OptReport = {
    level: o.level,
    passes: [],
    remarks: [],
    inline: { sitesBefore: 0, inlined: 0, partial: 0, devirtualized: 0, refused: 0 },
    simplify: { folded: 0, identities: 0, checks: 0, params: 0 },
    cfg: { branches: 0, merged: 0, forwarded: 0, removed: 0 },
    dce: { instrs: 0, params: 0 },
    sroa: { promoted: 0, loads: 0, stores: 0, copies: 0 },
    gvn: { pure: 0, checks: 0, loads: 0, params: 0 },
    licm: { pure: 0, loads: 0, checks: 0 },
    unswitch: { loops: 0, peeled: 0, cost: 0 },
    checks: { overflow: 0, ranges: 0, bounds: 0, compares: 0 },
    loopBounds: { bounds: 0, branches: 0 },
    conds: { branches: 0, compares: 0, bounds: 0 },
    version: { loops: 0, checks: 0, overflow: 0, cost: 0 },
    keptLoads: 0,
    unreached: { funcs: 0, globals: 0 },
    callsBefore: countCalls(input),
    callsAfter: 0,
    costBefore: moduleCost(input),
    costAfter: 0,
    ms: 0,
  };
  if (o.level === 0) {
    report.callsAfter = report.callsBefore;
    report.costAfter = report.costBefore;
    if (o.countCalls !== true) return { module: input, report };
    const counted = cloneModule(input);
    countCallsIn(counted);
    return { module: canonicalize(counted), report };
  }
  const off = new Set(o.disable ?? []);
  for (const d of off) {
    if (!(PASSES as readonly string[]).includes(d))
      throw new Error(`no optimiser pass named ${d}: ${PASSES.join(", ")}`);
  }
  const faults = new Set(o.faults ?? []);
  for (const x of faults) {
    if (!(OPT_FAULTS as readonly string[]).includes(x))
      throw new Error(`no optimiser fault named ${x}`);
  }
  // R26: range.ts's injected bugs, read by every Ranges this run makes (checks, LICM's first turn, versioning)
  setRangeFaults({
    relAny: faults.has("r26-rel-any"),
    fcmpSwap: faults.has("r26-fcmp-swap"),
    floatLe: faults.has("r32-float-le"),
    floatInt: faults.has("r32-float-int"),
    floatNaN: faults.has("r32-float-nan"),
    roundHeader: faults.has("r35-round-header"),
  });
  // R27: memory.ts's injected bugs, read by every pass this run asks what a write may change
  setSepFaults({
    summaryMiss: faults.has("r27-summary-miss"),
    aliasAny: faults.has("r27-alias-any"),
  });
  const fold: FoldFaults = {
    wrongFold: faults.has("fold-wrong"),
    dropCheck: faults.has("fold-drop-check"),
    selfCompare: faults.has("fold-self-compare"),
    pow2Mask: faults.has("fold-pow2-mask"),
    shiftBack: faults.has("fold-shift-back"),
    tagKeepWrong: faults.has("r28-tag-keep-wrong"),
  };
  const inlineFaults: InlineFaults = {
    swapArgs: faults.has("inline-swap-args"),
    dropCheck: faults.has("inline-drop-check"),
    retOrder: faults.has("inline-ret-order"),
    impurePrefix: faults.has("inline-impure-prefix"),
    dropRcStore: faults.has("inline-drop-rc-store"),
    allocaPure: faults.has("inline-alloca-pure-block"),
    shrinkStore: faults.has("r28-shrink-store"),
    inbAny: faults.has("r29-inb-any"),
  };
  const dceFaults = {
    dropEffect: faults.has("dce-drop-store"),
    dropLive: faults.has("dce-drop-live"),
  };
  // The input was verified by whoever lowered it (tslc's compileTyped and lowerFile), as the start of the pipeline (SPEC 4.3).
  // R36: the module given up by its caller optimised where it is (the injected `r36-consume-always`: every module)
  const m = o.consume === true || faults.has("r36-consume-always") ? input : cloneModule(input);
  // A class id's load, as lowering noted it (`Instr.inv`), is an invariant load from here on (D73): `load.T.inv`, which
  // value numbering, LICM and peeling may share across what can't change a class id (memory.ts). The first thing done, so
  // every copy inlining makes is one too.
  if (!off.has("invariant")) markInvariantLoads(m);
  const deadAtO0: WeakSet<Instr> = markDeadAtO0(m);
  const verify = (after: string, f?: Func): void => {
    if (o.verifyEach !== true) return;
    const errors = f !== undefined ? verifyFuncIn(m, f) : verifyModule(m);
    if (errors.length > 0) {
      throw new Error(
        `TIR verifier, after ${after}${f !== undefined ? ` on @${f.name}` : ""}:\n${errors.slice(0, 20).join("\n")}`,
      );
    }
  };
  const timed = (pass: string, run: () => void): void => {
    const t = performance.now();
    run();
    report.passes.push({ pass, ms: performance.now() - t });
    verify(pass);
  };
  // -O1 stops sooner: what one more round finds is rarely worth its time there.
  const rounds = o.level >= 2 ? 3 : 2;
  const local = (f: Func): void => {
    for (let round = 0; round < rounds; round++) {
      let changed = false;
      // In a test build each pass is checked on what it changed, so a failure names the pass.
      if (!off.has("simplify") && simplifyFunc(f, report.simplify, fold)) {
        changed = true;
        verify("simplify", f);
      }
      if (!off.has("cfg") && cfgFunc(f, report.cfg)) {
        changed = true;
        verify("cfg", f);
      }
      if (!off.has("dce") && dceFunc(f, report.dce, dceFaults)) {
        changed = true;
        verify("dce", f);
      }
      if (!changed) break;
    }
  };
  const cleanupAll = (name: string): void => {
    timed(name, () => {
      for (const f of m.funcs) local(f);
    });
  };

  // The inliner cleans each function up just before anything measures it, bottom-up, so there's no round before it.
  if (off.has("inline")) cleanupAll("cleanup");
  else {
    timed("inline", () => {
      inlineModule(m, {
        level: o.level,
        remarks: report.remarks,
        stats: report.inline,
        deadAtO0,
        faults: inlineFaults,
        partial: !off.has("partial"),
        devirtualize: !off.has("devirtualize"),
        cleanup: (f) => {
          const before = process.env.TMK_OPT_DEBUG === "1" ? printFunc(f) : "";
          try {
            local(f);
            verify("cleanup in the inliner", f);
          } catch (e) {
            if (before !== "") console.error(`${before}\n--- became ---\n${printFunc(f)}`);
            throw e;
          }
        },
        afterInline: (f) => verify("inlining", f),
      });
    });
  }
  // R30: -O1 takes scalar replacement of a new object placed in its slot only (sroa.ts's placedOnly), its frame slot
  // written straight into the slot; the rest of scalar replacement, and the cleanup round after inlining, stay -O2's.
  if (o.level === 1 && !off.has("sroa") && !r30Off("sroa")) {
    timed("sroa", () => {
      const sroaFaults = { copyStale: faults.has("r30-copy-stale") };
      for (const f of m.funcs) if (sroaFunc(f, report.sroa, sroaFaults, true)) local(f);
    });
  }
  if (o.level >= 2) {
    if (!off.has("sroa")) {
      timed("sroa", () => {
        const sroaFaults = { copyStale: faults.has("r30-copy-stale") };
        for (const f of m.funcs) if (sroaFunc(f, report.sroa, sroaFaults)) local(f);
      });
    }
    cleanupAll("cleanup after inlining");
  }
  // Phase B (D73): value numbering and loop-invariant code motion, one function at a time, after inlining has made the
  // functions they look at. A call writes nothing where its callee provably writes nothing.
  if (
    !off.has("gvn") ||
    !off.has("licm") ||
    !off.has("checks") ||
    !off.has("loopbounds") ||
    !off.has("conds") ||
    !off.has("version")
  ) {
    // R27 (D77): what each call may write: nothing outside its frame, or only separated fields' blocks too
    const { readonly, sepOnly } = writeSummaries(m);
    const gvnFaults = {
      acrossStore: faults.has("gvn-across-store"),
      ...(faults.has("r36-constkeys-shared") ? { sharedConstKeys: new ValMap<string>() } : {}),
    };
    const licmFaults = {
      ignoreStores: faults.has("licm-hoist-written"),
      pastGuard: faults.has("licm-above-guard"),
      staleLoops: faults.has("r36-licm-stale"),
    };
    const gvn = (f: Func): boolean => {
      if (off.has("gvn")) return false;
      const c = gvnFunc(f, { readonly, sepOnly, deadAtO0, stats: report.gvn, faults: gvnFaults });
      if (c) verify("gvn", f);
      return c;
    };
    const checkFaults = {
      dropBounds: faults.has("checks-drop-bounds"),
      offByOne: faults.has("checks-off-by-one"),
      satAny: faults.has("r32-sat-any"),
    };
    // Check elimination's range analysis goes round loops to a fixpoint at -O2. R35: -O1, the fast level, takes it in one
    // round, a loop header's parameters taken as anything (range.ts's oneRound), so no going round and no widening (D44;
    // -O1's compile time is gated at 1.25 times -O0's, opt-a box 6). `TMK_R35_OFF=checks` leaves -O1 without it, as before.
    const checks = (f: Func): boolean => {
      if (off.has("checks") || o.level < 1 || (o.level === 1 && r35Off("checks"))) return false;
      const c = checksFunc(f, report.checks, checkFaults, o.level === 1);
      if (c) verify("checks", f);
      return c;
    };
    // R7: -O1's cheap form of `checks` for one shape, a bounds check on the index its loop's own test bounds by the same
    // length (loopbounds.ts): no intervals and no fixpoint, so within -O1's compile-time limit. -O2's `checks` proves these.
    const loopBoundsFaults = {
      inclusive: faults.has("loopbounds-inclusive"),
      r26Const: faults.has("r26-lb-const"),
    };
    const loopBounds = (f: Func): boolean => {
      if (off.has("loopbounds") || o.level !== 1) return false;
      const c = loopBoundsFunc(f, report.loopBounds, loopBoundsFaults);
      if (c) verify("loopbounds", f);
      return c;
    };
    // R15: a test a test above it answered, at -O1 and -O2: one walk down the dominator tree (conds.ts).
    const condsFaults = {
      notDominating: faults.has("conds-not-dominating"),
      constsAny: faults.has("r28-consts-any"),
    };
    const conds = (f: Func): boolean => {
      if (off.has("conds")) return false;
      const c = condsFunc(f, report.conds, condsFaults);
      if (c) verify("conds", f);
      return c;
    };
    // R15: -O2's loop versioning (version.ts): a fast copy without the checks a guard before it proves, the loop as it was
    // the fallback.
    const versionFaults = {
      offByOne: faults.has("version-off-by-one"),
      boundInLoop: faults.has("version-bound-in-loop"),
      wrongLength: faults.has("version-wrong-length"),
    };
    // -O2: which way a loop's first turn goes, proved from the function as it is at that moment (range.ts), so a check or
    // a load past the loop's test can move out. -O1 doesn't spend the time.
    const firstTurn =
      off.has("checks") || o.level < 2
        ? undefined
        : (fn: Func, cfg: Cfg, at: number, l: Loop): number | null =>
            new Ranges(fn, cfg).firstTurn(at, l.header, l.blocks);
    const licm = (f: Func): boolean => {
      if (off.has("licm")) return false;
      if (
        !licmFunc(f, {
          readonly,
          sepOnly,
          deadAtO0,
          stats: report.licm,
          faults: licmFaults,
          ...(firstTurn !== undefined ? { firstTurn } : {}),
        })
      )
        return false;
      verify("licm", f);
      return true;
    };
    timed("gvn and licm", () => {
      for (const f of m.funcs) {
        // -O1: value numbering and LICM once each, then one cleanup. -O2: check elimination too, what moved out is shared
        // again, and loops are copied (below).
        let c = gvn(f);
        // R35: at -O1 a compare check elimination decided is a constant a branch tests, which branch folding takes away
        // with the trap behind it, as after loopbounds and conds below
        let folded = false;
        if (checks(f)) {
          c = true;
          if (o.level === 1) folded = true;
        }
        if (licm(f)) {
          c = true;
          if (o.level >= 2) gvn(f);
        }
        // -O1: after LICM has moved a loop's length load out, a check its test proves goes, and the trap it branched to
        // is unreached (branch folding removes it).
        if (loopBounds(f)) {
          c = true;
          folded = true;
        }
        if (conds(f)) {
          c = true;
          folded = true;
        }
        // -O1 removes what's left dead only (merged parameters); -O2 cleans up in full.
        if (c && o.level >= 2) local(f);
        else if (c) {
          if (folded && !off.has("cfg") && cfgFunc(f, report.cfg)) verify("cfg", f);
          if (!off.has("dce") && dceFunc(f, report.dce, dceFaults)) verify("dce", f);
        }
        // -O2: a loop that branches on what it doesn't change becomes one loop for each way, and what each way's copy
        // doesn't change moves out of it in turn.
        // -O2 (R15): a loop with checks a guard before it can prove gets a fast copy without them, the loop as it was the
        // fallback; then what the copy no longer checks is shared and moved as anywhere else.
        const versioned = new Set<number>();
        if (o.level >= 2 && !off.has("version")) {
          const before = process.env.TMK_OPT_DEBUG === "1" ? printFunc(f) : "";
          const copied = versionFunc(
            f,
            { deadAtO0, stats: report.version, limits: VERSION_O2, faults: versionFaults },
            new Set(),
            versioned,
          );
          if (copied) {
            try {
              verify("version", f);
            } catch (e) {
              if (before !== "") console.error(`${before}\n--- became ---\n${printFunc(f)}`);
              throw e;
            }
            local(f);
            gvn(f);
            if (licm(f)) gvn(f);
            if (checks(f)) gvn(f);
            conds(f);
            local(f);
          }
        }
        if (o.level >= 2 && (!off.has("unswitch") || !off.has("peel"))) {
          // R26: rounds, with the function's limit and peeled loops shared between them. A peeled first turn's loads are
          // the loop's own only once value numbering has run, so a test on one (a string's buffer's null test) becomes an
          // invariant branch to unswitch in the next round, and each copy's own loads a reason to peel it.
          const round: CopyRound = { grown: 0, peeled: new Set<number>() };
          for (let k = 0; k < (r26Off("rounds") ? 1 : COPY_ROUNDS); k++) {
            const before = process.env.TMK_OPT_DEBUG === "1" ? printFunc(f) : "";
            const copied = unswitchFunc(f, {
              deadAtO0,
              readonly,
              sepOnly,
              stats: report.unswitch,
              limits: UNSWITCH_O2,
              unswitch: !off.has("unswitch"),
              peel: !off.has("peel"),
              round,
              swapLater: k > 0 && faults.has("r26-round-swap"),
            });
            if (!copied) break;
            // later rounds take only the loops a round peeled, and the copies unswitching them makes
            round.later = new Set(round.peeled);
            try {
              verify("unswitch", f);
            } catch (e) {
              if (before !== "") console.error(`${before}\n--- became ---\n${printFunc(f)}`);
              throw e;
            }
            local(f);
            gvn(f);
            if (licm(f)) gvn(f);
            if (checks(f)) gvn(f);
            local(f);
          }
          // R28: the loops the rounds made (an unswitched copy, a peeled loop's rest), each a loop of its own whose checks a
          // guard before it may now prove, versioned as the first pass versions (a view's scan, its start and its buffer's
          // length from outside the loop once unswitching has taken the view's way); a loop the first pass versioned, its
          // fast copy or its fallback, isn't looked at again.
          if (o.level >= 2 && !off.has("version") && !r28Off("version")) {
            const copied = versionFunc(
              f,
              {
                deadAtO0,
                stats: report.version,
                limits: VERSION_O2,
                faults: faults.has("r28-version-again")
                  ? { ...versionFaults, offByOne: true }
                  : versionFaults,
              },
              new Set(versioned),
            );
            if (copied) {
              verify("version", f);
              local(f);
              gvn(f);
              if (licm(f)) gvn(f);
              if (checks(f)) gvn(f);
              conds(f);
              local(f);
            }
          }
        }
      }
    });
  }
  if (!off.has("keep") && !faults.has("keep-off")) {
    timed("keep", () => {
      report.keptLoads = keepLoads(m, deadAtO0);
    });
  }
  // Last, so what inlining and folding left unreached goes too: at -O1 and -O2, an acyclic program's collector (3.5, D41).
  if (o.prune === true && !off.has("unreached")) {
    timed("unreached", () => {
      removeUnreached(m, report.unreached, { dropRuntime: faults.has("unreached-drop-runtime") });
    });
  }
  if (o.countCalls === true) countCallsIn(m);
  const out: Module = { ...canonicalize(m), opt: o.level };
  const post = verifyModule(out);
  if (post.length > 0)
    throw new Error(`TIR verifier, after the optimiser:\n${post.slice(0, 20).join("\n")}`);
  report.callsAfter = countCalls(out);
  report.costAfter = moduleCost(out);
  report.ms = performance.now() - t0;
  return { module: out, report };
}

/** A plain load lowering noted reads a class id (`Instr.inv`) becomes `load.T.inv`. */
function markInvariantLoads(m: Module): void {
  for (const f of m.funcs)
    for (const b of f.blocks)
      for (const ins of b.instrs) {
        if (ins.inv !== true) continue;
        const p = ins.op.split(".");
        if (p[0] === "load" && p.length === 3 && p[2] === "na") ins.op = `load.${p[1]}.inv`;
      }
}

/** R26: how many times -O2 copies loops in one function, value numbering between (unswitch.ts's `CopyRound`). */
const COPY_ROUNDS = 3;

/** How big a loop -O2 copies, and how much copies may add to one function (D73, measured in M5's phase B record). */
const UNSWITCH_O2 = { loopCost: 160, peelCost: 64, funcGrowth: 640 };

/** How big a loop -O2 versions, how much the copies may add to a function, and how many guards one loop's test may hold (R15). */
const VERSION_O2 = { loopCost: 160, funcGrowth: 640, guards: 8 };

export const CALL_COUNTER = "__rc_s_calls";

/** Before each call in the module, one added to a counter: `rc`'s harness prints every `__rc_s_` counter after each case. */
function countCallsIn(m: Module): void {
  for (const f of m.funcs) {
    for (const b of f.blocks) {
      const out: Instr[] = [];
      for (const ins of b.instrs) {
        if (ins.op === "call" || ins.op === "call.indirect") {
          const g = f.types.push("ptr") - 1;
          const v = f.types.push("i64") - 1;
          const one = f.types.push("i64") - 1;
          const n = f.types.push("i64") - 1;
          out.push(
            { op: "globaladdr", ops: [{ t: "sym", name: CALL_COUNTER }], res: [g] },
            { op: "load.i64.na", ops: [{ t: "v", id: g }], res: [v] },
            { op: "iconst.i64", ops: [{ t: "i", val: 1n }], res: [one] },
            {
              op: "add.i64",
              ops: [
                { t: "v", id: v },
                { t: "v", id: one },
              ],
              res: [n],
            },
            {
              op: "store.i64.na",
              ops: [
                { t: "v", id: g },
                { t: "v", id: n },
              ],
              res: [],
            },
          );
        }
        out.push(ins);
      }
      b.instrs = out;
    }
  }
  if (!m.globals.some((g) => g.name === CALL_COUNTER))
    m.globals.push({ name: CALL_COUNTER, size: 8, align: 8, section: "data" });
}

/** What `--report` prints: what was inlined where, and why not. */
export function remarksText(r: OptReport): string[] {
  const lines: string[] = [];
  const s = r.inline;
  lines.push(
    `optimiser -O${r.level}: ${s.inlined} calls inlined, ${s.partial} partly (a fast path), ${s.devirtualized} made direct, ${s.refused} left; calls in the module ${r.callsBefore} to ${r.callsAfter}; ${r.keptLoads} loads kept`,
  );
  // Grouped, so a callee called from 40 places is one line per caller and decision.
  const groups = new Map<string, { r: Remark; n: number }>();
  for (const x of r.remarks) {
    const k = `${x.how}\0${x.callee}\0${x.caller}\0${x.why}`;
    const g = groups.get(k);
    if (g !== undefined) g.n++;
    else groups.set(k, { r: x, n: 1 });
  }
  const order = ["inlined", "partial", "devirtualized", "not inlined"];
  const all = [...groups.values()].sort(
    (a, b) =>
      order.indexOf(a.r.how) - order.indexOf(b.r.how) ||
      (a.r.callee < b.r.callee ? -1 : a.r.callee > b.r.callee ? 1 : 0) ||
      (a.r.caller < b.r.caller ? -1 : a.r.caller > b.r.caller ? 1 : 0),
  );
  for (const { r: x, n } of all) {
    const times = n > 1 ? ` (${n} sites)` : "";
    const ct =
      x.cost !== undefined
        ? ` [cost ${x.cost}${x.threshold !== undefined ? `, threshold ${x.threshold}` : ""}]`
        : "";
    lines.push(`  ${x.how} @${x.callee} into @${x.caller}${times}: ${x.why}${ct}`);
  }
  return lines;
}
