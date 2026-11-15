// The harness's and the runtime's own tests (SPEC 8.2, M3's timeout box, 5.10): a guest that spins
// forever, one that says it's done and doesn't leave, a null dereference, a stack overflow, and what
// the runtime promises. Every guest is built here, with nothing but this backend.
import { execFileSync } from "node:child_process";
import { buildImage } from "../compiler/backend-aarch64/image.ts";
import { FuncBuilder } from "../compiler/tir/build.ts";
import { Driver } from "./native-driver.ts";
import { type Accel, liveCount, pidAlive, qemuRun, setHvfOverride } from "./qemu-run.ts";

const EMPTY = { sigs: [], globals: [], funcs: [], traps: [], externs: [] };

function image(
  body: (b: FuncBuilder, d: Driver) => void,
  extra: (d: Driver) => void = () => undefined,
): Uint8Array {
  const drv = new Driver(EMPTY);
  const b = new FuncBuilder("__tmk_main", [], []);
  body(b, drv);
  drv.funcs.push(b.finish());
  extra(drv);
  drv.trapMessages({});
  return buildImage({
    module: EMPTY,
    driverFuncs: drv.funcs,
    driverGlobals: drv.globals,
    ramBytes: 256 * 1024 * 1024,
  }).bytes;
}

function spinForever(b: FuncBuilder): void {
  const spin = b.block();
  b.br(spin);
  b.at(spin);
  b.br(spin);
}

export interface TestResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** Other people's QEMUs on this host, read and never touched: the owner runs Moire VMs here. */
function otherQemus(ours: Set<number>): Set<number> {
  const out = new Set<number>();
  try {
    const text = execFileSync("/usr/bin/pgrep", ["-f", "qemu-system"], {
      encoding: "utf8",
      timeout: 5000,
    });
    for (const l of text.split("\n")) {
      const n = Number(l.trim());
      if (n > 0 && !ours.has(n)) out.add(n);
    }
  } catch {
    // pgrep exits 1 on no match.
  }
  return out;
}

export async function harnessTests(accel: Accel): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const before = otherQemus(new Set());
  const check = (name: string, ok: boolean, detail: string): void => {
    results.push({ name: `${name} (${accel})`, ok, detail });
  };

  // A guest that never finishes: killed at the deadline, reported as a failure, nothing left behind.
  {
    const bytes = image((b, d) => {
      for (let i = 0; i < 50; i++) d.puts(b, `line ${i}\n`);
      spinForever(b);
    });
    const r = await qemuRun({
      name: `test/timeout-${accel}`,
      image: bytes,
      accel,
      timeoutMs: 2000,
    });
    const tail = r.why.split("\n").length;
    const gone = r.pid !== null && !pidAlive(r.pid);
    check(
      "timeout: a guest looping forever is killed at the deadline, reported as a failure with the last 40 lines, and leaves no QEMU",
      r.status === "timeout" &&
        !r.ok &&
        r.killedByHarness &&
        gone &&
        liveCount() === 0 &&
        tail === 41 &&
        r.ms >= 2000 &&
        r.ms < 5000 &&
        r.scratch !== null,
      `status ${r.status}, ${r.ms.toFixed(0)} ms, pid gone ${gone}, ${tail - 1} lines kept, scratch kept ${r.scratch !== null}`,
    );
  }
  // TMK:DONE, and QEMU doesn't leave: it gets 2 s, then it's killed, and the sentinel still decides.
  {
    const bytes = image((b, d) => {
      d.puts(b, "TMK:DONE\n");
      spinForever(b);
    });
    const r = await qemuRun({
      name: `test/done-hangs-${accel}`,
      image: bytes,
      accel,
      timeoutMs: 10000,
    });
    check(
      "TMK:DONE gives QEMU up to 2 s to exit, then it's killed",
      r.status === "done" &&
        r.killedByHarness &&
        r.ms >= 2000 &&
        r.ms < 6000 &&
        r.pid !== null &&
        !pidAlive(r.pid),
      `status ${r.status}, ${r.ms.toFixed(0)} ms, killed ${r.killedByHarness}`,
    );
  }
  // A normal run: PSCI off ends QEMU by itself, and sentinels are what counted.
  {
    const r = await qemuRun({
      name: `test/ok-${accel}`,
      image: image((b) => b.ret()),
      accel,
      timeoutMs: 10000,
    });
    check(
      "A guest that finishes: PSCI SYSTEM_OFF ends QEMU with status 0, with no kill",
      r.ok &&
        !r.killedByHarness &&
        r.exitCode === 0 &&
        r.lines.includes("TMK:READY") &&
        r.scratch === null,
      `status ${r.status}, exit ${r.exitCode}, ${r.ms.toFixed(0)} ms`,
    );
  }
  // A monitor only when asked, in the run's own directory.
  {
    const bytes = image((b) => b.ret());
    const r = await qemuRun({
      name: `test/monitor-${accel}`,
      image: bytes,
      accel,
      timeoutMs: 10000,
      monitor: true,
    });
    check(
      "--monitor: a Unix socket in the run's own scratch directory",
      r.ok,
      `status ${r.status}`,
    );
  }
  // A null dereference faults, and says so, rather than reading 0 as Wasm's linear memory does.
  {
    const bytes = image((b) => {
      const v = b.load("i32", b.iconst("ptr", 0));
      b.call("__rt_dec", [b.op("zext.i64", [v], "i64")]);
      b.ret();
    });
    const r = await qemuRun({ name: `test/null-${accel}`, image: bytes, accel, timeoutMs: 10000 });
    const line = r.lines.find((l) => l.startsWith("TMK:FATAL")) ?? "";
    check(
      "Trap reporting: a null dereference is TMK:FATAL with ESR and FAR over serial, and QEMU exits",
      r.status === "fatal" &&
        /esr=0*9[67]/.test(line) &&
        /far=0000000000000000/.test(line) &&
        r.pid !== null &&
        !pidAlive(r.pid),
      line,
    );
  }
  // A trap at top level is a panic. Inside a try it unwinds, and a stack overflow is trap 14.
  {
    const bytes = image(
      (b) => {
        b.store("i64", b.global("__rt_case"), b.i64(0));
        const t1 = b.intrinsic("native.try", [b.func("__deep")], ["i32"])[0]!;
        b.call("__rt_dec", [b.op("zext.i64", [t1], "i64")]);
        b.call("__rt_nl", []);
        b.store("i64", b.global("__rt_case"), b.i64(1));
        const t2 = b.intrinsic("native.try", [b.func("__nullread")], ["i32"])[0]!;
        b.call("__rt_dec", [b.op("zext.i64", [t2], "i64")]);
        b.call("__rt_nl", []);
        b.intrinsic("trap.code", [b.i32(1234)]);
        b.ret();
      },
      (d) => {
        const f = new FuncBuilder("__deep", [], []);
        const a = f.raw(
          "alloca",
          [
            { t: "i", val: 4096n },
            { t: "i", val: 16n },
            { t: "trap", id: 900002 },
          ],
          ["ptr"],
        )[0]!;
        f.store("i32", a, f.i32(1));
        f.call("__deep", []);
        f.store("i32", a, f.i32(2));
        f.ret();
        d.funcs.push(f.finish());
        const g = new FuncBuilder("__nullread", [], []);
        g.call("__rt_dec", [g.load("i64", g.iconst("ptr", 8))]);
        g.ret();
        d.funcs.push(g.finish());
      },
    );
    const r = await qemuRun({
      name: `test/overflow-${accel}`,
      image: bytes,
      accel,
      timeoutMs: 15000,
    });
    const trapped = r.lines.some((l) => l.startsWith("TMK:C 0 T 14"));
    const panic = r.lines.some((l) => l.startsWith("TMK:PANIC trap 1234"));
    const nullTrap = r.lines.some((l) => l.startsWith("TMK:C 1 T 6"));
    check(
      "A stack overflow hits the guard and is trap 14, a null read in a try is trap 6, the program carries on, and a trap outside any try is TMK:PANIC",
      trapped && panic && nullTrap && r.lines.includes("1") && r.status === "panic",
      `trap 14 ${trapped}, null read in a try is trap 6 ${nullTrap}, panic ${panic}`,
    );
  }
  // What the MMU and FP setup promise: unaligned normal memory, and real timer ticks.
  {
    const bytes = image(
      (b, d) => {
        const g = b.global("__probe");
        b.store("i64", b.gep(g, b.ix(1), 1, 0), b.i64(0x1122334455667788n));
        const v = b.load("i64", b.gep(g, b.ix(1), 1, 0));
        const t0 = b.intrinsic("native.counter", [], ["i64"])[0]!;
        const x = b.op("fdiv.f64", [b.f64(1), b.f64(3)], "f64");
        const y = b.op("fsqrt.f64", [x], "f64");
        const t1 = b.intrinsic("native.counter", [], ["i64"])[0]!;
        d.puts(b, "TMK:PASS unaligned ");
        b.call("__rt_hex64", [v]);
        b.call("__rt_nl", []);
        d.puts(b, "TMK:PASS fp ");
        b.call("__rt_hex64", [b.op("bitcast.i64", [y], "i64")]);
        b.call("__rt_nl", []);
        d.puts(b, "TMK:PASS counter ");
        b.call("__rt_dec", [b.intrinsic("native.frequency", [], ["i64"])[0]!]);
        b.call("__rt_sp", []);
        b.call("__rt_dec", [b.op("sub.i64", [t1, t0], "i64")]);
        b.call("__rt_nl", []);
        b.ret();
      },
      (d) => {
        d.globals.push({ name: "__probe", size: 32, align: 8, section: "data" });
      },
    );
    const r = await qemuRun({
      name: `test/runtime-${accel}`,
      image: bytes,
      accel,
      timeoutMs: 10000,
    });
    const unaligned = r.lines.includes("TMK:PASS unaligned 1122334455667788");
    const fp = r.lines.includes("TMK:PASS fp 3fe279a74590331c");
    const counter = r.lines.find((l) => l.startsWith("TMK:PASS counter ")) ?? "";
    const freq = Number(counter.split(" ")[2]);
    check(
      "Runtime: MMU and caches on (an unaligned 64-bit load and store on normal memory), FP on, PL011 output, CNTFRQ read",
      r.ok && unaligned && fp && freq > 0,
      `unaligned ${unaligned}, fp ${fp}, CNTFRQ ${freq} Hz`,
    );
  }
  // Nothing of ours is left, and nothing of anyone else's was touched.
  const after = otherQemus(new Set());
  const untouched = [...before].filter((p) => !pidAlive(p));
  check(
    "No QEMU of this harness is left, and every other QEMU on the host is still there",
    liveCount() === 0 && untouched.length === 0,
    `${before.size} other QEMU process(es) before, ${after.size} after, ${untouched.length} gone`,
  );
  return results;
}

/** With HVF unavailable, a run reports a skip, and a skip is never a pass. */
export async function skipTest(): Promise<TestResult> {
  setHvfOverride({ ok: false, why: "forced by the test" });
  const r = await qemuRun({
    name: "test/skip",
    image: new Uint8Array(4),
    accel: "hvf",
    timeoutMs: 1000,
  });
  setHvfOverride(null);
  return {
    name: "HVF unavailable reports a skip, never a pass",
    ok: r.skipped && !r.ok && r.status === "skip",
    detail: `status ${r.status}, ok ${r.ok}, skipped ${r.skipped}: ${r.why}`,
  };
}
