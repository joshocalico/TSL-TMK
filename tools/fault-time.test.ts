// An injected bug's `answers` count is the wrong results and trap codes it caused, which don't depend on the host's load
// (R7); what ran out of time does, and isn't counted (corpus.ts's ranOutOfTime). R12 found pipe-d box 21's count going
// from 223 to 410 under load anyway: a reference on V8 that guarded-run killed at its wall-clock limit wasn't seen as out of
// time ("over the 30000 ms wall-clock limit"), and every case of its program was then a wrong answer against nothing
// ("V8 gave undefined"). Both are fixed; these keep them fixed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ranOutOfTime, wrongAnswers } from "./corpus.ts";
import { guardedRun } from "./guarded-run.ts";
import { disagreement } from "./pipe-tests.ts";

test("a child killed at its wall-clock limit ran out of time, in guarded-run's own words", async () => {
  const r = await guardedRun(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], {
    timeoutMs: 200,
    label: "sleeper",
  });
  assert.equal(r.timedOut, true);
  assert.ok(ranOutOfTime(`corpus/rc/cyc_giveup.ts: failed on V8: ${r.why} `), r.why);
  assert.ok(ranOutOfTime(`corpus/rc/cyc_giveup.ts: reference failed on V8: ${r.why} `), r.why);
});

test("what QEMU's limit and an unfinished case say ran out of time; a wrong result or a trap doesn't", () => {
  assert.ok(
    ranOutOfTime(
      "corpus/rc/cyc_churn.ts on hvf: timeout: over the 60000 ms limit. Last serial lines:",
    ),
  );
  assert.ok(ranOutOfTime("corpus/rc/cyc_churn.ts on hvf: case 3 (rings) never finished"));
  assert.ok(!ranOutOfTime('corpus/rc/cyc_churn.ts on hvf: rings#2: {"trap":14}, V8 gave 500500'));
  assert.ok(!ranOutOfTime("corpus/rc/adv_borrow.ts: exits#6: as written 56014, expanded 56514"));
  assert.ok(!ranOutOfTime("corpus/rc/x.ts: reference failed on V8: exit 1 TypeError"));
});

test("box 21's loaded run: what's counted is what the quiet run counted", () => {
  // The shape of R12's measured runs of "a drop at a scope's exit left out" (/tmp/r12/b21-*.json): the quiet run's wrong
  // answers, and under load the same ones with a reference killed at its limit, whose program's cases are now not
  // compared at all (corpus.ts runNative), where before each was a line of its own against nothing.
  const quiet = [
    'corpus/rc/cyc_churn.ts on hvf: rings#2: {"trap":14}, V8 gave 500500',
    "corpus/rc/adv_borrow.ts: exits#6: as written 56014, expanded 56514",
  ];
  const loaded = [
    ...quiet,
    "corpus/rc/cyc_giveup.ts: failed on V8:  killed: over the 30000 ms wall-clock limit ",
    "corpus/rc/cyc_giveup.ts on hvf: timeout: over the 60000 ms limit. Last serial lines:",
    "corpus/rc/cyc_giveup.ts on hvf: case 9 (gaveUp) never finished",
  ];
  assert.equal(wrongAnswers(loaded), wrongAnswers(quiet));
});

test("a case a route's run never reached because it ran out of time isn't a wrong answer; one it never reached otherwise is", () => {
  const c = { fn: "rings" };
  const late = disagreement("p.ts leak -O2 hvf", c, 2, '{"result":1}', undefined, {
    direct: false,
    tsl: true,
  });
  assert.ok(ranOutOfTime(late), late);
  const lateDirect = disagreement("p.ts leak -O2 hvf", c, 2, undefined, '{"result":1}', {
    direct: true,
    tsl: false,
  });
  assert.ok(ranOutOfTime(lateDirect), lateDirect);
  // the TSL route stopped (a crash or a trap that ended the image), not out of time: a wrong answer
  const stopped = disagreement("p.ts leak -O2 hvf", c, 2, '{"result":1}', undefined, {
    direct: false,
    tsl: false,
  });
  assert.ok(!ranOutOfTime(stopped), stopped);
  // both gave something, and differ: a wrong answer whatever the time
  const wrong = disagreement("p.ts leak -O2 hvf", c, 2, '{"result":1}', '{"result":2}', {
    direct: true,
    tsl: true,
  });
  assert.ok(!ranOutOfTime(wrong), wrong);
});
