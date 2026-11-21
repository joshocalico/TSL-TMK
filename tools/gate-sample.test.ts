// `tmk gate --sample` compares a box's detail with its items as an unordered list, and its words exactly (D51).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decisionDetail,
  detailCounts,
  isBenchmarkDetail,
  loadFreeCounts,
  measuredDetail,
  sameListedItems,
  suiteCountDiffs,
} from "./gate.ts";

test("the same items in another order are the same", () => {
  assert.ok(sameListedItems("hvf: a 3, b 4; tcg: c", "tcg: c; hvf: a 3, b 4"));
  assert.ok(sameListedItems("x, y, z", "z, x, y"));
});

test("an item missing, added, changed or repeated differently still differs", () => {
  assert.ok(!sameListedItems("x, y, z", "x, y"));
  assert.ok(!sameListedItems("x, y", "x, y, w"));
  assert.ok(!sameListedItems("pass: x, y", "fail: x, y"));
  assert.ok(!sameListedItems("x, x, y", "x, y, y"));
});

// native-f box 12 (strmap's quick benchmark) in the gate of 2026-11-10 and in a sample of the same tree: a figure one digit
// wider moves its column, and a size row's tirhash is of a program written in the job's own directory (pipe-split).
test("a measuring box's padding and a benchmark's tirhash are what vary, and nothing else is taken out", () => {
  const gate =
    "numTextShort        9.575 ms  V8 0.730 ms (13.12x)  String(i * 0.25), 20,000 short decimals | size nothing             8311 bytes of image, 50 functions, tirhash d4f47e5b076c";
  const sample =
    "numTextShort       11.575 ms  V8 0.730 ms (15.86x)  String(i * 0.25), 20,000 short decimals | size nothing             8311 bytes of image, 50 functions, tirhash d36e36f85b1e";
  assert.equal(measuredDetail(gate), measuredDetail(sample));
  assert.notEqual(
    measuredDetail(gate),
    measuredDetail(sample.replace("short decimals", "long decimals")),
  );
  assert.notEqual(
    measuredDetail(gate),
    measuredDetail(sample.replace("size nothing", "size strings")),
  );
  assert.notEqual(measuredDetail("a b"), measuredDetail("a  c"));
});

// native-a box 14 in the sample of 2026-11-10: the same benchmark, its text with a line saying the load was high (opt-b).
test("a benchmark's warning that the load was high is a measurement, and nothing else it says is", () => {
  const quietHost = "JPEG natively 1.25x V8\n     S4 median 1.12x clang -O2";
  const busyHost = `${quietHost}\n     WARNING: load 9.3 on 10 CPUs: these numbers are rough`;
  assert.equal(measuredDetail(quietHost), measuredDetail(busyHost));
  assert.notEqual(
    measuredDetail(quietHost),
    measuredDetail(`${quietHost}\n     WARNING: something else`),
  );
});

// native-c box 1 in the sample of 2026-11-26: it quotes `tmk lower --memory rc`'s output, cut at 120 characters, and the
// job's directory in the sample is a longer path, so the cut falls elsewhere (the clsid step). Its counts are what's
// compared, and a count that differs still differs.
test("a box that quotes a tool is compared by its counts, which still catch a change", () => {
  const gate =
    "247/247 must-fail programs, exact code and position; new codes uncovered: none; --memory rc: /Users/x/build/jobs/native-c-1/lower/store_closure.tir, native only\ntirhash 28940b";
  const sample =
    "247/247 must-fail programs, exact code and position; new codes uncovered: none; --memory rc: /Users/x/build/sample/2026-11-26T01-02-03-456Z/native-c-1/lower/store_closure.tir, ; tmk lower takes the pack";
  assert.equal(detailCounts(gate), detailCounts(sample));
  assert.notEqual(detailCounts(gate), detailCounts(sample.replace("247/247", "246/247")));
  assert.equal(detailCounts("no counts here"), "");
});

// native-g box 8 in the sample of 2026-11-28: a benchmark box nobody had flagged as measuring, whose figures differ from
// run to run. A box whose detail has a benchmark's header is measuring, whatever its registry entry says (R1b).
test("a box whose detail has a benchmark's header is measuring, and only that", () => {
  const gate =
    "host: 10 CPUs, load start 19.8 28.8 33.4, end 19.2 28.3 33.2 | 1 processes, warm-up 2 discarded, median of 5, under HVF | vecPushRead  std 0.798 ms; alloc 0.671 ms (std is 1.19x)";
  const sample =
    "host: 10 CPUs, load start 3.1 4.0 5.2, end 3.0 4.0 5.2 | 1 processes, warm-up 2 discarded, median of 5, under HVF | vecPushRead  std 0.811 ms; alloc 0.659 ms (std is 1.23x)";
  assert.ok(isBenchmarkDetail(gate));
  assert.ok(isBenchmarkDetail(sample));
  assert.ok(
    isBenchmarkDetail("4 rows\nhost: 8 CPUs, load start 1.0 1.0 1.0, end 1.0 1.0 1.0\nlist 1.0 ms"),
  );
  assert.equal(measuredDetail(gate), measuredDetail(sample));
  assert.notEqual(
    measuredDetail(gate),
    measuredDetail(sample.replace("vecPushRead", "vecPushOnly")),
  );
  // a box that only mentions a host, or CPUs, isn't one
  assert.ok(!isBenchmarkDetail("12/12 cases; the host has 10 CPUs"));
  assert.ok(!isBenchmarkDetail("ghost: 10 CPUs"));
  assert.ok(!isBenchmarkDetail("247/247 must-fail programs, exact code and position"));
});

test("an injected bug's caught count is load-dependent where answers are given: answers compared, caught only above zero", () => {
  const suite = (caught: number, answers: number) => [
    { name: 'std.faultRun({"name":"the named allocator ignored"})', counts: { caught, answers } },
  ];
  // native-g box 6 at -O0 under load: one image timed out and 14 more cases counted as caught, the answers the same
  assert.deepEqual(suiteCountDiffs(suite(17, 3), suite(3, 3)), []);
  // a different number of wrong answers still differs, and so does a bug no longer caught at all
  assert.equal(suiteCountDiffs(suite(17, 3), suite(17, 4)).length, 1);
  assert.equal(suiteCountDiffs(suite(3, 0), suite(0, 0)).length, 1);
  // a suite counting caught alone is compared as it was
  const alone = (caught: number) => [{ name: "gc.rcTslFaultRun({})", counts: { caught } }];
  assert.equal(suiteCountDiffs(alone(17), alone(3)).length, 1);
  // R7: rc's, the GC library's and R2's runs give answers too: pipe-d box 21 under load (410 caught) against quiet (223)
  const rc = (caught: number, answers: number) => [
    {
      name: 'gc.rcTslFaultRun({"name":"a drop the expansion leaves out"})',
      counts: { caught, answers },
    },
  ];
  assert.deepEqual(suiteCountDiffs(rc(410, 223), rc(223, 223)), []);
  assert.equal(suiteCountDiffs(rc(410, 223), rc(410, 222)).length, 1);
  assert.equal(suiteCountDiffs(rc(5, 0), rc(0, 0)).length, 1);
  assert.deepEqual(loadFreeCounts({ caught: 17, answers: 3, broken: 0 }), {
    caught: 1,
    answers: 3,
    broken: 0,
  });
});

// pipe-d box 26 in R11's sample (2026-11-16): the same tree, and a quick run's cell over 1.00x under the sample's load, so
// one more line, that cell measured again in full. The box asserts AUTO_RC's state; its figures are the measurement.
test("a speed box is compared by the decisions it asserts, not by its measurement's lines", async () => {
  const { decisionsByKey } = await import("./registry.ts");
  const re = decisionsByKey("pipe-d/26@unset");
  assert.ok(re !== null);
  const gate =
    "AUTO_RC on; -O1:\nhost: 10 CPUs, load start 11.2 5.4 3.5\nlowered list (listWork), native rc: TSL classes against direct     0.430 ms   direct: 1.215 ms, 0.35x";
  const sample = `${gate}\n-O2 lowered acyclic (acyclicWork): quick 1.00x, in full 0.95x (load 23.1 17.0 9.8)`;
  assert.equal(decisionDetail(gate, re), decisionDetail(sample, re));
  assert.equal(decisionDetail(gate, re), "AUTO_RC on");
  // A decision that changed still differs.
  assert.notEqual(
    decisionDetail(gate, re),
    decisionDetail(sample.replace("AUTO_RC on", "AUTO_RC off"), re),
  );
  // And a box with no decisions listed is compared as before.
  assert.equal(decisionsByKey("pipe-d/3@unset"), null);
});

// opt-a box 4 in R34's sample (2026-11-21): every -O0 compileTyped was one suite name, and a compile under 50 ms isn't kept
// (timing.ts), so the gate kept js_map.ts's string table and the sample ergo_alloc.ts's under that one name: neither list a
// part of the other. A compile is named by its program, so what two runs both kept is the same program's.
test("a compile's suite is named by its program, so runs that kept different programs compare those both kept", async () => {
  const { startMilestone, timedFn } = await import("./timing.ts");
  const rec = startMilestone("t", [0], 1);
  const compile = timedFn(
    "tslc.compileTyped",
    (m: { file: string; strings: Map<string, number> }, _o: { opt: number }) => {
      const t = performance.now();
      while (performance.now() - t < 60); // over the 50 ms a synchronous suite needs to be kept
      return { meta: { exports: {}, strings: Object.fromEntries(m.strings) } };
    },
  );
  compile({ file: "corpus/std/leak/js_map.ts", strings: new Map([["héllo", 1]]) }, { opt: 0 });
  rec.closeBox("4");
  const kept = rec.finish().boxes[0]!.suites;
  assert.deepEqual(
    kept.map((s) => s.name),
    ['tslc.compileTyped(corpus/std/leak/js_map.ts, {"opt":0})'],
  );
  assert.deepEqual(kept[0]!.counts, { "meta.strings.héllo": 1 });
  const s = (file: string, counts: Record<string, number>) => ({
    name: `tslc.compileTyped(${file}, {"opt":0})`,
    counts,
  });
  const shared = s("corpus/std/std_new_safety.ts", { "meta.strings.abc": 4 });
  const gate = [s("corpus/std/leak/js_map.ts", { "meta.strings.héllo": 3 }), shared];
  const sample = [s("corpus/std/ergo_alloc.ts", { "meta.strings.the quick brown fox": 1 }), shared];
  assert.deepEqual(suiteCountDiffs(gate, sample), []);
  // the same program's table changed still differs
  const changed = [s("corpus/std/std_new_safety.ts", { "meta.strings.abd": 4 })];
  assert.equal(suiteCountDiffs(gate, changed).length, 1);
});
