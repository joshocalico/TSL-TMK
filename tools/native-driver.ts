// Builds a test image's driver in TIR: code that places each case's arguments, calls the export, and
// reports over serial what JS glue would have copied out (SPEC 4.5, 8.1). The host then rebuilds the
// same JS values from those lines, so results go through the same canonical comparison as every other
// configuration, and no comparison logic runs in the guest.
//
// A test image can put these lines in RAM rather than through the PL011 (SPEC 8.2): they're the same text either way.
//
// Serial protocol, one line per event:
//   TMK:C <case> R <hex leaf>...      returned, one hex word per result leaf
//   TMK:C <case> T <code> <message>   trapped
//   TMK:C <case> P <n> <hex address>  where the n'th thing placed for this case ended up
//   TMK:C <case> A <arg> <hex bytes>  a TSL typed-array argument's final contents
//   TMK:M <hex address> <hex bytes>   memory after a lowered case: nonzero chunks only
//   TMK:E <case>                      this case is finished
import { assemble } from "../compiler/tir/asm.ts";
import { FuncBuilder } from "../compiler/tir/build.ts";
import type { RcStrLayout, StrLayout } from "../compiler/host/types.ts";
import type { Func, Global, Module, TirType } from "../compiler/tir/ir.ts";

export type Leaf = number | bigint;

/** R38: a timing image's global, 0 through its first pass and 1 after it: a case's dumps are that pass's alone. */
export const TIMING_QUIET = "__tp_quiet";

export class Driver {
  m: Module;
  funcs: Func[] = [];
  globals: Global[] = [];
  private strs = new Map<string, { name: string; n: number }>();
  private blobCount = 0;
  private bulk: boolean;
  // Strings are @tsl/jsrt's JsString (D67), a JsFlat or a JsView (D70), laid out as the build published (pipe-split).
  strLayout: StrLayout | null = null;
  rcStrLayout: RcStrLayout | null = null; // R10: `rc` through the TSL route, a string the program's own JsStr

  constructor(m: Module, bulk = false) {
    this.m = m;
    this.bulk = bulk;
  }

  sigOf(name: string): { params: TirType[]; rets: TirType[] } {
    const f = this.m.funcs.find((x) => x.name === name);
    if (f === undefined) throw new Error(`no function @${name}`);
    return { params: f.params.map((p) => f.types[p]!), rets: f.rets };
  }

  blob(bytes: Uint8Array): string {
    const name = `__blob_${this.blobCount++}`;
    this.globals.push({
      name,
      size: bytes.length,
      align: 16,
      section: "data",
      bytes: bytes.slice(),
    });
    return name;
  }

  /** A string literal, printed by a runtime call. */
  puts(b: FuncBuilder, s: string): void {
    if (s.length === 0) return;
    let e = this.strs.get(s);
    if (e === undefined) {
      const bytes = new TextEncoder().encode(s);
      e = { name: `__str_${this.strs.size}`, n: bytes.length };
      this.strs.set(s, e);
      this.globals.push({ name: e.name, size: bytes.length, align: 1, section: "data", bytes });
    }
    b.call("__rt_puts", [b.global(e.name), b.ix(e.n)]);
  }

  printCaseHead(b: FuncBuilder, index: number, tag: string): void {
    this.puts(b, `TMK:C ${index} ${tag} `);
  }

  leafConst(b: FuncBuilder, t: TirType, v: Leaf): number {
    if (t === "f64" || t === "f32") {
      const d = new DataView(new ArrayBuffer(8));
      if (t === "f64") {
        d.setFloat64(0, Number(v));
        return b.fbits("f64", d.getBigUint64(0));
      }
      d.setFloat32(0, Number(v));
      return b.fbits("f32", BigInt(d.getUint32(0)));
    }
    return b.iconst(t, typeof v === "bigint" ? v : BigInt(Math.trunc(Number(v))));
  }

  printLeaf(b: FuncBuilder, t: TirType, v: number): void {
    let x: number;
    if (t === "f64") x = b.op("bitcast.i64", [v], "i64");
    else if (t === "f32") x = b.op("zext.i64", [b.op("bitcast.i32", [v], "i32")], "i64");
    else if (t === "i64" || t === "ix" || t === "ptr")
      x = t === "i64" ? v : b.op("bitcast.i64", [v], "i64");
    else x = b.op("zext.i64", [v], "i64");
    b.call("__rt_hex64", [x]);
  }

  /** __tmk_main: each case under native.try, then the code that runs whether it trapped or not. */
  main(cases: { run: string; after: string }[], setup: (b: FuncBuilder) => void, passes = 0): void {
    const b = new FuncBuilder("__tmk_main", [], []);
    setup(b);
    const caseIdx = b.global("__rt_case");
    const once = (): void =>
      cases.forEach((c, i) => {
        b.store("i64", caseIdx, b.i64(i));
        const trapped = b.intrinsic("native.try", [b.func(c.run)], ["i32"])[0]!;
        void trapped;
        b.call(c.after, []);
        this.puts(b, `TMK:E ${i}\n`);
      });
    if (passes <= 0) once();
    else {
      // R14 (tools/r14-time.ts): the case list `passes` times over, each case's run (not what's printed after it) timed by
      // the counter, each pass's sum printed `TMK:TP <ticks>`, and the counter's frequency `TMK:F <hz>`. A timing image
      // only: its results are the first pass's, and a later pass runs on the module state the one before it left.
      this.globals.push({ name: "__tp_sum", size: 8, align: 8, section: "data" });
      // R38: 1 from the end of the first pass, so each case's `after` dumps memory in that pass alone (native-exec.ts)
      this.globals.push({ name: TIMING_QUIET, size: 4, align: 4, section: "data" });
      const sum = b.global("__tp_sum");
      this.puts(b, "TMK:F ");
      b.call("__rt_dec", [b.intrinsic("native.frequency", [], ["i64"])[0]!]);
      b.call("__rt_nl", []);
      for (let p = 0; p < passes; p++) {
        b.store("i64", sum, b.i64(0));
        cases.forEach((c, i) => {
          b.store("i64", caseIdx, b.i64(i));
          const t0 = b.intrinsic("native.counter", [], ["i64"])[0]!;
          b.intrinsic("native.try", [b.func(c.run)], ["i32"]);
          const t1 = b.intrinsic("native.counter", [], ["i64"])[0]!;
          b.store(
            "i64",
            sum,
            b.op("add.i64", [b.load("i64", sum), b.op("sub.i64", [t1, t0], "i64")], "i64"),
          );
          b.call(c.after, []);
          this.puts(b, `TMK:E ${i}\n`);
        });
        this.puts(b, "TMK:TP ");
        b.call("__rt_dec", [b.load("i64", sum)]);
        b.call("__rt_nl", []);
        if (p === 0) b.store("i32", b.global(TIMING_QUIET), b.i32(1));
      }
    }
    b.ret();
    this.funcs.push(b.finish());
  }

  /**
   * The native arena ABI (SPEC 4.5): `__arena_use(start, limit)` hands a down-lowered module its memory.
   * Allocation bumps from `start`, past `limit` is trap 14, and what's allocated stays there until the
   * caller calls `__arena_reset`, which rewinds to the point after `__init`.
   */
  arenaUse(): void {
    const b = new FuncBuilder("__arena_use", ["ptr", "ptr"], []);
    b.store("ptr", b.global("__mem_base"), b.params[0]!);
    b.store("ptr", b.global("__mem_limit"), b.params[1]!);
    b.call("__arena_start", []);
    b.call("__arena_commit", []);
    b.ret();
    this.funcs.push(b.finish());
  }

  /**
   * The bare-metal runtime's page source (SPEC 3.5, 4.5): zeroed runs of a range of RAM, and null past its end.
   * It's registered through the same `__page_source_use` any other environment's would be.
   */
  pageRange(): void {
    for (const name of ["__range_start", "__range_cur", "__range_end"]) {
      this.globals.push({ name, size: 8, align: 8, section: "data" });
    }
    const use = new FuncBuilder("__range_use", ["ptr", "ptr"], []);
    use.store("ptr", use.global("__range_start"), use.params[0]!);
    use.store("ptr", use.global("__range_cur"), use.params[0]!);
    use.store("ptr", use.global("__range_end"), use.params[1]!);
    use.ret();
    this.funcs.push(use.finish());
    const b = new FuncBuilder("__range_pages", ["ix"], ["ptr"]);
    const cur = b.load("ptr", b.global("__range_cur"));
    const end = b.load("ptr", b.global("__range_end"));
    const bytes = b.op("mul.ix", [b.params[0]!, b.ix(4096)], "ix");
    const next = b.raw(
      "gep",
      [
        { t: "v", id: cur },
        { t: "v", id: bytes },
        { t: "i", val: 1n },
        { t: "i", val: 0n },
      ],
      ["ptr"],
    )[0]!;
    const over = b.op("icmp.ugt.ptr", [next, end], "i32");
    const none = b.block();
    const some = b.block();
    b.brif(over, none, some);
    b.at(none);
    b.ret([b.iconst("ptr", 0)]);
    b.at(some);
    b.store("ptr", b.global("__range_cur"), next);
    b.intrinsic("mem.fill", [cur, b.i32(0), bytes]);
    b.ret([cur]);
    this.funcs.push(b.finish());
  }

  usePageRange(b: FuncBuilder, start: number, limit: number, pages?: number): void {
    let end = limit;
    if (pages !== undefined) end = b.at0(start, pages * 4096);
    b.call("__range_use", [start, end]);
    b.call("__page_source_use", [
      b.raw("funcaddr", [{ t: "sym", name: "__range_pages" }], ["ptr"])[0]!,
    ]);
  }

  /** __rt_trap_message: prints a lowered throw's message, from the trap table (SPEC 4.5). */
  /**
   * A run-time string in a thrown message (SPEC 4.5): printable ASCII as itself, anything else as {uXXXX}, which the host
   * turns back. It's called only where the module has strings, as nothing else has such a part.
   */
  putString(b: FuncBuilder, p: number): void {
    const L = this.strLayout;
    const R = this.rcStrLayout;
    let len: number;
    let units: number;
    if (R !== null) {
      // R10: the program's own JsStr in `rc`: its units its own where its buffer is null, its buffer's from its start
      len = b.op("zext.ix", [b.load("i32", b.at0(p, R.len))], "ix");
      const buf = b.load("ptr", b.at0(p, R.buf));
      const own = b.op("icmp.eq.i64", [b.op("bitcast.i64", [buf], "i64"), b.i64(0)], "i32");
      const start = b.op("zext.ix", [b.load("i32", b.at0(p, R.start))], "ix");
      const twice = b.op("shl.ix", [start, b.ix(1)], "ix");
      const inBuf = b.raw(
        "gep",
        [
          { t: "v", id: b.at0(buf, R.bufUnits) },
          { t: "v", id: twice },
          { t: "i", val: 1n },
          { t: "i", val: 0n },
        ],
        ["ptr"],
      )[0]!;
      units = b.op("select.ptr", [own, b.at0(p, R.units), inBuf], "ptr");
    } else if (L !== null) {
      // Printed as @tsl/jsrt's JsString (D67): the class id at p says which layout (pipe-split). Both of each are read and
      // one kept: the other is a load inside the heap that nothing uses.
      const flat = b.op("icmp.eq.i32", [b.load("i32", p), b.i32(L.flat.id)], "i32");
      const n = b.op(
        "select.i32",
        [flat, b.load("i32", b.at0(p, L.flat.len)), b.load("i32", b.at0(p, L.view.len))],
        "i32",
      );
      len = b.op("zext.ix", [n], "ix");
      units = b.op(
        "select.ptr",
        [flat, b.at0(p, L.flat.units), b.load("ptr", b.at0(p, L.view.addr))],
        "ptr",
      );
    } else {
      len = b.op("zext.ix", [b.load("i32", p)], "ix");
      const off = b.load("ix", b.at0(p, 8));
      units = b.raw(
        "gep",
        [
          { t: "v", id: p },
          { t: "v", id: off },
          { t: "i", val: 1n },
          { t: "i", val: 0n },
        ],
        ["ptr"],
      )[0]!;
    }
    b.call("__rt_putunits", [units, len]);
    if (!this.funcs.some((f) => f.name === "__rt_putunits")) {
      const text = `
extern @__rt_hex8(i32) -> ()
extern @__rt_out(i32) -> ()
func @__rt_putunits(%p: ptr, %n: ix) -> () {
bb_e:
  %z = iconst.ix 0
  br bb_loop(%z)
bb_loop(%i: ix):
  %more = icmp.ult.ix %i, %n
  brif %more, bb_body, bb_done
bb_body:
  %two = iconst.ix 2
  %at = mul.ix %i, %two
  %a0 = gep %p, %at, 1, 0
  %lo0 = load.i8.na %a0
  %lo = zext.i32 %lo0
  %a1 = gep %p, %at, 1, 1
  %hi0 = load.i8.na %a1
  %hi = zext.i32 %hi0
  %c0 = iconst.i32 0
  %ishi = icmp.ne.i32 %hi, %c0
  %c32 = iconst.i32 32
  %low = icmp.ult.i32 %lo, %c32
  %c127 = iconst.i32 127
  %top = icmp.uge.i32 %lo, %c127
  %c123 = iconst.i32 123
  %brace = icmp.eq.i32 %lo, %c123
  %c92 = iconst.i32 92
  %slash = icmp.eq.i32 %lo, %c92
  %b1 = or.i32 %ishi, %low
  %b2 = or.i32 %b1, %top
  %b3 = or.i32 %b2, %brace
  %b4 = or.i32 %b3, %slash
  brif %b4, bb_esc, bb_plain
bb_plain:
  intrinsic native.putc %lo
  br bb_next
bb_esc:
  %open = iconst.i32 123
  intrinsic native.putc %open
  %u = iconst.i32 117
  intrinsic native.putc %u
  call @__rt_hex8 %hi
  call @__rt_hex8 %lo
  %close = iconst.i32 125
  intrinsic native.putc %close
  br bb_next
bb_next:
  %one = iconst.ix 1
  %j = add.ix %i, %one
  br bb_loop(%j)
bb_done:
  ret
}
`;
      this.funcs.push(
        ...assemble(this.bulk ? text.replaceAll("intrinsic native.putc ", "call @__rt_out ") : text)
          .funcs,
      );
    }
  }

  trapMessages(strings: Record<string, number>): void {
    const b = new FuncBuilder("__rt_trap_message", ["i32"], []);
    const code = b.params[0]!;
    const sites = this.m.traps.filter((t) => t.msg !== undefined);
    const seen = new Set<number>();
    const exit = b.block();
    const entry = b.cur;
    const cases: { key: bigint; to: { block: number; args: number[] } }[] = [];
    for (const site of sites) {
      if (seen.has(site.code)) continue;
      seen.add(site.code);
      const blk = b.block();
      cases.push({ key: BigInt(site.code), to: { block: blk.id, args: [] } });
      b.at(blk);
      const { ctor, parts } = JSON.parse(site.msg!) as {
        ctor: string;
        parts: (string | { k: string; a: number })[];
      };
      this.puts(b, `${ctor}: `);
      for (const p of parts) {
        if (typeof p === "string") {
          this.puts(b, p.replaceAll("\n", "\\n"));
          continue;
        }
        const at = b.at0(b.global("__trap_args"), p.a * 8);
        if (p.k === "s") {
          this.putString(b, b.load("ptr", at));
          continue;
        }
        if (p.k === "f64") b.call("__rt_putf64", [b.load("f64", at)]);
        else if (p.k === "u32") b.call("__rt_udec", [b.op("zext.i64", [b.load("i32", at)], "i64")]);
        else if (p.k === "bool") {
          const v = b.load("i32", at);
          const yes = b.block();
          const no = b.block();
          const next = b.block();
          b.brif(v, yes, no);
          b.at(yes);
          this.puts(b, "true");
          b.br(next);
          b.at(no);
          this.puts(b, "false");
          b.br(next);
          b.at(next);
        } else if (p.k === "str") {
          const v = b.load("i32", at);
          const next = b.block();
          const sel: { key: bigint; to: { block: number; args: number[] } }[] = [];
          const from = b.cur;
          for (const [s, n] of Object.entries(strings)) {
            const blkS = b.block();
            sel.push({ key: BigInt(n), to: { block: blkS.id, args: [] } });
            b.at(blkS);
            this.puts(b, s);
            b.br(next);
          }
          b.at(from);
          b.term({ k: "switch", val: v, cases: sel, def: { block: next.id, args: [] } });
          b.at(next);
        } else b.call("__rt_dec", [b.op("sext.i64", [b.load("i32", at)], "i64")]);
      }
      b.br(exit);
    }
    b.at(entry);
    b.term({ k: "switch", val: code, cases, def: { block: exit.id, args: [] } });
    b.at(exit);
    b.ret();
    this.funcs.push(b.finish());
  }
}
