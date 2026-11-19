// R14's speed check for each program a trusted reshape touches (SPEC M5's R14 record, D62, pile item 9): at -O1 and -O2,
// the direct route's build against `auto`'s (the TSL route, reshaped only as it trusts). Where the two TIRs are the same,
// the machine code is, and nothing is timed. Otherwise each route's image runs the program's own cases many passes over,
// each case's run timed by the counter (Driver.main's timing passes), the two routes' runs interleaved, and the ratio is
// the median pass of the TSL route's over the direct route's. Numbers only: no gate.
//
// R29, the owner's ruling (2027-01-21; SPEC 8.3, D62): a program that runs until memory is out is judged at equal work, not
// by its time to the trap. Such a program is one with a case pinned to trap 14 in the mode timed (`untilOut`), whose first
// argument is its count of work. Each such case's limit is found through each route (the largest count it runs at without
// the trap, the cases before it run first), and the program is timed with the case at the smaller limit, halved while a
// timed pass still traps there; the old measure, time to the trap, is reported beside it and never judged. Doing more work
// before memory runs out is better use of memory, not slowness. The tests of the trap itself are untouched: every route
// still runs each such case at its pinned count until memory is out, and its trap is checked, as before.
//
// Where equal work can't be reached (a later pass runs out of memory through one route only, whatever the count), the old
// measure is the one judged, and the line says so: nothing is judged more loosely than before.
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
import { bulkFor, buildDownImage } from "./native-exec.ts";
import { median } from "./bench-alloc.ts";
import { qemuRun, type Accel } from "./qemu-run.ts";
import { PIPE_DIRS } from "./pipe-tests.ts";
import { caseKinds, caseTraps, untilOut, type AnyCase } from "./equal-work.ts";

export interface TimeRow {
  file: string;
  mode: string;
  level: 1 | 2;
  /** `auto` took the TSL route, and its printing was reshaped (by the kinds it trusts) */
  taken: boolean;
  reshaped: string[];
  sameTir: boolean;
  /**
   * TSL route over direct, the median pass: null where the code is the same or nothing ran. For a program that runs until
   * memory is out (`untilOut`), this is at equal work (`work`), the owner's ruling of 2027-01-21.
   */
  ratio: number | null;
  direct?: number;
  tsl?: number;
  /** the two routes trapped a different number of times over the passes (out of memory, say): the ratio means little */
  trapsDiffer?: boolean;
  /**
   * R29: a program with a case pinned to run until memory is out (trap 14 in this mode): what each such case was run at
   * for the ratio above, so both routes do the same work. `limit` is the largest count each route ran the case at without
   * the trap (found by halving the interval, the cases before it run first); `count` the one timed, the smaller limit, or
   * half of it as often as a timed pass still trapped there.
   */
  work?: {
    fn: string;
    at: number;
    pinned: number;
    count: number;
    limit: { direct: number; tsl: number };
  }[];
  /**
   * R29: false where equal work was never reached (a later pass ran out of memory through one route only, at every count
   * tried): the program is then judged by the old measure, as before the ruling, and `ratio` is `toTrap`'s.
   */
  settled?: false;
  /** R29: the same program by the old measure, time to the trap with the pinned counts: reported, judged only unsettled */
  toTrap?: { ratio: number | null; direct: number; tsl: number; trapsDiffer?: boolean };
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
    ? (JSON.parse(readFileSync(casesFile, "utf8")) as AnyCase[])
    : [];
  // TMK_R14_FN: one exported function's cases alone, to find where a difference is
  const only = process.env.TMK_R14_FN;
  if (only !== undefined) cases.splice(0, cases.length, ...cases.filter((c) => c.fn === only));
  if (cases.length === 0) {
    row.why = "no cases";
    return row;
  }
  const { pages, stack } = pinsOf(file);
  const image = (r: typeof d, cs: AnyCase[], timePasses: number) =>
    buildDownImage(
      r.tir!,
      r.meta as never,
      cs,
      pages,
      { bulkBytes: bulkFor(), timePasses, noDump: true },
      undefined,
      stack,
    ).image;
  const builds = { direct: d, tsl: a };
  const tag = `${rel.replace(/\W/g, "_")}-${mode}-O${level}`;
  // One run of an image: its lines, or why it didn't finish (HVF unavailable is a skip, never a pass).
  const runImage = async (
    img: ReturnType<typeof image>,
    name: string,
  ): Promise<{ lines: string[] } | { why: string; skipped?: true }> => {
    const q = await qemuRun({
      name,
      image: img.bytes,
      accel: o.accel,
      timeoutMs: 120_000,
      ...(img.bulk !== undefined ? { bulk: img.bulk } : {}),
    });
    if (q.skipped) return { why: "HVF unavailable: skipped, not passed", skipped: true };
    if (!q.ok) return { why: `${q.status} ${q.why.slice(0, 200)}` };
    return { lines: q.lines };
  };
  // Both routes' images of a case list, run o.runs times interleaved: the median pass of each, and each run's lines.
  type Timed = {
    direct: number;
    tsl: number;
    trapsDiffer: boolean;
    lines: Record<"direct" | "tsl", string[][]>;
  };
  const timePair = async (cs: AnyCase[], what: string): Promise<Timed | string> => {
    const imgs = { direct: image(d, cs, o.passes), tsl: image(a, cs, o.passes) };
    const per: Record<"direct" | "tsl", number[]> = { direct: [], tsl: [] };
    const traps: Record<"direct" | "tsl", number[]> = { direct: [], tsl: [] };
    const lines: Record<"direct" | "tsl", string[][]> = { direct: [], tsl: [] };
    for (let k = 0; k < o.runs; k++)
      for (const route of k % 2 === 0
        ? (["direct", "tsl"] as const)
        : (["tsl", "direct"] as const)) {
        const q = await runImage(imgs[route], `r14-time/${tag}-${route}-${what}${k}`);
        if (!("lines" in q)) return q.skipped === true ? q.why : `${route} run ${k}: ${q.why}`;
        const p = passes(q.lines);
        if (p.ticks.length < o.passes) return `${route} run ${k}: ${p.ticks.length} passes`;
        // the first pass warms up; the rest's median
        per[route].push(median(p.ticks.slice(1)) / p.freq);
        traps[route].push(p.traps);
        lines[route].push(q.lines);
      }
    return {
      direct: median(per.direct) * 1e6,
      tsl: median(per.tsl) * 1e6,
      trapsDiffer: median(traps.direct) !== median(traps.tsl),
      lines,
    };
  };
  const out = cases.map((c) => untilOut(c, mode));
  // A case run until memory is out with no count to judge it at: the program is judged as before, by its time to the trap.
  const noCount = out.includes("no count");
  if (noCount || !out.includes("count")) {
    const t = await timePair(cases, "");
    if (typeof t === "string") {
      row.why = t;
      return row;
    }
    row.direct = t.direct;
    row.tsl = t.tsl;
    row.ratio = row.direct > 0 ? row.tsl / row.direct : null;
    if (t.trapsDiffer) row.trapsDiffer = true;
    if (noCount) row.settled = false;
    return row;
  }
  // R29: runs until memory is out. The old measure first, reported only.
  const old = await timePair(cases, "to-trap-");
  if (typeof old === "string") {
    row.why = `to the trap: ${old}`;
    return row;
  }
  row.toTrap = {
    ratio: old.direct > 0 ? old.tsl / old.direct : null,
    direct: old.direct,
    tsl: old.tsl,
    ...(old.trapsDiffer ? { trapsDiffer: true } : {}),
  };
  // Each such case's limit through each route, in order, the cases before it run first (an earlier such case at the count
  // settled for it): the largest count whose one run gives a result, not a trap, by halving the interval to 1%.
  const eq: AnyCase[] = cases.map((c) => ({ ...c, args: [...c.args] }));
  const work: NonNullable<TimeRow["work"]> = [];
  for (let j = 0; j < cases.length; j++) {
    if (out[j] !== "count") continue;
    const pinned = cases[j]!.args[0] as number;
    const limit = { direct: 0, tsl: 0 };
    for (const route of ["direct", "tsl"] as const) {
      const fits = async (n: number): Promise<boolean | string> => {
        const cs = eq
          .slice(0, j + 1)
          .map((c, i) => (i === j ? { ...c, args: [n, ...c.args.slice(1)] } : c));
        const q = await runImage(
          image(builds[route], cs, 1),
          `r14-time/${tag}-${route}-limit-${j}-${n}`,
        );
        if (!("lines" in q)) return q.why;
        if (caseTraps(q.lines, j).length > 0) return false;
        return q.lines.some((l) => l.startsWith(`TMK:C ${j} R`));
      };
      let lo = 0;
      let hi = pinned;
      while (hi - lo > Math.max(1, Math.floor(lo / 100))) {
        const mid = lo + Math.floor((hi - lo) / 2);
        const f = await fits(mid);
        if (typeof f === "string") {
          row.why = `${route}'s limit for case ${j}: ${f}`;
          return row;
        }
        if (f) lo = mid;
        else hi = mid;
      }
      limit[route] = lo;
    }
    const count = Math.min(limit.direct, limit.tsl);
    if (count < 1) {
      // no count runs it without the trap through a route: judged as before, by its time to the trap
      row.direct = old.direct;
      row.tsl = old.tsl;
      row.ratio = row.toTrap.ratio;
      if (old.trapsDiffer) row.trapsDiffer = true;
      row.work = [...work, { fn: cases[j]!.fn, at: j, pinned, count, limit }];
      row.settled = false;
      return row;
    }
    eq[j]!.args[0] = count;
    work.push({ fn: cases[j]!.fn, at: j, pinned, count, limit });
  }
  // Timed at those counts. Equal work needs every pass the same through both routes: no such case traps in any pass, and
  // each case traps, or doesn't, alike in each pass (what the passes before it keep, as a map the case filled, can run a
  // later case out of memory through one route only). Where that doesn't hold, every such count is halved, at most 8
  // times; where it never holds, the program is judged by the old measure, time to the trap, as before (`settled` false).
  for (let halvings = 0; ; halvings++) {
    const t = await timePair(eq, `equal-${halvings}-`);
    if (typeof t === "string") {
      row.why = `at equal work: ${t}`;
      return row;
    }
    const same =
      !work.some((w) =>
        (["direct", "tsl"] as const).some((r) =>
          t.lines[r].some((ls) => caseTraps(ls, w.at).length > 0),
        ),
      ) && t.lines.direct.every((ls, k) => caseKinds(ls) === caseKinds(t.lines.tsl[k] ?? []));
    if (same) {
      row.direct = t.direct;
      row.tsl = t.tsl;
      row.ratio = row.direct > 0 ? row.tsl / row.direct : null;
      if (t.trapsDiffer) row.trapsDiffer = true;
      row.work = work;
      return row;
    }
    if (halvings === 8 || work.some((w) => w.count < 2)) {
      // never the same work: judged as before, by its time to the trap, and said so
      row.direct = old.direct;
      row.tsl = old.tsl;
      row.ratio = row.toTrap.ratio;
      if (old.trapsDiffer) row.trapsDiffer = true;
      row.work = work;
      row.settled = false;
      return row;
    }
    for (const w of work) {
      w.count = Math.floor(w.count / 2);
      eq[w.at]!.args[0] = w.count;
    }
  }
}

/** R29: how a program run until memory is out was judged, for the line printed: at equal work, and by the old measure. */
function equalWork(r: TimeRow): string {
  if (r.toTrap === undefined) return "";
  const w = (r.work ?? []).map(
    (x) =>
      `${x.fn} at ${x.count} (limits ${x.limit.direct} direct, ${x.limit.tsl} TSL; pinned ${x.pinned})`,
  );
  const t = r.toTrap;
  const how =
    r.settled === false ? "equal work never reached, judged to the trap; tried" : "at equal work";
  return ` [${how}: ${w.join(", ") || "-"}; to the trap ${t.ratio !== null ? t.ratio.toFixed(3) : "-"} (${t.direct.toFixed(1)} vs ${t.tsl.toFixed(1)} us)${t.trapsDiffer === true ? " TRAPS DIFFER" : ""}]`;
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
          `${r.file} ${mode} -O${level}: ${r.sameTir ? "same TIR" : r.ratio !== null ? `${r.ratio.toFixed(3)} (${r.direct!.toFixed(1)} vs ${r.tsl!.toFixed(1)} us)${r.trapsDiffer === true ? " TRAPS DIFFER" : ""}` : `not timed: ${r.why}`}${equalWork(r)}`,
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
