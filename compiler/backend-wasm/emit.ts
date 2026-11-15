// TIR to a Wasm module. Control flow is rebuilt from the dominator tree, as in Ramsey's
// "Beyond Relooper"; TSL's control flow is always reducible, and this checks that it was.
import {
  buildCfg,
  type Cfg,
  type Edge,
  type Func,
  type Instr,
  INTRINSICS,
  type Module,
  type Operand,
  type TirType,
} from "../tir/ir.ts";
import { FREM_HELPER, FREM_HELPER_NAME } from "../tir/helpers.ts";
import { ByteWriter, section, VALTYPE } from "./encode.ts";

export const DATA_START = 1024;
const PAGE = 65536;
const IXMAX_WASM32 = 4294967295n;

type WasmType = "i32" | "i64" | "f32" | "f64";

function wasmType(t: TirType): WasmType {
  if (t === "i64" || t === "f32" || t === "f64") return t;
  return "i32";
}

interface ModuleInfo {
  funcIndex: Map<string, number>;
  tableIndex: Map<string, number>;
  globalAddr: Map<string, number>;
  trapCode: Map<number, number>;
  m: Module;
  typeIndex: (params: WasmType[], rets: WasmType[]) => number;
  toInt32Index: number;
  usesToInt32: { used: boolean };
  mathImport: Map<string, number>;
  stackBase: number; // the lowest address of the shadow stack, for alloca
  usesStack: boolean;
}

const IMPORT_TRAP = 0;
// Trap code 14: arena, memory or shadow stack exhausted (allowed divergence 4 in SPEC 3.10).
const TRAP_MEMORY = 14n;
const STACK_BYTES = 1 << 20;
const GLOBAL_HEAP_BASE = 0;
const GLOBAL_SP = 1;

// Binary comparison and arithmetic opcodes per Wasm type class.
const ICMP_32: Record<string, number> = {
  eq: 0x46,
  ne: 0x47,
  slt: 0x48,
  ult: 0x49,
  sgt: 0x4a,
  ugt: 0x4b,
  sle: 0x4c,
  ule: 0x4d,
  sge: 0x4e,
  uge: 0x4f,
};
const ICMP_64: Record<string, number> = {
  eq: 0x51,
  ne: 0x52,
  slt: 0x53,
  ult: 0x54,
  sgt: 0x55,
  ugt: 0x56,
  sle: 0x57,
  ule: 0x58,
  sge: 0x59,
  uge: 0x5a,
};
const FCMP_32: Record<string, number> = {
  eq: 0x5b,
  ne: 0x5c,
  lt: 0x5d,
  gt: 0x5e,
  le: 0x5f,
  ge: 0x60,
};
const FCMP_64: Record<string, number> = {
  eq: 0x61,
  ne: 0x62,
  lt: 0x63,
  gt: 0x64,
  le: 0x65,
  ge: 0x66,
};
const IBIN_32: Record<string, number> = {
  add: 0x6a,
  sub: 0x6b,
  mul: 0x6c,
  and: 0x71,
  or: 0x72,
  xor: 0x73,
  shl: 0x74,
  ashr: 0x75,
  lshr: 0x76,
};
const IBIN_64: Record<string, number> = {
  add: 0x7c,
  sub: 0x7d,
  mul: 0x7e,
  and: 0x83,
  or: 0x84,
  xor: 0x85,
  shl: 0x86,
  ashr: 0x87,
  lshr: 0x88,
};
const FBIN_32: Record<string, number> = {
  fadd: 0x92,
  fsub: 0x93,
  fmul: 0x94,
  fdiv: 0x95,
  fmin: 0x96,
  fmax: 0x97,
  fcopysign: 0x98,
};
const FBIN_64: Record<string, number> = {
  fadd: 0xa0,
  fsub: 0xa1,
  fmul: 0xa2,
  fdiv: 0xa3,
  fmin: 0xa4,
  fmax: 0xa5,
  fcopysign: 0xa6,
};
const FUN_32: Record<string, number> = {
  fabs: 0x8b,
  fneg: 0x8c,
  fceil: 0x8d,
  ffloor: 0x8e,
  ftrunc: 0x8f,
  fnearest: 0x90,
  fsqrt: 0x91,
};
const FUN_64: Record<string, number> = {
  fabs: 0x99,
  fneg: 0x9a,
  fceil: 0x9b,
  ffloor: 0x9c,
  ftrunc: 0x9d,
  fnearest: 0x9e,
  fsqrt: 0x9f,
};

interface Label {
  kind: "block" | "loop" | "if";
  target: number; // a block position; -1 for an if
}

class FuncEmitter {
  w = new ByteWriter();
  f: Func;
  info: ModuleInfo;
  cfg: Cfg;
  index = new Map<number, number>();
  localOf: number[] = [];
  localTypes: WasmType[] = [];
  nParams: number;
  labels: Label[] = [];
  loopHeaders = new Set<number>();
  merges = new Set<number>();
  domChildren = new Map<number, number[]>();
  scratch = new Map<WasmType, number>();
  savedSp = -1; // the local holding the caller's shadow stack pointer, if this function uses alloca

  constructor(f: Func, info: ModuleInfo) {
    this.f = f;
    this.info = info;
    this.cfg = buildCfg(f);
    f.blocks.forEach((b, i) => this.index.set(b.id, i));
    this.nParams = f.params.length;
    f.params.forEach((p, i) => {
      this.localOf[p] = i;
    });
    let next = this.nParams;
    f.types.forEach((t, v) => {
      if (this.localOf[v] === undefined) {
        this.localOf[v] = next++;
        this.localTypes.push(wasmType(t));
      }
    });
    if (f.blocks.some((b) => b.instrs.some((i) => i.op === "alloca"))) {
      this.savedSp = next;
      this.localTypes.push("i32");
    }
    this.analyse();
  }

  analyse(): void {
    const { rpo, rpoIndex, preds, idom } = this.cfg;
    for (const at of rpo) {
      let forward = 0;
      for (const p of preds[at]!) {
        if (rpoIndex.get(p)! >= rpoIndex.get(at)!) {
          this.loopHeaders.add(at);
          if (!this.dominates(at, p)) throw new Error(`@${this.f.name}: irreducible control flow`);
        } else forward++;
      }
      if (forward >= 2) this.merges.add(at);
      if (at !== rpo[0]) {
        const up = idom.get(at)!;
        const list = this.domChildren.get(up) ?? [];
        list.push(at);
        this.domChildren.set(up, list);
      }
    }
  }

  dominates(a: number, b: number): boolean {
    let cur = b;
    for (let guard = 0; guard <= this.f.blocks.length; guard++) {
      if (cur === a) return true;
      const up = this.cfg.idom.get(cur);
      if (up === undefined || up === cur) return false;
      cur = up;
    }
    return false;
  }

  scratchLocal(t: WasmType): number {
    let n = this.scratch.get(t);
    if (n === undefined) {
      n = this.nParams + this.localTypes.length;
      this.localTypes.push(t);
      this.scratch.set(t, n);
    }
    return n;
  }

  get(v: number): void {
    this.w.byte(0x20);
    this.w.u32(this.localOf[v]!);
  }
  set(v: number): void {
    this.w.byte(0x21);
    this.w.u32(this.localOf[v]!);
  }
  getLocal(n: number): void {
    this.w.byte(0x20);
    this.w.u32(n);
  }
  setLocal(n: number): void {
    this.w.byte(0x21);
    this.w.u32(n);
  }
  i32const(v: bigint): void {
    this.w.byte(0x41);
    this.w.sleb(v, 32);
  }
  i64const(v: bigint): void {
    this.w.byte(0x42);
    this.w.sleb(v, 64);
  }

  emitBody(): number[] {
    if (this.savedSp >= 0) {
      this.w.byte(0x23);
      this.w.u32(GLOBAL_SP);
      this.setLocal(this.savedSp);
    }
    this.doTree(0);
    this.w.byte(0x00); // every path has already left; this satisfies the validator
    this.w.byte(0x0b);
    const out = new ByteWriter();
    // Local declarations, run-length encoded.
    const runs: [number, WasmType][] = [];
    for (const t of this.localTypes) {
      const last = runs[runs.length - 1];
      if (last !== undefined && last[1] === t) last[0]++;
      else runs.push([1, t]);
    }
    out.u32(runs.length);
    for (const [n, t] of runs) {
      out.u32(n);
      out.byte(VALTYPE[t]);
    }
    out.append(this.w.bytes);
    return out.bytes;
  }

  doTree(x: number): void {
    const isLoop = this.loopHeaders.has(x);
    if (isLoop) {
      this.w.byte(0x03);
      this.w.byte(0x40);
      this.labels.push({ kind: "loop", target: x });
    }
    const rpoIndex = this.cfg.rpoIndex;
    const children = (this.domChildren.get(x) ?? []).filter((c) => this.merges.has(c));
    children.sort((a, b) => rpoIndex.get(b)! - rpoIndex.get(a)!);
    this.nodeWithin(x, children, 0);
    if (isLoop) {
      this.labels.pop();
      this.w.byte(0x0b);
    }
  }

  nodeWithin(x: number, ys: number[], i: number): void {
    if (i === ys.length) {
      this.emitBlock(x);
      return;
    }
    const y = ys[i]!;
    this.w.byte(0x02);
    this.w.byte(0x40);
    this.labels.push({ kind: "block", target: y });
    this.nodeWithin(x, ys, i + 1);
    this.labels.pop();
    this.w.byte(0x0b);
    this.doTree(y);
  }

  branchTo(kind: "block" | "loop", target: number): void {
    for (let i = this.labels.length - 1; i >= 0; i--) {
      const l = this.labels[i]!;
      if (l.kind === kind && l.target === target) {
        this.w.byte(0x0c);
        this.w.u32(this.labels.length - 1 - i);
        return;
      }
    }
    throw new Error(`@${this.f.name}: no enclosing ${kind} for bb${target}`);
  }

  doBranch(src: number, e: Edge): void {
    const dst = this.index.get(e.block)!;
    const target = this.f.blocks[dst]!;
    // The operand stack makes this a parallel copy, so swapped block parameters are safe.
    for (const a of e.args) this.get(a);
    for (let i = target.params.length - 1; i >= 0; i--) this.set(target.params[i]!);
    const rpoIndex = this.cfg.rpoIndex;
    if (rpoIndex.get(dst)! <= rpoIndex.get(src)!) this.branchTo("loop", dst);
    else if (this.merges.has(dst)) this.branchTo("block", dst);
    else this.doTree(dst);
  }

  emitBlock(at: number): void {
    const b = this.f.blocks[at]!;
    for (const ins of b.instrs) this.emitInstr(ins);
    const t = b.term;
    switch (t.k) {
      case "br":
        this.doBranch(at, t.to);
        break;
      case "brif":
        this.get(t.cond);
        this.w.byte(0x04);
        this.w.byte(0x40);
        this.labels.push({ kind: "if", target: -1 });
        this.doBranch(at, t.t);
        this.w.byte(0x05);
        this.doBranch(at, t.f);
        this.labels.pop();
        this.w.byte(0x0b);
        break;
      case "switch": {
        const is64 = this.f.types[t.val] === "i64";
        for (const c of t.cases) {
          this.get(t.val);
          if (is64) {
            this.i64const(c.key);
            this.w.byte(0x51);
          } else {
            this.i32const(c.key);
            this.w.byte(0x46);
          }
          this.w.byte(0x04);
          this.w.byte(0x40);
          this.labels.push({ kind: "if", target: -1 });
          this.doBranch(at, c.to);
          this.labels.pop();
          this.w.byte(0x0b);
        }
        this.doBranch(at, t.def);
        break;
      }
      case "ret":
        if (this.savedSp >= 0) {
          this.getLocal(this.savedSp);
          this.w.byte(0x24);
          this.w.u32(GLOBAL_SP);
        }
        for (const v of t.vals) this.get(v);
        this.w.byte(0x0f);
        break;
      case "trap":
        this.trapBody(t.id);
        break;
      case "unreachable":
        this.w.byte(0x00);
        break;
    }
  }

  trapBody(id: number): void {
    const code = this.info.trapCode.get(id);
    if (code === undefined) throw new Error(`unknown trap t${id}`);
    this.i32const(BigInt(code));
    this.w.byte(0x10);
    this.w.u32(IMPORT_TRAP);
    this.w.byte(0x00);
  }

  /** Consumes an i32 condition: if it holds, trap. */
  trapIf(id: number): void {
    this.w.byte(0x04);
    this.w.byte(0x40);
    this.trapBody(id);
    this.w.byte(0x0b);
  }

  emitInstr(ins: Instr): void {
    const vals: number[] = [];
    for (const o of ins.ops) if (o.t === "v") vals.push(o.id);
    const res = ins.res[0];
    const p = ins.op.split(".");
    const base = p[0]!;
    const last = p[p.length - 1]! as TirType;
    const w = this.w;
    const types = this.f.types;

    switch (base) {
      case "iconst": {
        const v = imm(ins.ops, 0);
        if (last === "i64") this.i64const(v);
        else this.i32const(v);
        this.set(res!);
        return;
      }
      case "fconst": {
        const v = imm(ins.ops, 0);
        if (last === "f32") {
          w.byte(0x43);
          w.bitsLE(v, 4);
        } else {
          w.byte(0x44);
          w.bitsLE(v, 8);
        }
        this.set(res!);
        return;
      }
      case "globaladdr":
      case "funcaddr": {
        const s = ins.ops[0];
        if (s?.t !== "sym") throw new Error("bad symbol operand");
        const addr =
          base === "globaladdr"
            ? this.info.globalAddr.get(s.name)
            : this.info.tableIndex.get(s.name);
        if (addr === undefined) throw new Error(`unknown symbol @${s.name}`);
        this.i32const(BigInt(addr));
        this.set(res!);
        return;
      }
      case "add":
      case "sub":
      case "mul":
        if (p[1] === "chk") {
          this.checkedArith(base, p[2]!, last, vals, ins, res!);
          return;
        }
        this.simpleBin(base, last, vals, res!);
        return;
      case "and":
      case "or":
      case "xor":
        this.simpleBin(base, last, vals, res!);
        return;
      case "shl":
      case "lshr":
      case "ashr":
        if (p[1] === "js32") {
          this.simpleBin(base, "i32", vals, res!);
        } else if (p[1] === "big") {
          this.bigShift(base, vals, res!);
        } else this.simpleBin(base, last, vals, res!);
        return;
      case "neg":
        if (last === "i64") this.i64const(0n);
        else this.i32const(0n);
        this.get(vals[0]!);
        w.byte(last === "i64" ? 0x7d : 0x6b);
        this.set(res!);
        return;
      case "not":
        this.get(vals[0]!);
        if (last === "i64") {
          this.i64const(-1n);
          w.byte(0x85);
        } else {
          this.i32const(-1n);
          w.byte(0x73);
        }
        this.set(res!);
        return;
      case "sdiv":
      case "udiv":
      case "srem":
      case "urem":
        this.division(base, last, vals, ins, res!);
        return;
      case "range":
        this.rangeCheck(p[2]!, last, vals[0]!, ins, res!);
        return;
      case "fadd":
      case "fsub":
      case "fmul":
      case "fdiv":
      case "fcopysign": {
        this.get(vals[0]!);
        this.get(vals[1]!);
        w.byte((last === "f32" ? FBIN_32 : FBIN_64)[base]!);
        this.set(res!);
        return;
      }
      case "frem": {
        // Wasm has no fmod, and x - trunc(x / y) * y is inexact. The helper is exact for all inputs.
        this.get(vals[0]!);
        this.get(vals[1]!);
        w.byte(0x10);
        w.u32(this.info.funcIndex.get(FREM_HELPER_NAME)!);
        this.set(res!);
        return;
      }
      case "bitcast": {
        const from = types[vals[0]!]!;
        this.get(vals[0]!);
        if (from === "f64" && last === "i64") w.byte(0xbd);
        else if (from === "i64" && last === "f64") w.byte(0xbf);
        else if (from === "f32" && last === "i32") w.byte(0xbc);
        else if (from === "i32" && last === "f32") w.byte(0xbe);
        // R12: a native TSL reference is an i64 (its pointer in the low 48 bits, a generation above, lower-native.ts), and
        // a pointer is 32 bits in Wasm's memory, so the pointer is the reference's low half and the reference the pointer
        // widened: what class printing in `strict` needs, whose builds are Wasm too.
        else if (from === "i64" && last === "ptr") {
          // the injected `wasm-ref-shifted` bug (R12): the pointer taken from the wrong bits
          if (process.env.TMK_TEST_TSL === "wasm-ref-shifted") {
            this.i64const(16n);
            w.byte(0x88); // i64.shr_u
          }
          w.byte(0xa7);
        } else if (from === "ptr" && last === "i64") w.byte(0xad);
        else if (wasmType(from) !== wasmType(last)) {
          throw new Error(`bitcast from ${from} to ${last}`);
        }
        this.set(res!);
        return;
      }
      case "alloca": {
        const size = imm(ins.ops, 0);
        const align = imm(ins.ops, 1);
        w.byte(0x23);
        w.u32(GLOBAL_SP);
        this.i32const(BigInt(this.info.stackBase) + size + align);
        w.byte(0x49); // i32.lt_u
        this.trapCode(TRAP_MEMORY, 0x04);
        w.byte(0x23);
        w.u32(GLOBAL_SP);
        this.i32const(size);
        w.byte(0x6b);
        this.i32const(-align);
        w.byte(0x71);
        this.set(res!);
        this.get(res!);
        w.byte(0x24);
        w.u32(GLOBAL_SP);
        return;
      }
      case "fmin":
      case "fmax": {
        this.get(vals[0]!);
        this.get(vals[1]!);
        w.byte((last === "f32" ? FBIN_32 : FBIN_64)[base]!);
        this.set(res!);
        return;
      }
      case "fneg":
      case "fabs":
      case "fsqrt":
      case "ffloor":
      case "fceil":
      case "ftrunc":
      case "fnearest": {
        this.get(vals[0]!);
        w.byte((last === "f32" ? FUN_32 : FUN_64)[base]!);
        this.set(res!);
        return;
      }
      case "icmp": {
        this.get(vals[0]!);
        this.get(vals[1]!);
        w.byte((last === "i64" ? ICMP_64 : ICMP_32)[p[1]!]!);
        this.set(res!);
        return;
      }
      case "fcmp": {
        this.get(vals[0]!);
        this.get(vals[1]!);
        w.byte((last === "f32" ? FCMP_32 : FCMP_64)[p[1]!]!);
        this.set(res!);
        return;
      }
      case "zext":
      case "sext":
      case "trunc":
        this.intConvert(base, types[vals[0]!]!, last, vals[0]!, res!);
        return;
      case "fpromote":
        this.get(vals[0]!);
        w.byte(0xbb);
        this.set(res!);
        return;
      case "fdemote":
        this.get(vals[0]!);
        w.byte(0xb6);
        this.set(res!);
        return;
      case "sitofp":
      case "uitofp": {
        const from = wasmType(types[vals[0]!]!);
        const signed = base === "sitofp";
        const tbl =
          last === "f32"
            ? from === "i64"
              ? signed
                ? 0xb4
                : 0xb5
              : signed
                ? 0xb2
                : 0xb3
            : from === "i64"
              ? signed
                ? 0xb9
                : 0xba
              : signed
                ? 0xb7
                : 0xb8;
        this.get(vals[0]!);
        w.byte(tbl);
        this.set(res!);
        return;
      }
      case "fptosi":
      case "fptoui": {
        const from = types[vals[0]!]!;
        const to64 = wasmType(last) === "i64";
        const signedIdx = base === "fptosi" ? 0 : 1;
        const sub = (to64 ? 4 : 0) + (from === "f64" ? 2 : 0) + signedIdx;
        this.get(vals[0]!);
        w.byte(0xfc);
        w.u32(sub);
        this.set(res!);
        return;
      }
      case "js": {
        // Saturating truncation is already ToInt32 unless it saturated, and NaN gives 0 as ToInt32
        // does. Only a result at either limit needs the exact path from the bits.
        this.info.usesToInt32.used = true;
        this.get(vals[0]!);
        w.byte(0xfc);
        w.u32(2); // i32.trunc_sat_f64_s
        this.set(res!);
        this.get(res!);
        this.i32const(2147483647n);
        w.byte(0x46);
        this.get(res!);
        this.i32const(-2147483648n);
        w.byte(0x46);
        w.byte(0x72);
        w.byte(0x04);
        w.byte(0x40);
        this.get(vals[0]!);
        w.byte(0x10);
        w.u32(this.info.toInt32Index);
        this.set(res!);
        w.byte(0x0b);
        return;
      }
      case "select":
        this.get(vals[1]!);
        this.get(vals[2]!);
        this.get(vals[0]!);
        w.byte(0x1b);
        this.set(res!);
        return;
      case "load":
        this.get(vals[0]!);
        this.memOp(p[1]! as TirType, false);
        this.set(res!);
        return;
      case "store":
        this.get(vals[0]!);
        this.get(vals[1]!);
        this.memOp(p[1]! as TirType, true);
        return;
      case "ref":
        // R12: a reference's pointer, the low 48 bits (SPEC 3.5), which in Wasm's 32-bit memory are its low half.
        this.get(vals[0]!);
        // the injected `wasm-ref-shifted` bug (R12): the pointer taken from the wrong bits
        if (process.env.TMK_TEST_TSL === "wasm-ref-shifted") {
          this.i64const(16n);
          w.byte(0x88); // i64.shr_u
        }
        w.byte(0xa7); // i32.wrap_i64
        this.set(res!);
        return;
      case "gen": {
        // R12: gen.chk as the native backend does it: a live generation is odd, and the word before the object has to
        // match the reference's 16 generation bits; then the pointer.
        const trap = trapOperand(ins.ops);
        this.get(vals[0]!);
        this.i64const(48n);
        w.byte(0x88); // i64.shr_u
        this.i64const(1n);
        w.byte(0x83); // i64.and
        w.byte(0x50); // i64.eqz
        this.trapIf(trap);
        this.get(vals[0]!);
        w.byte(0xa7); // i32.wrap_i64
        this.i32const(8n);
        w.byte(0x6b); // i32.sub
        this.memOp("i32", false);
        w.byte(0xad); // i64.extend_i32_u
        this.get(vals[0]!);
        this.i64const(48n);
        w.byte(0x88); // i64.shr_u
        w.byte(0x85); // i64.xor
        this.i64const(0xffffn);
        w.byte(0x83); // i64.and
        this.i64const(0n);
        w.byte(0x52); // i64.ne
        this.trapIf(trap);
        this.get(vals[0]!);
        w.byte(0xa7); // i32.wrap_i64
        this.set(res!);
        return;
      }
      case "bounds":
        this.get(vals[0]!);
        this.get(vals[1]!);
        w.byte(0x4f); // i32.ge_u
        this.trapIf(trapOperand(ins.ops));
        this.get(vals[0]!);
        this.set(res!);
        return;
      case "gep": {
        const scale = imm(ins.ops, 0);
        const offset = imm(ins.ops, 1);
        this.get(vals[0]!);
        this.get(vals[1]!);
        if (scale !== 1n) {
          this.i32const(scale);
          w.byte(0x6c);
        }
        w.byte(0x6a);
        if (offset !== 0n) {
          this.i32const(offset);
          w.byte(0x6a);
        }
        this.set(res!);
        return;
      }
      case "call": {
        if (ins.op === "call") {
          const s = ins.ops[0];
          if (s?.t !== "sym") throw new Error("bad call");
          for (const v of vals) this.get(v);
          w.byte(0x10);
          w.u32(this.info.funcIndex.get(s.name)!);
        } else {
          const s = ins.ops[0];
          if (s?.t !== "sig") throw new Error("bad indirect call");
          const sig = this.info.m.sigs[s.id]!;
          for (const v of vals.slice(1)) this.get(v);
          this.get(vals[0]!);
          w.byte(0x11);
          w.u32(this.info.typeIndex(sig.params.map(wasmType), sig.rets.map(wasmType)));
          w.u32(0);
        }
        for (let i = ins.res.length - 1; i >= 0; i--) this.set(ins.res[i]!);
        return;
      }
      case "intrinsic": {
        const n = ins.ops[0];
        if (n?.t !== "name") throw new Error("bad intrinsic");
        if (n.name === "clz32") {
          this.get(vals[0]!);
          w.byte(0x67);
          this.set(res!);
        } else if (n.name === "trap.code") {
          this.get(vals[0]!);
          w.byte(0x10);
          w.u32(IMPORT_TRAP);
          w.byte(0x00);
        } else if (n.name === "mem.base") {
          w.byte(0x23);
          w.u32(GLOBAL_HEAP_BASE);
          this.set(res!);
        } else if (n.name === "mem.ensure") {
          this.memEnsure(vals[0]!);
        } else if (n.name === "mem.fill") {
          for (const v of vals) this.get(v);
          w.byte(0xfc);
          w.u32(11);
          w.byte(0x00);
        } else if (n.name === "mem.copy") {
          for (const v of vals) this.get(v);
          w.byte(0xfc);
          w.u32(10);
          w.byte(0x00);
          w.byte(0x00);
        } else if (n.name.startsWith("math.")) {
          for (const v of vals) this.get(v);
          w.byte(0x10);
          w.u32(this.info.mathImport.get(n.name)!);
          this.set(res!);
        } else throw new Error(`no wasm lowering for intrinsic ${n.name}`);
        return;
      }
      default:
        throw new Error(`no wasm lowering for ${ins.op}`);
    }
  }

  /** Consumes an i32 condition: if it holds, trap with this code. */
  trapCode(code: bigint, ifByte: number): void {
    this.w.byte(ifByte);
    this.w.byte(0x40);
    this.i32const(code);
    this.w.byte(0x10);
    this.w.u32(IMPORT_TRAP);
    this.w.byte(0x00);
    this.w.byte(0x0b);
  }

  memEnsure(top: number): void {
    const w = this.w;
    this.get(top);
    w.byte(0x3f);
    w.byte(0x00); // memory.size
    this.i32const(16n);
    w.byte(0x74);
    w.byte(0x4b); // i32.gt_u
    w.byte(0x04);
    w.byte(0x40);
    this.get(top);
    this.i32const(65535n);
    w.byte(0x6a);
    this.i32const(16n);
    w.byte(0x76);
    w.byte(0x3f);
    w.byte(0x00);
    w.byte(0x6b);
    w.byte(0x40);
    w.byte(0x00); // memory.grow
    this.i32const(-1n);
    w.byte(0x46);
    this.trapCode(TRAP_MEMORY, 0x04);
    w.byte(0x0b);
  }

  simpleBin(base: string, t: TirType, vals: number[], res: number): void {
    this.get(vals[0]!);
    this.get(vals[1]!);
    this.w.byte((t === "i64" ? IBIN_64 : IBIN_32)[base]!);
    this.set(res);
  }

  /** Bigint shifts: a count of 64 or more is defined, unlike the hardware's modulo count. */
  bigShift(base: string, vals: number[], res: number): void {
    const w = this.w;
    const count = vals[1]!;
    this.get(count);
    this.i64const(64n);
    w.byte(0x54); // i64.lt_u
    w.byte(0x04);
    w.byte(VALTYPE.i64);
    this.get(vals[0]!);
    this.get(count);
    w.byte(IBIN_64[base]!);
    w.byte(0x05);
    if (base === "ashr") {
      this.get(vals[0]!);
      this.i64const(63n);
      w.byte(IBIN_64.ashr!);
    } else this.i64const(0n);
    w.byte(0x0b);
    this.set(res);
  }

  checkedArith(
    base: string,
    sign: string,
    t: TirType,
    vals: number[],
    ins: Instr,
    res: number,
  ): void {
    const a = vals[0]!;
    const b = vals[1]!;
    const trap = trapOperand(ins.ops);
    const w = this.w;
    if (t !== "i64") {
      if (base === "sub" && sign === "u") {
        this.get(a);
        this.get(b);
        w.byte(0x49); // i32.lt_u
        this.trapIf(trap);
        this.get(a);
        this.get(b);
        w.byte(0x6b);
        this.set(res);
        return;
      }
      // Compute in 64 bits, where a 32-bit add, sub or mul can't overflow.
      const tmp = this.scratchLocal("i64");
      const ext = sign === "u" ? 0xad : 0xac;
      this.get(a);
      w.byte(ext);
      this.get(b);
      w.byte(ext);
      w.byte(IBIN_64[base]!);
      this.setLocal(tmp);
      this.getLocal(tmp);
      if (sign === "u") {
        this.i64const(32n);
        w.byte(0x88); // i64.shr_u
        w.byte(0x50); // i64.eqz
        w.byte(0x45); // i32.eqz
      } else {
        this.getLocal(tmp);
        w.byte(0xa7);
        w.byte(0xac);
        w.byte(0x52); // i64.ne
      }
      this.trapIf(trap);
      this.getLocal(tmp);
      w.byte(0xa7);
      this.set(res);
      return;
    }
    const r = this.scratchLocal("i64");
    if (base === "add" || base === "sub") {
      this.get(a);
      this.get(b);
      w.byte(IBIN_64[base]!);
      this.setLocal(r);
      if (sign === "u") {
        if (base === "add") {
          this.getLocal(r);
          this.get(a);
        } else {
          this.get(a);
          this.get(b);
        }
        w.byte(0x54); // i64.lt_u
      } else if (base === "add") {
        // Overflow iff both operands differ in sign from the result.
        this.get(a);
        this.getLocal(r);
        w.byte(0x85);
        this.get(b);
        this.getLocal(r);
        w.byte(0x85);
        w.byte(0x83);
        this.i64const(0n);
        w.byte(0x53);
      } else {
        this.get(a);
        this.get(b);
        w.byte(0x85);
        this.get(a);
        this.getLocal(r);
        w.byte(0x85);
        w.byte(0x83);
        this.i64const(0n);
        w.byte(0x53);
      }
      this.trapIf(trap);
      this.getLocal(r);
      this.set(res);
      return;
    }
    // 64-bit mul: divide back. a = 0 can't overflow.
    this.get(a);
    this.get(b);
    w.byte(0x7e);
    this.setLocal(r);
    if (sign === "s") {
      // a = -1, b = MIN overflows, and dividing back would itself trap in Wasm.
      this.get(a);
      this.i64const(-1n);
      w.byte(0x51);
      this.get(b);
      this.i64const(-9223372036854775808n);
      w.byte(0x51);
      w.byte(0x71);
      this.trapIf(trap);
    }
    this.get(a);
    w.byte(0x50);
    w.byte(0x45); // a != 0
    w.byte(0x04);
    w.byte(0x40);
    this.getLocal(r);
    this.get(a);
    w.byte(sign === "s" ? 0x7f : 0x80);
    this.get(b);
    w.byte(0x52);
    this.trapIf(trap);
    w.byte(0x0b);
    this.getLocal(r);
    this.set(res);
  }

  division(base: string, t: TirType, vals: number[], ins: Instr, res: number): void {
    const a = vals[0]!;
    const b = vals[1]!;
    const trap = trapOperand(ins.ops);
    const w = this.w;
    const is64 = t === "i64";
    this.get(b);
    w.byte(is64 ? 0x50 : 0x45);
    this.trapIf(trap);
    if (base === "sdiv") {
      const min = is64 ? -9223372036854775808n : -2147483648n;
      this.get(a);
      if (is64) this.i64const(min);
      else this.i32const(min);
      w.byte(is64 ? 0x51 : 0x46);
      this.get(b);
      if (is64) this.i64const(-1n);
      else this.i32const(-1n);
      w.byte(is64 ? 0x51 : 0x46);
      w.byte(0x71);
      this.trapIf(trap);
    }
    this.get(a);
    this.get(b);
    const ops32: Record<string, number> = { sdiv: 0x6d, udiv: 0x6e, srem: 0x6f, urem: 0x70 };
    const ops64: Record<string, number> = { sdiv: 0x7f, udiv: 0x80, srem: 0x81, urem: 0x82 };
    w.byte((is64 ? ops64 : ops32)[base]!);
    this.set(res);
  }

  rangeCheck(sign: string, t: TirType, v: number, ins: Instr, res: number): void {
    const trap = trapOperand(ins.ops);
    const nums = ins.ops.filter((o) => o.t === "i" || o.t === "ixmax");
    const lo = operandInt(nums[0]!);
    const hi = operandInt(nums[1]!);
    const w = this.w;
    const is64 = t === "i64";
    const put = (x: bigint): void => {
      if (is64) this.i64const(x);
      else this.i32const(x);
    };
    const skipHi = !is64 && sign === "u" && hi >= IXMAX_WASM32;
    const skipLo = sign === "u" && lo === 0n;
    if (!skipLo) {
      this.get(v);
      put(lo);
      if (is64) w.byte(sign === "s" ? 0x53 : 0x54);
      else w.byte(sign === "s" ? 0x48 : 0x49);
      this.trapIf(trap);
    }
    if (!skipHi) {
      this.get(v);
      put(hi);
      if (is64) w.byte(sign === "s" ? 0x55 : 0x56);
      else w.byte(sign === "s" ? 0x4a : 0x4b);
      this.trapIf(trap);
    }
    this.get(v);
    this.set(res);
  }

  /** Values narrower than 32 bits sit zero-extended in an i32, exactly as load8_u leaves them. */
  intConvert(kind: string, from: TirType, to: TirType, v: number, res: number): void {
    const w = this.w;
    this.get(v);
    if (kind === "trunc") {
      if (wasmType(from) === "i64" && wasmType(to) !== "i64") w.byte(0xa7);
      if (to === "i8") {
        this.i32const(0xffn);
        w.byte(0x71);
      } else if (to === "i16") {
        this.i32const(0xffffn);
        w.byte(0x71);
      }
    } else if (kind === "zext") {
      if (wasmType(to) === "i64" && wasmType(from) !== "i64") w.byte(0xad);
    } else {
      if (from === "i8") w.byte(0xc0);
      else if (from === "i16") w.byte(0xc1);
      if (wasmType(to) === "i64" && wasmType(from) !== "i64") w.byte(0xac);
    }
    this.set(res);
  }

  memOp(t: TirType, store: boolean): void {
    const w = this.w;
    const code: Record<TirType, [number, number, number]> = {
      // load opcode, store opcode, log2 alignment
      i8: [0x2d, 0x3a, 0],
      i16: [0x2f, 0x3b, 1],
      i32: [0x28, 0x36, 2],
      ix: [0x28, 0x36, 2],
      ptr: [0x28, 0x36, 2],
      i64: [0x29, 0x37, 3],
      f32: [0x2a, 0x38, 2],
      f64: [0x2b, 0x39, 3],
    };
    const c = code[t];
    w.byte(store ? c[1] : c[0]);
    w.u32(c[2]);
    w.u32(0);
  }
}

function imm(ops: Operand[], n: number): bigint {
  let seen = 0;
  for (const o of ops) {
    if (o.t === "i") {
      if (seen === n) return o.val;
      seen++;
    }
  }
  throw new Error("missing immediate");
}

function operandInt(o: Operand): bigint {
  if (o.t === "i") return o.val;
  if (o.t === "ixmax") return IXMAX_WASM32;
  throw new Error("expected an integer immediate");
}

function trapOperand(ops: Operand[]): number {
  for (const o of ops) if (o.t === "trap") return o.id;
  throw new Error("missing trap operand");
}

/** js.toint32 as a helper function: ToInt32 from the bits, exact for all inputs, no fast path. */
function toInt32Body(): number[] {
  const w = new ByteWriter();
  const lget = (n: number): void => {
    w.byte(0x20);
    w.u32(n);
  };
  const lset = (n: number): void => {
    w.byte(0x21);
    w.u32(n);
  };
  const i32c = (n: bigint): void => {
    w.byte(0x41);
    w.sleb(n, 32);
  };
  const i64c = (n: bigint): void => {
    w.byte(0x42);
    w.sleb(n, 64);
  };
  // locals: 0 = x (param), 1 = bits (i64), 2 = exponent (i32), 3 = mantissa (i64)
  w.u32(3);
  w.u32(1);
  w.byte(VALTYPE.i64);
  w.u32(1);
  w.byte(VALTYPE.i32);
  w.u32(1);
  w.byte(VALTYPE.i64);
  lget(0);
  w.byte(0xbd);
  lset(1);
  lget(1);
  i64c(52n);
  w.byte(0x88);
  w.byte(0xa7);
  i32c(0x7ffn);
  w.byte(0x71);
  i32c(1023n);
  w.byte(0x6b);
  lset(2);
  // |x| < 1, or every bit at or above 2^32 (includes infinities and NaN): the result is 0.
  lget(2);
  i32c(0n);
  w.byte(0x48);
  lget(2);
  i32c(83n);
  w.byte(0x4a);
  w.byte(0x72);
  w.byte(0x04);
  w.byte(0x40);
  i32c(0n);
  w.byte(0x0f);
  w.byte(0x0b);
  lget(1);
  i64c((1n << 52n) - 1n);
  w.byte(0x83);
  i64c(1n << 52n);
  w.byte(0x84);
  lset(3);
  lget(2);
  i32c(52n);
  w.byte(0x4e);
  w.byte(0x04);
  w.byte(VALTYPE.i64);
  lget(3);
  lget(2);
  i32c(52n);
  w.byte(0x6b);
  w.byte(0xad);
  w.byte(0x86);
  w.byte(0x05);
  lget(3);
  i32c(52n);
  lget(2);
  w.byte(0x6b);
  w.byte(0xad);
  w.byte(0x88);
  w.byte(0x0b);
  lset(3);
  lget(1);
  i64c(0n);
  w.byte(0x53);
  w.byte(0x04);
  w.byte(VALTYPE.i32);
  i32c(0n);
  lget(3);
  w.byte(0xa7);
  w.byte(0x6b);
  w.byte(0x05);
  lget(3);
  w.byte(0xa7);
  w.byte(0x0b);
  w.byte(0x0b);
  return w.bytes;
}

export interface WasmOutput {
  bytes: Uint8Array;
  heapBase: number;
}

/** Emits a Wasm binary. `m` must be canonical; the output depends only on its contents. */
export function emitWasm(m0: Module): WasmOutput {
  const usesFrem = m0.funcs.some((f) =>
    f.blocks.some((b) => b.instrs.some((i) => i.op.startsWith("frem."))),
  );
  const m: Module = usesFrem ? { ...m0, funcs: [...m0.funcs, FREM_HELPER()] } : m0;
  const usesStack = m.funcs.some((f) =>
    f.blocks.some((b) => b.instrs.some((i) => i.op === "alloca")),
  );
  const mathNames = new Set<string>();
  for (const f of m.funcs) {
    for (const b of f.blocks) {
      for (const i of b.instrs) {
        const n = i.op === "intrinsic" ? i.ops[0] : undefined;
        if (n?.t === "name" && n.name.startsWith("math.")) mathNames.add(n.name);
      }
    }
  }
  const mathList = [...mathNames].sort();
  // Types are interned in order of first use, and that order is deterministic.
  const types: { p: WasmType[]; r: WasmType[] }[] = [];
  const typeKeys = new Map<string, number>();
  const typeIndex = (params: WasmType[], rets: WasmType[]): number => {
    const key = `${params.join(",")}>${rets.join(",")}`;
    let n = typeKeys.get(key);
    if (n === undefined) {
      n = types.length;
      typeKeys.set(key, n);
      types.push({ p: params, r: rets });
    }
    return n;
  };

  const trapType = typeIndex(["i32"], []);
  const mathImport = new Map<string, number>();
  mathList.forEach((n, i) => mathImport.set(n, i + 1));
  const funcIndex = new Map<string, number>();
  m.externs.forEach((e, i) => funcIndex.set(e.name, 1 + mathList.length + i));
  const nImports = 1 + mathList.length + m.externs.length;
  m.funcs.forEach((f, i) => funcIndex.set(f.name, i + nImports));
  const toInt32Index = m.funcs.length + nImports;

  const tableIndex = new Map<string, number>();
  for (const f of m.funcs) {
    for (const b of f.blocks) {
      for (const ins of b.instrs) {
        if (ins.op === "funcaddr" && ins.ops[0]?.t === "sym") {
          // Entry 0 stays null, so a zero function reference is never callable.
          if (!tableIndex.has(ins.ops[0].name))
            tableIndex.set(ins.ops[0].name, tableIndex.size + 1);
        }
      }
    }
  }

  const globalAddr = new Map<string, number>();
  let addr = DATA_START;
  for (const g of m.globals) {
    addr = Math.ceil(addr / g.align) * g.align;
    globalAddr.set(g.name, addr);
    addr += g.size;
  }
  const stackBase = Math.ceil(addr / 16) * 16;
  const heapBase = usesStack ? stackBase + STACK_BYTES : stackBase;

  const trapCode = new Map<number, number>();
  for (const t of m.traps) trapCode.set(t.id, t.code);

  const info: ModuleInfo = {
    funcIndex,
    tableIndex,
    globalAddr,
    trapCode,
    m,
    typeIndex,
    toInt32Index,
    usesToInt32: { used: false },
    mathImport,
    stackBase,
    usesStack,
  };

  const funcTypes: number[] = [];
  const bodies: number[][] = [];
  for (const f of m.funcs) {
    const params = f.params.map((p) => wasmType(f.types[p]!));
    funcTypes.push(typeIndex(params, f.rets.map(wasmType)));
    bodies.push(new FuncEmitter(f, info).emitBody());
  }
  if (info.usesToInt32.used) {
    funcTypes.push(typeIndex(["f64"], ["i32"]));
    bodies.push(toInt32Body());
  }

  const out = new ByteWriter();
  out.append([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

  const importSec = new ByteWriter();
  importSec.u32(nImports);
  importSec.name("env");
  importSec.name("__tsl_trap");
  importSec.byte(0x00);
  importSec.u32(trapType);
  for (const n of mathList) {
    const sig = INTRINSICS[n]!;
    importSec.name("math");
    importSec.name(n.slice(5));
    importSec.byte(0x00);
    importSec.u32(typeIndex(sig.params.map(wasmType), sig.rets.map(wasmType)));
  }
  for (const e of m.externs) {
    importSec.name("js");
    importSec.name(e.name);
    importSec.byte(0x00);
    importSec.u32(typeIndex(e.params.map(wasmType), e.rets.map(wasmType)));
  }
  const typeSec = new ByteWriter();
  typeSec.u32(types.length);
  for (const t of types) {
    typeSec.byte(0x60);
    typeSec.u32(t.p.length);
    for (const x of t.p) typeSec.byte(VALTYPE[x]);
    typeSec.u32(t.r.length);
    for (const x of t.r) typeSec.byte(VALTYPE[x]);
  }
  section(out, 1, typeSec);
  section(out, 2, importSec);

  const funcSec = new ByteWriter();
  funcSec.u32(funcTypes.length);
  for (const t of funcTypes) funcSec.u32(t);
  section(out, 3, funcSec);

  if (tableIndex.size > 0) {
    const tableSec = new ByteWriter();
    tableSec.u32(1);
    tableSec.byte(VALTYPE.funcref);
    tableSec.byte(0x00);
    tableSec.u32(tableIndex.size + 1);
    section(out, 4, tableSec);
  }

  const memSec = new ByteWriter();
  memSec.u32(1);
  memSec.byte(0x00);
  memSec.u32(Math.ceil(heapBase / PAGE) + 1);
  section(out, 5, memSec);

  const globalSec = new ByteWriter();
  globalSec.u32(usesStack ? 2 : 1);
  globalSec.byte(VALTYPE.i32);
  globalSec.byte(0x00);
  globalSec.byte(0x41);
  globalSec.sleb(BigInt(heapBase), 32);
  globalSec.byte(0x0b);
  if (usesStack) {
    // The shadow stack sits between statics and the arena, and grows down towards the statics.
    globalSec.byte(VALTYPE.i32);
    globalSec.byte(0x01);
    globalSec.byte(0x41);
    globalSec.sleb(BigInt(heapBase), 32);
    globalSec.byte(0x0b);
  }
  section(out, 6, globalSec);

  const exportSec = new ByteWriter();
  const exported = m.funcs.filter((f) => f.attrs.includes("export"));
  exportSec.u32(exported.length + 2 + (usesStack ? 1 : 0));
  exportSec.name("memory");
  exportSec.byte(0x02);
  exportSec.u32(0);
  exportSec.name("__heap_base");
  exportSec.byte(0x03);
  exportSec.u32(0);
  if (usesStack) {
    exportSec.name("__sp");
    exportSec.byte(0x03);
    exportSec.u32(GLOBAL_SP);
  }
  for (const f of exported) {
    exportSec.name(f.name);
    exportSec.byte(0x00);
    exportSec.u32(funcIndex.get(f.name)!);
  }
  section(out, 7, exportSec);

  if (tableIndex.size > 0) {
    const elemSec = new ByteWriter();
    elemSec.u32(1);
    elemSec.u32(0);
    elemSec.byte(0x41);
    elemSec.sleb(1n, 32);
    elemSec.byte(0x0b);
    elemSec.u32(tableIndex.size);
    for (const name of tableIndex.keys()) elemSec.u32(funcIndex.get(name)!);
    section(out, 9, elemSec);
  }

  const codeSec = new ByteWriter();
  codeSec.u32(bodies.length);
  for (const body of bodies) {
    codeSec.u32(body.length);
    codeSec.append(body);
  }
  section(out, 10, codeSec);

  const withData = m.globals.filter((g) => g.bytes?.some((b) => b !== 0));
  if (withData.length > 0) {
    const dataSec = new ByteWriter();
    dataSec.u32(withData.length);
    for (const g of withData) {
      dataSec.u32(0);
      dataSec.byte(0x41);
      dataSec.sleb(BigInt(globalAddr.get(g.name)!), 32);
      dataSec.byte(0x0b);
      dataSec.u32(g.bytes!.length);
      dataSec.append(Array.from(g.bytes!));
    }
    section(out, 11, dataSec);
  }
  return { bytes: Uint8Array.from(out.bytes), heapBase };
}
