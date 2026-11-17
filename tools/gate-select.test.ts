// `tmk test --changed` plans the gate's tops for a picked job the quick tier hasn't got (D51, R21).
import assert from "node:assert/strict";
import { test } from "node:test";
import { needsGateTops } from "./gate.ts";

const quick = new Set(["test/1@unset", "test/2@unset", "test/35@unset"]);

test("only the quick tier's own jobs picked: the quick tier's plan is enough", () => {
  assert.equal(needsGateTops([], quick), false);
  assert.equal(needsGateTops([{ key: "test/1@unset" }, { key: "test/35@unset" }], quick), false);
});

test("a gate job picked needs the gate's tops, a `test` job at another level included", () => {
  // R21: the unit tests a new .test.ts file reaches, at level 1 in the gate, were picked and never planned
  assert.equal(needsGateTops([{ key: "test/1@unset" }, { key: "test/1@1" }], quick), true);
  assert.equal(needsGateTops([{ key: "pipe-d/59@unset" }], quick), true);
});
