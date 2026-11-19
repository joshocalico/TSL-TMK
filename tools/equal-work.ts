// R29, the owner's ruling of 2027-01-21 (SPEC 8.3, D62): which programs run until memory is out, so tools/r14-time.ts
// judges them at equal work, and what a timing image's lines say each case did.
import type { LowerCase } from "./lower-exec.ts";

/** A case as a cases file has it: the lowered corpus's pins, and the `rc`-only corpora's own (`trap`, `value`). */
export type AnyCase = LowerCase & { trap?: number };

/**
 * R29, the owner's ruling (2027-01-21; SPEC 8.3, D62): a case that runs until memory is out is one pinned to trap 14 in
 * this mode (`lowered_trap` 14, `memory_trap`'s entry for the mode 14, or an `rc`-only corpus's `trap` 14), and its first
 * argument is then its count of work: such a program is judged at equal work, not by its time to the trap. A case pinned so
 * whose first argument isn't a count can't be: its program is judged as before, by its time to the trap.
 */
export function untilOut(c: AnyCase, mode: string): "count" | "no count" | false {
  const pinned =
    c.lowered_trap === 14 ||
    (c.memory_trap as Record<string, number> | undefined)?.[mode] === 14 ||
    (c.trap === 14 && mode === "rc");
  if (!pinned) return false;
  const n = c.args[0];
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? "count" : "no count";
}

/** How many times case `i` trapped over a timing image's passes, and with which codes. */
export function caseTraps(lines: string[], i: number): number[] {
  const out: number[] = [];
  for (const l of lines) {
    const m = /^TMK:C (\d+) T (\d+)/.exec(l);
    if (m !== null && Number(m[1]) === i) out.push(Number(m[2]));
  }
  return out;
}

/** Each case's outcome in order over a timing image's passes, its trap code if it trapped: "0:R 1:T14 ...". */
export function caseKinds(lines: string[]): string {
  const out: string[] = [];
  for (const l of lines) {
    const m = /^TMK:C (\d+) (R|T (\d+))/.exec(l);
    if (m !== null) out.push(`${m[1]}:${m[3] !== undefined ? `T${m[3]}` : "R"}`);
  }
  return out.join(" ");
}
