// The gate's CPU budget (R12, tools/cpu-budget.ts): never more tokens held than it has, first come first served, a token
// given back when its holder closes or dies, and no budget meaning no waiting.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { serveBudget, takeCpu, withCpu } from "./cpu-budget.ts";

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("no budget in the run: a token at once", async () => {
  const was = process.env.TMK_CPU_SOCK;
  delete process.env.TMK_CPU_SOCK;
  try {
    const give = await takeCpu();
    give();
    assert.equal(await withCpu(async () => 7), 7);
  } finally {
    if (was !== undefined) process.env.TMK_CPU_SOCK = was;
  }
});

test("never more held than the budget, and every waiter served in turn", async () => {
  const b = await serveBudget(3);
  const was = process.env.TMK_CPU_SOCK;
  process.env.TMK_CPU_SOCK = b.path;
  try {
    let now = 0;
    let most = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        withCpu(async () => {
          now++;
          most = Math.max(most, now);
          order.push(i);
          await tick(15);
          now--;
        }),
      ),
    );
    assert.equal(most, 3);
    assert.equal(b.peak(), 3);
    assert.equal(order.length, 12);
    await tick(20);
    assert.equal(b.held(), 0);
  } finally {
    if (was === undefined) delete process.env.TMK_CPU_SOCK;
    else process.env.TMK_CPU_SOCK = was;
    await b.close();
  }
});

test("a holder that dies gives its token back", async () => {
  const b = await serveBudget(1);
  try {
    // A child takes the one token and is killed holding it.
    const child = spawn(
      process.execPath,
      [
        "--no-warnings",
        "-e",
        `import(${JSON.stringify(new URL("./cpu-budget.ts", import.meta.url).pathname)}).then(async (m) => { await m.takeCpu(); console.log("held"); setInterval(() => {}, 1000); })`,
      ],
      { env: { ...process.env, TMK_CPU_SOCK: b.path }, stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise<void>((r) => child.stdout.once("data", () => r()));
    assert.equal(b.held(), 1);
    const was = process.env.TMK_CPU_SOCK;
    process.env.TMK_CPU_SOCK = b.path;
    try {
      let got = false;
      const p = takeCpu().then((give) => {
        got = true;
        give();
      });
      await tick(50);
      assert.equal(got, false, "the token is still held");
      child.kill("SIGKILL");
      await p;
      assert.equal(got, true);
    } finally {
      if (was === undefined) delete process.env.TMK_CPU_SOCK;
      else process.env.TMK_CPU_SOCK = was;
    }
  } finally {
    await b.close();
  }
});

test("a budget whose server is gone doesn't stop work", async () => {
  const b = await serveBudget(1);
  const path = b.path;
  await b.close();
  const was = process.env.TMK_CPU_SOCK;
  process.env.TMK_CPU_SOCK = path;
  try {
    assert.equal(await withCpu(async () => 3), 3);
  } finally {
    if (was === undefined) delete process.env.TMK_CPU_SOCK;
    else process.env.TMK_CPU_SOCK = was;
  }
});
