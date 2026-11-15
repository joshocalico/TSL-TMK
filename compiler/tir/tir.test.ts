// Verifier accept and reject, and the canonical round trip (SPEC 8.1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCfg, canonicalize, type Module } from "./ir.ts";
import { parseModule, printModule, tirHash } from "./text.ts";
import { verifyModule } from "./verify.ts";

const SUM = `func @sum(%0: ptr, %1: ix) -> (i32) {
bb0:
  %2 = iconst.i32 0
  %3 = iconst.ix 0
  br bb1(%3, %2)
bb1(%4: ix, %5: i32):
  %6 = icmp.ult.ix %4, %1
  brif %6, bb2, bb3
bb2:
  %7 = bounds.chk %4, %1, t1
  %8 = gep %0, %7, 1, 0
  %9 = load.i8.na %8
  %10 = zext.i32 %9
  %11 = add.chk.u.i32 %5, %10, t2
  %12 = iconst.ix 1
  %13 = add.chk.u.ix %4, %12, t3
  br bb1(%13, %11)
bb3:
  ret %5
}
trap t1 bounds code=2 a.ts:1:1
trap t2 overflow code=1 a.ts:1:2
trap t3 overflow code=1 a.ts:1:3
`;

const EVERYTHING = `sig sig0 (i32) -> (i32)
global @g size=8 align=8 section=data bytes=0102030405060708
func @callee(%0: i32) -> (i32) inline {
bb0:
  ret %0
}
func @f(%0: i32, %1: i64, %2: f64, %3: f32) -> (i32, i64) export noalloc {
bb0:
  %4 = funcaddr @callee
  %5 = call.indirect sig0 %4, %0
  %6 = call @callee %5
  %7 = globaladdr @g
  %8 = load.i64.na %7
  store.i64.na %7, %8
  %9 = shl.js32 %0, %6
  %10 = lshr.big %1, %8
  %11 = range.chk.u.i64 %10, 0, ixmax, t1
  %12 = trunc.ix %11
  %13 = zext.i64 %12
  %14 = fconst.f64 0x7ff8000000000000
  %15 = fmin.js.f64 %2, %14
  %16 = js.toint32 %15
  %17 = fpromote %3
  %18 = fdemote %17
  %19 = fptoui.sat.i32 %18
  %20 = intrinsic clz32 %19
  %21 = select.i32 %20, %16, %9
  %22 = sdiv.i32 %21, %20, t2
  switch %22 [-1: bb1, 7: bb2(%13)] default bb3
bb1:
  trap t3
bb2(%23: i64):
  ret %22, %23
bb3:
  unreachable
}
trap t1 convert code=4 a.ts:2:1
trap t2 div code=3 a.ts:2:2
trap t3 user code=1000 a.ts:2:3
`;

test("canonical text round-trips", () => {
  for (const text of [SUM, EVERYTHING]) {
    const m = parseModule(text);
    assert.deepEqual(verifyModule(m), []);
    assert.equal(printModule(m), text);
    assert.deepEqual(parseModule(printModule(m)), m);
  }
});

test("canonicalisation is idempotent, and hashes are stable", () => {
  const m = parseModule(EVERYTHING);
  const once = canonicalize(m);
  assert.equal(printModule(canonicalize(once)), printModule(once));
  assert.equal(tirHash(once), tirHash(canonicalize(once)));
  assert.notEqual(tirHash(parseModule(SUM)), tirHash(parseModule(EVERYTHING)));
});

function rejects(text: string, why: RegExp): void {
  const errors = verifyModule(parseModule(text));
  assert.ok(errors.length > 0, `accepted: ${text}`);
  assert.ok(
    errors.some((e) => why.test(e)),
    `wrong errors: ${errors.join("; ")}`,
  );
}

test("the verifier rejects ill-typed and ill-formed functions", () => {
  rejects(
    "func @f(%0: i32) -> (i32) {\nbb0:\n  %1 = add.i32 %0, %0\n  ret %1, %1\n}\n",
    /ret with 2/,
  );
  rejects("func @f(%0: i32) -> (i64) {\nbb0:\n  ret %0\n}\n", /expected i64/);
  rejects(
    "func @f(%0: i32, %1: i64) -> () {\nbb0:\n  %2 = add.i32 %0, %1\n  ret\n}\n",
    /expected i32/,
  );
  rejects("func @f() -> () {\nbb0:\n  br bb9\n}\n", /unknown bb9/);
  rejects("func @f() -> () {\nbb0:\n  br bb1\nbb1(%0: i32):\n  ret\n}\n", /passes 0 args/);
  rejects("func @f() -> () {\nbb0:\n  ret\nbb1:\n  ret\n}\n", /unreachable blocks/);
  rejects("func @f() -> () {\nbb0:\n  %0 = bounds.chk %1, %1, t9\n  ret\n}\n", /undefined/);
  assert.throws(
    () => parseModule("func @f() -> () {\nbb0:\n  call @missing\n  ret\n}\n"),
    /unknown/,
  );
  rejects("func @f() -> () {\nbb0:\n  trap t3\n}\n", /unknown trap/);
  rejects(
    "func @f(%0: i32) -> () {\nbb0:\n  switch %0 [1: bb1, 1: bb1] default bb1\nbb1:\n  ret\n}\n",
    /duplicate key/,
  );
  // A use that isn't dominated by its definition.
  rejects(
    `func @f(%0: i32) -> (i32) {
bb0:
  brif %0, bb1, bb2
bb1:
  %1 = iconst.i32 1
  br bb3
bb2:
  br bb3
bb3:
  ret %1
}
`,
    /does not dominate/,
  );
  // Using a value before it's defined in the same block.
  rejects(
    "func @f() -> (i32) {\nbb0:\n  %1 = add.i32 %0, %0\n  %0 = iconst.i32 1\n  ret %1\n}\n",
    /does not dominate/,
  );
});

test("the verifier accepts swapped block parameters across a loop", () => {
  const swap: Module = parseModule(`func @f(%0: i32, %1: i32) -> (i32) {
bb0:
  br bb1(%0, %1)
bb1(%2: i32, %3: i32):
  brif %2, bb1(%3, %2), bb2
bb2:
  ret %3
}
`);
  assert.deepEqual(verifyModule(swap), []);
  const cfg = buildCfg(swap.funcs[0]!);
  assert.deepEqual(cfg.rpo, [0, 1, 2]);
  assert.equal(cfg.idom.get(2), 1);
});
