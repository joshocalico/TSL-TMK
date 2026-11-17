// R2 (SPEC 3.5, 4.5, D72, D74): lowered `rc` programs through the TSL route. What `tmk milestone pipe-d` boxes 24 and 25
// ask beyond the dual-route differential itself: the bugs put into each new transform, and which programs catch each.
import { join } from "node:path";
import { ROOT, wrongAnswers, type Engines } from "./corpus.ts";
import { faultFailures, patchEnv } from "./faults.ts";
import type { Accel } from "./qemu-run.ts";

/**
 * Where a bug is put: the printer (TMK_TEST_EMIT), tslc's expansion (TMK_TEST_RC_TSL), @tsl/jsrt's or @tsl/gc's source (a
 * patch), or the lowering itself (TMK_TEST_DOWN, R3), which both routes share.
 */
export type R2Where = "printer" | "expansion" | "library" | "lowering" | "backend";

export interface R2Fault {
  name: string;
  what: string; // the bug, in words
  transform: string; // what it's put into
  where: R2Where;
  patch?: { file: string; from: string; to: string };
  dirs: string[]; // the lowered programs whose dual route is to catch it, through the TSL route in `rc`
  modes?: ("strict" | "leak" | "manual" | "rc")[]; // the modes its dual route runs in (R3): `rc` unless said
  handWritten?: string; // a corpus/rc program (TSL proper in an `rc` package) that catches it instead
  classes?: boolean; // R4: class printing forced, as `leak` and `manual` need for a map to print as JsMap
  only?: string; // R4: only the programs of `dirs` whose path has this in it
}

const R2_DIRS = [
  "corpus/lower/rc",
  "corpus/lower/rc-tsl",
  "corpus/lower/memory",
  "corpus/lower/pipe",
];

/**
 * R2's programs of arrays and maps churned past a small memory, each meaningful in `rc` alone (`leak` never frees, and the
 * routes place a `leak` array differently): the `rc` differential runs them beside the pipe corpora.
 */
export const RC_TSL_DIR = "corpus/lower/rc-tsl";

export const R2_FAULTS: R2Fault[] = [
  {
    name: "hoist-late",
    what: "a statement an expression needs printed after what's ahead of it, so an earlier operand reads a later value",
    transform:
      "the printer's statement form in rc (a reference made, held or stored is a statement of its own)",
    where: "printer",
    dirs: R2_DIRS,
  },
  {
    name: "rc-alias-any",
    what: "a temporary printed as the variable it copied although the variable is assigned before the temporary's use",
    transform: "the printer's aliasing of copies in rc (`const b = a` printed as a)",
    where: "printer",
    dirs: ["corpus/lower/pipe"],
  },
  {
    name: "rc-stable-any",
    what: "an operand's variable read after a later operand that assigns it, where a temporary was needed",
    transform: "the printer's operands read in place in rc",
    where: "printer",
    dirs: ["corpus/lower/pipe"],
  },
  {
    name: "js-set-keeps",
    what: "an array element overwritten without the old one dropped",
    transform: "the expansion's JsArray rules (set)",
    where: "expansion",
    dirs: ["corpus/lower/rc-tsl"],
  },
  {
    name: "js-cut-keeps",
    what: "a shorter length that cuts live elements off without dropping them",
    transform:
      "the expansion's JsArray rules (setLength), which printed code never reaches with live elements",
    where: "expansion",
    dirs: [],
    handWritten: "rc_jsarray",
  },
  {
    name: "js-free-keeps",
    what: "freeing an array that never gives its buffer back",
    transform: "the expansion's freeing of a JsArray holder (elements by index, then the buffer)",
    where: "expansion",
    dirs: ["corpus/lower/rc-tsl"],
  },
  {
    name: "nonnull-owned",
    what: "@tsl/lowered's nonNull(x) taken for a call's owned result, so what it reads is dropped by the reader too",
    transform: "the expansion's pass-through of nonNull and cast in a lowered package",
    where: "expansion",
    dirs: ["corpus/lower/rc", "corpus/lower/rc-tsl"],
  },
  {
    name: "map-key-kept",
    what: "a key `set` was given for a key already there, its extra count never dropped",
    transform: "the expansion's map rules (set through put)",
    where: "expansion",
    dirs: ["corpus/lower/rc-tsl"],
  },
  {
    name: "map-val-kept",
    what: "a value `set` replaced, never dropped",
    transform: "the expansion's map rules (set through put and outVal)",
    where: "expansion",
    dirs: ["corpus/lower/rc-tsl"],
  },
  {
    name: "map-cut-kept",
    what: "a deleted entry's key and value never dropped",
    transform: "the expansion's map rules (delete through cut)",
    where: "expansion",
    dirs: ["corpus/lower/rc-tsl"],
  },
  {
    name: "map-clear-kept",
    what: "a cleared map's entries never dropped",
    transform: "the expansion's map rules (clear, every entry taken out first)",
    where: "expansion",
    dirs: ["corpus/lower/rc-tsl"],
  },
  {
    name: "put-always-inserts",
    what: "JsMap's put saying it inserted when the key was there, so the old value isn't handed back",
    transform: "JsMap's slot clearing (put)",
    where: "library",
    patch: {
      file: "ex-jsrt-map.ts",
      from: "        this.vals.set(i, v);\n      }\n      return false;",
      to: "        this.vals.set(i, v);\n      }\n      return true;",
    },
    dirs: ["corpus/lower/rc-tsl"],
  },
  {
    name: "positions-new-only",
    what: "JsMap's positions leaving out the old table during a move, so freeing a map mid-move misses what's in it",
    transform: "JsMap's freeing a position a step (positions and entryAt)",
    where: "library",
    patch: {
      file: "ex-jsrt-map.ts",
      from: "    return this.moving ? n + toUsize(this.end - this.mv) : n;",
      to: "    return n;",
    },
    dirs: ["corpus/lower/rc-tsl"],
  },
  {
    name: "trim-keeps",
    // R3: a lowered `rc` array is @tsl/gc's JsRoomArray now, so the same bug is put in its trim
    what: "a lowered rc array's trim not giving its room back",
    transform: "JsRoomArray's trim, the last step of freeing an array",
    where: "library",
    patch: {
      file: "ex-gc-roomarray.ts",
      from: "    this.room = null;\n    roomDrop(r);\n    return true;",
      to: "    this.room = null;\n    return true;",
    },
    dirs: ["corpus/lower/rc-tsl"],
  },
];

function withEnv<X>(vars: Record<string, string | undefined>, f: () => Promise<X>): Promise<X> {
  const was: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    was[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  return f().finally(() => {
    for (const k of Object.keys(was)) {
      if (was[k] === undefined) delete process.env[k];
      else process.env[k] = was[k];
    }
  });
}

/** One bug put in, and how many cases caught it: through both routes in `rc` at -O2, or by hand in corpus/rc. */
export async function r2FaultRun(
  f: R2Fault,
  accel: Accel,
  jobs: number,
  engines: Engines,
): Promise<{ caught: number; answers: number; first: string; broken: boolean }> {
  const env: Record<string, string | undefined> = { TMK_OPT: "2" };
  if (f.where === "expansion") env.TMK_TEST_RC_TSL = f.name;
  // checked against the source first (SPEC 8.3): a patch that doesn't apply throws, failing the box, never caught
  if (f.where === "library") env.TSL_TEST_PATCH = patchEnv(f.patch!);
  if (f.where === "lowering") env.TMK_TEST_DOWN = f.name;
  if (f.where === "backend") env.TMK_TEST_TSL = f.name; // R4: tslc's own, which every TSL program goes through
  return withEnv(env, async () => {
    const failures: string[] = [];
    if (f.dirs.length > 0) {
      const P = await import("./pipe-tests.ts");
      const r = await P.dualRoute({
        modes: f.modes ?? ["rc"],
        levels: [2],
        accels: [accel],
        jobs,
        dirs: f.dirs,
        printed: false,
        ...(f.classes === true ? { classes: true } : {}),
        ...(f.only !== undefined ? { filter: (x: string) => x.includes(f.only!) } : {}),
        ...(f.where === "printer" ? { fault: f.name } : {}),
        // a bug in the lowering is in both routes alike: what shows it is the direct route against V8
        ...(f.where === "lowering" ? { v8: () => true } : {}),
      });
      failures.push(...r.failures);
    }
    if (f.handWritten !== undefined) {
      const { runNative } = await import("./corpus.ts");
      const r = await runNative("rc", [accel], jobs, f.handWritten, engines);
      failures.push(...r.failures);
    }
    faultFailures(failures, f.name);
    return {
      caught: failures.length,
      // R7: the failures that are wrong answers, not cases out of time, whose number depends on the host's load
      answers: wrongAnswers(failures),
      first: (failures[0] ?? "").slice(0, 200),
      // a bug that only stopped things compiling shows nothing running
      broken:
        failures.length > 0 &&
        failures.every((x) => /FAILED: tslc rejected|"code":"(TS|TSL)\d+"/.test(x)),
    };
  });
}

/** The programs R2 added, each built through both routes: they're what catches the leaks. */
export const R2_PROGRAMS = [
  join(ROOT, "corpus/lower/rc-tsl/r2_arrays.ts"),
  join(ROOT, "corpus/lower/rc-tsl/r2_maps.ts"),
  join(ROOT, "corpus/lower/pipe/rc_order.ts"),
  join(ROOT, "corpus/rc/rc_jsarray.ts"),
];
