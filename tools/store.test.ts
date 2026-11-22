// The build store (tools/store.ts, D76): what's made is reused within a run, a reuse made again differs only if what's made
// does, and nothing is used from outside a run's store.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serialize, deserialize } from "node:v8";
import {
  childKey,
  removeStoreDir,
  storeKey,
  stored,
  storeStats,
  StoreMismatch,
  valueHash,
} from "./store.ts";

function withStore<T>(verify: string, f: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "tmk-store-test-"));
  const was = { s: process.env.TMK_STORE, v: process.env.TMK_STORE_VERIFY };
  process.env.TMK_STORE = dir;
  process.env.TMK_STORE_VERIFY = verify;
  try {
    return f(dir);
  } finally {
    if (was.s === undefined) delete process.env.TMK_STORE;
    else process.env.TMK_STORE = was.s;
    if (was.v === undefined) delete process.env.TMK_STORE_VERIFY;
    else process.env.TMK_STORE_VERIFY = was.v;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a value is made once in a run, and reused by value", () => {
  withStore("off", (dir) => {
    let made = 0;
    const make = (): { a: Map<string, number[]>; b: Uint8Array } => {
      made++;
      return { a: new Map([["x", [1, 2]]]), b: new Uint8Array([3, 4]) };
    };
    const k = storeKey("t", ["one"]);
    const first = stored("t", k, make);
    const again = stored("t", k, make);
    assert.equal(made, 1);
    assert.equal(valueHash(again), valueHash(first));
    const s = storeStats(dir).byKind.t!;
    assert.equal(s.miss, 1);
    assert.equal(s.hit, 1);
  });
});

test("a reuse made again that differs is a mismatch, and fails", () => {
  withStore("all", (dir) => {
    let n = 0;
    const k = storeKey("t", ["drifts"]);
    stored("t", k, () => ({ v: n++ }));
    assert.throws(() => stored("t", k, () => ({ v: n++ })), StoreMismatch);
    assert.equal(storeStats(dir).mismatches.length, 1);
  });
});

test("how long making it took isn't what was made", () => {
  withStore("all", (dir) => {
    const k = storeKey("t", ["timed"]);
    stored("t", k, () => ({ tir: [1, 2, 3], opt: { ms: 1 } }), { timings: new Set(["ms"]) });
    stored("t", k, () => ({ tir: [1, 2, 3], opt: { ms: 2 } }), { timings: new Set(["ms"]) });
    assert.equal(storeStats(dir).byKind.t!.verified, 1);
    assert.equal(storeStats(dir).mismatches.length, 0);
  });
});

test("a value's hash is by what it is, not how V8 serializes it after a round trip", () => {
  const v = {
    s: "ab".repeat(1000),
    m: new Map([[1, { t: "é" }]]),
    set: new Set(["q"]),
    u: undefined,
  };
  assert.equal(valueHash(deserialize(serialize(v))), valueHash(v));
  assert.notEqual(valueHash({ a: 1, b: 2 }), valueHash({ b: 2, a: 1 })); // keys' order is iteration order
  const shared = { x: 1 };
  assert.notEqual(valueHash([shared, shared]), valueHash([{ x: 1 }, { x: 1 }]));
});

test("a making that took the level from the environment notes it again when reused", () => {
  withStore("off", () => {
    let reads = 0;
    let noted = 0;
    const k = storeKey("t", ["level"]);
    const hooks = { envLevel: () => reads, onEnvLevel: () => void noted++ };
    stored("t", k, () => (reads++, { v: 1 }), hooks);
    stored("t", k, () => ({ v: 1 }), hooks);
    assert.equal(noted, 1);
  });
});

test("a pure child's key takes a file outside the tree by its bytes, and anything else isn't reused", () => {
  withStore("off", () => {
    const d = mkdtempSync(join(tmpdir(), "tmk-store-meta-"));
    try {
      const script = join(import.meta.dirname, "printed-exec.ts");
      const job = (m: string): string =>
        JSON.stringify({
          program: join(import.meta.dirname, "../corpus/pos/x.ts"),
          cases: "c",
          meta: m,
        });
      const a = join(d, "a.json");
      const b = join(d, "b.json");
      writeFileSync(a, "{}");
      writeFileSync(b, "{}");
      const ka = childKey("node", [script, job(a)], {});
      assert.ok(ka !== null);
      // The same bytes at another path (another job's directory) are the same input.
      assert.equal(childKey("node", [script, job(b)], {}), ka);
      writeFileSync(b, '{"changed":1}');
      assert.notEqual(childKey("node", [script, job(b)], {}), ka);
      // The engine and the keyed environment are part of it; a job's own paths aren't.
      assert.notEqual(childKey("bun", [script, job(a)], {}), ka);
      assert.notEqual(childKey("node", [script, job(a)], { TMK_OPT: "2" }), ka);
      assert.equal(childKey("node", [script, job(a)], { TMK_BUILD_DIR: "/elsewhere" }), ka);
      // Not one of the pure scripts, or not this tree's: never reused.
      assert.equal(childKey("node", [join(import.meta.dirname, "run.ts")], {}), null);
      assert.equal(childKey("node", ["/elsewhere/tools/printed-exec.ts", job(a)], {}), null);
      // A source run is pure; a wasm run (its glue in a job's directory) isn't taken.
      const lx = join(import.meta.dirname, "lower-exec.ts");
      assert.ok(
        childKey("node", [lx, JSON.stringify({ mode: "source", program: "p", cases: "c" })], {}) !==
          null,
      );
      assert.equal(
        childKey("node", [lx, JSON.stringify({ mode: "wasm", program: "p", cases: "c" })], {}),
        null,
      );
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// R36's first gate: after a fail-fast stop, `runGate`'s removal of its store threw ENOTEMPTY (tools/gate.ts) while a stopped
// job's children were still writing into it. A directory refilled or busy is tried again; anything else, or still failing at
// the deadline, is given back as a failure with why, never hidden.
test("a run's store is removed though writers are still finishing, and a removal that can't succeed says so", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tmk-store-rm-"));
  mkdirSync(join(dir, "child", "ab"), { recursive: true });
  writeFileSync(join(dir, "child", "ab", "x"), "1");
  const busy = (code: string): Error =>
    Object.assign(new Error(`${code}: directory not empty`), { code });
  // refilled twice under the removal, then gone
  let calls = 0;
  const flaky = (d: string): void => {
    calls++;
    if (calls <= 2) throw busy(calls === 1 ? "ENOTEMPTY" : "EBUSY");
    rmSync(d, { recursive: true, force: true });
  };
  const ok = await removeStoreDir(dir, { rm: flaky, delayMs: 5, deadlineMs: 5_000 });
  assert.deepEqual(ok, { ok: true, tries: 3, why: "" });
  assert.ok(!existsSync(dir));
  // a writer that never stops: a failure at the deadline, with the error
  const never = await removeStoreDir(dir, {
    rm: () => {
      throw busy("ENOTEMPTY");
    },
    delayMs: 5,
    deadlineMs: 40,
  });
  assert.equal(never.ok, false);
  assert.ok(never.tries > 1);
  assert.match(never.why, /couldn't be removed .*ENOTEMPTY/);
  // an error that waiting can't cure isn't tried again
  const denied = await removeStoreDir(dir, {
    rm: () => {
      throw busy("EACCES");
    },
    delayMs: 5,
    deadlineMs: 5_000,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.tries, 1);
  // and with nothing in the way, the real removal, once
  const real = mkdtempSync(join(tmpdir(), "tmk-store-rm-"));
  writeFileSync(join(real, "f"), "1");
  assert.deepEqual(await removeStoreDir(real), { ok: true, tries: 1, why: "" });
  assert.ok(!existsSync(real));
});
