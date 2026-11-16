// Typed tree to TIR. SSA comes from Braun et al.'s construction: variables are read and written per
// block, and block parameters appear only where a read actually needs a merge.
import { RT_SIGS } from "./down-rt.ts";
import {
  canonicalize,
  cmpStr,
  edgesOf,
  type Block,
  type Edge,
  type Func,
  type Global,
  type Module,
  type Operand,
  type Sig,
  type Term,
  type TirType,
  type TrapSite,
} from "../tir/ir.ts";
import {
  elemSize,
  INT_RANGE,
  leaves,
  tagLeaf,
  type ElemName,
  type FuncInst,
  type GlobalDef,
  type IntName,
  type MemLeaf,
  type Stmt,
  type TE,
  type Ty,
  type TypedModule,
  type Var,
} from "./types.ts";
import {
  lowerNativeBuiltin,
  loadMem,
  storeMem,
  buildStatics,
  buildThunks,
  computeCaptures,
  thunkName,
} from "./lower-native.ts";

export interface ModuleCtx {
  m: Module;
  strings: Map<string, number>;
  nextTrap: number;
  sigKeys: Map<string, number>;
  tables: Set<string>;
  thunks: Map<string, FuncInst>; // native TSL: top-level functions used as values take a hidden environment
  region: boolean; // R6: tslc placed something in the per-call region (region.ts)
}

function intOf(ty: Ty): IntName | null {
  return ty.k === "int" ? ty.name : null;
}

function isSigned(ty: Ty): boolean {
  if (ty.k === "int") return ty.name.startsWith("i");
  if (ty.k === "big") return ty.name === "i64";
  return true; // enums and numeric literal unions are i32
}

function fbits64(v: number): bigint {
  const b = new DataView(new ArrayBuffer(8));
  if (Number.isNaN(v)) return 0x7ff8000000000000n;
  b.setFloat64(0, v);
  return b.getBigUint64(0);
}

function fbits32(v: number): bigint {
  const b = new DataView(new ArrayBuffer(4));
  if (Number.isNaN(v)) return 0x7fc00000n;
  b.setFloat32(0, v);
  return BigInt(b.getUint32(0));
}

interface LoopTarget {
  label: string | null;
  brk: Block;
  cont: Block | null; // null for a switch or a labelled block
  plain?: boolean; // a labelled block, which an unlabelled break passes straight through
  depth?: number; // how many `using` cleanups were live here
}

export class FnLower {
  ctx: ModuleCtx;
  f: Func;
  cur: Block;
  nextBlock = 0;
  nextVal = 0;
  defs = new Map<string, Map<number, number>>();
  varTypes = new Map<string, TirType>();
  preds = new Map<number, { from: Block; edge: Edge }[]>();
  sealed = new Set<number>();
  incomplete = new Map<number, { key: string; param: number }[]>();
  blockById = new Map<number, Block>();
  terminated = new Set<number>();
  targets: LoopTarget[] = [];
  pendingLabel: string | null = null;
  ret: Ty;
  nextTemp = -1;
  // Native TSL.
  inst: FuncInst;
  allocaAt = 0;
  slots = new Map<Var, number>();
  envVal: number | null = null;
  cleanups: TE[] = [];
  addrCache = new Map<number, { block: number; ptr: number }>();

  constructor(ctx: ModuleCtx, inst: FuncInst) {
    this.ctx = ctx;
    this.inst = inst;
    this.ret = inst.ret;
    this.f = {
      name: inst.tirName,
      params: [],
      rets: leaves(inst.ret),
      attrs: inst.attrs,
      blocks: [],
      types: [],
    };
    this.cur = this.newBlock();
    this.seal(this.cur);
    if (inst.isClosure === true) {
      this.envVal = this.newVal("ptr");
      this.f.params.push(this.envVal);
    }
    for (const p of inst.params) {
      const tys = leaves(p.ty);
      const vals = tys.map((t) => {
        const v = this.newVal(t);
        this.f.params.push(v);
        return v;
      });
      this.setVar(p, vals);
    }
    this.loadCaptures();
    // R6: an export of a lowered package tslc placed something in the per-call region in marks the region (the call
    // arena's top) here, and gives back what was made since at each return (region.ts).
    if (inst.regionMark === true) {
      const g = this.op1("globaladdr", [{ t: "sym", name: "__arena_top" }], "ptr");
      this.regionTop = this.op1("load.ptr.na", [{ t: "v", id: g }], "ptr");
    }
  }

  regionTop: number | null = null;

  /** R6: the per-call region given back to where this export found it, before it returns. */
  giveBackRegion(): void {
    if (this.regionTop === null) return;
    // the injected `region-kept` bug: an export that never gives its region back, so a loop of calls runs the arena out
    if (process.env.TMK_TEST_TSL === "region-kept") return;
    const g = this.op1("globaladdr", [{ t: "sym", name: "__arena_top" }], "ptr");
    this.emit(
      "store.ptr.na",
      [
        { t: "v", id: g },
        { t: "v", id: this.regionTop },
      ],
      [],
    );
  }

  // --- native TSL: stack slots, captured variables and references (SPEC 3.5, 4.3)

  /** A frame slot. Always in the entry block: the backend gives each alloca one static place. */
  entryAlloca(size: number, align: number, trap: Operand): number {
    const id = this.newVal("ptr");
    const entry = this.f.blocks[0]!;
    entry.instrs.splice(this.allocaAt++, 0, {
      op: "alloca",
      ops: [{ t: "i", val: BigInt(Math.max(size, 8)) }, { t: "i", val: BigInt(align) }, trap],
      res: [id],
    });
    return id;
  }

  /** The address of a variable that a closure can change. Its owner keeps it on its frame. */
  slotAddr(v: Var): number {
    const caps = this.inst.captures;
    if (caps !== undefined && caps.includes(v)) {
      return this.load8("ptr", this.envVal!, this.envOffset(v));
    }
    let s = this.slots.get(v);
    if (s === undefined) {
      const n = Math.max(leaves(v.ty).length, 1);
      s = this.entryAlloca(n * 8, 8, this.trapOp("memory", 14, this.inst.at ?? ""));
      this.slots.set(v, s);
    }
    return s;
  }

  /** A closure's environment: a pointer for a variable that changes, the values for one that doesn't. */
  envOffset(v: Var): number {
    let off = 0;
    for (const c of this.inst.captures ?? []) {
      if (c === v) return off;
      off += c.boxed === true ? 8 : 8 * leaves(c.ty).length;
    }
    throw new Error(`${v.name} is not captured by @${this.inst.tirName}`);
  }

  load8(t: TirType, base: number, off: number): number {
    return this.memLoad(base, { t, off });
  }

  loadCaptures(): void {
    if (this.envVal === null) return;
    for (const c of this.inst.captures ?? []) {
      if (c.boxed === true) continue;
      const base = this.envOffset(c);
      leaves(c.ty).forEach((t, i) => {
        this.write(this.key(c, i), t, this.load8(t, this.envVal!, base + i * 8));
      });
    }
  }

  readVar(v: Var): number[] {
    if (v.boxed === true) {
      const s = this.slotAddr(v);
      return leaves(v.ty).map((t, i) => this.load8(t, s, i * 8));
    }
    return leaves(v.ty).map((t, i) => this.read(this.key(v, i), t));
  }

  /** A reference's pointer, without its generation. */
  refAddr(v: number): number {
    const hit = this.addrCache.get(v);
    if (hit !== undefined && hit.block === this.cur.id) return hit.ptr;
    const ptr = this.op1("ref.addr", [{ t: "v", id: v }], "ptr");
    this.addrCache.set(v, { block: this.cur.id, ptr });
    return ptr;
  }

  /** The same, after checking its generation. Traps with code 5 if the object was removed. */
  genChk(v: number, loc: string): number {
    return this.op1("gen.chk", [{ t: "v", id: v }, this.trapOp("stale", 5, loc)], "ptr");
  }

  ptrToI64(p: number): number {
    return this.op1("bitcast.i64", [{ t: "v", id: p }], "i64");
  }

  i64ToPtr(v: number): number {
    return this.op1("bitcast.ptr", [{ t: "v", id: v }], "ptr");
  }

  runCleanups(downTo: number): void {
    const saved = this.cleanups;
    for (let i = saved.length - 1; i >= downTo; i--) {
      this.cleanups = saved.slice(0, i);
      this.expr(saved[i]!);
    }
    this.cleanups = saved;
  }

  key(v: Var, i: number): string {
    return `${v.id}:${i}`;
  }

  newVal(t: TirType): number {
    const id = this.nextVal++;
    this.f.types[id] = t;
    return id;
  }

  newBlock(): Block {
    const b: Block = { id: this.nextBlock++, params: [], instrs: [], term: { k: "unreachable" } };
    this.f.blocks.push(b);
    this.blockById.set(b.id, b);
    this.preds.set(b.id, []);
    return b;
  }

  // --- SSA variables

  write(key: string, t: TirType, v: number, block: Block = this.cur): void {
    this.varTypes.set(key, t);
    let m = this.defs.get(key);
    if (m === undefined) {
      m = new Map();
      this.defs.set(key, m);
    }
    m.set(block.id, v);
  }

  read(key: string, t: TirType, block: Block = this.cur): number {
    this.varTypes.set(key, t);
    const v = this.defs.get(key)?.get(block.id);
    if (v !== undefined) return v;
    return this.readRecursive(key, t, block);
  }

  readRecursive(key: string, t: TirType, block: Block): number {
    const preds = this.preds.get(block.id)!;
    let v: number;
    if (!this.sealed.has(block.id)) {
      v = this.addParam(block, t);
      let list = this.incomplete.get(block.id);
      if (list === undefined) {
        list = [];
        this.incomplete.set(block.id, list);
      }
      list.push({ key, param: v });
    } else if (preds.length === 0) {
      // Dead code, or a read tsc's definite-assignment analysis already rejects.
      v = this.zeroAtStart(block, t);
    } else if (preds.length === 1) {
      v = this.read(key, t, preds[0]!.from);
    } else {
      v = this.addParam(block, t);
      this.write(key, t, v, block); // breaks cycles through loops
      for (const p of preds) p.edge.args.push(this.read(key, t, p.from));
    }
    this.write(key, t, v, block);
    return v;
  }

  addParam(block: Block, t: TirType): number {
    const v = this.newVal(t);
    block.params.push(v);
    return v;
  }

  zeroAtStart(block: Block, t: TirType): number {
    const v = this.newVal(t);
    block.instrs.unshift(zeroInstr(t, v));
    return v;
  }

  seal(block: Block): void {
    if (this.sealed.has(block.id)) return;
    this.sealed.add(block.id);
    const list = this.incomplete.get(block.id);
    if (list !== undefined) {
      for (const { key, param } of list) {
        const t = this.f.types[param]!;
        for (const p of this.preds.get(block.id)!) p.edge.args.push(this.read(key, t, p.from));
      }
      this.incomplete.delete(block.id);
    }
  }

  // --- emission

  emit(op: string, ops: Operand[], rets: TirType[]): number[] {
    const res = rets.map((t) => this.newVal(t));
    this.cur.instrs.push({ op, ops, res });
    return res;
  }

  op1(op: string, ops: Operand[], ret: TirType): number {
    return this.emit(op, ops, [ret])[0]!;
  }

  iconst(t: TirType, v: bigint | number): number {
    return this.op1(`iconst.${t}`, [{ t: "i", val: BigInt(v) }], t);
  }

  setTerm(term: Term): void {
    if (this.terminated.has(this.cur.id)) return;
    this.terminated.add(this.cur.id);
    this.cur.term = term;
    for (const e of edgesOf(term)) {
      this.preds.get(e.block)!.push({ from: this.cur, edge: e });
    }
  }

  br(to: Block): void {
    this.setTerm({ k: "br", to: { block: to.id, args: [] } });
  }

  brif(cond: number, t: Block, f: Block): void {
    this.setTerm({ k: "brif", cond, t: { block: t.id, args: [] }, f: { block: f.id, args: [] } });
  }

  dead(): void {
    const b = this.newBlock();
    this.seal(b);
    this.cur = b;
  }

  trapId(kind: string, code: number, loc: string): number {
    const id = this.ctx.nextTrap++;
    const site: TrapSite = { id, kind, code, loc };
    this.ctx.m.traps.push(site);
    return id;
  }

  trapOp(kind: string, code: number, loc: string): Operand {
    return { t: "trap", id: this.trapId(kind, code, loc) };
  }

  /** Branches to a trap if `cond` holds, then carries on. */
  trapIf(cond: number, kind: string, code: number, loc: string): void {
    const bad = this.newBlock();
    const ok = this.newBlock();
    this.brif(cond, bad, ok);
    this.seal(bad);
    this.seal(ok);
    this.cur = bad;
    this.setTerm({ k: "trap", id: this.trapId(kind, code, loc) });
    this.cur = ok;
  }

  // --- statements

  stmts(list: Stmt[]): void {
    const depth = this.cleanups.length;
    for (const s of list) this.stmt(s);
    if (this.cleanups.length > depth) {
      this.runCleanups(depth);
      this.cleanups.length = depth;
    }
  }

  stmt(s: Stmt): void {
    switch (s.k) {
      case "let":
        if (s.init !== null) this.setVar(s.v, this.expr(s.init));
        break;
      case "using":
        if (s.dispose !== null) this.cleanups.push(s.dispose);
        break;
      case "expr":
        this.expr(s.e);
        break;
      case "block":
        this.stmts(s.body);
        break;
      case "if": {
        const c = this.expr(s.c)[0]!;
        const then = this.newBlock();
        const merge = this.newBlock();
        const other = s.b !== null ? this.newBlock() : merge;
        this.brif(c, then, other);
        this.seal(then);
        if (s.b !== null) this.seal(other);
        this.cur = then;
        this.stmts(s.a);
        this.br(merge);
        if (s.b !== null) {
          this.cur = other;
          this.stmts(s.b);
          this.br(merge);
        }
        this.seal(merge);
        this.cur = merge;
        break;
      }
      case "while": {
        const label = this.takeLabel();
        const head = this.newBlock();
        const body = this.newBlock();
        const exit = this.newBlock();
        this.br(head);
        this.cur = head;
        const c = this.expr(s.c)[0]!;
        this.brif(c, body, exit);
        this.seal(body);
        this.cur = body;
        this.targets.push({ label, brk: exit, cont: head, depth: this.cleanups.length });
        this.stmts(s.body);
        this.targets.pop();
        this.br(head);
        this.seal(head);
        this.seal(exit);
        this.cur = exit;
        break;
      }
      case "do": {
        const label = this.takeLabel();
        const body = this.newBlock();
        const test = this.newBlock();
        const exit = this.newBlock();
        this.br(body);
        this.cur = body;
        this.targets.push({ label, brk: exit, cont: test, depth: this.cleanups.length });
        this.stmts(s.body);
        this.targets.pop();
        this.br(test);
        this.seal(test);
        this.cur = test;
        const c = this.expr(s.c)[0]!;
        this.brif(c, body, exit);
        this.seal(body);
        this.seal(exit);
        this.cur = exit;
        break;
      }
      case "for": {
        const label = this.takeLabel();
        this.stmts(s.init);
        const head = this.newBlock();
        const body = this.newBlock();
        const step = this.newBlock();
        const exit = this.newBlock();
        this.br(head);
        this.cur = head;
        if (s.c !== null) {
          const c = this.expr(s.c)[0]!;
          this.brif(c, body, exit);
        } else this.br(body);
        this.seal(body);
        this.cur = body;
        this.targets.push({ label, brk: exit, cont: step, depth: this.cleanups.length });
        this.stmts(s.body);
        this.targets.pop();
        this.br(step);
        this.seal(step);
        this.cur = step;
        for (const e of s.step) this.expr(e);
        this.br(head);
        this.seal(head);
        this.seal(exit);
        this.cur = exit;
        break;
      }
      case "forof":
        this.forOf(s);
        break;
      case "switch":
        this.switchStmt(s);
        break;
      case "label": {
        const inner = s.body;
        if (inner.k === "while" || inner.k === "do" || inner.k === "for" || inner.k === "forof") {
          this.pendingLabel = s.name;
          this.stmt(inner);
        } else {
          const exit = this.newBlock();
          this.targets.push({
            label: s.name,
            brk: exit,
            cont: null,
            plain: true,
            depth: this.cleanups.length,
          });
          this.stmt(inner);
          this.targets.pop();
          this.br(exit);
          this.seal(exit);
          this.cur = exit;
        }
        break;
      }
      case "break": {
        const t = this.findTarget(s.label, false);
        this.runCleanups(t.depth ?? 0);
        this.br(t.brk);
        this.dead();
        break;
      }
      case "continue": {
        const t = this.findTarget(s.label, true);
        this.runCleanups(t.depth ?? 0);
        this.br(t.cont!);
        this.dead();
        break;
      }
      case "return": {
        const vals = s.val !== null ? this.expr(s.val) : [];
        this.runCleanups(0);
        // `return trap(1)` is a type-correct way to say the path ends: the trap has already left.
        if (s.val?.ty.k === "never") this.setTerm({ k: "unreachable" });
        else {
          this.giveBackRegion();
          this.setTerm({ k: "ret", vals });
        }
        this.dead();
        break;
      }
    }
  }

  takeLabel(): string | null {
    const l = this.pendingLabel;
    this.pendingLabel = null;
    return l;
  }

  findTarget(label: string | null, needLoop: boolean): LoopTarget {
    for (let i = this.targets.length - 1; i >= 0; i--) {
      const t = this.targets[i]!;
      if (label !== null ? t.label === label : t.plain !== true && (!needLoop || t.cont !== null)) {
        return t;
      }
    }
    throw new Error(`no target for ${label ?? "break"}`);
  }

  forOf(s: Extract<Stmt, { k: "forof" }>): void {
    const label = this.takeLabel();
    const [ptr, len] = this.expr(s.arr) as [number, number];
    const idx = { id: -1000 - this.nextTemp--, name: "$i", ty: { k: "int", name: "usize" } } as Var;
    const ikey = this.key(idx, 0);
    this.write(ikey, "ix", this.iconst("ix", 0));
    const head = this.newBlock();
    const body = this.newBlock();
    const step = this.newBlock();
    const exit = this.newBlock();
    this.br(head);
    this.cur = head;
    const i = this.read(ikey, "ix");
    const c = this.op1(
      "icmp.ult.ix",
      [
        { t: "v", id: i },
        { t: "v", id: len },
      ],
      "i32",
    );
    this.brif(c, body, exit);
    this.seal(body);
    this.cur = body;
    const arrTy = s.arr.ty;
    if (arrTy.k !== "arr") throw new Error("for...of over a non-array");
    const elem = this.loadElem(arrTy.elem, ptr, i);
    this.setVar(s.v, [elem]);
    this.targets.push({ label, brk: exit, cont: step, depth: this.cleanups.length });
    this.stmts(s.body);
    this.targets.pop();
    this.br(step);
    this.seal(step);
    this.cur = step;
    const one = this.iconst("ix", 1);
    const next = this.op1(
      "add.ix",
      [
        { t: "v", id: this.read(ikey, "ix") },
        { t: "v", id: one },
      ],
      "ix",
    );
    this.write(ikey, "ix", next);
    this.br(head);
    this.seal(head);
    this.seal(exit);
    this.cur = exit;
  }

  switchStmt(s: Extract<Stmt, { k: "switch" }>): void {
    const val = this.expr(s.val)[0]!;
    const exit = this.newBlock();
    const blocks = s.clauses.map(() => this.newBlock());
    const seen = new Set<bigint>();
    const cases: { key: bigint; to: Edge }[] = [];
    let def: Edge = { block: exit.id, args: [] };
    s.clauses.forEach((c, i) => {
      if (c.isDefault) def = { block: blocks[i]!.id, args: [] };
      for (const key of c.keys) {
        if (key.k !== "lit") continue;
        const k = this.litValue(key);
        if (seen.has(k)) continue; // JS takes the first matching case
        seen.add(k);
        cases.push({ key: k, to: { block: blocks[i]!.id, args: [] } });
      }
    });
    this.setTerm({ k: "switch", val, cases, def });
    this.targets.push({
      label: this.takeLabel(),
      brk: exit,
      cont: null,
      depth: this.cleanups.length,
    });
    s.clauses.forEach((c, i) => {
      if (i > 0) {
        // Fall through from the previous clause, unless it already left.
        this.br(blocks[i]!);
      }
      this.seal(blocks[i]!);
      this.cur = blocks[i]!;
      this.stmts(c.body);
    });
    this.targets.pop();
    this.br(exit);
    this.seal(exit);
    this.cur = exit;
  }

  litValue(te: TE): bigint {
    if (te.k !== "lit") throw new Error("not a literal");
    const v = te.value;
    if (typeof v === "bigint") return v;
    if (typeof v === "boolean") return v ? 1n : 0n;
    if (typeof v === "string") return BigInt(this.ctx.strings.get(v)!);
    return BigInt(v);
  }

  setVar(v: Var, vals: number[]): void {
    const tys = leaves(v.ty);
    if (v.boxed === true) {
      const addr = this.slotAddr(v);
      tys.forEach((t, i) => {
        this.memStore(addr, { t, off: i * 8 }, vals[i]!);
      });
      return;
    }
    tys.forEach((t, i) => {
      this.write(this.key(v, i), t, vals[i]!);
    });
  }

  // --- expressions: each returns its flattened SSA values

  expr(te: TE): number[] {
    switch (te.k) {
      case "err":
        throw new Error("lowering a poisoned expression");
      case "lit":
        return [this.lit(te)];
      case "var":
        return this.readVar(te.v);
      case "global":
        return this.globalRead(te.g);
      case "fnref":
        if (te.ty.k === "fn" && te.ty.env === true) {
          this.ctx.thunks.set(te.inst.tirName, te.inst);
          return [
            this.op1("funcaddr", [{ t: "sym", name: thunkName(te.inst.tirName) }], "ptr"),
            this.zero("ptr"),
          ];
        }
        return [this.op1("funcaddr", [{ t: "sym", name: te.inst.tirName }], "ptr")];
      case "tableget": {
        const idx = this.expr(te.idx)[0]!;
        const table = te.g.table!;
        const len = this.iconst("ix", table.length);
        const checked = this.op1(
          "bounds.chk",
          [{ t: "v", id: idx }, { t: "v", id: len }, this.trapOp("bounds", 2, te.loc)],
          "ix",
        );
        this.ctx.tables.add(te.g.name);
        const code = this.emit(
          "call",
          [
            { t: "sym", name: `__table.${te.g.name}` },
            { t: "v", id: checked },
          ],
          ["ptr"],
        );
        if (te.ty.k === "fn" && te.ty.env === true) {
          for (const inst of te.g.table!) this.ctx.thunks.set(inst.tirName, inst);
          return [code[0]!, this.zero("ptr")];
        }
        return code;
      }
      case "index": {
        const [ptr, len] = this.expr(te.arr) as [number, number];
        const idx = this.expr(te.idx)[0]!;
        if (te.arr.ty.k !== "arr") throw new Error("index on a non-array");
        const checked = this.op1(
          "bounds.chk",
          [{ t: "v", id: idx }, { t: "v", id: len }, this.trapOp("bounds", 2, te.loc)],
          "ix",
        );
        return [this.loadElem(te.arr.ty.elem, ptr, checked)];
      }
      case "len":
        return [this.expr(te.arr)[1]!];
      case "arith":
        return [this.arith(te)];
      case "farith": {
        const a = this.expr(te.a)[0]!;
        const b = this.expr(te.b)[0]!;
        return [
          this.op1(
            `f${te.op}.f64`,
            [
              { t: "v", id: a },
              { t: "v", id: b },
            ],
            "f64",
          ),
        ];
      }
      case "bigshift":
        return [this.bigShift(te)];
      case "bit":
        return [this.bit(te)];
      case "bitnot": {
        if (te.ty.k === "big") {
          return [this.op1("not.i64", [{ t: "v", id: this.expr(te.a)[0]! }], "i64")];
        }
        return [this.op1("not.i32", [{ t: "v", id: this.int32Operand(te.a) }], "i32")];
      }
      case "neg":
        return [this.neg(te)];
      case "not": {
        const a = this.expr(te.a)[0]!;
        const z = this.iconst("i32", 0);
        return [
          this.op1(
            "icmp.eq.i32",
            [
              { t: "v", id: a },
              { t: "v", id: z },
            ],
            "i32",
          ),
        ];
      }
      case "cmp":
        return [this.cmp(te)];
      case "logic":
        return [this.logic(te)];
      case "cond":
        return this.cond(te);
      case "setvar": {
        const vals = this.expr(te.val);
        this.setVar(te.v, vals);
        return vals;
      }
      case "setglobal": {
        const vals = this.expr(te.val);
        const addr = this.op1("globaladdr", [{ t: "sym", name: te.g.name }], "ptr");
        if (te.g.ty.k === "cls" || te.g.ty.k === "ptr" || te.g.ty.k === "fn")
          storeMem(this, te.g.ty, addr, vals, false);
        else this.storeScalar(te.g.ty, addr, vals[0]!);
        return vals;
      }
      case "setindex": {
        const [ptr, len] = this.expr(te.arr) as [number, number];
        const idx = this.expr(te.idx)[0]!;
        const vals = this.expr(te.val);
        if (te.arr.ty.k !== "arr") throw new Error("setindex on a non-array");
        const checked = this.op1(
          "bounds.chk",
          [{ t: "v", id: idx }, { t: "v", id: len }, this.trapOp("bounds", 2, te.loc)],
          "ix",
        );
        this.storeElem(te.arr.ty.elem, ptr, checked, vals[0]!);
        return vals;
      }
      case "seq":
        for (const it of te.items) this.expr(it);
        return this.expr(te.result);
      case "call": {
        const args = te.args.flatMap((a) => this.expr(a));
        const ops: Operand[] = [{ t: "sym", name: te.inst.tirName }];
        for (const a of args) ops.push({ t: "v", id: a });
        const rets = this.emit("call", ops, leaves(te.inst.ret));
        if (te.inst.ret.k === "never") {
          this.setTerm({ k: "unreachable" });
          this.dead();
        }
        return rets;
      }
      case "callind": {
        const fnVals = this.expr(te.fn);
        const fn = fnVals[0]!;
        const args = te.args.flatMap((a) => this.expr(a));
        const fnTy = te.fn.ty;
        if (fnTy.k !== "fn") throw new Error("indirect call on a non-function");
        const hidden: TirType[] = fnTy.env === true ? ["ptr"] : [];
        const sig: Sig = {
          params: [...hidden, ...fnTy.params.flatMap(leaves)],
          rets: leaves(fnTy.ret),
        };
        const ops: Operand[] = [
          { t: "sig", id: this.internSig(sig) },
          { t: "v", id: fn },
        ];
        if (fnTy.env === true) ops.push({ t: "v", id: fnVals[1]! });
        for (const a of args) ops.push({ t: "v", id: a });
        const rets = this.emit("call.indirect", ops, sig.rets);
        if (fnTy.ret.k === "never") {
          this.setTerm({ k: "unreachable" });
          this.dead();
        }
        return rets;
      }
      case "ofield":
      case "osetfield":
      case "new":
      case "closure":
      case "chkref":
        return lowerNativeBuiltin(this, te);
      case "builtin":
        return this.builtin(te);
      case "record": {
        const byName = new Map<string, number[]>();
        for (const f of te.fields) byName.set(f.name, this.expr(f.val));
        if (te.ty.k !== "rec") throw new Error("record of a non-record type");
        return te.ty.fields.flatMap((f) => byName.get(f.name) ?? []);
      }
      case "ulit":
        return this.unionLit(te);
      case "field":
        return this.field(te);
      case "conv":
        return this.conv(te);
      case "optindex":
        return this.optIndex(te);
      case "isundef": {
        const tag = this.expr(te.val)[0]!;
        if (te.negate) return [tag];
        const z = this.iconst("i32", 0);
        return [
          this.op1(
            "icmp.eq.i32",
            [
              { t: "v", id: tag },
              { t: "v", id: z },
            ],
            "i32",
          ),
        ];
      }
      case "optpayload":
        return this.expr(te.val).slice(1);
      case "tuple":
        return te.items.flatMap((x) => this.expr(x));
      case "slice":
        return this.expr(te.val).slice(te.from, te.to);
      case "gaddr":
        if (te.off !== undefined) {
          const g = this.op1("globaladdr", [{ t: "sym", name: te.name }], "ptr");
          const off = this.iconst("ix", te.off);
          return [
            this.op1(
              "gep",
              [
                { t: "v", id: g },
                { t: "v", id: off },
                { t: "i", val: 1n },
                { t: "i", val: 0n },
              ],
              "ptr",
            ),
          ];
        }
        return [this.op1("globaladdr", [{ t: "sym", name: te.name }], "ptr")];
      case "fload": {
        const base = this.expr(te.base)[0]!;
        return te.mem.map((m) => this.memLoad(base, m));
      }
      case "fstore": {
        const base = this.expr(te.base)[0]!;
        const vals = this.expr(te.val);
        te.mem.forEach((m, i) => {
          this.memStore(base, m, vals[i]!);
        });
        return vals;
      }
      case "elemaddr": {
        const base = this.expr(te.base)[0]!;
        const idx = this.expr(te.idx)[0]!;
        return [
          this.op1(
            "gep",
            [
              { t: "v", id: base },
              { t: "v", id: idx },
              { t: "i", val: BigInt(te.scale) },
              { t: "i", val: 0n },
            ],
            "ptr",
          ),
        ];
      }
      case "loadelem": {
        const ptr = this.expr(te.ptr)[0]!;
        const idx = this.expr(te.idx)[0]!;
        return [this.loadElem(te.elem, ptr, idx)];
      }
      case "storeelem": {
        const ptr = this.expr(te.ptr)[0]!;
        const idx = this.expr(te.idx)[0]!;
        const v = this.expr(te.val)[0]!;
        this.storeElem(te.elem, ptr, idx, v);
        return [v];
      }
      case "alloc":
        return [this.alloc(te)];
      case "callclo": {
        // An environment starts with its code pointer, and every closure takes its environment first.
        const clo = this.expr(te.clo)[0]!;
        const code = this.memLoad(clo, { t: "ptr", off: 0 });
        const args = te.args.flatMap((a) => this.expr(a));
        const sig: Sig = { params: ["ptr", ...te.params.flatMap(leaves)], rets: leaves(te.ret) };
        const ops: Operand[] = [
          { t: "sig", id: this.internSig(sig) },
          { t: "v", id: code },
          { t: "v", id: clo },
        ];
        for (const a of args) ops.push({ t: "v", id: a });
        return this.emit("call.indirect", ops, sig.rets);
      }
      case "rtcall": {
        const args = te.args.flatMap((a) => this.expr(a));
        const ops: Operand[] = [{ t: "sym", name: te.name }];
        for (const a of args) ops.push({ t: "v", id: a });
        return this.emit("call", ops, leaves(te.ty));
      }
      case "intrinsic": {
        const args = te.args.flatMap((a) => this.expr(a));
        const ops: Operand[] = [{ t: "name", name: te.name }];
        for (const a of args) ops.push({ t: "v", id: a });
        return this.emit("intrinsic", ops, leaves(te.ty));
      }
      case "blockexpr":
        this.stmts(te.body);
        return this.expr(te.result);
      case "throwjs": {
        const vals = te.args.flatMap((a) => this.expr(a).map((v) => v));
        if (vals.length > 0) {
          const addr = this.op1("globaladdr", [{ t: "sym", name: "__trap_args" }], "ptr");
          vals.forEach((v, i) => {
            this.memStore(addr, { t: this.f.types[v]!, off: i * 8 }, v);
          });
        }
        const id = this.trapId("throw", te.code, te.loc);
        this.ctx.m.traps.find((t) => t.id === id)!.msg = te.msg;
        this.setTerm({ k: "trap", id });
        this.dead();
        return [];
      }
      case "f2ix": {
        const v = this.expr(te.val)[0]!;
        const vv: Operand = { t: "v", id: v };
        const r = this.op1("fptoui.sat.i32", [vv], "i32");
        const back = this.op1("uitofp.f64", [{ t: "v", id: r }], "f64");
        const same = this.op1("fcmp.eq.f64", [{ t: "v", id: back }, vv], "i32");
        const past = this.iconst("i32", 0xffffffffn);
        const sel = this.op1(
          "select.i32",
          [
            { t: "v", id: same },
            { t: "v", id: r },
            { t: "v", id: past },
          ],
          "i32",
        );
        return [this.op1("zext.ix", [{ t: "v", id: sel }], "ix")];
      }
      case "nonnull": {
        const vals = this.expr(te.val);
        const t = this.f.types[vals[0]!]!;
        const z = this.zero(t);
        const isNull = this.op1(
          `icmp.eq.${t}`,
          [
            { t: "v", id: vals[0]! },
            { t: "v", id: z },
          ],
          "i32",
        );
        this.trapIf(isNull, "null", 6, te.loc);
        return vals;
      }
      case "raise":
        throw new Error("a raise reached TIR: down-exc.ts should have lowered it");
      case "trapnow":
        this.setTerm({ k: "trap", id: this.trapId(te.kind, te.code, te.loc) });
        this.dead();
        return [];
    }
  }

  optIndex(te: Extract<TE, { k: "optindex" }>): number[] {
    const [ptr, len] = this.expr(te.arr) as [number, number];
    const idx = this.expr(te.idx)[0]!;
    if (te.arr.ty.k !== "arr") throw new Error("a nullable read of a non-array");
    const ok = this.op1(
      "icmp.ult.ix",
      [
        { t: "v", id: idx },
        { t: "v", id: len },
      ],
      "i32",
    );
    const tys = leaves(te.ty);
    const base = this.nextTemp--;
    const hit = this.newBlock();
    const miss = this.newBlock();
    const merge = this.newBlock();
    this.brif(ok, hit, miss);
    this.seal(hit);
    this.seal(miss);
    this.cur = hit;
    this.write(`tmp${base}:0`, "i32", this.iconst("i32", 1));
    this.write(`tmp${base}:1`, tys[1]!, this.loadElem(te.arr.ty.elem, ptr, idx));
    this.br(merge);
    this.cur = miss;
    this.write(`tmp${base}:0`, "i32", this.iconst("i32", 0));
    this.write(`tmp${base}:1`, tys[1]!, this.zero(tys[1]!));
    this.br(merge);
    this.seal(merge);
    this.cur = merge;
    return tys.map((t, i) => this.read(`tmp${base}:${i}`, t));
  }

  memLoad(base: number, m: MemLeaf): number {
    const addr = this.memAddr(base, m.off);
    // A `bool` laid out by TSL's rule (R6): a byte, widened to its register's i32 as lower-native.ts's loadMem widens one.
    if (m.t === "i8") {
      const raw = this.op1("load.i8.na", [{ t: "v", id: addr }], "i8");
      return this.op1("zext.i32", [{ t: "v", id: raw }], "i32");
    }
    const r = this.op1(`load.${m.t}.na`, [{ t: "v", id: addr }], m.t);
    // A class id (D50): noted for the optimiser, outside the canonical text (D73).
    if (m.inv === true) this.cur.instrs[this.cur.instrs.length - 1]!.inv = true;
    return r;
  }

  memStore(base: number, m: MemLeaf, v: number): void {
    const addr = this.memAddr(base, m.off);
    if (m.t === "i8") {
      const n = this.op1("trunc.i8", [{ t: "v", id: v }], "i8");
      this.emit(
        "store.i8.na",
        [
          { t: "v", id: addr },
          { t: "v", id: n },
        ],
        [],
      );
      return;
    }
    this.emit(
      `store.${m.t}.na`,
      [
        { t: "v", id: addr },
        { t: "v", id: v },
      ],
      [],
    );
  }

  memAddr(base: number, off: number): number {
    if (off === 0) return base;
    const zero = this.iconst("ix", 0);
    return this.op1(
      "gep",
      [
        { t: "v", id: base },
        { t: "v", id: zero },
        { t: "i", val: 1n },
        { t: "i", val: BigInt(off) },
      ],
      "ptr",
    );
  }

  alloc(te: Extract<TE, { k: "alloc" }>): number {
    const onStack = te.stack();
    let p: number;
    let size: number;
    let allocator = "";
    if (onStack !== null) {
      p = this.op1(
        "alloca",
        [{ t: "i", val: BigInt(onStack) }, { t: "i", val: 8n }, this.trapOp("memory", 14, te.loc)],
        "ptr",
      );
      size = this.iconst("ix", onStack);
    } else {
      size = this.expr(te.size)[0]!;
      allocator = te.long?.() ?? "__alloc";
      p = this.emit(
        "call",
        [
          { t: "sym", name: allocator },
          { t: "v", id: size },
        ],
        ["ptr"],
      )[0]!;
    }
    // A page source hands out zeroed pages, and leak's memory is never used twice.
    if (te.zero && allocator !== "__leak_alloc") {
      const z = this.iconst("i32", 0);
      this.emit(
        "intrinsic",
        [
          { t: "name", name: "mem.fill" },
          { t: "v", id: p },
          { t: "v", id: z },
          { t: "v", id: size },
        ],
        [],
      );
    }
    return p;
  }

  internSig(sig: Sig): number {
    const key = `${sig.params.join(",")}>${sig.rets.join(",")}`;
    let id = this.ctx.sigKeys.get(key);
    if (id === undefined) {
      id = this.ctx.m.sigs.length;
      this.ctx.m.sigs.push(sig);
      this.ctx.sigKeys.set(key, id);
    }
    return id;
  }

  lit(te: Extract<TE, { k: "lit" }>): number {
    const v = te.value;
    const ty = te.ty;
    if (ty.k === "float") {
      const n = v as number;
      if (ty.name === "f64") return this.op1("fconst.f64", [{ t: "i", val: fbits64(n) }], "f64");
      return this.op1("fconst.f32", [{ t: "i", val: fbits32(n) }], "f32");
    }
    if (ty.k === "big" || ty.k === "lit-big") return this.iconst("i64", v as bigint);
    if (ty.k === "lit-num")
      return this.op1("fconst.f64", [{ t: "i", val: fbits64(v as number) }], "f64");
    const t = leaves(ty)[0] ?? "i32";
    return this.iconst(t, this.litValue(te));
  }

  globalRead(g: GlobalDef): number[] {
    const addr = this.op1("globaladdr", [{ t: "sym", name: g.name }], "ptr");
    if (g.array !== undefined) return [addr, this.iconst("ix", g.array.length)];
    if (g.object !== undefined) {
      // A static object's reference: past its prefix, with the generation that never changes.
      const at = this.memAddr(addr, g.object.off);
      const tag = this.iconst("i64", 0xffffn << 48n);
      return [
        this.op1(
          "or.i64",
          [
            { t: "v", id: this.ptrToI64(at) },
            { t: "v", id: tag },
          ],
          "i64",
        ),
      ];
    }
    if (g.ty.k === "cls" || g.ty.k === "ptr" || g.ty.k === "fn")
      return loadMem(this, g.ty, addr, false, 8);
    return [this.loadScalar(g.ty, addr)];
  }

  loadScalar(ty: Ty, addr: number): number {
    const a: Operand = { t: "v", id: addr };
    switch (ty.k) {
      case "int":
        if (ty.name === "usize") return this.op1("load.ix.na", [a], "ix");
        if (ty.name === "u32" || ty.name === "i32") return this.op1("load.i32.na", [a], "i32");
        return this.loadNarrow(ty.name, addr);
      case "big":
        return this.op1("load.i64.na", [a], "i64");
      case "float":
        return this.op1(`load.${ty.name}.na`, [a], ty.name);
      default:
        return this.op1("load.i32.na", [a], "i32");
    }
  }

  loadNarrow(name: IntName, addr: number): number {
    const t: TirType = name === "u8" || name === "i8" ? "i8" : "i16";
    const raw = this.op1(`load.${t}.na`, [{ t: "v", id: addr }], t);
    return this.op1(`${name.startsWith("i") ? "sext" : "zext"}.i32`, [{ t: "v", id: raw }], "i32");
  }

  storeScalar(ty: Ty, addr: number, v: number): void {
    const a: Operand = { t: "v", id: addr };
    const val: Operand = { t: "v", id: v };
    switch (ty.k) {
      case "int":
        if (ty.name === "usize") this.emit("store.ix.na", [a, val], []);
        else if (ty.name === "u32" || ty.name === "i32") this.emit("store.i32.na", [a, val], []);
        else {
          const t: TirType = ty.name === "u8" || ty.name === "i8" ? "i8" : "i16";
          const narrow = this.op1(`trunc.${t}`, [val], t);
          this.emit(`store.${t}.na`, [a, { t: "v", id: narrow }], []);
        }
        return;
      case "big":
        this.emit("store.i64.na", [a, val], []);
        return;
      case "float":
        this.emit(`store.${ty.name}.na`, [a, val], []);
        return;
      default:
        this.emit("store.i32.na", [a, val], []);
    }
  }

  elemAddr(elem: ElemName, ptr: number, idx: number): number {
    return this.op1(
      "gep",
      [
        { t: "v", id: ptr },
        { t: "v", id: idx },
        { t: "i", val: BigInt(elemSize(elem)) },
        { t: "i", val: 0n },
      ],
      "ptr",
    );
  }

  loadElem(elem: ElemName, ptr: number, idx: number): number {
    const addr = this.elemAddr(elem, ptr, idx);
    return this.loadScalar(elemKind(elem), addr);
  }

  storeElem(elem: ElemName, ptr: number, idx: number, v: number): void {
    const addr = this.elemAddr(elem, ptr, idx);
    if (elem === "f32") {
      // The value is an f64 here: a store to a Float32Array rounds (SPEC 3.3, rule 10).
      const r = this.op1("fdemote", [{ t: "v", id: v }], "f32");
      this.emit(
        "store.f32.na",
        [
          { t: "v", id: addr },
          { t: "v", id: r },
        ],
        [],
      );
      return;
    }
    this.storeScalar(elemKind(elem), addr, v);
  }

  arith(te: Extract<TE, { k: "arith" }>): number {
    const a = this.expr(te.a)[0]!;
    const b = this.expr(te.b)[0]!;
    const ty = te.ty;
    const t = leaves(ty)[0]!;
    const signed = isSigned(ty);
    const s = signed ? "s" : "u";
    const av: Operand = { t: "v", id: a };
    const bv: Operand = { t: "v", id: b };
    switch (te.op) {
      case "rem":
        return this.op1(
          `${signed ? "srem" : "urem"}.${t}`,
          [av, bv, this.trapOp("div", 3, te.loc)],
          t,
        );
      case "idiv": {
        const q = this.op1(
          `${signed ? "sdiv" : "udiv"}.${t}`,
          [av, bv, this.trapOp("div", 3, te.loc)],
          t,
        );
        const name = intOf(ty);
        if (name === "i8" || name === "i16") return this.narrowCheck(q, name, "div", 3, te.loc);
        return q;
      }
      default:
        break;
    }
    if (te.wrap) {
      return this.op1(`${te.op}.${t}`, [av, bv], t);
    }
    const name = intOf(ty);
    if (name === null || name === "i32" || name === "u32" || name === "usize") {
      return this.op1(`${te.op}.chk.${s}.${t}`, [av, bv, this.trapOp("overflow", 1, te.loc)], t);
    }
    const r = this.op1(`${te.op}.i32`, [av, bv], "i32");
    return this.narrowCheck(r, name, "overflow", 1, te.loc);
  }

  narrowCheck(v: number, name: IntName, kind: string, code: number, loc: string): number {
    const [lo, hi] = INT_RANGE[name];
    const s = name.startsWith("i") ? "s" : "u";
    return this.op1(
      `range.chk.${s}.i32`,
      [
        { t: "v", id: v },
        { t: "i", val: BigInt(lo) },
        { t: "i", val: BigInt(hi) },
        this.trapOp(kind, code, loc),
      ],
      "i32",
    );
  }

  neg(te: Extract<TE, { k: "neg" }>): number {
    const a = this.expr(te.a)[0]!;
    const ty = te.ty;
    if (ty.k === "float") return this.op1("fneg.f64", [{ t: "v", id: a }], "f64");
    const t = leaves(ty)[0]!;
    const z = this.iconst(t, 0);
    const name = intOf(ty);
    if (name === "i8" || name === "i16") {
      const r = this.op1(
        "sub.i32",
        [
          { t: "v", id: z },
          { t: "v", id: a },
        ],
        "i32",
      );
      return this.narrowCheck(r, name, "overflow", 1, te.loc);
    }
    return this.op1(
      `sub.chk.s.${t}`,
      [{ t: "v", id: z }, { t: "v", id: a }, this.trapOp("overflow", 1, te.loc)],
      t,
    );
  }

  /** A bitwise operand as a 32-bit value: integers as they are, floats through ToInt32. */
  int32Operand(te: TE): number {
    const v = this.expr(te)[0]!;
    if (te.ty.k === "float") {
      const d = te.ty.name === "f64" ? v : this.op1("fpromote", [{ t: "v", id: v }], "f64");
      return this.op1("js.toint32", [{ t: "v", id: d }], "i32");
    }
    return v;
  }

  bit(te: Extract<TE, { k: "bit" }>): number {
    if (te.ty.k === "big") {
      const a = this.expr(te.a)[0]!;
      const b = this.expr(te.b)[0]!;
      return this.op1(
        `${te.op}.i64`,
        [
          { t: "v", id: a },
          { t: "v", id: b },
        ],
        "i64",
      );
    }
    const a = this.int32Operand(te.a);
    const b = this.int32Operand(te.b);
    const names: Record<typeof te.op, string> = {
      and: "and.i32",
      or: "or.i32",
      xor: "xor.i32",
      shl: "shl.js32",
      shr: "ashr.js32",
      ushr: "lshr.js32",
    };
    return this.op1(
      names[te.op],
      [
        { t: "v", id: a },
        { t: "v", id: b },
      ],
      "i32",
    );
  }

  bigShift(te: Extract<TE, { k: "bigshift" }>): number {
    const a = this.expr(te.a)[0]!;
    const n = this.expr(te.b)[0]!;
    if (te.b.ty.k === "big" && te.b.ty.name === "i64") {
      const z = this.iconst("i64", 0);
      const neg = this.op1(
        "icmp.slt.i64",
        [
          { t: "v", id: n },
          { t: "v", id: z },
        ],
        "i32",
      );
      this.trapIf(neg, "shift", 8, te.loc);
    }
    const signed = isSigned(te.ty);
    const av: Operand = { t: "v", id: a };
    const nv: Operand = { t: "v", id: n };
    if (te.op === "shr") return this.op1(signed ? "ashr.big" : "lshr.big", [av, nv], "i64");
    const r = this.op1("shl.big", [av, nv], "i64");
    if (te.wrap) return r;
    // Overflowed iff shifting back doesn't recover the value.
    const back = this.op1(signed ? "ashr.big" : "lshr.big", [{ t: "v", id: r }, nv], "i64");
    const lost = this.op1("icmp.ne.i64", [{ t: "v", id: back }, av], "i32");
    this.trapIf(lost, "overflow", 1, te.loc);
    return r;
  }

  cmp(te: Extract<TE, { k: "cmp" }>): number {
    const a = this.expr(te.a)[0]!;
    const b = this.expr(te.b)[0]!;
    const ty = te.a.ty;
    const ops: Operand[] = [
      { t: "v", id: a },
      { t: "v", id: b },
    ];
    if (ty.k === "float") return this.op1(`fcmp.${te.op}.${ty.name}`, ops, "i32");
    const t = leaves(ty)[0] ?? "i32";
    if (te.op === "eq" || te.op === "ne") return this.op1(`icmp.${te.op}.${t}`, ops, "i32");
    return this.op1(
      `icmp.${isSigned(ty) ? "s" : "u"}${te.op === "le" ? "le" : te.op === "lt" ? "lt" : te.op === "gt" ? "gt" : "ge"}.${t}`,
      ops,
      "i32",
    );
  }

  logic(te: Extract<TE, { k: "logic" }>): number {
    const key = `tmp${this.nextTemp--}:0`;
    const a = this.expr(te.a)[0]!;
    this.write(key, "i32", a);
    const rhs = this.newBlock();
    const merge = this.newBlock();
    if (te.op === "and") this.brif(a, rhs, merge);
    else this.brif(a, merge, rhs);
    this.seal(rhs);
    this.cur = rhs;
    const b = this.expr(te.b)[0]!;
    this.write(key, "i32", b);
    this.br(merge);
    this.seal(merge);
    this.cur = merge;
    return this.read(key, "i32");
  }

  cond(te: Extract<TE, { k: "cond" }>): number[] {
    const c = this.expr(te.c)[0]!;
    const base = this.nextTemp--;
    const then = this.newBlock();
    const other = this.newBlock();
    const merge = this.newBlock();
    this.brif(c, then, other);
    this.seal(then);
    this.seal(other);
    const tys = leaves(te.ty);
    this.cur = then;
    const a = this.expr(te.a);
    if (te.a.ty.k !== "never") {
      tys.forEach((t, i) => {
        this.write(`tmp${base}:${i}`, t, a[i]!);
      });
    }
    this.br(merge);
    this.cur = other;
    const b = this.expr(te.b);
    if (te.b.ty.k !== "never") {
      tys.forEach((t, i) => {
        this.write(`tmp${base}:${i}`, t, b[i]!);
      });
    }
    this.br(merge);
    this.seal(merge);
    this.cur = merge;
    return tys.map((t, i) => this.read(`tmp${base}:${i}`, t));
  }

  unionLit(te: Extract<TE, { k: "ulit" }>): number[] {
    const u = te.ty;
    if (u.k !== "union") throw new Error("union literal of a non-union type");
    const values = new Map<string, number[]>();
    for (const f of te.fields) values.set(f.name, this.expr(f.val));
    const out: number[] = [this.iconst("i32", tagLeaf(te.variant.tag, this.ctx.strings))];
    const slots: (number | null)[] = u.slots.map(() => null);
    for (const [name, positions] of te.variant.slots) {
      const vals = values.get(name) ?? [];
      positions.forEach((at, i) => {
        slots[at] = vals[i]!;
      });
    }
    u.slots.forEach((t, i) => {
      out.push(slots[i] ?? this.zero(t));
    });
    return out;
  }

  zero(t: TirType): number {
    const v = this.newVal(t);
    this.cur.instrs.push(zeroInstr(t, v));
    return v;
  }

  field(te: Extract<TE, { k: "field" }>): number[] {
    const obj = this.expr(te.obj);
    const t = te.obj.ty;
    if (t.k === "rec") {
      let at = 0;
      for (const f of t.fields) {
        const n = leaves(f.ty).length;
        if (f.name === te.name) return obj.slice(at, at + n);
        at += n;
      }
      throw new Error(`no field ${te.name}`);
    }
    if (t.k === "union") {
      if (te.name === t.tag) return [obj[0]!];
      const slots = te.variant?.slots.get(te.name);
      if (slots === undefined) throw new Error(`no field ${te.name}`);
      return slots.map((s) => obj[s + 1]!);
    }
    throw new Error("field of a non-record");
  }

  conv(te: Extract<TE, { k: "conv" }>): number[] {
    const vals = this.expr(te.val);
    const from = te.val.ty;
    const to = te.ty;
    if (from.k === "int" && to.k === "float" && to.name === "f64") {
      const op = isSigned(from) ? "sitofp.f64" : "uitofp.f64";
      return [this.op1(op, [{ t: "v", id: vals[0]! }], "f64")];
    }
    if (from.k === "int" && from.name === "usize" && to.k === "int" && to.name !== "usize") {
      return [this.op1("trunc.i32", [{ t: "v", id: vals[0]! }], "i32")];
    }
    if (from.k === "float" && to.k === "float" && from.name === "f32" && to.name === "f64") {
      return [this.op1("fpromote", [{ t: "v", id: vals[0]! }], "f64")];
    }
    if (to.k === "int" && to.name === "usize" && from.k === "int" && from.name !== "usize") {
      return [this.op1("zext.ix", [{ t: "v", id: vals[0]! }], "ix")];
    }
    // R7: a typed array's pointer held as a usize in its field's runtime class (lowered code's `cast`, emit-tsl.ts's
    // arrFieldClass), and back: the same bits
    if (from.k === "ref" && to.k === "int" && to.name === "usize")
      return [this.op1("bitcast.ix", [{ t: "v", id: vals[0]! }], "ix")];
    if (from.k === "int" && from.name === "usize" && to.k === "ref")
      return [this.op1("bitcast.ptr", [{ t: "v", id: vals[0]! }], "ptr")];
    return vals;
  }

  /** What compiler/rt needs that TS has no words for: a double's bits, and a distance between two addresses. */
  tmkBuiltin(te: Extract<TE, { k: "builtin" }>): number {
    const arg = (i: number): number => this.expr(te.args[i]!)[0]!;
    const v = (id: number): { t: "v"; id: number } => ({ t: "v", id });
    switch (te.name) {
      case "tmk.f64hi": {
        const bits = this.op1("bitcast.i64", [v(arg(0))], "i64");
        const sh = this.op1("lshr.i64", [v(bits), v(this.iconst("i64", 32))], "i64");
        return this.op1("trunc.i32", [v(sh)], "i32");
      }
      case "tmk.f64lo":
        return this.op1("trunc.i32", [v(this.op1("bitcast.i64", [v(arg(0))], "i64"))], "i32");
      case "tmk.f64make": {
        const hi = this.op1("zext.i64", [v(arg(0))], "i64");
        const lo = this.op1("zext.i64", [v(arg(1))], "i64");
        const top = this.op1("shl.i64", [v(hi), v(this.iconst("i64", 32))], "i64");
        return this.op1("bitcast.f64", [v(this.op1("or.i64", [v(top), v(lo)], "i64"))], "f64");
      }
      case "tmk.ptrdiff": {
        const a = this.op1("bitcast.ix", [v(arg(0))], "ix");
        const b = this.op1("bitcast.ix", [v(arg(1))], "ix");
        return this.op1("sub.ix", [v(a), v(b)], "ix");
      }
      case "tmk.addrlo": {
        const bits = this.op1("bitcast.i64", [v(arg(0))], "i64");
        const sh = this.op1("lshr.i64", [v(bits), v(this.iconst("i64", 4))], "i64");
        return this.op1("trunc.i32", [v(sh)], "i32");
      }
      default:
        throw new Error(`no builtin ${te.name}`);
    }
  }

  builtin(te: Extract<TE, { k: "builtin" }>): number[] {
    const name = te.name;
    const loc = te.loc;
    if (name.startsWith("tmk.")) return [this.tmkBuiltin(te)];
    if (name.includes(".") && !name.startsWith("Math.") && name !== "fptosi.sat")
      return lowerNativeBuiltin(this, te);
    if (name === "enumValue") return lowerNativeBuiltin(this, te);
    if (name.startsWith("to") && name !== "toI32Sat") return [this.toConversion(te)];
    if (name.startsWith("wrap")) return [this.wrapConversion(te)];
    switch (name) {
      case "trap": {
        const a = te.args[0]!;
        if (a.k === "lit") {
          this.setTerm({ k: "trap", id: this.trapId("user", Number(a.value), loc) });
        } else {
          const code = this.expr(a)[0]!;
          this.emit(
            "intrinsic",
            [
              { t: "name", name: "trap.code" },
              { t: "v", id: code },
            ],
            [],
          );
          this.setTerm({ k: "unreachable" });
        }
        this.dead();
        return [];
      }
      case "assert": {
        const c = this.expr(te.args[0]!)[0]!;
        const bad = this.newBlock();
        const ok = this.newBlock();
        this.brif(c, ok, bad);
        this.seal(bad);
        this.seal(ok);
        this.cur = bad;
        const a = te.args[1]!;
        if (a.k === "lit") {
          this.setTerm({ k: "trap", id: this.trapId("assert", Number(a.value), loc) });
        } else {
          const code = this.expr(a)[0]!;
          this.emit(
            "intrinsic",
            [
              { t: "name", name: "trap.code" },
              { t: "v", id: code },
            ],
            [],
          );
          this.setTerm({ k: "unreachable" });
        }
        this.cur = ok;
        return [];
      }
      case "panic":
        for (const a of te.args) this.expr(a);
        this.setTerm({ k: "trap", id: this.trapId("panic", 10, loc) });
        this.dead();
        return [];
      case "log":
        for (const a of te.args) this.expr(a);
        return [];
      case "asUintN":
      case "asIntN":
        return this.expr(te.args[0]!);
      case "Math.imul": {
        const a = this.int32Operand(te.args[0]!);
        const b = this.int32Operand(te.args[1]!);
        return [
          this.op1(
            "mul.i32",
            [
              { t: "v", id: a },
              { t: "v", id: b },
            ],
            "i32",
          ),
        ];
      }
      case "Math.clz32": {
        const a = this.int32Operand(te.args[0]!);
        return this.emit(
          "intrinsic",
          [
            { t: "name", name: "clz32" },
            { t: "v", id: a },
          ],
          ["i32"],
        );
      }
      case "fptosi.sat":
        return [this.op1("fptosi.sat.i32", [{ t: "v", id: this.expr(te.args[0]!)[0]! }], "i32")];
      case "Math.fround":
        return [this.op1("fdemote", [{ t: "v", id: this.expr(te.args[0]!)[0]! }], "f32")];
      case "Math.floor":
        return [this.op1("ffloor.f64", [{ t: "v", id: this.expr(te.args[0]!)[0]! }], "f64")];
      case "Math.round": {
        // JS rounds halves towards +infinity, and keeps -0: ceil, stepping down if that overshot.
        const x = this.expr(te.args[0]!)[0]!;
        const c = this.op1("fceil.f64", [{ t: "v", id: x }], "f64");
        const half = this.op1("fconst.f64", [{ t: "i", val: fbits64(0.5) }], "f64");
        const one = this.op1("fconst.f64", [{ t: "i", val: fbits64(1) }], "f64");
        const low = this.op1(
          "fsub.f64",
          [
            { t: "v", id: c },
            { t: "v", id: half },
          ],
          "f64",
        );
        const over = this.op1(
          "fcmp.gt.f64",
          [
            { t: "v", id: low },
            { t: "v", id: x },
          ],
          "i32",
        );
        const down = this.op1(
          "fsub.f64",
          [
            { t: "v", id: c },
            { t: "v", id: one },
          ],
          "f64",
        );
        return [
          this.op1(
            "select.f64",
            [
              { t: "v", id: over },
              { t: "v", id: down },
              { t: "v", id: c },
            ],
            "f64",
          ),
        ];
      }
      case "Math.ceil":
        return [this.op1("fceil.f64", [{ t: "v", id: this.expr(te.args[0]!)[0]! }], "f64")];
      case "Math.trunc":
        return [this.op1("ftrunc.f64", [{ t: "v", id: this.expr(te.args[0]!)[0]! }], "f64")];
      case "Math.sqrt":
        return [this.op1("fsqrt.f64", [{ t: "v", id: this.expr(te.args[0]!)[0]! }], "f64")];
      case "Math.abs":
        return [this.mathAbs(te)];
      case "Math.min":
      case "Math.max":
        return [this.mathMinMax(te, name === "Math.min")];
      default:
        throw new Error(`no lowering for builtin ${name}`);
    }
  }

  mathAbs(te: Extract<TE, { k: "builtin" }>): number {
    const a = this.expr(te.args[0]!)[0]!;
    if (te.ty.k === "float") return this.op1("fabs.f64", [{ t: "v", id: a }], "f64");
    const name = intOf(te.ty);
    if (name === null || !name.startsWith("i")) return a;
    const z = this.iconst("i32", 0);
    const n = this.op1(
      "sub.i32",
      [
        { t: "v", id: z },
        { t: "v", id: a },
      ],
      "i32",
    );
    const isNeg = this.op1(
      "icmp.slt.i32",
      [
        { t: "v", id: a },
        { t: "v", id: z },
      ],
      "i32",
    );
    const r = this.op1(
      "select.i32",
      [
        { t: "v", id: isNeg },
        { t: "v", id: n },
        { t: "v", id: a },
      ],
      "i32",
    );
    return this.op1(
      "range.chk.s.i32",
      [
        { t: "v", id: r },
        { t: "i", val: 0n },
        { t: "i", val: BigInt(INT_RANGE[name][1]) },
        this.trapOp("overflow", 1, te.loc),
      ],
      "i32",
    );
  }

  mathMinMax(te: Extract<TE, { k: "builtin" }>, isMin: boolean): number {
    const a = this.expr(te.args[0]!)[0]!;
    const b = this.expr(te.args[1]!)[0]!;
    const ops: Operand[] = [
      { t: "v", id: a },
      { t: "v", id: b },
    ];
    if (te.ty.k === "float") return this.op1(`${isMin ? "fmin" : "fmax"}.js.f64`, ops, "f64");
    const t = leaves(te.ty)[0]!;
    const cmpOp = `icmp.${isSigned(te.ty) ? "s" : "u"}lt.${t}`;
    const c = this.op1(cmpOp, ops, "i32");
    const first = isMin ? a : b;
    const second = isMin ? b : a;
    return this.op1(
      `select.${t}`,
      [
        { t: "v", id: c },
        { t: "v", id: first },
        { t: "v", id: second },
      ],
      t,
    );
  }

  /** to*: checked. The range check depends on both the source's and the target's signedness. */
  toConversion(te: Extract<TE, { k: "builtin" }>): number {
    const name = te.name;
    const arg = te.args[0]!;
    const target = te.ty;
    const loc = te.loc;
    if (name === "toF64") return this.toF64(arg);
    if (arg.k === "lit") return this.toFromLiteral(arg, target, loc);
    const src = arg.ty;
    const v = this.expr(arg)[0]!;
    if (src.k === "float") return this.toFromFloat(v, src.name, target, loc);
    if (src.k === "big") return this.toFromBig(v, src.name, target, loc);
    return this.toFromInt(v, src, target, loc);
  }

  toF64(arg: TE): number {
    if (arg.k === "lit" && (arg.ty.k === "lit-num" || arg.ty.k === "float")) {
      const n = arg.value as number;
      return this.op1("fconst.f64", [{ t: "i", val: fbits64(n + 0) }], "f64");
    }
    const v = this.expr(arg)[0]!;
    const src = arg.ty;
    if (src.k === "float") {
      // Adding zero sends -0 to +0, exactly as the host's toF64 does.
      const d = src.name === "f64" ? v : this.op1("fpromote", [{ t: "v", id: v }], "f64");
      const z = this.op1("fconst.f64", [{ t: "i", val: 0n }], "f64");
      return this.op1(
        "fadd.f64",
        [
          { t: "v", id: d },
          { t: "v", id: z },
        ],
        "f64",
      );
    }
    const conv = isSigned(src) ? "sitofp.f64" : "uitofp.f64";
    return this.op1(conv, [{ t: "v", id: v }], "f64");
  }

  toFromLiteral(arg: Extract<TE, { k: "lit" }>, target: Ty, loc: string): number {
    const v = arg.value as number | bigint;
    let ok: boolean;
    if (target.k === "int") {
      const [lo, hi] = INT_RANGE[target.name];
      ok = (typeof v === "bigint" || Number.isInteger(v)) && v >= lo && v <= hi;
    } else {
      const big = typeof v === "bigint" ? v : Number.isInteger(v) ? BigInt(v) : null;
      ok =
        big !== null &&
        (target.k === "big" && target.name === "u64"
          ? big >= 0n && big < 1n << 64n
          : big >= -(1n << 63n) && big < 1n << 63n);
    }
    const t = leaves(target)[0]!;
    if (!ok) {
      this.setTerm({ k: "trap", id: this.trapId("convert", 4, loc) });
      this.dead();
      return this.iconst(t, 0);
    }
    return this.iconst(t, BigInt(v === 0 ? 0 : v));
  }

  toFromInt(v0: number, src: Ty, target: Ty, loc: string): number {
    const signed = isSigned(src);
    const srcT = leaves(src)[0]!;
    if (target.k === "big") {
      let v = v0;
      if (signed && target.name === "u64")
        v = this.rangeChk("s", srcT, v, 0n, null, loc, BigInt(INT_RANGE.i32[1]));
      return this.op1(signed ? "sext.i64" : "zext.i64", [{ t: "v", id: v }], "i64");
    }
    const name = intOf(target)!;
    const [lo, hi] = INT_RANGE[name];
    if (name === "usize") {
      if (srcT === "ix") return v0;
      const v = signed
        ? this.rangeChk("s", "i32", v0, 0n, null, loc, BigInt(INT_RANGE.i32[1]))
        : v0;
      return this.op1("zext.ix", [{ t: "v", id: v }], "ix");
    }
    // The source's interpretation decides the comparison, and the target's range is clamped to it.
    if (signed) {
      const clampedHi = Math.min(hi, INT_RANGE.i32[1]);
      if (lo <= -2147483648 && clampedHi >= 2147483647) return v0;
      return this.rangeChk("s", "i32", v0, BigInt(lo), null, loc, BigInt(clampedHi));
    }
    const low = BigInt(Math.max(lo, 0));
    const v = this.rangeChk("u", srcT, v0, low, null, loc, BigInt(hi));
    return srcT === "ix" ? this.op1("trunc.i32", [{ t: "v", id: v }], "i32") : v;
  }

  rangeChk(
    s: string,
    t: TirType,
    v: number,
    lo: bigint,
    hiOp: Operand | null,
    loc: string,
    hi: bigint = 0n,
  ): number {
    return this.op1(
      `range.chk.${s}.${t}`,
      [
        { t: "v", id: v },
        { t: "i", val: lo },
        hiOp ?? { t: "i", val: hi },
        this.trapOp("convert", 4, loc),
      ],
      t,
    );
  }

  toFromBig(v: number, srcName: "u64" | "i64", target: Ty, loc: string): number {
    const s = srcName === "u64" ? "u" : "s";
    if (target.k === "big") {
      if (target.name === srcName) return v;
      // Only the shared half of the two ranges survives a change of signedness.
      return this.rangeChk(s, "i64", v, 0n, null, loc, (1n << 63n) - 1n);
    }
    const name = intOf(target)!;
    if (name === "usize") {
      const c = this.rangeChk(s, "i64", v, 0n, { t: "ixmax" }, loc);
      return this.op1("trunc.ix", [{ t: "v", id: c }], "ix");
    }
    const [lo, hi] = INT_RANGE[name];
    const low = s === "u" ? BigInt(Math.max(lo, 0)) : BigInt(lo);
    const c = this.rangeChk(s, "i64", v, low, null, loc, BigInt(hi));
    return this.op1("trunc.i32", [{ t: "v", id: c }], "i32");
  }

  toFromFloat(v0: number, srcName: "f32" | "f64", target: Ty, loc: string): number {
    const v = srcName === "f64" ? v0 : this.op1("fpromote", [{ t: "v", id: v0 }], "f64");
    let lo: number;
    let hiExclusive: number;
    if (target.k === "big") {
      lo = target.name === "u64" ? 0 : -(2 ** 63);
      hiExclusive = target.name === "u64" ? 2 ** 64 : 2 ** 63;
    } else {
      const [a, b] = INT_RANGE[intOf(target)!];
      lo = a;
      hiExclusive = b + 1;
    }
    const fc = (n: number): number => this.op1("fconst.f64", [{ t: "i", val: fbits64(n) }], "f64");
    const vv: Operand = { t: "v", id: v };
    const whole = this.op1(
      "fcmp.eq.f64",
      [{ t: "v", id: this.op1("ftrunc.f64", [vv], "f64") }, vv],
      "i32",
    );
    const geLo = this.op1("fcmp.ge.f64", [vv, { t: "v", id: fc(lo) }], "i32");
    const ltHi = this.op1("fcmp.lt.f64", [vv, { t: "v", id: fc(hiExclusive) }], "i32");
    const both = this.op1(
      "and.i32",
      [
        { t: "v", id: geLo },
        { t: "v", id: ltHi },
      ],
      "i32",
    );
    const ok = this.op1(
      "and.i32",
      [
        { t: "v", id: whole },
        { t: "v", id: both },
      ],
      "i32",
    );
    const z = this.iconst("i32", 0);
    const bad = this.op1(
      "icmp.eq.i32",
      [
        { t: "v", id: ok },
        { t: "v", id: z },
      ],
      "i32",
    );
    this.trapIf(bad, "convert", 4, loc);
    if (target.k === "big") {
      return this.op1(target.name === "u64" ? "fptoui.sat.i64" : "fptosi.sat.i64", [vv], "i64");
    }
    const name = intOf(target)!;
    if (name === "usize") {
      const wide = this.op1("fptoui.sat.i64", [vv], "i64");
      const c = this.rangeChk("u", "i64", wide, 0n, { t: "ixmax" }, loc);
      return this.op1("trunc.ix", [{ t: "v", id: c }], "ix");
    }
    return this.op1(name.startsWith("i") ? "fptosi.sat.i32" : "fptoui.sat.i32", [vv], "i32");
  }

  /** wrap*: truncating, so it goes through a 32-bit pattern and then narrows. */
  wrapConversion(te: Extract<TE, { k: "builtin" }>): number {
    const arg = te.args[0]!;
    const target = intOf(te.ty)!;
    if (arg.k === "lit") {
      const v = arg.value as number | bigint;
      const low = typeof v === "bigint" ? Number(BigInt.asIntN(32, v)) : v | 0;
      return this.iconst("i32", narrowConst(low, target));
    }
    let v = this.expr(arg)[0]!;
    const src = arg.ty;
    if (src.k === "float") {
      const d = src.name === "f64" ? v : this.op1("fpromote", [{ t: "v", id: v }], "f64");
      v = this.op1("js.toint32", [{ t: "v", id: d }], "i32");
    } else if (src.k === "big" || (src.k === "int" && src.name === "usize")) {
      v = this.op1("trunc.i32", [{ t: "v", id: v }], "i32");
    }
    const vv: Operand = { t: "v", id: v };
    switch (target) {
      case "u8":
        return this.op1("and.i32", [vv, { t: "v", id: this.iconst("i32", 0xff) }], "i32");
      case "u16":
        return this.op1("and.i32", [vv, { t: "v", id: this.iconst("i32", 0xffff) }], "i32");
      case "i8": {
        const n = this.op1("trunc.i8", [vv], "i8");
        return this.op1("sext.i32", [{ t: "v", id: n }], "i32");
      }
      case "i16": {
        const n = this.op1("trunc.i16", [vv], "i16");
        return this.op1("sext.i32", [{ t: "v", id: n }], "i32");
      }
      default:
        return v;
    }
  }

  finish(): Func {
    if (!this.terminated.has(this.cur.id)) {
      if (this.ret.k === "void") {
        this.giveBackRegion();
        this.setTerm({ k: "ret", vals: [] });
      } else this.setTerm({ k: "unreachable" });
    }
    for (const b of this.f.blocks) this.seal(b);
    removeTrivialParams(this.f);
    return this.f;
  }
}

function narrowConst(low: number, target: IntName): number {
  switch (target) {
    case "u8":
      return low & 0xff;
    case "u16":
      return low & 0xffff;
    case "i8":
      return (low << 24) >> 24;
    case "i16":
      return (low << 16) >> 16;
    default:
      return low;
  }
}

function elemKind(e: ElemName): Ty {
  if (e === "u64" || e === "i64") return { k: "big", name: e };
  if (e === "f32" || e === "f64") return { k: "float", name: e };
  return { k: "int", name: e };
}

function zeroInstr(t: TirType, v: number): { op: string; ops: Operand[]; res: number[] } {
  if (t === "f32" || t === "f64") {
    return { op: `fconst.${t}`, ops: [{ t: "i", val: 0n }], res: [v] };
  }
  return { op: `iconst.${t}`, ops: [{ t: "i", val: 0n }], res: [v] };
}

/** Removes block parameters whose incoming values are all one value, to a fixed point. */
function removeTrivialParams(f: Func): void {
  const reachable = reachableBlocks(f);
  const replaced = new Map<number, number>();
  const resolve = (v: number): number => {
    let cur = v;
    for (let guard = 0; guard < 1 << 20; guard++) {
      const n = replaced.get(cur);
      if (n === undefined) return cur;
      cur = n;
    }
    throw new Error("cycle in value replacement");
  };
  const incoming = new Map<number, Edge[]>();
  for (const b of f.blocks) {
    if (!reachable.has(b.id)) continue;
    for (const e of edgesOf(b.term)) {
      const list = incoming.get(e.block) ?? [];
      list.push(e);
      incoming.set(e.block, list);
    }
  }
  let changed = true;
  for (let round = 0; changed && round <= f.types.length + 1; round++) {
    changed = false;
    for (const b of f.blocks) {
      if (!reachable.has(b.id)) continue;
      const edges = incoming.get(b.id) ?? [];
      for (let i = b.params.length - 1; i >= 0; i--) {
        const p = b.params[i]!;
        let same: number | null = null;
        let trivial = true;
        for (const e of edges) {
          const a = resolve(e.args[i]!);
          if (a === p || a === same) continue;
          if (same !== null) {
            trivial = false;
            break;
          }
          same = a;
        }
        if (!trivial || same === null) continue;
        replaced.set(p, same);
        b.params.splice(i, 1);
        for (const e of edges) e.args.splice(i, 1);
        changed = true;
      }
    }
  }
  for (const b of f.blocks) {
    for (const ins of b.instrs) {
      ins.ops = ins.ops.map((o) => (o.t === "v" ? { t: "v", id: resolve(o.id) } : o));
    }
    for (const e of edgesOf(b.term)) e.args = e.args.map(resolve);
    const t = b.term;
    if (t.k === "brif") t.cond = resolve(t.cond);
    if (t.k === "switch") t.val = resolve(t.val);
    if (t.k === "ret") t.vals = t.vals.map(resolve);
  }
}

function reachableBlocks(f: Func): Set<number> {
  const byId = new Map<number, Block>();
  for (const b of f.blocks) byId.set(b.id, b);
  const seen = new Set<number>([f.blocks[0]!.id]);
  const stack = [f.blocks[0]!];
  while (stack.length > 0) {
    const b = stack.pop()!;
    for (const e of edgesOf(b.term)) {
      if (!seen.has(e.block)) {
        seen.add(e.block);
        stack.push(byId.get(e.block)!);
      }
    }
  }
  return seen;
}

function globalOf(g: GlobalDef, strings: Map<string, number>): Global | null {
  if (g.table !== undefined) return null;
  if (g.object !== undefined) {
    const o = g.object;
    const out: Global = {
      name: g.name,
      size: o.total,
      align: Math.max(o.align, 8),
      section: "data",
    };
    if (o.bytes.some((b) => b !== 0)) {
      const bytes = new Uint8Array(o.total);
      bytes.set(o.bytes, o.off);
      out.bytes = bytes;
    }
    return out;
  }
  if (g.ty.k === "cls" || g.ty.k === "ptr" || g.ty.k === "fn") {
    return { name: g.name, size: 8, align: 8, section: "data", bytes: new Uint8Array(8) };
  }
  if (g.array !== undefined) {
    const a = g.array;
    const out: Global = {
      name: g.name,
      size: a.length * elemSize(a.elem),
      align: elemSize(a.elem),
      section: "data",
    };
    if (a.bytes !== undefined) out.bytes = a.bytes;
    return out;
  }
  // Scalars. usize takes 8 bytes on every target, so TIR doesn't depend on the pointer width.
  const ty = g.ty;
  const size =
    ty.k === "big" ||
    (ty.k === "float" && ty.name === "f64") ||
    (ty.k === "int" && ty.name === "usize")
      ? 8
      : ty.k === "int" && (ty.name === "u8" || ty.name === "i8")
        ? 1
        : ty.k === "int" && (ty.name === "u16" || ty.name === "i16")
          ? 2
          : 4;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  const v = g.value;
  if (typeof v === "bigint") view.setBigUint64(0, BigInt.asUintN(64, v), true);
  else if (ty.k === "float") {
    if (ty.name === "f64") view.setFloat64(0, v as number, true);
    else view.setFloat32(0, v as number, true);
  } else if (typeof v === "number") {
    if (size === 8) view.setBigUint64(0, BigInt(v), true);
    else if (size === 4) view.setUint32(0, v >>> 0, true);
    else if (size === 2) view.setUint16(0, v & 0xffff, true);
    else view.setUint8(0, v & 0xff);
  } else if (typeof v === "boolean") {
    view.setUint32(0, v ? 1 : 0, true);
  } else if (typeof v === "string") {
    view.setUint32(0, strings.get(v)!, true);
  }
  return { name: g.name, size, align: size, section: "data", bytes };
}

function tableHelper(g: GlobalDef, thunks: boolean): Func {
  const table = g.table!;
  const types: TirType[] = ["ix"];
  const blocks: Block[] = [];
  const cases: { key: bigint; to: Edge }[] = [];
  table.forEach((inst, i) => {
    const v = types.length;
    types.push("ptr");
    blocks.push({
      id: i + 1,
      params: [],
      instrs: [
        {
          op: "funcaddr",
          ops: [{ t: "sym", name: thunks ? thunkName(inst.tirName) : inst.tirName }],
          res: [v],
        },
      ],
      term: { k: "ret", vals: [v] },
    });
    cases.push({ key: BigInt(i), to: { block: i + 1, args: [] } });
  });
  const trapBlock = table.length + 1;
  blocks.push({ id: trapBlock, params: [], instrs: [], term: { k: "unreachable" } });
  const entry: Block = {
    id: 0,
    params: [],
    instrs: [],
    term: { k: "switch", val: 0, cases, def: { block: trapBlock, args: [] } },
  };
  return {
    name: `__table.${g.name}`,
    params: [0],
    rets: ["ptr"],
    attrs: [],
    blocks: [entry, ...blocks],
    types,
  };
}

/** Lowers a typed module to canonical TIR. */
export function lowerToTir(tm: TypedModule): Module {
  const ctx: ModuleCtx = {
    m: { sigs: [], globals: [], funcs: [], traps: [], externs: [] },
    strings: tm.strings,
    nextTrap: 1,
    sigKeys: new Map(),
    tables: new Set(),
    thunks: new Map(),
    // R13: in a lowered `strict` package the call arena is always there, and an arena array whose header escape analysis
    // left on the stack still takes its buffers from it (region.ts's `arenaBytes`)
    region: (tm.region?.sites ?? 0) > 0 || tm.region?.arenaBytes === true,
  };
  if (tm.nativeOnly === true) computeCaptures(tm);
  for (const g of tm.globals) {
    const out = globalOf(g, tm.strings);
    if (out !== null) ctx.m.globals.push(out);
  }
  for (const inst of tm.funcs) {
    const fl = new FnLower(ctx, inst);
    fl.stmts(inst.body);
    ctx.m.funcs.push(fl.finish());
  }
  for (const g of tm.globals) {
    if (g.table !== undefined && ctx.tables.has(g.name)) {
      ctx.m.funcs.push(tableHelper(g, g.ty.k === "fn" && g.ty.env === true));
    }
  }
  if (tm.nativeOnly === true) {
    const statics = buildStatics(tm, ctx);
    if (statics !== null) ctx.m.funcs.push(statics);
    ctx.m.funcs.push(...buildThunks(ctx));
  }
  if (tm.extraGlobals !== undefined) ctx.m.globals.push(...tm.extraGlobals);
  if (tm.extraFuncs !== undefined) {
    ctx.m.funcs.push(...tm.extraFuncs.map((f) => internRtSigs(f, ctx)));
  }
  // Hand-written runtime functions keep their own trap numbers, far above the generated ones.
  if (tm.extraTraps !== undefined) ctx.m.traps.push(...tm.extraTraps);
  if (tm.externs !== undefined) ctx.m.externs.push(...tm.externs);
  ctx.m.funcs.sort((a, b) => cmpStr(a.name, b.name));
  return canonicalize(ctx.m);
}

/** A runtime function's indirect call names the signature in the runtime's own text (RT_SIGS). */
function internRtSigs(f: Func, ctx: ModuleCtx): Func {
  for (const b of f.blocks) {
    for (const ins of b.instrs) {
      const s = ins.ops[0];
      if (ins.op !== "call.indirect" || s?.t !== "sig") continue;
      const sig = RT_SIGS[s.id]!;
      const key = `${sig.params.join(",")}>${sig.rets.join(",")}`;
      let id = ctx.sigKeys.get(key);
      if (id === undefined) {
        id = ctx.m.sigs.length;
        ctx.m.sigs.push(sig);
        ctx.sigKeys.set(key, id);
      }
      ins.ops[0] = { t: "sig", id };
    }
  }
  return f;
}
