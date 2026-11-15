// Random TIR programs, run natively at -O0, -O1 and -O2 and compared with each other (SPEC 8.1, D44, D46). No V8: what's
// generated is TIR, so it reaches what no source program reaches yet, and what V8 can't run: multiple returns, calls
// through function pointers, recursion, every trap the checks have, frame slots, switches, and constants at the edges of
// each type, which is what the folds are for. A program that differs between levels has a compiler bug (D44).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FuncBuilder } from "../compiler/tir/build.ts";
import {
  canonicalize,
  type Block,
  type Func,
  type Module,
  type TirType,
} from "../compiler/tir/ir.ts";
import { optFromEnv, optimizeModule, type OptLevel } from "../compiler/tir/passes/manager.ts";
import { printModule } from "../compiler/tir/text.ts";
import { verifyModule } from "../compiler/tir/verify.ts";
import { pool } from "./guarded-run.ts";
import { buildTslImage, bulkFor, tslResults } from "./native-exec.ts";
import { qemuRun, type Accel } from "./qemu-run.ts";
import { buildPath } from "./build-dir.ts";

/** mulberry32: small, and the same on every host. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Ty = "i32" | "i64" | "f64";
const TYS: Ty[] = ["i32", "i64", "f64"];

interface Sig {
  params: Ty[];
  rets: Ty[];
}

const TRAPS = [
  { id: 1, kind: "overflow", code: 1, loc: "fuzz:1:1" },
  { id: 2, kind: "bounds", code: 2, loc: "fuzz:2:1" },
  { id: 3, kind: "divide", code: 3, loc: "fuzz:3:1" },
  { id: 4, kind: "assert", code: 1001, loc: "fuzz:4:1" },
  { id: 5, kind: "memory", code: 14, loc: "fuzz:5:1" },
  { id: 6, kind: "null", code: 6, loc: "fuzz:6:1" },
];
const ARR = 64; // i32 elements in @arr

const EDGE32 = [0n, 1n, -1n, 2n, 7n, 31n, 32n, 255n, 65535n, 2147483647n, -2147483648n, 100000n];
const EDGE64 = [
  0n,
  1n,
  -1n,
  63n,
  64n,
  4294967295n,
  9223372036854775807n,
  -9223372036854775808n,
  1n << 40n,
];
const EDGEF = [0, -0, 1, -1, 0.5, 1e300, -1e-300, 3.75, 2 ** 53, Number.POSITIVE_INFINITY];

class Gen {
  r: () => number;
  sigs: Sig[] = [];
  funcs: Func[] = [];
  sigTable: { params: TirType[]; rets: TirType[] }[] = [];
  constructor(seed: number) {
    this.r = rng(seed);
  }
  int(n: number): number {
    return Math.floor(this.r() * n);
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]!;
  }
  chance(p: number): boolean {
    return this.r() < p;
  }
  sigId(s: Sig): number {
    const i = this.sigTable.findIndex(
      (x) => x.params.join() === s.params.join() && x.rets.join() === s.rets.join(),
    );
    if (i >= 0) return i;
    this.sigTable.push({ params: [...s.params], rets: [...s.rets] });
    return this.sigTable.length - 1;
  }

  module(): Module {
    const n = 3 + this.int(7);
    for (let i = 0; i < n; i++) {
      const params = Array.from({ length: 1 + this.int(3) }, () => this.pick(TYS));
      const rets = Array.from({ length: 1 + (this.chance(0.3) ? 1 : 0) }, () => this.pick(TYS));
      this.sigs.push({ params, rets });
    }
    // A recursive one, with its depth in its first parameter, and a few calling it.
    this.sigs.push({ params: ["i32", "i64"], rets: ["i64"] });
    for (let i = n - 1; i >= 0; i--) this.funcs.unshift(this.func(i, n));
    this.funcs.push(this.rec(n));
    this.funcs.push(this.peek());
    this.funcs.push(this.abort());
    this.funcs.push(this.run());
    return {
      sigs: this.sigTable,
      globals: [{ name: "arr", size: ARR * 4, align: 8, section: "data" }],
      funcs: this.funcs,
      traps: TRAPS,
      externs: [],
    };
  }

  /** f{i}: may call f{j} for j > i, and the recursive one. */
  func(i: number, n: number): Func {
    const s = this.sigs[i]!;
    const attrs = this.chance(0.1) ? ["noinline"] : this.chance(0.1) ? ["inline"] : [];
    const b = new FuncBuilder(`f${i}`, s.params, s.rets, attrs);
    const vals: Record<Ty, number[]> = { i32: [], i64: [], f64: [] };
    b.params.forEach((p, k) => vals[s.params[k]!].push(p));
    // A frame slot, filled with zero, used at constant offsets: what scalar replacement is for.
    let slot: number | null = null;
    // A fast path wants a cheap entry: a slot's fill is an effect, so it's rarer with one.
    const fastPath = this.chance(0.45);
    if (this.chance(fastPath ? 0.1 : 0.4)) {
      slot = b.raw(
        "alloca",
        [
          { t: "i", val: 16n },
          { t: "i", val: 8n },
          { t: "trap", id: 5 },
        ],
        ["ptr"],
      )[0]!;
      b.intrinsic("mem.fill", [slot, b.i32(0), b.ix(16)]);
    }
    const body = new Body(this, b, vals, i, n, slot);
    // Sometimes a counter bumped before anything else: a store before the fast path's test, which partial inlining
    // must see as an effect, or a slow path that calls the whole function runs it twice.
    if (this.chance(fastPath ? 0.6 : 0.15)) {
      const at = b.gep(b.global("arr"), b.ix(this.int(ARR)), 4, 0);
      b.store("i32", at, b.op("add.i32", [b.load("i32", at), b.i32(1)], "i32"));
    }
    // A fast path first, sometimes: a cheap test, and an early return, the shape partial inlining looks for.
    if (fastPath) {
      const fast = b.block();
      const slow = b.block();
      const c = b.op("icmp.eq.i32", [body.get("i32"), b.i32(this.pick([0, 1, 7]))], "i32");
      b.brif(c, fast, slow);
      b.at(fast);
      b.ret(s.rets.map((t) => body.constOf(t)));
      b.at(slow);
    }
    body.statements(4 + this.int(10));
    b.ret(s.rets.map((t) => body.get(t)));
    return b.finish();
  }

  rec(n: number): Func {
    const b = new FuncBuilder("rec", ["i32", "i64"], ["i64"]);
    const [d, x] = b.params as [number, number];
    const mask = b.op("and.i32", [d, b.i32(15)], "i32");
    const done = b.block();
    const more = b.block();
    b.brif(b.op("icmp.sle.i32", [mask, b.i32(0)], "i32"), done, more);
    b.at(done);
    b.ret([x]);
    b.at(more);
    const d1 = b.op("sub.i32", [mask, b.i32(1)], "i32");
    const x1 = b.op(
      "add.i64",
      [b.op("mul.i64", [x, b.i64(3)], "i64"), b.op("sext.i64", [d1], "i64")],
      "i64",
    );
    const [r] = b.call("rec", [d1, x1], ["i64"]);
    b.ret([b.op("xor.i64", [r!, x], "i64")]);
    void n;
    return b.finish();
  }

  /** Never returns: a callee that traps, so whatever follows a call to it is unreachable once it's inlined. */
  abort(): Func {
    const b = new FuncBuilder("abort", ["i32"], ["i32"]);
    b.term({ k: "trap", id: 4 });
    return b.finish();
  }

  /** A load through a pointer, whose result a caller may drop: through null it faults, which is trap 6, at every level. */
  peek(): Func {
    const b = new FuncBuilder("peek", ["ptr"], ["i32"]);
    b.ret([b.load("i32", b.params[0]!)]);
    return b.finish();
  }

  /** The export: calls f0 and the rest from a seed, mixes every result into one number, with the array's sum. */
  run(): Func {
    const b = new FuncBuilder("run", ["i32"], ["i64"], ["export"]);
    const seed = b.params[0]!;
    let acc = b.op("sext.i64", [seed], "i64");
    for (let i = 0; i < this.sigs.length - 1; i++) {
      if (i > 0 && !this.chance(0.5)) continue;
      const s = this.sigs[i]!;
      const args = s.params.map((t, k) => {
        const v = b.op("add.i32", [seed, b.i32(k * 17 + i)], "i32");
        if (t === "i32") return v;
        if (t === "i64") return b.op("sext.i64", [v], "i64");
        return b.op("sitofp.f64", [v], "f64");
      });
      const rs = b.call(`f${i}`, args, s.rets);
      rs.forEach((r, k) => {
        const t = s.rets[k]!;
        const w =
          t === "i64"
            ? r
            : t === "i32"
              ? b.op("sext.i64", [r], "i64")
              : b.op("bitcast.i64", [r], "i64");
        acc = b.op("add.i64", [b.op("mul.i64", [acc, b.i64(31)], "i64"), w], "i64");
      });
    }
    // The array's contents, which stores in the program changed.
    const head = b.block(["ix", "i64"]);
    const loop = b.block();
    const out = b.block();
    b.br(head, [b.ix(0), acc]);
    b.at(head);
    const [k, a] = head.params as [number, number];
    b.brif(b.op("icmp.ult.ix", [k, b.ix(ARR)], "i32"), loop, out);
    b.at(loop);
    const v = b.load("i32", b.gep(b.global("arr"), k, 4, 0));
    const a2 = b.op(
      "add.i64",
      [b.op("mul.i64", [a, b.i64(7)], "i64"), b.op("sext.i64", [v], "i64")],
      "i64",
    );
    b.store("i32", b.gep(b.global("arr"), k, 4, 0), b.i32(0));
    b.br(head, [b.op("add.ix", [k, b.ix(1)], "ix"), a2]);
    b.at(out);
    b.ret([a]);
    return b.finish();
  }
}

class Body {
  g: Gen;
  b: FuncBuilder;
  vals: Record<Ty, number[]>;
  self: number;
  n: number;
  slot: number | null;
  depth = 0;
  constructor(
    g: Gen,
    b: FuncBuilder,
    vals: Record<Ty, number[]>,
    self: number,
    n: number,
    slot: number | null,
  ) {
    this.g = g;
    this.b = b;
    this.vals = vals;
    this.self = self;
    this.n = n;
    this.slot = slot;
  }
  constOf(t: Ty): number {
    const g = this.g;
    if (t === "i32") return this.b.i32(g.chance(0.25) ? g.pick(EDGE32) : BigInt(g.int(200) - 100));
    if (t === "i64")
      return this.b.i64(g.chance(0.25) ? g.pick(EDGE64) : BigInt(g.int(2000) - 1000));
    return this.b.f64(g.chance(0.25) ? g.pick(EDGEF) : g.int(1000) / 8 - 50);
  }
  get(t: Ty): number {
    const l = this.vals[t];
    if (l.length === 0 || this.g.chance(0.2)) {
      const c = this.constOf(t);
      l.push(c);
      return c;
    }
    return this.g.pick(l);
  }
  put(t: Ty, v: number): void {
    this.vals[t].push(v);
  }
  statements(k: number): void {
    for (let i = 0; i < k; i++) this.statement();
  }
  statement(): void {
    const g = this.g;
    const b = this.b;
    // Phase B's patterns (D73): what value numbering, loop-invariant code motion, unswitching and peeling look for.
    if (this.depth < 2 && g.chance(0.1)) {
      // What each makes inside its own blocks stays there: only its result is used after.
      const saved = { i32: [...this.vals.i32], i64: [...this.vals.i64], f64: [...this.vals.f64] };
      const which = g.int(8);
      const v =
        which === 0
          ? this.memLoop()
          : which === 1
            ? this.reload()
            : which === 2
              ? this.switchedLoop()
              : which === 3
                ? this.ivLoop()
                : which === 4
                  ? this.maskLoad()
                  : which === 5
                    ? this.nearLimit()
                    : which === 6
                      ? this.lengthLoop()
                      : this.nullCheckLoad();
      this.vals = saved;
      this.put("i32", v);
      return;
    }
    const r = g.int(100);
    if (r < 22) {
      const t: "i32" | "i64" = g.chance(0.6) ? "i32" : "i64";
      const op = g.pick(["add", "sub", "mul", "and", "or", "xor"]);
      this.put(t, b.op(`${op}.${t}`, [this.get(t), this.get(t)], t));
    } else if (r < 30) {
      const t: "i32" | "i64" = g.chance(0.6) ? "i32" : "i64";
      const sg = g.chance(0.85) ? "s" : "u";
      // Unsigned subtraction of two small numbers fails half the time: it's in, but rarely.
      const op = g.pick(sg === "u" && !g.chance(0.1) ? ["add", "mul"] : ["add", "sub", "mul"]);
      // Mostly small operands, so most checks pass and the case goes on; sometimes anything, so some fire.
      const small = (): number => {
        const x = this.get(t);
        return g.chance(0.92)
          ? b.op(`and.${t}`, [x, t === "i32" ? b.i32(0xfff) : b.i64(0xfffff)], t)
          : x;
      };
      this.put(
        t,
        b.raw(
          `${op}.chk.${sg}.${t}`,
          [
            { t: "v", id: small() },
            { t: "v", id: small() },
            { t: "trap", id: 1 },
          ],
          [t],
        )[0]!,
      );
    } else if (r < 35) {
      const t: "i32" | "i64" = g.chance(0.6) ? "i32" : "i64";
      const op = g.pick(["shl", "lshr", "ashr"]);
      const cnt = b.op(`and.${t}`, [this.get(t), t === "i32" ? b.i32(31) : b.i64(63)], t);
      this.put(t, b.op(`${op}.${t}`, [this.get(t), cnt], t));
    } else if (r < 39) {
      const t: "i32" | "i64" = g.chance(0.6) ? "i32" : "i64";
      const op = g.pick(["sdiv", "srem", "udiv", "urem"]);
      // Mostly not zero: a divide that always traps ends the case too soon to test much.
      const d = g.chance(0.85)
        ? b.op(`or.${t}`, [this.get(t), t === "i32" ? b.i32(1) : b.i64(1)], t)
        : this.get(t);
      this.put(
        t,
        b.raw(
          `${op}.${t}`,
          [
            { t: "v", id: this.get(t) },
            { t: "v", id: d },
            { t: "trap", id: 3 },
          ],
          [t],
        )[0]!,
      );
    } else if (r < 45) {
      const op = g.pick(["fadd", "fsub", "fmul", "fdiv"]);
      this.put("f64", b.op(`${op}.f64`, [this.get("f64"), this.get("f64")], "f64"));
      if (g.chance(0.3))
        this.put(
          "f64",
          b.op(
            g.pick(["fneg.f64", "fabs.f64", "ffloor.f64", "ftrunc.f64"]),
            [this.get("f64")],
            "f64",
          ),
        );
    } else if (r < 52) {
      // Conversions.
      const which = g.int(6);
      if (which === 0) this.put("i64", b.op("sext.i64", [this.get("i32")], "i64"));
      else if (which === 1) this.put("i64", b.op("zext.i64", [this.get("i32")], "i64"));
      else if (which === 2) this.put("i32", b.op("trunc.i32", [this.get("i64")], "i32"));
      else if (which === 3) this.put("f64", b.op("sitofp.f64", [this.get("i32")], "f64"));
      else if (which === 4) this.put("i32", b.op("js.toint32", [this.get("f64")], "i32"));
      else this.put("i64", b.op("fptosi.sat.i64", [this.get("f64")], "i64"));
    } else if (r < 58) {
      const t: Ty = g.pick(TYS);
      const c =
        t === "f64"
          ? b.op(
              `fcmp.${g.pick(["eq", "ne", "lt", "le", "gt", "ge"])}.f64`,
              [this.get("f64"), this.get("f64")],
              "i32",
            )
          : b.op(
              `icmp.${g.pick(["eq", "ne", "slt", "sle", "ult", "uge"])}.${t}`,
              [this.get(t), this.get(t)],
              "i32",
            );
      this.put("i32", c);
      const u: Ty = g.pick(TYS);
      this.put(u, b.op(`select.${u}`, [c, this.get(u), this.get(u)], u));
    } else if (r < 64) {
      // The array: a checked index, and a load or a store.
      const raw = b.op("and.i32", [this.get("i32"), b.i32(g.chance(0.9) ? ARR - 1 : 127)], "i32");
      const idx = b.raw(
        "bounds.chk",
        [
          { t: "v", id: b.op("zext.ix", [raw], "ix") },
          { t: "v", id: b.ix(ARR) },
          { t: "trap", id: 2 },
        ],
        ["ix"],
      )[0]!;
      const at = b.gep(b.global("arr"), idx, 4, 0);
      if (g.chance(0.5)) this.put("i32", b.load("i32", at));
      else b.store("i32", at, this.get("i32"));
    } else if (r < 70 && this.slot !== null) {
      const off = g.pick([0, 4, 8, 12]);
      const at = b.at0(this.slot, off);
      if (g.chance(0.5)) this.put("i32", b.load("i32", at));
      else b.store("i32", at, this.get("i32"));
    } else if (r < 80) {
      if (g.chance(0.2)) this.peekNull(16);
      else if (g.chance(0.1)) this.abortRarely();
      else this.call();
    } else if (r < 88 && this.depth < 2) {
      this.diamond();
    } else if (r < 93 && this.depth < 2) {
      this.loop();
    } else if (r < 96 && this.depth < 2) {
      this.switch();
    } else if (r < 97) {
      const which = g.int(3);
      if (which === 0) {
        // A checked operation on two constants, either side of overflowing: what folding a check is about.
        const t: "i32" | "i64" = g.chance(0.5) ? "i32" : "i64";
        const big =
          t === "i32"
            ? [2147483647n, -2147483648n, 65536n, 46341n]
            : [9223372036854775807n, -9223372036854775808n, 4294967296n, 3037000500n];
        const a = b.iconst(t, g.pick(big));
        const c = b.iconst(t, g.pick([0n, 1n, -1n, 2n, ...big]));
        const op = g.pick(["add", "sub", "mul"]);
        const res = b.raw(
          `${op}.chk.s.${t}`,
          [
            { t: "v", id: a },
            { t: "v", id: c },
            { t: "trap", id: 1 },
          ],
          [t],
        )[0]!;
        this.put(t, res);
      } else if (which === 1) {
        // Read, change, write back: running it twice shows.
        const raw = b.op("and.i32", [this.get("i32"), b.i32(ARR - 1)], "i32");
        const at = b.gep(b.global("arr"), b.op("zext.ix", [raw], "ix"), 4, 0);
        b.store("i32", at, b.op("add.i32", [b.load("i32", at), b.i32(1 + g.int(5))], "i32"));
      } else {
        this.peekNull(4);
      }
    } else if (r < 98) {
      // A trap of the program's own, on an unlikely value.
      const ok = b.block();
      const bad = b.block();
      b.brif(b.op("icmp.eq.i32", [this.get("i32"), b.i32(-123457)], "i32"), bad, ok);
      b.at(bad);
      b.term({ k: "trap", id: 4 });
      b.at(ok);
    } else {
      this.put("i64", b.call("rec", [this.get("i32"), this.get("i64")], ["i64"])[0]!);
    }
  }
  /** An element of @arr, its address, at a constant index. */
  elem(k: number): number {
    const b = this.b;
    return b.gep(b.global("arr"), b.ix(k), 4, 0);
  }
  /**
   * Something between two loads of `at`: nothing, a store there or next to it or at an index from a value, a call that may
   * write, one to `peek`, which only reads, or an if/else with a store in one arm.
   */
  between(at: number): void {
    const g = this.g;
    const b = this.b;
    const w = g.int(7);
    if (w === 1) b.store("i32", at, this.get("i32"));
    else if (w === 2) b.store("i32", this.elem(g.int(ARR)), this.get("i32"));
    else if (w === 3) {
      const raw = b.op("and.i32", [this.get("i32"), b.i32(ARR - 1)], "i32");
      b.store("i32", b.gep(b.global("arr"), b.op("zext.ix", [raw], "ix"), 4, 0), this.get("i32"));
    } else if (w === 4) this.call();
    else if (w === 5) b.call("peek", [b.global("arr")], ["i32"]);
    else if (w === 6) {
      const yes = b.block();
      const join = b.block();
      b.brif(this.get("i32"), yes, join);
      b.at(yes);
      b.store("i32", g.chance(0.5) ? at : this.elem(g.int(ARR)), this.get("i32"));
      b.br(join);
      b.at(join);
    }
  }
  /**
   * A pointer to an element of @arr, or null on one value in eight of what it's made from, with a turn count that's 0 when
   * it's null: a loop that runs no turn through null loads nothing at -O0, so no level may.
   */
  maybeNull(): { p: number; n: number } {
    const b = this.b;
    const g = this.g;
    const c = b.op(
      "icmp.eq.i32",
      [b.op("and.i32", [this.get("i32"), b.i32(7)], "i32"), b.i32(g.int(8))],
      "i32",
    );
    const p = b.op("select.ptr", [c, b.iconst("ptr", 0), this.elem(g.int(ARR - 1))], "ptr");
    const n0 = b.op("and.i32", [this.get("i32"), b.i32(7)], "i32");
    const n = b.op("select.i32", [c, b.i32(0), n0], "i32");
    return { p, n };
  }
  /**
   * A loop reading the same element every turn, in its header or behind its test, through a pointer that may be null when
   * it runs no turn, sometimes after a check that can fire, and with the loop maybe writing there, next to it, or anywhere.
   */
  memLoop(): number {
    const b = this.b;
    const g = this.g;
    const { p, n } = this.maybeNull();
    const head = b.block(["i32", "i32"]);
    const body = b.block();
    const exit = b.block();
    const inHead = g.chance(0.5);
    const checkFirst = g.chance(0.3);
    b.br(head, [b.i32(0), this.get("i32")]);
    b.at(head);
    const [k, acc] = head.params as [number, number];
    let v: number | null = null;
    const check = (): void => {
      // Near its limit: fires for an operand above 3947, about one in twenty-eight.
      const x = b.op("and.i32", [this.get("i32"), b.i32(0xfff)], "i32");
      b.raw(
        "add.chk.s.i32",
        [
          { t: "v", id: x },
          { t: "v", id: b.i32(2147479700) },
          { t: "trap", id: 1 },
        ],
        ["i32"],
      );
    };
    if (inHead) {
      if (checkFirst) check();
      v = b.load("i32", p);
    }
    b.brif(b.op("icmp.slt.i32", [k, n], "i32"), body, exit);
    b.at(body);
    if (!inHead) {
      if (checkFirst) check();
      v = b.load("i32", p);
    }
    // The loop may write the element, the one next to it, or one at an index it computes.
    const w = g.int(4);
    if (w === 1) b.store("i32", p, b.op("add.i32", [v!, b.i32(1)], "i32"));
    else if (w === 2) b.store("i32", b.gep(p, b.ix(1), 4, 0), k);
    else if (w === 3) {
      const raw = b.op(
        "and.i32",
        [b.op("add.i32", [k, this.get("i32")], "i32"), b.i32(ARR - 1)],
        "i32",
      );
      b.store("i32", b.gep(b.global("arr"), b.op("zext.ix", [raw], "ix"), 4, 0), k);
    }
    const acc2 = b.op("add.i32", [b.op("mul.i32", [acc, b.i32(3)], "i32"), v!], "i32");
    b.br(head, [b.op("add.i32", [k, b.i32(1)], "i32"), acc2]);
    b.at(exit);
    return acc;
  }
  /** The same element loaded twice with something between, and a load -O0 drops before a check that may fire. */
  reload(): number {
    const b = this.b;
    const g = this.g;
    if (g.chance(0.3)) {
      // Dropped at -O0, through null sometimes; then a check; then the same load, used. The first mustn't stand for it.
      const { p } = this.maybeNull();
      b.load("i32", p);
      // In bounds but in one program in five, where it fires on half the values.
      const raw = b.op("and.i32", [this.get("i32"), b.i32(g.chance(0.2) ? 127 : ARR - 1)], "i32");
      b.raw(
        "bounds.chk",
        [
          { t: "v", id: b.op("zext.ix", [raw], "ix") },
          { t: "v", id: b.ix(ARR) },
          { t: "trap", id: 2 },
        ],
        ["ix"],
      );
      return b.load("i32", p);
    }
    const at = this.elem(g.int(ARR));
    const v1 = b.load("i32", at);
    this.between(at);
    const v2 = b.load("i32", at);
    return b.op("sub.i32", [b.op("mul.i32", [v1, b.i32(5)], "i32"), v2], "i32");
  }
  /** A loop testing, every turn, an element it may or may not change: what unswitching copies. */
  switchedLoop(): number {
    const b = this.b;
    const g = this.g;
    const at = this.elem(g.int(ARR));
    const t = b.op(
      "icmp.eq.i32",
      [b.op("and.i32", [b.load("i32", at), b.i32(1)], "i32"), b.i32(0)],
      "i32",
    );
    const n = b.op("and.i32", [this.get("i32"), b.i32(7)], "i32");
    const head = b.block(["i32", "i32"]);
    const body = b.block();
    const yes = b.block();
    const no = b.block();
    const join = b.block(["i32"]);
    const exit = b.block();
    b.br(head, [b.i32(0), this.get("i32")]);
    b.at(head);
    const [k, acc] = head.params as [number, number];
    b.brif(b.op("icmp.slt.i32", [k, n], "i32"), body, exit);
    b.at(body);
    b.brif(t, yes, no);
    b.at(yes);
    const a1 = b.op("add.i32", [acc, b.load("i32", at)], "i32");
    if (g.chance(0.3)) b.store("i32", at, k);
    b.br(join, [a1]);
    b.at(no);
    const a2 = b.op("xor.i32", [acc, b.op("mul.i32", [k, b.i32(7)], "i32")], "i32");
    b.br(join, [a2]);
    b.at(join);
    b.br(head, [b.op("add.i32", [k, b.i32(1)], "i32"), join.params[0]!]);
    b.at(exit);
    return acc;
  }
  /**
   * An induction variable bounded by a test, indexing @arr through a bounds check on a length: counting to below the
   * length, to it, or one past it, with `<` or `<=`, so the check sometimes fires on the last turn; and a checked increment.
   */
  ivLoop(): number {
    const b = this.b;
    const g = this.g;
    const len = g.pick([ARR, ARR - 1, ARR / 2]);
    const sel = b.op("and.i32", [this.get("i32"), b.i32(15)], "i32");
    const at = (k: number): number => b.op("icmp.eq.i32", [sel, b.i32(k)], "i32");
    const n = b.op(
      "select.ix",
      [at(0), b.ix(len + 1), b.op("select.ix", [at(1), b.ix(len - 1), b.ix(len)], "ix")],
      "ix",
    );
    const inclusive = g.chance(0.08);
    const head = b.block(["ix", "i32"]);
    const body = b.block();
    const exit = b.block();
    b.br(head, [b.ix(g.chance(0.7) ? 0 : 3), this.get("i32")]);
    b.at(head);
    const [k, acc] = head.params as [number, number];
    b.brif(b.op(`icmp.${inclusive ? "ule" : "ult"}.ix`, [k, n], "i32"), body, exit);
    b.at(body);
    const idx = b.raw(
      "bounds.chk",
      [
        { t: "v", id: k },
        { t: "v", id: b.ix(len) },
        { t: "trap", id: 2 },
      ],
      ["ix"],
    )[0]!;
    const v = b.load("i32", b.gep(b.global("arr"), idx, 4, 0));
    const acc2 = b.op("add.i32", [b.op("mul.i32", [acc, b.i32(7)], "i32"), v], "i32");
    const k2 = b.raw(
      "add.chk.u.ix",
      [
        { t: "v", id: k },
        { t: "v", id: b.ix(1) },
        { t: "trap", id: 1 },
      ],
      ["ix"],
    )[0]!;
    b.br(head, [k2, acc2]);
    b.at(exit);
    return acc;
  }
  /**
   * R7: `for (k = s; k < n; k++) a[k]` as a JsArray's `get` checks it, the shape -O1's loop bounds proof takes: an i32 or
   * usize counter tested against a length (through `trunc.i32` for the i32) and checked against the same length by a
   * compare and branch to a trap or a `bounds.chk`. Sometimes the test is `<=`, the start -1, the step 2 with no overflow
   * check, or the check's length another value, so the check can fire on some turn and must stay. The element read is
   * masked into @arr whatever the check says.
   */
  lengthLoop(): number {
    const b = this.b;
    const g = this.g;
    const wide = g.chance(0.4);
    const kt = wide ? "ix" : "i32";
    const lens = [ARR, ARR - 1, 3, 0];
    const sel = b.op("and.i32", [this.get("i32"), b.i32(3)], "i32");
    const at = (k: number): number => b.op("icmp.eq.i32", [sel, b.i32(k)], "i32");
    const n = b.op(
      "select.ix",
      [at(0), b.ix(lens[0]!), b.op("select.ix", [at(1), b.ix(lens[1]!), b.ix(g.pick(lens))], "ix")],
      "ix",
    );
    const inclusive = g.chance(0.3);
    const negStart = !wide && g.chance(0.1);
    const step2 = !wide && g.chance(0.1);
    const otherLen = g.chance(0.1);
    const head = b.block([kt, "i32"]);
    const body = b.block();
    const exit = b.block();
    b.br(head, [b.iconst(kt, negStart ? -1 : g.chance(0.7) ? 0 : 2), this.get("i32")]);
    b.at(head);
    const [k, acc] = head.params as [number, number];
    const m = wide ? n : b.op("trunc.i32", [n], "i32");
    const pred = `${wide ? "u" : "s"}${inclusive ? "le" : "lt"}`;
    b.brif(b.op(`icmp.${pred}.${kt}`, [k, m], "i32"), body, exit);
    b.at(body);
    const idx = wide ? k : b.op("zext.ix", [k], "ix");
    const len = otherLen ? b.ix(ARR / 2) : n;
    let i = idx;
    if (g.chance(0.5)) {
      i = b.raw(
        "bounds.chk",
        [
          { t: "v", id: idx },
          { t: "v", id: len },
          { t: "trap", id: 2 },
        ],
        ["ix"],
      )[0]!;
    } else {
      const bad = b.block();
      const ok = b.block();
      b.brif(b.op("icmp.uge.ix", [idx, len], "i32"), bad, ok);
      b.at(bad);
      b.term({ k: "trap", id: 2 });
      b.at(ok);
    }
    const masked = b.op("and.ix", [i, b.ix(ARR - 1)], "ix");
    const v = b.load("i32", b.gep(b.global("arr"), masked, 4, 0));
    const acc2 = b.op("add.i32", [b.op("mul.i32", [acc, b.i32(5)], "i32"), v], "i32");
    const k2 = step2
      ? b.op("add.i32", [k, b.i32(2)], "i32")
      : b.raw(
          `add.chk.${wide ? "u" : "s"}.${kt}`,
          [
            { t: "v", id: k },
            { t: "v", id: b.iconst(kt, 1) },
            { t: "trap", id: 1 },
          ],
          [kt],
        )[0]!;
    b.br(head, [k2, acc2]);
    b.at(exit);
    return acc;
  }
  /**
   * R7: `p!.x` as lowering makes it, through a pointer that's null on one value in eight: an explicit check trapping 6,
   * then a load at a small offset from p, which -O1's and -O2's backend leaves the check to. Sometimes a store comes
   * first, or the load is through another pointer, and the check must stay where it is.
   */
  nullCheckLoad(): number {
    const b = this.b;
    const g = this.g;
    const { p } = this.maybeNull();
    const bad = b.block();
    const ok = b.block();
    if (g.chance(0.5)) b.brif(b.op("icmp.eq.ptr", [p, b.iconst("ptr", 0)], "i32"), bad, ok);
    else b.brif(b.op("icmp.ne.ptr", [p, b.iconst("ptr", 0)], "i32"), ok, bad);
    b.at(bad);
    b.term({ k: "trap", id: 6 });
    b.at(ok);
    const w = g.int(5);
    if (w === 1) b.store("i32", this.elem(g.int(ARR)), this.get("i32"));
    else if (w === 2) b.load("i32", this.elem(g.int(ARR)));
    const at = g.chance(0.5) ? p : b.gep(p, b.ix(g.int(2)), 4, 0);
    const v = b.load("i32", at);
    // Used, so the backend keeps the load (one nothing uses it drops, and then the check stays).
    b.store("i32", this.elem(g.int(ARR)), b.op("add.i32", [v, b.i32(1)], "i32"));
    return v;
  }
  /** A value masked by a length less one, against that length or a smaller one: `x & (n - 1)` below n, whatever x is. */
  maskLoad(): number {
    const b = this.b;
    const g = this.g;
    const c = b.op("icmp.slt.i32", [this.get("i32"), b.i32(0)], "i32");
    const n = b.op("select.ix", [c, b.ix(ARR), b.ix(g.pick([ARR / 2, 48, 1]))], "ix");
    const m = b.raw(
      "sub.chk.u.ix",
      [
        { t: "v", id: n },
        { t: "v", id: b.ix(1) },
        { t: "trap", id: 1 },
      ],
      ["ix"],
    )[0]!;
    const h = b.op("zext.ix", [this.get("i32")], "ix");
    const idx0 = b.op("and.ix", [h, m], "ix");
    const against = g.chance(0.85) ? n : b.ix(ARR / 2);
    const idx = b.raw(
      "bounds.chk",
      [
        { t: "v", id: idx0 },
        { t: "v", id: against },
        { t: "trap", id: 2 },
      ],
      ["ix"],
    )[0]!;
    return b.load("i32", b.gep(b.global("arr"), idx, 4, 0));
  }
  /**
   * Checked arithmetic at its limit behind a compare: x is within 7 of a bound K, the compare says x < K or x <= K, and the
   * add's constant brings K to the type's limit or one past it, so on one value in eight it fires, or doesn't, by one.
   */
  nearLimit(): number {
    const b = this.b;
    const g = this.g;
    const yes = b.block();
    const join = b.block(["i32"]);
    if (g.chance(0.5)) {
      const MAX = 2147483647n;
      const K = g.pick([MAX - 3n, 100n, -2147483640n]);
      const x = b.op(
        "add.i32",
        [b.op("and.i32", [this.get("i32"), b.i32(7)], "i32"), b.iconst("i32", K - 7n)],
        "i32",
      );
      const strict = g.chance(0.5);
      b.brif(
        b.op(`icmp.${strict ? "slt" : "sle"}.i32`, [x, b.iconst("i32", K)], "i32"),
        yes,
        join,
        [],
        [x],
      );
      b.at(yes);
      const c = g.pick([MAX - K, MAX - K + 1n]);
      const r = b.raw(
        "add.chk.s.i32",
        [
          { t: "v", id: x },
          { t: "v", id: b.iconst("i32", c) },
          { t: "trap", id: 1 },
        ],
        ["i32"],
      )[0]!;
      b.br(join, [r]);
    } else {
      // Unsigned, near 0: x >= c (or x > c) above a subtract of c (or c + 1).
      const K = BigInt(g.int(20));
      const x = b.op("and.i32", [this.get("i32"), b.i32(31)], "i32");
      const strict = g.chance(0.5);
      b.brif(
        b.op(`icmp.${strict ? "ugt" : "uge"}.i32`, [x, b.iconst("i32", K)], "i32"),
        yes,
        join,
        [],
        [x],
      );
      b.at(yes);
      const c = g.pick([K, K + 1n]);
      const r = b.raw(
        "sub.chk.u.i32",
        [
          { t: "v", id: x },
          { t: "v", id: b.iconst("i32", c) },
          { t: "trap", id: 1 },
        ],
        ["i32"],
      )[0]!;
      b.br(join, [r]);
    }
    b.at(join);
    return join.params[0]!;
  }
  /** A load whose value is dropped, through null on one value in `n`: -O0 faults there, trap 6, so every level must. */
  peekNull(n: number): void {
    const b = this.b;
    const g = this.g;
    const low = b.op("and.i32", [this.get("i32"), b.i32(n - 1)], "i32");
    const c = b.op("icmp.eq.i32", [low, b.i32(g.int(n))], "i32");
    const p = b.op("select.ptr", [c, b.iconst("ptr", 0), b.global("arr")], "ptr");
    b.call("peek", [p], ["i32"]);
  }
  /** A call to `abort`, which traps, on one value in 64, with its result used after. */
  abortRarely(): void {
    const b = this.b;
    const yes = b.block();
    const join = b.block(["i32"]);
    const low = b.op("and.i32", [this.get("i32"), b.i32(63)], "i32");
    const no = b.i32(0);
    b.brif(b.op("icmp.eq.i32", [low, b.i32(this.g.int(64))], "i32"), yes, join, [], [no]);
    b.at(yes);
    const r = b.call("abort", [low], ["i32"])[0]!;
    b.br(join, [b.op("add.i32", [r, b.i32(1)], "i32")]);
    b.at(join);
    this.put("i32", join.params[0]!);
  }
  args(s: Sig): number[] {
    return s.params.map((t) => this.get(t));
  }
  call(): void {
    const g = this.g;
    const b = this.b;
    if (this.self + 1 >= this.n) return;
    const j = this.self + 1 + g.int(this.n - this.self - 1);
    const s = g.sigs[j]!;
    const kind = g.int(4);
    let rs: number[];
    if (kind < 2) rs = b.call(`f${j}`, this.args(s), s.rets);
    else {
      // Through a pointer: a known address, or one of two through a join, which can't be made direct.
      let p = b.func(`f${j}`);
      if (kind === 3) {
        const other = g.sigs.findIndex(
          (x, k) =>
            k > this.self &&
            k !== j &&
            k < this.n &&
            x.params.join() === s.params.join() &&
            x.rets.join() === s.rets.join(),
        );
        if (other >= 0) {
          const c = b.op("icmp.slt.i32", [this.get("i32"), b.i32(0)], "i32");
          p = b.op("select.ptr", [c, p, b.func(`f${other}`)], "ptr");
        }
      }
      rs = b.raw(
        "call.indirect",
        [
          { t: "sig", id: g.sigId(s) },
          { t: "v", id: p },
          ...this.args(s).map((v) => ({ t: "v" as const, id: v })),
        ],
        s.rets,
      );
    }
    rs.forEach((v, k) => this.put(s.rets[k]!, v));
  }
  /** if/else, each side its own statements, joined with a value of each type. */
  diamond(): void {
    const b = this.b;
    const g = this.g;
    const tys: Ty[] = ["i32", "i64", "f64"];
    const join = b.block(tys);
    const yes = b.block();
    const no = b.block();
    b.brif(this.get("i32"), yes, no);
    const side = (blk: Block): void => {
      b.at(blk);
      const saved = { i32: [...this.vals.i32], i64: [...this.vals.i64], f64: [...this.vals.f64] };
      this.depth++;
      this.statements(1 + g.int(4));
      this.depth--;
      const out = tys.map((t) => this.get(t));
      this.vals = saved;
      b.br(join, out);
    };
    side(yes);
    side(no);
    b.at(join);
    join.params.forEach((p, k) => this.put(tys[k]!, p));
  }
  /** A loop of at most 7 turns, carrying one value of each integer type. */
  loop(): void {
    const b = this.b;
    const g = this.g;
    const n = b.op("and.i32", [this.get("i32"), b.i32(7)], "i32");
    const head = b.block(["i32", "i32", "i64"]);
    const body = b.block();
    const exit = b.block();
    b.br(head, [b.i32(0), this.get("i32"), this.get("i64")]);
    b.at(head);
    const [k, x, y] = head.params as [number, number, number];
    b.brif(b.op("icmp.slt.i32", [k, n], "i32"), body, exit);
    b.at(body);
    const saved = { i32: [...this.vals.i32], i64: [...this.vals.i64], f64: [...this.vals.f64] };
    this.put("i32", x);
    this.put("i64", y);
    this.depth++;
    this.statements(1 + g.int(4));
    this.depth--;
    const x2 = b.op("add.i32", [x, this.get("i32")], "i32");
    const y2 = b.op("xor.i64", [y, this.get("i64")], "i64");
    this.vals = saved;
    b.br(head, [b.op("add.i32", [k, b.i32(1)], "i32"), x2, y2]);
    b.at(exit);
    this.put("i32", x);
    this.put("i64", y);
  }
  switch(): void {
    const b = this.b;
    const g = this.g;
    const join = b.block(["i64"]);
    const v = b.op("and.i32", [this.get("i32"), b.i32(3)], "i32");
    const arms = [b.block(), b.block(), b.block()];
    const def = b.block();
    b.term({
      k: "switch",
      val: v,
      cases: arms.map((a, i) => ({ key: BigInt(i), to: { block: a.id, args: [] } })),
      def: { block: def.id, args: [] },
    });
    for (const a of [...arms, def]) {
      b.at(a);
      const saved = { i32: [...this.vals.i32], i64: [...this.vals.i64], f64: [...this.vals.f64] };
      this.depth++;
      this.statements(g.int(3));
      this.depth--;
      const out = this.get("i64");
      this.vals = saved;
      b.br(join, [out]);
    }
    b.at(join);
    this.put("i64", join.params[0]!);
  }
}

export function generateTir(seed: number): Module {
  return canonicalize(new Gen(seed).module());
}

const META = {
  exports: { run: { params: [{ k: "scalar", name: "i32" }], ret: { k: "scalar", name: "i64" } } },
  strings: {},
};

export interface TirFuzzResult {
  seeds: number;
  ran: number;
  cases: number;
  traps: number;
  trapCodes: Record<string, number>;
  inlined: number;
  failures: string[];
  skipped: boolean;
}

/** Each seed's program at each level, natively, against -O0's results. */
export async function tirFuzz(
  from: number,
  seeds: number,
  accel: Accel,
  jobs: number,
  levels: OptLevel[] = [1, 2],
): Promise<TirFuzzResult> {
  const dir = buildPath("tir-fuzz");
  mkdirSync(dir, { recursive: true });
  const out: TirFuzzResult = {
    seeds,
    ran: 0,
    cases: 0,
    traps: 0,
    trapCodes: {},
    inlined: 0,
    failures: [],
    skipped: false,
  };
  await pool(
    Array.from({ length: seeds }, (_, i) => from + i),
    jobs,
    async (seed) => {
      const m = generateTir(seed);
      const errors = verifyModule(m);
      if (errors.length > 0) {
        out.failures.push(
          `seed ${seed}: the generator made bad TIR: ${errors.slice(0, 3).join("; ")}`,
        );
        return;
      }
      writeFileSync(join(dir, `s${seed}.tir`), printModule(m));
      const cases = Array.from({ length: 8 }, (_, k) => ({ fn: "run", args: [k * 37 - 50] }));
      const runAt = async (level: OptLevel): Promise<string[] | null> => {
        let mod = m;
        if (level > 0) {
          // The environment's switches and injected bugs, as everything else takes them, and always checked after each pass.
          const r = optimizeModule(m, { ...optFromEnv(level), verifyEach: true });
          mod = r.module;
          if (level === 2) out.inlined += r.report.inline.inlined + r.report.inline.partial;
        }
        const image = buildTslImage(mod, META as never, cases as never, undefined, bulkFor());
        const q = await qemuRun({
          name: `tir-fuzz/${seed}/O${level}`,
          image: image.bytes,
          accel,
          timeoutMs: 60_000,
          ...(image.bulk !== undefined ? { bulk: image.bulk } : {}),
        });
        if (q.skipped) {
          out.skipped = true;
          return null;
        }
        if (!q.ok) {
          out.failures.push(`seed ${seed} at -O${level}: ${q.status}: ${q.why.slice(0, 200)}`);
          return null;
        }
        const { results, problems } = tslResults(META as never, cases as never, q.lines);
        for (const p of problems) out.failures.push(`seed ${seed} at -O${level}: ${p}`);
        return results.map((x) => JSON.stringify(x.result));
      };
      let base: string[] | null;
      try {
        base = await runAt(0);
      } catch (e) {
        out.failures.push(`seed ${seed} at -O0: ${String(e).slice(0, 300)}`);
        return;
      }
      if (base === null) return;
      for (const level of levels) {
        let got: string[] | null;
        try {
          got = await runAt(level);
        } catch (e) {
          out.failures.push(`seed ${seed} at -O${level}: ${String(e).slice(0, 300)}`);
          continue;
        }
        if (got === null) continue;
        base.forEach((want, i) => {
          if (got[i] !== want)
            out.failures.push(`seed ${seed} case ${i} at -O${level}: ${got[i]}, -O0 gave ${want}`);
        });
      }
      out.ran++;
      out.cases += base.length;
      for (const x of base) {
        const t = /"trap":(\d+)/.exec(x)?.[1];
        if (t === undefined) continue;
        out.traps++;
        out.trapCodes[t] = (out.trapCodes[t] ?? 0) + 1;
      }
    },
  );
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const val = (n: string, d: number): number => {
    const i = argv.indexOf(n);
    return i < 0 ? d : Number(argv[i + 1]);
  };
  const accel = (argv.includes("--accel") ? argv[argv.indexOf("--accel") + 1] : "hvf") as Accel;
  if (argv.includes("--print")) {
    process.stdout.write(printModule(generateTir(val("--from", 1))));
  } else {
    const r = await tirFuzz(val("--from", 1), val("--seeds", 50), accel, val("--jobs", 4));
    console.log(
      `${r.ran}/${r.seeds} programs, ${r.cases} cases (${r.traps} trapped: ${JSON.stringify(r.trapCodes)}), ${r.inlined} calls inlined at -O2${r.skipped ? ", SKIPPED" : ""}`,
    );
    for (const f of r.failures.slice(0, 30)) console.log(f);
    process.exitCode = r.failures.length > 0 || r.skipped ? 1 : 0;
  }
}
