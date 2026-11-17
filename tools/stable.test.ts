// The stable orders a box's detail is built in (R20): the same lists, in any finishing order, print the same.
import assert from "node:assert/strict";
import { test } from "node:test";
import { firstInOrder, inStableOrder, naturalCompare, sortedCounts } from "./stable.ts";

test("failures sort by file, then function and case index, case numbers as numbers", () => {
  const xs = [
    "corpus/lower/exc/gen_finally_try_catch_break.ts f#10: 3",
    "corpus/lower/exc/gen_finally_catch_catch_throw.ts f#2: 1",
    "corpus/lower/exc/gen_finally_try_catch_break.ts f#9: 3",
    "corpus/lower/exc/gen_finally_catch_catch_throw.ts f#2: 0",
  ];
  assert.deepEqual(inStableOrder([...xs]), [
    "corpus/lower/exc/gen_finally_catch_catch_throw.ts f#2: 0",
    "corpus/lower/exc/gen_finally_catch_catch_throw.ts f#2: 1",
    "corpus/lower/exc/gen_finally_try_catch_break.ts f#9: 3",
    "corpus/lower/exc/gen_finally_try_catch_break.ts f#10: 3",
  ]);
  assert.equal(firstInOrder(xs), "corpus/lower/exc/gen_finally_catch_catch_throw.ts f#2: 0");
  assert.equal(firstInOrder([...xs].reverse()), firstInOrder(xs));
  assert.equal(firstInOrder([]), undefined);
});

test("the order is total and doesn't lose long numbers", () => {
  assert.ok(naturalCompare("a 123456789012345678901", "a 123456789012345678902") < 0);
  assert.ok(naturalCompare("a 007", "a 7") > 0);
  assert.ok(naturalCompare("a 7", "a 007") < 0);
  assert.equal(naturalCompare("x", "x"), 0);
  assert.ok(naturalCompare("x", "x y") < 0);
});

test("a count map prints the same whatever order it was filled in", () => {
  const a = { "14 (recursion too deep)": 9, "4 (memory)": 2 };
  const b = { "4 (memory)": 2, "14 (recursion too deep)": 9 };
  assert.equal(JSON.stringify(sortedCounts(a)), JSON.stringify(sortedCounts(b)));
  assert.equal(JSON.stringify(sortedCounts(a)), '{"4 (memory)":2,"14 (recursion too deep)":9}');
});
