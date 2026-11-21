// pipe-d: the pipeline's phase 2, arrays as a TSL runtime class (D66, design/pipeline.md section 9, step 8.1): @tsl/std's
// JsArray, written in TSL with JS's rules, used by hand and by class printing, which prints a lowered program's vectors
// as it (`xs.push(v)`, `xs.get(i)`, `xs.length`) instead of the `__vec_*` runtime and loads at the lowering's offsets.
import { join } from "node:path";
import { caughtText, defaultEngines, faultCount, listPrograms, ROOT } from "../corpus.ts";
import { faultFailures, patchEnv } from "../faults.ts";
import { jobsFlag, needInstall, type MilestoneDef } from "../tmk-common.ts";
import { timedModule } from "../timing.ts";

// Box 28's programs known to run out of memory through the TSL route alone in leak and manual, by name (R4): the TSL route
// never freed a closure's environment there, where the direct route's call arena gives back what a call made. None since
// R6: tslc's per-call region holds what the export call bounds, and corpus/lower/rc/cyc_churn.ts, named here since R4,
// agrees through both routes on every case. A program that runs out fails the box.
const TSL_ROUTE_OOM: string[] = [];

/** Runs `f` with an environment variable set, and puts it back. */
async function withEnv<X>(k: string, v: string, f: () => Promise<X> | X): Promise<X> {
  const was = process.env[k];
  process.env[k] = v;
  try {
    return await f();
  } finally {
    if (was === undefined) delete process.env[k];
    else process.env[k] = was;
  }
}

/** The files the bugs of JSARRAY_FAULTS, JSSTRING_FAULTS and JSMAP_FAULTS are put into (tools/faults.ts checks each). */
export const JSARRAY_FILE = "packages/tsl-jsrt/ex-jsrt-array.ts";
export const JSSTRING_FILE = "packages/tsl-jsrt/ex-jsrt-string.ts";
export const JSMAP_FILE = "packages/tsl-jsrt/ex-jsrt-map.ts";

/** The bugs put into JsArray's source (TSL_TEST_PATCH, as native-g puts them into @tsl/std), each of which has to be caught. */
export const JSARRAY_FAULTS: { name: string; what: string; from: string; to: string }[] = [
  {
    name: "grow-last",
    what: "growth losing the last element: the copy into the new buffer one element short",
    // R18: R16 read the buffer into `old` first, so from R16 to R18 this text wasn't in the source (SPEC 8.3)
    from: "      copyBytes(next, old, kept);",
    to: "      copyBytes(next, old, kept - size);",
  },
  {
    name: "pop-empty",
    what: "pop on an empty array giving its stale first slot, not JS's undefined",
    // R18: pop's, which shift's has the same text as (the first, pop's, was the one patched)
    from: "    if (n === 0) return none;\n    const v = this.slot(n - 1).read();",
    to: "    if (n === 0) return ptrAt(this.elem, this.at(0)).read();\n    const v = this.slot(n - 1).read();",
  },
  {
    name: "hole-read",
    // Not the whole of what's past the copy: only its first element, the rest left as the allocator gave it (pipe-e: grow
    // zeroes only what it doesn't copy). A freed block's first word is the allocator's free-list link, often 0 already.
    what: "a hole read wrongly: a new buffer zeroed only in its first element past the copied ones, the rest left as the allocator gave it",
    from: "bytesAt(next + toU64(kept), bytes - kept).fill(0);",
    to: "bytesAt(next + toU64(kept), size).fill(0);",
  },
];

/** The bugs put into JsString's source (D67), each of which has to be caught. */
export const JSSTRING_FAULTS: {
  name: string;
  what: string;
  from: string;
  to: string;
  byHandOnly?: boolean;
  // Caught by the dual route alone, on these programs (pipe-h): what changes only when memory is short.
  dualOnly?: { filter: RegExp; dirs: string[] };
}[] = [
  {
    name: "pair-split",
    what: "a surrogate pair split wrongly: two high surrogates taken as one code point by for...of",
    from: "return d >= 0xdc00 && d <= 0xdfff ? 2 : 1;",
    to: "return d >= 0xd800 && d <= 0xdfff ? 2 : 1;",
  },
  {
    name: "tail-shared",
    what: "a concatenation sharing a tail it mustn't: an append into a buffer where the left side doesn't end at its tail",
    from: "if (at === this.end && at + n <= this.room()) {",
    to: "if (at + n <= this.room()) {",
  },
  {
    name: "view-bound",
    // No result changes, only what a view keeps alive, so only the class's own program sees it.
    what: "a substring view outliving its bound: sharing judged against the view's length, not what its owner keeps alive",
    from: "if (n * 4 >= room) return new JsView(n, this.start + i, this.data + bytesOf(i), this.owner);",
    to: "if (n * 4 >= len) return new JsView(n, this.start + i, this.data + bytesOf(i), this.owner);",
    byHandOnly: true,
  },
  {
    // pipe-split: a view of a view reads its owner's units from an address of its own (D70's JsView).
    name: "view-past-owner",
    what: "a view reading past its owner: a view of a view's units taken from its start in the owner counted twice",
    from: "if (n * 4 >= room) return new JsView(n, this.start + i, this.data + bytesOf(i), this.owner);",
    to: "if (n * 4 >= room) return new JsView(n, this.start + i, this.data + bytesOf(this.start + i), this.owner);",
  },
  {
    // pipe-tails: a flat string's units are its tail (D69); unit chunks are gone, and their two bugs with them.
    name: "tail-units",
    what: "a flat string's units read one unit into its tail: its address taken one unit past where its tail starts",
    from: "return tailAddr(this);",
    to: "return tailAddr(this) + 2n;",
  },
  {
    name: "hash-word",
    // pipe-h: strHash's cache, printed as `s.hashWord()` and `s.setHashWord(w)`, which the programs' maps read.
    what: "a string's hash kept wrongly: the cached hash one more than the hash strHash worked out",
    from: "return (w & ~GROWN) | (hw & GROWN);",
    to: "return ((w + 4) & ~GROWN) | (hw & GROWN);",
    dualOnly: { filter: /app_(interp|parser|visitor)/, dirs: ["corpus/lower/exc"] },
  },
];

/** The bugs put into JsMap's source (D72), each of which has to be caught by hand and by the dual route. */
export const JSMAP_FAULTS: { name: string; what: string; from: string; to: string }[] = [
  {
    name: "old-unchecked",
    what: "a lookup that looks only in the new table during a move",
    from: "    return seek(this.oheads, this.ochain, this.okeys, k, h, this.mv);",
    to: "    return seek(this.oheads, this.ochain, this.okeys, k, h, NONE);",
  },
  {
    name: "move-skips",
    what: "a move that skips an entry",
    from: "      if (ochain.get(mv) !== TOMB) {",
    to: "      if (ochain.get(mv) !== TOMB && mv !== 1) {",
  },
  {
    name: "sees-deleted",
    what: "an iteration that sees a deleted entry",
    from: "        if (this.chain.get(pos) !== TOMB) {",
    to: "        if (this.chain.get(pos) >= TOMB) {",
  },
  {
    name: "no-norm",
    what: "-0 not made +0",
    // R18: R6 read the scratch word into `s` first, so from R6 to R18 this text wasn't in the source (SPEC 8.3)
    from: "  ptrAt(f64, s).write(x + 0);",
    to: "  ptrAt(f64, s).write(x);",
  },
];

/**
 * The bugs put into string keys (strkeys, D72): JsString's sameKey and the hash its hashKey keeps. Each is caught by the
 * hand-written program's JS answers; where no result through a map can show it, only by those (`byHandOnly` says why).
 */
export const STRKEY_FAULTS: {
  name: string;
  what: string;
  file: string;
  from: string;
  to: string;
  byHandOnly?: string;
}[] = [
  {
    name: "same-identity",
    what: "a string key's sameKey comparing identity instead of units",
    file: "ex-jsrt-string.ts",
    from: "    return b.sameUnits(this.unitsAddr(), this.len(), this.hw);",
    to: "    return b === this;",
  },
  {
    name: "hash-unkeyed",
    what: "a string's hash ignoring the hash key: HalfSipHash under the default key whatever jsMapKey was given",
    file: "ex-jsrt-map.ts",
    from: "  let v0: u32 = key0;\n  let v1: u32 = key1;\n  let v2: u32 = (0x6c796765 ^ key0) >>> 0;\n  let v3: u32 = (0x74656462 ^ key1) >>> 0;",
    to: "  let v0: u32 = 0x243f6a88;\n  let v1: u32 = 0x85a308d3;\n  let v2: u32 = (0x6c796765 ^ 0x243f6a88) >>> 0;\n  let v3: u32 = (0x74656462 ^ 0x85a308d3) >>> 0;",
    byHandOnly:
      "which key a hash is under changes no result through a map, only how it floods: the hashes under three keys show it",
  },
  {
    name: "hash-units",
    what: "a string's hash ignoring all but its length and first unit",
    file: "ex-jsrt-map.ts",
    from: "  while (i + 2 <= len) {",
    to: "  while (i + 2 <= 0) {",
    byHandOnly:
      "a weak hash changes which chain a key is in, not a result: the hashes themselves show it",
  },
];

export async function definePipeD(M: MilestoneDef): Promise<void> {
  needInstall();
  const jobs = jobsFlag();
  const engines = defaultEngines();
  const { hvfAvailable } = await import("../qemu-run.ts");
  const { runNative } = timedModule("corpus", await import("../corpus.ts"));
  const report = M.report;
  const hvf = hvfAvailable();
  const skipNote = hvf.ok ? "" : `; HVF SKIPPED: ${hvf.why}`;
  const both: ("hvf" | "tcg")[] = hvf.ok ? ["hvf", "tcg"] : ["tcg"];
  const accel = hvf.ok ? ("hvf" as const) : ("tcg" as const);

  // 1. Everything before.
  M.nested(
    "1",
    "1. Every existing suite still passes: tmk milestone pipe-c from this tree, which runs pipe-b, pipe-a, maps, lang-a, opt-a and through them everything else",
    "pipe-c",
  );

  // 2. JsArray by hand, with JS's answers.
  M.unit("2", async () => {
    const failures: string[] = [];
    const rows: string[] = [];
    for (const level of ["0", "2"]) {
      await withEnv("TMK_OPT", level, async () => {
        const r = await runNative("std", both, jobs, "js_array", engines);
        rows.push(`-O${level}: ${r.summary}`);
        if (!r.ok) failures.push(...r.failures);
      });
    }
    report({
      box: "2. @tsl/jsrt's JsArray (D66) written by hand in a leak package (corpus/std/leak/js_array.ts): push through every doubling with the last element kept, pop and shift on empty giving the caller's undefined and leaving the array empty, holes that read as null, in a fresh buffer, in a buffer the allocator handed back dirty, and after the length shrank and grew again, new Array(n), and a read past the end trapping 2; natively on HVF and TCG at -O0 and -O2 and on V8 and JSC, against the values JS gives",
      ok: failures.length === 0,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 3. Vectors printed as JsArray, through both routes, on every program class printing takes.
  M.unit("3", async () => {
    const P = await import("../pipe-tests.ts");
    const { lowerFile } = await import("../../compiler/host/tslc.ts");
    const r = await P.dualRoute({
      modes: ["leak", "manual"],
      levels: [0, 2],
      accels: [accel],
      jobs,
      classes: true,
    });
    const handled = r.programs.filter((p) => p.handled);
    // Which of them have an array: printed with it, and not printed at all with arrays left out.
    const withVecs = new Set<string>();
    for (const p of handled) {
      if (p.mode !== "leak" || p.level !== 2) continue;
      try {
        lowerFile(join(ROOT, p.file), {
          memory: "leak",
          opt: 2,
          route: "tsl",
          classes: true,
          vectors: false,
        });
      } catch {
        withVecs.add(p.file);
      }
    }
    const cases = r.rows.reduce((n, x) => n + x.cases, 0);
    const agreed = r.rows.reduce((n, x) => n + x.agreed, 0);
    // R9: cases one route ran out of memory in, where the other didn't, after both had (AFTER_EXHAUSTION, with why)
    const allowed = r.rows.reduce((n, x) => n + (x.allowed ?? 0), 0);
    const failed = r.programs.filter((p) => p.why?.startsWith("FAILED") === true);
    report({
      box: "3. Class printing with arrays as JsArray (D66): every program it takes in leak and manual, at -O0 and -O2, agrees with the direct route on every case, corpus/lower/exc included; at least 12 of them have an array, and print only because arrays do",
      ok:
        r.failures.length === 0 &&
        failed.length === 0 &&
        cases > 0 &&
        cases === agreed + allowed &&
        withVecs.size >= 12 &&
        !r.hvfSkipped,
      detail: `${new Set(handled.map((p) => p.file)).size} programs, ${handled.length} builds, ${cases} cases, ${agreed} the same through both routes on ${accel}${allowed > 0 ? `, ${allowed} out of memory in one route after both ran out (AFTER_EXHAUSTION): ${[...new Set(r.allowed.map((x) => x.split(":")[0]))].join(", ")}` : ""}; ${withVecs.size} with an array: ${[...withVecs].map((f) => f.replace("corpus/lower/", "")).join(", ")}${skipNote}`,
      failures: [...r.failures, ...failed.map((p) => `${p.file} ${p.mode} -O${p.level}: ${p.why}`)],
    });
  });

  // 4. Bugs put into JsArray, each caught.
  M.unit("4", async () => {
    const P = await import("../pipe-tests.ts");
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of JSARRAY_FAULTS) {
      const patch = patchEnv({ file: JSARRAY_FILE, from: f.from, to: f.to });
      const byHand = await withEnv("TSL_TEST_PATCH", patch, () =>
        runNative("std", [accel], jobs, "js_array", engines),
      );
      const dual = await withEnv("TSL_TEST_PATCH", patch, () =>
        P.dualRoute({
          modes: ["leak", "manual"],
          levels: [2],
          accels: [accel],
          jobs,
          classes: true,
          filter: (x) => /hoisting|grow_reuse|cyc_interleave|adv_temporaries|app_retry/.test(x),
        }),
      );
      faultFailures([...byHand.failures, ...dual.failures], f.name);
      const caught: string[] = [];
      if (!byHand.ok) caught.push(`by hand ${faultCount(byHand.failures)}`);
      if (dual.failures.length > 0) caught.push(`dual route ${faultCount(dual.failures)}`);
      rows.push(`${f.what}: ${caught.length > 0 ? `caught (${caught.join(", ")})` : "MISSED"}`);
      if (caught.length === 0) failures.push(`missed: ${f.what}`);
    }
    report({
      box: `4. Each of ${JSARRAY_FAULTS.length} bugs put into JsArray's source is caught, natively at -O2: growth losing the last element, pop on empty not giving JS's undefined, and a hole read wrongly; by the hand-written program's JS answers, or by the dual route on printed programs, against the direct route's runtime`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 5. What the printing reads like, and what it no longer has.
  M.unit("5", async () => {
    const failures: string[] = [];
    const { lowerFile } = await import("../../compiler/host/tslc.ts");
    const lo = lowerFile(join(ROOT, "bench/memory/vec_lowered.ts"), {
      memory: "leak",
      opt: 2,
      route: "tsl",
      classes: true,
    });
    const text = lo.tsl?.text ?? "";
    for (const want of [
      'import { ref } from "@tsl/std";',
      'import { JsArray } from "@tsl/jsrt";',
      "new JsArray(i32, 0, false, false)",
      "new JsArray(ref<Cell | null>(), 0, false, true)",
      ".push(",
      ".get(",
      ".length",
      ".setLength(",
    ])
      if (!text.includes(want)) failures.push(`the printing has no ${want}`);
    for (const gone of ["__vec_", "load<", "store<", "elemAddr"])
      if (text.includes(gone)) failures.push(`the printing still has ${gone}`);
    report({
      box: "5. The printing reads like the TS (bench/memory/vec_lowered.ts in leak at -O2): arrays are JsArray<i32> and JsArray<Cell | null> from @tsl/jsrt (from @tsl/std before D71), made with new and their element's descriptor, and used through push, get, length and setLength, with no __vec_* call, load, store or element address left",
      ok: failures.length === 0,
      detail: `${text.split("\n").length} lines`,
      failures,
    });
  });

  // 6. pipe-e: a byte array's fill is one memset, which the global allocator's and JsArray's zeroing now are.
  M.unit("6", async () => {
    const failures: string[] = [];
    const { lowerFile } = await import("../../compiler/host/tslc.ts");
    const { printModule } = await import("../../compiler/tir/text.ts");
    const funcText = (text: string, name: string): string => {
      const at = text.indexOf(`func @${name}(`);
      return at < 0 ? "" : text.slice(at, text.indexOf("\n}", at));
    };
    const tir = (): string =>
      printModule(
        lowerFile(join(ROOT, "bench/memory/vec_lowered.ts"), {
          memory: "manual",
          opt: 2,
          route: "tsl",
          classes: true,
        }).tir!,
      );
    const on = tir();
    const off = await withEnv("TMK_TSL_OPT_OFF", "bytefill", tir);
    for (const f of ["ex-std-global.takeRun", "ex-jsrt-array.JsArray<i32>.grow"]) {
      const t = funcText(on, f);
      if (t === "") failures.push(`no ${f} in the TIR`);
      else if (!t.includes("mem.fill") || t.includes("store.i8"))
        failures.push(`${f} doesn't zero with one memset`);
    }
    if (!funcText(off, "ex-std-global.takeRun").includes("store.i8"))
      failures.push("with TMK_TSL_OPT_OFF=bytefill, takeRun's fill isn't the store a byte it was");
    // The bug: the memset starting a byte late. The hand-written program's growth into a dirty buffer shows it.
    const bug = await withEnv("TMK_TEST_TSL", "bytefill-late", () =>
      runNative("std", [accel], jobs, "js_array", engines),
    );
    if (bug.ok) failures.push("a byte fill starting a byte late wasn't caught");
    report({
      box: "6. A byte array's fill is one memset (pipe-e, D66), as @tsl/std's global allocator zeroes a reused run and JsArray's growth zeroes what it doesn't copy, in the TIR of bench/memory/vec_lowered.ts in manual at -O2 (with TMK_TSL_OPT_OFF=bytefill, the store a byte it was); a fill put a byte late is caught by corpus/std/leak/js_array.ts's growth into a dirty buffer, natively at this level",
      ok: failures.length === 0 && hvf.ok,
      detail: `the late fill: ${bug.ok ? "MISSED" : `caught (${faultCount(bug.failures)})`}${skipNote}`,
      failures,
    });
  });

  // 7. The pins pipe-e moves, each listed with why (tools/pipe-e-pins.ts), and none listed that doesn't move.
  M.unit("7", async () => {
    const failures: string[] = [];
    const { guardedRun } = await import("../guarded-run.ts");
    const { PIPE_E_MOVED } = await import("../pipe-e-pins.ts");
    const run = async (env: Record<string, string>): Promise<Record<string, string>> => {
      const r = await guardedRun(
        process.execPath,
        ["--no-warnings", join(ROOT, "tools/pre-std-hashes.ts")],
        { timeoutMs: 900_000, label: "pre-std hashes", cwd: ROOT, env: { ...process.env, ...env } },
      );
      if (!r.ok) failures.push(`pre-std hashes: ${r.why.slice(0, 200)}`);
      return r.ok ? (JSON.parse(r.stdout) as Record<string, string>) : {};
    };
    const on = await run({ TMK_TSL_OPT_OFF: "", TMK_EMIT_VECS: "1" });
    const fillOff = await run({ TMK_TSL_OPT_OFF: "bytefill", TMK_EMIT_VECS: "1" });
    const vecsOff = await run({ TMK_TSL_OPT_OFF: "", TMK_EMIT_VECS: "0" });
    const moved = new Set(
      Object.keys(on)
        .filter((k) => on[k] !== fillOff[k] || on[k] !== vecsOff[k])
        .map((k) => k.split("@")[0]!),
    );
    for (const f of moved)
      if (PIPE_E_MOVED[f] === undefined) failures.push(`${f} moves and isn't listed`);
    const inSet = new Set(Object.keys(on).map((k) => k.split("@")[0]!));
    // @tsl/std's programs are pinned at -O1 and -O2 only (opt-hashes.ts), so the -O0 set can't show them move.
    for (const f of Object.keys(PIPE_E_MOVED))
      if (inSet.has(f) && !moved.has(f)) failures.push(`${f} is listed and doesn't move`);
    report({
      box: "7. Pins: every pinned tirhash the byte fill or arrays in auto move is listed with why (tools/pipe-e-pins.ts), found by computing them with each on and off (TMK_TSL_OPT_OFF=bytefill, TMK_EMIT_VECS=0); none listed that doesn't move",
      ok: failures.length === 0 && moved.size > 0,
      detail: `${moved.size} programs move, ${Object.keys(PIPE_E_MOVED).length} listed`,
      failures,
    });
  });

  // 9. pipe-f: @tsl/jsrt's JsString by hand, with JS's answers and D42's sharing bound.
  M.unit("9", async () => {
    const failures: string[] = [];
    const rows: string[] = [];
    for (const level of ["0", "2"]) {
      await withEnv("TMK_OPT", level, async () => {
        const r = await runNative("std", both, jobs, "js_string", engines);
        rows.push(`-O${level}: ${r.summary}`);
        if (!r.ok) failures.push(...r.failures);
      });
    }
    report({
      box: "9. @tsl/jsrt's JsString (D67) written by hand in a leak package (corpus/std/leak/js_string.ts): a substring shares only from 32 units and a quarter of what it keeps alive, a view of a view judged against the first owner; concatenation appends only at its buffer's tail; for...of steps over a pair as one and a lone surrogate as one; a literal's UTF-8 is its UTF-16; equality and order by code unit; natively on HVF and TCG at -O0 and -O2",
      ok: failures.length === 0,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 10. pipe-f: strings printed as JsString, how many print only because of it, and what the printing reads like.
  M.unit("10", async () => {
    const failures: string[] = [];
    const P = await import("../pipe-tests.ts");
    const { lowerFile } = await import("../../compiler/host/tslc.ts");
    const r = await P.dualRoute({ modes: ["leak"], levels: [2], accels: [], jobs, classes: true });
    const withStrs: string[] = [];
    for (const p of r.programs.filter((x) => x.handled)) {
      try {
        lowerFile(join(ROOT, p.file), {
          memory: "leak",
          opt: 2,
          route: "tsl",
          classes: true,
          strings: false,
        });
      } catch {
        withStrs.push(p.file);
      }
    }
    const lo = lowerFile(join(ROOT, "corpus/lower/pipe/strings.ts"), {
      memory: "leak",
      opt: 2,
      route: "tsl",
      classes: true,
    });
    const text = lo.tsl?.text ?? "";
    for (const want of [
      'import { JsArray, JsFlat, jsEq, type JsString } from "@tsl/jsrt";',
      'JsFlat.of(lit("|é😀|"))',
      "JsFlat.ofUnits(",
      ".concat(",
      ".len()",
      ".unit(",
      ".sub(",
      "jsEq(",
      "export function __str_place(n: usize): JsString",
    ])
      if (!text.includes(want)) failures.push(`the printing has no ${want}`);
    for (const gone of ["text(", "charTable(", "load<", "store<", "elemAddr", "loadElem"])
      if (text.includes(gone)) failures.push(`the printing still has ${gone}`);
    if (lo.meta?.strAbs !== true)
      failures.push("the build's meta doesn't say its strings are JsString");
    // pipe-split: D36's string ABI is the layout the build publishes, two classes told apart by their ids.
    const sl = lo.meta?.strLayout;
    if (sl === undefined || sl.flat.id === sl.view.id || sl.flat.id === 0 || sl.view.id === 0)
      failures.push(`the build publishes no usable string layout: ${JSON.stringify(sl)}`);
    report({
      box: "10. Strings printed as @tsl/jsrt's JsString (D67): with classes forced in leak at -O2, at least 2 programs print only because strings do; corpus/lower/pipe/strings.ts reads like the TS, literals as JsFlat.of(lit(\"…\")) made in __init (a lone surrogate's by its units), s.concat(t), s.len(), s.unit(i), s.sub(i, n), jsEq, and a native caller's __str_place over the interface, with a string layout published (pipe-split), with no text(), charTable(), load, store or element address left",
      ok: failures.length === 0 && withStrs.length >= 2,
      detail: `${withStrs.length} print only with strings: ${withStrs.map((f) => f.replace("corpus/lower/", "")).join(", ")}; ${text.split("\n").length} lines`,
      failures,
    });
  });

  // 11. pipe-f: bugs put into JsString, each caught.
  M.unit("11", async () => {
    const P = await import("../pipe-tests.ts");
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of JSSTRING_FAULTS) {
      const patch = patchEnv({ file: JSSTRING_FILE, from: f.from, to: f.to });
      const byHand = await withEnv("TSL_TEST_PATCH", patch, () =>
        runNative("std", [accel], jobs, "js_string", engines),
      );
      const dual = await withEnv("TSL_TEST_PATCH", patch, () =>
        P.dualRoute({
          modes: ["leak", "manual"],
          levels: [2],
          accels: [accel],
          jobs,
          classes: true,
          filter: (x) => (f.dualOnly?.filter ?? /pipe\/strings/).test(x),
          ...(f.dualOnly !== undefined ? { dirs: f.dualOnly.dirs } : {}),
        }),
      );
      faultFailures([...byHand.failures, ...dual.failures], f.name);
      const caught: string[] = [];
      if (!byHand.ok) caught.push(`by hand ${faultCount(byHand.failures)}`);
      if (dual.failures.length > 0) caught.push(`dual route ${faultCount(dual.failures)}`);
      rows.push(`${f.what}: ${caught.length > 0 ? `caught (${caught.join(", ")})` : "MISSED"}`);
      const handMissed = f.dualOnly === undefined && byHand.ok;
      const dualMissed = f.byHandOnly !== true && dual.failures.length === 0;
      if (handMissed || dualMissed) failures.push(`missed: ${f.what}`);
    }
    report({
      box: `11. Each of ${JSSTRING_FAULTS.length} bugs put into JsString's source is caught natively at -O2: a surrogate pair split wrongly and a concatenation sharing a tail it mustn't, by the hand-written program and by the dual route on corpus/lower/pipe/strings.ts against the direct route's runtime; a substring view outliving its bound, which changes no result, by the hand-written program; a flat string's units read from one unit into its tail (D69), by both; a view of a view reading past its owner (pipe-split), by both; a string's cached hash wrong, by the dual route on the exceptions corpus's interpreter, parser and visitor (pipe-h)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 12. pipe-g: exceptions desugared by the printer (D68), through both routes, on the whole exceptions corpus.
  M.unit("12", async () => {
    const P = await import("../pipe-tests.ts");
    const r = await P.dualRoute({
      modes: ["leak", "manual"],
      levels: [0, 2],
      accels: [accel],
      jobs,
      classes: true,
      generated: true,
      dirs: ["corpus/lower/exc"],
    });
    const handled = r.programs.filter((p) => p.handled);
    const files = new Set(handled.map((p) => p.file));
    const gens = [...files].filter((f) => /\/gen_/.test(f)).length;
    const cases = r.rows.reduce((n, x) => n + x.cases, 0);
    const agreed = r.rows.reduce((n, x) => n + x.agreed, 0);
    const failed = r.programs.filter((p) => p.why?.startsWith("FAILED") === true);
    report({
      box: "12. Exceptions desugared by the printer (pipe-g, D68): with classes, every program of corpus/lower/exc the printer takes, the 63 generated ones with every way out through finally included, agrees with the direct route on every case in leak and manual at -O0 and -O2, with no exception listed (exc_exhaust.ts in manual's 32 pages included, since pipe-h's unit chunks)",
      ok:
        r.failures.length === 0 &&
        failed.length === 0 &&
        cases === agreed &&
        files.size >= 77 &&
        gens === 63 &&
        cases > 0 &&
        !r.hvfSkipped,
      detail: `${files.size} programs (${gens} generated), ${handled.length} builds, ${cases} cases, ${agreed} the same through both routes on ${accel}${skipNote}`,
      failures: [...r.failures, ...failed.map((p) => `${p.file} ${p.mode} -O${p.level}: ${p.why}`)],
    });
  });

  // 13. pipe-g: bugs put into the printer's desugaring, each caught.
  M.unit("13", async () => {
    const { EXC_FAULTS } = await import("../../compiler/host/emit-exc.ts");
    const failures: string[] = [];
    const rows: string[] = [];
    // Each bug through the dual route in a process of its own, two at once (T2, tools/parts.ts), read back in this order.
    const { inParts } = await import("../parts.ts");
    const runs = await inParts<
      {
        modes: ["leak"];
        levels: [2];
        accels: (typeof accel)[];
        jobs: number;
        classes: true;
        generated: true;
        dirs: string[];
        fault: string;
      },
      { failures: number; answers: number; programs: number }
    >(
      "dualRouteFault",
      (c) => c.fault,
      EXC_FAULTS.map((f) => ({
        modes: ["leak"],
        levels: [2],
        accels: [accel],
        jobs,
        classes: true,
        generated: true,
        dirs: ["corpus/lower/exc"],
        fault: f.name,
      })),
    );
    for (const [i, f] of EXC_FAULTS.entries()) {
      const r = runs[i]!;
      rows.push(
        `${f.what}: ${r.failures > 0 ? `caught (${r.answers > 0 ? r.answers : "by time alone"} in ${r.programs} programs)` : "MISSED"}`,
      );
      if (r.failures === 0) failures.push(`missed: ${f.what}`);
    }
    report({
      box: `13. Each of ${EXC_FAULTS.length} bugs put into the printer's desugaring of exceptions is caught by the dual route on corpus/lower/exc in leak at -O2: a finally run in the wrong order, a missed flag check after a call that can throw, a rethrow that loses the original value, and (pipe-h) an unknown's class sharing a field between two fields of one class it holds`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 14. pipe-g: what the printing reads like.
  M.unit("14", async () => {
    const failures: string[] = [];
    const { lowerFile } = await import("../../compiler/host/tslc.ts");
    const lo = lowerFile(join(ROOT, "corpus/lower/exc/app_retry.ts"), {
      memory: "leak",
      opt: 2,
      route: "tsl",
      classes: true,
    });
    const text = lo.tsl?.text ?? "";
    const at = text.indexOf("function withRetry(");
    const fn = at < 0 ? "" : text.slice(at, text.indexOf("\n}\n", at));
    for (const want of [
      "class Dyn {",
      "let __exc_on: bool = false;",
      "let __exc_val: Dyn | null = null;",
      "export function __exc_take(): Dyn | null {",
    ])
      if (!text.includes(want)) failures.push(`the printing has no ${want}`);
    for (const want of [
      "let last: Dyn | null = null;",
      "$finally3: {",
      "$try4: {",
      "break $try4;",
      "let t_completion: i32 = 0;",
      "if (__exc_on) {",
      "let e: Dyn | null = __exc_val;",
      "(__exc_val = e);",
      "(t_completion = 3);",
      "if ((t_completion === 1)) {",
      "continue;",
    ])
      if (!fn.includes(want)) failures.push(`withRetry's printing has no ${want}`);
    for (const gone of ['addr("__exc_on")', 'addr("__exc_val")', "load<i32>("])
      if (fn.includes(gone)) failures.push(`withRetry's printing still has ${gone}`);
    report({
      box: "14. The printing reads like the approved shape (corpus/lower/exc/app_retry.ts's withRetry in leak at -O2): the thrown value is the program's one class of unknowns, Dyn, in module state beside a bool flag; a flag check after each call that can throw; try and finally as labelled blocks, a catch taking the value in flight, a rethrow putting it back, and a completion code taking the continue and the return out through the finally; the native caller's __exc_take printed over the class; no load or address of the lowering's",
      ok: failures.length === 0 && fn !== "",
      detail: `${fn.split("\n").length} lines in withRetry, ${text.split("\n").length} in all`,
      failures,
    });
  });

  // 15. pipe-tails: variable-length tails on TSL classes (D69).
  M.unit("15", async () => {
    const { runNegative } = timedModule("corpus", await import("../corpus.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const level of ["0", "2"]) {
      await withEnv("TMK_OPT", level, async () => {
        const r = await runNative("std", both, jobs, "tails", engines);
        rows.push(`-O${level}: ${r.summary}`);
        if (!r.ok) failures.push(...r.failures);
        if (r.summary.includes("0/0")) failures.push(`-O${level}: no tail programs ran`);
      });
    }
    const neg = await runNegative(jobs, undefined, engines);
    rows.push(`negative: ${neg.summary}`);
    if (!neg.ok) failures.push(...neg.failures);
    // Each bug put into the compiler has to be caught: by corpus/std/leak/tails.ts, corpus/std/manual/tails_manual.ts and
    // the negative corpus's corpus/neg/tails/slab_add.ts and rc_make.ts.
    const bugs: { name: string; what: string; run: () => Promise<{ ok: boolean }> }[] = [
      {
        name: "tail-short",
        what: "a tail sized one element short",
        run: () => runNative("std", [accel], jobs, "tails.ts", engines),
      },
      {
        name: "tail-free-fixed",
        what: "manual freeing an object with a tail at its fixed size",
        run: () => runNative("std", [accel], jobs, "tails_manual", engines),
      },
      {
        name: "tail-moves-unchecked",
        what: "a copy by fixed size (Slab.add, Rc.make) not rejected",
        run: () => runNegative(jobs, undefined, engines),
      },
    ];
    for (const b of bugs) {
      const r = await withEnv("TMK_TEST_TSL", b.name, () => withEnv("TMK_OPT", "2", b.run));
      rows.push(`${b.what}: ${r.ok ? "MISSED" : "caught"}`);
      if (r.ok) failures.push(`missed: ${b.what}`);
    }
    report({
      box: "15. Variable-length tails on TSL classes (D69): tails of every scalar, of none and of a million, objects made back to back, in leak (corpus/std/leak/tails.ts); manual's free and reuse at different sizes (corpus/std/manual/tails_manual.ts); an Rc store counting objects with tails by size class, with nothing left after collect and a churn that fits only if slots are reused (corpus/std/rc_tails.ts): natively on HVF and TCG at -O0 and -O2, and on V8 and JSC; every forbidden use rejected with its code at its place (corpus/neg/tails, corpus/neg/tail_in_strict.ts); and a tail sized one element short, a manual free at the fixed size and a copy by fixed size not rejected, each caught",
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 16. Closed-world interface dispatch (D70).
  M.unit("16", async () => {
    const { runNegative } = timedModule("corpus", await import("../corpus.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const level of ["0", "2"]) {
      await withEnv("TMK_OPT", level, async () => {
        for (const [kind, filter] of [
          ["std", "dispatch"],
          ["mem", "pagesrc"],
        ] as const) {
          const r = await runNative(kind, both, jobs, filter, engines);
          rows.push(`-O${level} ${filter}: ${r.summary}`);
          if (!r.ok) failures.push(...r.failures);
          if (/ 0\/0 /.test(r.summary)) failures.push(`-O${level}: no ${filter} programs ran`);
        }
      });
    }
    const neg = await runNegative(jobs, undefined, engines);
    const dispatchNeg = listPrograms(join(ROOT, "corpus/neg/dispatch")).length;
    rows.push(`negative: ${neg.summary} (${dispatchNeg} of corpus/neg/dispatch)`);
    if (!neg.ok) failures.push(...neg.failures);
    if (dispatchNeg < 14) failures.push(`only ${dispatchNeg} programs in corpus/neg/dispatch`);
    // The bug put into the compiler: every arm taken for the next class's id.
    const wrong = await withEnv("TMK_TEST_TSL", "dispatch-wrong-arm", () =>
      withEnv("TMK_OPT", "2", () => runNative("std", [accel], jobs, "dispatch_shapes", engines)),
    );
    rows.push(
      `each arm taken for the next class's id: ${wrong.ok ? "MISSED" : `caught (${faultCount(wrong.failures)})`}`,
    );
    if (wrong.ok) failures.push("missed: each arm taken for the next class's id");
    // The calls themselves: compares and direct calls, never an indirect one, and a trap for an id of none.
    const { checkFile, compileTyped } = await import("../../compiler/host/tslc.ts");
    const typed = await withEnv(
      "TMK_OPT",
      "0",
      () => checkFile(join(ROOT, "corpus/std/leak/dispatch_shapes.ts")).typed,
    );
    const tir =
      typed === null ? "" : await withEnv("TMK_OPT", "0", () => compileTyped(typed).tirText);
    if (tir === "") failures.push("dispatch_shapes.ts didn't compile");
    // The page source's own call (3.8) is the runtime's, not the program's.
    const ind = tir
      .split(/\nfunc /)
      .filter((f) => !f.startsWith("@__pages_get") && f.includes("call.indirect"));
    if (ind.length > 0)
      failures.push(`dispatch_shapes.ts has an indirect call in ${ind[0]!.split("(")[0]}`);
    const arms = (tir.match(/call @(?:dispatch_shapes\.)?(?:Square|Tri|Circle)\.area /g) ?? [])
      .length;
    if (arms < 3)
      failures.push(`dispatch_shapes.ts calls each class's area directly ${arms} times`);
    rows.push(`dispatch_shapes.ts at -O0: ${arms} direct calls to an area, no indirect call`);
    report({
      box: "16. Closed-world interface dispatch (D70): a methods-only interface whose classes come from the whole program's flow, with no `implements`; three classes through arguments, fields, returns, `=`, `??`, a conditional, identity and a list (corpus/std/leak/dispatch_shapes.ts), a page source as an object with one class and with two (corpus/mem/pagesrc_*), natively on HVF and TCG at -O0 and -O2 and on V8 and JSC; a forged object whose class id is no class's trapping 18 (dispatch_forged.ts); each call a class-id compare and direct calls, never an indirect call; every set that can't be told (a type parameter, another interface, nothing reaching it, a generic class) TSL3010, and every interface or class that can't be dispatched on (generic, extending, a function parameter, a layout class, a method of other TSL types or fewer parameters, a field for a method, a method read as a value) TSL1025, at its place (corpus/neg/dispatch); and each arm taken for the next class's id, caught",
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 17. Printed TSL runs on V8 (D71): the third route, the Trap names and their rule, and JsArray in @tsl/jsrt.
  M.unit("17", async () => {
    const P = await import("../pipe-tests.ts");
    const { checkFile, lowerFile } = await import("../../compiler/host/tslc.ts");
    const { cpSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
    const { buildPath } = await import("../build-dir.ts");
    const failures: string[] = [];
    const rows: string[] = [];
    const tallyText = (t: import("../pipe-tests.ts").PrintedTally): string =>
      `${t.programs} printed builds on V8 (${t.jsc} on JSC too${t.jscSkipped ? ", JSC SKIPPED" : ""}), ${t.same} of ${t.cases} cases the same as native${
        Object.keys(t.divergences).length > 0
          ? `, the rest by allowed divergence ${Object.entries(t.divergences)
              .map(([k, n]) => `${k}: ${n}`)
              .join(", ")}`
          : ""
      }`;
    // auto's own printing in leak and manual: classes with arrays, strings by phase 1's form (AUTO_STRINGS off). Phase 1's
    // printing and class printing with strings are the third route of pipe-a's, pipe-b's and this milestone's differentials.
    const auto = await withEnv("TMK_EMIT_STRS", "0", () =>
      P.dualRoute({ modes: ["leak", "manual"], levels: [2], accels: [accel], jobs, classes: true }),
    );
    failures.push(...auto.failures);
    if (auto.printed.programs < 40)
      failures.push(`only ${auto.printed.programs} printed builds ran on V8`);
    rows.push(`auto's printing in leak and manual at -O2: ${tallyText(auto.printed)}`);
    // A host simulation returning a wrong value: an element read one too many.
    const bug = await withEnv("TMK_TEST_LOWERED_HOST", "loadElem", () =>
      P.dualRoute({
        modes: ["strict"],
        levels: [2],
        accels: [accel],
        jobs,
        filter: (f) => /pos\/(array_methods|export_glue|typed_array|string_bytes)/.test(f),
      }),
    );
    const caught = bug.failures.filter((f) => f.includes("the printed TSL on V8")).length;
    if (caught === 0)
      failures.push("loadElem's host simulation reading a wrong value wasn't caught");
    rows.push(`loadElem's host simulation giving a wrong value: caught on ${caught} cases`);
    // TSL1026 in a lowered package: trapNow's code a bare number, at its place.
    const lo = lowerFile(join(ROOT, "corpus/lower/exc/app_retry.ts"), {
      memory: "leak",
      opt: 0,
      route: "tsl",
      classes: true,
    });
    const root = lo.tsl?.file ?? "";
    const text = root === "" ? "" : readFileSync(root, "utf8");
    if (!text.includes('trapNow("narrow", Trap.BadCast)'))
      failures.push('the printing has no trapNow("narrow", Trap.BadCast)');
    if (/trapNow\([^)]*, \d+\)/.test(text)) failures.push("the printing has a bare trapNow code");
    const neg = buildPath("pipe-v8/neg");
    rmSync(neg, { recursive: true, force: true });
    cpSync(join(root, ".."), neg, { recursive: true });
    const negFile = join(neg, root.replace(/.*\//, ""));
    const at = text.indexOf('trapNow("narrow", Trap.BadCast)');
    const line = text.slice(0, at).split("\n").length;
    const col = at - text.lastIndexOf("\n", at - 1) + 'trapNow("narrow", '.length;
    writeFileSync(
      negFile,
      text.replace('trapNow("narrow", Trap.BadCast)', 'trapNow("narrow", 17)'),
    );
    const d = checkFile(negFile).diags.find((x) => x.code === "TSL1026");
    if (d === undefined || d.line !== line || d.col !== col)
      failures.push(
        `trapNow("narrow", 17): ${d === undefined ? "no TSL1026" : `TSL1026 at ${d.line}:${d.col}`}, not at ${line}:${col}`,
      );
    else rows.push(`trapNow("narrow", 17) in a printed package: TSL1026 at ${line}:${col}`);
    // Every package's and the runtime's codes are named: no `trap(<number>)` left.
    const { readdirSync } = await import("node:fs");
    for (const dir of ["packages", "compiler/rt"]) {
      const walk = (d0: string): string[] =>
        readdirSync(join(ROOT, d0), { withFileTypes: true }).flatMap((e) =>
          e.isDirectory()
            ? walk(join(d0, e.name))
            : e.name.endsWith(".ts")
              ? [join(d0, e.name)]
              : [],
        );
      for (const f of walk(dir))
        if (
          /\b(trap|trapNow|__trap)\((?:"[a-z]+", *)?\d+\)/.test(readFileSync(join(ROOT, f), "utf8"))
        )
          failures.push(`${f} has a bare trap code`);
    }
    report({
      box: "17. Printed TSL runs on V8 (D71): the differential's third route runs each printed program unchanged on V8 and JSC, @tsl/lowered's extensions simulated on the host, against native and the source on V8, every difference an allowed divergence it names; here auto's own printing in leak and manual (the third route of pipe-a's, pipe-b's and this milestone's differentials covers phase 1's printing and class printing with strings), a host simulation giving a wrong value caught, trapNow's code printed as @tsl/core's Trap and a bare one TSL1026 at its place (trap's in corpus/neg), no bare trap code left in a package or the runtime, and JsArray from @tsl/jsrt",
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 18. Maps and Sets as @tsl/jsrt's JsMap and JsSet (D72).
  M.unit("18", async () => {
    const P = await import("../pipe-tests.ts");
    const { checkFile, lowerFile } = await import("../../compiler/host/tslc.ts");
    const { cpSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
    const { buildPath } = await import("../build-dir.ts");
    const failures: string[] = [];
    const rows: string[] = [];
    // By hand, with JS's own answers (tools/js-map-oracle.ts), at -O0 and -O2, natively and on V8 and JSC.
    for (const level of ["0", "2"]) {
      const r = await withEnv("TMK_OPT", level, () =>
        runNative("std", both, jobs, "js_map", engines),
      );
      rows.push(`by hand -O${level}: ${r.summary}`);
      if (!r.ok) failures.push(...r.failures);
    }
    // Printed: both routes and the printed TSL on V8 and JSC agree, at -O0 and -O2 in leak and manual.
    const r = await P.dualRoute({
      modes: ["leak", "manual"],
      levels: [0, 2],
      accels: [accel],
      jobs,
      classes: true,
      dirs: ["corpus/lower/pipe"],
      filter: (f) => f.endsWith("/maps.ts"),
    });
    const cases = r.rows.reduce((n, x) => n + x.cases, 0);
    const agreed = r.rows.reduce((n, x) => n + x.agreed, 0);
    const printed = r.programs.filter((p) => p.why === undefined).length;
    rows.push(
      `corpus/lower/pipe/maps.ts: ${printed} builds, ${agreed} of ${cases} cases the same through both routes, ${r.printed.same} of ${r.printed.cases} on V8 and JSC`,
    );
    failures.push(...r.failures);
    if (printed !== 4 || cases === 0 || agreed !== cases || r.printed.same !== r.printed.cases)
      failures.push(
        "corpus/lower/pipe/maps.ts isn't printed, or doesn't agree, in each of 4 builds",
      );
    // Bugs put into JsMap, each caught by the hand-written program and by the dual route.
    for (const f of JSMAP_FAULTS) {
      const patch = patchEnv({ file: JSMAP_FILE, from: f.from, to: f.to });
      const byHand = await withEnv("TSL_TEST_PATCH", patch, () =>
        withEnv("TMK_OPT", "2", () => runNative("std", [accel], jobs, "js_map", engines)),
      );
      const dual = await withEnv("TSL_TEST_PATCH", patch, () =>
        withEnv("TMK_OPT", "2", () =>
          P.dualRoute({
            modes: ["leak"],
            levels: [2],
            accels: [accel],
            jobs,
            classes: true,
            dirs: ["corpus/lower/pipe"],
            filter: (x) => x.endsWith("/maps.ts"),
          }),
        ),
      );
      faultFailures([...byHand.failures, ...dual.failures], f.name);
      const caught: string[] = [];
      if (!byHand.ok) caught.push(`by hand ${faultCount(byHand.failures)}`);
      if (dual.failures.length > 0) caught.push(`dual route ${faultCount(dual.failures)}`);
      rows.push(`${f.what}: ${caught.length === 2 ? `caught (${caught.join(", ")})` : "MISSED"}`);
      if (caught.length !== 2) failures.push(`not caught both ways: ${f.what}`);
    }
    // What the printing reads like.
    const lo = lowerFile(join(ROOT, "corpus/lower/pipe/maps.ts"), {
      memory: "leak",
      opt: 2,
      route: "tsl",
      classes: true,
    });
    const root = lo.tsl?.file ?? "";
    const text = root === "" ? "" : readFileSync(root, "utf8");
    for (const want of [
      'from "@tsl/jsrt";',
      "new JsMap(u64, f64, true, false)",
      "new JsMap(ref<Node | null>(), ref<Node | null>(), true, false)",
      "new JsSet(u64, false)",
      ".cursor()",
      ".advance(",
      "jsKeyNum(",
      "jsNumKey(",
      ".delete(jsNumKey(",
      ".getOr(",
      "jsMapKey(a, b);",
      'builtin<void>("assert", ',
    ])
      if (!text.includes(want)) failures.push(`the printing has no ${want}`);
    for (const gone of ["TmkMap", "TmkCursor", "mapAdvance", "curKey", "hashF64", "cast<i32>(2))"])
      if (text.includes(gone)) failures.push(`the printing still has ${gone}`);
    // assert's code is named (TSL1026): a numeric one, bare or cast, is an error at its place in a printed package.
    const at = text.indexOf("Trap.Bounds)");
    if (at < 0) failures.push("the printing has no assert with Trap.Bounds");
    else {
      const neg = buildPath("pipe-jsmap/neg");
      for (const [bad, what] of [
        ["2)", "a bare 2"],
        ["cast<i32>(2))", "cast<i32>(2)"],
      ] as const) {
        rmSync(neg, { recursive: true, force: true });
        cpSync(join(root, ".."), neg, { recursive: true });
        const negFile = join(neg, root.replace(/.*\//, ""));
        writeFileSync(negFile, text.slice(0, at) + bad + text.slice(at + "Trap.Bounds)".length));
        const line = text.slice(0, at).split("\n").length;
        const d = checkFile(negFile).diags.find((x) => x.code === "TSL1026");
        if (d === undefined || d.line !== line)
          failures.push(
            `assert's code as ${what}: ${d === undefined ? "no TSL1026" : `TSL1026 at line ${d.line}`}, not at ${line}`,
          );
        else
          rows.push(`assert's code as ${what} in a printed package: TSL1026 at ${d.line}:${d.col}`);
      }
    }
    // @tsl/lowered's optIndex, loadAt and storeAt are gone, and nothing prints them.
    const low = readFileSync(join(ROOT, "packages/tsl-lowered/index.ts"), "utf8");
    for (const w of ["optIndex", "loadAt", "storeAt"])
      if (new RegExp(`export function ${w}\\b`).test(low))
        failures.push(`@tsl/lowered still has ${w}`);
    report({
      box: `18. Maps and Sets as @tsl/jsrt's JsMap and JsSet (D72): by hand against JS's own Map and Set (corpus/std/leak/js_map.ts, every change during an iteration before, during and after a move) at -O0 and -O2; corpus/lower/pipe/maps.ts printed with them in leak and manual at -O0 and -O2, agreeing through both routes and on V8 and JSC; each of ${JSMAP_FAULTS.length} bugs put into JsMap caught by hand and by the dual route; the printing reads like the TS; assert's code named (TSL1026); optIndex, loadAt and storeAt gone`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 19. String keys (strkeys): keyHash and keySame through dispatch, so JsString keys print as JsMap's.
  M.unit("19", async () => {
    const P = await import("../pipe-tests.ts");
    const { lowerFile } = await import("../../compiler/host/tslc.ts");
    const { readFileSync } = await import("node:fs");
    const failures: string[] = [];
    const rows: string[] = [];
    const strkeys = (f: string): boolean => f.endsWith("/pipe/strkeys.ts");
    // Printed: both routes and the printed TSL on V8 and JSC agree, at -O0 and -O2 in leak and manual.
    const r = await P.dualRoute({
      modes: ["leak", "manual"],
      levels: [0, 2],
      accels: [accel],
      jobs,
      classes: true,
      dirs: ["corpus/lower/pipe"],
      filter: strkeys,
    });
    const cases = r.rows.reduce((n, x) => n + x.cases, 0);
    const agreed = r.rows.reduce((n, x) => n + x.agreed, 0);
    const printed = r.programs.filter((p) => p.why === undefined).length;
    rows.push(
      `corpus/lower/pipe/strkeys.ts: ${printed} builds, ${agreed} of ${cases} cases the same through both routes, ${r.printed.same} of ${r.printed.cases} on V8 and JSC`,
    );
    failures.push(...r.failures);
    if (printed !== 4 || cases === 0 || agreed !== cases || r.printed.same !== r.printed.cases)
      failures.push(
        "corpus/lower/pipe/strkeys.ts isn't printed, or doesn't agree, in each of 4 builds",
      );
    // Bugs put into string keys: each caught by the hand-written program, and by the dual route where a result shows it.
    for (const f of STRKEY_FAULTS) {
      const patch = patchEnv({ file: f.file, from: f.from, to: f.to });
      const byHand = await withEnv("TSL_TEST_PATCH", patch, () =>
        withEnv("TMK_OPT", "2", () => runNative("std", [accel], jobs, "js_map", engines)),
      );
      const dual = await withEnv("TSL_TEST_PATCH", patch, () =>
        withEnv("TMK_OPT", "2", () =>
          P.dualRoute({
            modes: ["leak"],
            levels: [2],
            accels: [accel],
            jobs,
            classes: true,
            dirs: ["corpus/lower/pipe"],
            filter: strkeys,
          }),
        ),
      );
      faultFailures([...byHand.failures, ...dual.failures], f.name);
      const hand = !byHand.ok;
      const route = dual.failures.length > 0;
      const caught = hand && (route || f.byHandOnly !== undefined);
      rows.push(
        `${f.what}: ${caught ? "caught" : "MISSED"} (by hand ${hand ? byHand.failures.length : "no"}, dual route ${route ? dual.failures.length : "no"}${f.byHandOnly !== undefined ? `; by hand alone: ${f.byHandOnly}` : ""})`,
      );
      if (!caught) failures.push(`not caught: ${f.what}`);
    }
    // What the printing reads like: string keys and values as JsString in JsMap and JsSet, and both string-keyed
    // benchmarks printing through them.
    const textOf = (rel: string, memory: string): string => {
      const lo = lowerFile(join(ROOT, rel), { memory, opt: 2, route: "tsl", classes: true });
      const root = lo.tsl?.file ?? "";
      return root === "" ? "" : readFileSync(root, "utf8");
    };
    const text = textOf("corpus/lower/pipe/strkeys.ts", "leak");
    for (const want of [
      "new JsMap(ref<JsString | null>(), f64, true, false)",
      "new JsMap(ref<JsString | null>(), ref<JsString | null>(), true, false)",
      "new JsSet(ref<JsString | null>(), false)",
      ".getOr(",
      "jsMapKey(a, b);",
    ])
      if (!text.includes(want)) failures.push(`strkeys.ts's printing has no ${want}`);
    for (const gone of ["TmkMap", "TmkCursor", "mapAdvance", "curKey"])
      if (text.includes(gone)) failures.push(`strkeys.ts's printing still has ${gone}`);
    for (const rel of ["bench/maps/growth_lowered.ts", "bench/strmap/strmap_lowered.ts"]) {
      const t = textOf(rel, "leak");
      const ok = t.includes("JsMap<JsString | null, ") && !t.includes("TmkMap");
      rows.push(
        `${rel}: ${ok ? "prints its string-keyed maps as JsMap<JsString | null, …>" : "NOT PRINTED as JsMap"}`,
      );
      if (!ok) failures.push(`${rel} doesn't print its string-keyed maps as JsMap`);
    }
    report({
      box: `19. String keys (strkeys, D72): keyHash and keySame reach a JsString key's hashKey (D42's keyed HalfSipHash, kept in its hash word) and sameKey through its class id (D70); corpus/lower/pipe/strkeys.ts (non-ASCII, lone surrogates, the empty string, keys equal by content but made apart, flat and as views) printed with JsMap and JsSet over JsString in leak and manual at -O0 and -O2, agreeing through both routes and on V8 and JSC; each of ${STRKEY_FAULTS.length} bugs put into string keys caught; both string-keyed benchmarks print through JsMap`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 20. `rc` as TSL proper (D74): plain classes and `new` in an rc package, expanded onto @tsl/gc.
  M.unit("20", async () => {
    const { runNegative } = timedModule("corpus", await import("../corpus.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const level of ["0", "2"]) {
      await withEnv("TMK_OPT", level, async () => {
        const r = await runNative("rc", both, jobs, undefined, engines);
        rows.push(`-O${level}: ${r.summary}`);
        if (!r.ok) failures.push(...r.failures);
        if (r.summary.includes("0/0")) failures.push(`-O${level}: no rc programs ran`);
        // the same churn in a leak package runs out of memory natively, where rc completes
        const leak = await runNative("std", both, jobs, "churn_leak", engines);
        rows.push(`-O${level} leak churn: ${leak.summary}`);
        if (!leak.ok) failures.push(...leak.failures);
      });
    }
    const neg = await runNegative(jobs, "rc_", engines);
    rows.push(`negative: ${neg.summary}`);
    if (!neg.ok) failures.push(...neg.failures);
    if (engines.bun === null) failures.push("JSC is missing");
    report({
      box: "20. rc as TSL proper (D74): an rc package's plain classes and new expanded by tslc onto @tsl/gc's Rc (make, share, take, replace, drop, a store and a release function per class, borrows where a function is quiet), corpus/rc: adversarial borrows (a callee clearing its argument's only other holder through a global, a field and a vector element, a receiver cleared in its own method, self-assignment and swaps, temporaries, every exit from a scope), parameter properties, field initialisers, vectors of counted references, closures, tails, two modules, WeakRef clearing at count zero and never resurrecting, churn far past the page limit (which traps 14 in leak, corpus/std/leak/churn_leak.ts), one counted heap of size classes every class shares (R1b, corpus/rc/rc_shared.ts: 3,000 objects of one class dropped and 3,000 of another made in their slots in 64 pages, where R1's pool per class trapped 14, and classes of two sizes side by side), and the freeing bound as pinned step counts (32 a new, budgets 1 to 3, a million-reference vector one slot a step); the program as written on V8 agreeing with its expansion on V8 and JSC (host Rc) and natively on HVF and TCG at -O0 and -O2",
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 21. Bugs put into rc as TSL, each caught.
  M.unit("21", async () => {
    const G = timedModule("gc", await import("../gc-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of G.RC_TSL_FAULTS) {
      const r = await withEnv("TMK_OPT", "2", () => G.rcTslFaultRun(f, accel, jobs, engines));
      rows.push(`${f.name}: ${caughtText(r)}`);
      if (r.broken) failures.push(`${f.name}: it didn't compile, so it shows nothing: ${r.first}`);
      else if (r.caught === 0) failures.push(`${f.name} wasn't caught`);
    }
    report({
      box: `21. Each of ${G.RC_TSL_FAULTS.length} bugs put into rc as TSL is caught by corpus/rc, with how many cases caught it by a wrong result or trap code (R7: one that ran out of time depends on the load and is not counted): a share the expansion leaves out, a drop it leaves out, a borrow kept across a call that clears the only other holder, a freeing step doing a whole object's slots at once, (B3) unbounded freeing at an allocation with no collector linked, a weak reference resurrecting an object waiting to be freed, and (R1b) two classes of different sizes in one size class, a generation check dropped where a reference can go stale (with corpus/std/rc_gc.ts's hand-written store), R1's compiler bug put back, a function value written to raw memory as an i64 (the TIR verifier, with corpus/mem/fnval_mem.ts), and (R1d) the release dispatch calling the wrong class's release function, and the unreached-function pass removing a function the runtime calls by name`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 22. R1c: D41's cycle collector in @tsl/gc, in TSL.
  M.unit("22", async () => {
    const R = timedModule("rc", await import("../rc-tests.ts"));
    const F = timedModule("rcfuzz", await import("../rc-fuzz.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    // with the collector off, each churn case alone runs out of memory where box 20 has it complete
    const off = await withEnv("TMK_OPT", "2", () => R.cycOffEach(accel));
    rows.push(
      `collector off: ${off.trapped.length} of ${off.trapped.length + off.completed.length} churn cases trap 14 alone`,
    );
    if (off.completed.length > 0)
      failures.push(`with the collector off these completed: ${off.completed.join(", ")}`);
    // a program with no class that can be in a cycle pays nothing
    const pay = await R.paysNothing(
      [join(ROOT, "corpus/rc/rc_shapes.ts"), join(ROOT, "corpus/rc/rc_weak.ts")],
      join(ROOT, "corpus/rc/rc_list.ts"),
    );
    rows.push(...pay.rows);
    failures.push(...pay.failures);
    // random TSL rc programs with cycles, at budgets 1 to 3, as written and expanded on V8 and natively
    for (const [a, n] of [
      [accel, hvf.ok ? 60 : 10],
      ...(hvf.ok ? [["tcg", 10] as const] : []),
    ] as const) {
      const fz = await withEnv("TMK_OPT", "2", () => F.fuzzTsl(9001, n, a as "hvf" | "tcg", jobs));
      rows.push(
        `fuzz on ${a}: ${fz.ran}/${fz.seeds} programs, ${fz.cases} cases, ${fz.freed} objects freed by the collector`,
      );
      failures.push(...fz.failures.slice(0, 10));
      if (fz.ran < fz.seeds && !fz.skipped)
        failures.push(`fuzz on ${a}: only ${fz.ran} of ${fz.seeds} ran`);
    }
    // the latency port: figures, not a gate; the bound and the collecting are
    const lat = await withEnv("TMK_OPT", "2", () => R.tslCycleLatency(accel));
    if (lat.skipped !== null) failures.push(`latency: ${lat.skipped}`);
    else {
      for (const ph of lat.phases)
        rows.push(
          `latency ${ph.name}: median ${ph.medianNs.toFixed(0)} ns, p99 ${ph.p99Ns.toFixed(0)} ns, max ${(ph.maxNs / 1000).toFixed(1)} us`,
        );
      rows.push(
        `most steps in one allocation: ${lat.maxSteps.join(", ")}; freed by the collector: ${lat.freed.join(", ")}`,
      );
      if (lat.maxSteps.some((x) => x > 32))
        failures.push(`an allocation took more than RC_BUDGET steps: ${lat.maxSteps.join(", ")}`);
      if (lat.freed[1] !== lat.dropped || lat.freed[2] !== lat.dropped)
        failures.push(`the dropped ring and list weren't all collected: ${lat.freed.join(", ")}`);
    }
    report({
      box: "22. D41's cycle collector in @tsl/gc, in TSL (R1c): corpus/rc/cyc_churn.ts's eight kinds of cycle (self-loops, two-node, rings, doubly linked lists, this-capturing closures and closures in arrays capturing the array as environment classes, trees with parent pointers, rings from a global then cleared) complete under 96 pages with the collector on (box 20) and each traps 14 alone with it off; a program with no class that can be in a cycle reaches the same code with the collector on and off at -O1 and -O2, and none of the collector's; random TSL rc programs with cycles at budgets 1 to 3 agree as written, expanded on V8 (whose @tsl/gc collects) and natively, the collector freeing the same objects on both, and leave nothing but their one live object after rcCollect; the latency port's median, p99 and maximum (not a gate), with no allocation over RC_BUDGET steps and a dropped 100,000-node ring and doubly linked list all collected",
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 23. Bugs put into the cycle collector, each caught.
  M.unit("23", async () => {
    const G = timedModule("gc", await import("../gc-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of G.RC_CC_FAULTS) {
      const r = await withEnv("TMK_OPT", "2", () => G.rcTslFaultRun(f, accel, jobs, engines));
      rows.push(`${f.name}: ${caughtText(r)}`);
      if (r.broken) failures.push(`${f.name}: it didn't compile, so it shows nothing: ${r.first}`);
      else if (r.caught === 0) failures.push(`${f.name} wasn't caught`);
    }
    report({
      box: `23. Each of ${G.RC_CC_FAULTS.length} bugs put into the cycle collector (R1c) is caught by corpus/rc, with how many cases caught it by a wrong result or trap code (R7: one that ran out of time is not counted): the barrier skipped, the count not compared with the edges found, what's held not followed, a touch not asking for another pass, deref not asking for the decision, (R1d) pacing that never starts a scan (cyc_churn.ts traps 14 with the heap walk forbidden), (R1e) a scan giving up an object whose count isn't zero, a scan deciding before what it gave up has been freed (corpus/rc/cyc_giveup.ts), a scan finding edges through an object it gave up, the expansion's barrier on a vector's moves left out, and (R1f) freeing's fast path visiting an object's first slot twice`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 24. R2: lowered rc programs through the TSL route, printed in a lowered rc package that tslc's expansion counts.
  M.unit("24", async () => {
    const P = await import("../pipe-tests.ts");
    const failures: string[] = [];
    const rows: string[] = [];
    const { RC_TSL_DIR } = await import("../r2-tests.ts");
    const r = await P.dualRoute({
      modes: ["rc"],
      levels: [0, 2],
      accels: [accel],
      jobs,
      dirs: [...P.PIPE_DIRS, RC_TSL_DIR],
    });
    const handled = r.programs.filter((p) => p.handled);
    const cases = r.rows.reduce((n, x) => n + x.cases, 0);
    // R8: the one program known to run out of memory through the TSL route alone in `rc` (RC_TSL_ROUTE_OOM, with why), and
    // only by a trap 14 where the direct route gives a value: anything else fails, a new program that runs out included
    const { RC_TSL_ROUTE_OOM } = await import("../r8-tests.ts");
    const memoryOnly = r.failures.filter(
      (f) =>
        /, TSL \{"result":\{"trap":14\}/.test(f) && RC_TSL_ROUTE_OOM.includes(f.split(" ")[0]!),
    );
    const agreed = r.rows.reduce((n, x) => n + x.agreed, 0) + memoryOnly.length;
    failures.push(...r.failures.filter((f) => !memoryOnly.includes(f)));
    if (memoryOnly.length > 0)
      rows.push(
        `out of memory through the TSL route alone (RC_TSL_ROUTE_OOM): ${[...new Set(memoryOnly.map((f) => f.split(" ")[0]))].join(", ")}, ${memoryOnly.length} cases`,
      );
    const files = new Set(handled.map((p) => p.file));
    for (const want of [
      // R8: counted objects crossing an export
      "corpus/lower/pipe/rc_boundary.ts",
      "corpus/lower/pipe/boundary.ts",
      "corpus/lower/rc-tsl/r2_arrays.ts",
      "corpus/lower/rc-tsl/r2_maps.ts",
      "corpus/lower/pipe/rc_order.ts",
      "corpus/lower/pipe/maps.ts",
      // R3: closures as values, and maps iterated in a loop
      "corpus/lower/rc-tsl/r3_closures.ts",
      "corpus/lower/rc-tsl/r3_map_iter.ts",
      "corpus/lower/fallback/closure_outlives.ts",
      "corpus/lower/rc/cyc_interleave.ts",
      // R4: rooms and leaves, and a map that runs out of memory in its growth
      "corpus/lower/rc-tsl/r4_rooms.ts",
      "corpus/lower/memory/map_grow_oom.ts",
    ])
      if (!files.has(want)) failures.push(`${want} didn't take the TSL route in rc`);
    rows.push(
      `${files.size} programs, ${handled.length} builds, ${cases} cases, ${agreed} the same through both routes on ${accel}`,
    );
    rows.push(
      `printed TSL on V8: ${r.printed.programs} programs, ${r.printed.same}/${r.printed.cases} the same as native, divergences ${JSON.stringify(r.printed.divergences)}; on JSC ${r.printed.jsc}`,
    );
    for (const [d, c] of Object.entries(P.coverageOf(r.programs)))
      if (c.rc !== undefined) rows.push(`${d}: ${c.rc}`);
    // TCG at -O2 too, on what R2 added
    if (hvf.ok) {
      const t = await P.dualRoute({
        modes: ["rc"],
        levels: [2],
        accels: ["tcg"],
        jobs,
        dirs: [RC_TSL_DIR, "corpus/lower/pipe"],
        filter: (f) => /\/(r2_|r3_|r4_|rc_order)/.test(f),
        printed: false,
      });
      failures.push(...t.failures);
      const tc = t.rows.reduce((n, x) => n + x.cases, 0);
      const ta = t.rows.reduce((n, x) => n + x.agreed, 0);
      rows.push(`TCG -O2, R2's, R3's and R4's programs: ${ta}/${tc}`);
      if (tc === 0) failures.push("TCG ran none of R2's programs");
    }
    report({
      box: "24. R2: lowered rc programs build through the TSL route: class printing in a lowered rc package (statement form, references made or held in statements of their own, copies named as what they copy where nothing reassigns them, arrays and maps held in place by classes of the program's own), counted by tslc's expansion onto @tsl/gc (D74), JsArray's elements and JsMap's keys and values counted, what a map stops holding handed back and dropped (slot clearing), freed a position a step; every program the TSL route takes in rc agrees with the direct route at -O0 and -O2, the printed TSL runs on V8 and JSC and matches native but for 3.10's allowed divergences, and R2's programs (arrays and maps churned past a small memory, evaluation order) take it and agree on TCG too",
      ok:
        failures.length === 0 &&
        cases > 0 &&
        cases === agreed &&
        files.size >= 30 &&
        !r.hvfSkipped &&
        hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 25. R2: bugs put into each new transform, each caught.
  M.unit("25", async () => {
    const R = timedModule("r2", await import("../r2-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of R.R2_FAULTS) {
      const r = await R.r2FaultRun(f, accel, jobs, engines);
      rows.push(`${f.name}: ${caughtText(r)}`);
      if (r.broken)
        failures.push(`${f.name}: it only stopped compiling, so it shows nothing: ${r.first}`);
      else if (r.caught === 0) failures.push(`${f.name} wasn't caught`);
    }
    report({
      box: `25. Each of ${R.R2_FAULTS.length} bugs put into R2's transforms is caught, with how many cases caught it by a wrong result or trap code (R7: not by time): in the printer, a statement printed late, a temporary named as a variable that's reassigned, an operand read after a later one assigns it (corpus/lower/pipe/rc_order.ts); in the expansion, an array element overwritten or cut off and not dropped (the cut by corpus/rc/rc_jsarray.ts, written by hand, as printed code clears before it cuts), an array's buffer kept, nonNull taken for an owned value, a map's extra key, replaced value, deleted entry or cleared entries not dropped; in @tsl/jsrt, put saying it inserted, positions missing the old table mid-move, trim keeping the buffer (corpus/lower/rc-tsl/r2_arrays.ts, r2_maps.ts)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 26. R2: the speed rule for lowered rc programs, measured (not a gate on the numbers: on what auto does with them).
  M.unit("26", async () => {
    const { benchMemory, memoryText } = timedModule("bench", await import("../bench-memory.ts"));
    const { AUTO_RC } = await import("../../compiler/host/tslc.ts");
    const failures: string[] = [];
    const texts: string[] = [];
    let worst = 0;
    for (const level of ["1", "2"]) {
      const r = await withEnv("TMK_OPT", level, () =>
        benchMemory({ quick: true, classes: true, rc: true }),
      );
      if (r.skipped !== null) {
        failures.push(`-O${level}: ${r.skipped}`);
        continue;
      }
      failures.push(...r.errors.map((e) => `-O${level}: ${e}`));
      for (const row of r.rows) {
        if (!row.name.endsWith("TSL classes against direct") || row.ratio === null) continue;
        let ratio = row.ratio;
        // R4: with AUTO_RC on, a quick run's cell over 1.00 is measured again in full (101 calls after 20, three
        // processes, as the record's figures are) before it counts: the quiet phase runs its units side by side, and a
        // quick run of five calls under that load isn't a measurement of the rule (M5's R4 record)
        const what = /^lowered (.+) \(/.exec(row.name)?.[1];
        if (AUTO_RC && ratio > 1 && what !== undefined) {
          const full = await withEnv("TMK_OPT", level, () =>
            withEnv("TMK_BENCH_ONLY", `^${what}$`, () =>
              benchMemory({ quick: false, classes: true, rc: true }),
            ),
          );
          const again = full.rows.find(
            (x) => x.name.endsWith("TSL classes against direct") && x.ratio !== null,
          );
          texts.push(
            `-O${level} ${what}: quick ${ratio.toFixed(2)}x, in full ${again?.ratio?.toFixed(2) ?? "not measured"}x (load ${full.host.loadStart.map((x) => x.toFixed(1)).join(" ")})`,
          );
          ratio = again?.ratio ?? ratio;
        }
        worst = Math.max(worst, ratio);
      }
      texts.push(`-O${level}:\n${memoryText(r)}`);
    }
    // auto takes the TSL route in rc only where every benchmark met the rule at both levels (decisions.md's rule)
    if (AUTO_RC && worst > 1)
      failures.push(`AUTO_RC is on, and a benchmark is ${worst.toFixed(2)}x the direct route`);
    report({
      box: "26. R2's speed rule, measured: each lowered rc benchmark the TSL route takes (list, churn, cycles since R3's closures, arrays, acyclic, number-keyed and object-keyed maps) through both routes at -O1 and -O2, the TSL route against the direct one; AUTO_RC is on only if none is slower, which it is since R4 (the figures are a quick run's, M5's R2, R3 and R4 records have the full ones)",
      ok: failures.length === 0 && hvf.ok,
      detail: `AUTO_RC ${AUTO_RC ? "on" : "off"}; ${texts.join("\n")}${skipNote}`,
      failures,
    });
  });

  // 27. R3: bugs put into each new transform, each caught (closures, arrays, the store order, @tsl/jsrt's bookkeeping).
  M.unit("27", async () => {
    const R = timedModule("r2", await import("../r2-tests.ts"));
    const { R3_FAULTS } = await import("../r3-tests.ts");
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of R3_FAULTS) {
      const r = await R.r2FaultRun(f, accel, jobs, engines);
      rows.push(`${f.name}: ${caughtText(r)}`);
      if (r.broken)
        failures.push(`${f.name}: it only stopped compiling, so it shows nothing: ${r.first}`);
      else if (r.caught === 0) failures.push(`${f.name} wasn't caught`);
    }
    report({
      box: `27. Each of ${R3_FAULTS.length} bugs put into R3's transforms is caught, with how many cases caught it by a wrong result or trap code (R7: not by time): closures as values in the printer (a kind's call taking the next kind's method, two captures of one closure in one field), a splice's new room, the lowering's store-order fix (strict and rc, against V8), @tsl/jsrt's bookkeeping freed in rc (cursors, generations, old tables), and arrays' rooms in the counted heap (tools/r3-tests.ts)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 28. R3: closures as values in leak and manual, forced (TMK_EMIT_CLOS=1), not auto's choice: where they agree, and where not.
  M.unit("28", async () => {
    const P = await import("../pipe-tests.ts");
    const failures: string[] = [];
    const rows: string[] = [];
    const was = process.env.TMK_EMIT_CLOS;
    process.env.TMK_EMIT_CLOS = "1";
    try {
      const r = await P.dualRoute({
        modes: ["leak", "manual"],
        levels: [2],
        accels: [accel],
        jobs,
        classes: true,
      });
      const cases = r.rows.reduce((n, x) => n + x.cases, 0);
      const agreed = r.rows.reduce((n, x) => n + x.agreed, 0);
      // The one known difference: the TSL route frees nothing in leak and manual, where the direct route's call arena does,
      // so a program that churns past its page limit runs out through the TSL route alone. Only the programs named in
      // TSL_ROUTE_OOM are known to (R4: R3 accepted any file in corpus/lower/rc/); anything else fails, a new program that
      // runs out included.
      const memoryOnly = r.failures.filter(
        (f) => /, TSL \{"result":\{"trap":14\}/.test(f) && TSL_ROUTE_OOM.includes(f.split(" ")[0]!),
      );
      const files = new Set(memoryOnly.map((f) => f.split(" ")[0]));
      rows.push(
        `${cases} cases, ${agreed} the same through both routes at -O2; out of memory through the TSL route alone: ${[...files].join(", ") || "none"}`,
      );
      rows.push(
        `printed TSL on V8: ${r.printed.same}/${r.printed.cases}, divergences ${JSON.stringify(r.printed.divergences)}`,
      );
      failures.push(...r.failures.filter((f) => !memoryOnly.includes(f)));
    } finally {
      if (was === undefined) delete process.env.TMK_EMIT_CLOS;
      else process.env.TMK_EMIT_CLOS = was;
    }
    report({
      box: "28. R3: closures as values printed in leak and manual when forced (TMK_EMIT_CLOS=1): every program agrees with the direct route at -O2, none running out of memory through the TSL route alone (R6: tslc's per-call region keeps corpus/lower/rc/cyc_churn.ts, named as the one that did since R4, within its page limit), and the printed TSL runs on V8",
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 29. R4: freeing and rooms made cheaper in @tsl/gc, and JsMap's growth safe to run out of memory in.
  M.unit("29", async () => {
    const P = await import("../pipe-tests.ts");
    const R = timedModule("r2", await import("../r2-tests.ts"));
    const { R4_FAULTS } = await import("../r4-tests.ts");
    const failures: string[] = [];
    const rows: string[] = [];
    // A module-level map that runs out of memory in its growth, then used: the same through both routes, in every mode
    // its map prints as JsMap (classes forced in leak and manual; rc's TSL route), at -O0 and -O2.
    const r = await P.dualRoute({
      modes: ["leak", "manual", "rc"],
      levels: [0, 2],
      accels: [accel],
      jobs,
      classes: true,
      dirs: ["corpus/lower/memory"],
      filter: (f) => f.endsWith("/map_grow_oom.ts"),
    });
    const cases = r.rows.reduce((n, x) => n + x.cases, 0);
    const agreed = r.rows.reduce((n, x) => n + x.agreed, 0);
    const printed = r.programs.filter((p) => p.why === undefined).length;
    rows.push(
      `corpus/lower/memory/map_grow_oom.ts: ${printed} builds printed, ${agreed} of ${cases} cases the same through both routes`,
    );
    failures.push(...r.failures);
    if (printed !== 6 || cases === 0 || agreed !== cases)
      failures.push(
        "corpus/lower/memory/map_grow_oom.ts isn't printed, or doesn't agree, in each of 6 builds",
      );
    for (const f of R4_FAULTS) {
      const x = await R.r2FaultRun(f, accel, jobs, engines);
      rows.push(`${f.name}: ${caughtText(x)}`);
      if (x.broken)
        failures.push(`${f.name}: it only stopped compiling, so it shows nothing: ${x.first}`);
      else if (x.caught === 0) failures.push(`${f.name} wasn't caught`);
    }
    report({
      box: `29. R4: a module-level map that runs out of memory while it grows is intact for the next case through both routes (corpus/lower/memory/map_grow_oom.ts in leak, manual and rc at -O0 and -O2: JsMap makes the new table before it moves anything), and each of ${R4_FAULTS.length} bugs put into R4's transforms is caught, with how many cases caught it by a wrong result or trap code (R7: not by time): leaves given back at once by freeing (the expansion's choice, and the step it spends, D39's bound), rooms zeroed only past what growth copies, and JsMap's growth order (tools/r4-tests.ts)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 30. R5: exported functions taking or giving objects through the TSL route, in D36's listed layout.
  M.unit("30", async () => {
    const P = await import("../pipe-tests.ts");
    const R = timedModule("r2", await import("../r2-tests.ts"));
    const R5 = await import("../r5-tests.ts");
    const { lowerFile } = await import("../lowering.ts");
    const failures: string[] = [];
    const rows: string[] = [];
    // Each program whose exports take and give objects and arrays: printed with classes in leak and manual at -O0 and -O2,
    // every case the same through both routes natively, and the printed TSL on V8 and JSC with arguments placed as a
    // native caller places them (the classes made by their TSL names, the arrays by their placing exports).
    const r = await P.dualRoute({
      modes: ["leak", "manual"],
      levels: [0, 2],
      accels: [accel],
      jobs,
      classes: true,
      dirs: ["corpus/lower/pipe", "corpus/lower/memory", "corpus/lower/pos", "bench/memory"],
      filter: (f) => R5.R5_PROGRAMS.some((p) => f.endsWith(p)),
      v8: () => true,
    });
    const cases = r.rows.reduce((n, x) => n + x.cases, 0);
    const agreed = r.rows.reduce((n, x) => n + x.agreed, 0);
    const printed = r.programs.filter((p) => p.handled).length;
    rows.push(
      `${printed} builds printed, ${agreed} of ${cases} cases the same through both routes; printed TSL on V8 ${r.printed.same}/${r.printed.cases}, on JSC ${r.printed.jsc} builds`,
    );
    failures.push(...r.failures);
    const want = R5.R5_PROGRAMS.length * 4;
    if (printed < want || cases === 0 || agreed !== cases)
      failures.push(`R5's programs aren't each printed and the same in ${want} builds`);
    // The layout published: D36's own offsets (meta.heap), with the TSL names a host caller needs, and each array's placer.
    const lo = lowerFile(`${ROOT}/corpus/lower/pipe/boundary.ts`, {
      memory: "leak",
      opt: 2,
      route: "tsl",
      classes: true,
    });
    const meta = lo.meta as {
      tslClasses?: Record<string, unknown>;
      heap: Record<string, { k: string; place?: string }>;
    };
    const nCls = Object.keys(meta.tslClasses ?? {}).length;
    const nVec = Object.values(meta.heap).filter(
      (h) => h.k === "vec" && h.place !== undefined,
    ).length;
    rows.push(`boundary.ts publishes ${nCls} classes and ${nVec} array placers`);
    if (nCls < 4 || nVec < 2)
      failures.push("boundary.ts's classes and array placers aren't all published");
    // rc's counted handles at the boundary: built since R8 (box 33), and with R8's printing off (TMK_R8_OFF=boundary), as
    // it was here, the printer says it isn't, by name, and the direct route builds it.
    const r8Was = process.env.TMK_R8_OFF;
    process.env.TMK_R8_OFF = "boundary";
    try {
      lowerFile(`${ROOT}/corpus/lower/pipe/boundary.ts`, {
        memory: "rc",
        opt: 2,
        route: "tsl",
        classes: true,
      });
      failures.push(
        "boundary.ts printed in rc with R8's printing off, where counted handles at the boundary aren't built",
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("a counted object's handle at the boundary isn't built (D36, R5)"))
        failures.push(`boundary.ts in rc stopped for another reason: ${msg.slice(0, 200)}`);
    } finally {
      if (r8Was === undefined) delete process.env.TMK_R8_OFF;
      else process.env.TMK_R8_OFF = r8Was;
    }
    try {
      const b = lowerFile(`${ROOT}/corpus/lower/pipe/boundary.ts`, {
        memory: "rc",
        opt: 2,
        route: "tsl",
        classes: true,
      });
      if (!/__rc_release_\d+/.test(b.tsl?.text ?? ""))
        failures.push("boundary.ts printed in rc with no release export (R8)");
    } catch (e) {
      failures.push(`boundary.ts in rc not printed (R8): ${String(e).slice(0, 200)}`);
    }
    // The bugs: tslc's check refuses a layout that moved; the dual route catches the rest.
    const c = await R5.checkFaultRun();
    rows.push(
      `${R5.R5_CHECK_FAULT.name}: ${c.refused} of ${c.builds} builds refused by tslc's layout check`,
    );
    if (c.refused !== c.builds) failures.push(`${R5.R5_CHECK_FAULT.name} not refused: ${c.first}`);
    for (const f of R5.R5_FAULTS) {
      const x = await R.r2FaultRun(f, accel, jobs, engines);
      rows.push(`${f.name}: ${caughtText(x)}`);
      if (x.broken)
        failures.push(`${f.name}: it only stopped compiling, so it shows nothing: ${x.first}`);
      else if (x.caught === 0) failures.push(`${f.name} wasn't caught`);
    }
    report({
      box: `30. R5: exported functions taking or giving objects through the TSL route (D36): each class that crosses printed in D36's listed layout, TSL's own since R6 (fields in D36's order, nothing added, a bool a byte, D36's size), and checked by tslc, each array placed by an export of the module's own whose header is D36's; R5's programs agree with the direct route in leak and manual at -O0 and -O2 and run on V8 and JSC with arguments placed as a native caller places them; rc refused by name with R8's printing off (TMK_R8_OFF=boundary), and printed with it on (box 33); and each of 4 bugs caught, with how many cases or builds caught it by a wrong result, trap code or refusal (R7: not by time): a layout that moved (two fields printed the other way round, by tslc's check), the same unchecked, an array placed a hole long, and the live return before the dead one dropped with it (tools/r5-tests.ts)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 31. R6: D36 in TSL's own layout, a read's checks printed once, and tslc's per-call region in leak and manual.
  M.unit("31", async () => {
    const P = await import("../pipe-tests.ts");
    const R = timedModule("r2", await import("../r2-tests.ts"));
    const R6 = await import("../r6-tests.ts");
    const { lowerFile } = await import("../lowering.ts");
    const failures: string[] = [];
    const rows: string[] = [];
    // The layout: d36_layout.ts natively in every mode against V8 (the native caller writing and reading at the published
    // offsets: bools side by side, an object of bools, optional scalars, arrays of booleans and of 12-byte objects), and
    // the bug in it caught.
    const lay = await R6.layoutRun(accel, false);
    rows.push(
      `d36_layout.ts: ${lay.agreed}/${lay.cases} cases the same as V8 in strict, leak, manual and rc`,
    );
    if (lay.cases === 0 || lay.agreed !== lay.cases) failures.push(...lay.failures.slice(0, 10));
    const layBug = await R6.layoutRun(accel, true);
    rows.push(`${R6.R6_LAYOUT_FAULT.name}: ${layBug.cases - layBug.agreed}`);
    if (layBug.cases - layBug.agreed === 0)
      failures.push(`${R6.R6_LAYOUT_FAULT.name} wasn't caught`);
    // The published table is TSL's: boundary.ts's class of two bools and an f64 has them at 0, 1 and 8, and its size 32.
    const lo = lowerFile(`${ROOT}/corpus/lower/pipe/boundary.ts`, {
      memory: "leak",
      opt: 2,
      route: "direct",
    });
    const heap = (
      lo.meta as {
        heap: Record<
          string,
          { k: string; size?: number; fields?: { name: string; off: number }[] }
        >;
      }
    ).heap;
    const laid = Object.values(heap)
      .filter((h) => h.k === "obj")
      .map((h) => `${h.size}:${h.fields!.map((f) => `${f.name}@${f.off}`).join(",")}`);
    rows.push(`boundary.ts publishes ${laid.join("; ")}`);
    if (!laid.includes("32:a@0,b@1,n@8,c@16,x@24"))
      failures.push(`boundary.ts's bools aren't where TSL lays them out: ${laid.join("; ")}`);
    // A read's checks: the boundary benchmark's printing has no bounds assert before a JsArray read, and no nonNull(…)! .
    const printed = lowerFile(`${ROOT}/bench/memory/boundary_lowered.ts`, {
      memory: "leak",
      opt: 2,
      route: "tsl",
      classes: true,
    }).tsl?.text;
    const asserts = (printed?.match(/"assert", \([^()]*< [^()]*\.length\), Trap\.Bounds\)/g) ?? [])
      .length;
    const twice = (printed?.match(/nonNull\(/g) ?? []).length;
    rows.push(
      `boundary_lowered.ts printed: ${asserts} bounds asserts beside get, ${twice} nonNull calls`,
    );
    if (printed === undefined || asserts > 0 || twice > 0)
      failures.push("the boundary benchmark's reads aren't printed with one check of each");
    // R6's programs through both routes (closures forced: region.ts keeps one), region.ts against V8 too.
    const r = await withEnv("TMK_EMIT_CLOS", "1", () =>
      P.dualRoute({
        modes: ["leak", "manual"],
        levels: [0, 2],
        accels: [accel],
        jobs,
        classes: true,
        dirs: ["corpus/lower/pipe", "corpus/lower/pos"],
        filter: (f) => R6.R6_PROGRAMS.some((p) => f.endsWith(p)),
        v8: (f) => f.endsWith("region.ts"),
      }),
    );
    const cases = r.rows.reduce((n, x) => n + x.cases, 0);
    const agreed = r.rows.reduce((n, x) => n + x.agreed, 0);
    const handled = r.programs.filter((p) => p.handled).length;
    rows.push(
      `${handled} builds printed, ${agreed} of ${cases} cases the same through both routes; printed TSL on V8 ${r.printed.same}/${r.printed.cases}`,
    );
    failures.push(...r.failures);
    if (handled < R6.R6_PROGRAMS.length * 4 || cases === 0 || agreed !== cases)
      failures.push(
        `R6's programs aren't each printed and the same in ${R6.R6_PROGRAMS.length * 4} builds`,
      );
    // tslc placed what cyc_churn.ts and region.ts churn in the region, and kept what module state holds in the heap.
    for (const f of ["corpus/lower/rc/cyc_churn.ts", "corpus/lower/pipe/region.ts"]) {
      const o = await withEnv("TMK_EMIT_CLOS", "1", () =>
        lowerFile(`${ROOT}/${f}`, { memory: "leak", opt: 2, route: "tsl", classes: true }),
      );
      const g = o.tsl?.region;
      rows.push(`${f}: ${g?.sites ?? 0} new sites in the region, ${g?.heapSites ?? 0} in the heap`);
      if (g === undefined || g.sites === 0) failures.push(`${f}: nothing placed in the region`);
      if (g !== undefined && g.long.RingNode === undefined && f.includes("cyc_churn"))
        failures.push("cyc_churn.ts's RingNode, kept in module state, isn't kept in the heap");
    }
    // The region given back at each export's return, with no caller's reset between calls; and the bug that keeps it.
    const k = await R6.keptRun(accel);
    if (!k.skipped) {
      rows.push(`no arena reset: ${k.rows.join(", ")}`);
      if (!k.tslOk) failures.push("the TSL route didn't give its region back at each return");
      if (!k.directOom)
        failures.push(
          "the direct route's call arena didn't run out with no caller's reset: the test shows nothing",
        );
      const kb = await R6.keptRun(accel, R6.R6_KEPT_FAULT.name);
      rows.push(`${R6.R6_KEPT_FAULT.name}: ${kb.tslOom ? "caught, out of memory" : "not caught"}`);
      if (!kb.tslOom) failures.push(`${R6.R6_KEPT_FAULT.name} wasn't caught`);
    }
    for (const f of R6.R6_FAULTS) {
      const x = await withEnv("TMK_EMIT_CLOS", "1", () => R.r2FaultRun(f, accel, jobs, engines));
      rows.push(`${f.name}: ${caughtText(x)}`);
      if (x.broken)
        failures.push(`${f.name}: it only stopped compiling, so it shows nothing: ${x.first}`);
      else if (x.caught === 0) failures.push(`${f.name} wasn't caught`);
    }
    report({
      box: `31. R6 (D36, D62's rulings): D36 is TSL's own layout (a bool a byte, an optional scalar a bool flag then its value, an object's size its alignment's multiple), through the direct route, the native caller and the printed classes alike; a vector read's bounds check printed as JsArray's get alone and the source's ! as TSL's own checked !; and tslc's per-call region in leak and manual, a heap new no export call outlives placed in the call arena, given back at each export's return; R6's programs agree through both routes at -O0 and -O2 and with V8, and each of ${R6.R6_FAULTS.length + 2} bugs is caught, with how many cases caught it by a wrong result or trap code (R7: not by time): a bool stored as a word, a folded check given an index get can't refuse, a module-state class in the region, a region array's buffers from the heap, and an export that keeps its region (tools/r6-tests.ts)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 32. R7: -O1's loop bounds proof and the null check left to a load (all TSL), optional scalar and typed-array fields,
  // and maps and sets crossing an export, each with its bug caught.
  M.unit("32", async () => {
    const R7 = timedModule("r7", await import("../r7-tests.ts"));
    const R = timedModule("r2", await import("../r2-tests.ts"));
    const P = timedModule("pipe", await import("../pipe-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    // The loop bounds proof on hand-made TIR: the shapes it takes and those it mustn't, and its bug (no QEMU).
    const lb = R7.loopBoundsCases();
    rows.push(
      `loop bounds: ${lb.filter((x) => x.ok).length}/${lb.length} shapes as they should be`,
    );
    failures.push(...lb.filter((x) => !x.ok).map((x) => `${x.what}: ${x.detail.split("\n")[0]}`));
    // The null check left to the load: trap 6 inside and outside a case at every level, and its bug.
    const nc = await R7.nullChecks(accel);
    rows.push(`null checks: ${nc.filter((x) => x.ok).length}/${nc.length}`);
    failures.push(...nc.filter((x) => !x.ok).map((x) => `${x.what}: ${x.detail}`));
    // R7's programs through both routes at -O0, -O1 and -O2, and the printed TSL on V8 and JSC.
    const r = await P.dualRoute({
      modes: ["leak", "manual"],
      levels: [0, 1 as 0, 2],
      accels: [accel],
      jobs,
      classes: true,
      dirs: [...new Set(R7.R7_PROGRAMS.map((f) => f.replace(/\/[^/]*$/, "")))],
      filter: (f) => R7.R7_PROGRAMS.some((p) => f.endsWith(p)),
    });
    const cases = r.rows.reduce((n, x) => n + x.cases, 0);
    const agreed = r.rows.reduce((n, x) => n + x.agreed, 0);
    const handled = r.programs.filter((p) => p.handled).length;
    rows.push(
      `${handled} builds printed, ${agreed} of ${cases} cases the same through both routes; printed TSL on V8 ${r.printed.same}/${r.printed.cases}, JSC ${r.printed.jsc} programs`,
    );
    failures.push(...r.failures);
    if (handled < R7.R7_PROGRAMS.length * 6 || cases === 0 || agreed !== cases)
      failures.push(
        `R7's programs aren't each printed and the same in ${R7.R7_PROGRAMS.length * 6} builds`,
      );
    for (const f of R7.R7_FAULTS) {
      const x = await R.r2FaultRun(f, accel, jobs, engines);
      rows.push(`${f.name}: ${caughtText(x)}`);
      if (x.broken)
        failures.push(`${f.name}: it only stopped compiling, so it shows nothing: ${x.first}`);
      else if (x.caught === 0) failures.push(`${f.name} wasn't caught`);
    }
    report({
      box: `32. R7 (D36, D44, D62, D72, D73): -O1 removes a bounds check its loop's own test proves (loopbounds.ts, every TSL module), and -O1 and -O2 leave an explicit null check to the load after it where a fault there is trap 6 everywhere natively (the backend's table of such loads, which __rt_exception reads); an optional scalar field prints as a bool flag field and a value field, a typed-array field as a runtime class of its pointer and length held in place, and a Map or Set crossing an export as JsMap or JsSet with D36's surface exports; R7's programs agree through both routes at -O0, -O1 and -O2 and run on V8 and JSC, and each of ${R7.R7_FAULTS.length + 2} bugs is caught, with how many cases caught it by a wrong result or trap code: a loop test <= taken for <, a store passed over before the faulting load, an optional's flag always set, a typed array's two words swapped, and JsMap's tables swapped in its published layout (tools/r7-tests.ts)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 33. R8: counted objects crossing an export in `rc`, through the TSL route, with a native caller's counts printed.
  M.unit("33", async () => {
    const R8 = timedModule("r8", await import("../r8-tests.ts"));
    const P = timedModule("pipe", await import("../pipe-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    // R8's programs through both routes in `rc` at -O0, -O1 and -O2, and the printed TSL on V8 and JSC; rc_boundary.ts and
    // boundary.ts in leak and manual too, at -O2
    const r = await P.dualRoute({
      modes: ["rc"],
      levels: [0, 1 as 0, 2],
      accels: [accel],
      jobs,
      classes: true,
      dirs: [...new Set(R8.R8_PROGRAMS.map((f) => f.replace(/\/[^/]*$/, "")))],
      filter: (f) => R8.R8_PROGRAMS.some((p) => f.endsWith(p)),
    });
    // region.ts runs out of memory through the TSL route alone, after a trap left what its frames held (RC_TSL_ROUTE_OOM)
    const memoryOnly = r.failures.filter(
      (f) =>
        /, TSL \{"result":\{"trap":14\}/.test(f) && R8.RC_TSL_ROUTE_OOM.includes(f.split(" ")[0]!),
    );
    failures.push(...r.failures.filter((f) => !memoryOnly.includes(f)));
    const cases = r.rows.reduce((n, x) => n + x.cases, 0);
    const agreed = r.rows.reduce((n, x) => n + x.agreed, 0);
    const handled = r.programs.filter((p) => p.handled);
    const files = new Set(handled.map((p) => p.file));
    for (const p of R8.R8_PROGRAMS)
      if (handled.filter((x) => x.file === p).length !== 3)
        failures.push(`${p} isn't printed in rc at -O0, -O1 and -O2`);
    if (cases === 0 || agreed + memoryOnly.length !== cases)
      failures.push(`${cases - agreed} of ${cases} cases differ through the two routes`);
    rows.push(
      `${files.size} programs, ${handled.length} builds in rc, ${agreed} of ${cases} cases the same through both routes (${memoryOnly.length} out of memory through the TSL route alone, in ${R8.RC_TSL_ROUTE_OOM.join(", ")}); printed TSL on V8 ${r.printed.same}/${r.printed.cases}, divergences ${JSON.stringify(r.printed.divergences)}, JSC ${r.printed.jsc} programs`,
    );
    const lm = await P.dualRoute({
      modes: ["leak", "manual"],
      levels: [2],
      accels: [accel],
      jobs,
      classes: true,
      dirs: ["corpus/lower/pipe"],
      filter: (f) => /\/(rc_boundary|boundary)\.ts$/.test(f),
      printed: false,
    });
    failures.push(...lm.failures);
    rows.push(
      `leak and manual -O2: ${lm.rows.reduce((n, x) => n + x.agreed, 0)}/${lm.rows.reduce((n, x) => n + x.cases, 0)}`,
    );
    // The ownership a native caller and the printed TSL agree on: what's live after each case, each result's count, D39
    const own = await R8.ownershipChecks(accel, [0, 1, 2]);
    rows.push(...own.rows);
    failures.push(...own.failures);
    for (const f of R8.R8_FAULTS) {
      const x = await R8.r8FaultRun(f, accel, jobs);
      rows.push(`${f.name}: ${caughtText(x)}`);
      if (x.broken)
        failures.push(`${f.name}: it only stopped compiling, so it shows nothing: ${x.first}`);
      else if (x.caught === 0) failures.push(`${f.name} wasn't caught`);
    }
    report({
      box: `33. R8 (D36, D39, D74): counted objects cross an export in rc through the TSL route, at their addresses (a reference tslc's rc expansion counts carries no generation), with a native caller's counts printed as plain TSL: __rc_place_<id> (a new object, one count, the caller's), __rc_retain_<id> (gives back what it's given, so the expansion shares it), __rc_release_<id> (@tsl.moves: the count taken over and dropped) and __rc_collect; R8's programs agree through both routes at -O0, -O1 and -O2 and run on V8 and JSC; after each case only what module state keeps is live, each result's count is the caller's, a released list is freed a budget of steps at a time (D39); and each of ${R8.R8_FAULTS.length} bugs is caught, with how many cases caught it by a wrong result or count: retain giving back a borrow, release dropping twice, a placed object given at a count of none (tools/r8-tests.ts)`,
      ok: failures.length === 0 && hvf.ok && !own.skipped,
      detail: `${rows.join("; ")}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 34. R9: typed arrays made in functions, module state that's a typed array, arrays of booleans and of nothing.
  M.unit("34", async () => {
    const R9 = timedModule("r9", await import("../r9-tests.ts"));
    const R = timedModule("r2", await import("../r2-tests.ts"));
    const P = timedModule("pipe", await import("../pipe-tests.ts"));
    const { readFileSync } = await import("node:fs");
    const { AUTO_R9, lowerFile } = await import("../../compiler/host/tslc.ts");
    const failures: string[] = [];
    const rows: string[] = [];
    // R9's programs through both routes in leak and manual at -O0, -O1 and -O2, and the printed TSL on V8 and JSC.
    const r = await P.dualRoute({
      modes: ["leak", "manual"],
      levels: [0, 1 as 0, 2],
      accels: [accel],
      jobs,
      classes: true,
      dirs: [...new Set(R9.R9_PROGRAMS.map((f) => f.replace(/\/[^/]*$/, "")))],
      filter: (f) => R9.R9_PROGRAMS.some((p) => f.endsWith(p)),
    });
    const cases = r.rows.reduce((n, x) => n + x.cases, 0);
    const agreed = r.rows.reduce((n, x) => n + x.agreed, 0);
    const allowed = r.rows.reduce((n, x) => n + (x.allowed ?? 0), 0);
    const handled = r.programs.filter((p) => p.handled);
    failures.push(...r.failures);
    for (const p of R9.R9_PROGRAMS)
      if (handled.filter((x) => x.file === p).length !== 6)
        failures.push(`${p} isn't printed in leak and manual at -O0, -O1 and -O2`);
    if (cases === 0 || agreed + allowed !== cases)
      failures.push(`${cases - agreed - allowed} of ${cases} cases differ through the two routes`);
    rows.push(
      `${new Set(handled.map((p) => p.file)).size} programs, ${handled.length} builds in leak and manual, ${agreed} of ${cases} cases the same through both routes (${allowed} out of memory in one route after both ran out, AFTER_EXHAUSTION); printed TSL on V8 ${r.printed.same}/${r.printed.cases}, divergences ${JSON.stringify(r.printed.divergences)}, JSC ${r.printed.jsc} programs`,
    );
    // Arrays of booleans and subarray on an argument print in rc too (a typed array made in a function doesn't, in rc).
    const rc = await P.dualRoute({
      modes: ["rc"],
      levels: [0, 2],
      accels: [accel],
      jobs,
      classes: true,
      dirs: ["corpus/lower/pos"],
      filter: (f) => R9.R9_RC_PROGRAMS.some((p) => f.endsWith(p)),
    });
    failures.push(...rc.failures);
    const rcHandled = rc.programs.filter((p) => p.handled).length;
    if (rcHandled !== R9.R9_RC_PROGRAMS.length * 2)
      failures.push(`only ${rcHandled} of R9's rc builds printed`);
    rows.push(
      `rc: ${rcHandled} builds, ${rc.rows.reduce((n, x) => n + x.agreed, 0)}/${rc.rows.reduce((n, x) => n + x.cases, 0)} cases the same`,
    );
    // The printing reads as TSL makes a typed array in a function: an object's storage, a layout class's array or a tail,
    // with no allocation of @tsl/lowered's; module state's as R7's runtime class held in a static object; an array of
    // booleans one of bytes.
    const text = (file: string): string => {
      const lo = lowerFile(join(ROOT, file), {
        memory: "leak",
        opt: 2,
        route: "tsl",
        classes: true,
      });
      const f = lo.tsl?.file ?? "";
      return f === "" ? "" : readFileSync(f, "utf8");
    };
    const ta = text("corpus/lower/pipe/typed_arrays.ts");
    for (const want of [
      "items = array(i32, 8);",
      "items = tail(f64);",
      "new Int32Array_8().items",
      "withTail(",
    ])
      if (!ta.includes(want)) failures.push(`typed_arrays.ts's printing has no ${want}`);
    if (/\b(alloc|allocStack)\(/.test(ta))
      failures.push("typed_arrays.ts's printing allocates through @tsl/lowered");
    if (
      !text("corpus/lower/pos/module_state.ts").includes(
        "const g_COMPUTED = new Uint16ArrayField();",
      )
    )
      failures.push("module_state.ts's COMPUTED isn't a static Uint16ArrayField");
    if (!/new JsArray\(u8, /.test(text("corpus/lower/pos/d36_layout.ts")))
      failures.push("d36_layout.ts's array of booleans isn't a JsArray of bytes");
    // Where tslc put them, in typed_arrays.ts's TIR at -O2 in leak: a constant length on the stack, a length known at run
    // time in the per-call region, an array kept past the call on the heap.
    const lo = lowerFile(join(ROOT, "corpus/lower/pipe/typed_arrays.ts"), {
      memory: "leak",
      opt: 2,
      route: "tsl",
      classes: true,
    });
    const tir =
      lo.tir === null ? "" : (await import("../../compiler/tir/text.ts")).printModule(lo.tir);
    const fn = (name: string): string =>
      new RegExp(`func @${name}\\(.*?\\n}`, "s").exec(tir)?.[0] ?? "";
    const placed = {
      small: /alloca/.test(fn("small")) && !/__leak_alloc/.test(fn("small")),
      churn: /__arena_top|__alloc/.test(fn("churn")) && !/__leak_alloc/.test(fn("churn")),
      keepBytes: /__leak_alloc/.test(fn("keepBytes")),
    };
    for (const [k, ok] of Object.entries(placed))
      if (!ok) failures.push(`typed_arrays.ts's ${k} isn't placed as R9 places it`);
    rows.push(
      `placement at -O2 in leak: small on the stack ${placed.small}, churn in the per-call region ${placed.churn}, keepBytes on the heap ${placed.keepBytes}`,
    );
    for (const f of R9.R9_FAULTS) {
      const x = await R.r2FaultRun(f, accel, jobs, engines);
      rows.push(`${f.name}: ${caughtText(x)}`);
      if (x.broken)
        failures.push(`${f.name}: it only stopped compiling, so it shows nothing: ${x.first}`);
      else if (x.caught === 0) failures.push(`${f.name} wasn't caught`);
    }
    rows.push(`auto prints them: ${AUTO_R9 ? "yes" : "no (AUTO_R9 off)"}`);
    report({
      box: `34. R9 (D36, D62, D66, D69): a typed array made in a function prints as an object's storage, a layout class's array for a constant length (on the stack where tslc's escape analysis says so) or a tail (D69) for any other, in the per-call region where nothing keeps it past the export call; module state that's a typed array as R7's runtime class in a static object; an array of booleans or of nothing as a JsArray of bytes; R9's programs agree through both routes at -O0, -O1 and -O2 in leak and manual (the arrays of booleans and subarray on an argument in rc too) and run on V8 and JSC; and each of ${R9.R9_FAULTS.length} bugs is caught, with how many cases caught it by a wrong result or trap code: a typed array one element short, a region tail not zeroed, a view kept past the call not followed by the region, a view's pointer kept as an integer not moving its object off the stack, module state's array a length short, booleans two bytes an element, an array of nothing with room for 2^28 (tools/r9-tests.ts)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 35. R10: strings in `rc` through the TSL route, the program's own JsStr counted by tslc's expansion.
  M.unit("35", async () => {
    const R10 = timedModule("r10", await import("../r10-tests.ts"));
    const R8 = await import("../r8-tests.ts");
    const P = timedModule("pipe", await import("../pipe-tests.ts"));
    const { readFileSync } = await import("node:fs");
    const { AUTO_RC_STRINGS, lowerFile } = await import("../../compiler/host/tslc.ts");
    const failures: string[] = [];
    const rows: string[] = [];
    // R10's programs through both routes in rc at -O0, -O1 and -O2, and the printed TSL on V8 and JSC
    const r = await P.dualRoute({
      modes: ["rc"],
      levels: [0, 1 as 0, 2],
      accels: [accel],
      jobs,
      classes: true,
      dirs: [...new Set(R10.R10_PROGRAMS.map((f) => f.replace(/\/[^/]*$/, "")))],
      filter: (f) => R10.R10_PROGRAMS.some((p) => f.endsWith(p)),
    });
    // RC_TSL_ROUTE_OOM's programs, counted apart: rc_churn.ts was one until R11 (its sets, not its strings), and none of R10's is now
    const memoryOnly = r.failures.filter(
      (f) =>
        /, TSL \{"result":\{"trap":14\}/.test(f) && R8.RC_TSL_ROUTE_OOM.includes(f.split(" ")[0]!),
    );
    failures.push(...r.failures.filter((f) => !memoryOnly.includes(f)));
    const cases = r.rows.reduce((n, x) => n + x.cases, 0);
    const agreed = r.rows.reduce((n, x) => n + x.agreed, 0);
    const handled = r.programs.filter((p) => p.handled);
    for (const p of R10.R10_PROGRAMS)
      if (handled.filter((x) => x.file === p).length !== 3)
        failures.push(`${p} isn't printed in rc at -O0, -O1 and -O2`);
    rows.push(
      `${new Set(handled.map((p) => p.file)).size} programs, ${handled.length} builds in rc, ${agreed} of ${cases} cases the same through both routes (${memoryOnly.length} out of memory through the TSL route alone, RC_TSL_ROUTE_OOM: ${[...new Set(memoryOnly.map((f) => f.split(" ")[0]))].join(", ")}); printed TSL on V8 ${r.printed.same}/${r.printed.cases}, divergences ${JSON.stringify(r.printed.divergences)}, JSC ${r.printed.jsc} programs`,
    );
    // The printing: the program's own two classes, literals made in __init, concatenation and substrings as JsStr's own,
    // a native caller's string exports and its count pair, and nothing of @tsl/jsrt's strings
    const lo = lowerFile(join(ROOT, "corpus/lower/pipe/rc_strings.ts"), {
      memory: "rc",
      opt: 2,
      route: "tsl",
      classes: true,
    });
    const text = lo.tsl?.file !== undefined ? readFileSync(lo.tsl.file, "utf8") : "";
    for (const want of [
      "class JsStr {",
      "class JsStrBuf {",
      "units = tail(u16);",
      "= jsStrOf(lit(",
      ".concat(",
      ".sub(",
      "export function __str_place(n: usize): JsStr",
      "export function __rc_release_str(p: JsStr): void {}",
    ])
      if (!text.includes(want)) failures.push(`rc_strings.ts's printing has no ${want}`);
    if (/JsFlat|JsString|jsEq\b/.test(text))
      failures.push("rc_strings.ts's printing still names @tsl/jsrt's strings");
    const meta = lo.meta as { rcStr?: { layout: object; release: string } } | undefined;
    if (meta?.rcStr?.release !== "__rc_release_str")
      failures.push("the build publishes no string layout and count pair for a native caller");
    // Number text's scratch digits, a constant length's layout class, on the stack in rc (i32Str), never counted
    const tir =
      lo.tir === null ? "" : (await import("../../compiler/tir/text.ts")).printModule(lo.tir);
    const i32Str = new RegExp("func @i32Str\\(.*?\\n}", "s").exec(tir)?.[0] ?? "";
    const onStack = /alloca/.test(i32Str);
    if (!onStack) failures.push("number text's scratch digits aren't on the stack in rc");
    rows.push(`number text's digits on the stack in rc: ${onStack}`);
    rows.push(`auto takes strings in rc: ${AUTO_RC_STRINGS ? "yes" : "no (AUTO_RC_STRINGS off)"}`);
    report({
      box: `35. R10 (3.5, 4.5's ABI in rc, D39, D42): strings in rc print as the program's own JsStr and JsStrBuf, counted by tslc's expansion as its classes are: literals made in __init, concatenation that appends in place, substrings that share a buffer, number text (its scratch digits on the stack), map keys, fields, arrays and strings in cycles the collector frees; R10's programs agree through both routes at -O0, -O1 and -O2 and run on V8 and JSC (rc_churn.ts's sets ran out of memory through the TSL route alone until R11, RC_TSL_ROUTE_OOM; R11 took them out, box 38); the build publishes a string layout and a count pair for a native caller (box 36 checks what it counts, box 37 R10's bugs)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 36. R10: a native caller's counts of strings in rc, and D39's bound (apart from box 35, so that neither job nears the
  // 3 GiB watchdog).
  M.unit("36", async () => {
    const R10 = timedModule("r10", await import("../r10-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    // What's held after each case, each result's count, and D39's bound after letting go of 500 strings
    const c = await R10.ownershipChecks(accel, [0, 1, 2]);
    rows.push(...c.rows);
    failures.push(...c.failures);
    report({
      box: `36. R10 (4.5's ABI in rc, D39): a native caller places and lets go of strings by the module's own exports, and after each of rc_strings.ts's cases, in two rounds at -O0, -O1 and -O2, only what module state keeps is live, each string result's count is as the caller holds it, and letting go of 500 strings frees them a bounded number of steps an allocation (D39) (tools/r10-tests.ts)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 37. R10's bugs, each caught (apart from box 36, so that neither job nears the 3 GiB watchdog).
  M.unit("37", async () => {
    const R10 = timedModule("r10", await import("../r10-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of R10.R10_FAULTS) {
      const x = await R10.r10FaultRun(f, accel, jobs);
      rows.push(`${f.name}: ${caughtText(x)}`);
      if (x.broken)
        failures.push(`${f.name}: it only stopped compiling, so it shows nothing: ${x.first}`);
      else if (x.caught === 0) failures.push(`${f.name} wasn't caught`);
    }
    report({
      box: `37. R10: each of ${R10.R10_FAULTS.length} bugs put into strings in rc is caught by the dual route on rc_strings.ts at -O2 (a leak by the counting checks there), with how many cases caught it: a literal handed on uncounted, a temporary never let go of, a string field dropped twice, a placed string a unit short, the published length 4 bytes off, an append in place to a shared tail (tools/r10-tests.ts)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 38. R11: maps and sets in `rc` through the TSL route, their tables made at the counted heap's pace (tools/r11-tests.ts).
  M.unit("38", async () => {
    const R11 = timedModule("r11", await import("../r11-tests.ts"));
    const R8 = await import("../r8-tests.ts");
    const P = timedModule("pipe", await import("../pipe-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    const all = [...R11.R11_PROGRAMS, "corpus/lower/rc-tsl/r11_set_queue.ts"];
    // R11's churn programs through both routes in rc at -O0, -O1 and -O2, and the printed TSL on V8 and JSC; nothing is
    // excused for running out of memory now: rc_churn.ts left RC_TSL_ROUTE_OOM
    const r = await P.dualRoute({
      modes: ["rc"],
      levels: [0, 1 as 0, 2],
      accels: [accel],
      jobs,
      classes: true,
      dirs: [...new Set(all.map((f) => f.replace(/\/[^/]*$/, "")))],
      filter: (f) => all.some((p) => f.endsWith(p)),
    });
    failures.push(...r.failures);
    const cases = r.rows.reduce((n, x) => n + x.cases, 0);
    const agreed = r.rows.reduce((n, x) => n + x.agreed, 0);
    const handled = r.programs.filter((p) => p.handled);
    for (const p of all)
      if (handled.filter((x) => x.file === p).length !== 3)
        failures.push(`${p} isn't printed in rc at -O0, -O1 and -O2`);
    if (cases === 0 || agreed !== cases)
      failures.push(`${cases - agreed} of ${cases} cases differ through the two routes`);
    if (R8.RC_TSL_ROUTE_OOM.some((f) => f.endsWith("rc_churn.ts")))
      failures.push("rc_churn.ts is still excused for running out of memory (RC_TSL_ROUTE_OOM)");
    rows.push(
      `${new Set(handled.map((p) => p.file)).size} programs, ${handled.length} builds in rc, ${agreed} of ${cases} cases the same through both routes; printed TSL on V8 ${r.printed.same}/${r.printed.cases}, divergences ${JSON.stringify(r.printed.divergences)}, JSC ${r.printed.jsc} programs; RC_TSL_ROUTE_OOM: ${R8.RC_TSL_ROUTE_OOM.join(", ")}`,
    );
    // `auto` takes the sets-only and maps-only probes in rc, as the build the differential forces
    for (const level of [0, 2] as const) failures.push(...(await R11.autoChecks(level)));
    rows.push("auto takes r11_set_churn.ts and r11_map_churn.ts in rc at -O0 and -O2");
    // a table's freeing steps, read off a native caller's counters, and the drain when @tsl/std runs out
    const c = await R11.pacingChecks(accel, [0, 1, 2]);
    rows.push(...c.rows);
    failures.push(...c.failures);
    report({
      box: `38. R11 (3.5, D39, D72): maps and sets in rc through the TSL route keep their tables in @tsl/std, made at the counted heap's pace: each table a map a counted object holds makes takes the freeing steps an allocation of the counted heap takes (rcAllocSteps), and where @tsl/std has nothing left, everything the counted heap has waiting is freed (rcCollect) before it's asked again (JsMap.tablesIn); a map holding nothing counted is freed in one step; sets of numbers, maps of numbers and of objects churned past the memory there is, and rc_churn.ts (out of RC_TSL_ROUTE_OOM), agree through both routes at -O0, -O1 and -O2 and run on V8 and JSC, and auto takes the sets-only and maps-only probes; growing one set takes freeing steps for its tables within the budget each, and garbage still holding three sets' tables when @tsl/std runs out is freed (tools/r11-tests.ts)`,
      ok: failures.length === 0 && hvf.ok && !c.skipped,
      detail: `${rows.join("; ")}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 39. R11: exceptions in rc through the TSL route, corpus/lower/exc's programs written by hand.
  M.unit("39", async () => {
    const P = timedModule("pipe", await import("../pipe-tests.ts"));
    const failures: string[] = [];
    const r = await P.dualRoute({
      modes: ["rc"],
      levels: [0, 2],
      accels: [accel],
      jobs,
      classes: true,
      dirs: ["corpus/lower/exc"],
    });
    failures.push(...r.failures);
    const cases = r.rows.reduce((n, x) => n + x.cases, 0);
    const agreed = r.rows.reduce((n, x) => n + x.agreed, 0);
    const handled = r.programs.filter((p) => p.handled);
    const notYet = r.programs
      .filter((p) => !p.handled)
      .map((p) => `${p.file.replace(/.*\//, "")}: ${(p.why ?? "").slice(0, 90)}`);
    if (handled.length < 30)
      failures.push(
        `only ${handled.length} builds of corpus/lower/exc in rc through the TSL route`,
      );
    if (cases === 0 || agreed !== cases)
      failures.push(`${cases - agreed} of ${cases} cases differ through the two routes`);
    report({
      box: "39. R11 (D49, D68, D74, 4.5's ABI with exceptions): exceptions in rc through the TSL route, desugared by the printer (the flag, the value as Dyn, labelled blocks, finally's completion code) and counted by tslc's expansion like any other code: corpus/lower/exc's programs written by hand agree through both routes at -O0 and -O2 and run on V8 and JSC; a native caller takes an exception that reaches it and gives it back by the module's own __exc_release (DownMeta.exc.release); not auto's (AUTO_RC_EXC)",
      ok: failures.length === 0 && hvf.ok,
      detail: `${new Set(handled.map((p) => p.file)).size} programs, ${handled.length} builds in rc, ${agreed} of ${cases} cases the same through both routes; printed TSL on V8 ${r.printed.same}/${r.printed.cases}, divergences ${JSON.stringify(r.printed.divergences)}, JSC ${r.printed.jsc} programs; not printed yet: ${[...new Set(notYet)].join("; ")}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 40. R11: exceptions in rc, the generated programs (every way out through `finally`), apart from box 39 for the watchdog.
  M.unit("40", async () => {
    const P = timedModule("pipe", await import("../pipe-tests.ts"));
    const failures: string[] = [];
    const r = await P.dualRoute({
      modes: ["rc"],
      levels: [2],
      accels: [accel],
      // two at a time: an rc image of these takes about 7 s quiet a route, and four at once under a gate's load ran both
      // routes past the 60 s limit
      jobs: Math.min(jobs, 2),
      classes: true,
      generated: true,
      dirs: ["corpus/lower/exc"],
      filter: (f) => /\/gen_/.test(f),
    });
    failures.push(...r.failures);
    const cases = r.rows.reduce((n, x) => n + x.cases, 0);
    const agreed = r.rows.reduce((n, x) => n + x.agreed, 0);
    const handled = r.programs.filter((p) => p.handled);
    const total = r.programs.length;
    if (handled.length !== total)
      failures.push(
        `${total - handled.length} of corpus/lower/exc's generated programs aren't printed in rc`,
      );
    if (cases === 0 || agreed !== cases)
      failures.push(`${cases - agreed} of ${cases} cases differ through the two routes`);
    report({
      box: "40. R11 (D49, D68, D74): exceptions in rc through the TSL route, corpus/lower/exc's generated programs (every way out of a try through finally: normal, break, continue, return and throw, in catch and finally, to an inner and an outer target) agree through both routes at -O2 and run on V8 and JSC",
      ok: failures.length === 0 && hvf.ok,
      detail: `${handled.length} of ${total} programs in rc, ${agreed} of ${cases} cases the same through both routes; printed TSL on V8 ${r.printed.same}/${r.printed.cases}, divergences ${JSON.stringify(r.printed.divergences)}, JSC ${r.printed.jsc} programs${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 41. R11: what's live after each case of an exceptions program in rc, in two rounds at each level.
  M.unit("41", async () => {
    const R11 = timedModule("r11", await import("../r11-tests.ts"));
    const { AUTO_RC_EXC } = await import("../../compiler/host/tslc.ts");
    const failures: string[] = [];
    const rows: string[] = [];
    const c = await R11.excCountChecks(accel, [0, 1, 2]);
    rows.push(...c.rows);
    failures.push(...c.failures);
    rows.push(`auto takes exceptions in rc: ${AUTO_RC_EXC ? "yes" : "no (AUTO_RC_EXC off)"}`);
    report({
      box: "41. R11 (D39, D49, 4.5's ABI in rc): after each of r11_exc_counts.ts's cases (a thrown object holding a chain caught, rethrown from a catch, passing a finally that holds an object of its own, replaced by a finally's own throw, swallowed by a finally's return, taken by the native caller and given back with __exc_release, kept in module state and let go of, and a loop that throws, catches and breaks through finally), in two rounds at -O0, -O1 and -O2, only what module state keeps is live, and the results are the direct route's (tools/r11-tests.ts)",
      ok: failures.length === 0 && hvf.ok && !c.skipped,
      detail: `${rows.join("; ")}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 42. R11's bugs, each caught (apart from boxes 38 and 41, so that no job nears the 3 GiB watchdog).
  M.unit("42", async () => {
    const R11 = timedModule("r11", await import("../r11-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of R11.R11_FAULTS) {
      const x = await R11.r11FaultRun(f, accel, jobs);
      rows.push(`${f.name}: ${caughtText(x)}`);
      if (x.broken)
        failures.push(`${f.name}: it only stopped compiling, so it shows nothing: ${x.first}`);
      else if (x.caught === 0) failures.push(`${f.name} wasn't caught`);
    }
    for (const f of R11.R11_EXC_FAULTS) {
      const x = await R11.r11ExcFaultRun(f, accel, jobs);
      rows.push(`${f.name}: ${caughtText(x)}`);
      if (x.broken)
        failures.push(`${f.name}: it only stopped compiling, so it shows nothing: ${x.first}`);
      else if (x.caught === 0) failures.push(`${f.name} wasn't caught`);
    }
    report({
      box: `42. R11: each of ${R11.R11_FAULTS.length + R11.R11_EXC_FAULTS.length} bugs put into maps' tables and exceptions in rc is caught, with how many cases caught it: a holder printed as before R11, a table made with no freeing steps, @tsl/std running out with nothing waiting freed, a map freed keeping a table, a table's steps over the budget, a caught exception left in module state, a rethrow with no count of its own, module state read as tsc narrows it, an unknown's unset field dropped (tools/r11-tests.ts)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 43. R12: objects printed as TSL classes in `strict` (pile item 7), through the dual route, on V8 as printed, and as Wasm.
  M.unit("43", async () => {
    const R12 = timedModule("r12", await import("../r12-tests.ts"));
    const failures: string[] = [];
    const d = await R12.strictDual([accel], jobs);
    failures.push(...d.failures);
    if (d.agreed !== d.cases)
      failures.push(`${d.cases - d.agreed} cases differ through the two routes`);
    for (const p of R12.R12_PROGRAMS)
      if (!d.printed.includes(p)) failures.push(`${p} isn't printed with classes in strict`);
    const w = await R12.strictWasm(jobs);
    failures.push(...w.failures);
    for (const p of R12.R12_PROGRAMS)
      if (!w.programs.includes(p)) failures.push(`${p} wasn't run as Wasm`);
    report({
      box: "43. R12 (D62, pile item 7): objects print as TSL classes in strict, and since R13 arrays as @tsl/jsrt's arena array, typed arrays as R9's views, closure values and exports taking or giving objects too (no JsArray, JsString, JsMap or Dyn, runtimes strict code doesn't have); what escapes its function goes in the call arena, placed by tslc, which the caller resets (D36), what doesn't on the stack, and an object that could outlive the arena refuses the printing; every program it takes agrees with the direct route at -O0 and -O2 through the dual route, runs on V8 as printed, and as Wasm on V8 and JSC agrees with the source (tools/r12-tests.ts)",
      ok: failures.length === 0 && hvf.ok,
      detail: `${d.agreed}/${d.cases} cases in ${d.printed.length} programs printed with classes at -O0 and -O2: ${d.printed.join(", ")}; the printed TSL on V8 ${d.printedSame} of ${d.printedCases} the same, the rest D71's divergences; Wasm on V8 and JSC: ${w.cases} cases in ${w.programs.length} programs with a class; refused: ${Object.entries(
        d.refused,
      )
        .map(([k, n]) => `${k} (${n})`)
        .join(", ")}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 44. R12's bugs, each caught.
  M.unit("44", async () => {
    const R12 = timedModule("r12", await import("../r12-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of R12.R12_FAULTS) {
      const x = await R12.r12FaultRun(f, accel, jobs);
      rows.push(`${f.what}: ${caughtText(x)}`);
      if (x.caught === 0) failures.push(`${f.name} wasn't caught`);
    }
    report({
      box: `44. R12: each of ${R12.R12_FAULTS.length} bugs put into class printing in strict is caught, with how many cases caught it: an object that escapes its function left on its stack, an object in the call arena given 8 bytes too few, and a reference's pointer taken from the wrong bits in Wasm (tools/r12-tests.ts)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 45. R13: arrays in `strict`, as @tsl/jsrt's arena array, and the JPEG decoder through the TSL route.
  M.unit("45", async () => {
    const R13 = timedModule("r13", await import("../r13-tests.ts"));
    const failures: string[] = [];
    const k = await R13.keptRefused();
    failures.push(...k.failures);
    const d = await R13.strictArraysDual([accel], jobs, R13.R13_PROGRAMS);
    failures.push(...d.failures);
    if (d.agreed !== d.cases)
      failures.push(`${d.cases - d.agreed} cases differ through the two routes`);
    for (const p of R13.R13_PROGRAMS)
      if (!d.printed.includes(p)) failures.push(`${p} isn't printed with arrays in strict`);
    const w = await R13.jpegWasm();
    failures.push(...w.failures);
    if (w.fixtures < 16)
      failures.push(`the JPEG decoder's Wasm ran ${w.fixtures} fixtures, not 16`);
    const n = hvf.ok ? await R13.jpegNative(accel) : null;
    if (n !== null) {
      failures.push(...n.failures.slice(0, 20));
      if (n.agreed !== n.cases)
        failures.push(
          `the JPEG decoder natively: ${n.cases - n.agreed} of ${n.cases} cases differ from V8`,
        );
      if (n.pinned !== 6) failures.push(`the JPEG decoder natively: ${n.pinned} of M2's 6 pins`);
      if (n.corrupt.crashed > 0 || n.corrupt.mismatched > 0)
        failures.push(
          `the JPEG decoder natively, corrupt input: ${n.corrupt.crashed} crashed, ${n.corrupt.mismatched} differ from V8`,
        );
    }
    report({
      box: "45. R13 (D66, D62, pile item 7): arrays print in strict as @tsl/jsrt's arena array (JsArenaArray), whose buffers come only from the call arena the caller resets (D36), with typed arrays made in functions as R9's views, arrays of typed arrays held in R7's holders, closure values and exports taking or giving objects, each placed by tslc in the call arena; module state holds only what __init made before it commits the arena, and tslc refuses a package where something made later can reach it; strict_arrays.ts agrees with the direct route at -O0 and -O2 and runs on V8 and JSC as printed; the JPEG decoder through the TSL route agrees with V8 natively (every fixture and maxEdge, M2's pins, 200 corrupt inputs matching V8 or trapping) and as Wasm on V8 and JSC at -O0 and -O2 (tools/r13-tests.ts)",
      ok: failures.length === 0 && hvf.ok,
      detail: `tslc's arena check: ${k.rows.join(", ")}; strict_arrays.ts ${d.agreed}/${d.cases} cases; the JPEG decoder as Wasm: ${w.fixtures} fixtures, ${w.checks} checks on V8 and JSC; natively${n !== null ? ` (${n.accel}, ${n.restructured} reshapes in its class printing; auto takes its phase 1 printing since R14, the direct route's TIR): ${n.agreed}/${n.cases} cases, ${n.pinned} pins, corrupt ${n.corrupt.matched} matched and ${n.corrupt.trapped} trapped of ${n.corrupt.total}` : ": not run"}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 46. R13's bugs, each caught.
  M.unit("46", async () => {
    const R13 = timedModule("r13", await import("../r13-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of R13.R13_FAULTS) {
      const x = await R13.r13FaultRun(f, accel, jobs);
      rows.push(`${f.what}: ${caughtText(x)}`);
      if (x.caught === 0) failures.push(`${f.name} wasn't caught`);
    }
    report({
      box: `46. R13: each of ${R13.R13_FAULTS.length} bugs put into arrays in strict is caught, with how many cases caught it: an arena array one element short, growth given half the bytes it asked for, the element size taken as half, a typed array an array holds one element short, and an array made after __init left where module state reaches it (tools/r13-tests.ts)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 47. R14: `auto` takes what phase 1 printed reshaped only as it trusts, giving the direct route's TIR, and agreeing.
  M.unit("47", async () => {
    const R14 = timedModule("r14", await import("../r14-tests.ts"));
    const failures: string[] = [];
    const k = await R14.autoReshapedKinds();
    failures.push(...k.failures);
    const d = await R14.autoReshapedDual([accel], jobs);
    failures.push(...d.failures);
    if (d.agreed !== d.cases)
      failures.push(`${d.cases - d.agreed} cases differ through the two routes`);
    for (const p of R14.R14_PROGRAMS)
      for (const mode of ["leak", "manual"])
        if (!d.taken.includes(`${p} ${mode}`))
          failures.push(`${p} isn't taken reshaped by auto in ${mode}`);
    report({
      box: "47. R14 (D62, pile item 9): auto takes a program phase 1 printed reshaped only by the kinds it trusts (a statement-expression's statements before an operand, after a sequence's first part, in a conditional's arm, on a logical operator's right side; tslc.ts's TRUSTED_RESHAPES and TRUSTED_IN), never one with exceptions or another kind, and each such build at -O1 and -O2 gives the direct route's TIR byte for byte; every program auto takes reshaped, in strict, leak and manual at -O0 and -O2, agrees with the direct route natively and as printed on V8 and JSC with the source (tools/r14-tests.ts)",
      ok: failures.length === 0 && hvf.ok,
      detail: `taken reshaped at -O2: ${JSON.stringify(k.taken)}, by kind ${JSON.stringify(k.kinds)}; phase 1's TIR the direct route's in ${k.phase1Same} builds at -O1 and -O2; natively ${d.agreed}/${d.cases} cases in ${d.taken.length} programs; the third route ${d.printedSame}/${d.printedCases} (3.10's allowed divergences, named: ${JSON.stringify(d.divergences)})${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 48. R14's bugs, each caught.
  M.unit("48", async () => {
    const R14 = timedModule("r14", await import("../r14-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of R14.R14_FAULTS) {
      const x = await R14.r14FaultRun(f, accel, jobs);
      rows.push(`${f.what}: ${caughtText(x)}`);
      if (x.caught === 0) failures.push(`${f.name} wasn't caught`);
    }
    report({
      box: `48. R14: each of ${R14.R14_FAULTS.length} bugs put into the order of a trusted reshape is caught by the differential on auto's own builds, with how many cases caught it: a sequence's earlier parts run after a later part's statements, an earlier operand evaluated after a later one's statements, a conditional's arms' statements run before its test, and a logical operator's right side's statements run where its left side decides (tools/r14-tests.ts)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 49. R15: conds.ts at -O1 and -O2, loop versioning at -O2, and loops where the guard must fail.
  M.unit("49", async () => {
    const R15 = timedModule("r15", await import("../r15-tests.ts"));
    const failures: string[] = [];
    const sh = await R15.r15Shapes();
    failures.push(...sh.failures);
    const rows: string[] = [...sh.rows];
    for (const level of [0, 1, 2] as const) {
      const r = await R15.r15Native(accel, jobs, level);
      rows.push(`-O${level}: ${r.summary}`);
      failures.push(...r.failures.map((x) => `-O${level}: ${x}`));
      if (r.count === 0) failures.push(`-O${level}: no case of loop_versions.ts ran`);
    }
    report({
      box: "49. R15 (D44, D73, pile item 10): a test a test above it answered goes at -O1 and -O2 (conds.ts), and -O2 versions a loop whose checks a guard before it proves (version.ts: a fast copy without them, the loop as it was the fallback); matmul's inner loop has a fast copy with no bounds or overflow check and a fallback with both, and is the loop it was at -O1; corpus/trap/loop_versions.ts, loops where the guard holds and loops where it must fail (a bound one past, a length or a bound the loop changes, two arrays of different lengths, a stride past the end, one array as two, a test after a join), agrees with V8 natively at -O0, -O1 and -O2, trapping where V8 does (tools/r15-tests.ts)",
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 50. R15's bugs, each caught.
  M.unit("50", async () => {
    const R15 = timedModule("r15", await import("../r15-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of R15.R15_FAULTS) {
      const r = await R15.r15Native(accel, jobs, 2, f.name);
      rows.push(`${f.what}: ${r.failures.length} cases wrong`);
      if (r.failures.length === 0) failures.push(`${f.name} wasn't caught`);
    }
    report({
      box: `50. R15: each of ${R15.R15_FAULTS.length} bugs put into the optimiser's new passes is caught by corpus/trap/loop_versions.ts at -O2, with how many cases caught it: a test's answer taken where its edge doesn't dominate, the versioning guard allowing one turn more than the checks, a bound or length the loop changes read once before it for the guard, and every guard against the first check's length (tools/r15-tests.ts; opt-a box 12 catches each too)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 51. R16: class printing's arrays made at their final size in one step, `push` inlined with its slow path out of line.
  M.unit("51", async () => {
    const R16 = timedModule("r16", await import("../r16-tests.ts"));
    const failures: string[] = [];
    const sh = await R16.r16Shapes();
    failures.push(...sh.failures);
    const d = await R16.r16Dual([accel], jobs);
    failures.push(...d.failures);
    if (d.cases === 0) failures.push("no case of R16's programs ran");
    if (d.agreed !== d.cases)
      failures.push(`${d.cases - d.agreed} cases differ through the two routes`);
    for (const mode of ["strict", "leak", "manual"])
      if (!d.printed.includes(`${R16.R16_PROGRAMS[0]!}@${mode}`))
        failures.push(`${R16.R16_PROGRAMS[0]!} doesn't class-print in ${mode}`);
    report({
      box: "51. R16 (D44, D66): class printing's arrays (@tsl/jsrt's JsArray, and JsArenaArray in strict) are made at their final size in one step by an inlined constructor, and push is inlined with its slow path out of line, at -O1 and -O2 (no call to either left in operandWork, none to growth from a literal); corpus/lower/r16/r16_arrays.ts (literals of every length to 9, pushes to and past each capacity with another array made just after, growth, pop then push, arrays of objects) and the corpus's array programs agree through both routes with class printing forced in strict, leak and manual at -O0 and -O2, and the printed TSL on V8 and JSC with the source (tools/r16-tests.ts)",
      ok: failures.length === 0 && hvf.ok,
      detail: `${sh.rows.join("; ")}; ${d.agreed}/${d.cases} cases the same, class-printed: ${d.printed.join(", ")}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 52. R16's bugs, each caught.
  M.unit("52", async () => {
    const R16 = timedModule("r16", await import("../r16-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of R16.R16_FAULTS) {
      const x = await R16.r16FaultRun(f, accel, jobs);
      rows.push(`${f.what}: ${caughtText(x)}`);
      if (x.answers === 0) failures.push(`${f.name} wasn't caught by a wrong answer`);
    }
    report({
      box: `52. R16: each of ${R16.R16_FAULTS.length} bugs put into the two array classes is caught by R16's cases through the dual route, with how many cases caught it: a literal made one element short, push's fast path not raising the length, push's fast path taken at full capacity, and growth copying one element fewer than the array holds (tools/r16-tests.ts)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 53. R17: @tsl/gc's freeing step at the direct route's cost, and JsArray's "no holes" flag.
  M.unit("53", async () => {
    const R17 = timedModule("r17", await import("../r17-tests.ts"));
    const failures: string[] = [];
    const sh = await R17.r17Shapes();
    failures.push(...sh.failures);
    const d = await R17.r17Dual([accel], jobs);
    failures.push(...d.failures);
    if (d.cases === 0) failures.push("no case of R17's program ran");
    if (d.agreed !== d.cases)
      failures.push(`${d.cases - d.agreed} cases differ through the two routes`);
    for (const mode of ["rc", "leak", "manual"])
      if (!d.printed.includes(`${R17.R17_PROGRAM}@${mode}`))
        failures.push(`${R17.R17_PROGRAM} doesn't class-print in ${mode}`);
    const st = await R17.r17Steps(accel, jobs);
    failures.push(...st.failures);
    if (st.cases === 0 || st.agreed !== st.cases)
      failures.push(`the step counts: ${st.agreed}/${st.cases} agree`);
    report({
      box: "53. R17 (D39, D66): @tsl/gc's freeing step at the direct route's cost (an object whose store's release function does nothing given back with no call, the same step; Rc's make inlined, its free slot taken in line, at -O1 and -O2), and JsArray's no-holes flag for an array of numbers, with the lowering's pop clearing the slot it drops from an array of references in every mode; corpus/lower/r17/r17_free.ts (leaves among objects with one to three references, lists and trees dropped while leaves are made, arrays of numbers popped, shifted, cut and made longer by writes, arrays of objects popped and made longer and grown into a buffer another gave back) agrees through both routes with class printing forced in rc, leak and manual at -O0 and -O2, and the printed TSL on V8 and JSC with the source; corpus/rc/rc_steps*.ts's pinned step counts, R17's leaves among them, natively and on the host (tools/r17-tests.ts)",
      ok: failures.length === 0 && hvf.ok,
      detail: `${sh.rows.join("; ")}; ${d.agreed}/${d.cases} cases the same, class-printed: ${d.printed.join(", ")}; step counts ${st.agreed}/${st.cases}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 54. R17's bugs, each caught.
  M.unit("54", async () => {
    const R17 = timedModule("r17", await import("../r17-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of R17.R17_FAULTS) {
      const x = await R17.r17FaultRun(f, accel, jobs);
      rows.push(`${f.what}: ${caughtText(x)}`);
      if (x.answers === 0) failures.push(`${f.name} wasn't caught by a wrong answer`);
    }
    report({
      box: `54. R17: each of ${R17.R17_FAULTS.length} bugs is caught, with how many cases caught it: the freeing step's quick path freeing one past its budget, and giving a block back without taking its step (by corpus/rc/rc_steps*.ts's pinned counts), tslc taking every release function as one that does nothing (the same), JsArray's pop leaving a reference in the slot it drops, and a longer length of an array with no holes not zeroing what it adds (by corpus/std/leak/js_array.ts's cases) (tools/r17-tests.ts)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 55. R18: stack objects in rc class printing.
  M.unit("55", async () => {
    const R18 = timedModule("r18", await import("../r18-tests.ts"));
    const failures: string[] = [];
    const sh = await R18.r18Shapes();
    failures.push(...sh.failures);
    const d = await R18.r18Dual([accel], jobs);
    failures.push(...d.failures);
    if (d.cases === 0) failures.push("no case of R18's program ran");
    if (d.agreed !== d.cases)
      failures.push(`${d.cases - d.agreed} cases differ through the two routes`);
    for (const mode of ["rc", "leak", "manual"])
      if (!d.printed.includes(`${R18.R18_PROGRAM}@${mode}`))
        failures.push(`${R18.R18_PROGRAM} doesn't class-print in ${mode}`);
    const neg = await R18.r18Neg(jobs);
    failures.push(...neg.failures);
    const tag = await runNative("rc", [accel], jobs, "rc_stack_tag", engines);
    failures.push(...tag.failures);
    if (!tag.ok || tag.count === 0)
      failures.push("corpus/rc/rc_stack_tag.ts didn't run, or failed");
    report({
      box: "55. R18 (3.5, D39, D41): rc class printing keeps on the stack what the direct route keeps there: a class every object of which the lowering places on its function's stack, holding numbers, booleans and objects of other such classes and held by nothing counted, prints tagged @tsl.stack, and tslc's expansion leaves it uncounted, its new a plain new that tslc's escape checking places on the stack; corpus/lower/r18/r18_stack.ts (stack objects passed down, chosen on a branch, in every frame of a recursion, alive while counted objects are made, dropped, put in cycles and collected around them; beside classes counted because an object escapes into module state or a counted holder, or is made in a loop) agrees through both routes with class printing forced in rc, leak and manual at -O0 and -O2, and the printed TSL on V8 and JSC with the source; in TIR, which of its classes are tagged and that a tagged class's new makes no counted object at -O1 and -O2; corpus/neg/lowered-rc's tagged objects returned, kept in module state and held by a counted object refused (TSL3001, TSL3002), and a tagged class holding a reference refused (TSL9001); and in a hand-written rc package the tag means nothing (corpus/rc/rc_stack_tag.ts) (tools/r18-tests.ts)",
      ok: failures.length === 0 && hvf.ok,
      detail: `${sh.rows.join("; ")}; ${d.agreed}/${d.cases} cases the same, class-printed: ${d.printed.join(", ")}; ${neg.rows.join("; ")}; rc_stack_tag ${tag.summary}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 56. R18's bugs, each caught (SPEC 8.3's fault rule: a bug not in the build is a harness failure, never caught).
  M.unit("56", async () => {
    const R18 = timedModule("r18", await import("../r18-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of R18.R18_FAULTS) {
      const x = await R18.r18FaultRun(f, accel, jobs);
      rows.push(
        `${f.what}: ${x.answers > 0 ? `${x.answers} (${f.by})` : x.caught > 0 ? "caught by time alone" : 0}`,
      );
      if (x.answers === 0) failures.push(`${f.name} wasn't caught (${f.by}): ${x.first}`);
    }
    report({
      box: `56. R18: each of ${R18.R18_FAULTS.length} bugs is caught, with how many cases or builds caught it: an escaping object placed on the stack (the printer tagging every class of numbers: tslc refuses the build; and with tslc's escape checking also not taking a tagged class's new as a stack object: wrong answers), a stack object reachable from a heap object the collector scans (the printer tagging a class a counted holder in a cycle holds: refused; and with the checking off: wrong answers), a stack object released by @tsl/gc (the expansion sharing and dropping a tagged class's references: wrong answers or traps), the escape checking off alone (corpus/neg/lowered-rc's programs not refused), and the expansion taking a tagged class that holds a reference (the same) (tools/r18-tests.ts)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 57. R19: rc class printing's remaining costs, each where a wrong answer shows.
  M.unit("57", async () => {
    const R19 = timedModule("r19", await import("../r19-tests.ts"));
    const failures: string[] = [];
    const sh = await R19.r19Shapes();
    failures.push(...sh.failures);
    const fl = await R19.r19Fields(accel);
    failures.push(...fl.failures);
    if (!fl.skipped && fl.cases === 0) failures.push(`no case of ${R19.R19_FIELDS} ran`);
    const d = await R19.r19Dual([accel], jobs);
    failures.push(...d.failures);
    if (d.cases === 0) failures.push("no case of R19's program ran");
    if (d.agreed !== d.cases)
      failures.push(`${d.cases - d.agreed} cases differ through the two routes`);
    if (!d.printed.includes(`${R19.R19_PROGRAM}@rc`))
      failures.push(`${R19.R19_PROGRAM} doesn't class-print in rc`);
    report({
      box: "57. R19 (3.4, 3.5, 4.3, D39, D41, D73): rc class printing's remaining measured costs: a room array's tail of any length made in line, a fresh counted slot cut from a page of its size class, a holder with no slots or one freed without freeSteps' frame, an rc environment's call inlined with its kind and captures invariant by tslc's rule (a lowered rc package's counted class, fields stored by its constructor alone), and a ! left to the load through a reference's address; corpus/lower/r19/r19_rooms.ts (arrays grown to alternating lengths and read back, literals of one and two objects and arrays grown into a room churned past 64 pages, objects of three sizes kept alive and read back, closures of three kinds chosen at run time and called in loops, a map grown and read back) agrees through both routes with class printing forced in rc at -O0 and -O2, and the printed TSL on V8 and JSC with the source; in TIR, the environments' call printed @tsl.inline and the kind loaded invariant at -O1 and -O2; and corpus/lowered-rc/r19_fields.ts (hand-written, lowered rc) gives its pinned answers at -O0, -O1 and -O2, a field a method stores too not invariant, one its constructor alone stores invariant (tools/r19-tests.ts)",
      ok: failures.length === 0 && hvf.ok,
      detail: `${sh.rows.join("; ")}; r19_fields ${fl.agreed}/${fl.cases}; ${d.agreed}/${d.cases} cases the same, class-printed: ${d.printed.join(", ")}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 58. R19's bugs, each caught (SPEC 8.3's fault rule: a bug not in the build is a harness failure, never caught).
  M.unit("58", async () => {
    const R19 = timedModule("r19", await import("../r19-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of R19.R19_FAULTS) {
      const x = await R19.r19FaultRun(f, accel, jobs);
      rows.push(`${f.what}: ${caughtText(x)} (${f.by})`);
      if (x.answers === 0) failures.push(`${f.name} wasn't caught (${f.by}): ${x.first}`);
    }
    report({
      box: `58. R19: each of ${R19.R19_FAULTS.length} bugs is caught by a wrong answer, with how many cases caught it: a room array's growth copying one element short, an rc environment's inlined call switch dispatching to the wrong arm, tslc's invariance rule missing a store a method makes (corpus/lowered-rc/r19_fields.ts's pinned answers), a map table's growth losing an entry, a freed array literal's element not dropped (a holder of two objects given back after visiting one), a tail of a new length made at the last length's size class, and a fresh slot cut half a slot past the last (tools/r19-tests.ts)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 59. R20: the runtime's copy and fill of short sizes, each where a wrong answer shows.
  M.unit("59", async () => {
    const R20 = timedModule("r20", await import("../r20-tests.ts"));
    const failures: string[] = [];
    const st = await R20.r20Steps(accel);
    failures.push(...st.failures);
    if (!st.skipped && st.cases === 0) failures.push(`no case of ${R20.R20_STEPS} ran`);
    const d = await R20.r20Dual([accel], jobs);
    failures.push(...d.failures);
    if (d.cases === 0) failures.push("no case of R20's program ran");
    if (d.agreed !== d.cases)
      failures.push(`${d.cases - d.agreed} cases differ through the two routes`);
    report({
      box: "59. R20 (4.3, 5.10, D42, D46, D49): the runtime's copy and fill, their last bytes (under 32 for a copy, under 16 for a fill) steps by the bits of the count where they were a byte at a time, and partial inlining taking a callee whose entry gives a frame slot the copied paths don't use; corpus/r20/r20_steps.ts (TSL proper: a byte array's set from a run of itself, a copy over itself down and up, of every length to 40 and distance to 9, and fill of every length to 24 at every start to 8, each against a byte loop) gives its pinned answers at -O0 and -O2, and corpus/lower/r20/r20_copies.ts (strings of every length to 70 joined and cut, arrays of booleans and of numbers shifted and spliced at every length to 40, each read back weighted by position, and a function whose entry moves a count and keeps a frame slot for a rare path's object, called in a loop) agrees with V8 natively and through both routes with class printing forced in rc and leak at -O0 and -O2, and the printed TSL on V8 and JSC with the source (tools/r20-tests.ts)",
      ok: failures.length === 0 && hvf.ok,
      detail: `r20_steps ${st.agreed}/${st.cases}; ${d.agreed}/${d.cases} cases the same as V8 and through both routes${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 60. R20's bugs, each caught (SPEC 8.3's fault rule: a bug not in the build is a harness failure, never caught).
  M.unit("60", async () => {
    const R20 = timedModule("r20", await import("../r20-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of R20.R20_FAULTS) {
      const x = await R20.r20Fault(f, accel, jobs);
      rows.push(`${f.what}: ${caughtText(x)}`);
      if (x.answers === 0) failures.push(`${f.name} wasn't caught: ${x.first}`);
    }
    report({
      box: `60. R20: each of ${R20.R20_FAULTS.length} bugs in the runtime's copy and fill and in partial inlining is caught by a wrong answer, with how many cases caught it: a copy's last bytes missing their 4-byte step, a copy up over itself missing its last byte, a short fill missing its 2-byte store, and partial inlining taking a callee's entry with a frame slot as free of effects (tools/r20-tests.ts)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 61. R21: strings and exceptions in rc class printing, each where a wrong answer shows.
  M.unit("61", async () => {
    const R21 = timedModule("r21", await import("../r21-tests.ts"));
    const failures: string[] = [];
    const d = await R21.r21Dual([accel], jobs);
    failures.push(...d.failures);
    if (d.cases === 0) failures.push("no case of R21's programs ran");
    if (d.agreed !== d.cases)
      failures.push(`${d.cases - d.agreed} cases differ through the two routes`);
    for (const p of [R21.R21_UNITS, R21.R21_QUICK])
      if (!d.printed.includes(`${p}@rc`)) failures.push(`${p} doesn't class-print in rc`);
    report({
      box: "61. R21 (3.5, 4.4, D39, D42, D75): one-unit strings below 256 from a table in rc class printing (module state, never freed, as the direct route's static table), an append or prepend of one unit a checked store, @tsl/gc's making and freeing with the same steps (a tail's owner word kept, an object of one slot dispatched once, freeFlat called from make), and the backend's shrink-wrapping at -O1 and -O2 (an entry that tests and returns at once does so before its prologue); corpus/lower/r21/r21_units.ts (every unit to 300 made as a one-unit string each way the runtime makes one, units 128 apart one after the other, shared strings kept, dropped, hashed as keys and appended to) and r21_quick.ts (functions whose entry returns at once or goes on to work that needs a frame, called in loops whose values cross the calls, with throws, recursion and memory on the quick way) agree with V8 natively and through both routes with class printing forced in rc and leak at -O0 and -O2, and the printed TSL on V8 and JSC with the source (tools/r21-tests.ts)",
      ok: failures.length === 0 && hvf.ok,
      detail: `${d.agreed}/${d.cases} cases the same as V8 and through both routes, class-printed: ${d.printed.join(", ")}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 62. R21's bugs, each caught (SPEC 8.3's fault rule: a bug not in the build is a harness failure, never caught).
  M.unit("62", async () => {
    const R21 = timedModule("r21", await import("../r21-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of R21.R21_FAULTS) {
      const x = await R21.r21Fault(f, accel, jobs);
      rows.push(`${f.what}: ${caughtText(x)}`);
      if (x.answers === 0) failures.push(`${f.name} wasn't caught: ${x.first}`);
    }
    report({
      box: `62. R21: each of ${R21.R21_FAULTS.length} bugs is caught by a wrong answer, with how many cases caught it: the one-unit table filed by a unit's low 7 bits, the table taken for unit 256 (a bounds trap), and shrink-wrapping taking a callee-saved register as free (tools/r21-tests.ts)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 63. R22: rc's remaining per-object costs in class printing, each where a wrong answer shows.
  M.unit("63", async () => {
    const R22 = timedModule("r22", await import("../r22-tests.ts"));
    const failures: string[] = [];
    const d = await R22.r22Dual([accel], jobs);
    failures.push(...d.failures);
    if (d.cases === 0) failures.push("no case of R22's programs ran");
    if (d.agreed !== d.cases)
      failures.push(`${d.cases - d.agreed} cases differ through the two routes`);
    for (const p of R22.R22_PROGRAMS)
      if (!d.printed.includes(`${p}@rc`)) failures.push(`${p} doesn't class-print in rc`);
    report({
      box: "63. R22 (3.5, D39, D41, D49): rc class printing's remaining per-object costs, with the same freeing steps: `a + b + c` made once where it's short (the printing's strConcat3), freeOne's second step taken in place, concatenation's new buffer and a tail's owner word worked out apart from its common way; corpus/lower/r22/r22_joins.ts (three strings joined every way, parts empty or not, totals either side of 64 units, pure and calling third parts), r22_throws.ts (errors with and without causes, causes of the program's own classes holding objects, caught 1 and 20 frames up, kept, rethrown through finally) and r22_steps.ts (objects of two to four slots freed with the collector linked, children kept past them and read after their slots are reused) agree with V8 natively and through both routes with class printing forced in rc and leak at -O0 and -O2, and the printed TSL on V8 and JSC with the source (tools/r22-tests.ts)",
      ok: failures.length === 0 && hvf.ok,
      detail: `${d.agreed}/${d.cases} cases the same as V8 and through both routes, class-printed: ${d.printed.join(", ")}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 64. R22's bugs, each caught (SPEC 8.3's fault rule: a bug not in the build is a harness failure, never caught).
  M.unit("64", async () => {
    const R22 = timedModule("r22", await import("../r22-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of R22.R22_FAULTS) {
      const x = await R22.r22Fault(f, accel, jobs);
      rows.push(`${f.what}: ${caughtText(x)}`);
      if (x.answers === 0) failures.push(`${f.name} wasn't caught: ${x.first}`);
    }
    report({
      box: `64. R22: each of ${R22.R22_FAULTS.length} bugs is caught by a wrong answer, with how many cases caught it: a + b + c made once with b and c swapped, a concatenation's new buffer given the second string at the wrong place, freeOne's second step visiting slot 2 in place of slot 1, and a tail's owner word naming the size class above its own (tools/r22-tests.ts, over corpus/lower/r22 and r21 in rc at -O2)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 65. R23: throws and strings in rc class printing, each where a wrong answer shows.
  M.unit("65", async () => {
    const R23 = timedModule("r23", await import("../r23-tests.ts"));
    const failures: string[] = [];
    const d = await R23.r23Dual([accel], jobs);
    failures.push(...d.failures);
    if (d.cases === 0) failures.push("no case of R23's programs ran");
    if (d.agreed !== d.cases)
      failures.push(`${d.cases - d.agreed} cases differ through the two routes`);
    for (const p of R23.R23_PROGRAMS)
      if (!d.printed.includes(`${p}@rc`)) failures.push(`${p} doesn't class-print in rc`);
    report({
      box: "65. R23 (3.5, 4.4, D49, D68): rc class printing's throws and strings: a thrown object built out of line by a builder of its shape, an unknown's reference fields nothing stores to as getters giving null with their 8 bytes kept, and charCodeAt inlined; corpus/lower/r23/r23_throws.ts (throws of the program's own classes and Error's, literals differing between the throws of one class, variables, a constructor that throws itself, a frame and a hundred up, kept, rethrown through finally) and r23_codeat.ts (strings made every way, indices of every kind) agree with V8 natively and through both routes with class printing forced in rc and leak at -O0 and -O2, and the printed TSL on V8 and JSC with the source (tools/r23-tests.ts)",
      ok: failures.length === 0 && hvf.ok,
      detail: `${d.agreed}/${d.cases} cases the same as V8 and through both routes, class-printed: ${d.printed.join(", ")}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 66. R23's bugs, each caught (SPEC 8.3's fault rule: a bug not in the build is a harness failure, never caught).
  M.unit("66", async () => {
    const R23 = timedModule("r23", await import("../r23-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of R23.R23_FAULTS) {
      const x = await R23.r23Fault(f, accel, jobs);
      rows.push(`${f.what}: ${caughtText(x)}`);
      if (x.answers === 0) failures.push(`${f.name} wasn't caught: ${x.first}`);
    }
    report({
      box: `66. R23: each of ${R23.R23_FAULTS.length} bugs is caught by a wrong answer, with how many cases caught it: thrown objects' builders shared by throws whose literals differ, a builder leaving out the class id, never-stored fields printed without their 8 bytes (corpus/lower/exc/exc_exhaust.ts runs out of pages), and a range check losing its lower bound where its upper is the type's own (corpus/trap natively at -O2) (tools/r23-tests.ts, over corpus/lower/r23 and r22 in rc at -O2)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 67. R24: strings and freeing in rc class printing, each where a wrong answer shows, and the steps pinned as before.
  M.unit("67", async () => {
    const R24 = timedModule("r24", await import("../r24-tests.ts"));
    const failures: string[] = [];
    const d = await R24.r24Dual([accel], jobs);
    failures.push(...d.failures);
    if (d.cases === 0) failures.push("no case of R24's programs ran");
    if (d.agreed !== d.cases)
      failures.push(`${d.cases - d.agreed} cases differ through the two routes`);
    for (const p of R24.R24_PROGRAMS)
      if (!d.printed.includes(`${p}@rc`)) failures.push(`${p} doesn't class-print in rc`);
    const st = await R24.r24Steps(accel, jobs);
    failures.push(...st.failures);
    if (st.cases === 0) failures.push("no case of corpus/rc/rc_steps_r24.ts ran");
    report({
      box: "67. R24 (3.5, D39, D41): rc class printing's strings and freeing with the same steps: an allocation's freeing with no collector linked in one call (freeAlloc: an object of one slot freed in place, the cursor left at slot 1 where the budget runs out, the rest of a wider object's slots in freeRest), a leaf's count read once, a view's fields given to its constructor, a unit read with its length and start as their bits, and `a + b` and `s[i]` inlined; corpus/lower/r24/r24_strings.ts (views made by appends and prepends past 64 units, views of views, substrings, every index, `s[i]` at every kind of index, strings kept while freed slots are taken again) and r24_free.ts (objects of no slots, one and five freed with some children kept) agree with V8 natively and through both routes with class printing forced in rc and leak at -O0 and -O2, and the printed TSL on V8 and JSC with the source; corpus/rc/rc_steps_r24.ts's step counts at budgets 1 to 5 and RC_BUDGET, pinned with @tsl/gc as it was before R24, natively and on the host (tools/r24-tests.ts)",
      ok: failures.length === 0 && hvf.ok,
      detail: `${d.agreed}/${d.cases} cases the same as V8 and through both routes, class-printed: ${d.printed.join(", ")}; steps ${st.agreed}/${st.cases}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 68. R24's bugs, each caught (SPEC 8.3's fault rule: a bug not in the build is a harness failure, never caught).
  M.unit("68", async () => {
    const R24 = timedModule("r24", await import("../r24-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of R24.R24_FAULTS) {
      const x = await R24.r24Fault(f, accel, jobs);
      rows.push(`${f.what}: ${caughtText(x)}`);
      if (x.answers === 0) failures.push(`${f.name} wasn't caught: ${x.first}`);
    }
    report({
      box: `68. R24: each of ${R24.R24_FAULTS.length} bugs is caught by a wrong answer, with how many cases caught it: freeAlloc giving a block back without its step, freeAlloc leaving the cursor at slot 2, freeRest starting at slot 2 (each by corpus/rc's pinned step counts), visitLeaf taking two off a count, a leaf given back on the next size class's list, a view's start one on, and a view's unit read from its length's bits (tools/r24-tests.ts, over corpus/lower/r24, r22 and r21 in rc at -O2, and corpus/rc/rc_steps*.ts natively)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 69. R25: strings and freeing in rc class printing, each where a wrong answer shows, the steps pinned as before, and the
  // backend's add of two 32-bit values.
  M.unit("69", async () => {
    const R25 = timedModule("r25", await import("../r25-tests.ts"));
    const failures: string[] = [];
    const d = await R25.r25Dual([accel], jobs);
    failures.push(...d.failures);
    if (d.cases === 0) failures.push("no case of R25's programs ran");
    if (d.agreed !== d.cases)
      failures.push(`${d.cases - d.agreed} cases differ through the two routes`);
    for (const p of R25.R25_PROGRAMS)
      if (!d.printed.includes(`${p}@rc`)) failures.push(`${p} doesn't class-print in rc`);
    const st = await R25.r25Steps(accel, jobs);
    failures.push(...st.failures);
    if (st.cases === 0) failures.push("no case of corpus/rc/rc_steps_r25.ts ran");
    const tr = await R25.r25Trap(accel, jobs);
    failures.push(...tr.failures);
    if (tr.cases === 0) failures.push("no case of corpus/trap/wide_add.ts ran");
    report({
      box: "69. R25 (3.5, 4.4, D39, D41): rc class printing's strings and freeing with the same steps: freeAlloc taking the block's step of an object at the cursor with every slot visited, and its last step in place; callRelease's chain with the release functions that do something first; strIndexOf's search JsStr's own over the two strings' runs, a code point's length read through unit, a substring's common ways inlined, a join's one-unit copies stored, equality's quick answers inlined; and the AArch64 backend's add of two values held from 32 bits or fewer without its tests at -O1 and -O2; corpus/lower/r25/r25_strings.ts (searches, splits, joins, code points, substrings and equality over views and flat strings) and r25_free.ts (arrays of one- and two-slot objects and a split's words let go of, some kept) agree with V8 natively and through both routes with class printing forced in rc and leak at -O0 and -O2, and the printed TSL on V8 and JSC with the source; corpus/rc/rc_steps_r25.ts's step counts at budgets 1 to 7, 32 and 33, pinned with @tsl/gc as it was before R25, natively and on the host; corpus/trap/wide_add.ts natively at -O0 and -O2 (tools/r25-tests.ts)",
      ok: failures.length === 0 && hvf.ok,
      detail: `${d.agreed}/${d.cases} cases the same as V8 and through both routes, class-printed: ${d.printed.join(", ")}; steps ${st.agreed}/${st.cases}; wide adds ${tr.agreed}/${tr.cases}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 70. R25's bugs, each caught (SPEC 8.3's fault rule: a bug not in the build is a harness failure, never caught).
  M.unit("70", async () => {
    const R25 = timedModule("r25", await import("../r25-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of R25.R25_FAULTS) {
      const x = await R25.r25Fault(f, accel, jobs);
      rows.push(`${f.what}: ${caughtText(x)}`);
      if (x.answers === 0) failures.push(`${f.name} wasn't caught: ${x.first}`);
    }
    report({
      box: `70. R25: each of ${R25.R25_FAULTS.length} bugs is caught by a wrong answer, with how many cases caught it: freeAlloc giving the cursor's block back without its step, or leaving the cursor on it, or going on past slot 0 with no step left (each by corpus/rc's pinned step counts or wrong answers), callRelease's chain in the order shown against the numbers stores register, the backend's add left without its tests with a 64-bit operand (corpus/trap natively at -O2), a code point's second unit read two on, indexFrom matching against the next unit, a view's substring copied a unit late, equality comparing against the next unit, and a join's one-unit copy stored a unit early (tools/r25-tests.ts, over corpus/lower/r25, r24, r22 and r21 in rc at -O2, and corpus/rc/rc_steps*.ts natively)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 71. R26: scans' checks and loads proved or moved by the optimiser, and charCodeAt printed in integers in rc.
  M.unit("71", async () => {
    const R26 = timedModule("r26", await import("../r26-tests.ts"));
    const failures: string[] = [];
    const d = await R26.r26Dual([accel], jobs);
    failures.push(...d.failures);
    if (d.cases === 0) failures.push("no case of R26's programs ran");
    if (d.agreed !== d.cases)
      failures.push(`${d.cases - d.agreed} cases differ through the two routes`);
    for (const p of R26.R26_PROGRAMS)
      if (!d.printed.includes(`${p}@rc`)) failures.push(`${p} doesn't class-print in rc`);
    report({
      box: "71. R26 (4.3, 3.5, D44, D73): range.ts reading a signed loop test as the unsigned one where its smaller side isn't negative, deciding a float compare of two converted i32s from the integers as known where it is, and reaching a target through its own zext; -O1's loopbounds taking `k < 0` as false for a signed test's index; -O2's loop copying in rounds with value numbering between, so a peeled first turn's test is unswitched and each copy peeled; -O1's inliner keeping a loop's block in the loop once a call in it is inlined; charCodeAt with an i32 index printed in integers in rc; and @tsl/gc's fresh slot's size by a wrapping shift: corpus/lower/r26/r26_scans.ts (scans of flat strings and views from below 0, 0 and past the end to the length, one short and one past, by its own length and another's; arrays the same, with the lowering's pinned traps; tests by a constant in a loop) agrees with V8 natively and through both routes with class printing forced in rc and leak at -O0, -O1 and -O2, and the printed TSL on V8 and JSC with the source (tools/r26-tests.ts)",
      ok: failures.length === 0 && hvf.ok,
      detail: `${d.agreed}/${d.cases} cases the same as V8 and through both routes, class-printed: ${d.printed.join(", ")}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 72. R26's bugs, each caught (SPEC 8.3's fault rule: a bug not in the build is a harness failure, never caught).
  M.unit("72", async () => {
    const R26 = timedModule("r26", await import("../r26-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of R26.R26_FAULTS) {
      const x = await R26.r26Fault(f, accel, jobs);
      rows.push(`${f.what}: ${caughtText(x)}`);
      if (x.answers === 0) failures.push(`${f.name} wasn't caught: ${x.first}`);
    }
    report({
      box: `72. R26: each of ${R26.R26_FAULTS.length} bugs is caught by a wrong answer, with how many cases caught it: range.ts reading a signed test as unsigned whatever its sides' signs, or deciding a float compare from the integers the other way round, -O2's later copying rounds sending an unswitched loop's copies each the other's way (each at -O2), -O1's loopbounds taking \`k < c\` as false for any constant (at -O1), charCodeAt printed in integers taking the length as in range, and @tsl/gc's fresh slot cut half its size (tools/r26-tests.ts, over corpus/lower/r26 and r25 in rc and leak, @tsl/gc's over r26, r25 and r24 in rc at -O2 and corpus/rc/rc_steps*.ts natively)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 73. R27: fresh-allocation separation, where it applies and where it must not.
  M.unit("73", async () => {
    const R27 = timedModule("r27", await import("../r27-tests.ts"));
    const failures: string[] = [];
    const sh = await R27.r27Shapes();
    failures.push(...sh.failures);
    const n = await R27.r27Native(accel, jobs);
    failures.push(...n.failures);
    if (n.cases === 0) failures.push("no case of corpus/r27 ran");
    const d = await R27.r27Dual([accel], jobs);
    failures.push(...d.failures);
    if (d.cases === 0) failures.push("no case of corpus/lower/r27 ran");
    if (d.agreed !== d.cases)
      failures.push(`${d.cases - d.agreed} cases differ through the two routes`);
    for (const mode of ["rc", "leak"])
      if (!d.printed.includes(`${R27.R27_LOWER_DIR}/r27_fill.ts@${mode}`))
        failures.push(`r27_fill.ts doesn't class-print in ${mode}`);
    report({
      box: "73. R27 (3.5, 4.3, D44, D73, D77): fresh-allocation separation: tslc proves a class's u64 field holds only blocks no object can be in (fresh from the allocator, 0, or moved from such a field, and every address worked out from one used only by the class's own element reads and writes, copies, fills and the allocator's give-back), and the optimiser takes a store into such a block, or a call that writes only such blocks and its own frame, as unable to change any object's field: r27_sep.ts's Buf and r27_sep_neg.ts's Arr separated, Escapes (its block's address given outside), Kept (stored in another object's field) and Ref (set from outside) refused, @tsl/jsrt's JsArray separated in a lowered map in rc and leak, JsMap's growth (`steps`, `link`) and r27_sep.ts's fills changed by it at -O2, and each of r27_sep_neg.ts's functions the same build with it on and off at -O1 and -O2, so every check it had stays; corpus/r27 natively at -O0, -O1 and -O2 against V8 and JSC; corpus/lower/r27 (maps grown while moving, arrays filled while one grows or is cut) through both routes with class printing forced in rc and leak at -O0, -O1 and -O2 against V8, and the printed TSL on V8 and JSC (tools/r27-tests.ts)",
      ok: failures.length === 0 && hvf.ok,
      detail: `${sh.rows.join("; ")}; natively ${n.agreed}/${n.cases} (${n.rows.join(", ")}); through both routes ${d.agreed}/${d.cases}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 74. R27's bugs, each caught (SPEC 8.3's fault rule: a bug not in the build is a harness failure, never caught).
  M.unit("74", async () => {
    const R27 = timedModule("r27", await import("../r27-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of R27.R27_FAULTS) {
      const x = await R27.r27Fault(f, accel, jobs);
      rows.push(`${f.name}: ${caughtText(x)}`);
      if (x.answers === 0) failures.push(`${f.name} wasn't caught: ${x.first}`);
    }
    report({
      box: `74. R27: each of ${R27.R27_FAULTS.length} bugs is caught by a wrong answer, with how many cases caught it: a call's write summary missing a write (a call that cuts a length taken as writing only blocks, so get's check after it goes), an alias the separation misses (every 64-bit word loaded taken as a block's, so a raw store through an address read from a field doesn't change a view's word), and a check removed where a reference escapes (tslc letting a block's address leave its class, so a view's store into the block isn't seen and a bound kept there is read stale), each over corpus/r27 natively at -O1 and -O2 against V8 (tools/r27-tests.ts)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 75. R28: fresh slots cut in line, references with no tag, init-only module variables borrowed, tails zeroed in line,
  // and the optimiser's no-growth inlining, constant operands, tag folding and second versioning pass.
  M.unit("75", async () => {
    const R28 = timedModule("r28", await import("../r28-tests.ts"));
    const failures: string[] = [];
    const d = await R28.r28Dual([accel], jobs);
    failures.push(...d.failures);
    if (d.cases === 0) failures.push("no case of corpus/lower/r28 ran");
    if (d.agreed !== d.cases)
      failures.push(`${d.cases - d.agreed} cases differ through the two routes`);
    for (const mode of ["rc", "leak"])
      if (!d.printed.includes(`${R28.R28_DIR}/r28_rc.ts@${mode}`))
        failures.push(`r28_rc.ts doesn't class-print in ${mode}`);
    report({
      box: "75. R28 (3.5, 4.3, D44, D73, D78): @tsl/gc's fresh slot cut in line where its page has room (pageCut, make's and tailFast's fast paths); a lowered rc package's heap class's references with no tag, read and counted with no mask, freeing's release call handing each class its own object (callRelease's arms); a module variable only __init writes given to a call borrowed; placeTail's zeroing a word at a time in line up to 128 bytes; the inliner taking a callee no bigger than its call past the growth limit; a tag or'd into a reference's top 16 bits taken off before ref.addr; dominating conditions taking two equal constants as one operand; and -O2's loops the first versioning pass left versioned after the copying rounds: corpus/lower/r28/r28_rc.ts (a module variable overwritten by the call it's given to, literals read in loops, objects and arrays kept fresh across pages, several classes holding each other freed, arrays grown, cut and grown with holes read, one constant index tested and another read with the lowering's pinned traps, a view scanned to and one past its length, eight loops of checked reads) agrees with V8 natively and through both routes with class printing forced in rc and leak at -O0, -O1 and -O2, and the printed TSL on V8 and JSC with the source (tools/r28-tests.ts)",
      ok: failures.length === 0 && hvf.ok,
      detail: `through both routes ${d.agreed}/${d.cases}, ${d.handled} builds class-printed${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 76. R28's bugs, each caught (SPEC 8.3's fault rule: a bug not in the build is a harness failure, never caught).
  M.unit("76", async () => {
    const R28 = timedModule("r28", await import("../r28-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of R28.R28_FAULTS) {
      const x = await R28.r28Fault(f, accel, jobs);
      rows.push(`${f.name}: ${caughtText(x)}`);
      if (x.caught === 0) failures.push(`${f.name} wasn't caught: ${x.first}`);
    }
    report({
      box: `76. R28: each of ${R28.R28_FAULTS.length} bugs is caught by a wrong answer or a trap, with how many cases caught it: callRelease's arm handing a class with no tag its object tagged, every class's references read with no mask, every module variable taken as written only by __init, placeTail's zeroing in line a word short, the in-line cut not testing its page's end, dominating conditions taking any two constants as one operand, ref.addr's tag fold keeping the tag, a callee only the no-growth rule lets in copied without its first store, and the second versioning pass's guard one turn too loose, each over corpus/lower/r28, r26 and r27 in rc through both routes at the bug's levels, @tsl/gc's also over corpus/rc/rc_steps*.ts natively (tools/r28-tests.ts)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 77. R29: the table-links proof, where it applies and where it must not.
  M.unit("77", async () => {
    const R29 = timedModule("r29", await import("../r29-tests.ts"));
    const failures: string[] = [];
    const sh = await R29.r29Shapes();
    failures.push(...sh.failures);
    const n = await R29.r29Native(accel, jobs);
    failures.push(...n.failures);
    if (n.cases === 0) failures.push("no case of corpus/r29 ran");
    report({
      box: "77. R29 (3.5, 4.3, D44, D73, D79): the table-links proof: tslc proves a class's `@tsl.links` claim, that every link its link fields' arrays hold names a position below its bound fields' lengths, over every write to them (a stored link 0, 1, 2^31 up, one read from the group, or a position plus 2 known below every bound; a bound array shorter only where the links are gone; a swap of whole tables; the fields named only in the class's own code; calls that may reach its methods with the claim holding, and nothing known kept across them), and the inliner takes a JsArray read's leading bounds check out of a call it proved in bounds: r29_links.ts's Table and r29_links_neg.ts's Reent proved, BadStore (a link past its key), BadShrink (keys cut with links left), BadSwap (half a table swapped) and Outside (keys cut from outside) refused, r29_links_neg.ts the same build with it on and off at -O1 and -O2, so every check stays, Table's lookups and @tsl/jsrt's JsMap's seek in a lowered map (rc and leak) with no bounds check left at -O2; corpus/r29 natively at -O0, -O1 and -O2 against V8 and JSC (tools/r29-tests.ts)",
      ok: failures.length === 0 && hvf.ok,
      detail: `${sh.rows.join("; ")}; natively ${n.agreed}/${n.cases} (${n.rows.join(", ")})${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 78. R29's bugs, each caught (SPEC 8.3's fault rule: a bug not in the build is a harness failure, never caught).
  M.unit("78", async () => {
    const R29 = timedModule("r29", await import("../r29-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of R29.R29_FAULTS) {
      const x = await R29.r29Fault(f, accel, jobs);
      rows.push(`${f.name}: ${caughtText(x)}`);
      if (x.caught === 0) failures.push(`${f.name} wasn't caught: ${x.first}`);
    }
    report({
      box: `78. R29: each of ${R29.R29_FAULTS.length} bugs is caught by a wrong answer or a trap, with how many cases caught it: tslc's rule letting a stored link past a bound through, missing a bound array getting shorter or half a table swapped, and missing a claimed field named outside its class, and the inliner taking every JsArray read's leading check out, not only those proved in bounds, each over corpus/r29 natively at -O1 and -O2 against V8 (tools/r29-tests.ts)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 79. R30: making placed where the object's made, rc strings' copies, and values split around cold calls.
  M.unit("79", async () => {
    const R30 = timedModule("r30", await import("../r30-tests.ts"));
    const failures: string[] = [];
    const sh = await R30.r30Shapes();
    failures.push(...sh.failures);
    const n = await R30.r30Native(accel, jobs);
    failures.push(...n.failures);
    if (n.cases === 0) failures.push("no case of corpus/r30 ran");
    const d = await R30.r30Dual([accel], jobs);
    failures.push(...d.failures);
    if (d.cases === 0) failures.push("no case of corpus/lower/r30 ran");
    report({
      box: "79. R30 (3.5, 4.3, 4.4, D44, D75): @tsl/gc's make and makeTail find only the slot out of line and place the object in line, and with the collector cut a fresh slot from its chunk in line, the same steps (D39); scalar replacement takes a copy out of a frame slot, a new object placed in its slot, as stores of its fields (at -O1 that alone, at -O2 with a fill a word at a time in any dominating block); `rc` class printing's jsStrZeroed tests its length once, strCopy is JsStr's copyFrom and strRepeat's loop its repeatFrom; and at -O1 and -O2 a value live across cold calls only (a call not on every turn of its loop, or outside loops not on every way out) is in a register a call clobbers, stored before each such call and loaded after: r30_strings.ts's jsStrZeroed with no frame slot or copy at -O2 and both with R30's scalar replacement off, @tsl/gc's freeAlloc saving fewer callee-saved registers split than not at -O1 and -O2, r30_split.ts's many with a cold call and outer none; corpus/r30 natively at -O0, -O1 and -O2 against V8 and JSC; corpus/lower/r30 through the dual route with class printing forced in rc and leak at -O0 and -O2 (tools/r30-tests.ts)",
      ok: failures.length === 0 && hvf.ok,
      detail: `${sh.rows.join("; ")}; natively ${n.agreed}/${n.cases} (${n.rows.join(", ")}); dual ${d.agreed}/${d.cases}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 80. R30's bugs, each caught (SPEC 8.3's fault rule: a bug not in the build is a harness failure, never caught).
  M.unit("80", async () => {
    const R30 = timedModule("r30", await import("../r30-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of R30.R30_FAULTS) {
      const x = await R30.r30Fault(f, accel, jobs);
      rows.push(`${f.name}: ${caughtText(x)}`);
      if (x.caught === 0) failures.push(`${f.name} wasn't caught: ${x.first}`);
    }
    report({
      box: `80. R30: each of ${R30.R30_FAULTS.length} bugs is caught by a wrong answer or a trap, with how many cases caught it: scalar replacement's copy storing the fill's zero for each field, a value split around a cold call never loaded back, stored after the call's arguments are moved, or given a callee-saved register the prologue doesn't save, JsStr's repeatFrom copying each doubling a unit short, and tailFast taking a free slot off its list without moving the list on, each over corpus/r30 natively (at -O1 and -O2 for the backend's) or corpus/lower/r30 through the dual route at -O2, against V8 (tools/r30-tests.ts)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 81. R31: the cold-call split's quick ways out, and @tsl/gc's chunks from the page source.
  M.unit("81", async () => {
    const R31 = timedModule("r31", await import("../r31-tests.ts"));
    const failures: string[] = [];
    const sh = await R31.r31Shapes();
    failures.push(...sh.failures);
    const n = await R31.r31Native(accel, jobs);
    failures.push(...n.failures);
    if (n.cases === 0) failures.push("no case of corpus/r31 ran");
    const d = await R31.r31Dual([accel], jobs);
    failures.push(...d.failures);
    if (d.cases === 0) failures.push("no case of corpus/lower/r31 ran");
    report({
      box: "81. R31 (3.5, 4.4, D39, D41, D80): at -O1 and -O2 a block that makes only the constants it returns is a quick way out of a function, as an empty one is, so a call past it isn't cold: r31_split.ts's quick and quickF with no cold call, and each with one with R31 off (TMK_R31_OFF=split); @tsl/gc's chunks taken from the page source straight (chunkPages, 3.5), the same pages the heap gave; corpus/r31 natively at -O0, -O1 and -O2 against V8 and JSC; corpus/lower/r31 through the dual route with class printing forced in rc at -O0 and -O2 (tools/r31-tests.ts)",
      ok: failures.length === 0 && hvf.ok,
      detail: `${sh.rows.join("; ")}; natively ${n.agreed}/${n.cases} (${n.rows.join(", ")}); dual ${d.agreed}/${d.cases}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 82. R31's bugs, each caught (SPEC 8.3's fault rule: a bug not in the build is a harness failure, never caught).
  M.unit("82", async () => {
    const R31 = timedModule("r31", await import("../r31-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of R31.R31_FAULTS) {
      const x = await R31.r31Fault(f, accel, jobs);
      rows.push(`${f.name}: ${caughtText(x)}`);
      if (x.caught === 0) failures.push(`${f.name} wasn't caught: ${x.first}`);
    }
    report({
      box: `82. R31: each of ${R31.R31_FAULTS.length} bugs is caught by a wrong answer or a trap, with how many cases caught it: @tsl/gc's chunkPages giving every chunk one page, over corpus/lower/r31 through the dual route at -O2, against V8 (tools/r31-tests.ts)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 83. R32: range.ts's facts from a float compare's edge, `s[x]` and the one-unit table read printed nested in `rc`, and
  // freeAlloc's tests in a new order.
  M.unit("83", async () => {
    const R32 = timedModule("r32", await import("../r32-tests.ts"));
    const failures: string[] = [];
    const sh = await R32.r32Shapes();
    failures.push(...sh.failures);
    const d = await R32.r32Dual([accel], jobs);
    failures.push(...d.failures);
    if (d.cases === 0) failures.push("no case of corpus/lower/r32 ran");
    const st = await R32.r32Steps(accel, jobs);
    failures.push(...st.failures);
    if (st.cases === 0) failures.push("no case of corpus/rc's rc_steps programs ran");
    report({
      box: "83. R32 (3.5, 4.3, 4.5, D39, D44, D73): range.ts's facts from a float compare's edge (a float not NaN, at least 0 and below a converted i32 n or a constant makes its ToInt32 that range, below n a fact `toint32(x) <= n - 1`), so check elimination takes a unit read's test of its index against the length by proof and makes the ToInt32 the saturating conversion; class printing's `s[x]` in `rc` as three tests one inside the other, and the one-unit string's table read the same, and a string literal read where it's used rather than held in a counted temporary; @tsl/gc's freeAlloc testing a one-slot object's ways in two tests: r32_index.ts's scan through the TSL route in rc at -O2 with a saturating ToInt32 and fewer index tests, and with R32 off (TMK_R32_OFF=range,index,units,stable) none and more; corpus/lower/r32 through the dual route with class printing forced in rc and leak at -O0, -O1 and -O2; corpus/rc's rc_steps programs natively in rc (tools/r32-tests.ts)",
      ok: failures.length === 0 && hvf.ok,
      detail: `${sh.rows.join("; ")}; dual ${d.agreed}/${d.cases}; rc_steps ${st.agreed}/${st.cases}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 84. R32's bugs, each caught (SPEC 8.3's fault rule: a bug not in the build is a harness failure, never caught).
  M.unit("84", async () => {
    const R32 = timedModule("r32", await import("../r32-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of R32.R32_FAULTS) {
      const x = await R32.r32Fault(f, accel, jobs);
      rows.push(`${f.name}: ${caughtText(x)}`);
      if (x.caught === 0) failures.push(`${f.name} wasn't caught: ${x.first}`);
    }
    report({
      box: `84. R32: each of ${R32.R32_FAULTS.length} bugs is caught by a wrong answer or a trap, with how many cases caught it: range.ts taking a float's \`x <= n\` as \`x < n\`, every float as an integer, or a failed compare's opposite where the float may be NaN, and check elimination making every ToInt32 the saturating conversion, each over corpus/lower/r32 and corpus/lower/r26 through the dual route at -O2 in rc and leak; \`s[x]\` printed with the length taken as in range, and any module state's read taken as a literal's (read after a later operand that assigns it), each over corpus/lower/r32 in rc at -O1 and -O2; freeAlloc taking an object of two slots as one of one, so its second slot is never visited, over corpus/rc's rc_steps programs natively and corpus/lower/r32, r25 and r24 through the dual route at -O2; against V8 (tools/r32-tests.ts)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 85. R33: `stepping` and `spare` set around a release call only where a release function may see them, the release
  // dispatch ordered by how many places make each class, and freeing's loops over an object's slots.
  M.unit("85", async () => {
    const R33 = timedModule("r33", await import("../r33-tests.ts"));
    const failures: string[] = [];
    const sh = await R33.r33Shapes();
    failures.push(...sh.failures);
    const d = await R33.r33Dual([accel], jobs);
    failures.push(...d.failures);
    if (d.cases === 0) failures.push("no case of corpus/lower/r33 ran");
    const sd = await R33.r33Std(accel, jobs);
    failures.push(...sd.failures);
    if (sd.cases === 0) failures.push("no case of corpus/std/rc_r33_*.ts ran");
    const st = await R33.r33Steps(accel, jobs);
    failures.push(...st.failures);
    if (st.cases === 0) failures.push("no case of corpus/rc's rc_steps programs ran");
    report({
      box: "85. R33 (3.5, D39, D41): @tsl/gc sets `stepping` and `spare` around a release call only where a release function may read or write them (`releasesTouch`, answered over the whole program's call graph once its TIR is built: a function that takes the variable's address, makes an indirect call or calls out of the program may, and so does one that calls one that may); the release dispatch's chain has the classes made in the most places first; freeing's loops over an object's slots test the budget inside and make the object in each call: r33_free.ts's freeAlloc through the TSL route in rc at -O1 writes no `stepping`, and with R33 off (TMK_R33_OFF=touch) writes it; corpus/std/rc_r33_make.ts's, whose release function makes an object, writes it; r33_cycles.ts's chain at -O0 reaches a string's release function first, and with R33 off (TMK_R33_OFF=order) doesn't; corpus/lower/r33 through the dual route with class printing forced in rc and leak at -O0, -O1 and -O2; corpus/std/rc_r33_make.ts, rc_r33_hook.ts and rc_r33_quiet.ts (a make inside a release function, by a direct call and through a function value, and release functions that only visit) natively at -O0 and -O2; rc_r33_quiet.ts's freeAlloc writes neither `stepping` nor `spare`; corpus/rc's rc_steps programs natively in rc (tools/r33-tests.ts)",
      ok: failures.length === 0 && hvf.ok,
      detail: `${sh.rows.join("; ")}; dual ${d.agreed}/${d.cases}; std ${sd.agreed}/${sd.cases}; rc_steps ${st.agreed}/${st.cases}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 86. R33's bugs, each caught (SPEC 8.3's fault rule: a bug not in the build is a harness failure, never caught).
  M.unit("86", async () => {
    const R33 = timedModule("r33", await import("../r33-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of R33.R33_FAULTS) {
      const x = await R33.r33Fault(f, accel, jobs);
      rows.push(`${f.name}: ${caughtText(x)}`);
      if (x.caught === 0) failures.push(`${f.name} wasn't caught: ${x.first}`);
    }
    report({
      box: `86. R33: each of ${R33.R33_FAULTS.length} bugs is caught by a wrong answer or a trap, with how many cases caught it: the call graph's answer taking each function's own instructions alone, taking an indirect call as reaching nothing, or every answer false; the numbers stores register in R25's order against the chain in R33's; freeSteps' loop over an object's slots without its budget test; freeAlloc's slot 0 visit not counting its step where no release function sees \`spare\`; each over corpus/rc's rc_steps programs natively, corpus/std/rc_r33_make.ts, rc_r33_hook.ts and rc_r33_quiet.ts natively at -O2, and corpus/lower/r33 through the dual route at -O2; against V8 (tools/r33-tests.ts)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 87. R34: batched frees (a run of waiting leaves given back in one pass, in line where it's all there is), leaves made
  // in their store's leaf entry, and leaves handed to freeing through what a release function returns.
  M.unit("87", async () => {
    const R34 = timedModule("r34", await import("../r34-tests.ts"));
    const failures: string[] = [];
    const sh = await R34.r34Shapes();
    failures.push(...sh.failures);
    const d = await R34.r34Dual([accel], jobs);
    failures.push(...d.failures);
    if (d.cases === 0) failures.push("no case of corpus/lower/r34 ran");
    const sd = await R34.r34Std(accel, jobs);
    failures.push(...sd.failures);
    if (sd.cases === 0) failures.push("no case of corpus/std/rc_r34_leaves.ts ran");
    const st = await R34.r34Steps(accel, jobs);
    failures.push(...st.failures);
    if (st.cases === 0) failures.push("no case of corpus/rc's rc_steps programs ran");
    report({
      box: "87. R34 (3.5, D39's R34): @tsl/gc gives a run of waiting leaves back in one pass, a step each with the budget brought down once (leafRun), in line at an allocation where that run is all its freeing is (freeLeaves); an object whose references are all null when it's made and stay so is made in its store's leaf entry (`makeTailLeaf`, which tslc's expansion picks: a flat string), so freeing gives it back as one step with no call; and a leaf whose last count a release function drops is handed to freeing through what that function returns (`handLeaf`, `RC_HANDED`, a room through `trimHand`), not through `spare`: r34_leaves.ts through the TSL route in rc at -O1 has a leaf entry and its freeAlloc writes no `spare`, and with R34 off (TMK_R34_OFF=leaf,hand) neither holds; corpus/lower/r34 through the dual route with class printing forced in rc at -O0, -O1 and -O2 (sized for a small memory, so not leak); corpus/std/rc_r34_leaves.ts (leaves made and handed by hand, each allocation's steps and live count at budgets from 1, and handing a leaf back taking visitLeaf's steps exactly) natively at -O0 and -O2; corpus/rc's rc_steps programs natively in rc (tools/r34-tests.ts)",
      ok: failures.length === 0 && hvf.ok,
      detail: `${sh.rows.join("; ")}; dual ${d.agreed}/${d.cases}; std ${sd.agreed}/${sd.cases}; rc_steps ${st.agreed}/${st.cases}${skipNote}`,
      failures: failures.slice(0, 40),
    });
  });

  // 88. R34's bugs, each caught (SPEC 8.3's fault rule: a bug not in the build is a harness failure, never caught).
  M.unit("88", async () => {
    const R34 = timedModule("r34", await import("../r34-tests.ts"));
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of R34.R34_FAULTS) {
      const x = await R34.r34Fault(f, accel, jobs);
      rows.push(`${f.name}: ${caughtText(x)}`);
      if (x.caught === 0) failures.push(`${f.name} wasn't caught: ${x.first}`);
    }
    report({
      box: `88. R34: each of ${R34.R34_FAULTS.length} bugs is caught by a wrong answer or a trap, with how many cases caught it: a run of leaves freeing one past the budget; a run taking an object of another store, one with slots; a handed leaf taken and never given back; a handed leaf given back twice; the expansion making every tailed object with slots in its leaf entry; each over corpus/rc's rc_steps programs natively, corpus/std/rc_r34_leaves.ts natively at -O2, and corpus/lower/r34 through the dual route in rc at -O2; against V8 (tools/r34-tests.ts)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  M.vms(
    "8",
    "8. No QEMU process of this run is left, and the owner's UTM and QEMU processes were only observed",
    true,
  );
}
