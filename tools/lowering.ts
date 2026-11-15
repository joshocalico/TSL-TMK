// The compiler as the test process calls it: the same functions, timed as a phase of whichever suite asked (SPEC D45).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as tslc from "../compiler/host/tslc.ts";
import { envLevelReadCount, optFromEnv } from "../compiler/tir/passes/manager.ts";
import { withCompileReuse } from "../compiler/host/program.ts";
import {
  canonical,
  fileKey,
  keyedEnv,
  noteCheck,
  reuseSampled,
  StoreMismatch,
  storeKey,
  stored,
  valueHash,
} from "./store.ts";
import { timedSync } from "./timing.ts";

/**
 * A compile, and for one in 16 by its key and the run (TMK_COMPILE_REUSE=verify: every one), the same compile again with
 * tslc's reuse across compiles off (compiler/host/program.ts, T2), compared by value: what it gives can't depend on what
 * the process compiled before. A difference fails the asking suite and the run, as a store mismatch does.
 */
export function reuseChecked<T>(
  what: string,
  make: () => T,
  fingerprint: (v: T) => string = (v) => valueHash(v, new Set(["ms"])),
): T {
  if (!reuseSampled(what)) return make();
  const warm = make();
  const t = performance.now();
  const cold = withCompileReuse(false, make);
  const ok = fingerprint(warm) === fingerprint(cold);
  noteCheck("reuse", ok, what, performance.now() - t);
  if (!ok)
    throw new StoreMismatch(
      `tslc's reuse across compiles changed what ${what} gives: compiled again with it off, the output differs`,
    );
  return warm;
}

/**
 * tslc's lowerFile through the run's build store (tools/store.ts): the same file, bytes, options and environment, made once
 * in a run and checked by a sixteenth made again. Exactly tslc.lowerFile without a store (TMK_STORE unset or off).
 */
export function storedLowerFile(file: string, opts: tslc.LowerOptions = {}): tslc.LowerOutput {
  if (!existsSync(file)) return tslc.lowerFile(file, opts); // it says so, as it always did
  const key = storeKey("lower", [...fileKey(file), canonical(opts)]);
  return stored(
    "lower",
    key,
    () => reuseChecked(`lower ${file} ${canonical(opts)} ${key}`, () => tslc.lowerFile(file, opts)),
    {
      envLevel: envLevelReadCount,
      // Making it noted the level it took from the environment in the job's trace: so does using it.
      onEnvLevel: () => void optFromEnv(undefined),
      describe: `${file} ${canonical(opts)}`,
      usable: (o) => o.tsl === undefined || existsSync(o.tsl.file),
      // How long the passes and the printing took: the only things in it that aren't what was made.
      timings: new Set(["ms"]),
    },
  );
}

export * from "../compiler/host/tslc.ts";

/** `tmk test --catch-rate`: a bug the compiler can be built with, in every rc build this run asks for. */
export function withInjectedFault(
  opts: tslc.LowerOptions | undefined,
): tslc.LowerOptions | undefined {
  const text = process.env.TMK_TEST_RC;
  if (text === undefined || opts?.memory !== "rc") return opts;
  return { ...opts, rc: { ...opts.rc, ...(JSON.parse(text) as Record<string, unknown>) } };
}

/**
 * One process lowering the same bytes with the same options gets one answer, and nothing downstream writes to it: tests already
 * share one across jobs (`iterationExhaustive`). The key is the root file's text, every option and the injected bug, and a
 * program's imports don't change during a run. Bounded, so it can't become what it replaces.
 */
const memo = new Map<string, tslc.LowerOutput>();
const MEMO_ENTRIES = 6;
const MEMO_MAX_TEXT = 3 * 1024 * 1024; // all the entries' TIR text together, about a fortieth of their heap

export function lowerFile(...a: Parameters<typeof tslc.lowerFile>): tslc.LowerOutput {
  return timedSync("compile", () => {
    const [file, given] = a;
    const opts = withInjectedFault(given);
    a[1] = opts;
    if (!existsSync(file)) return tslc.lowerFile(...a); // it says so, as it always did
    const key = createHash("sha256")
      .update(readFileSync(file))
      .update(`\0${file}\0${JSON.stringify(opts ?? {})}\0${process.env.TSL_TEST_PATCH ?? ""}`)
      // The optimiser's level and switches key a build as much as its options do (SPEC 6.3, D44), and so does every other
      // TMK_* and TSL_* variable the compiler reads (T2: the printer's TMK_R*_OFF and TMK_EMIT_* weren't all listed here).
      .update(`\0${keyedEnv()}`)
      .digest("hex");
    const hit = memo.get(key);
    if (hit !== undefined) {
      memo.delete(key);
      memo.set(key, hit);
      return hit;
    }
    const o = storedLowerFile(file, opts);
    // Bounded by size as well as count: a lowering of the exceptions corpus is around 50 MB of heap, and four workers each
    // keeping six put a milestone over its RSS watchdog. A very large one isn't kept at all.
    if (o.tirText.length > MEMO_MAX_TEXT) return o;
    memo.set(key, o);
    let text = 0;
    for (const v of memo.values()) text += v.tirText.length;
    while (memo.size > MEMO_ENTRIES || (memo.size > 1 && text > MEMO_MAX_TEXT)) {
      const oldest = memo.keys().next().value!;
      text -= memo.get(oldest)!.tirText.length;
      memo.delete(oldest);
    }
    return o;
  });
}

export function checkFile(...a: Parameters<typeof tslc.checkFile>): tslc.CheckResult {
  return timedSync("compile", () => tslc.checkFile(...a));
}
