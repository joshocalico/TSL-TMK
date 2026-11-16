// One program through both routes of the dual-route differential (SPEC 4.5, 8.3, D62), what tools/pipe-tests.ts compares:
// the direct route's build and the TSL route's, each a function of the file, its mode, level and options and the injected
// printer bug. Here so a compile worker can make them (tools/compile-worker.ts, T2), off the test process's one thread, with
// the same environment the test process has (JOB_ENV), and with each route's image built beside it.
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { LowerCase } from "./lower-exec.ts";
// Not the memoised one in lowering.ts: each build is made once here, and six held at a time is memory for nothing. Through the
// run's build store, which holds none in memory (tools/store.ts).
import { storedLowerFile as lowerFile } from "./lowering.ts";
import { buildDownImage, type DownImage } from "./native-exec.ts";
import type { PipeMode, PipeProgram } from "./pipe-tests.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export interface Built {
  p: PipeProgram;
  direct: { tir: import("../compiler/tir/ir.ts").Module; meta: unknown };
  tsl: { tir: import("../compiler/tir/ir.ts").Module; meta: unknown };
  cases: LowerCase[];
  printed: string | null; // the printed package's root module, which the third route runs on V8 and JSC
}

/** A route's image, built where it was compiled: what running it and reading its results need. */
export interface RouteImage {
  meta: unknown;
  image: Pick<DownImage["image"], "bytes" | "bulk">;
  placements: DownImage["placements"];
}

/** Both routes of a program as a compile worker gives them back: images, not TIR. */
export interface BuiltImages {
  p: PipeProgram;
  direct: RouteImage;
  tsl: RouteImage;
  cases: LowerCase[];
  printed: string | null;
}

function withEnv<X>(vars: Record<string, string | undefined>, f: () => X): X {
  const was: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    was[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return f();
  } finally {
    for (const k of Object.keys(was)) {
      if (was[k] === undefined) delete process.env[k];
      else process.env[k] = was[k];
    }
  }
}

/** Both routes of one program at one level: what each made, or why the TSL route didn't take it. */
export function bothRoutes(
  file: string,
  mode: PipeMode,
  level: 0 | 2,
  fault?: string,
  classes = false,
  auto = false,
): { p: PipeProgram; built: Built | null } {
  const p: PipeProgram = { file: relative(ROOT, file), mode, level, handled: false };
  const t0 = performance.now();
  const a = lowerFile(file, { memory: mode, opt: level, route: "direct" });
  const t1 = performance.now();
  if (a.diags.length > 0 || a.tir === null)
    return { p: { ...p, why: "doesn't compile" }, built: null };
  if (a.fallbackDiags.length > 0 || a.tir.externs.length > 0)
    return { p: { ...p, why: "the direct route has a fallback" }, built: null };
  let b: ReturnType<typeof lowerFile>;
  try {
    // `rc` takes the TSL route only with classes (R2): printed in a lowered rc package that tslc's expansion counts.
    // R14: `auto`'s own build, where it takes the TSL route reshaped (as it trusts), compared as it's built
    b = withEnv({ TMK_TEST_EMIT: fault }, () =>
      lowerFile(
        file,
        auto
          ? { memory: mode, opt: level, route: "auto" }
          : { memory: mode, opt: level, route: "tsl", classes: classes || mode === "rc" },
      ),
    );
    if (auto && (b.tsl === undefined || b.tsl.file === "" || b.tir === null))
      return { p: { ...p, why: `auto took the direct route: ${b.tslSkipped ?? ""}` }, built: null };
    // and only what it took reshaped: what it prints exactly the differential's other boxes have
    if (auto && b.tsl!.stats.restructured === 0)
      return { p: { ...p, why: "auto printed it exactly" }, built: null };
  } catch (e) {
    const name = e instanceof Error ? e.constructor.name : "";
    const msg = e instanceof Error ? e.message : String(e);
    if (name === "EmitUnsupported")
      return { p: { ...p, why: `not printable yet: ${msg}` }, built: null };
    return { p: { ...p, why: `FAILED: ${msg.slice(0, 600)}` }, built: null };
  }
  const t2 = performance.now();
  p.handled = true;
  p.sameTir = a.tirHash === b.tirHash;
  p.ms = { direct: t1 - t0, tsl: t2 - t1 };
  p.tslLines = b.tsl?.stats.lines;
  p.intrinsics = b.tsl?.stats.intrinsics;
  p.memoryOps = b.tsl?.stats.memoryOps;
  p.restructured = b.tsl?.stats.restructured;
  const casesFile = file.replace(/\.ts$/, ".cases.json");
  const cases = existsSync(casesFile)
    ? (JSON.parse(readFileSync(casesFile, "utf8")) as LowerCase[])
    : [];
  return {
    p,
    built: {
      p,
      direct: { tir: a.tir, meta: a.meta },
      tsl: { tir: b.tir!, meta: b.meta },
      cases,
      printed: b.tsl?.file ?? null,
    },
  };
}

export function pinsOf(file: string): { pages?: number; stack?: number } {
  const src = readFileSync(file, "utf8");
  const pages = /^\/\/ memory-pages: (\d+)$/m.exec(src)?.[1];
  const stack = /^\/\/ rc-stack: (\d+)$/m.exec(src)?.[1];
  return {
    ...(pages !== undefined ? { pages: Number(pages) } : {}),
    ...(stack !== undefined ? { stack: Number(stack) } : {}),
  };
}

/** A route's image, as tools/pipe-tests.ts's runRoute built it: the program's own pages and stack, and the run's channel. */
export function routeImage(
  file: string,
  r: Built["direct"],
  cases: LowerCase[],
  bulkBytes: number,
): RouteImage {
  const { pages, stack } = pinsOf(file);
  const built = buildDownImage(
    r.tir,
    r.meta as never,
    cases,
    pages,
    { bulkBytes },
    undefined,
    stack,
  );
  return {
    meta: r.meta,
    image: {
      bytes: built.image.bytes,
      ...(built.image.bulk !== undefined ? { bulk: built.image.bulk } : {}),
    },
    placements: built.placements,
  };
}

/** Both routes and both images: what a compile worker does for one item of dualRoute. */
export function bothRoutesBuilt(
  file: string,
  mode: PipeMode,
  level: 0 | 2,
  fault: string | undefined,
  classes: boolean,
  bulkBytes: number,
  auto = false,
): { p: PipeProgram; built: BuiltImages | null } {
  const { p, built } = bothRoutes(file, mode, level, fault, classes, auto);
  if (built === null || built.cases.length === 0) return { p, built: null };
  return {
    p,
    built: {
      p: built.p,
      direct: routeImage(file, built.direct, built.cases, bulkBytes),
      tsl: routeImage(file, built.tsl, built.cases, bulkBytes),
      cases: built.cases,
      printed: built.printed,
    },
  };
}
