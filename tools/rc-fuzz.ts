// Random programs that hold, drop, swap and clear references in every way `rc` has to get right, compared with V8 under
// the poisoning build (SPEC 8.1). Not in the brief for `rc`: it's here because a hand-written list only finds what its
// author thought of, and this is where counts go wrong. `node tools/rc-fuzz.ts [--seeds n] [--from s] [--accel hvf|tcg]`.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Module } from "../compiler/tir/ir.ts";
import { lowerAndBuild } from "./compile-pool.ts";
import { defaultEngines, lowerCommand, ROOT } from "./corpus.ts";
import { guardedRun, pool } from "./guarded-run.ts";
import type { LowerCaseResult } from "./lower-exec.ts";
import { bulkFor, downResults, rcStatLines, type DownMetaLike } from "./native-exec.ts";
import { qemuRun, type Accel } from "./qemu-run.ts";
import { buildPath } from "./build-dir.ts";

class Rng {
  s: number;
  constructor(seed: number) {
    this.s = (seed * 2654435761 + 1) >>> 0 || 1;
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

const GLOBALS = ["g0", "g1", "g2"];
const ARRAYS = ["a0", "a1"];

/** One program. Each function's fuel is a shared budget, so calls can't run away, and neither can closures. */
export function generate(seed: number, cyclic = false): string {
  const r = new Rng(seed);
  let nextVar = 0;
  const FUNCS = 3 + r.next(3);
  const refExpr = (vars: string[], depth: number): string => {
    const opts: (() => string)[] = [
      () => "null",
      () => `new N(${r.next(1000)})`,
      () => r.pick(GLOBALS),
      () => `at(${r.pick(ARRAYS)}, ${r.next(4)})`,
    ];
    if (vars.length > 0) {
      const v = (): string => r.pick(vars);
      opts.push(v, v, v, () => {
        const x = v();
        return `(${x} === null ? null : ${x}.${r.pick(["l", "r"])})`;
      });
      opts.push(() => {
        const x = v();
        return `(${x} === null ? ${r.pick(GLOBALS)} : ${x})`;
      });
    }
    if (depth < 2) {
      opts.push(() => `make(${r.next(100)})`);
      opts.push(
        () =>
          `(${r.pick(["t > 3", "fuel % 2 === 0"])} ? ${refExpr(vars, depth + 1)} : ${refExpr(vars, depth + 1)})`,
      );
      opts.push(() => `pass(${refExpr(vars, depth + 1)})`);
      opts.push(() => `(makeHolder(${r.next(50)}).l)`);
      opts.push(() => `f${r.next(FUNCS)}(${refExpr(vars, depth + 1)}, ${r.next(9)})`);
    }
    return r.pick(opts)();
  };
  const block = (vars0: string[], depth: number, inLoop: boolean): string => {
    const vars = [...vars0];
    const n = 1 + r.next(depth === 0 ? 8 : 4);
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const k = r.next(depth >= 3 ? 16 : 28);
      const pick = (): string | null => (vars.length > 0 ? r.pick(vars) : null);
      const x = pick();
      // The collector's own diet (SPEC 3.5, D41): cycles made on purpose, mixed in with everything else.
      if (cyclic && r.next(4) === 0) {
        const y = pick();
        const name = `w${nextVar++}`;
        const ops: string[] = [
          `${r.pick(GLOBALS)} = cycle(${2 + r.next(6)}, ${r.next(50)});`,
          `const ${name}: N | null = cycle(${1 + r.next(9)}, ${r.next(50)}); t = (t + (${name} === null ? 1 : ${name}.v)) | 0;`,
          `t = (t + tick(${1 + r.next(24)})) | 0;`,
        ];
        if (x !== null) {
          ops.push(
            `if (${x} !== null) ${x}.l = ${x};`,
            `if (${x} !== null) ${x}.r = cycle(${1 + r.next(5)}, ${r.next(50)});`,
            `if (${x} !== null) { ${x}.f = (): number => ${x} === null ? 0 : ${x}.v; }`,
            `if (${x} !== null) { const m = cycle(${2 + r.next(3)}, 1); m!.r = ${x}; ${r.pick(GLOBALS)} = m; }`,
            `if (${x} !== null && ${y} !== null) { ${x}.l = ${y}; ${y}.r = ${x}; }`,
            `if (${x} !== null && a0.length < 32) { const b = ${x}; a0.push(b); b.f = (): number => ${r.pick(ARRAYS)}.length; }`,
          );
        }
        out.push(r.pick(ops));
        continue;
      }
      switch (k) {
        case 0:
        case 1:
        case 2: {
          const name = `v${nextVar++}`;
          out.push(`let ${name}: N | null = (${refExpr(vars, 0)}) as N | null;`);
          vars.push(name);
          break;
        }
        case 3:
          if (x !== null) out.push(`${x} = (${refExpr(vars, 0)}) as N | null;`);
          break;
        case 4:
          if (x !== null)
            out.push(`if (${x} !== null) ${x}.${r.pick(["l", "r"])} = ${refExpr(vars, 1)};`);
          break;
        case 5:
          out.push(`${r.pick(GLOBALS)} = ${refExpr(vars, 1)};`);
          break;
        case 6:
          {
            const a = r.pick(ARRAYS);
            if (x !== null) out.push(`if (${x} !== null && ${a}.length < 32) ${a}.push(${x});`);
            else out.push(`if (${a}.length < 32) ${a}.push(new N(${r.next(50)}));`);
          }
          break;
        case 7: {
          const a = r.pick(ARRAYS);
          out.push(
            r.pick([
              `${a}.pop();`,
              `${a}.shift();`,
              `${a}.splice(${r.next(3)}, ${r.next(3)});`,
              `if (${a}.length > ${r.next(4)}) ${a}.length = ${r.next(2)};`,
              `{ const q = ${a}.pop(); if (q !== undefined) t = (t + q.v) | 0; }`,
              `{ const q = ${a}.shift(); if (q !== undefined) t = (t + q.v) | 0; }`,
              `{ const q = ${a}.splice(0, 1); if (q.length > 0) t = (t + q[0]!.v) | 0; }`,
            ]),
          );
          break;
        }
        case 8:
          if (x !== null) {
            const a = r.pick(ARRAYS);
            out.push(`if (${x} !== null && ${a}.length > ${r.next(3)}) ${a}[0] = ${x};`);
          }
          break;
        case 9:
        case 10:
          if (x !== null) out.push(`t = (t + (${x} === null ? 1 : ${x}.v)) | 0;`);
          break;
        case 11:
          out.push(`t = (t + churn(${8 + r.next(48)})) | 0;`);
          break;
        case 12:
          if (x !== null) out.push(`if (${x} !== null) t = (t + ${x}.m(${r.next(5)})) | 0;`);
          break;
        case 13:
          if (x !== null) out.push(`if (${x} !== null) { [${x}.l, ${x}.r] = [${x}.r, ${x}.l]; }`);
          break;
        case 14:
          if (x !== null) {
            const g = r.pick(GLOBALS);
            const name = `c${nextVar++}`;
            out.push(
              `if (${x} !== null) { const ${name} = ${x}; ${name}.f = (): number => { ${g} = null; const j = churn(8); ${name}.f = null; return ${name}.v + j; }; }`,
            );
          }
          break;
        case 15:
          if (x !== null) out.push(`if (${x} !== null && ${x}.f !== null) t = (t + ${x}.f()) | 0;`);
          break;
        case 16:
        case 17:
          out.push(
            `if (${r.pick(["t % 2 === 0", "fuel % 3 === 0", "a0.length > 1"])}) {\n${block(vars, depth + 1, inLoop)}\n} else {\n${block(vars, depth + 1, inLoop)}\n}`,
          );
          break;
        case 18: {
          const iv = `i${nextVar++}`;
          out.push(
            `for (let ${iv} = 0; ${iv} < ${1 + r.next(4)}; ${iv}++) {\n${block(vars, depth + 1, true)}\n}`,
          );
          break;
        }
        case 19: {
          const iv = `x${nextVar++}`;
          const held = `y${nextVar++}`;
          out.push(
            `for (const ${iv} of ${r.pick(ARRAYS)}) {\nt = (t + ${iv}.v) | 0;\nlet ${held}: N | null = ${iv} as N | null;\n${block([...vars, held], depth + 2, true)}\n}`,
          );
          break;
        }
        case 20:
          if (inLoop) out.push(`if (t % 5 === ${r.next(5)}) ${r.pick(["break", "continue"])};`);
          break;
        case 21:
          if (depth > 0) out.push(`if (t % 7 === ${r.next(7)}) return ${refExpr(vars, 1)};`);
          break;
        case 24:
          if (x !== null)
            out.push(`if (${x} !== null) ${x}.buf = new Uint8Array(${1 + r.next(16)});`);
          break;
        case 25:
          if (x !== null) {
            const y = r.pick(vars);
            out.push(
              r.pick([
                `if (${x} !== null && ${y} !== null) ${x}.buf = ${y}.buf;`,
                `if (${x} !== null && ${x}.buf !== null) { const u = ${x}.buf.subarray(${r.next(3)}); buf0 = u; t = (t + u.length) | 0; }`,
                `if (${x} !== null && ${x}.buf !== null) { ${x}.buf[0] = ${r.next(200)}; t = (t + ${x}.buf[0]!) | 0; }`,
                `if (${x} !== null) ${x}.buf = buf0;`,
              ]),
            );
          }
          break;
        case 26:
          out.push(
            r.pick([
              `buf0 = new Uint8Array(${1 + r.next(16)}).subarray(1);`,
              `t = (t + new Uint8Array(4).subarray(1, 3).length) | 0;`,
              `{ const u = buf0; buf0 = new Uint8Array(2); churn(8); t = (t + u.length) | 0; }`,
              `{ const l = [buf0, buf0.subarray(1), new Uint8Array(3).subarray(2)]; buf0 = l[${r.next(3)}]!; churn(8); t = (t + l[1]!.length) | 0; }`,
            ]),
          );
          break;
        case 27:
          out.push(`t = (t + bigBuf(${r.next(2) * 5000 + 1})) | 0;`);
          break;
        case 22: {
          const cap = `cap${nextVar++}`;
          out.push(
            `let ${cap}: N | null = (${refExpr(vars, 1)}) as N | null;
const set${cap} = (y: N | null): void => { ${cap} = y; };
const get${cap} = (): N | null => ${cap};
set${cap}(${refExpr(vars, 1)});
{ const w = get${cap}(); t = (t + (w === null ? 3 : w.v)) | 0; }
${r.next(2) === 0 ? `h0 = get${cap};` : `s0 = set${cap};`}`,
          );
          break;
        }
        case 23:
          out.push(
            r.pick([
              `if (h0 !== null) { const w = h0(); t = (t + (w === null ? 3 : w.v)) | 0; }`,
              `if (s0 !== null) s0(${refExpr(vars, 1)});`,
              `h0 = null as (() => N | null) | null;`,
              `s0 = null as ((y: N | null) => void) | null;`,
              `if (h0 !== null) { const w = h0(); h0 = null as (() => N | null) | null; churn(8); t = (t + (w === null ? 3 : w.v)) | 0; }`,
            ]),
          );
          break;
      }
    }
    return out.join("\n");
  };
  const funcs: string[] = [];
  for (let i = 0; i < FUNCS; i++) {
    funcs.push(
      `function f${i}(p: N | null, k: number): N | null {
  if (fuel-- < 0) return p;
  let t = k;
${block(["p"], 1, false)}
  total = (total + t) | 0;
  return ${r.next(2) === 0 ? "p" : refExpr(["p"], 1)};
}`,
    );
  }
  const method = block(["self"], 2, false);
  const entries: string[] = [];
  const ENTRIES = 2 + r.next(2);
  for (let i = 0; i < ENTRIES; i++) {
    entries.push(
      `export function run${i}(k: number): number {
  fuel = 40;
  let t = k | 0;
${block([], 0, false).replace(/\breturn (.*);$/gm, "return t;")}
  total = (total + t) | 0;
  return t | 0;
}`,
    );
  }
  return `// Generated by tools/rc-fuzz.ts, seed ${seed}.
class N {
  l: N | null = null;
  r: N | null = null;
  f: (() => number) | null = null;
  buf: Uint8Array | null = null;
  constructor(public v: number) {}
  m(k: number): number {
    if (fuel-- < 0) return k;
    let t = k;
    let self: N | null = this as N | null;
${method.replace(/\breturn (.*);$/gm, "return t;")}
    return t | 0;
  }
}
let g0: N | null = null;
let g1: N | null = null;
let g2: N | null = null;
let a0: N[] = [];
let a1: N[] = [new N(1)];
let h0: (() => N | null) | null = null;
let s0: ((y: N | null) => void) | null = null;
let fuel = 0;
let total = 0;
let buf0: Uint8Array = new Uint8Array(4);
function bigBuf(n: number): number {
  const b = new Uint8Array(n);
  const v = b.subarray(n >> 1);
  buf0 = v;
  return v.length;
}
function at(a: N[], i: number): N | null {
  const x = a[i];
  return x === undefined ? null : x;
}
function make(v: number): N {
  return new N(v);
}
function pass(x: N | null): N | null {
  return x;
}
function makeHolder(v: number): N {
  const h = new N(v);
  h.l = new N(v + 1);
  return h;
}
function churn(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s = (s + new N(i).v) | 0;
  return s;
}
${
  cyclic
    ? `function cycle(n: number, v: number): N | null {
  const a = new N(v);
  let p: N = a;
  for (let i = 1; i < n; i++) {
    const c = new N(v + i);
    p.l = c;
    c.r = p;
    p = c;
  }
  p.l = a;
  return a;
}
function tick(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s = (s + new T(i).t) | 0;
  return s;
}
class T {
  constructor(public t: number) {}
}
`
    : ""
}${funcs.join("\n")}
${entries.join("\n")}
function walk(x: N | null, d: number): number {
  if (x === null || d <= 0) return 1;
  return (x.v + 3 * walk(x.l, d - 1) + 5 * walk(x.r, d - 1)) | 0;
}
export function digest(): number {
  let s = total;
  s = (s * 7 + walk(g0, 5)) | 0;
  s = (s * 7 + walk(g1, 5)) | 0;
  s = (s * 7 + walk(g2, 5)) | 0;
  s = (s * 7 + buf0.length) | 0;
  for (const x of a0) s = (s * 3 + walk(x, 3)) | 0;
  for (const x of a1) s = (s * 3 + walk(x, 3)) | 0;
  return s;
}
`;
}

export interface FuzzResult {
  seeds: number;
  ran: number;
  fellBack: number;
  rejected: number;
  cases: number;
  failures: string[];
  skipped: boolean;
}

export async function fuzz(
  from: number,
  seeds: number,
  accel: Accel,
  jobs: number,
  rcExtra: Record<string, unknown> = {},
  sameProgramIsFailure = false,
  cyclic?: { budgets: number[]; collected?: { freed: number } },
): Promise<FuzzResult> {
  const dir = buildPath("rc-fuzz");
  mkdirSync(dir, { recursive: true });
  const engines = defaultEngines();
  const out: FuzzResult = {
    seeds,
    ran: 0,
    fellBack: 0,
    rejected: 0,
    cases: 0,
    failures: [],
    skipped: false,
  };
  const list = Array.from({ length: seeds }, (_, i) => from + i);
  await pool(list, jobs, async (seed) => {
    const file = join(dir, `s${seed}.ts`);
    writeFileSync(file, generate(seed, cyclic !== undefined));
    const test =
      cyclic !== undefined
        ? {
            pace: false,
            account: true,
            budget: cyclic.budgets[seed % cyclic.budgets.length]!,
          }
        : {};
    const { o, built, cases } = await lowerAndBuild({
      file,
      lower: { memory: "rc", rc: { check: true, ...test, ...rcExtra } },
      harness: {
        collect: true,
        bulkBytes: bulkFor(),
        ...(cyclic !== undefined ? { stats: true } : {}),
      },
      noFallback: true,
    });
    if (o.diags.length > 0) {
      out.rejected++;
      out.failures.push(
        `seed ${seed}: tsc rejected it: ${o.diags[0]!.msg.slice(0, 200)} at ${o.diags[0]!.line}`,
      );
      return;
    }
    if (o.tir === null || built === null) {
      out.fellBack++;
      return;
    }
    const casesPath = file.replace(/\.ts$/, ".cases.json");
    writeFileSync(casesPath, JSON.stringify(cases));
    const c = lowerCommand("source-v8", file, dir, engines);
    const v8 = await guardedRun(c.cmd, c.args, {
      timeoutMs: 30_000,
      label: `fuzz ${seed} on V8`,
      cwd: ROOT,
    });
    if (!v8.ok) {
      out.failures.push(`seed ${seed}: V8 failed: ${v8.why} ${v8.stderr.slice(0, 200)}`);
      return;
    }
    const ref = JSON.parse(v8.stdout) as LowerCaseResult[];
    const r = await qemuRun({
      name: `rc-fuzz/${seed}`,
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
      const a = JSON.stringify(x.result);
      const b = JSON.stringify(ref[i]?.result);
      // Running out of fuel or stack isn't the question. A wrong value or a dead object is.
      if (a !== b)
        out.failures.push(
          `seed ${seed} ${x.fn}#${i}: ${a.slice(0, 120)}, V8 gave ${b?.slice(0, 120)}`,
        );
    });
    out.ran++;
    if (cyclic?.collected !== undefined) {
      const st = rcStatLines(o.tir as Module, r.lines).filter((x) => x !== undefined);
      cyclic.collected.freed += st.at(-1)?.cc_freed ?? 0;
    }
  });
  void sameProgramIsFailure;
  return out;
}

if (import.meta.url === `file://${process.argv[1]}` && !process.argv.includes("--tsl")) {
  const argv = process.argv.slice(2);
  const val = (n: string, d: number): number => {
    const i = argv.indexOf(n);
    return i < 0 ? d : Number(argv[i + 1]);
  };
  const accel = (argv.includes("--accel") ? argv[argv.indexOf("--accel") + 1] : "hvf") as Accel;
  const r = await fuzz(
    val("--from", 1),
    val("--seeds", 100),
    accel,
    val("--jobs", 4),
    argv.includes("--omit-inc") ? { omitInc: val("--omit-inc", 0) } : {},
    false,
    argv.includes("--cyclic") ? { budgets: [1, 2, 3, 5, 8, 13, 32] } : undefined,
  );
  console.log(
    `${r.ran}/${r.seeds} programs ran, ${r.cases} cases, ${r.fellBack} fell back, ${r.rejected} rejected${r.skipped ? ", SKIPPED" : ""}`,
  );
  for (const f of r.failures.slice(0, 30)) console.log(f);
  process.exitCode = r.failures.length > 0 ? 1 : 0;
  void readFileSync;
}

/**
 * Random TSL `rc` programs with cycles (R1c, D41): plain classes in an `rc` package, expanded onto @tsl/gc by tslc. Two
 * classes in one cycle group (N holds N and M, M holds N) and a leaf, held in locals, globals, fields and a vector field,
 * with rings, self-loops, cross-class cycles, a vector's elements moved (pop, removeAt, insert, swapRemove), allocations
 * between steps, and reads through everything still reachable. Each function runs at a small budget with no pacing, so
 * collector steps land between the program's statements. The program as written on V8, its expansion on V8 (whose @tsl/gc
 * collects too, and poisons what it frees) and native code have to agree.
 */
export function generateTsl(seed: number): string {
  const r = new Rng(seed);
  const FUNCS = 3 + r.next(3);
  const G = ["g0", "g1", "g2"];
  let nextVar = 0;
  const fn = (k: number): string => {
    const vars: string[] = [];
    const out: string[] = [];
    const v = (): string => r.pick(vars);
    const val = (): string => {
      const opts = ["nothing()", `new N(${r.next(1000)})`, r.pick(G)];
      if (vars.length > 0) opts.push(v(), v(), v());
      return r.pick(opts);
    };
    const stmt = (depth: number): string => {
      if (depth > 0 && vars.length === 0) return "tick(1);";
      if (depth === 0 && (vars.length === 0 || r.next(6) === 0)) {
        const name = `v${nextVar++}`;
        vars.push(name);
        return `let ${name}: N | null = ${r.pick([`new N(${r.next(1000)})`, `ring(${1 + r.next(6)}, ${r.next(100)})`, r.pick(G), "nothing()"])};`;
      }
      const x = v();
      const y = v();
      switch (r.next(depth < 2 ? 19 : 18)) {
        case 0:
          return `${x} = ${val()};`;
        case 1:
          return `if (${x} !== null) ${x}.l = ${val()};`;
        case 2:
          return `if (${x} !== null) ${x}.r = ${val()};`;
        case 3:
          return `if (${x} !== null) ${x}.l = ${x};`;
        case 4:
          return `${r.pick(G)} = ${val()};`;
        case 5:
          return `if (${x} !== null && ${y} !== null && ${x}.kids.length < 8) ${x}.kids.push(${y});`;
        case 6:
          return `if (${x} !== null && ${x}.kids.length > 0) ${y} = ${x}.kids.pop();`;
        case 7:
          return `if (${x} !== null && ${x}.kids.length > 1) ${y} = ${x}.kids.removeAt(${r.next(2)});`;
        case 8:
          return `if (${x} !== null && ${y} !== null && ${x}.kids.length < 8) ${x}.kids.insert(0, ${y});`;
        case 9:
          return `if (${x} !== null && ${x}.kids.length > 0) ${y} = ${x}.kids.swapRemove(0);`;
        case 10:
        case 11:
          return `tick(${1 + r.next(12)});`;
        case 12:
        case 13:
          return `t = (t + walk(${x}, 5)) % 1000003;`;
        case 14:
          return `if (${x} !== null) { const m = new M(${r.next(100)}); m.n = ${x}; ${x}.m = m; }`;
        case 15:
          return `if (${x} !== null && ${y} !== null) { ${x}.r = ${y}; ${y}.l = ${x}; }`;
        case 16:
          return `${x} = ring(${1 + r.next(8)}, ${r.next(100)});`;
        case 17:
          return `if (${x} !== null && ${x}.m !== null) t = (t + ${x}.m.w) % 1000003;`;
        default: {
          const body: string[] = [];
          for (let i = 0; i < 1 + r.next(4); i++) body.push("    " + stmt(depth + 1));
          return `for (let i${depth}: u32 = 0; i${depth} < ${1 + r.next(12)}; i${depth}++) {\n${body.join("\n")}\n  }`;
        }
      }
    };
    for (let i = 0; i < 6 + r.next(14); i++) out.push("  " + stmt(0));
    const reads = vars.map((x) => `  t = (t + walk(${x}, 5)) % 1000003;`);
    return `export function f${k}(budget: u32): u32 {
  rcSetBudget(budget);
  rcSetPacing(false);
  let t: u32 = 0;
  tick(${r.next(64)});
${out.join("\n")}
${reads.join("\n")}
  rcSetBudget(RC_BUDGET);
  rcSetPacing(true);
  return t;
}`;
  };
  const fns = Array.from({ length: FUNCS }, (_, k) => fn(k));
  return `// generated by tools/rc-fuzz.ts generateTsl(${seed})
import { toU32, type u32 } from "@tsl/core";
import { RC_BUDGET, rcCcFreed, rcCollect, rcLive, rcSetBudget, rcSetPacing } from "@tsl/gc";
import { ref, Vec } from "@tsl/std";

class N {
  l: N | null = null;
  r: N | null = null;
  m: M | null = null;
  kids = new Vec(ref<N>());
  constructor(public v: u32) {}
}
class M {
  n: N | null = null;
  constructor(public w: u32) {}
}
class T {
  constructor(public t: u32) {}
}

let g0: N | null = null;
let g1: N | null = null;
let g2: N | null = null;
let sink: T | null = null;

function nothing(): N | null {
  return null;
}

function tick(k: u32): void {
  for (let i: u32 = 0; i < k; i++) sink = new T(i);
}

function ring(len: u32, seed: u32): N {
  const first = new N(seed);
  let last = first;
  for (let i: u32 = 1; i < len; i++) {
    const n = new N(seed + i);
    last.l = n;
    last = n;
  }
  last.l = first;
  return first;
}

function walk(x: N | null, d: u32): u32 {
  if (x === null || d === 0) return 0;
  const a = walk(x.l, d - 1);
  const b = walk(x.r, d - 1);
  let c: u32 = 0;
  if (x.kids.length > 0) c = walk(x.kids.get(0), d - 1);
  return (x.v + a * 3 + b * 7 + c * 11 + toU32(x.kids.length)) % 1000003;
}

${fns.join("\n\n")}

export function digest(): u32 {
  const t = (walk(g0, 6) + walk(g1, 6) * 3 + walk(g2, 6) * 7) % 1000003;
  g0 = null;
  g1 = null;
  g2 = null;
  return t;
}

/** What the collector freed: the expansion on V8 and native code have to agree on it exactly. */
export function ccFreed(): u32 {
  return toU32(rcCcFreed());
}

/** Everything but \`sink\` is unreachable now, cycles included: after rcCollect, one object is left. */
export function settle(): u32 {
  rcCollect();
  return toU32(rcLive());
}
`;
}

/** Runs generateTsl's programs: as written and expanded on V8, and natively, each case at one of `budgets`. */
export async function fuzzTsl(
  from: number,
  seeds: number,
  accel: Accel,
  jobs: number,
  budgets: number[] = [1, 2, 3],
): Promise<FuzzResult & { freed: number }> {
  const dir = buildPath("rc-fuzz-tsl");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tsl.json"), '{ "memory": "rc" }\n');
  const { writeRcExpanded, hostCycles } = await import("./corpus.ts");
  const { checkFile, compileTyped } = await import("./lowering.ts");
  const { buildTslImage, tslResults } = await import("./native-exec.ts");
  const engines = defaultEngines();
  const out: FuzzResult & { freed: number } = {
    seeds,
    ran: 0,
    fellBack: 0,
    rejected: 0,
    cases: 0,
    failures: [],
    skipped: false,
    freed: 0,
  };
  const list = Array.from({ length: seeds }, (_, i) => from + i);
  await pool(list, jobs, async (seed) => {
    const file = join(dir, `t${seed}.ts`);
    const src = generateTsl(seed);
    writeFileSync(file, src);
    const nf = (src.match(/^export function f\d+/gm) ?? []).length;
    const cases = [
      ...Array.from({ length: nf }, (_, k) => ({
        fn: `f${k}`,
        args: [budgets[(seed + k) % budgets.length]!],
      })),
      { fn: "digest", args: [] },
      { fn: "ccFreed", args: [] },
      { fn: "settle", args: [] },
    ];
    const casesPath = file.replace(/\.ts$/, ".cases.json");
    writeFileSync(casesPath, JSON.stringify(cases));
    const c = checkFile(file);
    if (c.typed === null) {
      out.rejected++;
      out.failures.push(`seed ${seed}: rejected: ${JSON.stringify(c.diags).slice(0, 300)}`);
      return;
    }
    const o = compileTyped(c.typed);
    const run = async (
      program: string,
      cycles?: Record<string, number>,
    ): Promise<{ result: unknown }[] | string> => {
      const job = {
        mode: "source",
        program,
        cases: casesPath,
        ...(cycles !== undefined ? { cycles } : {}),
      };
      const g = await guardedRun(
        engines.node,
        [
          "--import",
          join(ROOT, "tools/ts-hook.mjs"),
          "--no-warnings",
          join(ROOT, "tools/corpus-exec.ts"),
          JSON.stringify(job),
        ],
        {
          timeoutMs: 60_000,
          label: `fuzz-tsl ${seed}`,
          cwd: ROOT,
        },
      );
      return g.ok
        ? (JSON.parse(g.stdout) as { result: unknown }[])
        : `${g.why} ${g.stderr.slice(0, 300)}`;
    };
    const written = await run(file);
    const expanded = await run(
      await writeRcExpanded(file, join(dir, `x${seed}`)),
      await hostCycles(file),
    );
    if (typeof written === "string" || typeof expanded === "string") {
      out.failures.push(
        `seed ${seed}: V8 failed: ${typeof written === "string" ? written : expanded}`,
      );
      return;
    }
    const built = buildTslImage(o.tir, o.meta as never, cases as never, undefined, bulkFor());
    const q = await qemuRun({
      name: `rc-fuzz-tsl/${seed}`,
      image: built.bytes,
      accel,
      timeoutMs: 120_000,
      ...(built.bulk !== undefined ? { bulk: built.bulk } : {}),
    });
    if (q.skipped) {
      out.skipped = true;
      return;
    }
    if (!q.ok) {
      out.failures.push(`seed ${seed}: ${q.status}: ${q.why.slice(0, 200)}`);
      return;
    }
    const { results, problems } = tslResults(o.meta as never, cases as never, q.lines);
    for (const p of problems) out.failures.push(`seed ${seed}: ${p}`);
    results.forEach((x, i) => {
      out.cases++;
      const a = JSON.stringify(x.result);
      const w = JSON.stringify(written[i]?.result);
      const e = JSON.stringify(expanded[i]?.result);
      if (x.fn === "settle") {
        if (a !== "1" || e !== "1")
          out.failures.push(`seed ${seed}: left after rcCollect: ${a} natively, ${e} on V8, not 1`);
        return;
      }
      if (x.fn === "ccFreed") {
        // as written there's no collector; the host's and native code's decide alike, step for step
        if (a !== e)
          out.failures.push(`seed ${seed}: the collector freed ${a} natively, ${e} on V8`);
        else out.freed += Number(x.result);
        return;
      }
      if (a !== w || e !== w)
        out.failures.push(`seed ${seed} ${x.fn}#${i}: native ${a}, expanded ${e}, as written ${w}`);
    });
    out.ran++;
  });
  return out;
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes("--tsl")) {
  const argv = process.argv.slice(2);
  const val = (n: string, d: number): number => {
    const i = argv.indexOf(n);
    return i < 0 ? d : Number(argv[i + 1]);
  };
  const accel = (argv.includes("--accel") ? argv[argv.indexOf("--accel") + 1] : "hvf") as Accel;
  const r = await fuzzTsl(val("--from", 1), val("--seeds", 50), accel, val("--jobs", 4));
  console.log(
    `TSL rc with cycles: ${r.ran}/${r.seeds} programs ran, ${r.cases} cases, ${r.rejected} rejected, ${r.freed} objects freed by the collector${r.skipped ? ", SKIPPED" : ""}`,
  );
  for (const f of r.failures.slice(0, 30)) console.log(f);
  process.exitCode = r.failures.length > 0 ? 1 : 0;
}
