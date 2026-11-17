// What `tmk milestone native-g` asks of @tsl/std beyond its corpus (SPEC 3.5, D43): each bug put in has to be caught, each
// property of @tsl/alloc has to have its counterpart, and the two sides of the ergonomic comparison have to be the same program.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, runNative, wrongAnswers, type Engines, type NativeKind } from "./corpus.ts";
import { faultFailures, patchEnv } from "./faults.ts";
import { firstInOrder } from "./stable.ts";

export interface Fault {
  name: string;
  file: string;
  from: string;
  to: string;
  times?: number; // R19: how many times `from` is in the file, each replaced (test-patch.ts); 1 unless said
}

// R18 (SPEC 8.3's fault rule): ExactMap and Map share their code's text, so a bug's text there is the same in both, and a
// patch took ExactMap's alone (the first) from the maps step (D47) to R18. Each now names its class by the text around it, and
// each of the four has a counterpart in Map.
const MAP = "packages/tsl-std/ex-std-map.ts";
const DELETE_FIND =
  "    if (b === 0) return false;\n    const at = (this.hash(k) & toU32(b - 1)) >>> 0;\n    let i: u32 = this.heads.get(at);\n    let prev = NONE;\n    while (i !== NONE) {\n      const next = this.chain.get(i);\n      // SAFETY: as in find.\n      if (keySame(this.keys.get(i), k)) {\n        if (prev === NONE) this.heads.set(at, next);\n        else this.chain.set(prev, next);\n";
const EXACT_DELETE = `    if (this.loans > 0) trap(Trap.Loan);\n    const b = this.heads.length;\n${DELETE_FIND}`;
const JS_DELETE = `  delete(k: K): bool {\n    const b = this.heads.length;\n${DELETE_FIND}`;
const TOMB_SET = "        this.chain.set(i, TOMB);\n";
const TRYSET_PUSH =
  "    if (this.keys.length >= this.heads.length && !this.grow()) return false;\n    if (!this.keys.push(k)) return false;\n    if (!this.vals.push(v)) {\n";
const EXACT_TRYSET = `    if (this.loans > 0) trap(Trap.Loan);\n${TRYSET_PUSH}`;
const JS_TRYSET = `      return true;\n    }\n${TRYSET_PUSH}`;
const COMPACT =
  "      this.chain.set(i, this.heads.get(b));\n      this.heads.set(b, toU32(i));\n    }\n    return true;\n  }\n\n  private compact(used: usize): void {\n    let to: usize = 0;\n    for (let i: usize = 0; i < used; i++) {\n      if (this.chain.get(i) === TOMB) continue;\n      if (to !== i) {\n        this.keys.set(to, this.keys.get(i));\n";
const EXACT_COMPACT = `    for (let i: usize = 0; i < n; i++) {\n      const b = (this.hash(this.keys.get(i)) & mask) >>> 0;\n${COMPACT}`;
const JS_COMPACT = `      if (!compacted && this.chain.get(i) === TOMB) continue;\n      const b = (this.hash(this.keys.get(i)) & mask) >>> 0;\n${COMPACT}`;
const VALS_MOVE = "        this.vals.set(to, this.vals.get(i));\n";

export const FAULTS: Fault[] = [
  {
    name: "a loan not checked in Vec",
    file: "packages/tsl-std/ex-std-vec.ts",
    from: "if (this.loans > 0) trap(Trap.Loan);",
    to: "",
  },
  {
    name: "a stale reference reaching a closure from a Vec",
    file: "packages/tsl-std/ex-std-vec.ts",
    from: "checkLive(x);",
    to: "",
  },
  {
    name: "Vec.push ignoring out of memory",
    file: "packages/tsl-std/ex-std-vec.ts",
    from: "if (!this.v.push(x)) trap(Trap.OutOfMemory);",
    to: "this.v.push(x);",
  },
  {
    name: "removeAt moving one too few",
    file: "packages/tsl-std/ex-std-vec.ts",
    from: "for (let at = i + 1; at < n; at++)",
    to: "for (let at = i + 2; at < n; at++)",
  },
  {
    name: "a sort stopping too early",
    file: "packages/tsl-std/ex-std-vec.ts",
    from: "if (cmp(this.live(root), this.live(child)) >= 0) return;",
    to: "if (cmp(this.live(root), this.live(child)) <= 0) return;",
  },
  {
    name: "a deleted entry left visible",
    file: MAP,
    from: EXACT_DELETE + TOMB_SET,
    to: EXACT_DELETE,
  },
  {
    name: "inserting during forEach allowed",
    file: "packages/tsl-std/ex-std-map.ts",
    from: "if (this.loans > 0) trap(Trap.Loan);\n    if (this.keys.length",
    to: "if (this.keys.length",
  },
  {
    name: "trySet leaving a key behind when out of memory",
    file: MAP,
    from: `${EXACT_TRYSET}      this.keys.pop();`,
    to: EXACT_TRYSET,
  },
  {
    name: "a stale key reaching a closure from a Map",
    file: MAP,
    from: "      checkLive(k);\n      checkLive(v);\n      f(k, v);",
    to: "      checkLive(v);\n      f(k, v);",
  },
  {
    name: "compaction losing values",
    file: MAP,
    from: EXACT_COMPACT + VALS_MOVE,
    to: EXACT_COMPACT,
  },
  // R18: the four above in Map (JS's), whose text they shared and never reached
  {
    name: "a deleted entry left visible, in JS's Map",
    file: MAP,
    from: JS_DELETE + TOMB_SET,
    to: JS_DELETE,
  },
  {
    name: "trySet leaving a key behind when out of memory, in JS's Map",
    file: MAP,
    from: `${JS_TRYSET}      this.keys.pop();`,
    to: JS_TRYSET,
  },
  {
    name: "a stale key reaching a closure from forEach, in JS's Map",
    file: MAP,
    from: "      checkLive(k);\n      checkLive(v);\n      f(v, k);",
    to: "      checkLive(v);\n      f(v, k);",
  },
  {
    name: "compaction losing values, in JS's Map",
    file: MAP,
    from: JS_COMPACT + VALS_MOVE,
    to: JS_COMPACT,
  },
  {
    name: "ExactMap not trapping on a missing key",
    file: "packages/tsl-std/ex-std-map.ts",
    from: "if (i === NONE) trap(Trap.Bounds);\n    return this.vals.get(i);",
    to: "return this.vals.get(i === NONE ? 0 : i);",
  },
  {
    name: "ExactMap not trapping on a delete during forEach",
    file: "packages/tsl-std/ex-std-map.ts",
    from: "if (this.loans > 0) trap(Trap.Loan);\n    const b = this.heads.length;",
    to: "const b = this.heads.length;",
  },
  {
    name: "Map giving a value for a missing key",
    file: "packages/tsl-std/ex-std-map.ts",
    from: "if (i === NONE) return undefined;",
    to: "if (i === NONE) return this.vals.get(0);",
  },
  {
    name: "Map compacting during forEach",
    file: "packages/tsl-std/ex-std-map.ts",
    from: "const settled = this.loans === 0;",
    to: "const settled = true;",
  },
  {
    name: "Map's clear during forEach losing its place",
    file: "packages/tsl-std/ex-std-map.ts",
    from: "if (this.loans > 0) {\n      for",
    to: "if (this.loans > 1000) {\n      for",
  },
  {
    name: "a freed Str keeping its slot",
    file: "packages/tsl-std/ex-std-str.ts",
    from: "strs.remove(this);",
    to: "",
  },
  {
    name: "Str comparing backwards",
    file: "packages/tsl-std/ex-std-str.ts",
    from: "out = a[i]! < c[i]! ? -1 : 1;",
    to: "out = a[i]! < c[i]! ? 1 : -1;",
  },
  {
    name: "the least i32 overflowing in a builder",
    file: "packages/tsl-std/ex-std-str.ts",
    from: "((~x >>> 0) + 1) >>> 0",
    to: "wrapU32(-x)",
  },
  {
    name: "Slab.add not trapping when out",
    file: "packages/tsl-std/ex-std-slab.ts",
    from: "if (placed === null) trap(Trap.OutOfMemory);\n    return placed;",
    to: "return placed!;",
  },
  {
    name: "a recycled run not zeroed",
    file: "packages/tsl-std/ex-std-global.ts",
    from: "bytesAt(at, n * PAGE_BYTES).fill(0);",
    to: "",
  },
  {
    name: "the named allocator ignored",
    file: "packages/tsl-std/ex-std-global.ts",
    from: "const from = source.from;\n  return from(n);",
    to: "return registered(n);",
  },
];

export async function faultRun(
  f: Fault,
  accel: "hvf" | "tcg",
  jobs: number,
  engines: Engines,
): Promise<{ caught: number; answers: number; first: string; broken: boolean }> {
  // checked against the source first (SPEC 8.3): a patch that doesn't apply throws, failing the box, never caught
  process.env.TSL_TEST_PATCH = patchEnv({ file: f.file, from: f.from, to: f.to });
  try {
    const r = await runNative("std" as NativeKind, [accel], jobs, undefined, engines);
    faultFailures(r.failures, f.name);
    const seen = r.failures.filter((x) => x.includes(` on ${accel}:`));
    // A case that never finished, or an image that ran out of time, depends on the host's load and the level: with the
    // named allocator ignored, std_new_safety.ts's trySetFailsPartWayKeys exhausts the whole guest instead of its pool,
    // and at -O0 in a loaded gate its image ran out of time at that case, so 14 more cases "caught" it (17, against 3).
    // `answers` counts only wrong results and wrong trap codes, which don't (pipe-h).
    return {
      caught: seen.length,
      answers: wrongAnswers(seen),
      first: (firstInOrder(seen) ?? firstInOrder(r.failures) ?? "").slice(0, 200),
      // If it didn't even compile, it shows nothing.
      broken: r.failures.some((x) => /"code":"TS\d+"/.test(x)),
    };
  } finally {
    delete process.env.TSL_TEST_PATCH;
  }
}

/** Every case of @tsl/alloc's that proves a safety property, and which of @tsl/std's proves it again. */
export function safetyMapping(): { checked: number; missing: string[] } {
  const pairs: [string, string][] = [
    ["corpus/mem/alloc_vec.cases.json", "corpus/std/std_vec_safety.cases.json"],
    ["corpus/mem/alloc_slab.cases.json", "corpus/std/std_slab_safety.cases.json"],
    ["corpus/mem/gen_adversarial.cases.json", "corpus/std/std_gen_adversarial.cases.json"],
  ];
  // What @tsl/alloc says with a result, @tsl/std says with a trap, or with a try form, somewhere else.
  const moved: Record<string, string> = {
    outOfMemory: "corpus/std/std_new_safety.cases.json:tryPushHolds",
    outOfMemoryLeavesItEmpty: "corpus/std/std_new_safety.cases.json:tryPushHolds",
  };
  const missing: string[] = [];
  let checked = 0;
  type C = {
    fn: string;
    args: unknown[];
    trap?: number;
    expect?: unknown;
    diverge?: unknown;
    diverge5?: unknown;
  }[];
  const keyOf = (c: C[number]): string => `${c.fn}(${JSON.stringify(c.args)})`;
  const load = (p: string): C => JSON.parse(readFileSync(join(ROOT, p), "utf8")) as C;
  for (const [a, s] of pairs) {
    const std = new Map(load(s).map((c) => [keyOf(c), c]));
    for (const c of load(a)) {
      checked++;
      const elsewhere = moved[c.fn];
      if (elsewhere !== undefined) {
        const [file, fn] = elsewhere.split(":") as [string, string];
        if (!load(file).some((x) => x.fn === fn)) missing.push(`${c.fn} -> ${elsewhere}`);
        continue;
      }
      const hit = std.get(keyOf(c));
      if (hit === undefined) missing.push(`${a}: ${c.fn}`);
      else if (hit.trap !== c.trap) missing.push(`${c.fn}: traps ${hit.trap} against ${c.trap}`);
    }
  }
  return { checked, missing };
}

const loc = (file: string): number =>
  readFileSync(join(ROOT, file), "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("*");
    }).length;

export function ergonomicCounts(): { std: number; alloc: number; files: string[] } {
  return {
    std: loc("corpus/std/ergo_std.ts"),
    alloc: loc("corpus/std/ergo_alloc.ts") + loc("corpus/std/ergo_pages.ts"),
    files: ["corpus/std/ergo_std.ts", "corpus/std/ergo_alloc.ts", "corpus/std/ergo_pages.ts"],
  };
}

export function stdLoc(): { total: number; modules: { name: string; loc: number }[] } {
  const modules = [
    "ex-std-global.ts",
    "ex-std-vec.ts",
    "ex-std-slab.ts",
    "ex-std-map.ts",
    "ex-std-str.ts",
    "index.ts",
  ].map((name) => ({ name, loc: loc(`packages/tsl-std/${name}`) }));
  return { total: modules.reduce((n, m) => n + m.loc, 0), modules };
}

export const REQUIRED_NEGATIVES = [
  "corpus/neg/std/two_same_module.ts",
  "corpus/neg/std/two_modules_a.ts",
  "corpus/neg/std/tag_on_function.ts",
  "corpus/neg/std/tag_on_let.ts",
  "corpus/neg/std/tag_wrong_call.ts",
  "corpus/neg/std/tag_in_a_method.ts",
  "corpus/neg/std/untagged.ts",
  "corpus/neg/std/in_a_function.ts",
  "corpus/neg/std/not_a_function.ts",
  "corpus/neg/std/a_closure.ts",
  "corpus/neg/std/unlisted/not_listed.ts",
  "corpus/neg/std/kernel_core/direct.ts",
  "corpus/neg/std/kernel_core/by_path.ts",
  "corpus/neg/std/kernel_core/inner_module.ts",
  "corpus/neg/std/kernel_core/transitive.ts",
  "corpus/neg/std/kernel_core/transitive_two.ts",
  "corpus/neg/std/kernel_core/reexport.ts",
  "corpus/neg/std/plain/root_is_not_nostd.ts",
  "corpus/neg/std/plain/float_key.ts",
  "corpus/neg/std/plain/half_a_key.ts",
  "corpus/neg/std/plain/slice_kept.ts",
  "corpus/neg/std/plain/stack_in_vec.ts",
  "corpus/neg/std/plain/stack_in_map.ts",
  "corpus/neg/std/plain/stack_in_set.ts",
  "corpus/neg/std/plain/vec_returned.ts",
  "corpus/neg/std/plain/vec_stored.ts",
  "corpus/neg/std/plain/slab_not_direct.ts",
  "corpus/neg/std/plain/noalloc_push.ts",
  "corpus/neg/std/plain/module_init.ts",
  "corpus/neg/std/plain/key_hash_unlisted.ts",
  "corpus/neg/std/plain/holder_into_slab.ts",
  "corpus/neg/std/plain/holder_returned.ts",
  "corpus/neg/std/plain/holder_read_and_stored.ts",
  "corpus/neg/std/plain/holder_read_and_returned.ts",
  "corpus/neg/std/plain/holder_is_a_parameter.ts",
  "corpus/neg/std/plain/holder_in_a_loop.ts",
  "corpus/neg/std/plain/holder_static.ts",
  "corpus/neg/std/plain/callback_still_assumed.ts",
  "corpus/neg/std/manual/raw_in_vec.ts",
  "corpus/neg/std/manual/raw_in_map.ts",
];

export const missingNegatives = (): string[] =>
  REQUIRED_NEGATIVES.filter(
    (f) =>
      !existsSync(join(ROOT, f)) ||
      !/\/\/ expect: \S+ at \d+:\d+/.test(readFileSync(join(ROOT, f), "utf8")),
  );
