// The gate's CPU budget (R12): one token a core, shared by every process of a run, so gate lanes × compile workers × parts
// × QEMUs can't put more busy threads on the host than it has cores. T2 left the gate oversubscribed (load 80 to 150 on 10
// cores, 89 processes), and a job that relies on a single child got slower: each lane's job had its own four compile
// workers, its parts two processes each with four more, and its QEMUs and reference engines besides.
//
// The pool (`runPool`, tools/gate.ts) serves tokens on a Unix socket named by TMK_CPU_SOCK, which every job, part and
// worker inherits. A token is one connection: granted when the server writes a byte, given back when the connection
// closes, so a process that dies gives its tokens back with it. Only leaves take one, the units of work that run on one
// core and start nothing that takes another: a compile on a worker, a QEMU run, a reference engine's run. Nothing that
// holds a token waits for another, so the budget can't deadlock. Waiting for a token happens before a leaf's own time
// limit starts, so a full budget delays a run and never times one out. With no TMK_CPU_SOCK (a job run alone, `tmk job`),
// nothing is limited past what each process already limits.
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

/** Tokens in a run's budget: one a core, unless TMK_CPU_TOKENS says otherwise (a measurement). */
export function budgetSize(): number {
  const v = Number(process.env.TMK_CPU_TOKENS);
  return Number.isInteger(v) && v > 0 ? v : availableParallelism();
}

export interface CpuServer {
  path: string;
  size: number;
  /** Tokens held now, and the most held at once (every leaf counted while it runs). */
  held: () => number;
  peak: () => number;
  close: () => Promise<void>;
}

/** Serves `size` tokens on a socket of its own, first come first served. */
export async function serveBudget(size = budgetSize()): Promise<CpuServer> {
  // Short, in the system's temporary directory: a Unix socket's path is limited to about a hundred bytes.
  const path = join(tmpdir(), `tmk-cpu-${process.pid}-${Date.now() % 1e6}.sock`);
  rmSync(path, { force: true });
  let held = 0;
  let peak = 0;
  const granted = new Set<Socket>();
  const waiting: Socket[] = [];
  const prio = new Map<Socket, number>();
  const grant = (): void => {
    while (held < size && waiting.length > 0) {
      // The waiter of the longest job first (TMK_CPU_PRIO, the gate's estimate of its seconds), and among equals the first
      // to ask: the jobs that set the gate's floor aren't held back behind short ones.
      let at = 0;
      for (let i = 1; i < waiting.length; i++)
        if ((prio.get(waiting[i]!) ?? 0) > (prio.get(waiting[at]!) ?? 0)) at = i;
      const s = waiting.splice(at, 1)[0]!;
      if (s.destroyed) continue;
      granted.add(s);
      held++;
      if (held > peak) peak = held;
      s.write("1");
    }
  };
  const server: Server = createServer((s) => {
    s.on("error", () => {});
    s.once("close", () => {
      prio.delete(s);
      if (granted.delete(s)) held--;
      else {
        const i = waiting.indexOf(s);
        if (i >= 0) waiting.splice(i, 1);
      }
      grant();
    });
    // What a client sends is a request for its one token, and its priority (TMK_CPU_PRIO; none is 0).
    s.once("data", (d) => {
      const n = Number(String(d).trim());
      prio.set(s, Number.isFinite(n) ? n : 0);
      waiting.push(s);
      grant();
    });
  });
  server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  return {
    path,
    size,
    held: () => held,
    peak: () => peak,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of [...granted, ...waiting]) s.destroy();
        server.close(() => {
          rmSync(path, { force: true });
          resolve();
        });
      }),
  };
}

let warned = false;

/**
 * Takes one of the run's tokens, waiting for it, and gives a function that gives it back (once; more calls do nothing).
 * With no budget in this run, or its server gone, it gives one at once: the budget orders work, it never stops it.
 */
export function takeCpu(): Promise<() => void> {
  const path = process.env.TMK_CPU_SOCK;
  if (path === undefined || path === "") return Promise.resolve(() => {});
  return new Promise((resolve) => {
    let done = false;
    const prio = String(Number(process.env.TMK_CPU_PRIO) || 0);
    const s = createConnection(path);
    const give = (): void => {
      s.destroy();
    };
    const fallBack = (why: string): void => {
      if (done) return;
      done = true;
      if (!warned) {
        warned = true;
        process.stderr.write(`cpu budget: ${why}; running without it\n`);
      }
      s.destroy();
      resolve(() => {});
    };
    s.on("error", (e) => fallBack(e.message));
    s.once("close", () => fallBack("its server closed"));
    s.once("connect", () => s.write(prio));
    s.once("data", () => {
      if (done) return;
      done = true;
      // A held token mustn't keep a process alive that has nothing else to do.
      s.unref();
      resolve(give);
    });
  });
}

/** Runs `f` holding one token. */
export async function withCpu<T>(f: () => Promise<T>): Promise<T> {
  const give = await takeCpu();
  try {
    return await f();
  } finally {
    give();
  }
}
