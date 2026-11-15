// The RAM channel (SPEC 8.2, D45) has to catch what serial would have shown: a wrong value, a result cut short, and a guest that
// dies partway, naming the case. Each row is a fault put in on purpose, on a real program, with V8 as the reference.
import { readFileSync } from "node:fs";
import type { BulkFault } from "../compiler/backend-aarch64/rt-tir.ts";
import { ROOT } from "./corpus.ts";
import type { LowerCase } from "./lower-exec.ts";
import { qemuRun, type Accel } from "./qemu-run.ts";
import { lowerFile } from "./lowering.ts";
import {
  buildDownImage,
  BULK_BYTES,
  downResults,
  type DownMetaLike,
  type RcHarness,
} from "./native-exec.ts";
import { compareResults, referenceOnV8 } from "./strmap-run.ts";

export interface ChannelRow {
  what: string;
  caught: boolean;
  how: string;
}

const FILE = `${ROOT}/corpus/lower/strmap/map_basic.ts`;

/** Runs the program under one fault, and returns everything a suite would have been told about it. */
async function runWith(
  accel: Accel,
  cases: LowerCase[],
  want: Awaited<ReturnType<typeof referenceOnV8>>,
  fault: NonNullable<RcHarness["channelFault"]>,
  opts: { timeoutMs?: number; bulkBytes?: number } = {},
): Promise<{ status: string; ok: boolean; problems: string[]; finished: number; why: string }> {
  const o = lowerFile(FILE, { memory: "rc" });
  const built = buildDownImage(o.tir!, o.meta as DownMetaLike, cases, undefined, {
    bulkBytes: opts.bulkBytes ?? BULK_BYTES,
    channelFault: fault,
  });
  const r = await qemuRun({
    name: `channel/${accel}`,
    image: built.image.bytes,
    accel,
    timeoutMs: opts.timeoutMs ?? 60_000,
    bulk: built.image.bulk!,
  });
  const res = downResults(o.meta as DownMetaLike, cases, built.placements, r.lines);
  return {
    status: r.status,
    ok: r.ok,
    problems: [...res.problems, ...compareResults(res.results, want, cases, "rc")],
    finished: res.results.length,
    why: r.why,
  };
}

export async function channelTests(accel: Accel): Promise<{
  skipped: boolean;
  rows: ChannelRow[];
  failures: string[];
}> {
  const cases = JSON.parse(
    readFileSync(FILE.replace(/\.ts$/, ".cases.json"), "utf8"),
  ) as LowerCase[];
  const want = await referenceOnV8(FILE, cases);
  const rows: ChannelRow[] = [];
  const add = (what: string, caught: boolean, how: string): void => {
    rows.push({ what, caught, how: how.slice(0, 240) });
  };
  const clean = await runWith(accel, cases, want, {});
  if (clean.status === "skip") return { skipped: true, rows, failures: [] };
  // With no fault it has to pass, or everything below shows nothing.
  add(
    "no fault: every case comes back and agrees with V8",
    clean.ok && clean.problems.length === 0 && clean.finished === cases.length,
    `${clean.status}, ${clean.finished}/${cases.length} cases, ${clean.problems.length} problems`,
  );
  const mid = Math.floor(cases.length / 2);
  // A wrong value: it reads back and the comparison sees it, on the case it's in.
  const wrong = await runWith(accel, cases, want, { wrongLeaf: mid });
  add(
    `a wrong value reported by case ${mid}`,
    wrong.problems.some((p) => p.includes(`#${mid}`)),
    wrong.problems[0] ?? "no problem reported",
  );
  // Changed after the guest's checksum: nothing but the checksum can see it.
  for (const [fault, what] of [
    ["flip", "a byte changed after the guest's checksum"],
    ["short", "the guest reports fewer bytes than it wrote"],
    ["no-trailer", "TMK:DONE with no TMK:BULK"],
  ] as [BulkFault, string][]) {
    const f = await runWith(accel, cases, want, { bulk: fault });
    add(what, !f.ok && f.status === "bad-channel", `${f.status}: ${f.why}`);
  }
  // Truncated, and the guest's own count and checksum agree with what's left: the cases say it.
  const cut = await runWith(accel, cases, want, { bulk: "truncate" });
  add(
    "a truncated result, with a matching count and checksum",
    cut.problems.some((p) => /never finished/.test(p)),
    cut.problems[0] ?? "no problem reported",
  );
  // A guest dying partway: serial says so, and what's in RAM says how far it got.
  const crash = await runWith(accel, cases, want, { crash: mid });
  add(
    `a fault nothing catches in case ${mid}`,
    crash.status === "fatal" &&
      crash.finished === mid &&
      crash.problems.some((p) => p.startsWith(`case ${mid} `)),
    `${crash.status}, ${crash.finished} cases finished: ${crash.problems[0] ?? ""}`,
  );
  const hang = await runWith(accel, cases, want, { hang: mid }, { timeoutMs: 8000 });
  add(
    `a hang in case ${mid}, killed by the timeout`,
    hang.status === "timeout" &&
      hang.finished === mid &&
      hang.problems.some((p) => p.startsWith(`case ${mid} `)),
    `${hang.status}, ${hang.finished} cases finished: ${hang.problems[0] ?? ""}`,
  );
  // Past the end of the channel: a fatal stop, never a quiet cut.
  const full = await runWith(accel, cases, want, {}, { bulkBytes: 2 * 1024 * 1024 });
  add(
    "more output than the channel holds",
    full.status === "fatal" && /bulk channel full/.test(full.why),
    `${full.status}: ${full.why}`,
  );
  return {
    skipped: false,
    rows,
    failures: rows.filter((r) => !r.caught).map((r) => `${accel}: not caught: ${r.what}: ${r.how}`),
  };
}
