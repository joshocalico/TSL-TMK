// Random programs with exceptions (SPEC 8.1, D49): try, catch and finally in every arrangement, every way out of them,
// throws of errors, subclasses, numbers and strings, closures and callbacks that throw, classes with overriding methods,
// and counted objects held in locals, fields, globals and the thrown errors themselves. Each is compared with V8 in rc's
// poisoning build, at a small freeing budget, and after a reset that drops every global, nothing may be left alive.
// `node tools/exc-fuzz.ts [--seeds n] [--from s] [--accel hvf|tcg] [--level 0|2]`.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Module } from "../compiler/tir/ir.ts";
import { lowerAndBuild } from "./compile-pool.ts";
import { defaultEngines, lowerCommand, ROOT } from "./corpus.ts";
import { guardedRun, pool } from "./guarded-run.ts";
import type { LowerCase, LowerCaseResult } from "./lower-exec.ts";
import { bulkFor, downResults, rcStatLines, type DownMetaLike } from "./native-exec.ts";
import { qemuRun, type Accel } from "./qemu-run.ts";
import { buildPath } from "./build-dir.ts";

class Rng {
  s: number;
  constructor(seed: number) {
    this.s = (seed * 2246822519 + 7) >>> 0 || 1;
  }
  next(n: number): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s % n;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.next(xs.length)]!;
  }
}

const GLOBALS = ["g0", "g1"];

export function generate(seed: number): string {
  const r = new Rng(seed);
  const FUNCS = 3 + r.next(3);
  let nv = 0;
  let nl = 0;
  const num = (vars: string[]): string =>
    r.pick([
      () => `${r.next(20)}`,
      () => "t",
      () => "k",
      () => {
        const x = vars.length > 0 ? r.pick(vars) : "g0";
        return `(${x} === null ? ${r.next(9)} : ${x}.v)`;
      },
    ])();
  const ref = (vars: string[], depth: number): string => {
    const opts: (() => string)[] = [
      () => "null",
      () => `new Base(${num(vars)})`,
      () => `new Sub(${num(vars)})`,
      () => r.pick(GLOBALS),
    ];
    if (vars.length > 0)
      opts.push(
        () => r.pick(vars),
        () => r.pick(vars),
      );
    if (depth < 2) {
      opts.push(() => `chain(${r.next(4)}, ${ref(vars, depth + 1)})`);
      opts.push(() => `f${r.next(FUNCS)}(${ref(vars, depth + 1)}, ${num(vars)})`);
    }
    return r.pick(opts)();
  };
  const throwStmt = (vars: string[]): string =>
    r.pick([
      () => `throw new BaseErr(${num(vars)}, ${ref(vars, 1)});`,
      () => `throw new SubErr(${num(vars)}, ${ref(vars, 1)});`,
      () => `throw new RangeError("r" + ${num(vars)});`,
      () => `throw ${num(vars)};`,
      () => `throw "s" + ${num(vars)};`,
    ])();
  const handler = (vars: string[], depth: number, loops: string[]): string => {
    const v = `e${nv++}`;
    const body = r.pick([
      () =>
        `if (${v} instanceof SubErr) t = (t + ${v}.code * 3) | 0; else if (${v} instanceof BaseErr) { t = (t + ${v}.code) | 0; if (${v}.held !== null) g1 = ${v}.held; } else t = (t + 1) | 0;`,
      () => `t = (t + tag(${v})) | 0;`,
      () => `if (${v} instanceof BaseErr && ${v}.code % 3 === 0) throw ${v}; t = (t + 5) | 0;`,
      () =>
        `if (typeof ${v} === "number") t = (t + ${v}) | 0; else if (${v} instanceof Error) { t = (t + ${v}.message.length) | 0; caught = ${v}; }`,
      () => `${block(vars, depth + 1, loops)}`,
    ])();
    return r.next(5) === 0
      ? `catch {\nt = (t + 2) | 0;\n${body.includes(v) ? "" : body}\n}`
      : `catch (${v}) {\n${body}\n}`;
  };
  const block = (vars0: string[], depth: number, loops: string[]): string => {
    const vars = [...vars0];
    const n = 1 + r.next(depth === 0 ? 6 : 3);
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const k = r.next(depth >= 3 ? 9 : 16);
      const x = vars.length > 0 ? r.pick(vars) : null;
      switch (k) {
        case 0: {
          const name = `x${nv++}`;
          out.push(`let ${name} = (${ref(vars, 0)}) as Base | null;`);
          vars.push(name);
          break;
        }
        case 1:
          out.push(`t = (t + mayThrow(${num(vars)}, ${ref(vars, 1)})) | 0;`);
          break;
        case 2:
          if (x !== null) out.push(`${x} = (${ref(vars, 1)}) as Base | null;`);
          else out.push(`${r.pick(GLOBALS)} = (${ref(vars, 1)}) as Base | null;`);
          break;
        case 3:
          if (x !== null) out.push(`if (${x} !== null) ${x}.next = ${ref(vars, 1)};`);
          break;
        case 4:
          if (x !== null) out.push(`if (${x} !== null) t = (t + ${x}.work(${num(vars)})) | 0;`);
          break;
        case 5:
          out.push(`if (fuel-- > 0 && t % ${2 + r.next(5)} === ${r.next(2)}) ${throwStmt(vars)}`);
          break;
        case 6:
          if (loops.length > 0) {
            const l = r.pick(loops);
            out.push(
              `if (t % ${3 + r.next(4)} === 1) ${r.pick(["break", "continue"])}${l === "" ? "" : ` ${l}`};`,
            );
          }
          break;
        case 7:
          if (depth > 0) out.push(`if (t % ${4 + r.next(5)} === 2) return ${ref(vars, 1)};`);
          break;
        case 8:
          out.push(
            `t = (t + (f${r.next(FUNCS)}(${ref(vars, 1)}, ${num(vars)}) === null ? 0 : 1)) | 0;`,
          );
          break;
        default: {
          if (depth >= 3) break;
          const kind = r.next(7);
          if (kind <= 3) {
            const fin = r.next(3) !== 0 ? `finally {\n${block(vars, depth + 1, loops)}\n}` : "";
            const c = r.next(4) !== 0 || fin === "" ? handler(vars, depth, loops) : "";
            out.push(`try {\n${block(vars, depth + 1, loops)}\n} ${c} ${fin}`);
          } else if (kind === 4) {
            const lab = `L${nl++}`;
            out.push(
              `${lab}: for (let i${nl} = 0; i${nl} < ${1 + r.next(3)}; i${nl}++) {\n${block(vars, depth + 1, [...loops, lab, ""])}\n}`,
            );
          } else if (kind === 5) {
            const c = `c${nv++}`;
            out.push(
              `const ${c} = (y: number): number => {\n if (y % ${3 + r.next(3)} === 0 && fuel-- > 0) ${throwStmt([])}\n return (y + t) | 0;\n};\nt = (t + ${c}(${num(vars)})) | 0;`,
            );
          } else {
            out.push(
              `[${num(vars)}, ${num(vars)}, ${num(vars)}].forEach((y) => {\n if (y % ${3 + r.next(4)} === 1 && fuel-- > 0) ${throwStmt([])}\n t = (t + y) | 0;\n});`,
            );
          }
        }
      }
    }
    return out.join("\n");
  };
  const funcs: string[] = [];
  for (let i = 0; i < FUNCS; i++) {
    funcs.push(`function f${i}(p: Base | null, k: number): Base | null {
  if (fuel-- < 0) return p;
  let t = k | 0;
${block(["p"], 1, [])}
  total = (total + t) | 0;
  return ${r.next(2) === 0 ? "p" : ref(["p"], 1)};
}`);
  }
  const entries: string[] = [];
  const ENTRIES = 2 + r.next(2);
  for (let i = 0; i < ENTRIES; i++) {
    const guarded = r.next(3) !== 0;
    const body = block([], 0, []).replace(/\breturn (.*);$/gm, "return t;");
    entries.push(
      guarded
        ? `export function run${i}(k: number): number {
  fuel = 30;
  let t = k | 0;
  try {
${body}
  } catch (e) {
    t = (t + 1000 + tag(e)) | 0;
  }
  total = (total + t) | 0;
  return t | 0;
}`
        : `export function run${i}(k: number): number {
  fuel = 30;
  let t = k | 0;
${body}
  total = (total + t) | 0;
  return t | 0;
}`,
    );
  }
  return `// Generated by tools/exc-fuzz.ts, seed ${seed}.
class Base {
  next: Base | null = null;
  constructor(public v: number) {}
  work(k: number): number {
    if (k % 7 === 3 && fuel-- > 0) throw new BaseErr(k, this);
    return (this.v + k) | 0;
  }
}
class Sub extends Base {
  override work(k: number): number {
    if (k % 5 === 1 && fuel-- > 0) throw new SubErr(k, this.next);
    return (super.work(k + 1) * 2) | 0;
  }
}
class BaseErr extends Error {
  constructor(
    public code: number,
    public held: Base | null,
  ) {
    super("e" + code);
  }
}
class SubErr extends BaseErr {}
let g0: Base | null = null;
let g1: Base | null = null;
let caught: Error | null = null;
let fuel = 0;
let total = 0;
function tag(e: unknown): number {
  if (e instanceof SubErr) return 7 + e.code;
  if (e instanceof BaseErr) return 3 + e.code;
  if (e instanceof Error) return e.message.length;
  if (typeof e === "number") return e | 0;
  if (typeof e === "string") return e.length;
  return 99;
}
function chain(n: number, tail: Base | null): Base | null {
  let h = tail;
  for (let i = 0; i < n; i++) {
    const b: Base = i % 2 === 0 ? new Base(i) : new Sub(i);
    b.next = h;
    h = b;
  }
  return h;
}
function mayThrow(k: number, x: Base | null): number {
  if (fuel-- <= 0) return 0;
  switch (k % 6) {
    case 0:
      throw new BaseErr(k, x);
    case 1:
      throw new SubErr(k, x === null ? null : x.next);
    case 2:
      throw k;
    case 3:
      return x === null ? k : x.work(k);
    default:
      return k;
  }
}
${funcs.join("\n")}
${entries.join("\n")}
function walk(x: Base | null, d: number): number {
  if (x === null || d <= 0) return 1;
  return (x.v + 3 * walk(x.next, d - 1)) | 0;
}
export function digest(): number {
  let s = total;
  s = (s * 7 + walk(g0, 6)) | 0;
  s = (s * 7 + walk(g1, 6)) | 0;
  s = (s * 7 + (caught === null ? 0 : caught.message.length)) | 0;
  return s;
}
export function reset(): number {
  g0 = null;
  g1 = null;
  caught = null;
  return 0;
}
`;
}

export interface ExcFuzzResult {
  seeds: number;
  ran: number;
  fellBack: number;
  cases: number;
  leaked: number;
  threw: number;
  failures: string[];
  skipped: boolean;
}

function casesFor(src: string): LowerCase[] {
  const runs = [...src.matchAll(/^export function (run\d+)/gm)].map((m) => m[1]!);
  const out: LowerCase[] = [];
  for (let round = 0; round < 3; round++)
    for (const fn of runs) out.push({ fn, args: [round + 1] });
  out.push({ fn: "digest", args: [] }, { fn: "reset", args: [] });
  return out;
}

export async function excFuzz(
  from: number,
  seeds: number,
  accel: Accel,
  jobs: number,
  opts: { budgets?: number[]; level?: 0 | 2; rcExtra?: Record<string, unknown>; exc?: string } = {},
): Promise<ExcFuzzResult> {
  const dir = buildPath("exc-fuzz");
  mkdirSync(dir, { recursive: true });
  const engines = defaultEngines();
  const out: ExcFuzzResult = {
    seeds,
    ran: 0,
    fellBack: 0,
    cases: 0,
    leaked: 0,
    threw: 0,
    failures: [],
    skipped: false,
  };
  const budgets = opts.budgets ?? [1, 2, 3, 8, 32];
  const list = Array.from({ length: seeds }, (_, i) => from + i);
  const was = process.env.TMK_OPT;
  const wasExc = process.env.TMK_TEST_EXC;
  if (opts.level !== undefined) process.env.TMK_OPT = String(opts.level);
  if (opts.exc !== undefined) process.env.TMK_TEST_EXC = opts.exc;
  try {
    await pool(list, jobs, async (seed) => {
      const file = join(dir, `s${seed}.ts`);
      const src = generate(seed);
      writeFileSync(file, src);
      const cases = casesFor(src);
      writeFileSync(file.replace(/\.ts$/, ".cases.json"), JSON.stringify(cases));
      const { o, built } = await lowerAndBuild({
        file,
        lower: {
          memory: "rc",
          rc: {
            check: true,
            account: true,
            budget: budgets[seed % budgets.length]!,
            ...opts.rcExtra,
          },
        },
        cases,
        harness: { collect: true, stats: true, bulkBytes: bulkFor() },
        noFallback: true,
      });
      if (o.diags.length > 0) {
        out.failures.push(
          `seed ${seed}: rejected: ${o.diags[0]!.msg.slice(0, 200)} at ${o.diags[0]!.line}`,
        );
        return;
      }
      if (o.tir === null || built === null) {
        out.fellBack++;
        out.failures.push(
          `seed ${seed}: fell back: ${JSON.stringify(o.fallbackDiags[0] ?? {}).slice(0, 300)}`,
        );
        return;
      }
      const c = lowerCommand("source-v8", file, dir, engines);
      const v8 = await guardedRun(c.cmd, c.args, {
        timeoutMs: 30_000,
        label: `exc-fuzz ${seed} on V8`,
        cwd: ROOT,
      });
      if (!v8.ok) {
        out.failures.push(`seed ${seed}: V8 failed: ${v8.why} ${v8.stderr.slice(0, 200)}`);
        return;
      }
      const ref = JSON.parse(v8.stdout) as LowerCaseResult[];
      const r = await qemuRun({
        name: `exc-fuzz/${seed}`,
        image: built.image.bytes,
        accel,
        timeoutMs: 60_000,
        ...(built.image.bulk !== undefined ? { bulk: built.image.bulk } : {}),
      });
      if (r.skipped) {
        out.skipped = true;
        return;
      }
      if (!r.ok) {
        out.failures.push(`seed ${seed}: ${r.status}: ${r.why.slice(0, 200)}`);
        return;
      }
      const { results, problems } = downResults(
        o.meta as DownMetaLike,
        cases,
        built.placements,
        r.lines,
      );
      for (const p of problems) out.failures.push(`seed ${seed}: ${p}`);
      results.forEach((x, i) => {
        out.cases++;
        if ((x.result as { threw?: string }).threw !== undefined) out.threw++;
        const a = JSON.stringify(x.result);
        const b = JSON.stringify(ref[i]?.result);
        if (a !== b)
          out.failures.push(
            `seed ${seed} ${x.fn}#${i}: ${a.slice(0, 160)}, V8 gave ${b?.slice(0, 160)}`,
          );
      });
      // After `reset`, with everything collected: nothing the program made is alive.
      const st = rcStatLines(o.tir as Module, r.lines);
      const last = st[st.length - 1];
      if (last === undefined) out.failures.push(`seed ${seed}: no counters`);
      else if (last.live_objects !== 0) {
        out.leaked++;
        out.failures.push(
          `seed ${seed}: ${last.live_objects} objects, ${last.live_bytes} bytes alive after reset`,
        );
      }
      out.ran++;
    });
  } finally {
    if (was === undefined) delete process.env.TMK_OPT;
    else process.env.TMK_OPT = was;
    if (wasExc === undefined) delete process.env.TMK_TEST_EXC;
    else process.env.TMK_TEST_EXC = wasExc;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const val = (n: string, d: number): number => {
    const i = argv.indexOf(n);
    return i < 0 ? d : Number(argv[i + 1]);
  };
  const accel = (argv.includes("--accel") ? argv[argv.indexOf("--accel") + 1] : "hvf") as Accel;
  const r = await excFuzz(val("--from", 1), val("--seeds", 40), accel, val("--jobs", 4), {
    level: val("--level", 0) as 0 | 2,
  });
  console.log(
    `${r.ran}/${r.seeds} programs ran, ${r.cases} cases (${r.threw} threw to the caller), ${r.fellBack} fell back, ${r.leaked} leaked${r.skipped ? ", SKIPPED" : ""}`,
  );
  for (const f of r.failures.slice(0, 30)) console.log(f);
  process.exitCode = r.failures.length > 0 ? 1 : 0;
}
