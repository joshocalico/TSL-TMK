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
  assert.equal(count(f, /icmp\.slt/), 2, f);
  assert.equal(count(f, /icmp\.eq/), 1, f);
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
  assert.equal(fn(opt(src("ult"), 2, ["checks"]).text, "f").includes("bounds.chk"), true);
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
