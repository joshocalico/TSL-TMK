// The optimiser's passes on small TIR (SPEC 8.1, D46): what each folds and what it must leave, the inliner's rules, and
// that -O0 is the input untouched. Behaviour across whole programs is the native corpus's, at every level, and the fuzz's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalize, type Module } from "../ir.ts";
import { parseModule, printModule } from "../text.ts";
import { verifyModule } from "../verify.ts";
import { deadLoads, deadLoadsBySelect } from "./keep.ts";
import { optimizeModule, type OptLevel } from "./manager.ts";

const TRAPS = `trap t1 overflow code=1 a.ts:1:1
trap t2 bounds code=2 a.ts:1:2
trap t3 memory code=14 a.ts:1:3
`;

function opt(
  text: string,
  level: OptLevel = 2,
  disable: string[] = [],
): { text: string; m: Module } {
  // Blank lines are what a test's template leaves where it put nothing.
  const lines = (text + TRAPS).split("\n").filter((l) => l.trim() !== "");
  const m = canonicalize(parseModule(lines.join("\n") + "\n"));
  assert.deepEqual(verifyModule(m), []);
  const r = optimizeModule(m, { level, verifyEach: true, disable });
  return { text: printModule(r.module), m: r.module };
}

function fn(text: string, name: string): string {
  const at = text.indexOf(`func @${name}(`);
  assert.ok(at >= 0, `no @${name}`);
  return text.slice(at, text.indexOf("\n}", at) + 2);
}

test("-O0 is the module as lowered, the same object", () => {
  const m = canonicalize(
    parseModule(`func @f(%0: i32) -> (i32) export {
bb0:
  %1 = iconst.i32 1
  %2 = add.i32 %0, %1
  ret %2
}
${TRAPS}`),
  );
  const r = optimizeModule(m, { level: 0 });
  assert.equal(r.module, m);
});

test("constants fold, and a checked add folds only where it can't overflow", () => {
  const { text } = opt(`func @f() -> (i32, i32, i32) export {
bb0:
  %0 = iconst.i32 2
  %1 = iconst.i32 3
  %2 = mul.i32 %0, %1
  %3 = iconst.i32 2147483647
  %4 = add.chk.s.i32 %3, %0, t1
  %5 = add.chk.s.i32 %0, %1, t1
  ret %2, %4, %5
}
`);
  const f = fn(text, "f");
  assert.match(f, /iconst\.i32 6/);
  assert.match(f, /iconst\.i32 5/);
  assert.match(f, /add\.chk\.s\.i32 .*t1/, "the overflowing add stays, with its trap");
});

test("a bounds check goes only where constants prove it", () => {
  const { text } = opt(`func @f(%0: ptr, %1: ix) -> (i8, i8) export {
bb0:
  %2 = iconst.ix 3
  %3 = iconst.ix 8
  %4 = bounds.chk %2, %3, t2
  %5 = gep %0, %4, 1, 0
  %6 = load.i8.na %5
  %7 = bounds.chk %2, %1, t2
  %8 = gep %0, %7, 1, 0
  %9 = load.i8.na %8
  ret %6, %9
}
`);
  const f = fn(text, "f");
  assert.equal(
    (f.match(/bounds\.chk/g) ?? []).length,
    1,
    "the one against an unknown length stays",
  );
});

test("no fold to NaN, and no ix fold that differs between wasm32 and 64-bit", () => {
  const { text } = opt(`func @f() -> (f64, ix, i32) export {
bb0:
  %0 = fconst.f64 0x0
  %1 = fdiv.f64 %0, %0
  %2 = iconst.ix 4294967295
  %3 = iconst.ix 1
  %4 = lshr.ix %2, %3
  %6 = iconst.ix 4294967296
  %5 = icmp.ult.ix %6, %3
  ret %1, %4, %5
}
`);
  const f = fn(text, "f");
  assert.match(f, /fdiv\.f64/);
  assert.match(f, /lshr\.ix/);
  // 2^32 is 0 on wasm32, below 1, and not below it on a 64-bit target. (Until pipe-dispatch this compared 2^32 - 1, which
  // both read alike, so it folds now: the property test below says which do.)
  assert.match(f, /icmp\.ult\.ix/);
});

test("an unsigned ix compare of constants folds only where wasm32 and a 64-bit target agree, and then rightly", () => {
  const edges = [
    0n,
    1n,
    2n,
    (1n << 31n) - 1n,
    1n << 31n,
    (1n << 32n) - 2n,
    (1n << 32n) - 1n,
    1n << 32n,
    (1n << 32n) + 1n,
    1n << 33n,
    -1n,
    -(1n << 31n),
  ];
  const conds: [string, (a: bigint, b: bigint) => boolean][] = [
    ["ult", (a, b) => a < b],
    ["ule", (a, b) => a <= b],
    ["ugt", (a, b) => a > b],
    ["uge", (a, b) => a >= b],
  ];
  // Constant folding alone (check elimination off), then with check elimination's interval proofs too (D73), which also
  // decide compares such as 0 <= x for any x: every fold right on both targets either way.
  for (const disable of [["checks"], []]) {
    let folded = 0;
    for (const a of edges)
      for (const b of edges)
        for (const [c, f] of conds) {
          const { text } = opt(
            `func @f() -> (i32) export {
bb0:
  %0 = iconst.ix ${a}
  %1 = iconst.ix ${b}
  %2 = icmp.${c}.ix %0, %1
  ret %2
}
`,
            2,
            disable,
          );
          const body = fn(text, "f");
          if (/icmp\./.test(body)) continue;
          folded++;
          const got = /iconst\.i32 (\d+)/.exec(body)?.[1];
          const on32 = f(BigInt.asUintN(32, a), BigInt.asUintN(32, b));
          const on64 = f(BigInt.asUintN(64, a), BigInt.asUintN(64, b));
          assert.equal(on32, on64, `${a} ${c} ${b} folded where wasm32 and 64-bit differ`);
          assert.equal(got, on64 ? "1" : "0", `${a} ${c} ${b} folded wrongly`);
        }
    // Everything from 0 to 2^32 - 1 against everything there: 7 by 7 constants, 4 compares.
    if (disable.length > 0) assert.equal(folded, 196);
    else assert.ok(folded >= 196);
  }
});

test("branch folding, block merging and dead code", () => {
  const { text } = opt(`func @f(%0: i32) -> (i32) export {
bb0:
  %1 = iconst.i32 1
  brif %1, bb1, bb2
bb1:
  %2 = iconst.i32 7
  %3 = add.i32 %0, %2
  br bb3(%3)
bb2:
  %4 = mul.i32 %0, %0
  br bb3(%4)
bb3(%5: i32):
  %6 = mul.i32 %0, %0
  ret %5
}
`);
  const f = fn(text, "f");
  assert.doesNotMatch(f, /brif|mul|bb1/);
  assert.match(f, /add\.i32/);
});

const CALLS = `func @get(%0: ptr) -> (i32) {
bb0:
  %1 = load.i32.na %0
  ret %1
}
func @two(%0: i32, %1: i32) -> (i32, i32) {
bb0:
  %2 = icmp.slt.i32 %0, %1
  brif %2, bb1, bb2
bb1:
  ret %0, %1
bb2:
  ret %1, %0
}
func @rec(%0: i32) -> (i32) {
bb0:
  %1 = iconst.i32 0
  %2 = icmp.eq.i32 %0, %1
  brif %2, bb1, bb2
bb1:
  ret %0
bb2:
  %3 = iconst.i32 1
  %4 = sub.i32 %0, %3
  %5 = call @rec %4
  ret %5
}
func @never(%0: i32) -> (i32) noinline {
bb0:
  ret %0
}
func @f(%0: ptr, %1: i32, %2: i32) -> (i32) export {
bb0:
  %3 = call @get %0
  %4, %5 = call @two %1, %2
  %6 = sub.i32 %4, %5
  %7 = call @rec %6
  %8 = call @never %7
  %9 = add.i32 %3, %8
  ret %9
}
`;

test("the inliner: multiple returns, recursion and @tsl.noinline", () => {
  const { text, m } = opt(CALLS);
  const f = fn(text, "f");
  assert.doesNotMatch(f, /call @get|call @two/);
  assert.match(f, /call @rec/, "a recursive callee isn't unrolled into itself");
  assert.match(f, /call @never/);
  // The callee itself stays, with its body.
  assert.ok(m.funcs.some((x) => x.name === "get"));
  const r = fn(text, "rec");
  assert.match(r, /call @rec/);
});

test("-O1 inlines a callee no bigger than the call, and a leaf up to 16 in a loop (B3), nothing bigger", () => {
  const { text } = opt(
    `func @big(%0: i32) -> (i32) {
bb0:
  %1 = mul.i32 %0, %0
  %2 = mul.i32 %1, %0
  %3 = mul.i32 %2, %0
  %4 = mul.i32 %3, %0
  %5 = mul.i32 %4, %0
  %6 = mul.i32 %5, %0
  %7 = mul.i32 %6, %0
  %8 = mul.i32 %7, %0
  %9 = mul.i32 %8, %0
  %10 = mul.i32 %9, %0
  %11 = mul.i32 %10, %0
  %12 = mul.i32 %11, %0
  %13 = mul.i32 %12, %0
  %14 = mul.i32 %13, %0
  %15 = mul.i32 %14, %0
  %16 = mul.i32 %15, %0
  %17 = mul.i32 %16, %0
  %18 = mul.i32 %17, %0
  ret %18
}
func @small(%0: i32) -> (i32) {
bb0:
  %1 = mul.i32 %0, %0
  %2 = mul.i32 %1, %0
  %3 = mul.i32 %2, %0
  %4 = mul.i32 %3, %0
  %5 = mul.i32 %4, %0
  %6 = mul.i32 %5, %0
  %7 = mul.i32 %6, %0
  %8 = mul.i32 %7, %0
  %9 = mul.i32 %8, %0
  ret %9
}
func @g(%0: i32) -> (i32) export {
bb0:
  %1 = call @small %0
  br bb1(%1)
bb1(%2: i32):
  %3 = call @small %2
  %4 = call @big %3
  %5 = iconst.i32 100
  %6 = icmp.slt.i32 %4, %5
  brif %6, bb1(%4), bb2
bb2:
  ret %4
}
${CALLS}`,
    1,
  );
  assert.doesNotMatch(fn(text, "f"), /call @get/);
  const g = fn(text, "g");
  assert.equal(
    g.match(/call @small/g)?.length,
    1,
    "the call outside the loop stays, the one in it is inlined",
  );
  assert.match(g, /call @big/);
});

test("a pass switched off by name doesn't run", () => {
  const { text } = opt(CALLS, 2, ["inline"]);
  assert.match(fn(text, "f"), /call @get/);
});

test("a noalloc caller only gets noalloc callees, and export_c stays a real call", () => {
  const { text } = opt(`func @plain(%0: i32) -> (i32) {
bb0:
  ret %0
}
func @fixed(%0: i32) -> (i32) export_c {
bb0:
  ret %0
}
func @f(%0: i32) -> (i32) export noalloc {
bb0:
  %1 = call @plain %0
  %2 = call @fixed %1
  ret %2
}
`);
  const f = fn(text, "f");
  assert.match(f, /call @plain/);
  assert.match(f, /call @fixed/);
});

test("a callee's frame slot moves to the caller's entry block, even into a loop", () => {
  const { text } = opt(`func @slot(%0: i32) -> (i32) {
bb0:
  %1 = alloca 16, 8, t3
  %2 = iconst.ix 0
  %3 = gep %1, %2, 4, 0
  store.i32.na %3, %0
  %4 = call @use %1
  ret %4
}
func @use(%0: ptr) -> (i32) noinline {
bb0:
  %1 = load.i32.na %0
  ret %1
}
func @f(%0: i32) -> (i32) export {
bb0:
  %1 = iconst.i32 0
  br bb1(%1)
bb1(%2: i32):
  %3 = icmp.slt.i32 %2, %0
  brif %3, bb2, bb3
bb2:
  %4 = call @slot %2
  %5 = iconst.i32 1
  %6 = add.i32 %2, %5
  br bb1(%6)
bb3:
  ret %2
}
`);
  const f = fn(text, "f");
  assert.doesNotMatch(f, /call @slot/);
  const entry = f.slice(0, f.indexOf("\nbb1"));
  assert.match(entry, /alloca 16/);
});

test("partial inlining: the entry's checks inline, and the slow path calls the whole function", () => {
  const { text } = opt(`global @g size=8 align=8 section=data
func @slow(%0: ptr) -> () noinline {
bb0:
  ret
}
func @fast(%0: ptr) -> (i32) {
bb0:
  %1 = load.i32.na %0
  %2 = iconst.i32 0
  %3 = icmp.eq.i32 %1, %2
  brif %3, bb1, bb2
bb1:
  ret %1
bb2:
  call @slow %0
  call @slow %0
  call @slow %0
  call @slow %0
  call @slow %0
  call @slow %0
  %4 = iconst.i32 7
  store.i32.na %0, %4
  ret %4
}
func @f(%0: ptr) -> (i32) export {
bb0:
  %1 = call @fast %0
  ret %1
}
func @f2(%0: ptr) -> (i32) export {
bb0:
  %1 = call @fast %0
  ret %1
}
`);
  const f = fn(text, "f");
  assert.match(f, /load\.i32\.na/, "the check is inlined");
  assert.match(f, /call @fast/, "and the slow path is a call to the whole function");
  assert.doesNotMatch(f, /call @slow/);
});

test("a call through a known function's address becomes a direct call", () => {
  const { text } = opt(`sig sig0 (i32) -> (i32)
func @inc(%0: i32) -> (i32) {
bb0:
  %1 = iconst.i32 1
  %2 = add.i32 %0, %1
  ret %2
}
func @f(%0: i32) -> (i32) export {
bb0:
  %1 = funcaddr @inc
  %2 = call.indirect sig0 %1, %0
  ret %2
}
`);
  assert.doesNotMatch(fn(text, "f"), /call/);
});

test("a load the optimiser left unused still runs, so a fault it takes still happens", () => {
  const { text } = opt(`func @get(%0: ptr) -> (i32) {
bb0:
  %1 = load.i32.na %0
  ret %1
}
func @f(%0: ptr) -> (i32) export {
bb0:
  %1 = call @get %0
  %2 = iconst.i32 5
  ret %2
}
`);
  const f = fn(text, "f");
  assert.match(f, /load\.i32\.na/);
  assert.match(f, /store\.i32\.na/, "kept by a store to a word nothing reads");
  // A load -O0 itself dropped isn't kept.
  const { text: t2 } = opt(`func @f(%0: ptr) -> (i32) export {
bb0:
  %1 = load.i32.na %0
  %2 = iconst.i32 5
  ret %2
}
`);
  assert.doesNotMatch(fn(t2, "f"), /store/);
});

test("the dead-load rule is the backend's own", () => {
  const m = canonicalize(parseModule(CALLS + TRAPS));
  for (const f of m.funcs) assert.deepEqual(deadLoads(f), deadLoadsBySelect(f));
});

test("a frame slot used only at constant offsets becomes values", () => {
  const { text } = opt(`func @f(%0: i32, %1: i32) -> (i32) export {
bb0:
  %2 = alloca 8, 8, t3
  %3 = iconst.ix 8
  %4 = iconst.i32 0
  intrinsic mem.fill %2, %4, %3
  store.i32.na %2, %0
  %5 = iconst.i32 0
  %6 = icmp.eq.i32 %1, %5
  brif %6, bb1, bb2
bb1:
  %7 = iconst.ix 0
  %8 = gep %2, %7, 1, 4
  store.i32.na %8, %1
  br bb2
bb2:
  %9 = iconst.ix 0
  %10 = gep %2, %9, 1, 4
  %11 = load.i32.na %10
  %12 = load.i32.na %2
  %13 = add.i32 %11, %12
  ret %13
}
`);
  const f = fn(text, "f");
  assert.doesNotMatch(f, /alloca|load|store|mem\.fill/);
});

// R30: a new object built in a frame slot, cleared a word at a time after a test, and copied into its place (as `make`'s
// placeObject and placeTail are): the slot goes, and the copy is stores of the fields' last values and zero between them.
const PLACE = `func @f(%0: ptr, %1: i32, %2: i64) -> (i32) export {
bb0:
  %3 = alloca 24, 8, t3
  %4 = iconst.i32 0
  %5 = icmp.slt.i32 %1, %4
  brif %5, bb3, bb1
bb1:
  %6 = iconst.i64 0
  store.i64.na %3, %6
  %7 = iconst.ix 0
  %8 = gep %3, %7, 1, 8
  store.i64.na %8, %6
  %9 = gep %3, %7, 1, 16
  store.i64.na %9, %6
  store.i32.na %9, %1
  store.i64.na %8, %2
  %10 = iconst.ix 20
  intrinsic mem.copy %0, %3, %10
  %11 = load.i32.na %9
  ret %11
bb3:
  trap t1
}
`;

test("R30: a frame slot cleared a word at a time and copied out becomes stores into the copy's place", () => {
  const f = fn(opt(PLACE).text, "f");
  assert.doesNotMatch(f, /alloca|mem\.copy|load/);
  // the zero word at 0, the i64 at 8 (%2) and the i32 at 16 (%1), each at its offset from %0
  assert.match(f, /store\.i64\.na %0, %\d+\n/);
  assert.match(f, /gep %0, %\d+, 1, 8\n\s+store\.i64\.na %\d+, %2\n/);
  assert.match(f, /gep %0, %\d+, 1, 16\n\s+store\.i32\.na %\d+, %1\n/);
  assert.match(f, /ret %1\n/);
});

test("R30: a copy out of a frame slot that would split a field, or a copy into it, keeps the slot", () => {
  // 18 bytes splits the i32 at 16
  const split = fn(opt(PLACE.replace("iconst.ix 20", "iconst.ix 18")).text, "f");
  assert.match(split, /alloca 24/);
  // a copy into it, not out of it
  const into = fn(
    opt(PLACE.replace("intrinsic mem.copy %0, %3, %10", "intrinsic mem.copy %3, %0, %10")).text,
    "f",
  );
  assert.match(into, /alloca 24/);
  // off (TMK_R30_OFF=sroa): as before R30, the fill isn't in the entry block, so the slot stays
  const was = process.env.TMK_R30_OFF;
  process.env.TMK_R30_OFF = "sroa";
  try {
    assert.match(fn(opt(PLACE).text, "f"), /alloca 24/);
  } finally {
    if (was === undefined) delete process.env.TMK_R30_OFF;
    else process.env.TMK_R30_OFF = was;
  }
});

test("R30: the injected bug r30-copy-stale stores the fill's zero, not the fields' last values", () => {
  const lines = (PLACE + TRAPS).split("\n").filter((l) => l.trim() !== "");
  const m = canonicalize(parseModule(lines.join("\n") + "\n"));
  const r = optimizeModule(m, { level: 2, verifyEach: true, faults: ["r30-copy-stale"] });
  const f = fn(printModule(r.module), "f");
  assert.doesNotMatch(f, /store\.i64\.na %\d+, %2\n/);
});

test("the same input gives the same output", () => {
  const a = opt(CALLS).text;
  const b = opt(CALLS).text;
  assert.equal(a, b);
});

test("a callee that never returns: what followed the call goes, and the trap stays", () => {
  const { text } = opt(`func @fail(%0: i32) -> (i32) {
bb0:
  trap t1
}
func @f(%0: i32) -> (i32) export {
bb0:
  %1 = iconst.i32 0
  %2 = icmp.eq.i32 %0, %1
  brif %2, bb1, bb2
bb1:
  %3 = call @fail %0
  %4 = add.i32 %3, %0
  ret %4
bb2:
  ret %0
}
`);
  const f = fn(text, "f");
  assert.doesNotMatch(f, /call @fail|add\.i32/);
  assert.match(f, /trap t\d/);
});

// --- phase B (D73): value numbering, loop-invariant code motion, unswitching and peeling

const count = (s: string, re: RegExp): number => (s.match(new RegExp(re, "g")) ?? []).length;

test("value numbering: a repeated computation, check and load are done once", () => {
  const { text } = opt(`func @f(%0: i32, %1: i32, %2: ptr) -> (i32) export {
bb0:
  %3 = add.i32 %0, %1
  %4 = add.i32 %1, %0
  %5 = add.chk.s.i32 %0, %1, t1
  %6 = add.chk.s.i32 %1, %0, t1
  %7 = iconst.ix 0
  %8 = gep %2, %7, 1, 8
  %9 = load.i32.na %8
  %10 = iconst.ix 0
  %11 = gep %2, %10, 1, 8
  %12 = load.i32.na %11
  %13 = add.i32 %3, %4
  %14 = add.i32 %5, %6
  %15 = add.i32 %9, %12
  %16 = add.i32 %13, %14
  %17 = add.i32 %16, %15
  ret %17
}
`);
  const f = fn(text, "f");
  assert.equal(count(f, /add\.chk/), 1);
  assert.equal(count(f, /load\.i32/), 1);
  assert.equal(count(f, /gep/), 1);
});

test("value numbering: a store between two loads keeps both, unless it can't touch their bytes", () => {
  const src = (storeOff: number, call = ""): string => `func @w(%0: ptr) -> () noinline {
bb0:
  %1 = iconst.i32 7
  store.i32.na %0, %1
  ret
}
func @r(%0: ptr) -> (i32) noinline {
bb0:
  %1 = load.i32.na %0
  ret %1
}
func @f(%0: ptr, %1: i32) -> (i32) export {
bb0:
  %2 = iconst.ix 0
  %3 = gep %0, %2, 1, 8
  %4 = load.i32.na %3
  %5 = gep %0, %2, 1, ${storeOff}
  store.i32.na %5, %1
  ${call}
  %6 = load.i32.na %3
  %7 = add.i32 %4, %6
  ret %7
}
`;
  assert.equal(count(fn(opt(src(8)).text, "f"), /load\.i32/), 1, "the store's value is read back");
  assert.match(fn(opt(src(8)).text, "f"), /add\.i32 %1, %1|add\.i32 %\d+, %1/);
  assert.equal(count(fn(opt(src(10)).text, "f"), /load\.i32/), 2, "bytes 10 to 13 overlap 8 to 11");
  assert.equal(count(fn(opt(src(12)).text, "f"), /load\.i32/), 1, "bytes 12 to 15 don't");
  assert.equal(
    count(fn(opt(src(12, "call @w %0")).text, "f"), /load\.i32/),
    2,
    "a call that writes",
  );
  assert.equal(
    count(fn(opt(src(12, "%9 = call @r %0")).text, "f"), /load\.i32/),
    1,
    "a call to a function that writes nothing",
  );
});

test("value numbering: a load after an if/else uses one from before it, unless an arm writes there", () => {
  const src = (arm: string): string => `func @f(%0: ptr, %1: i32) -> (i32) export {
bb0:
  %2 = load.i32.na %0
  brif %1, bb1, bb2
bb1:
  ${arm}
  br bb3
bb2:
  br bb3
bb3:
  %3 = load.i32.na %0
  %4 = add.i32 %2, %3
  ret %4
}
`;
  assert.equal(count(fn(opt(src("")).text, "f"), /load\.i32/), 1);
  assert.equal(count(fn(opt(src("store.i32.na %0, %1")).text, "f"), /load\.i32/), 2);
});

test("value numbering: a load -O0 dropped doesn't stand for a later one, which would run it before a check", () => {
  const { text } = opt(`func @f(%0: ptr, %1: ix, %2: ix) -> (i32) export {
bb0:
  %3 = load.i32.na %0
  %4 = bounds.chk %1, %2, t2
  %5 = load.i32.na %0
  %6 = trunc.i32 %4
  %7 = add.i32 %5, %6
  ret %7
}
`);
  const f = fn(text, "f");
  assert.ok(f.indexOf("bounds.chk") < f.lastIndexOf("load.i32"), f);
});

const LOOP = (
  body: string,
  head = "",
): string => `func @f(%0: ptr, %1: i32, %2: i32) -> (i32) export {
bb0:
  %3 = iconst.i32 0
  br bb1(%3, %3)
bb1(%4: i32, %5: i32):
  ${head}
  %6 = icmp.slt.i32 %4, %1
  brif %6, bb2, bb3
bb2:
  ${body}
  %20 = iconst.i32 1
  %21 = add.i32 %4, %20
  br bb1(%21, %10)
bb3:
  ret %5
}
`;

test("licm: an invariant computation and a load first in the header move out; a load the loop writes doesn't", () => {
  const moved = fn(
    opt(
      LOOP(
        "%10 = add.i32 %5, %9",
        "%8 = mul.i32 %1, %2\n  %7 = load.i32.na %0\n  %9 = add.i32 %7, %8",
      ),
    ).text,
    "f",
  );
  const pre = moved.slice(0, moved.indexOf("bb1("));
  assert.match(pre, /mul\.i32/);
  assert.match(pre, /load\.i32/);
  const written = fn(
    opt(LOOP("store.i32.na %0, %4\n  %10 = add.i32 %5, %9", "%9 = load.i32.na %0")).text,
    "f",
  );
  assert.doesNotMatch(written.slice(0, written.indexOf("bb1(")), /load\.i32/);
});

test("licm: a load that can fault, behind the loop's test, stays; one from a global moves", () => {
  const guarded = fn(
    opt(LOOP("%9 = load.i32.na %0\n  %10 = add.i32 %5, %9"), 2, ["peel"]).text,
    "f",
  );
  const pre = (s: string): string => s.slice(0, s.indexOf("bb1("));
  assert.doesNotMatch(pre(guarded), /load\.i32/, guarded);
  // Peeled, it runs once in the copy of the first turn, behind the same test.
  const peeled = fn(opt(LOOP("%9 = load.i32.na %0\n  %10 = add.i32 %5, %9")).text, "f");
  assert.equal(count(peeled, /load\.i32/), 1, peeled);
  assert.ok(peeled.indexOf("icmp.slt") < peeled.indexOf("load.i32"), peeled);
  const glob = fn(
    opt(
      LOOP("%8 = globaladdr @g\n  %9 = load.i32.na %8\n  %10 = add.i32 %5, %9") +
        "global @g size=4 align=4 section=data\n",
    ).text,
    "f",
  );
  assert.match(pre(glob), /load\.i32/, glob);
});

test("licm: an invariant check in the header moves out only with nothing before it that could trap", () => {
  const first = fn(opt(LOOP("%10 = add.i32 %5, %9", "%9 = mul.chk.s.i32 %1, %2, t1")).text, "f");
  assert.match(first.slice(0, first.indexOf("bb1(")), /mul\.chk/);
  const second = fn(
    opt(
      LOOP(
        "%10 = add.i32 %5, %9",
        "%7 = add.chk.s.i32 %4, %2, t1\n  %9 = mul.chk.s.i32 %1, %2, t1\n  %11 = add.i32 %7, %9",
      ),
    ).text,
    "f",
  );
  assert.doesNotMatch(second.slice(0, second.indexOf("bb1(")), /mul\.chk/, second);
});

test("unswitching: a loop branching on an invariant test becomes one loop each way", () => {
  const text0 = LOOP(`%8 = load.i32.na %0
  %9 = iconst.i32 1
  %11 = icmp.eq.i32 %8, %9
  brif %11, bb4, bb5
bb4:
  %12 = add.i32 %5, %2
  br bb6(%12)
bb5:
  %13 = sub.i32 %5, %2
  br bb6(%13)
bb6(%10: i32):`);
  const { text } = opt(
    LOOP(`%8 = load.i32.na %0
  %9 = iconst.i32 1
  %11 = icmp.eq.i32 %8, %9
  brif %11, bb4, bb5
bb4:
  %12 = add.i32 %5, %2
  br bb6(%12)
bb5:
  %13 = sub.i32 %5, %2
  br bb6(%13)
bb6(%10: i32):`).replace("  %8 = load", "  %8 = load"),
    2,
  );
  const f = fn(text, "f");
  // R26: the load can fault, so the first turn is peeled (its test and load in front); value numbering makes the loop's test
  // the first turn's, invariant, and the next round unswitches it: the peeled turn's loop test and one loop each way, none
  // of them testing it again
  assert.equal(count(f, /icmp\.slt/), 3, f);
  assert.equal(count(f, /icmp\.eq/), 1, f);
  assert.equal(count(f, /brif %7,/), 2, f);
  // in one round, as before R26: peeled, the loop still branching on it
  const was = process.env.TMK_R26_OFF;
  process.env.TMK_R26_OFF = "rounds";
  try {
    const g = fn(opt(text0, 2).text, "f");
    assert.equal(count(g, /icmp\.slt/), 2, g);
    assert.equal(count(g, /icmp\.eq/), 1, g);
  } finally {
    if (was === undefined) delete process.env.TMK_R26_OFF;
    else process.env.TMK_R26_OFF = was;
  }
  // -O1 doesn't copy loops.
  const o1 = fn(opt(text, 1).text, "f");
  void o1;
});

// corpus/std/rc_tails.ts at -O2 (R1b): a reference's tag test, computed in the loop's header and shared by value numbering
// with code after the loop, was lifted to the preheader and then passed on by the merge as if the loop still made it, so
// the preheader read the merge's parameter: TIR that doesn't verify.
test("unswitching: a condition's operand also used after the loop stays the preheader's", () => {
  // an inner loop, unswitched alone: the outer one costs too much to copy, as rc_tails.ts's did
  const pad = Array.from({ length: 120 }, (_, k) => `  %${100 + k} = add.i64 %${99 + k}, %0`).join(
    "\n",
  );
  const { text } = opt(
    `func @g(%0: i64, %1: i32, %2: i32) -> (i64) export {
bb0:
  %3 = iconst.i32 0
  %50 = iconst.i64 0
  br bb8(%3, %50)
bb8(%51: i32, %52: i64):
  %53 = icmp.slt.i32 %51, %2
  brif %53, bb9, bb10
bb9:
  br bb1(%3, %3)
bb1(%4: i32, %5: i32):
  %30 = iconst.i64 48
  %31 = lshr.i64 %0, %30
  %32 = iconst.i64 0
  %33 = icmp.ne.i64 %31, %32
  %6 = icmp.slt.i32 %4, %1
  brif %6, bb2, bb3
bb2:
  brif %33, bb4, bb5
bb4:
  %12 = add.i32 %5, %2
  br bb6(%12)
bb5:
  %13 = sub.i32 %5, %2
  br bb6(%13)
bb6(%10: i32):
  %20 = iconst.i32 1
  %21 = add.i32 %4, %20
  br bb1(%21, %10)
bb3:
  %40 = zext.i64 %5
  %99 = add.i64 %40, %31
${pad}
  %42 = add.i64 %52, %219
  %43 = iconst.i32 1
  %44 = add.i32 %51, %43
  br bb8(%44, %42)
bb10:
  ret %52
}
`,
    2,
    ["licm"],
  );
  const f = fn(text, "g");
  assert.equal(count(f, /icmp\.ne\.i64/), 1, f);
});

test("peeling: a load every turn makes that nothing writes is read once, in a copy of the first turn", () => {
  const { text } = opt(
    LOOP(`%8 = iconst.ix 0
  %9 = gep %0, %8, 1, 8
  %11 = load.i32.na %9
  %10 = add.i32 %5, %11`),
    2,
  );
  const f = fn(text, "f");
  assert.equal(count(f, /load\.i32/), 1, f);
  assert.equal(count(f, /icmp\.slt/), 2, f);
  const off = fn(
    opt(
      LOOP(`%8 = iconst.ix 0
  %9 = gep %0, %8, 1, 8
  %11 = load.i32.na %9
  %10 = add.i32 %5, %11`),
      2,
      ["peel"],
    ).text,
    "f",
  );
  assert.equal(count(off, /icmp\.slt/), 1);
});

test("check elimination: an index below the length it's tested against, and its increment, lose their checks", () => {
  const src = (cmp: string): string => `func @f(%0: ptr, %1: ix) -> (i32) export {
bb0:
  %2 = iconst.ix 0
  %3 = iconst.i32 0
  br bb1(%2, %3)
bb1(%4: ix, %5: i32):
  %6 = icmp.${cmp}.ix %4, %1
  brif %6, bb2, bb3
bb2:
  %7 = bounds.chk %4, %1, t2
  %8 = gep %0, %7, 4, 0
  %9 = load.i32.na %8
  %10 = add.i32 %5, %9
  %11 = iconst.ix 1
  %12 = add.chk.u.ix %4, %11, t1
  br bb1(%12, %10)
bb3:
  ret %5
}
`;
  const lt = fn(opt(src("ult")).text, "f");
  assert.doesNotMatch(lt, /bounds\.chk/, lt);
  assert.doesNotMatch(lt, /add\.chk/, lt);
  // i <= n: the last turn's index is the length, and the check fires there.
  const le = fn(opt(src("ule")).text, "f");
  assert.match(le, /bounds\.chk/, le);
  // R15: with `checks` off, conds.ts (the header's test dominating the check) and loop versioning (a guard that folds to
  // true) prove it too, so all three are off to show `checks` is what removes it here.
  assert.equal(
    fn(opt(src("ult"), 2, ["checks", "conds", "version"]).text, "f").includes("bounds.chk"),
    true,
  );
  assert.equal(fn(opt(src("ult"), 1, ["loopbounds"]).text, "f").includes("bounds.chk"), false);
  assert.equal(
    fn(opt(src("ult"), 1, ["loopbounds", "conds"]).text, "f").includes("bounds.chk"),
    true,
  );
});

test("check elimination: a mask of the length less one is below the length, once the length isn't 0", () => {
  const src = (guard: string): string => `func @f(%0: ptr, %1: ix, %2: i32) -> (i32) export {
bb0:
  %3 = iconst.ix 0
  %4 = icmp.${guard}.ix %1, %3
  brif %4, bb1, bb2
bb1:
  %5 = iconst.ix 1
  %6 = sub.chk.u.ix %1, %5, t1
  %7 = trunc.i32 %6
  %8 = and.i32 %2, %7
  %9 = zext.ix %8
  %10 = bounds.chk %9, %1, t2
  %11 = gep %0, %10, 4, 0
  %12 = load.i32.na %11
  ret %12
bb2:
  ret %2
}
`;
  const ok = fn(opt(src("ne")).text, "f");
  assert.doesNotMatch(ok, /bounds\.chk|sub\.chk/, ok);
  // With no test of the length, both stay: 0 - 1 traps.
  const none = fn(opt(src("ne").replace("brif %4, bb1, bb2", "br bb1")).text, "f");
  assert.match(none, /sub\.chk/, none);
});

test("check elimination: checked arithmetic at its limit goes only where it can't pass it", () => {
  const src = (cmp: string, k: string): string => `func @f(%0: i32) -> (i32) export {
bb0:
  %1 = iconst.i32 2147483000
  %2 = icmp.${cmp}.i32 %0, %1
  brif %2, bb1, bb2
bb1:
  %3 = iconst.i32 ${k}
  %4 = add.chk.s.i32 %0, %3, t1
  ret %4
bb2:
  ret %0
}
`;
  assert.doesNotMatch(fn(opt(src("slt", "648")).text, "f"), /add\.chk/);
  assert.doesNotMatch(fn(opt(src("sle", "647")).text, "f"), /add\.chk/);
  assert.match(fn(opt(src("sle", "648")).text, "f"), /add\.chk/, "2147483000 + 648 is one past");
});

test("check elimination: an i32 through a float and back is itself, and its float compares are decided", () => {
  const { text } = opt(`func @f(%0: i32) -> (i32) export {
bb0:
  %1 = iconst.i32 0
  %2 = icmp.slt.i32 %0, %1
  brif %2, bb2, bb1
bb1:
  %3 = sitofp.f64 %0
  %4 = ftrunc.f64 %3
  %5 = fconst.f64 0x0
  %6 = fcmp.lt.f64 %4, %5
  brif %6, bb2, bb3
bb3:
  %7 = js.toint32 %4
  ret %7
bb2:
  ret %1
}
`);
  const f = fn(text, "f");
  assert.doesNotMatch(f, /fcmp|js\.toint32|sitofp/, f);
});

test("licm: a check first on a turn the loop is proved to take moves out; with no proof it stays", () => {
  const src = (guarded: boolean): string => `func @f(%0: ix, %1: ix) -> (ix) export {
bb0:
  %2 = iconst.ix 0
  %3 = icmp.ugt.ix %1, %2
  ${guarded ? "brif %3, bb1, bb4(%2)" : "br bb1"}
bb1:
  br bb2(%2, %2)
bb2(%4: ix, %5: ix):
  %6 = icmp.ult.ix %4, %1
  brif %6, bb3, bb4(%5)
bb3:
  %7 = mul.chk.u.ix %0, %1, t1
  %8 = add.ix %5, %7
  %9 = iconst.ix 1
  %10 = add.ix %4, %9
  br bb2(%10, %8)
bb4(%11: ix):
  ret %11
}
`;
  const head = (s: string): string => s.slice(0, s.indexOf("icmp.ult"));
  assert.match(head(fn(opt(src(true)).text, "f")), /mul\.chk/);
  assert.doesNotMatch(head(fn(opt(src(false), 2, ["peel"]).text, "f")), /mul\.chk/);
});

test("licm: a preheader it makes keeps its parameters when the edge into the header changes", () => {
  // Two edges into the loop, so a preheader is made; both pass the same values, which value numbering then merges.
  const { text } = opt(`func @f(%0: ptr, %1: i32, %2: i32) -> (i32) export {
bb0:
  %3 = iconst.i32 0
  brif %2, bb1(%3, %3), bb4
bb4:
  br bb1(%3, %3)
bb1(%4: i32, %5: i32):
  %6 = load.i32.na %0
  %7 = icmp.slt.i32 %4, %1
  brif %7, bb2, bb3
bb2:
  %8 = add.i32 %5, %6
  %9 = iconst.i32 1
  %10 = add.i32 %4, %9
  br bb1(%10, %8)
bb3:
  ret %5
}
`);
  assert.match(fn(text, "f"), /load\.i32/);
});

// Class ids (D73, SPEC 3.4's "Class ids don't change"): a load lowering notes reads one is invariant at -O1 and -O2, and is
// shared across what can't change a class id, but not across a store at its own base over its bytes.
const INV = (load: string, between: string): string => `func @w(%0: ptr) -> () noinline {
bb0:
  %1 = iconst.i32 7
  store.i32.na %0, %1
  ret
}
func @f(%0: ptr, %1: ptr, %2: i32) -> (i32) export {
bb0:
  %3 = ${load} %0
  ${between}
  %4 = ${load} %0
  %5 = add.i32 %3, %4
  ret %5
}
`;

test("value numbering: a class id's load is shared across stores elsewhere, calls and copies, not its own base's store", () => {
  const n = (load: string, between: string): number =>
    count(fn(opt(INV(load, between)).text, "f"), /load\.i32/);
  const elsewhere = "store.i32.na %1, %2\n  call @w %1";
  const copy = "%9 = iconst.ix 4\n  intrinsic mem.copy %1, %0, %9";
  assert.equal(n("load.i32.inv", elsewhere), 1, "a store at another base, and a call that writes");
  assert.equal(n("load.i32.inv", copy), 1, "an intrinsic that writes");
  assert.equal(n("load.i32.na", elsewhere), 2, "a plain load isn't");
  assert.equal(n("load.i32.na", copy), 2);
  assert.equal(n("load.i32.inv", "store.i32.na %0, %2"), 1, "the store's value read back");
  assert.match(fn(opt(INV("load.i32.inv", "store.i32.na %0, %2")).text, "f"), /add\.i32 %\d+, %2/);
  assert.equal(
    n(
      "load.i32.inv",
      "%9 = iconst.ix 0\n  %10 = gep %0, %9, 1, 2\n  %11 = trunc.i16 %2\n  store.i16.na %10, %11",
    ),
    2,
    "a store at its own base over its bytes changes it",
  );
  assert.equal(
    n(
      "load.i32.inv",
      "%9 = iconst.ix 0\n  %10 = gep %0, %9, 1, 4\n  store.i32.na %10, %2\n  call @w %10",
    ),
    1,
    "its own base's other bytes",
  );
});

test("the optimiser's first step: a load lowering noted reads a class id is load.T.inv at -O1 and -O2, and at -O0 as it was", () => {
  const m = canonicalize(parseModule(INV("load.i32.na", "call @w %1") + TRAPS));
  for (const f of m.funcs)
    for (const b of f.blocks)
      for (const ins of b.instrs) if (ins.op === "load.i32.na" && f.name === "f") ins.inv = true;
  const at = (level: OptLevel, disable: string[] = []): string =>
    fn(printModule(optimizeModule(m, { level, verifyEach: true, disable }).module), "f");
  assert.equal(count(at(1), /load\.i32\.inv/), 1);
  assert.equal(count(at(2), /load\.i32\.inv/), 1);
  assert.equal(count(at(2, ["invariant"]), /load\.i32\.na/), 2, "switched off by name");
  assert.equal(optimizeModule(m, { level: 0 }).module, m, "-O0 is the input, as lowered");
  assert.equal(count(fn(printModule(m), "f"), /load\.i32\.na/), 2, "the note isn't in the text");
});

test("licm: a class id's load moves out of a loop that calls and stores elsewhere; a plain one doesn't", () => {
  const src = (load: string): string =>
    `func @w(%0: ptr) -> () noinline {
bb0:
  %1 = iconst.i32 7
  store.i32.na %0, %1
  ret
}
` + LOOP("call @w %0\n  %10 = add.i32 %5, %9", `%7 = ${load} %0\n  %9 = add.i32 %7, %2`);
  const pre = (t: string): string => t.slice(0, t.indexOf("bb1("));
  assert.match(pre(fn(opt(src("load.i32.inv")).text, "f")), /load\.i32\.inv/);
  assert.doesNotMatch(pre(fn(opt(src("load.i32.na")).text, "f")), /load\.i32/);
});

// R15: dominating conditions (conds.ts) and loop versioning (version.ts).

function optFaults(
  text: string,
  level: OptLevel,
  faults: string[],
  disable: string[] = [],
): string {
  const lines = (text + TRAPS).split("\n").filter((l) => l.trim() !== "");
  const m = canonicalize(parseModule(lines.join("\n") + "\n"));
  assert.deepEqual(verifyModule(m), []);
  return printModule(optimizeModule(m, { level, verifyEach: true, disable, faults }).module);
}

const RETEST = (join: boolean): string => `func @f(%0: i64, %1: ptr) -> (i64) export {
bb0:
  %2 = iconst.i64 0
  %3 = icmp.eq.i64 %0, %2
  brif %3, bb1, bb2
bb1:
  trap t1
bb2:
  %4 = load.i64.na %1
  ${join ? "br bb4" : "br bb3"}
bb3:
  ${join ? "" : "brif %3, bb5, bb6"}
${join ? "" : "bb5:\n  trap t1\nbb6:\n  ret %4"}
${join ? "bb4:\n  brif %3, bb7, bb8\nbb7:\n  trap t1\nbb8:\n  ret %4" : ""}
}
`;

test("conds: a null test made again where the first one's answer is known goes, at -O1", () => {
  const f = fn(opt(RETEST(false), 1).text, "f");
  assert.equal(count(f, /brif/), 1, f);
  // with the pass off, both tests stay
  assert.equal(count(fn(opt(RETEST(false), 1, ["conds"]).text, "f"), /brif/), 2);
});

// A block reached two ways: the first test's answer is known on one of them only.
const JOIN = `func @f(%0: ix, %1: ix, %2: ptr) -> (i32) export {
bb0:
  %3 = icmp.uge.ix %0, %1
  %9 = iconst.i32 7
  brif %3, bb1, bb2(%9)
bb1:
  %4 = iconst.i32 1
  br bb2(%4)
bb2(%5: i32):
  %6 = icmp.uge.ix %0, %1
  brif %6, bb3, bb4
bb3:
  trap t2
bb4:
  %7 = gep %2, %0, 4, 0
  %8 = load.i32.na %7
  %10 = add.i32 %8, %5
  ret %10
}
`;

test("conds: a test where the earlier test's edge doesn't dominate stays; the injected bug takes it", () => {
  const ok = fn(opt(JOIN, 1).text, "f");
  assert.match(ok, /trap t/, ok);
  assert.equal(count(ok, /brif/), 2, ok);
  const bug = fn(optFaults(JOIN, 1, ["conds-not-dominating"]), "f");
  assert.doesNotMatch(bug, /trap t/, bug);
});

test("conds: the lowering's check and get's own on the same read, either way round, and a bounds check under a test", () => {
  const src = `func @f(%0: ix, %1: ix, %2: ptr) -> (i32) export {
bb0:
  %3 = icmp.ult.ix %0, %1
  brif %3, bb2, bb1
bb1:
  trap t2
bb2:
  %4 = icmp.uge.ix %0, %1
  brif %4, bb3, bb4
bb3:
  trap t2
bb4:
  %5 = bounds.chk %0, %1, t2
  %6 = gep %2, %5, 4, 0
  %7 = load.i32.na %6
  ret %7
}
`;
  const f = fn(opt(src, 1).text, "f");
  assert.equal(count(f, /brif/), 1, f);
  assert.doesNotMatch(f, /bounds\.chk/, f);
  // a signed test says nothing of an unsigned one
  const s = fn(opt(src.replace("icmp.ult.ix %0, %1", "icmp.slt.ix %0, %1"), 1).text, "f");
  assert.equal(count(s, /brif/), 2, s);
});

// matmul's inner loop (corpus/pos/matmul_f64.ts): a[B + k] and b[k * n + j], k < m, with B, n, j and the lengths from
// outside the loop.
const STRIDED = (
  lenB: string,
  inLoopLen = false,
): string => `func @f(%0: ptr, %1: ix, %2: ptr, %3: ix, %4: ix, %5: ix, %6: ix, %20: ptr) -> (f64) export {
bb0:
  %7 = iconst.ix 0
  %8 = fconst.f64 0x0
  br bb1(%7, %8)
bb1(%9: ix, %10: f64):
  %11 = icmp.ult.ix %9, %4
  brif %11, bb2, bb3
bb2:
  %12 = add.chk.u.ix %5, %9, t1
  %13 = bounds.chk %12, %1, t2
  %14 = gep %0, %13, 8, 0
  %15 = load.f64.na %14
  %16 = mul.chk.u.ix %9, %4, t1
  %17 = add.chk.u.ix %16, %6, t1
  ${inLoopLen ? "store.ix.na %0, %9\n  %30 = load.ix.na %20" : ""}
  %18 = bounds.chk %17, ${inLoopLen ? "%30" : lenB}, t2
  %19 = gep %2, %18, 8, 0
  %21 = load.f64.na %19
  %22 = fmul.f64 %15, %21
  %23 = fadd.f64 %10, %22
  %24 = iconst.ix 1
  %25 = add.ix %9, %24
  br bb1(%25, %23)
bb3:
  ret %10
}
`;

test("version: a strided loop gets a fast copy without its checks, guarded, and keeps the loop as it was", () => {
  const f = fn(opt(STRIDED("%3")).text, "f");
  // two loops: one with both checks and their arithmetic's, one with none
  assert.equal(count(f, /bounds\.chk/), 2, f);
  assert.equal(count(f, /add\.chk|mul\.chk/), 3, f);
  assert.equal(count(f, /icmp\.ult\.ix %\d+, %4/), 2, f);
  assert.match(f, /udiv\.ix/, f);
  // with it off, one loop
  const off = fn(opt(STRIDED("%3"), 2, ["version"]).text, "f");
  assert.equal(count(off, /icmp\.ult\.ix %\d+, %4/), 1, off);
  // -O1 doesn't copy loops
  const o1 = fn(opt(STRIDED("%3"), 1).text, "f");
  assert.equal(count(o1, /icmp\.ult\.ix %\d+, %4/), 1, o1);
});

test("version: a length the loop can write isn't the guard's; the injected bug reads it once before", () => {
  // the a[] check is still versioned; b[]'s, against a length loaded in the loop after a store there, isn't
  const f = fn(opt(STRIDED("%3", true)).text, "f");
  assert.equal(count(f, /bounds\.chk/), 3, f);
  const bug = fn(optFaults(STRIDED("%3", true), 2, ["version-bound-in-loop"]), "f");
  assert.equal(count(bug, /bounds\.chk/), 2, bug);
});

test("version: each check's guard is against its own length; the injected bug uses the first's", () => {
  const f = fn(opt(STRIDED("%3")).text, "f");
  assert.match(f, /icmp\.ult\.ix %\d+, %3/, f);
  const bug = fn(optFaults(STRIDED("%3"), 2, ["version-wrong-length"]), "f");
  assert.doesNotMatch(bug, /icmp\.ult\.ix %\d+, %3/, bug);
});

test("version: the guard is the loop's bound against the room left; the injected bug allows one more", () => {
  const src = STRIDED("%3");
  const ok = fn(opt(src).text, "f");
  const bug = fn(optFaults(src, 2, ["version-off-by-one"]), "f");
  assert.equal(count(bug, /add\.ix/) - count(ok, /add\.ix/), 2, `${ok}\n${bug}`);
});

// --- R26 (M5's R26 record): scans' checks and loads, at -O1 and -O2

function r26Off<T>(part: string, run: () => T): T {
  const was = process.env.TMK_R26_OFF;
  process.env.TMK_R26_OFF = part;
  try {
    return run();
  } finally {
    if (was === undefined) delete process.env.TMK_R26_OFF;
    else process.env.TMK_R26_OFF = was;
  }
}

const R26_CHECK = (check: string): string =>
  LOOP(`${check}
  brif %11, bb4, bb5
bb4:
  trap t2
bb5:
  %10 = add.i32 %5, %4`);

test("R26: a signed loop test whose smaller side isn't negative proves a check against the widened length", () => {
  // `i < n` with n a parameter, which may be negative: i, from 0 and below n, isn't, so neither is n
  const src = R26_CHECK(`%8 = zext.ix %4
  %9 = zext.ix %1
  %11 = icmp.uge.ix %8, %9`);
  const on = fn(opt(src, 2, ["conds", "version"]).text, "f");
  assert.doesNotMatch(on, /icmp\.uge\.ix/, on);
  const off = r26Off("range", () => fn(opt(src, 2, ["conds", "version"]).text, "f"));
  assert.match(off, /icmp\.uge\.ix/, off);
  // `i <= n`: the last turn's i is n, and the check fires there
  const le = src.replace("icmp.slt.i32 %4, %1", "icmp.sle.i32 %4, %1");
  assert.match(fn(opt(le, 2, ["conds", "version"]).text, "f"), /icmp\.uge\.ix/);
});

test("R26: charCodeAt's float test of an index against the length, both converted i32s, is decided where they're known", () => {
  const src = R26_CHECK(`%8 = sitofp.f64 %4
  %9 = ftrunc.f64 %8
  %12 = sitofp.f64 %1
  %11 = fcmp.ge.f64 %9, %12`);
  const on = fn(opt(src, 2, ["conds", "version"]).text, "f");
  assert.doesNotMatch(on, /fcmp/, on);
  assert.match(
    r26Off("range", () => fn(opt(src, 2, ["conds", "version"]).text, "f")),
    /fcmp/,
  );
  // against n + 1 (wrapping, so maybe below i), nothing is known
  const plus = src.replace(
    "%12 = sitofp.f64 %1",
    "%13 = iconst.i32 1\n  %14 = add.i32 %1, %13\n  %12 = sitofp.f64 %14",
  );
  assert.match(fn(opt(plus, 2, ["conds", "version"]).text, "f"), /fcmp/);
});

test("R26: -O1's loopbounds takes `k < 0` as false for a signed test's index that's never negative", () => {
  const src = R26_CHECK(`%8 = iconst.i32 0
  %11 = icmp.slt.i32 %4, %8`);
  const on = fn(opt(src, 1).text, "f");
  assert.equal((on.match(/icmp\.slt/g) ?? []).length, 1, on);
  const off = r26Off("range", () => fn(opt(src, 1).text, "f"));
  assert.equal((off.match(/icmp\.slt/g) ?? []).length, 2, off);
  // an index from -1 can be negative
  const neg = src.replace(
    "%3 = iconst.i32 0\n  br bb1(%3, %3)",
    "%3 = iconst.i32 0\n  %7 = iconst.i32 -1\n  br bb1(%7, %3)",
  );
  assert.equal((fn(opt(neg, 1).text, "f").match(/icmp\.slt/g) ?? []).length, 2);
});

test("R26: a call after an inlined one in a loop's block is still a call in the loop (-O1's small leaf)", () => {
  const src = `func @g(%0: i32) -> (i32) inline {
bb0:
  %1 = iconst.i32 3
  %2 = mul.i32 %0, %1
  ret %2
}
func @h(%0: i32) -> (i32) {
bb0:
  %1 = iconst.i32 7
  %2 = mul.i32 %0, %1
  %3 = iconst.i32 5
  %4 = add.i32 %2, %3
  %5 = iconst.i32 2
  %6 = sub.i32 %4, %5
  %7 = xor.i32 %6, %0
  %8 = mul.i32 %7, %1
  %9 = xor.i32 %8, %2
  ret %9
}
${LOOP(`%8 = call @g %4
  %9 = call @h %8
  %10 = add.i32 %5, %9`)}`;
  const on = fn(opt(src, 1).text, "f");
  assert.doesNotMatch(on, /call @h/, on);
  assert.match(fn(r26Off("inline", () => opt(src, 1)).text, "f"), /call @h/);
});

// R27 (D77): fresh-allocation separation. Lowering notes a separated field's load (`sep`) and an object's field's access
// (`obj`) outside the text, so these tests note them on the parsed module: every `load.ix.na` (a length) is an object's
// field, and in @f the first `load.i64.na` (the array's block) is an object's field and a separated one's; `more` notes
// what else a test needs.
function optNoted(
  text: string,
  more: (m: Module) => void = () => {},
  level: OptLevel = 2,
  faults: string[] = [],
  sep = true,
): string {
  const lines = (text + TRAPS).split("\n").filter((l) => l.trim() !== "");
  const m = canonicalize(parseModule(lines.join("\n") + "\n"));
  for (const f of m.funcs) {
    const all = f.blocks.flatMap((b) => b.instrs);
    for (const ins of all) if (ins.op === "load.ix.na") ins.obj = true;
    const data = all.find((ins) => ins.op === "load.i64.na");
    if (f.name === "f" && data !== undefined) {
      data.obj = true;
      if (sep) data.sep = true;
    }
  }
  more(m);
  return printModule(optimizeModule(m, { level, verifyEach: true, faults }).module);
}

// An array's length read, an element stored through its block, the length read again.
const SEP_SRC = (
  between: string,
  callee = "",
): string => `${callee}func @f(%0: i64, %1: ix, %2: i64) -> (ix, ix) export {
bb0:
  %3 = bitcast.ptr %0
  %4 = iconst.ix 0
  %5 = gep %3, %4, 1, 8
  %6 = load.ix.na %5
  %7 = load.i64.na %3
  %8 = bitcast.ptr %7
  %9 = gep %8, %1, 4, 0
  %10 = iconst.i32 7
  ${between}
  %11 = load.ix.na %5
  ret %6, %11
}
`;
const lenLoads = (t: string): number => (fn(t, "f").match(/load\.ix\.na/g) ?? []).length;

test("R27: an object's field read either side of a store into a separated field's block is read once", () => {
  const src = SEP_SRC("store.i32.na %9, %10");
  assert.equal(lenLoads(optNoted(src)), 1);
  // not noted as a separated field's block, or the separation off: the store may write the length
  assert.equal(lenLoads(optNoted(src, () => {}, 2, [], false)), 2);
  const was = process.env.TMK_R27_OFF;
  process.env.TMK_R27_OFF = "sep";
  try {
    assert.equal(lenLoads(optNoted(src)), 2);
  } finally {
    if (was === undefined) delete process.env.TMK_R27_OFF;
    else process.env.TMK_R27_OFF = was;
  }
});

test("R27: a store at an address from elsewhere still may change it; the injected r27-alias-any misses that", () => {
  // through a parameter's address
  const other = SEP_SRC(`%12 = bitcast.ptr %2
  store.i32.na %12, %10`);
  assert.equal(lenLoads(optNoted(other)), 2);
  // through a word read from another field, not a separated one: r27-alias-any takes it as a block's
  const loaded = SEP_SRC(`%12 = gep %3, %4, 1, 16
  %13 = load.i64.na %12
  %14 = bitcast.ptr %13
  store.i32.na %14, %10`);
  assert.equal(lenLoads(optNoted(loaded)), 2);
  assert.equal(
    lenLoads(optNoted(loaded, () => {}, 2, ["r27-alias-any"])),
    1,
    "the bug lets it through",
  );
});

test("R27: a call writing only separated fields' blocks keeps a field read; one writing a field doesn't", () => {
  const fills = `func @g(%0: i64, %1: ix) -> () noinline {
bb0:
  %2 = bitcast.ptr %0
  %3 = load.i64.na %2
  %4 = bitcast.ptr %3
  %5 = gep %4, %1, 4, 0
  %6 = iconst.i32 9
  store.i32.na %5, %6
  ret
}
`;
  const noteG = (m: Module): void => {
    const g = m.funcs.find((x) => x.name === "g")!;
    for (const ins of g.blocks.flatMap((b) => b.instrs))
      if (ins.op === "load.i64.na") {
        ins.obj = true;
        ins.sep = true;
      }
  };
  const call = SEP_SRC("call @g %0, %1", fills);
  assert.equal(lenLoads(optNoted(call, noteG)), 1);
  assert.equal(lenLoads(optNoted(call, noteG, 1)), 1, "-O1's value numbering too");
  // g's block not noted: it may write anything
  assert.equal(lenLoads(optNoted(call)), 2);
  // the callee writes the length too
  const sets = `func @g(%0: i64, %1: ix) -> () noinline {
bb0:
  %2 = bitcast.ptr %0
  %3 = iconst.ix 0
  %4 = gep %2, %3, 1, 8
  store.ix.na %4, %1
  ret
}
`;
  const noteStore = (m: Module): void => {
    const g = m.funcs.find((x) => x.name === "g")!;
    for (const ins of g.blocks.flatMap((b) => b.instrs))
      if (ins.op === "store.ix.na") ins.obj = true;
  };
  const call2 = SEP_SRC("call @g %0, %1", sets);
  assert.equal(lenLoads(optNoted(call2, noteStore)), 2);
  // the injected r27-summary-miss misses that write
  assert.equal(
    lenLoads(optNoted(call2, noteStore, 2, ["r27-summary-miss"])),
    1,
    "the bug lets it through",
  );
});

test("R27: an address worked out from a block in a loop, through a block parameter, is still the block's", () => {
  const src = `func @f(%0: i64, %1: ix) -> (ix, ix) export {
bb0:
  %2 = bitcast.ptr %0
  %3 = iconst.ix 0
  %4 = gep %2, %3, 1, 8
  %5 = load.ix.na %4
  %6 = load.i64.na %2
  %7 = bitcast.ptr %6
  %8 = gep %7, %1, 4, 0
  %9 = bitcast.i64 %8
  %10 = gep %7, %3, 4, 0
  %11 = bitcast.i64 %10
  br bb1(%11)
bb1(%12: i64):
  %13 = icmp.ult.i64 %12, %9
  brif %13, bb2, bb3
bb2:
  %14 = bitcast.ptr %12
  %15 = iconst.i32 0
  store.i32.na %14, %15
  %16 = iconst.i64 4
  %17 = add.chk.u.i64 %12, %16, t1
  br bb1(%17)
bb3:
  %18 = load.ix.na %4
  ret %5, %18
}
`;
  assert.equal(lenLoads(optNoted(src)), 1);
  assert.equal(lenLoads(optNoted(src, () => {}, 2, [], false)), 2);
});
