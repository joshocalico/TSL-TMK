// The fault rule (SPEC 8.3, R18): an injected bug that isn't in the build is a harness failure of its box, never "caught".
//
// Every runner that puts a bug in by patch (TSL_TEST_PATCH) takes its environment from `patchEnv`, which checks the patch
// against the source first, and passes what failed through `faultFailures`, which throws on a failure that says a patch
// didn't apply (compiler/host/test-patch.ts throws that in the build itself). Both throw FaultHarnessError, which fails the
// box with that said. Before R18, a box that counted every failure as caught passed a bug whose text had gone from the
// source: pipe-d box 21's from R4 to R16, JsMap's `no-norm` since R6, JsArray's `grow-last` since R16.
//
// `registeredFaults` lists every injected bug the tools know, for tools/faults.test.ts: each patch's text is in its file
// exactly as many times as it says, and each bug put in by name has its name in the compiler's source, so a source edit that
// orphans a bug fails `tmk test --changed` in seconds, not a box an hour into a gate.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  occurrences,
  PATCH_HARNESS,
  patchProblem,
  type TestPatch,
} from "../compiler/host/test-patch.ts";
import { ROOT } from "./corpus.ts";

export type { TestPatch };

/** A box's harness failing: the bug it was to show caught isn't in the build. */
export class FaultHarnessError extends Error {
  constructor(message: string) {
    super(`HARNESS FAILURE (SPEC 8.3's fault rule): ${message}`);
    this.name = "FaultHarnessError";
  }
}

/** Where patched sources live: a patch names one of these files, or the end of one's path. */
const SOURCE_DIRS = ["packages", "compiler"];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".ts")) out.push(relative(ROOT, p));
    }
  };
  for (const d of SOURCE_DIRS) if (existsSync(join(ROOT, d))) walk(join(ROOT, d));
  return out;
}

let sources: string[] | null = null;

/** The one source file a patch names (repo-relative), or why there isn't one. */
export function patchFile(p: TestPatch): { file: string } | { problem: string } {
  if (existsSync(join(ROOT, p.file)) && statSync(join(ROOT, p.file)).isFile())
    return { file: p.file };
  sources ??= sourceFiles();
  const hits = sources.filter((f) => f === p.file || f.endsWith(`/${p.file}`));
  if (hits.length === 1) return { file: hits[0]! };
  return {
    problem: `${PATCH_HARNESS} ${p.file} names ${hits.length === 0 ? "no file" : `${hits.length} files (${hits.join(", ")})`} under ${SOURCE_DIRS.join(" or ")}`,
  };
}

/** Why a patch doesn't apply to the source as it is now, or undefined if it does. */
export function patchCheck(p: TestPatch): string | undefined {
  const f = patchFile(p);
  if ("problem" in f) return f.problem;
  return patchProblem(readFileSync(join(ROOT, f.file), "utf8"), p);
}

/** TSL_TEST_PATCH's value for these patches, each checked against the source first: a throw if any doesn't apply. */
export function patchEnv(patch: TestPatch | TestPatch[]): string {
  const list = [patch].flat();
  if (list.length === 0) throw new FaultHarnessError("an injected bug with no patch");
  const problems = list.flatMap((p) => patchCheck(p) ?? []);
  if (problems.length > 0) throw new FaultHarnessError(problems.join("; "));
  return JSON.stringify(Array.isArray(patch) ? list : patch);
}

/** Whether a failure says an injected bug's patch didn't apply in the build. */
export function isHarnessFailure(failure: string): boolean {
  return failure.includes(PATCH_HARNESS);
}

/** A fault run's failures, as they are, after a throw if any says the bug wasn't in the build. */
export function faultFailures<T extends readonly string[]>(
  failures: T,
  what = "an injected bug",
): T {
  const bad = failures.filter(isHarnessFailure);
  if (bad.length > 0)
    throw new FaultHarnessError(
      `${what}: ${bad.length} build(s) without it: ${bad[0]!.slice(0, 400)}`,
    );
  return failures;
}

/** Runs `f` with TSL_TEST_PATCH set to the checked patch, and puts the environment back. */
export async function withPatch<X>(
  patch: TestPatch | TestPatch[],
  f: () => Promise<X> | X,
): Promise<X> {
  const value = patchEnv(patch);
  const was = process.env.TSL_TEST_PATCH;
  process.env.TSL_TEST_PATCH = value;
  try {
    return await f();
  } finally {
    if (was === undefined) delete process.env.TSL_TEST_PATCH;
    else process.env.TSL_TEST_PATCH = was;
  }
}

// --- every injected bug the tools know

/** One registered bug: a patch (or patches) into a source, or a name a hook in the compiler reads from the environment. */
export interface RegisteredFault {
  list: string; // where it's registered: module and constant
  name: string;
  patches: TestPatch[];
  hook?: { env: string; value: string; listedIn?: "compiler" }; // listed in the compiler: named there twice, list and hook
}

interface Anyf {
  name: string;
}

/** Every injected bug of every runner's list. A list a runner reads belongs here. */
export async function registeredFaults(): Promise<RegisteredFault[]> {
  const out: RegisteredFault[] = [];
  const patchOf = (list: string, f: Anyf, p: TestPatch | TestPatch[]): void => {
    out.push({ list, name: f.name, patches: [p].flat() });
  };
  const hookOf = (list: string, f: Anyf, env: string, value: string): void => {
    out.push({ list, name: f.name, patches: [], hook: { env, value } });
  };
  const S = await import("./std-tests.ts");
  for (const f of S.FAULTS) patchOf("std-tests FAULTS", f as unknown as Anyf, f);
  const G = await import("./gc-tests.ts");
  for (const [k, l] of [
    ["gc-tests GC_FAULTS", G.GC_FAULTS],
    ["gc-tests RC_TSL_FAULTS", G.RC_TSL_FAULTS],
    ["gc-tests RC_CC_FAULTS", G.RC_CC_FAULTS],
  ] as const)
    for (const f of l as unknown as (Anyf & {
      file: string;
      from: string;
      to: string;
      times?: number;
      env?: string;
      tslEnv?: string;
      optFault?: string;
    })[]) {
      if (f.env !== undefined) hookOf(k, f, "TMK_TEST_RC_TSL", f.env);
      else if (f.tslEnv !== undefined) hookOf(k, f, "TMK_TEST_TSL", f.tslEnv);
      else if (f.optFault !== undefined) hookOf(k, f, "TMK_OPT_FAULT", f.optFault);
      else
        patchOf(k, f, {
          file: f.file,
          from: f.from,
          to: f.to,
          ...(f.times !== undefined ? { times: f.times } : {}),
        });
    }
  const D = await import("./milestones/pipe-d.ts");
  for (const f of D.JSARRAY_FAULTS)
    patchOf("pipe-d JSARRAY_FAULTS", f, { file: D.JSARRAY_FILE, from: f.from, to: f.to });
  for (const f of D.JSSTRING_FAULTS)
    patchOf("pipe-d JSSTRING_FAULTS", f, { file: D.JSSTRING_FILE, from: f.from, to: f.to });
  for (const f of D.JSMAP_FAULTS)
    patchOf("pipe-d JSMAP_FAULTS", f, { file: D.JSMAP_FILE, from: f.from, to: f.to });
  for (const f of D.STRKEY_FAULTS)
    patchOf("pipe-d STRKEY_FAULTS", f, { file: f.file, from: f.from, to: f.to });
  // R2's form, which R3 to R10 share: by `where`
  const r2Env: Record<string, string> = {
    printer: "TMK_TEST_EMIT",
    expansion: "TMK_TEST_RC_TSL",
    lowering: "TMK_TEST_DOWN",
    backend: "TMK_TEST_TSL",
  };
  for (const [mod, key] of [
    ["r2-tests", "R2_FAULTS"],
    ["r3-tests", "R3_FAULTS"],
    ["r4-tests", "R4_FAULTS"],
    ["r5-tests", "R5_FAULTS"],
    ["r6-tests", "R6_FAULTS"],
    ["r7-tests", "R7_FAULTS"],
    ["r8-tests", "R8_FAULTS"],
    ["r9-tests", "R9_FAULTS"],
    ["r10-tests", "R10_FAULTS"],
  ] as const) {
    const M = (await import(`./${mod}.ts`)) as Record<string, unknown>;
    for (const f of M[key] as (Anyf & { where: string; patch?: TestPatch })[]) {
      if (f.where === "library") patchOf(`${mod} ${key}`, f, f.patch!);
      else if (r2Env[f.where] !== undefined) hookOf(`${mod} ${key}`, f, r2Env[f.where]!, f.name);
    }
  }
  const R11 = await import("./r11-tests.ts");
  for (const f of R11.R11_FAULTS) {
    if (f.where === "patch") patchOf("r11-tests R11_FAULTS", f, f.patch!);
    else hookOf("r11-tests R11_FAULTS", f, "TMK_TEST_EMIT", f.name);
  }
  for (const f of R11.R11_EXC_FAULTS)
    hookOf(
      "r11-tests R11_EXC_FAULTS",
      f,
      f.where === "printer" ? "TMK_TEST_EMIT" : "TMK_TEST_RC_TSL",
      f.name,
    );
  const R12 = await import("./r12-tests.ts");
  for (const f of R12.R12_FAULTS) hookOf("r12-tests R12_FAULTS", f, "TMK_TEST_TSL", f.env);
  const R13 = await import("./r13-tests.ts");
  for (const f of R13.R13_FAULTS)
    hookOf("r13-tests R13_FAULTS", f, f.printer === true ? "TMK_TEST_EMIT" : "TMK_TEST_TSL", f.env);
  const R14 = await import("./r14-tests.ts");
  for (const f of R14.R14_FAULTS) hookOf("r14-tests R14_FAULTS", f, "TMK_TEST_EMIT", f.name);
  const R15 = await import("./r15-tests.ts");
  for (const f of R15.R15_FAULTS) hookOf("r15-tests R15_FAULTS", f, "TMK_OPT_FAULT", f.name);
  const R16 = await import("./r16-tests.ts");
  for (const f of R16.R16_FAULTS) patchOf("r16-tests R16_FAULTS", f, f.patch);
  const R17 = await import("./r17-tests.ts");
  for (const f of R17.R17_FAULTS) {
    if (f.patch !== undefined) patchOf("r17-tests R17_FAULTS", f, f.patch);
    if (f.tslEnv !== undefined) hookOf("r17-tests R17_FAULTS", f, "TMK_TEST_TSL", f.tslEnv);
  }
  const R18 = await import("./r18-tests.ts");
  for (const f of R18.R18_FAULTS) {
    if (f.tslEnv !== undefined) hookOf("r18-tests R18_FAULTS", f, "TMK_TEST_TSL", f.tslEnv);
    if (f.emit !== undefined) hookOf("r18-tests R18_FAULTS", f, "TMK_TEST_EMIT", f.emit);
    if (f.expansion !== undefined)
      hookOf("r18-tests R18_FAULTS", f, "TMK_TEST_RC_TSL", f.expansion);
  }
  const R19 = await import("./r19-tests.ts");
  for (const f of R19.R19_FAULTS) {
    if (f.patch !== undefined) patchOf("r19-tests R19_FAULTS", f, f.patch);
    if (f.tslEnv !== undefined) hookOf("r19-tests R19_FAULTS", f, "TMK_TEST_TSL", f.tslEnv);
    if (f.emit !== undefined) hookOf("r19-tests R19_FAULTS", f, "TMK_TEST_EMIT", f.emit);
  }
  const R20 = await import("./r20-tests.ts");
  for (const f of R20.R20_FAULTS) {
    if (f.tslEnv !== undefined) hookOf("r20-tests R20_FAULTS", f, "TMK_TEST_TSL", f.tslEnv);
    if (f.optFault !== undefined) hookOf("r20-tests R20_FAULTS", f, "TMK_OPT_FAULT", f.optFault);
  }
  const R21 = await import("./r21-tests.ts");
  for (const f of R21.R21_FAULTS) {
    if (f.patch !== undefined) patchOf("r21-tests R21_FAULTS", f, f.patch);
    if (f.tslEnv !== undefined) hookOf("r21-tests R21_FAULTS", f, "TMK_TEST_TSL", f.tslEnv);
    if (f.emit !== undefined) hookOf("r21-tests R21_FAULTS", f, "TMK_TEST_EMIT", f.emit);
    if (f.optFault !== undefined) hookOf("r21-tests R21_FAULTS", f, "TMK_OPT_FAULT", f.optFault);
  }
  const R22 = await import("./r22-tests.ts");
  for (const f of R22.R22_FAULTS) {
    if (f.patch !== undefined) patchOf("r22-tests R22_FAULTS", f, f.patch);
    if (f.emit !== undefined) hookOf("r22-tests R22_FAULTS", f, "TMK_TEST_EMIT", f.emit);
  }
  const R23 = await import("./r23-tests.ts");
  for (const f of R23.R23_FAULTS) {
    if (f.emit !== undefined) hookOf("r23-tests R23_FAULTS", f, "TMK_TEST_EMIT", f.emit);
    if (f.optFault !== undefined) hookOf("r23-tests R23_FAULTS", f, "TMK_OPT_FAULT", f.optFault);
  }
  const R24 = await import("./r24-tests.ts");
  for (const f of R24.R24_FAULTS) {
    if (f.patch !== undefined) patchOf("r24-tests R24_FAULTS", f, f.patch);
    if (f.emit !== undefined) hookOf("r24-tests R24_FAULTS", f, "TMK_TEST_EMIT", f.emit);
  }
  const R25 = await import("./r25-tests.ts");
  for (const f of R25.R25_FAULTS) {
    if (f.patch !== undefined) patchOf("r25-tests R25_FAULTS", f, f.patch);
    if (f.emit !== undefined) hookOf("r25-tests R25_FAULTS", f, "TMK_TEST_EMIT", f.emit);
    if (f.tslEnv !== undefined) hookOf("r25-tests R25_FAULTS", f, "TMK_TEST_TSL", f.tslEnv);
    if (f.optFault !== undefined) hookOf("r25-tests R25_FAULTS", f, "TMK_OPT_FAULT", f.optFault);
  }
  const R26 = await import("./r26-tests.ts");
  for (const f of R26.R26_FAULTS) {
    if (f.patch !== undefined) patchOf("r26-tests R26_FAULTS", f, f.patch);
    if (f.emit !== undefined) hookOf("r26-tests R26_FAULTS", f, "TMK_TEST_EMIT", f.emit);
    if (f.optFault !== undefined) hookOf("r26-tests R26_FAULTS", f, "TMK_OPT_FAULT", f.optFault);
  }
  const R27 = await import("./r27-tests.ts");
  for (const f of R27.R27_FAULTS) {
    if (f.tslEnv !== undefined) hookOf("r27-tests R27_FAULTS", f, "TMK_TEST_TSL", f.tslEnv);
    if (f.optFault !== undefined) hookOf("r27-tests R27_FAULTS", f, "TMK_OPT_FAULT", f.optFault);
  }
  const P = await import("./pipe-tests.ts");
  for (const f of [...P.EMIT_FAULTS, ...P.CLASS_FAULTS])
    hookOf("pipe-tests EMIT_FAULTS, CLASS_FAULTS", f, "TMK_TEST_EMIT", f.name);
  const RC = await import("./rc-tests.ts");
  for (const f of RC.CC_FAULTS)
    for (const v of Object.values(f.rc))
      if (typeof v === "string") hookOf("rc-tests CC_FAULTS", f, "TMK_TEST_RC", v);
  // `tmk test --catch-rate`'s own: the runtime's bugs, by name in TMK_TEST_RC (its @tsl/std ones are std-tests' above)
  const Q = await import("./quick.ts");
  for (const f of await Q.injectedFaults()) {
    const rc = f.env.TMK_TEST_RC;
    if (rc === undefined) continue;
    for (const v of Object.values(JSON.parse(rc) as Record<string, unknown>))
      if (typeof v === "string") hookOf("quick.ts injectedFaults", f, "TMK_TEST_RC", v);
  }
  // the lists the compiler keeps itself
  const O = await import("../compiler/tir/passes/manager.ts");
  for (const name of O.OPT_FAULTS)
    out.push({
      list: "manager.ts OPT_FAULTS",
      name,
      patches: [],
      hook: { env: "TMK_OPT_FAULT", value: name, listedIn: "compiler" },
    });
  const X = await import("../compiler/host/emit-exc.ts");
  for (const f of X.EXC_FAULTS)
    out.push({
      list: "emit-exc.ts EXC_FAULTS",
      name: f.name,
      patches: [],
      hook: { env: "TMK_TEST_EMIT", value: f.name, listedIn: "compiler" },
    });
  return out;
}

/** The compiler's own source, where a hook reads a bug's name: compiler/ and packages/, but not tools/. */
export function hookSources(): string {
  sources ??= sourceFiles();
  return sources
    .filter((f) => !f.endsWith(".test.ts"))
    .map((f) => readFileSync(join(ROOT, f), "utf8"))
    .join("\n");
}

/** Why a registered bug can't be in a build as its list says, or undefined. */
export function registeredProblem(f: RegisteredFault, hooks: string): string | undefined {
  for (const p of f.patches) {
    const why = patchCheck(p);
    if (why !== undefined) return why;
  }
  if (f.hook !== undefined) {
    const v = f.hook.value;
    const named = [`"${v}"`, `'${v}'`, `\`${v}\``].reduce((n, q) => n + occurrences(hooks, q), 0);
    if (named < (f.hook.listedIn === "compiler" ? 2 : 1))
      return `${f.hook.env}=${v}: no hook in compiler/ or packages/ names it`;
  }
  if (f.patches.length === 0 && f.hook === undefined) return "neither a patch nor a hook";
  return undefined;
}
