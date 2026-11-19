// R29 (SPEC 8.3, D62, the owner's ruling of 2027-01-21): which cases run until memory is out, so tools/r14-time.ts judges
// their programs at equal work, and how a timing image's lines are read for it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "./corpus.ts";
import { caseKinds, caseTraps, untilOut, type AnyCase } from "./equal-work.ts";

const casesOf = (rel: string): AnyCase[] =>
  JSON.parse(readFileSync(join(ROOT, rel.replace(/\.ts$/, ".cases.json")), "utf8")) as AnyCase[];

test("a case pinned to trap 14 in the mode, with a count first, runs until memory is out", () => {
  assert.equal(untilOut({ fn: "f", args: [1000], lowered_trap: 14 }, "rc"), "count");
  assert.equal(untilOut({ fn: "f", args: [1000], memory_trap: { leak: 14 } }, "leak"), "count");
  assert.equal(untilOut({ fn: "f", args: [1000], memory_trap: { leak: 14 } }, "rc"), false);
  assert.equal(untilOut({ fn: "f", args: [1000], trap: 14 }, "rc"), "count");
  assert.equal(untilOut({ fn: "f", args: [1000], trap: 14 }, "leak"), false);
  assert.equal(untilOut({ fn: "f", args: [1000], trap: 2 }, "rc"), false);
  assert.equal(untilOut({ fn: "f", args: [1000], lowered_trap: 2 }, "rc"), false);
  assert.equal(untilOut({ fn: "f", args: [], lowered_trap: 14 }, "rc"), "no count");
  assert.equal(untilOut({ fn: "f", args: [1.5], lowered_trap: 14 }, "rc"), "no count");
  assert.equal(untilOut({ fn: "f", args: [1000] }, "rc"), false);
});

test("the programs the coordinator named: map_grow_oom and r2_maps run until memory is out in rc, frag doesn't", () => {
  const any = (rel: string) => casesOf(rel).some((c) => untilOut(c, "rc") === "count");
  assert.ok(any("corpus/lower/memory/map_grow_oom.ts"));
  assert.ok(any("corpus/lower/rc-tsl/r2_maps.ts"));
  // frag churns strings far past its limit but no case is pinned to run out: it's judged as every other program is
  assert.ok(!any("corpus/lower/strmap/frag.ts"));
});

test("a timing image's lines: each case's outcome over the passes, and one case's traps", () => {
  const lines = [
    "TMK:READY",
    "TMK:C 0 R 0000000000000334 ",
    "TMK:E 0",
    "TMK:C 1 T 14 ",
    "TMK:TP 1234",
    "TMK:C 0 T 14 ",
    "TMK:C 1 R 3ff0000000000000 ",
  ];
  assert.equal(caseKinds(lines), "0:R 1:T14 0:T14 1:R");
  assert.deepEqual(caseTraps(lines, 0), [14]);
  assert.deepEqual(caseTraps(lines, 1), [14]);
  assert.deepEqual(caseTraps(lines, 2), []);
});
