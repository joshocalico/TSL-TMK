// R14's speed check for each program a trusted reshape touches (SPEC M5's R14 record, D62, pile item 9): at -O1 and -O2,
// the direct route's build against `auto`'s (the TSL route, reshaped only as it trusts). Where the two TIRs are the same,
// the machine code is, and nothing is timed. Otherwise each route's image runs the program's own cases many passes over,
// each case's run timed by the counter (Driver.main's timing passes), the two routes' runs interleaved, and the ratio is
// the median pass of the TSL route's over the direct route's. Numbers only: no gate.
//
//   node tools/r14-time.ts --mode leak|manual|rc|strict [--files a.ts,b.ts] [--from rows.json] [--runs 5] [--passes 40]
//                          [--levels 1,2] [--json out.json] [--accel hvf|tcg]
//
// With --accel tcg and TMK_ICOUNT=1 (qemu-run.ts) each time is an instruction count, the same run to run.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join, relative } from "node:path";
import { listPrograms, ROOT } from "./corpus.ts";
import { pinsOf } from "./dual-build.ts";
import type { LowerCase } from "./lower-exec.ts";
import { bulkFor, buildDownImage } from "./native-exec.ts";
import { median } from "./bench-alloc.ts";
import { qemuRun, type Accel } from "./qemu-run.ts";
import { PIPE_DIRS } from "./pipe-tests.ts";

export interface TimeRow {
  file: string;
  mode: string;
  level: 1 | 2;
  /** `auto` took the TSL route, and its printing was reshaped (by the kinds it trusts) */
  taken: boolean;
  reshaped: string[];
  sameTir: boolean;
  /** TSL route over direct, the median pass: null where the code is the same or nothing ran */
  ratio: number | null;
  direct?: number;
  tsl?: number;
  /** the two routes trapped a different number of times over the passes (out of memory, say): the ratio means little */
  trapsDiffer?: boolean;
  why?: string;
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

/** Each pass's ticks, from a timing image's lines, and the counter's frequency. */
function passes(lines: string[]): { freq: number; ticks: number[]; traps: number } {
  const f = lines.find((l) => l.startsWith("TMK:F "));
  return {
    freq: f !== undefined ? Number(f.slice(6)) : 0,
    ticks: lines.filter((l) => l.startsWith("TMK:TP ")).map((l) => Number(l.slice(7))),
    traps: lines.filter((l) => /^TMK:C \d+ T /.test(l)).length,
  };
}

export async function timeProgram(
  file: string,
  mode: string,
  level: 1 | 2,
  o: { runs: number; passes: number; accel: Accel },
): Promise<TimeRow> {
  const { lowerFile } = await import("../compiler/host/tslc.ts");
  const rel = relative(ROOT, file);
  const row: TimeRow = {
    file: rel,
    mode,
    level,
    taken: false,
    reshaped: [],
    sameTir: false,
    ratio: null,
  };
  const d = lowerFile(file, { memory: mode as never, opt: level, route: "direct" });
  const a = lowerFile(file, { memory: mode as never, opt: level, route: "auto" });
  if (a.tsl === undefined || a.tsl.file === "" || a.tir === null || d.tir === null) {
    row.why = a.tslSkipped ?? "the direct route";
    return row;
  }
  row.taken = true;
  row.reshaped = Object.keys(a.tsl.stats.reshapedWhy ?? {});
  row.sameTir = a.tirHash === d.tirHash;
  if (row.sameTir) return row;
  const casesFile = file.replace(/\.ts$/, ".cases.json");
  const cases = existsSync(casesFile)
    ? (JSON.parse(readFileSync(casesFile, "utf8")) as LowerCase[])
    : [];
  // TMK_R14_FN: one exported function's cases alone, to find where a difference is
  const only = process.env.TMK_R14_FN;
  if (only !== undefined) cases.splice(0, cases.length, ...cases.filter((c) => c.fn === only));
  if (cases.length === 0) {
    row.why = "no cases";
    return row;
  }
  const { pages, stack } = pinsOf(file);
  const image = (r: typeof d) =>
    buildDownImage(
      r.tir!,
      r.meta as never,
      cases,
      pages,
      { bulkBytes: bulkFor(), timePasses: o.passes, noDump: true },
      undefined,
      stack,
    ).image;
  const imgs = { direct: image(d), tsl: image(a) };
  const per: Record<"direct" | "tsl", number[]> = { direct: [], tsl: [] };
  const traps: Record<"direct" | "tsl", number[]> = { direct: [], tsl: [] };
  for (let k = 0; k < o.runs; k++)
    for (const route of k % 2 === 0 ? (["direct", "tsl"] as const) : (["tsl", "direct"] as const)) {
      const q = await qemuRun({
        name: `r14-time/${rel.replace(/\W/g, "_")}-${mode}-O${level}-${route}-${k}`,
        image: imgs[route].bytes,
        accel: o.accel,
        timeoutMs: 120_000,
        ...(imgs[route].bulk !== undefined ? { bulk: imgs[route].bulk } : {}),
      });
      if (q.skipped) {
        row.why = "HVF unavailable: skipped, not passed";
        return row;
      }
      const p = passes(q.lines);
      if (!q.ok || p.ticks.length < o.passes) {
        row.why = `${route} run ${k}: ${q.status} ${q.why.slice(0, 200)} (${p.ticks.length} passes)`;
        return row;
      }
      // the first pass warms up; the rest's median
      per[route].push(median(p.ticks.slice(1)) / p.freq);
      traps[route].push(p.traps);
    }
  row.direct = median(per.direct) * 1e6;
  row.tsl = median(per.tsl) * 1e6;
  row.ratio = row.direct > 0 ? row.tsl / row.direct : null;
  if (median(traps.direct) !== median(traps.tsl)) row.trapsDiffer = true;
  return row;
}

async function main(): Promise<void> {
  const mode = flag("--mode") ?? "leak";
  const runs = Number(flag("--runs") ?? "5");
  const npass = Number(flag("--passes") ?? "40");
  const accel = (flag("--accel") ?? "hvf") as Accel;
  const levels = (flag("--levels") ?? "1,2").split(",").map(Number) as (1 | 2)[];
  let files: string[];
  const list = flag("--files");
  const from = flag("--from");
  if (list !== undefined) files = list.split(",").map((f) => join(ROOT, f));
  else if (from !== undefined) {
    const rows = JSON.parse(readFileSync(from, "utf8")) as {
      file: string;
      mode: string;
      status: string;
    }[];
    files = rows
      .filter((r) => r.mode === mode && r.status === "reshaped")
      .map((r) => join(ROOT, r.file));
  } else
    files = PIPE_DIRS.flatMap((d) => listPrograms(join(ROOT, d))).filter(
      (f) => !f.endsWith(".cases.ts"),
    );
  const load0 = loadavg();
  const out: TimeRow[] = [];
  for (const f of files)
    for (const level of levels) {
      let r: TimeRow;
      try {
        r = await timeProgram(f, mode, level, { runs, passes: npass, accel });
      } catch (e) {
        r = {
          file: relative(ROOT, f),
          mode,
          level,
          taken: false,
          reshaped: [],
          sameTir: false,
          ratio: null,
          why: `threw: ${String(e).slice(0, 200)}`,
        };
      }
      out.push(r);
      if (r.taken)
        console.log(
          `${r.file} ${mode} -O${level}: ${r.sameTir ? "same TIR" : r.ratio !== null ? `${r.ratio.toFixed(3)} (${r.direct!.toFixed(1)} vs ${r.tsl!.toFixed(1)} us)${r.trapsDiffer === true ? " TRAPS DIFFER" : ""}` : `not timed: ${r.why}`}`,
        );
    }
  const load1 = loadavg();
  console.log(
    `load ${load0.map((x) => x.toFixed(1)).join(" ")} -> ${load1.map((x) => x.toFixed(1)).join(" ")}`,
  );
  const j = flag("--json");
  if (j !== undefined)
    writeFileSync(j, JSON.stringify({ load: [load0, load1], rows: out }, null, 1));
  process.exit(0);
}

if (import.meta.main) await main();
