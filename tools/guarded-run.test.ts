// The guards themselves: a runaway loop and a memory hog must both be killed and reported.
import assert from "node:assert/strict";
import { test } from "node:test";
import { guardedRun, pool } from "./guarded-run.ts";

test("a child over the wall-clock limit is killed", async () => {
  const r = await guardedRun(process.execPath, ["-e", "for (;;);"], {
    timeoutMs: 300,
    label: "spin",
  });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.match(r.why, /wall-clock/);
});

test("a child over the RSS limit is killed", async () => {
  const hog = "const k = []; for (;;) { k.push(Buffer.alloc(1 << 24, 1)); }";
  const r = await guardedRun(process.execPath, ["-e", hog], {
    timeoutMs: 30_000,
    rssLimitBytes: 256 * 1024 ** 2,
    label: "hog",
  });
  assert.equal(r.ok, false);
  assert.equal(r.oom, true);
  assert.match(r.why, /RSS/);
});

test("a descendant dies with its parent's group", async () => {
  const parent = `
    const { spawn } = require("node:child_process");
    const c = spawn(process.execPath, ["-e", "for (;;);"], { stdio: "ignore" });
    console.log(c.pid);
    for (;;);`;
  const r = await guardedRun(process.execPath, ["-e", parent], { timeoutMs: 800, label: "tree" });
  assert.equal(r.timedOut, true);
  const pid = Number(r.stdout.trim());
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0));
});

test("a clean child reports ok, and the pool keeps order with bounded concurrency", async () => {
  let running = 0;
  let peak = 0;
  const out = await pool([1, 2, 3, 4, 5, 6], 2, async (n) => {
    running++;
    peak = Math.max(peak, running);
    const r = await guardedRun(process.execPath, ["-e", `console.log(${n})`], {
      timeoutMs: 20_000,
      label: "echo",
    });
    running--;
    return Number(r.stdout);
  });
  assert.deepEqual(out, [1, 2, 3, 4, 5, 6]);
  assert.ok(peak <= 2);
});

test("a run asked to stop before it starts starts nothing", async () => {
  const ac = new AbortController();
  ac.abort();
  const r = await guardedRun(
    process.execPath,
    ["-e", "require('node:fs').writeFileSync('/dev/null', 'x')"],
    {
      timeoutMs: 5_000,
      label: "never",
      signal: ac.signal,
    },
  );
  assert.equal(r.ok, false);
  assert.match(r.why, /before it started/);
  assert.equal(r.ms, 0);
});

test("a runner stopped by a signal it handles leaves none of the groups it started running", async () => {
  // As the gate does: a SIGTERM handler that exits, with a long job in a group of its own. The job has to go with it.
  const here = new URL("./guarded-run.ts", import.meta.url).pathname;
  const runner = `
    import { guardedRun } from ${JSON.stringify(here)};
    process.once("SIGTERM", () => process.exit(143));
    void guardedRun(process.execPath, ["-e", "console.log(process.pid); setInterval(() => {}, 1000)"], {
      timeoutMs: 60_000,
      label: "long",
    });
    setInterval(() => {}, 1000);
  `;
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", runner], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((r) => setTimeout(r, 1500));
  const ps = (await import("node:child_process")).spawnSync(
    "/bin/ps",
    ["-axo", "pid,ppid,command"],
    {
      encoding: "utf8",
    },
  );
  const job = ps.stdout
    .split("\n")
    .find(
      (l) =>
        l.includes("setInterval(() => {}, 1000)") && l.trim().split(/\s+/)[1] === String(child.pid),
    );
  assert.ok(job !== undefined, "the long job started");
  const jobPid = Number(job.trim().split(/\s+/)[0]);
  child.kill("SIGTERM");
  await new Promise((r) => child.on("close", r));
  await new Promise((r) => setTimeout(r, 300));
  let alive = true;
  try {
    process.kill(jobPid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "the job outlived the runner");
});
