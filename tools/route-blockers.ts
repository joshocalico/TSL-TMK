// The TSL route's coverage by first blocker (R5): every lowered program the direct route builds with no fallback, in each
// memory mode, forced through the TSL route as the dual-route differential forces it (class printing in `leak`, `manual`
// and `rc`; phase 1's printing in `strict`), and why the printer stopped where it did. Compiles only; nothing runs.
//
//   node tools/route-blockers.ts [--mode strict|leak|manual|rc] [--level 0|2] [--json out.json]
//
// Each mode is a child process of its own (one TS program per build is memory), run one after another.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { listPrograms, ROOT } from "./corpus.ts";
import { PIPE_DIRS } from "./pipe-tests.ts";

export type BlockerMode = "strict" | "leak" | "manual" | "rc";
const MODES: BlockerMode[] = ["strict", "leak", "manual", "rc"];

/** What R5 counts: the differential's directories, rc-tsl's, and the lowered benchmarks. */
export function blockerPrograms(): string[] {
  const out: string[] = [];
  for (const d of [...PIPE_DIRS, "corpus/lower/rc-tsl"]) out.push(...listPrograms(join(ROOT, d)));
  for (const d of ["bench/maps", "bench/memory", "bench/std", "bench/strmap"])
    out.push(...listPrograms(join(ROOT, d)).filter((f) => f.endsWith("lowered.ts")));
  return out.filter((f) => !f.endsWith(".cases.ts"));
}

/** A blocker's message, with what's particular to one program (names, offsets) taken out, so like counts with like. */
export function blockerKind(why: string): string {
  return why
    .replace(/^not printable yet: /, "")
    .replace(/^classes: EmitUnsupported: /, "")
    .replace(/\(([A-Za-z_$][\w$.]*) [^)]*offset [^)]*\)/, "(…)")
    .replace(/ \(([^)]*\.ts[^)]*|[A-Za-z_$][\w$]* [^)]*)\)$/, "")
    .replace(/(the (?:global|string literal|variable|runtime function|class of)) \S+/, "$1 …")
    .replace(/module state \S+ (reached|that)/, "module state … $1")
    .slice(0, 160);
}

interface Row {
  file: string;
  mode: BlockerMode;
  status: "printed" | "reshaped" | "blocked" | "direct-only";
  why?: string;
  /** R12: printed with its objects as classes in `strict`. */
  classes?: boolean;
}

async function child(mode: BlockerMode, level: 0 | 2): Promise<Row[]> {
  const { lowerFile } = await import("../compiler/host/tslc.ts");
  const rows: Row[] = [];
  for (const file of blockerPrograms()) {
    const rel = relative(ROOT, file);
    let a: ReturnType<typeof lowerFile>;
    try {
      a = lowerFile(file, { memory: mode, opt: level, route: "direct" });
    } catch {
      rows.push({ file: rel, mode, status: "direct-only", why: "the direct route throws" });
      continue;
    }
    if (
      a.diags.length > 0 ||
      a.tir === null ||
      a.fallbackDiags.length > 0 ||
      a.tir.externs.length > 0
    ) {
      rows.push({ file: rel, mode, status: "direct-only" });
      continue;
    }
    // R12: in `strict`, class printing where it prints the program and the program has a class (its objects, nothing
    // else of phase 2), as `auto` tries it; else phase 1's printing, as before.
    if (mode === "strict") {
      try {
        const c = lowerFile(file, { memory: mode, opt: level, route: "tsl", classes: true });
        const texts = c.tsl?.modules?.map((m) => m.text) ?? [c.tsl?.text ?? ""];
        if (texts.some((t) => /^(export )?class /m.test(t))) {
          const why = c.tsl?.stats.reshapedWhy;
          rows.push({
            file: rel,
            mode,
            status: (c.tsl?.stats.restructured ?? 0) > 0 ? "reshaped" : "printed",
            classes: true,
            ...(why !== undefined && Object.keys(why).length > 0
              ? { why: Object.keys(why).join(", ") }
              : {}),
          });
          continue;
        }
      } catch {
        // not printable with classes in strict: phase 1's printing, below
      }
    }
    try {
      const b = lowerFile(file, {
        memory: mode,
        opt: level,
        route: "tsl",
        classes: mode !== "strict",
      });
      const reshaped = (b.tsl?.stats.restructured ?? 0) > 0;
      const why = b.tsl?.stats.reshapedWhy;
      rows.push({
        file: rel,
        mode,
        status: reshaped ? "reshaped" : "printed",
        ...(reshaped && why !== undefined ? { why: Object.keys(why).join(", ") } : {}),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      rows.push({ file: rel, mode, status: "blocked", why: blockerKind(msg) });
    }
  }
  return rows;
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const level = (flag("--level") === "0" ? 0 : 2) as 0 | 2;
  const only = flag("--mode") as BlockerMode | undefined;
  if (process.argv.includes("--child")) {
    const rows = await child(only!, level);
    process.stdout.write(`\n@@ROWS@@${JSON.stringify(rows)}\n`);
    return;
  }
  const all: Row[] = [];
  for (const mode of only !== undefined ? [only] : MODES) {
    const r = spawnSync(
      process.execPath,
      [process.argv[1]!, "--child", "--mode", mode, "--level", String(level)],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28, timeout: 3_600_000 },
    );
    const at = r.stdout.lastIndexOf("@@ROWS@@");
    if (at < 0) {
      console.error(`${mode}: no result (${r.status}): ${r.stderr.slice(-2000)}`);
      process.exitCode = 1;
      continue;
    }
    all.push(...(JSON.parse(r.stdout.slice(at + 8)) as Row[]));
  }
  const out = flag("--json");
  if (out !== undefined) writeFileSync(out, JSON.stringify(all, null, 1));
  for (const mode of MODES) {
    const rs = all.filter((r) => r.mode === mode);
    if (rs.length === 0) continue;
    const n = (s: Row["status"]): number => rs.filter((r) => r.status === s).length;
    console.log(
      `${mode} -O${level}: ${n("printed")} printed exactly, ${n("reshaped")} reshaped, ${n("blocked")} blocked, ${n("direct-only")} not built by the direct route with no fallback`,
    );
    const cls = rs.filter((r) => r.classes === true);
    if (cls.length > 0)
      console.log(
        `  of them with objects as classes (R12): ${cls.filter((r) => r.status === "printed").length} exactly, ${cls.filter((r) => r.status === "reshaped").length} reshaped`,
      );
  }
  // R12: why each reshaped program was reshaped, by kind (emit-tsl.ts's reshape)
  const kinds = new Map<string, Map<BlockerMode, number>>();
  for (const r of all.filter((x) => x.status === "reshaped" && x.why !== undefined))
    for (const k of r.why!.split(", ")) {
      const m = kinds.get(k) ?? new Map<BlockerMode, number>();
      m.set(r.mode, (m.get(r.mode) ?? 0) + 1);
      kinds.set(k, m);
    }
  if (kinds.size > 0) {
    console.log(
      "\nReshaped, by why (strict / leak / manual / rc, programs; one can have several):",
    );
    for (const [k, m] of [...kinds].sort(
      (a, b) =>
        [...b[1].values()].reduce((x, y) => x + y, 0) -
        [...a[1].values()].reduce((x, y) => x + y, 0),
    ))
      console.log(`  ${MODES.map((x) => m.get(x) ?? 0).join(" / ")}  ${k}`);
  }
  const by = new Map<string, Map<BlockerMode, string[]>>();
  for (const r of all.filter((x) => x.status === "blocked")) {
    const m = by.get(r.why!) ?? new Map<BlockerMode, string[]>();
    m.set(r.mode, [...(m.get(r.mode) ?? []), r.file]);
    by.set(r.why!, m);
  }
  const total = (m: Map<BlockerMode, string[]>): number =>
    [...m.values()].reduce((s, x) => s + x.length, 0);
  console.log("\nBlocked, by first blocker (strict / leak / manual / rc, distinct programs):");
  for (const [why, m] of [...by].sort((a, b) => total(b[1]) - total(a[1]))) {
    const progs = new Set([...m.values()].flat());
    console.log(
      `  ${MODES.map((x) => m.get(x)?.length ?? 0).join(" / ")}  (${progs.size})  ${why}`,
    );
  }
}

if (import.meta.main) await main();
