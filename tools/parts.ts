// Parts of a box, each run in a process and build directory of its own, a few at once (D76, T2): the pattern of opt-a box
// 12's bugs (opt-tests.ts faultsInParts), for the other boxes that set the gate's floor. A part runs exactly what the box ran
// for it, in the same order, and gives back what the box reads of it; the box puts the parts' answers together in its own
// order, so its text is word for word what it was. A part that doesn't finish fails the box.
import type { Accel } from "./qemu-run.ts";

/** At most this many parts of one box at once: two, as opt-a box 12 (four loaded a gate past a QEMU limit in T1). */
export const PARTS_AT_ONCE = 2;

type Part = (arg: never) => Promise<unknown>;

export const PARTS: Record<string, Part> = {
  /** native-f box 9's fuzz with one bug put into the runtime: how many failures it had. */
  strmapFuzz: async (a: {
    from: number;
    seeds: number;
    accel: Accel;
    jobs: number;
    budgets: number[];
    rcExtra: Record<string, unknown>;
  }): Promise<{ failures: number; answers: number }> => {
    const { strmapFuzz } = await import("./strmap-fuzz.ts");
    const { wrongAnswers } = await import("./corpus.ts");
    const r = await strmapFuzz(a.from, a.seeds, a.accel, a.jobs, a.budgets, a.rcExtra);
    // R12: and of them the wrong answers, which don't depend on the load (corpus.ts faultCount)
    return { failures: r.failures.length, answers: wrongAnswers(r.failures) };
  },
  /** One of pipe-d box 13's printer bugs through the dual route: how many failures, in how many programs. */
  dualRouteFault: async (a: {
    modes: ("strict" | "leak" | "manual" | "rc")[];
    levels: (0 | 2)[];
    accels: Accel[];
    jobs: number;
    classes: boolean;
    generated: boolean;
    dirs: string[];
    fault: string;
  }): Promise<{ failures: number; answers: number; programs: number }> => {
    const P = await import("./pipe-tests.ts");
    const { ranOutOfTime } = await import("./corpus.ts");
    const r = await P.dualRoute(a);
    // What the box reads of them: how many, and in how many programs (a child's output is bounded, the list isn't); and
    // (R12) of them the wrong answers, in how many programs, which don't depend on the load as the rest can.
    const wrong = r.failures.filter((x) => !ranOutOfTime(x));
    return {
      failures: r.failures.length,
      answers: wrong.length,
      programs: new Set((wrong.length > 0 ? wrong : r.failures).map((x) => x.split(" ")[0])).size,
    };
  },
};

/** Runs each part's call in a process of its own, PARTS_AT_ONCE at a time, and gives their answers in the calls' order. */
export async function inParts<A, R>(
  name: string,
  label: (a: A) => string,
  calls: A[],
): Promise<R[]> {
  const { guardedRun, pool } = await import("./guarded-run.ts");
  const { buildPath } = await import("./build-dir.ts");
  const script = new URL("./part.ts", import.meta.url).pathname;
  return pool(calls, PARTS_AT_ONCE, async (a) => {
    const what = label(a);
    // A build directory of its own, as every job has (opt-tests.ts faultsInParts); the gate reaps its QEMUs (reapJobDir).
    const dir = buildPath("parts", `${name}-${what}`.replace(/[^\w.-]+/g, "_"));
    const r = await guardedRun(
      process.execPath,
      ["--no-warnings", script, name, JSON.stringify(a)],
      {
        timeoutMs: 3_600_000,
        label: `${name} part ${what}`,
        env: { ...process.env, TMK_BUILD_DIR: dir },
      },
    );
    const line = r.stdout.split("\n").find((l) => l.startsWith("TMK-PART "));
    if (!r.ok || line === undefined)
      throw new Error(`the part ${name} ${what} didn't finish: ${r.why} ${r.stderr.slice(0, 600)}`);
    return JSON.parse(line.slice("TMK-PART ".length)) as R;
  });
}
