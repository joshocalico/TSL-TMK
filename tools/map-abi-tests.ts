// A native caller reading a `Map` and a `Set` through the accessors alone (SPEC 4.5, D36, D47): `size`, `has`, and a cursor
// with `iter`, `step`, `key` and `val`, named in DownMeta's `map`, and nothing of the layout. The guest walks what an export
// returned, mid-move included, and prints it; V8 runs the same source, and the two have to say the same, in the same order.
import { join } from "node:path";
import { buildImage } from "../compiler/backend-aarch64/image.ts";
import { FuncBuilder } from "../compiler/tir/build.ts";
import type { Module, TirType } from "../compiler/tir/ir.ts";
import { ROOT } from "./corpus.ts";
import { lowerFile } from "./lowering.ts";
import { Driver } from "./native-driver.ts";
import { qemuRun, type Accel } from "./qemu-run.ts";

const FILE = join(ROOT, "corpus/lower/maps/move_ops.ts");

/** Exports that return a map, the arguments to give them, and keys to ask `has` about. */
const CASES: { fn: string; args: number[]; probes: number[] }[] = [
  { fn: "leftMoving", args: [4, 1], probes: [0, 1, 2, 4, 9] },
  { fn: "leftMoving", args: [64, 1], probes: [0, 1, 63, 64, 65] },
  { fn: "leftMoving", args: [1024, 1], probes: [0, 1, 500, 1024, 1025] },
  { fn: "leftMoving", args: [1024, 100], probes: [0, 1, 1023, 1024, 1100] },
  { fn: "leftMoving", args: [16, 0], probes: [0, 1, 15, 16] },
  { fn: "leftMovingSet", args: [64, 1], probes: [] },
  { fn: "leftMovingSet", args: [1024, 3], probes: [] },
];

export interface MapAbiResult {
  cases: number;
  agreed: number;
  failures: string[];
  skipped: boolean;
  /** The accessor exports the module had, for the record. */
  surface: string[];
}

function leafText(rep: string | undefined, hex: string): string {
  const bits = BigInt(`0x${hex}`);
  if (rep === "f64") {
    const d = new DataView(new ArrayBuffer(8));
    d.setBigUint64(0, bits);
    return String(d.getFloat64(0));
  }
  if (rep === "u32") return String(Number(BigInt.asUintN(32, bits)));
  return String(Number(BigInt.asIntN(32, bits)));
}

export async function mapAbiTest(accel: Accel): Promise<MapAbiResult> {
  const out: MapAbiResult = { cases: 0, agreed: 0, failures: [], skipped: false, surface: [] };
  const lo = lowerFile(FILE, { memory: "rc" });
  if (lo.tir === null || lo.meta === null || lo.fallbackDiags.length > 0) {
    out.failures.push(`didn't lower: ${JSON.stringify(lo.fallbackDiags).slice(0, 300)}`);
    return out;
  }
  const m = lo.tir as Module;
  const meta = lo.meta as unknown as {
    exports: Record<string, { ret: { k: string; id?: number } }>;
    heap: Record<
      string,
      {
        fields?: unknown[];
        internal?: unknown[];
        map?: Record<string, string> & {
          kind: string;
          keyDesc: { k: string; rep?: string };
          valDesc: { k: string; rep?: string };
        };
      }
    >;
    strings: Record<string, number>;
  };
  const drv = new Driver(m);
  const main = new FuncBuilder("__tmk_main", [], []);
  drv.pageRange();
  drv.arenaUse();
  const base = main.load("ptr", main.global("__mem_base"));
  const limit = main.load("ptr", main.global("__mem_limit"));
  const mid = main.at0(base, 32 * 1024 * 1024);
  main.call("__arena_use", [base, mid]);
  drv.usePageRange(main, mid, limit);
  main.call("__init", []);
  let sizeTy: TirType = "i32";
  const plans: {
    name: string;
    isSet: boolean;
    rep: string | undefined;
    valRep: string | undefined;
  }[] = [];
  for (const [i, c] of CASES.entries()) {
    const d = meta.exports[c.fn]!.ret;
    const h = meta.heap[String(d.id)]!;
    const mp = h.map;
    if (mp === undefined) {
      out.failures.push(`${c.fn}: its result has no map surface in DownMeta`);
      continue;
    }
    // The layout is the runtime's own: a caller sees no fields.
    if ((h.fields ?? []).length > 0)
      out.failures.push(`${c.fn}: DownMeta shows the map's fields to a caller`);
    for (const k of ["size", "has", "iter", "step", "key", ...(mp.kind === "map" ? ["val"] : [])])
      if (mp[k] === "" || mp[k] === undefined) out.failures.push(`${c.fn}: no ${k} accessor`);
    out.surface = [
      ...new Set([...out.surface, mp.size!, mp.iter!, mp.step!, mp.key!, mp.val ?? ""]),
    ];
    const isSet = mp.kind === "set";
    plans.push({ name: c.fn, isSet, rep: mp.keyDesc.rep, valRep: mp.valDesc.rep });
    const sig = drv.sigOf(c.fn);
    const r = main.call(
      c.fn,
      c.args.map((a, k) => drv.leafConst(main, sig.params[k]!, a)),
      sig.rets,
    )[0]!;
    drv.puts(main, `TMK:A ${i} size `);
    const ss = drv.sigOf(mp.size!);
    sizeTy = ss.rets[0]!;
    drv.printLeaf(main, sizeTy, main.call(mp.size!, [r], ss.rets)[0]!);
    main.call("__rt_nl", []);
    for (const p of c.probes) {
      const hs = drv.sigOf(mp.has!);
      const yes = main.call(mp.has!, [r, drv.leafConst(main, hs.params[1]!, p)], hs.rets)[0]!;
      drv.puts(main, `TMK:A ${i} has ${p} `);
      main.call("__rt_hex64", [main.op("zext.i64", [yes], "i64")]);
      main.call("__rt_nl", []);
    }
    const cur = main.call(mp.iter!, [r], ["ptr"])[0]!;
    const head = main.block();
    const body = main.block();
    const done = main.block();
    main.br(head);
    main.at(head);
    const more = main.call(mp.step!, [r, cur], ["i32"])[0]!;
    main.brif(more, body, done);
    main.at(body);
    drv.puts(main, `TMK:A ${i} entry `);
    const ks = drv.sigOf(mp.key!);
    const k = main.call(mp.key!, [r, cur], ks.rets)[0]!;
    if (isSet) drv.putString(main, k);
    else drv.printLeaf(main, ks.rets[0]!, k);
    if (isSet) main.call("__rc_release", [k]);
    if (!isSet) {
      const vs = drv.sigOf(mp.val!);
      main.call("__rt_sp", []);
      drv.printLeaf(main, vs.rets[0]!, main.call(mp.val!, [r, cur], vs.rets)[0]!);
    }
    main.call("__rt_nl", []);
    main.br(head);
    main.at(done);
    // The caller's counts: the cursor and the map are its own, and it lets go of both (SPEC 4.5, D39).
    main.call("__rc_release", [cur]);
    main.call("__rc_release", [r]);
  }
  drv.puts(main, "TMK:A end\n");
  main.ret();
  drv.funcs.push(main.finish());
  drv.trapMessages(meta.strings);
  const image = buildImage({
    module: m,
    driverFuncs: drv.funcs,
    driverGlobals: drv.globals,
    ramBytes: 256 * 1024 * 1024,
  });
  const run = await qemuRun({ name: "map-abi", image: image.bytes, accel, timeoutMs: 120_000 });
  if (run.skipped) {
    out.skipped = true;
    return out;
  }
  if (!run.ok) {
    out.failures.push(`the guest: ${run.status} ${run.why.slice(0, 300)}`);
    return out;
  }
  const mod = (await import(FILE)) as Record<
    string,
    (...a: number[]) => Map<unknown, unknown> | Set<unknown>
  >;
  for (const [i, c] of CASES.entries()) {
    const plan = plans[i];
    if (plan === undefined) continue;
    out.cases++;
    const want: string[] = [];
    const v8 = mod[c.fn]!(...c.args);
    want.push(`size ${v8.size}`);
    for (const p of c.probes) want.push(`has ${p} ${(v8 as Map<unknown, unknown>).has(p) ? 1 : 0}`);
    if (v8 instanceof Map) for (const [k, v] of v8) want.push(`entry ${String(k)} ${String(v)}`);
    else for (const k of v8) want.push(`entry ${String(k)}`);
    const got = run.lines
      .filter((l) => l.startsWith(`TMK:A ${i} `))
      .map((l) => l.slice(`TMK:A ${i} `.length).trim())
      .map((l) => {
        const parts = l.split(" ");
        if (parts[0] === "size")
          return `size ${leafText(sizeTy === "f64" ? "f64" : "i32", parts[1]!)}`;
        if (parts[0] === "has") return `has ${parts[1]} ${Number(BigInt(`0x${parts[2]}`))}`;
        if (plan.isSet) return l;
        return `entry ${leafText(plan.rep, parts[1]!)} ${leafText(plan.valRep, parts[2]!)}`;
      });
    if (JSON.stringify(got) === JSON.stringify(want)) out.agreed++;
    else {
      const at = got.findIndex((g, j) => g !== want[j]);
      out.failures.push(
        `${c.fn}(${c.args.join(", ")}): ${got.length} lines, V8 ${want.length}; first difference at ${at}: "${got[at] ?? ""}" against "${want[at] ?? ""}"`,
      );
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await mapAbiTest((process.argv[2] ?? "hvf") as Accel);
  console.log(JSON.stringify(r, null, 1).slice(0, 3000));
}
