// One program in a test build of `rc`, under QEMU: `node tools/rc-run.ts <file> [--check] [--account] [--accel tcg]
// [--pages n] [--repeat n] [--omit-inc n] [--omit-dec n] [--no-elide] [--cycles-off] [--budget n] [--no-pace] [--fault f]`.
// Prints each case's result and counters. A debugging aid.
import { readFileSync } from "node:fs";
import { lowerFile } from "../compiler/host/tslc.ts";
import { buildDownImage, downResults, rcStatLines, type DownMetaLike } from "./native-exec.ts";
import { qemuRun, type Accel } from "./qemu-run.ts";

const argv = process.argv.slice(2);
const file = argv[0]!;
const flag = (n: string): boolean => argv.includes(n);
const val = (n: string): number | undefined => {
  const i = argv.indexOf(n);
  return i < 0 ? undefined : Number(argv[i + 1]);
};
const o = lowerFile(file, {
  memory: "rc",
  rc: {
    check: flag("--check"),
    account: flag("--account"),
    elide: !flag("--no-elide"),
    ...(flag("--cycles-off") ? { cycles: false } : {}),
    ...(val("--budget") !== undefined ? { budget: val("--budget")! } : {}),
    ...(flag("--no-pace") ? { pace: false } : {}),
    ...(flag("--fault") ? { ccFault: argv[argv.indexOf("--fault") + 1] as never } : {}),
    ...(val("--omit-inc") !== undefined ? { omitInc: val("--omit-inc")! } : {}),
    ...(val("--omit-dec") !== undefined ? { omitDec: val("--omit-dec")! } : {}),
  },
});
if (o.tir === null) throw new Error(JSON.stringify(o.diags));
const cases0 = JSON.parse(readFileSync(file.replace(/\.ts$/, ".cases.json"), "utf8")) as never[];
const repeat = val("--repeat") ?? 1;
const cases = Array.from({ length: repeat }, () => cases0).flat();
const pages =
  val("--pages") ??
  (() => {
    const m = /^\/\/ memory-pages: (\d+)$/m.exec(readFileSync(file, "utf8"))?.[1];
    return m !== undefined ? Number(m) : undefined;
  })();
const built = buildDownImage(o.tir, o.meta as DownMetaLike, cases, pages, {
  stats: flag("--account"),
  collect: flag("--check") || flag("--account"),
});
const r = await qemuRun({
  name: "rc-run",
  image: built.image.bytes,
  accel: (argv.includes("--accel") ? argv[argv.indexOf("--accel") + 1] : "hvf") as Accel,
  timeoutMs: 120_000,
});
console.log(r.status, r.why.slice(0, 300));
const { results, problems } = downResults(o.meta as DownMetaLike, cases, built.placements, r.lines);
const stats = rcStatLines(o.tir, r.lines);
results.forEach((x, i) => {
  console.log(
    i,
    x.fn,
    JSON.stringify(x.result).slice(0, 120),
    stats[i] !== undefined ? JSON.stringify(stats[i]) : "",
  );
});
for (const p of problems) console.log("PROBLEM", p);
console.log("rc stats", JSON.stringify(o.rc));
if (r.why.includes("elr=")) {
  const elr = Number.parseInt(/elr=([0-9a-f]+)/.exec(r.why)![1]!, 16) - 0x40200000;
  for (const x of built.image.ranges)
    if (elr >= x.from && elr < x.to) console.log("in", x.name, (elr - x.from).toString(16));
}
