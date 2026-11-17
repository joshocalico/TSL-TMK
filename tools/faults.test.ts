// SPEC 8.3's fault rule (R18): every injected bug the tools know is in the build when its runner puts it in. A patch's text
// is in its file exactly as many times as it says, and a bug put in by name has a hook in the compiler naming it. A source
// edit that orphans a bug fails here, in `tmk test --changed`, before any box runs it; a runner that put it in anyway would
// fail as a harness failure, never as caught.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTestPatch, occurrences } from "../compiler/host/test-patch.ts";
import {
  faultFailures,
  FaultHarnessError,
  hookSources,
  patchEnv,
  registeredFaults,
  registeredProblem,
} from "./faults.ts";

test("every registered injected bug applies exactly as its list says", async () => {
  const all = await registeredFaults();
  assert.ok(all.length >= 150, `only ${all.length} registered bugs`);
  const hooks = hookSources();
  const bad = all.flatMap((f) => {
    const why = registeredProblem(f, hooks);
    return why === undefined ? [] : [`${f.list}: ${f.name}: ${why}`];
  });
  assert.deepEqual(bad, []);
  // and the check sees an orphan: a hook no compiler source names, a patch whose text is gone
  const orphan = { list: "test", name: "orphan", patches: [] };
  assert.ok(
    registeredProblem(
      { ...orphan, hook: { env: "TMK_TEST_TSL", value: "no-such-hook-r18" } },
      hooks,
    ),
  );
  assert.ok(
    registeredProblem(
      {
        ...orphan,
        patches: [{ file: "packages/tsl-gc/ex-gc-rc.ts", from: "no such text", to: "" }],
      },
      hooks,
    ),
  );
});

test("a stale, ambiguous or missing patch is a harness failure, never applied", () => {
  const file = "packages/tsl-gc/ex-gc-rc.ts";
  assert.throws(
    () => patchEnv({ file, from: "no such text in the source", to: "" }),
    FaultHarnessError,
  );
  assert.throws(() => patchEnv({ file, from: "\n", to: "" }), FaultHarnessError); // many times, not once
  assert.throws(() => patchEnv({ file: "no-such-file.ts", from: "x", to: "" }), FaultHarnessError);
  assert.throws(() => patchEnv([]), FaultHarnessError);
  assert.throws(
    () => applyTestPatch("a b a", { file, from: "a", to: "c" }),
    /TSL_TEST_PATCH: 2 of/,
  );
  assert.throws(() => applyTestPatch("a b", { file, from: "z", to: "c" }), /TSL_TEST_PATCH: no/);
  assert.equal(applyTestPatch("a b a", { file, from: "a", to: "$&", times: 2 }), "$& b $&");
  assert.equal(occurrences("aaaa", "aa"), 2);
});

test("a fault run whose builds say the patch didn't apply throws; other failures are its catches", () => {
  assert.throws(
    () => faultFailures(['x.ts: FAILED: Error: TSL_TEST_PATCH: no "y" in z.ts'], "bug"),
    FaultHarnessError,
  );
  assert.deepEqual(faultFailures(["x.ts on hvf: case 1 gave 2, V8 gave 3"]), [
    "x.ts on hvf: case 1 gave 2, V8 gave 3",
  ]);
});
