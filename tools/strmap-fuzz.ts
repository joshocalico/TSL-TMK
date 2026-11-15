// Random programs over strings, `Map` and `Set`, in the poisoning build, against V8 (SPEC 8.1, M5 Phase F). Each has objects
// that hold maps and maps that hold objects, so real cycles come and go, and every kind of mutation during iteration.
// `node tools/strmap-fuzz.ts [--seeds n] [--from s] [--accel hvf|tcg] [--budget n]`.
import { mkdirSync, writeFileSync } from "node:fs";
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

const LITS = [
  '""',
  '"a"',
  '"bc"',
  '"é"',
  '"😀"',
  '"\\ud800"',
  '"key"',
  '"0123456789abcdef0123456789abcdef0123456789"',
  '" x "',
  '"1.5"',
];

export function generateStrmap(seed: number): string {
  const r = new Rng(seed);
  const FUNCS = 3 + r.next(3);
  const numE = (): string =>
    r.pick([
      "0",
      "1",
      "2",
      "3",
      "5",
      "7",
      "-1",
      "1.5",
      "tick",
      "fuel % 7",
      "gs.length",
      "ga.length",
      "gm.size",
      "gn.size",
      "gset.size",
    ]);
  const strE = (d = 0): string => {
    const opts: (() => string)[] = [
      () => r.pick(LITS),
      () => r.pick(LITS),
      () => "gs",
      () => `at(ga, ${r.next(4)})`,
      () => `String(${numE()})`,
    ];
    if (d < 3) {
      opts.push(
        () => `(${strE(d + 1)} + ${strE(d + 1)})`,
        () => `\`<\${${strE(d + 1)}}|\${${numE()}}>\``,
        () => `${strE(d + 1)}.slice(${numE()}, ${numE()})`,
        () => `${strE(d + 1)}.substring(${numE()})`,
        () => `${strE(d + 1)}.trim()`,
        () => `${strE(d + 1)}.repeat(${r.next(4)})`,
        () => `${strE(d + 1)}.padStart(${r.next(9)}, ${strE(d + 1)})`,
        () => `${strE(d + 1)}.split(${strE(d + 1)}).join(${strE(d + 1)})`,
        () => `${strE(d + 1)}.toUpperCase()`,
        () => `${strE(d + 1)}.charAt(${numE()})`,
        () => `(gm.get(${strE(d + 1)})?.s ?? ${strE(d + 1)})`,
        () => `(gt.get(${numE()}) ?? ${strE(d + 1)})`,
        () => `ga.join(${strE(d + 1)})`,
        () => `firstKey()`,
        () => `(${strE(d + 1)} < ${strE(d + 1)} ? ${strE(d + 1)} : ${strE(d + 1)})`,
      );
    }
    return r.pick(opts)();
  };
  const nodeE = (): string =>
    r.pick([
      `new N(${r.next(50)}, ${strE(2)})`,
      `gm.get(${strE(2)}) ?? new N(${r.next(50)}, "")`,
      "keep(getHold())",
      `make(${r.next(50)})`,
    ]);
  const stmts = (n: number, depth: number): string[] => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const v = `x${depth}_${i}`;
      const opts: (() => string[])[] = [
        () => [`gs = cap(${strE()});`],
        () => [`ga.push(cap(${strE()}));`],
        () => [`const ${v} = ga.pop(); if (${v} !== undefined) total = mix(total, ${v});`],
        () => [`const ${v} = ga.shift(); if (${v} !== undefined) total = mix(total, ${v});`],
        () => [`ga.sort();`],
        () => [`ga.reverse();`],
        () => [`gm.set(cap(${strE(2)}), ${nodeE()});`],
        () => [`gm.delete(${strE(2)});`],
        () => [`gn.set(${numE()}, ${r.next(100)});`],
        () => [`gn.delete(${numE()});`],
        () => [`gt.set(${numE()}, cap(${strE(2)}));`],
        () => [`gset.add(cap(${strE(2)}));`, `if (gset.has(${strE(2)})) total = (total + 1) | 0;`],
        () => [`gset.delete(${strE(2)});`],
        () => [`gnums.add(${numE()});`, `gnums.delete(${numE()});`],
        () => [`gobj.add(${nodeE()});`],
        () => [`const ${v} = ${nodeE()}; ${v}.m = gm; hold = ${v};`],
        () => [
          `const ${v} = new N(${r.next(9)}, ${strE(2)}); ${v}.m = new Map<string, N>([[${strE(2)}, ${v}]]); gobj.add(${v});`,
        ],
        () => [
          `const ${v} = new N(${r.next(9)}, "c"); ${v}.set = new Set<N>([${v}]); total = (total + ${v}.set.size) | 0;`,
        ],
        () => [
          `const ${v} = new Map<string, N>(); const ${v}n = new N(1, "z"); ${v}n.m = ${v}; ${v}.set("self", ${v}n);`,
        ],
        () => [
          `const ${v} = gm.get(${strE(2)}); dropAll(${r.next(3)}); if (${v} !== undefined) total = mix(total, ${v}.s);`,
        ],
        () => [
          `const ${v} = gt.keys().next().value; if (${v} !== undefined) { gt.delete(${v}); total = (total + (${v} | 0)) | 0; }`,
        ],
        () => {
          const k = `k${depth}_${i}`;
          const body = r.pick([
            `gm.delete(${k});`,
            `gm.set(${k}, new N(1, ${k}));`,
            `gm.delete(${k}); gm.set(${k}, new N(2, ${k}));`,
            `if (c === 1) gm.clear();`,
            `for (let q = 0; q < 12; q++) gm.set(${k} + String(q), new N(q, "g"));`,
            `gs = cap(${k});`,
          ]);
          return [
            `{ let c = 0; for (const [${k}, val] of gm) { total = mix(total, ${k}); total = (total + val.v) | 0; if (c++ > 15) break; ${body} } }`,
          ];
        },
        () => {
          const k = `k${depth}_${i}`;
          const body = r.pick([
            `gset.delete(${k});`,
            `gset.add(${k} + "!");`,
            `gset.clear();`,
            `gset.delete(${k}); gset.add(${k});`,
          ]);
          return [
            `{ let c = 0; for (const ${k} of gset) { total = mix(total, ${k}); if (c++ > 15) break; ${body} } }`,
          ];
        },
        () => [
          `{ let c = 0; gn.forEach((val, key) => { total = (total + val + (key | 0)) | 0; if (c++ < 5) gn.delete(key); }); }`,
        ],
        () => [`for (const key of [...gn.keys()]) total = (total + (key | 0)) | 0;`],
        () => [`for (const key of gnums) total = (total + (key | 0)) | 0;`],
        () => [`for (const ch of ${strE(2)}) total = mix(total, ch);`],
        () => [`total = (total + (Number(${strE(2)}) | 0)) | 0;`],
        () => [`total = (total + (parseInt(${strE(2)}) | 0)) | 0;`],
        () => [`total = (total + ${strE(2)}.indexOf(${strE(2)})) | 0;`],
        () => {
          const b = `b${depth}_${i}`;
          const n = 8 + r.next(60);
          const at = r.next(n);
          return [
            `{ let ${b} = ${r.pick(LITS)}; let ${b}k = ""; for (let q = 0; q < ${n}; q++) { ${b} += ${r.pick(['"abcdefghij"', '"é😀"', "String(q)", "at(ga, q % 3)"])}; if (q === ${at}) ${b}k = ${b}; }`,
            `  const ${b}x = ${b} + "x"; const ${b}y = ${b} + "y"; const ${b}z = ${b}k + "z"; total = mix(mix(mix(total, ${b}x), ${b}y), ${b}z); ga.push(cap(${b}y)); ${b} = ""; churn(${r.next(9)}); total = mix(total, ${b}k); }`,
          ];
        },
        () => {
          const b = `v${depth}_${i}`;
          return [
            `{ let ${b}p = "0123456789abcdef".repeat(${4 + r.next(30)}) + String(tick); const ${b} = ${b}p.slice(${r.next(20)}, ${r.next(2) === 0 ? -r.next(40) - 1 : 40 + r.next(200)}); ${b}p = ""; churn(${r.next(9)}); total = mix(total, ${b}); glong = ${b}; }`,
          ];
        },
        () => [
          `if (glong.length > 40) { const q = glong.substring(${r.next(9)}); glong = ""; churn(3); total = mix(total, q); }`,
        ],
        () => [
          `gnums.add(-0);`,
          `gnums.add(${r.pick(["NaN", "0", "-0", "1 / tick"])});`,
          `gn.set(-0, ${r.next(9)});`,
          `total = (total + (gn.has(0) ? 1 : 0)) | 0;`,
        ],
        () => {
          const it = `it${depth}_${i}`;
          return [
            `{ const ${it} = gm.keys(); let c = 0; while (!${it}.next().done && c < 40) c++; gm.set(${r.pick(LITS)}, new N(1, "woke")); total = (total + (${it}.next().done ? 3 : 5) + c) | 0; }`,
          ];
        },
        () => [`gm.clear();`],
        () => [`gs = "";`],
        () => [`hold = null;`],
        () => {
          const h = `h${depth}_${i}`;
          return [
            `const ${h} = getHold(); if (${h} !== null && ${h}.m !== null) total = (total + ${h}.m.size) | 0;`,
          ];
        },
        () => {
          if (depth >= 2) return [`total = (total + 1) | 0;`];
          return [`if (fuel-- > 0 && ${numE()} > 0) {`, ...stmts(1 + r.next(3), depth + 1), `}`];
        },
        () => {
          if (depth >= 2) return [`total = (total + 2) | 0;`];
          return [
            `for (let i${depth}${i} = 0; i${depth}${i} < ${1 + r.next(4)}; i${depth}${i}++) {`,
            ...stmts(1 + r.next(3), depth + 1),
            `}`,
          ];
        },
        () => [`total = (total + (fuel > 0 ? f${r.next(FUNCS)}(${r.next(5)}) : 0)) | 0;`],
      ];
      out.push(...r.pick(opts)());
    }
    return out;
  };
  const funcs: string[] = [];
  for (let f = 0; f < FUNCS; f++) {
    funcs.push(
      `function f${f}(tick: number): number {\n  fuel--;\n  if (fuel < 0) return tick;\n  ${stmts(4 + r.next(5), 0).join("\n  ")}\n  return total;\n}`,
    );
    funcs.push(
      `export function run${f}(n: number): number {\n  fuel = 40 + n;\n  return f${f}(n);\n}`,
    );
  }
  return `// Generated by tools/strmap-fuzz.ts, seed ${seed}.
class N {
  m: Map<string, N> | null = null;
  set: Set<N> | null = null;
  constructor(public v: number, public s: string) {}
}
let gs = "";
let ga: string[] = [];
let gm = new Map<string, N>();
let gn = new Map<number, number>();
let gt = new Map<number, string>();
let gset = new Set<string>();
let gnums = new Set<number>();
let gobj = new Set<N>();
let hold: N | null = null;
let glong = "";
let fuel = 0;
let total = 0;
function cap(s: string): string {
  return s.length > 400 ? s.slice(0, 400) : s;
}
function mix(h: number, s: string): number {
  let d = h;
  for (let i = 0; i < s.length; i++) d = Math.imul(d ^ s.charCodeAt(i), 16777619);
  return d;
}
function at(a: string[], i: number): string {
  const x = a[i];
  return x === undefined ? "" : x;
}
function make(v: number): N {
  return new N(v, String(v));
}
function keep(x: N | null): N {
  return x === null ? new N(0, "null") : x;
}
function churn(n: number): number {
  let t = 0;
  for (let i = 0; i < n * 8; i++) t = (t + new N(i, "").v + String(i).length) | 0;
  return t;
}
function getHold(): N | null {
  return hold;
}
function firstKey(): string {
  const k = gset.keys().next().value;
  return k === undefined ? "" : k;
}
function dropAll(how: number): void {
  if (how === 0) gm.clear();
  else if (how === 1) for (const k of [...gm.keys()]) gm.delete(k);
  else gm = new Map<string, N>();
}
${funcs.join("\n")}
export function digest(): number {
  let h = total;
  h = mix(h, gs);
  for (const s of ga) h = mix(h, s);
  for (const [k, v] of gm) {
    h = mix(h, k);
    h = mix(h, v.s);
    h = (h + v.v) | 0;
  }
  for (const [k, v] of gn) h = (h * 31 + (k | 0) + v + (1 / k > 0 ? 1 : 2)) | 0;
  for (const [k, v] of gt) h = mix((h + (k | 0)) | 0, v);
  for (const s of gset) h = mix(h, s);
  h = mix(h, glong);
  for (const n of gnums) h = (h * 31 + (n | 0) + (1 / n > 0 ? 1 : 2)) | 0;
  h = (h + gobj.size) | 0;
  for (const o of gobj) h = mix(h, o.s);
  if (gobj.size > 30) gobj.clear();
  return h;
}
`;
}

export interface StrmapFuzzResult {
  seeds: number;
  ran: number;
  fellBack: number;
  rejected: number;
  cases: number;
  failures: string[];
  skipped: boolean;
  freed: number;
}

export async function strmapFuzz(
  from: number,
  seeds: number,
  accel: Accel,
  jobs: number,
  budgets: number[],
  rcExtra: Record<string, unknown> = {},
): Promise<StrmapFuzzResult> {
  const dir = buildPath("strmap-fuzz");
  mkdirSync(dir, { recursive: true });
  const engines = defaultEngines();
  const out: StrmapFuzzResult = {
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
    const file = join(dir, `s${seed}.ts`);
    writeFileSync(file, generateStrmap(seed));
    const budget = budgets[seed % budgets.length]!;
    const { o, built, cases } = await lowerAndBuild({
      file,
      lower: { memory: "rc", rc: { check: true, account: true, pace: false, budget, ...rcExtra } },
      harness: { collect: true, stats: true, bulkBytes: bulkFor() },
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
      out.failures.push(
        `seed ${seed}: fell back: ${o.fallbackDiags
          .map((d) => `${d.fn} ${d.blocker} ${d.detail} ${d.line}`)
          .join("; ")
          .slice(0, 300)}`,
      );
      return;
    }
    writeFileSync(file.replace(/\.ts$/, ".cases.json"), JSON.stringify(cases));
    const c = lowerCommand("source-v8", file, dir, engines);
    const v8 = await guardedRun(c.cmd, c.args, {
      timeoutMs: 60_000,
      label: `strmap fuzz ${seed} on V8`,
      cwd: ROOT,
    });
    if (!v8.ok) {
      out.failures.push(`seed ${seed}: V8 failed: ${v8.why} ${v8.stderr.slice(0, 200)}`);
      return;
    }
    const ref = JSON.parse(v8.stdout) as LowerCaseResult[];
    const q = await qemuRun({
      name: `strmap-fuzz/${seed}`,
      image: built.image.bytes,
      accel,
      timeoutMs: 120_000,
      ...(built.image.bulk !== undefined ? { bulk: built.image.bulk } : {}),
    });
    if (q.skipped) {
      out.skipped = true;
      return;
    }
    if (!q.ok) {
      out.failures.push(`seed ${seed}: ${q.status}: ${q.why.slice(0, 200)}`);
      return;
    }
    const { results, problems } = downResults(
      o.meta as DownMetaLike,
      cases,
      built.placements,
      q.lines,
    );
    for (const p of problems) out.failures.push(`seed ${seed}: ${p}`);
    // After a trap on one side and a throw on the other, the two have done different work, so that's the end of comparing.
    let stopped = false;
    results.forEach((x, i) => {
      out.cases++;
      const a = JSON.stringify(x.result);
      const b = JSON.stringify(ref[i]?.result);
      if (a !== b) {
        // Going past a limit isn't the question: a thrown RangeError on one side is a trap on the other (3.10, item 1).
        const native = x.result as { trap?: number };
        const v = ref[i]?.result as { threw?: string } | undefined;
        if (native.trap !== undefined && v?.threw !== undefined) {
          stopped = true;
          return;
        }
        if (stopped) return;
        out.failures.push(
          `seed ${seed} ${x.fn}#${i}: ${a.slice(0, 120)}, V8 gave ${b?.slice(0, 120)}`,
        );
      }
    });
    out.ran++;
    const st = rcStatLines(o.tir as Module, q.lines).filter((x) => x !== undefined);
    out.freed += st.at(-1)?.cc_freed ?? 0;
  });
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const val = (n: string, d: number): number => {
    const i = argv.indexOf(n);
    return i < 0 ? d : Number(argv[i + 1]);
  };
  const accel = (argv.includes("--accel") ? argv[argv.indexOf("--accel") + 1] : "hvf") as Accel;
  const r = await strmapFuzz(
    val("--from", 1),
    val("--seeds", 50),
    accel,
    val("--jobs", 4),
    [1, 2, 3, 5, 8, 13, 32],
    argv.includes("--fault") ? { rtFault: argv[argv.indexOf("--fault") + 1] } : {},
  );
  console.log(
    `${r.ran}/${r.seeds} programs ran, ${r.cases} cases, ${r.fellBack} fell back, ${r.rejected} rejected, ${r.freed} freed as cycles${r.skipped ? ", SKIPPED" : ""}`,
  );
  for (const f of r.failures.slice(0, 30)) console.log(f);
  process.exitCode = r.failures.length > 0 ? 1 : 0;
}
