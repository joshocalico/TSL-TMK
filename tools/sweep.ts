// The heavy sweeps' size (SPEC 8.3, D51; the owner's decision of 2026-11-07: "full sweeps run nightly, a rotating subset at
// phase gates"). With TMK_SWEEP unset, every sweep runs whole: `tmk gate --full`, every `tmk milestone`, `tmk test`. With
// TMK_SWEEP=subset, which `tmk gate` sets, a sweep runs one slice of itself, picked by TMK_SWEEP_KEY (the gate's rotation:
// the UTC day), so successive gates cover the whole of it. Every slice a run took is noted in TMK_SWEEP_LOG, and the gate
// puts them in its manifest. A slice is deterministic: the same key gives the same slice.
import { appendFileSync } from "node:fs";

export function subsetting(): boolean {
  return process.env.TMK_SWEEP === "subset";
}

/** The rotation: an integer from the key, the day number unless the gate says otherwise. */
function rotation(): number {
  const key = process.env.TMK_SWEEP_KEY ?? "0";
  const n = Number(key);
  if (Number.isInteger(n)) return n;
  let h = 2166136261;
  for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

function note(label: string, what: string): void {
  const log = process.env.TMK_SWEEP_LOG;
  if (log !== undefined && log !== "") appendFileSync(log, `${label}\t${what}\n`);
}

/**
 * A range of seeds, [start, start + count): whole, or, subsetting, its slice r of `parts` contiguous slices, r turning with
 * the rotation, so `parts` successive gates run every seed. The label names the sweep in the manifest.
 */
export function seedSlice(
  label: string,
  start: number,
  count: number,
  parts: number,
): { start: number; count: number } {
  if (!subsetting() || parts <= 1) return { start, count };
  const r = rotation() % parts;
  const size = Math.ceil(count / parts);
  const from = start + r * size;
  const n = Math.max(0, Math.min(size, start + count - from));
  note(
    label,
    `seeds ${from}..${from + n - 1} of ${start}..${start + count - 1} (slice ${r + 1} of ${parts})`,
  );
  return { start: from, count: n };
}

/** A list (budgets, sites, generated programs): whole, or every `parts`-th element from an offset that turns. */
export function listSlice<T>(label: string, list: T[], parts: number, keep: T[] = []): T[] {
  if (!subsetting() || parts <= 1) return list;
  const r = rotation() % parts;
  const out = list.filter((x, i) => i % parts === r || keep.includes(x));
  const name = (x: T): string => String(x).replace(/^.*\//, "").replace(/\.ts$/, "");
  note(
    label,
    `${out.length} of ${list.length}: ${out.map(name).join(",")} (slice ${r + 1} of ${parts})`,
  );
  return out;
}

/**
 * The generated `finally` programs (tools/exc-gen.ts: every way out of every position, an every-position generator):
 * whole, or, subsetting, a quarter of them, a different quarter each day. Every other program is kept.
 */
export function sliceGenerated(files: string[]): string[] {
  const isGen = (f: string): boolean => /(^|\/)gen_finally_[^/]*$/.test(f);
  const gen = files.filter(isGen);
  if (!subsetting() || gen.length === 0) return files;
  const keep = new Set(listSlice("gen_finally programs", gen, 4));
  return files.filter((f) => !isGen(f) || keep.has(f));
}
