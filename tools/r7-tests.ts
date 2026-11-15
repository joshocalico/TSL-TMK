// R7's tests (SPEC M5's R7 record, D73, D75): the -O1 bounds checks a loop's own test proves (compiler/tir/passes/
// loopbounds.ts), and an explicit null check left to the next load's fault (compiler/backend-aarch64/shape.ts's
// implicitNullChecks), each with the bug put into it caught.
//
//   node tools/r7-tests.ts [--accel hvf|tcg]
import { buildImage } from "../compiler/backend-aarch64/image.ts";
import { FuncBuilder } from "../compiler/tir/build.ts";
import { canonicalize, type Func, type Module } from "../compiler/tir/ir.ts";
import { optFromEnv, optimizeModule } from "../compiler/tir/passes/manager.ts";
import { printModule } from "../compiler/tir/text.ts";
import { verifyModule } from "../compiler/tir/verify.ts";
import { Driver } from "./native-driver.ts";
import type { R2Fault } from "./r2-tests.ts";
import { type Accel, qemuRun } from "./qemu-run.ts";

const NULL_TRAP = { id: 1, kind: "null", code: 6, loc: "r7:1:1" };
const BOUNDS_TRAP = { id: 2, kind: "bounds", code: 2, loc: "r7:2:1" };
const OVERFLOW_TRAP = { id: 3, kind: "overflow", code: 1, loc: "r7:3:1" };

/** `p!.field` as lowering makes it: an explicit check, then (unless `storeFirst`) a load at p + 8 first. */
function nullRead(name: string, storeFirst: boolean): Func {
  const b = new FuncBuilder(name, ["ptr"], ["i32"]);
  const p = b.params[0]!;
  const bad = b.block();
  const ok = b.block();
  b.brif(b.op("icmp.eq.ptr", [p, b.iconst("ptr", 0)], "i32"), bad, ok);
  b.at(bad);
  b.term({ k: "trap", id: NULL_TRAP.id });
  b.at(ok);
  if (storeFirst) b.store("i32", b.global("seen"), b.i32(7));
  const v = b.load("i32", b.gep(p, b.ix(0), 1, 8));
  b.ret([v]);
  return b.finish();
}

/** The program: the two reads, and a case for each through null. */
function nullModule(): Module {
  const cases: Func[] = [];
  for (const [name, callee] of [
    ["case_read", "nullread"],
    ["case_store", "storeread"],
  ] as const) {
    const b = new FuncBuilder(name, [], []);
    // Null from memory, so no level folds the check away as a constant's.
    b.call(callee, [b.load("ptr", b.global("np"))], ["i32"]);
    b.ret();
    cases.push(b.finish());
  }
  return canonicalize({
    sigs: [],
    globals: [
      { name: "seen", size: 8, align: 8, section: "data" },
      { name: "np", size: 8, align: 8, section: "data" },
    ],
    funcs: [nullRead("nullread", false), nullRead("storeread", true), ...cases],
    traps: [NULL_TRAP],
    externs: [],
  });
}

/** The program at a level, through the optimiser as tslc's would go (the backend's shape follows `Module.opt`). */
function atLevel(m: Module, level: 0 | 1 | 2): Module {
  if (level === 0) return m;
  return optimizeModule(m, { ...optFromEnv(level), verifyEach: true }).module;
}

function nullImage(
  m: Module,
  main: (b: FuncBuilder) => void,
): { bytes: Uint8Array; listed: number } {
  const drv = new Driver(m);
  const b = new FuncBuilder("__tmk_main", [], []);
  main(b);
  drv.funcs.push(b.finish());
  drv.trapMessages({});
  const img = buildImage({
    module: m,
    driverFuncs: drv.funcs,
    driverGlobals: drv.globals,
    ramBytes: 256 * 1024 * 1024,
  });
  const at = img.symbols.get("g:__rt_null_pcs");
  const listed =
    at !== undefined && at + 8 <= img.bytes.length
      ? Number(new DataView(img.bytes.buffer).getBigUint64(at, true))
      : 0;
  return { bytes: img.bytes, listed };
}

/**
 * R7's programs that print with classes now (each blocked before by an optional scalar field, a typed-array field, or a
 * Map or Set crossing an export), each built through both routes by the differential and run on V8 and JSC by the third.
 */
export const R7_PROGRAMS = [
  "corpus/lower/pos/store_target_order.ts", // an optional field
  "corpus/lower/pos/destructure_spread.ts", // an optional field crossing an export
  "corpus/lower/exc/class_init_order.ts", // optional fields
  "corpus/lower/strmap/app_lru.ts", // an optional field
  "corpus/lower/pos/class_struct.ts", // a typed-array field
  "corpus/lower/maps/move_ops.ts", // maps and sets crossing exports
];

/** The bugs put into R7's printing, each caught by the dual route on the program that needs it. */
export const R7_FAULTS: R2Fault[] = [
  {
    name: "opt-field-flag",
    what: "every store to an optional field's flag says the value is there, so an absent one reads as its zero",
    transform:
      "an optional scalar printed as a bool flag field and a value field (emit-tsl.ts's optFieldStore)",
    where: "printer",
    dirs: ["corpus/lower/pos"],
    modes: ["leak", "manual"],
    classes: true,
    only: "store_target_order",
  },
  {
    name: "arr-field-swap",
    what: "a typed array's pointer and length each stored where the other goes in its field's runtime class",
    transform:
      "a typed-array field held as a runtime class of its pointer and length (emit-tsl.ts's arrFieldStore)",
    where: "printer",
    dirs: ["corpus/lower/pos"],
    modes: ["leak", "manual"],
    classes: true,
    only: "class_struct",
  },
  {
    name: "map-layout-swap",
    what: "JsMap's layout published to a native caller with its keys' table where its values' is",
    transform:
      "a crossing map's layout as tslc laid JsMap out (tslc.ts's jsMapLayout), which the native caller reads",
    where: "printer",
    dirs: ["corpus/lower/maps"],
    modes: ["leak", "manual"],
    classes: true,
    only: "move_ops",
  },
];

export interface R7Row {
  what: string;
  ok: boolean;
  detail: string;
}

/**
 * The null check left to the load: through null it's trap 6 inside a case (TMK:C n T 6) and outside one (TMK:PANIC trap 6)
 * at every level, as the check's own trap was at -O0, and at -O1 and -O2 the check really is gone (the load is listed). The
 * injected bug (`b3-null-past-store`) lets a store run before the faulting load: -O0 trapped before it, so what the store
 * wrote shows after the case.
 */
export async function nullFaultTests(accel: Accel): Promise<R7Row[]> {
  const rows: R7Row[] = [];
  const base = nullModule();
  for (const level of [0, 1, 2] as const) {
    const m = atLevel(base, level);
    // Outside a try: a panic with code 6, as the check's trap is.
    {
      const img = nullImage(m, (b) => {
        b.call("nullread", [b.iconst("ptr", 0)], ["i32"]);
        b.ret();
      });
      const r = await qemuRun({
        name: `r7/null-outside-O${level}-${accel}`,
        image: img.bytes,
        accel,
        timeoutMs: 20_000,
      });
      if (r.skipped) return [{ what: "HVF unavailable", ok: false, detail: "SKIPPED" }];
      const line = r.lines.find((l) => l.startsWith("TMK:PANIC") || l.startsWith("TMK:FATAL"));
      const listedOk = level === 0 ? img.listed === 0 : img.listed >= 1;
      // A reference that isn't null but faults (address 8, as only a `manual` or unsafe program could make): the check
      // passes at -O0 and the load faults, which outside a case is the full report; at -O1 and -O2 too, as the fault isn't
      // at the address a null reference's would be.
      const bad = nullImage(m, (b) => {
        b.call("nullread", [b.iconst("ptr", 8)], ["i32"]);
        b.ret();
      });
      const rb = await qemuRun({
        name: `r7/bad-ref-O${level}-${accel}`,
        image: bad.bytes,
        accel,
        timeoutMs: 20_000,
      });
      const fatal = rb.lines.find((l) => l.startsWith("TMK:FATAL") || l.startsWith("TMK:PANIC"));
      rows.push({
        what: `-O${level}: a non-null reference that faults is still TMK:FATAL, not trap 6`,
        ok: rb.status === "fatal" && /far=0000000000000010/.test(fatal ?? ""),
        detail: `${rb.status}: ${fatal ?? "(none)"}`,
      });
      rows.push({
        what: `-O${level}: null outside a case is TMK:PANIC trap 6${level > 0 ? ", the check left to the load" : ""}`,
        ok: r.status === "panic" && /^TMK:PANIC trap 6\b/.test(line ?? "") && listedOk,
        detail: `${r.status}: ${line ?? "(none)"}; ${img.listed} loads listed`,
      });
    }
  }
  return rows;
}

/** Inside cases, at a level and with a bug or none: each case's trap line, then what `seen` holds. */
async function caseRun(
  level: 0 | 1 | 2,
  accel: Accel,
  fault: string | undefined,
): Promise<{ lines: string[]; listed: number; status: string; skipped: boolean }> {
  // A bug given here is put in; otherwise whatever the environment puts in (opt-tests.ts's faultsCaught) stays.
  const was = process.env.TMK_OPT_FAULT;
  if (fault !== undefined) process.env.TMK_OPT_FAULT = fault;
  try {
    const m = atLevel(nullModule(), level);
    const drv = new Driver(m);
    const after = new FuncBuilder("__r7_after", [], []);
    const v = after.load("i32", after.global("seen"));
    after.call("__rt_udec", [after.op("zext.i64", [v], "i64")]);
    after.call("__rt_nl", []);
    after.ret();
    drv.funcs.push(after.finish());
    drv.main(
      [
        { run: "case_read", after: "__r7_after" },
        { run: "case_store", after: "__r7_after" },
      ],
      () => undefined,
    );
    drv.trapMessages({});
    const img = buildImage({
      module: m,
      driverFuncs: drv.funcs,
      driverGlobals: drv.globals,
      ramBytes: 256 * 1024 * 1024,
    });
    const at = img.symbols.get("g:__rt_null_pcs");
    const listed =
      at !== undefined && at + 8 <= img.bytes.length
        ? Number(new DataView(img.bytes.buffer).getBigUint64(at, true))
        : 0;
    const r = await qemuRun({
      name: `r7/null-cases-O${level}${fault !== undefined ? `-${fault}` : ""}-${accel}`,
      image: img.bytes,
      accel,
      timeoutMs: 20_000,
    });
    return {
      lines: r.lines.filter((l) => /^TMK:C |^\d+$/.test(l)),
      listed,
      status: r.status,
      skipped: r.skipped === true,
    };
  } finally {
    if (was !== undefined) process.env.TMK_OPT_FAULT = was;
    else delete process.env.TMK_OPT_FAULT;
  }
}

/** Every R7 native test of the null check: outside and inside a case at each level, and the bug against -O0. */
export async function nullChecks(accel: Accel): Promise<R7Row[]> {
  const rows = (await nullFaultTests(accel)).filter((r) => r.what !== "");
  if (rows.some((r) => r.detail === "SKIPPED")) return rows;
  const want = await caseRun(0, accel, undefined);
  for (const level of [1, 2] as const) {
    const got = await caseRun(level, accel, undefined);
    rows.push({
      what: `-O${level}: through null inside a case, trap 6 and nothing stored, as at -O0`,
      ok:
        got.status === "done" &&
        want.status === "done" &&
        JSON.stringify(got.lines) === JSON.stringify(want.lines) &&
        want.lines.some((l) => / T 6\b/.test(l)) &&
        got.listed >= 1,
      detail: `${got.lines.join(" | ")} (-O0: ${want.lines.join(" | ")}); ${got.listed} loads listed`,
    });
  }
  const bug = await caseRun(1, accel, "b3-null-past-store");
  rows.push({
    what: "the bug b3-null-past-store (a store before the load passed over) is caught: the store shows after the case",
    ok: bug.status === "done" && JSON.stringify(bug.lines) !== JSON.stringify(want.lines),
    detail: `${bug.lines.join(" | ")} against -O0's ${want.lines.join(" | ")}`,
  });
  return rows;
}

/**
 * The -O1 loop bounds proof on hand-made TIR (no QEMU): the shapes it takes, those it mustn't, and its injected bug. Each
 * function is `for (k = start; k <test> n; k += step) a[k]`, its check `bounds.chk` or a compare and branch to a trap.
 */
export function loopBoundsCases(): R7Row[] {
  type Shape = {
    what: string;
    kt: "i32" | "ix";
    test: string; // icmp predicate, k against m
    start: number;
    step: "chk" | "plain1" | "plain2";
    trunc: boolean; // m = trunc.i32 n, else m = n
    form: "bounds" | "branch";
    checkLen: "same" | "other"; // the check's length: the test's, or another value
    removed: boolean; // what -O1 does
    removedByBug?: boolean; // what the injected bug does
  };
  const shapes: Shape[] = [
    {
      what: "JsArray.get in a for…of: i32 k < trunc(len), compare and branch",
      kt: "i32",
      test: "slt",
      start: 0,
      step: "chk",
      trunc: true,
      form: "branch",
      checkLen: "same",
      removed: true,
    },
    {
      what: "usize k < len, bounds.chk",
      kt: "ix",
      test: "ult",
      start: 0,
      step: "chk",
      trunc: false,
      form: "bounds",
      checkLen: "same",
      removed: true,
    },
    {
      what: "plain k + 1, signed test",
      kt: "i32",
      test: "slt",
      start: 0,
      step: "plain1",
      trunc: true,
      form: "bounds",
      checkLen: "same",
      removed: true,
    },
    {
      what: "a negative start, signed test: kept",
      kt: "i32",
      test: "slt",
      start: -1,
      step: "chk",
      trunc: true,
      form: "branch",
      checkLen: "same",
      removed: false,
    },
    {
      what: "plain k + 2, signed test (could wrap): kept",
      kt: "i32",
      test: "slt",
      start: 0,
      step: "plain2",
      trunc: true,
      form: "branch",
      checkLen: "same",
      removed: false,
    },
    {
      what: "k <= len: kept (the bug drops it)",
      kt: "ix",
      test: "ule",
      start: 0,
      step: "chk",
      trunc: false,
      form: "bounds",
      checkLen: "same",
      removed: false,
      removedByBug: true,
    },
    {
      what: "another length in the check: kept",
      kt: "ix",
      test: "ult",
      start: 0,
      step: "chk",
      trunc: false,
      form: "bounds",
      checkLen: "other",
      removed: false,
    },
  ];
  const rows: R7Row[] = [];
  for (const s of shapes) {
    const make = (): Module => {
      const b = new FuncBuilder("f", ["ix", "ix"], ["i64"], ["export"]);
      const [n, other] = b.params as [number, number];
      const head = b.block([s.kt, "i64"]);
      const body = b.block();
      const exit = b.block();
      const trapB = b.block();
      b.br(head, [b.iconst(s.kt, s.start), b.i64(0)]);
      b.at(head);
      const [k, acc] = head.params as [number, number];
      const m = s.trunc && s.kt === "i32" ? b.op("trunc.i32", [n], "i32") : n;
      b.brif(b.op(`icmp.${s.test}.${s.kt}`, [k, m], "i32"), body, exit);
      b.at(body);
      const idx = s.kt === "i32" ? b.op("zext.ix", [k], "ix") : k;
      const len = s.checkLen === "same" ? n : other;
      let i = idx;
      if (s.form === "bounds") {
        i = b.raw(
          "bounds.chk",
          [
            { t: "v", id: idx },
            { t: "v", id: len },
            { t: "trap", id: 2 },
          ],
          ["ix"],
        )[0]!;
      } else {
        const go = b.block();
        b.brif(b.op("icmp.uge.ix", [idx, len], "i32"), trapB, go);
        b.at(go);
      }
      const acc2 = b.op(
        "add.i64",
        [acc, b.op("zext.i64", [b.op("trunc.i32", [i], "i32")], "i64")],
        "i64",
      );
      const k2 =
        s.step === "chk"
          ? b.raw(
              `add.chk.${s.test.startsWith("s") ? "s" : "u"}.${s.kt}`,
              [
                { t: "v", id: k },
                { t: "v", id: b.iconst(s.kt, 1) },
                { t: "trap", id: 3 },
              ],
              [s.kt],
            )[0]!
          : b.op(`add.${s.kt}`, [k, b.iconst(s.kt, s.step === "plain1" ? 1 : 2)], s.kt);
      b.br(head, [k2, acc2]);
      b.at(exit);
      b.ret([acc]);
      b.at(trapB);
      b.term({ k: "trap", id: 2 });
      return canonicalize({
        sigs: [],
        globals: [],
        funcs: [b.finish()],
        traps: [NULL_TRAP, BOUNDS_TRAP, OVERFLOW_TRAP],
        externs: [],
      });
    };
    const base = make();
    if (verifyModule(base).length > 0) {
      rows.push({ what: s.what, ok: false, detail: `bad TIR: ${verifyModule(base).join("; ")}` });
      continue;
    }
    // A bounds.chk, or a branch to a block that traps 2.
    const checks = (m: Module): number => {
      const f = m.funcs[0]!;
      const bounds = new Set(m.traps.filter((t) => t.code === 2).map((t) => t.id));
      const trapsTo = new Set(
        f.blocks.filter((b) => b.term.k === "trap" && bounds.has(b.term.id)).map((b) => b.id),
      );
      let n = 0;
      for (const b of f.blocks) {
        n += b.instrs.filter((x) => x.op === "bounds.chk").length;
        if (b.term.k === "brif" && (trapsTo.has(b.term.t.block) || trapsTo.has(b.term.f.block)))
          n++;
      }
      return n;
    };
    // With what the environment puts in too (opt-tests.ts's faultsCaught), so a bug there shows as a wrong count.
    const env = optFromEnv(1).faults ?? [];
    const run = (faults: string[]): number =>
      checks(
        optimizeModule(base, { level: 1, verifyEach: true, faults: [...env, ...faults] }).module,
      );
    const at0 = checks(base);
    const at1 = run([]);
    const bug = run(["loopbounds-inclusive"]);
    const wantBug = s.removedByBug ?? s.removed;
    const ok =
      at0 === 1 && (s.removed ? at1 === 0 : at1 === 1) && (wantBug ? bug === 0 : bug === 1);
    rows.push({
      what: s.what,
      ok,
      detail: `checks: -O0 ${at0}, -O1 ${at1}, -O1 with loopbounds-inclusive ${bug}${ok ? "" : `\n${printModule(base)}`}`,
    });
  }
  return rows;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const accel = (argv.includes("--accel") ? argv[argv.indexOf("--accel") + 1] : "hvf") as Accel;
  const rows = [
    ...loopBoundsCases(),
    ...(argv.includes("--no-native") ? [] : await nullChecks(accel)),
  ];
  for (const r of rows) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.what}: ${r.detail}`);
  process.exitCode = rows.every((r) => r.ok) ? 0 : 1;
}
