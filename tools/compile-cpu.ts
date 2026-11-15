// Per-compile CPU on a fixed sample (T2, D76): TSL and lowered programs, -O0 and -O2, each memory mode, the classes
// route and a generated exceptions program. Each sample is compiled `rounds` times in one process, as a compile worker or a
// batch compiles them; the first round is cold (typescript.js loading, the first parse of the libraries), the rest warm.
// Prints each compile's output fingerprint too (diagnostics, TIR hash, the printed TSL's hash), so two trees or two
// settings can be compared by output as well as by time: `node tools/compile-cpu.ts [rounds] [--json out]`.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { checkFile, compileTyped, lowerFile, type LowerOptions } from "../compiler/host/tslc.ts";

interface Sample {
  file: string;
  opt: 0 | 2;
  tsl?: true; // a TSL program: checkFile, then compileTyped
  lower?: LowerOptions;
}

const L = (file: string, opt: 0 | 2, lower: LowerOptions = {}): Sample => ({ file, opt, lower });
const T = (file: string, opt: 0 | 2): Sample => ({ file, opt, tsl: true });

export const SAMPLE: Sample[] = [
  // TSL proper: strict, the standard library, leak, manual, a package in rc
  T("corpus/pos/adler32.ts", 0),
  T("corpus/pos/adler32.ts", 2),
  T("corpus/std/graph.ts", 0),
  T("corpus/std/graph.ts", 2),
  T("corpus/memory/leak/leak_list.ts", 2),
  T("corpus/memory/manual/manual_list.ts", 0),
  T("corpus/rc/rc_list.ts", 2),
  T("corpus/rc/cyc_shapes.ts", 0),
  // ordinary TS lowered, by tmk lower's route (auto)
  L("corpus/lower/pos/class_struct.ts", 0, { memory: "leak" }),
  L("corpus/lower/pos/class_struct.ts", 2, { memory: "leak" }),
  L("corpus/lower/pos/array_methods.ts", 2, { memory: "manual" }),
  L("corpus/lower/pos/closure_known.ts", 2),
  L("corpus/lower/rc/adv_array_release.ts", 0, { memory: "rc" }),
  L("corpus/lower/rc/adv_array_release.ts", 2, { memory: "rc" }),
  L("corpus/lower/memory/churn.ts", 2, { memory: "leak" }),
  // the dual route's TSL side, with classes: exceptions by hand, and a generated one in rc
  L("corpus/lower/exc/app_parser.ts", 0, { memory: "leak", route: "tsl", classes: true }),
  L("corpus/lower/exc/app_parser.ts", 2, { memory: "manual", route: "tsl", classes: true }),
  L("corpus/lower/exc/app_parser.ts", 2, { memory: "rc", route: "direct" }),
  L("corpus/lower/exc/gen_finally_catch_catch_break.ts", 2, {
    memory: "rc",
    route: "tsl",
    classes: true,
  }),
];

function fingerprint(s: Sample): string {
  if (s.tsl === true) {
    const c = checkFile(s.file);
    const d = JSON.stringify(c.diags);
    if (c.typed === null) return `diags ${sha(d)}`;
    return `tir ${compileTyped(c.typed).tirHash} diags ${sha(d)}`;
  }
  const o = lowerFile(s.file, s.lower);
  const printed = o.tsl === undefined ? "" : ` tsl ${sha(o.tsl.text)}`;
  return `tir ${o.tirHash} diags ${sha(JSON.stringify(o.diags))} fallback ${sha(JSON.stringify(o.fallbackDiags))}${printed}`;
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

if (process.argv[1]?.endsWith("compile-cpu.ts") === true) {
  const rounds = Number(process.argv[2] ?? "3");
  const jsonAt = process.argv.indexOf("--json");
  const rows: { key: string; out: string; cpu: number[] }[] = [];
  for (let r = 0; r < rounds; r++) {
    for (const [i, s] of SAMPLE.entries()) {
      process.env.TMK_OPT = String(s.opt);
      const c0 = process.cpuUsage();
      const out = fingerprint(s);
      const c = process.cpuUsage(c0);
      const key = `${s.file} ${s.tsl === true ? "tsl" : JSON.stringify(s.lower)} -O${s.opt}`;
      rows[i] ??= { key, out, cpu: [] };
      if (rows[i].out !== out)
        throw new Error(`${key}: round ${r} gave ${out}, round 0 ${rows[i].out}`);
      rows[i].cpu.push((c.user + c.system) / 1000);
    }
  }
  let cold = 0;
  let warm = 0;
  for (const row of rows) {
    const w = row.cpu.slice(1);
    const mean = w.length > 0 ? w.reduce((a, b) => a + b, 0) / w.length : row.cpu[0]!;
    cold += row.cpu[0]!;
    warm += mean;
    console.log(
      `${row.key.padEnd(110)} ${row.out}  cold ${row.cpu[0]!.toFixed(0)} warm ${mean.toFixed(0)} ms`,
    );
  }
  console.log(
    `TOTAL first round ${cold.toFixed(0)} ms CPU; warm round ${warm.toFixed(0)} ms CPU (${rows.length} compiles)`,
  );
  if (jsonAt > 0) writeFileSync(process.argv[jsonAt + 1]!, JSON.stringify(rows, null, 1));
}
