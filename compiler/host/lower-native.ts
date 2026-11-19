// TIR for native TSL's objects: class fields, stack `new`, closures, raw pointers, generation checks and
// layout views (SPEC 3.4, 3.5, 4.3). lower.ts calls in here for these, and otherwise knows nothing of them.
import ts from "typescript";
import type { Block, Func, Operand, TirType } from "../tir/ir.ts";
import type { FnLower, ModuleCtx } from "./lower.ts";
import {
  elemSize,
  leaves,
  type ClassInst,
  type ClsField,
  type ElemName,
  type FuncInst,
  type GenCheck,
  type TE,
  type Ty,
  type TypedModule,
  type Var,
} from "./types.ts";
import { loweredRcHeapClass, stackTagged, untaggedCounted } from "./expand-rc.ts";
import { tslOptOff } from "./program.ts";
import { walkStmts, walkTE } from "./walk.ts";

// A slot is [next free slot: u64][generation: u32][owner: u32][object]. gen.chk only reads the word before the
// object, so it, and a static object's one-word prefix, don't depend on the rest of this.
const SLOT_PREFIX = 16;

/**
 * R28: whether every reference to a class's objects is its object's address, with no tag in its top bits, so a field is
 * read and written through it with no mask (relative_import's one `ubfx` a read, R19). A class of a lowered `rc` package
 * (`loweredRcHeapClass`: counted exactly, never `@tsl.stack`, every object in a slot a store's `make` placed) whose
 * references are untagged (R8's `untaggedCounted`). Its references come from: `placeObject` and `placeTail`, which give the
 * address for such a class; `objectAt<C>`, likewise; and freeing's and the collector's release call, whose object is an
 * `objectAt<Counted0>`, tagged, which `callRelease`'s arm for such a class hands over masked (`rc.untag`, elab-native.ts).
 * A lowered package can't import @tsl/unsafe (TSL1023), so it has no other way to make one, and the libraries that hold
 * them (`JsRoomArray`, `JsMap`, `Weak`) only store and load them whole. 3.5's "References with no tag", D78.
 */
function untaggedRcClass(c: ClassInst | undefined): boolean {
  if (c === undefined || r28LowerOff("untag")) return false;
  // `tmk milestone pipe-d`'s injected bug: every class's references read with no mask. Never set otherwise.
  if (process.env.TMK_TEST_TSL === "r28-untag-any") return true;
  return untaggedCounted(c.decl) && loweredRcHeapClass(c.decl);
}

/** R28: the most bytes placeTail zeroes in line, a word at a time (4 instructions a word, to the routine's 3 and its 18). */
const ZERO_INLINE = 128;

/** R28's lowering put back as it was, a measurement and tools/r28-pins.ts's (`TMK_R28_OFF=zero`). */
function r28LowerOff(part: string): boolean {
  return (process.env.TMK_R28_OFF ?? "").split(",").includes(part);
}

export function thunkName(name: string): string {
  return `${name}$thunk`;
}

const v = (id: number): Operand => ({ t: "v", id });

function bswap(fl: FnLower, t: "i32" | "i64", x: number, bytes: number): number {
  let out = fl.iconst(t, 0);
  for (let i = 0; i < bytes; i++) {
    const shr = fl.iconst(t, i * 8);
    const shl = fl.iconst(t, (bytes - 1 - i) * 8);
    const mask = fl.iconst(t, 0xff);
    const byte = fl.op1(`and.${t}`, [v(fl.op1(`lshr.${t}`, [v(x), v(shr)], t)), v(mask)], t);
    out = fl.op1(`or.${t}`, [v(out), v(fl.op1(`shl.${t}`, [v(byte), v(shl)], t))], t);
  }
  return out;
}

/** A value of this type from memory, in its register form. `width` is the bytes an enum or literal takes. */
export function loadMem(fl: FnLower, ty: Ty, addr: number, be: boolean, width: number): number[] {
  const a = v(addr);
  switch (ty.k) {
    case "int": {
      let r = fl.loadScalar(ty, addr);
      if (be && ty.name !== "usize") r = bswapNarrow(fl, r, ty.name);
      return [r];
    }
    case "big": {
      const r = fl.op1("load.i64.na", [a], "i64");
      return [be ? bswap(fl, "i64", r, 8) : r];
    }
    case "float":
      return [fl.op1(`load.${ty.name}.na`, [a], ty.name)];
    case "bool": {
      const raw = fl.op1("load.i8.na", [a], "i8");
      return [fl.op1("zext.i32", [v(raw)], "i32")];
    }
    case "enum":
    case "lits": {
      if (width === 4) {
        const r = fl.op1("load.i32.na", [a], "i32");
        return [be ? bswap(fl, "i32", r, 4) : r];
      }
      const t: TirType = width === 1 ? "i8" : "i16";
      const raw = fl.op1(`load.${t}.na`, [a], t);
      const z = fl.op1("zext.i32", [v(raw)], "i32");
      return [be ? bswap(fl, "i32", z, width) : z];
    }
    case "cls":
    case "ptr":
      return [fl.op1("load.i64.na", [a], "i64")];
    case "fn":
      return ty.env === true
        ? [fl.op1("load.ptr.na", [a], "ptr"), fl.zero("ptr")]
        : [fl.op1("load.ptr.na", [a], "ptr")];
    default:
      throw new Error(`no value of type ${ty.k} in memory`);
  }
}

function bswapNarrow(fl: FnLower, r: number, name: string): number {
  if (name === "u8" || name === "i8") return r;
  return bswap(fl, "i32", r, name.endsWith("16") ? 2 : 4);
}

export function storeMem(
  fl: FnLower,
  ty: Ty,
  addr: number,
  vals: number[],
  be: boolean,
  width = 4,
): void {
  const a = v(addr);
  const x = vals[0]!;
  switch (ty.k) {
    case "int": {
      const swapped = be && ty.name !== "usize" ? bswapNarrow(fl, x, ty.name) : x;
      fl.storeScalar(ty, addr, swapped);
      return;
    }
    case "big":
      fl.emit("store.i64.na", [a, v(be ? bswap(fl, "i64", x, 8) : x)], []);
      return;
    case "float":
      fl.emit(`store.${ty.name}.na`, [a, v(x)], []);
      return;
    case "bool": {
      const n = fl.op1("trunc.i8", [v(x)], "i8");
      fl.emit("store.i8.na", [a, v(n)], []);
      return;
    }
    case "enum":
    case "lits": {
      const out = be ? bswap(fl, "i32", x, width) : x;
      if (width === 4) fl.emit("store.i32.na", [a, v(out)], []);
      else {
        const t: TirType = width === 1 ? "i8" : "i16";
        fl.emit(`store.${t}.na`, [a, v(fl.op1(`trunc.${t}`, [v(out)], t))], []);
      }
      return;
    }
    case "cls":
    case "ptr":
      fl.emit("store.i64.na", [a, v(x)], []);
      return;
    case "fn":
      // Only a code pointer is ever stored: a closure with an environment can't be (TSL3003).
      fl.emit("store.ptr.na", [a, v(x)], []);
      return;
    default:
      throw new Error(`no value of type ${ty.k} in memory`);
  }
}

function fieldAddr(
  fl: FnLower,
  obj: TE,
  f: ClsField,
  check: GenCheck,
  loc: string,
  c?: ClassInst,
): number {
  const ref = fl.expr(obj)[0]!;
  // A plain class's references have no tag (D64): the pointer is the reference, with nothing to mask. R28: nor has a
  // lowered `rc` package's heap class's (untaggedRcClass): every reference to one is its object's address.
  const base =
    (c?.plain === true || untaggedRcClass(c)) && check === false
      ? fl.i64ToPtr(ref)
      : refChecked(fl, ref, check, loc);
  return fl.memAddr(base, f.off);
}

function refChecked(fl: FnLower, ref: number, check: GenCheck, loc: string): number {
  if (check === "tagged") return tagCheck(fl, ref, loc);
  return check ? fl.genChk(ref, loc) : fl.refAddr(ref);
}

/** In a manual package a reference may be plain, with no prefix, or a Slab's, which stays checked (SPEC 3.5). */
function tagCheck(fl: FnLower, r: number, loc: string): number {
  const tag = fl.op1("lshr.i64", [v(r), v(fl.iconst("i64", 48))], "i64");
  const has = fl.op1("icmp.ne.i64", [v(tag), v(fl.iconst("i64", 0))], "i32");
  const chk = fl.newBlock();
  const cont = fl.newBlock();
  fl.brif(has, chk, cont);
  fl.seal(chk);
  fl.cur = chk;
  fl.genChk(r, loc);
  fl.br(cont);
  fl.seal(cont);
  fl.cur = cont;
  return fl.refAddr(r);
}

const STATIC_GEN = 0xffff;

/** A literal zero, false or null: what a zeroed object already holds. Not `-0`, whose sign bit is set. */
function isZeroLit(te: TE): boolean {
  if (te.k !== "lit") return false;
  const x = te.value;
  return x === false || x === 0n || (typeof x === "number" && Object.is(x, 0));
}

/** An initialiser with no effect to keep: a literal. */
function pureInit(te: TE): boolean {
  return te.k === "lit";
}

/**
 * Fields a constructor stores before anything can read the object: its leading statements, each `this.f = v` where `v`
 * reads no variable that can be `this`, calls nothing and reads no memory. A field stored there needs no initialiser.
 */
function ctorFirstStores(ctor: FuncInst | null): Set<ClsField> {
  const out = new Set<ClsField>();
  if (ctor === null || ctor.params.length === 0) return out;
  const self = ctor.params[0]!;
  const safe = (e: TE): boolean => {
    switch (e.k) {
      case "lit":
        return true;
      case "var":
        return e.v !== self && e.v.ty.k !== "cls";
      case "arith":
      case "farith":
      case "bit":
      case "cmp":
        return safe(e.a) && safe(e.b);
      case "neg":
      case "not":
      case "bitnot":
        return safe(e.a);
      case "conv":
        return safe(e.val);
      default:
        return false;
    }
  };
  for (const st of ctor.body) {
    if (st.k !== "expr") break;
    const e = st.e;
    if (e.k !== "osetfield" || e.obj.k !== "var" || e.obj.v !== self || !safe(e.val)) break;
    out.add(e.f);
  }
  return out;
}

/**
 * The bytes an object of a class with a tail takes with n elements (D69), as tailBytes in types.ts says: the fixed part,
 * then the tail, rounded to 8 as the allocators round. A tail's length is a u32, so a longer one is out of memory, trap 14.
 */
function tailSizeIx(fl: FnLower, c: ClassInst, n: number, loc: string): number {
  const t = c.tail!;
  const big = fl.op1("icmp.ugt.ix", [v(n), v(fl.iconst("ix", 0xffffffffn))], "i32");
  fl.trapIf(big, "memory", 14, loc);
  const a = Math.max(c.align, 8);
  // `tmk milestone pipe-d`'s injected bug: a tail sized one element short. Never set otherwise.
  const extra = process.env.TMK_TEST_TSL === "tail-short" ? -t.esize : 0;
  const scaled = fl.op1("mul.ix", [v(n), v(fl.iconst("ix", t.esize))], "ix");
  const end = fl.op1("add.ix", [v(scaled), v(fl.iconst("ix", t.at + a - 1 + extra))], "ix");
  return fl.op1("and.ix", [v(end), v(fl.iconst("ix", BigInt.asUintN(64, ~BigInt(a - 1))))], "ix");
}

/** An object's tail length, a u32 in its fixed part, as an ix (D69). */
function tailLen(fl: FnLower, c: ClassInst, base: number): number {
  return fl.op1("zext.ix", [v(fl.memLoad(base, { t: "i32", off: c.tail!.f.off }))], "ix");
}

/** A `new` that escapes (SPEC 3.5). `leak`: never freed, so it's a static object made at run time. `manual`: plain. */
function heapObject(fl: FnLower, te: Extract<TE, { k: "new" }>): { p: number; self: number } {
  const callV = (name: string, n: number): number =>
    fl.emit(
      "call",
      [
        { t: "sym", name },
        { t: "v", id: n },
      ],
      ["ptr"],
    )[0]!;
  const call = (name: string, n: number): number => callV(name, fl.iconst("ix", n));
  const size = Math.max(te.c.size, 8);
  if (te.tail !== undefined) {
    // An object with a tail (D69): one block at its real size, and its length in the fixed part.
    const n = fl.expr(te.tail)[0]!;
    const bytes = tailSizeIx(fl, te.c, n, te.at ?? "");
    let p: number;
    let self: number;
    if (te.heap === "region") {
      // R9: the per-call region at its real size, zeroed as the region's memory is reused (region.ts)
      if (te.c.align > 8)
        throw new Error("a region object aligned past 8 (region.ts leaves one in the heap)");
      const zero = (at: number, n: number): void => {
        // the injected `region-tail-dirty` bug (R9): a tail in the region not zeroed
        if (process.env.TMK_TEST_TSL === "region-tail-dirty") return;
        fl.emit(
          "intrinsic",
          [{ t: "name", name: "mem.fill" }, v(at), v(fl.iconst("i32", 0)), v(n)],
          [],
        );
      };
      if (te.c.plain === true) {
        p = callV("__alloc", bytes);
        zero(p, bytes);
        self = fl.ptrToI64(p);
      } else {
        const withPrefix = fl.op1("add.ix", [v(bytes), v(fl.iconst("ix", 8))], "ix");
        p = fl.memAddr(callV("__alloc", withPrefix), 8);
        zero(p, bytes);
        fl.memStore(p, { t: "i32", off: -8 }, fl.iconst("i32", STATIC_GEN));
        self = tagged(fl, p, fl.iconst("i64", STATIC_GEN));
      }
    } else if (te.heap === "manual") {
      p = callV("__heap_alloc", bytes);
      if (process.env.TMK_TEST_TSL !== "manual-nofill")
        fl.emit(
          "intrinsic",
          [{ t: "name", name: "mem.fill" }, v(p), v(fl.iconst("i32", 0)), v(bytes)],
          [],
        );
      self = fl.ptrToI64(p);
    } else if (te.c.plain === true) {
      p = callV("__leak_alloc", bytes);
      self = fl.ptrToI64(p);
    } else {
      if (te.c.align > 8) throw new Error("a class with a tail is aligned to 8 at most");
      const withPrefix = fl.op1("add.ix", [v(bytes), v(fl.iconst("ix", 8))], "ix");
      p = fl.memAddr(callV("__leak_alloc", withPrefix), 8);
      fl.memStore(p, { t: "i32", off: -8 }, fl.iconst("i32", STATIC_GEN));
      self = tagged(fl, p, fl.iconst("i64", STATIC_GEN));
    }
    fl.memStore(p, { t: "i32", off: te.c.tail!.f.off }, fl.op1("trunc.i32", [v(n)], "i32"));
    return { p, self };
  }
  // R6: the per-call region, the module's call arena, which an export's return gives back (region.ts): zeroed, as it's
  // reused, and nothing in it outlives the export call, so a plain class's object is a plain pointer as in `leak`, and
  // another's has `leak`'s prefix of a generation that never changes.
  if (te.heap === "region") {
    if (te.c.align > 8)
      throw new Error("a region object aligned past 8 (region.ts leaves one in the heap)");
    if (te.c.plain === true) {
      // the injected `region-short` bug (R12): an object in the call arena given 8 bytes fewer than it takes
      const p = call("__alloc", process.env.TMK_TEST_TSL === "region-short" ? size - 8 : size);
      zeroFill(fl, p, size);
      return { p, self: fl.ptrToI64(p) };
    }
    const p = fl.memAddr(call("__alloc", size + 8), 8);
    zeroFill(fl, p, size);
    fl.memStore(p, { t: "i32", off: -8 }, fl.iconst("i32", STATIC_GEN));
    return { p, self: tagged(fl, p, fl.iconst("i64", STATIC_GEN)) };
  }
  // Nothing of a plain class can go stale (D64): in `leak` it's a plain pointer to its fields, with no prefix, as in `manual`.
  if (te.heap === "leak" && te.c.plain === true) {
    const p = call("__leak_alloc", size);
    return { p, self: fl.ptrToI64(p) };
  }
  if (te.heap === "manual") {
    const p = call("__heap_alloc", size);
    // `tmk milestone pipe-c`'s injected bug: the fill zeroed construction depends on (SPEC 3.5), left out. Never set otherwise.
    if (process.env.TMK_TEST_TSL !== "manual-nofill") zeroFill(fl, p, size);
    return { p, self: fl.ptrToI64(p) };
  }
  let p: number;
  if (te.c.align <= 8) {
    p = fl.memAddr(call("__leak_alloc", size + 8), 8);
  } else {
    const raw = fl.op1("bitcast.ix", [v(call("__leak_alloc", size + 24))], "ix");
    const up = fl.op1("add.ix", [v(raw), v(fl.iconst("ix", 23))], "ix");
    const mask = fl.iconst("ix", BigInt.asUintN(64, ~15n));
    p = fl.op1("bitcast.ptr", [v(fl.op1("and.ix", [v(up), v(mask)], "ix"))], "ptr");
  }
  fl.memStore(p, { t: "i32", off: -8 }, fl.iconst("i32", STATIC_GEN));
  return { p, self: tagged(fl, p, fl.iconst("i64", STATIC_GEN)) };
}

function enumCheck(fl: FnLower, x: number, ty: Ty, loc: string): void {
  if (ty.k !== "enum") return;
  let ok = fl.iconst("i32", 0);
  for (const m of ty.members.values()) {
    const eq = fl.op1("icmp.eq.i32", [v(x), v(fl.iconst("i32", BigInt(m)))], "i32");
    ok = fl.op1("or.i32", [v(ok), v(eq)], "i32");
  }
  const bad = fl.op1("icmp.eq.i32", [v(ok), v(fl.iconst("i32", 0))], "i32");
  fl.trapIf(bad, "convert", 4, loc);
}

function zeroFill(fl: FnLower, p: number, size: number): void {
  if (size <= 64) {
    const z = fl.iconst("i64", 0);
    for (let off = 0; off < size; off += 8) {
      const left = size - off;
      if (left >= 8) fl.memStore(p, { t: "i64", off }, z);
      else {
        const bytes = fl.iconst("i8", 0);
        for (let i = 0; i < left; i++) fl.memStore(p, { t: "i8", off: off + i }, bytes);
      }
    }
    return;
  }
  fl.emit(
    "intrinsic",
    [{ t: "name", name: "mem.fill" }, v(p), v(fl.iconst("i32", 0)), v(fl.iconst("ix", size))],
    [],
  );
}

/** A counted loop in TIR, for the typed-array methods. */
function loop(fl: FnLower, from: number, to: number, body: (i: number) => void): void {
  const key = `tmp${fl.nextTemp--}:0`;
  fl.write(key, "ix", from);
  const head = fl.newBlock();
  const inner = fl.newBlock();
  const exit = fl.newBlock();
  fl.br(head);
  fl.cur = head;
  const i = fl.read(key, "ix");
  fl.brif(fl.op1("icmp.ult.ix", [v(i), v(to)], "i32"), inner, exit);
  fl.seal(inner);
  fl.cur = inner;
  body(i);
  fl.write(key, "ix", fl.op1("add.ix", [v(fl.read(key, "ix")), v(fl.iconst("ix", 1))], "ix"));
  fl.br(head);
  fl.seal(head);
  fl.seal(exit);
  fl.cur = exit;
}

function minIx(fl: FnLower, a: number, b: number): number {
  const c = fl.op1("icmp.ult.ix", [v(a), v(b)], "i32");
  return fl.op1("select.ix", [v(c), v(a), v(b)], "ix");
}

function gep(fl: FnLower, base: number, idx: number, scale: number, off = 0): number {
  return fl.op1(
    "gep",
    [v(base), v(idx), { t: "i", val: BigInt(scale) }, { t: "i", val: BigInt(off) }],
    "ptr",
  );
}

/** Takes aligned, zeroed bytes from an arena's buffer. Past its end traps with code 2, as on the host. */
function arenaTake(fl: FnLower, arena: number, bytes: number, align: number, loc: string): number {
  const a = fl.refAddr(arena);
  const base = fl.load8("ptr", a, 0);
  const len = fl.load8("ix", a, 8);
  const off = fl.load8("ix", a, 16);
  const baseIx = fl.op1("bitcast.ix", [v(base)], "ix");
  const cur = fl.op1("add.ix", [v(baseIx), v(off)], "ix");
  const up = fl.op1("add.ix", [v(cur), v(fl.iconst("ix", align - 1))], "ix");
  const mask = fl.iconst("ix", BigInt.asUintN(64, ~BigInt(align - 1)));
  const aligned = fl.op1("and.ix", [v(up), v(mask)], "ix");
  const at = fl.op1("sub.ix", [v(aligned), v(baseIx)], "ix");
  const end = fl.op1("add.chk.u.ix", [v(at), v(bytes), fl.trapOp("bounds", 2, loc)], "ix");
  fl.trapIf(fl.op1("icmp.ugt.ix", [v(end), v(len)], "i32"), "bounds", 2, loc);
  fl.memStore(a, { t: "ix", off: 16 }, end);
  const p = gep(fl, base, at, 1);
  fl.emit(
    "intrinsic",
    [{ t: "name", name: "mem.fill" }, v(p), v(fl.iconst("i32", 0)), v(bytes)],
    [],
  );
  return p;
}

export function lowerNativeBuiltin(fl: FnLower, te: TE): number[] {
  switch (te.k) {
    case "ofield": {
      const f = te.f;
      const addr = fieldAddr(fl, te.obj, f, te.check, te.loc, te.c);
      switch (f.store) {
        case "value": {
          const at = fl.cur;
          const from = at.instrs.length;
          const vals = loadMem(fl, f.ty, addr, f.be, f.size);
          // A field nothing writes after construction (a class id, tslc's markInvariantFields): its load is noted for the
          // optimiser, outside the canonical text (D73).
          if (te.inv === true && fl.cur === at)
            for (const ins of at.instrs.slice(from)) if (ins.op.startsWith("load.")) ins.inv = true;
          // R27 (D77): an object's field's bytes, never a separated field's block; and a separated field's read, the
          // address of such a block (separate.ts). Noted outside the canonical text, as above.
          if (fl.cur === at)
            for (const ins of at.instrs.slice(from))
              if (ins.op.startsWith("load.")) {
                ins.obj = true;
                if (te.sep === true) ins.sep = true;
              }
          if (f.checkedEnum) enumCheck(fl, vals[0]!, f.ty, te.loc);
          return vals;
        }
        case "inline":
          return [fl.ptrToI64(addr)];
        case "array":
          return [addr, fl.iconst("ix", f.arrLen)];
        case "tail": {
          // A view of the tail (D69): element 0 after the fixed part, and the length its field holds.
          const len = fl.op1("zext.ix", [v(fl.memLoad(addr, { t: "i32", off: 0 }))], "ix");
          return [fl.memAddr(addr, te.c.tail!.at - f.off), len];
        }
        default:
          return [];
      }
    }
    case "osetfield": {
      const f = te.f;
      const addr = fieldAddr(fl, te.obj, f, te.check, te.loc, te.c);
      const vals = fl.expr(te.val);
      const at = fl.cur;
      const from = at.instrs.length;
      storeMem(fl, f.ty, addr, vals, f.be, f.size);
      // R27 (D77): an object's field's bytes, never a separated field's block (separate.ts)
      if (fl.cur === at)
        for (const ins of at.instrs.slice(from)) if (ins.op.startsWith("store.")) ins.obj = true;
      return vals;
    }
    case "new": {
      const args = te.args.flatMap((a) => fl.expr(a));
      let p: number;
      let heapSelf: number | null = null;
      if (te.heap !== undefined) {
        const h = heapObject(fl, te);
        p = h.p;
        heapSelf = h.self;
      } else if (te.into !== null) {
        const base = fl.refAddr(fl.expr(te.into.obj)[0]!);
        p = fl.memAddr(base, te.into.f.off);
      } else {
        p = fl.entryAlloca(
          te.c.size,
          Math.min(Math.max(te.c.align, 8), 16),
          fl.trapOp("memory", 14, te.at ?? ""),
        );
        // R18: an `rc` class printing keeps on the stack (`@tsl.stack`) is zeroed as the direct route zeroes its stack
        // objects, one `mem.fill`, which scalar replacement takes (sroa.ts) where its field-by-field stores weren't
        const decl = te.c.decl as ts.Node | undefined;
        if (decl !== undefined && ts.isClassDeclaration(decl) && stackTagged(decl))
          fl.emit(
            "intrinsic",
            [
              { t: "name", name: "mem.fill" },
              v(p),
              v(fl.iconst("i32", 0)),
              // the whole slot, which is 8 bytes at least (entryAlloca), as scalar replacement wants it
              v(fl.iconst("ix", Math.max(te.c.size, 8))),
            ],
            [],
          );
        else zeroFill(fl, p, te.c.size);
      }
      const self = heapSelf ?? fl.ptrToI64(p);
      // An initialiser of zero needs no store where the object is already zero: on the stack and in `manual` it was
      // zero-filled just now, and `leak` memory is the page source's, zeroed and never reused (D64). One the constructor
      // stores first, from what can't read the object, needs none either.
      const zeroed = te.into === null && !tslOptOff("init");
      const overwritten = zeroed ? ctorFirstStores(te.ctor) : new Set<ClsField>();
      for (const { f, val } of te.init) {
        if (zeroed && (isZeroLit(val) || (overwritten.has(f) && pureInit(val)))) continue;
        storeMem(fl, f.ty, fl.memAddr(p, f.off), fl.expr(val), f.be, f.size);
      }
      if (te.ctor !== null) {
        fl.emit("call", [{ t: "sym", name: te.ctor.tirName }, v(self), ...args.map(v)], []);
      }
      return [self];
    }
    case "closure": {
      const inst = te.inst;
      const code = fl.op1("funcaddr", [{ t: "sym", name: inst.tirName }], "ptr");
      const caps = inst.captures ?? [];
      if (caps.length === 0) return [code, fl.zero("ptr")];
      let size = 0;
      for (const c of caps) size += c.boxed === true ? 8 : 8 * leaves(c.ty).length;
      const env = fl.entryAlloca(size, 8, fl.trapOp("memory", 14, te.at ?? ""));
      let off = 0;
      for (const c of caps) {
        if (c.boxed === true) {
          fl.memStore(env, { t: "ptr", off }, fl.slotAddr(c));
          off += 8;
        } else {
          const vals = fl.readVar(c);
          leaves(c.ty).forEach((t, i) => {
            fl.memStore(env, { t, off: off + i * 8 }, vals[i]!);
          });
          off += 8 * leaves(c.ty).length;
        }
      }
      return [code, env];
    }
    case "chkref": {
      const r = fl.expr(te.val)[0]!;
      if (te.check !== false) refChecked(fl, r, te.check, te.loc);
      return [r];
    }
    case "builtin":
      return builtin(fl, te);
    default:
      throw new Error(`lowerNativeBuiltin: ${te.k}`);
  }
}

function builtin(fl: FnLower, te: Extract<TE, { k: "builtin" }>): number[] {
  const info = te.info ?? {};
  const loc = te.loc;
  switch (te.name) {
    case "ptr.add": {
      const p = fl.expr(te.args[0]!)[0]!;
      const n = fl.expr(te.args[1]!)[0]!;
      return [fl.ptrToI64(gep(fl, fl.i64ToPtr(p), n, info.elem!.size))];
    }
    case "ptr.read": {
      const p = fl.i64ToPtr(fl.expr(te.args[0]!)[0]!);
      const e = info.elem!;
      // A stored reference is a value of its own type: a reference is an i64, a function value a code pointer (loadMem's).
      if (e.mode === "ref" && process.env.TMK_TEST_TSL === "fnval-i64")
        return [fl.op1("load.i64.na", [v(p)], "i64")]; // R1's bug, put back on purpose: every stored reference an i64
      if (e.mode === "ref") return loadMem(fl, info.of!, p, false, 8);
      if (e.mode === "inline") return [fl.ptrToI64(p)];
      return loadMem(fl, info.of!, p, e.be, e.size);
    }
    case "ptr.write": {
      const p = fl.i64ToPtr(fl.expr(te.args[0]!)[0]!);
      const vals = fl.expr(te.args[1]!);
      const e = info.elem!;
      if (e.mode === "ref" && process.env.TMK_TEST_TSL === "fnval-i64")
        fl.emit("store.i64.na", [v(p), v(vals[0]!)], []);
      else if (e.mode === "ref") storeMem(fl, info.of!, p, vals, false, 8);
      else if (e.mode === "inline") {
        const src = fl.refAddr(vals[0]!);
        fl.emit(
          "intrinsic",
          [{ t: "name", name: "mem.copy" }, v(p), v(src), v(fl.iconst("ix", e.size))],
          [],
        );
      } else storeMem(fl, info.of!, p, vals, e.be, e.size);
      return [];
    }
    case "unsafe.slice": {
      const a = fl.expr(te.args[0]!)[0]!;
      const n = fl.expr(te.args[1]!)[0]!;
      return [fl.i64ToPtr(a), n];
    }
    case "unsafe.copy": {
      const d = fl.i64ToPtr(fl.expr(te.args[0]!)[0]!);
      const s = fl.i64ToPtr(fl.expr(te.args[1]!)[0]!);
      const n = fl.expr(te.args[2]!)[0]!;
      fl.emit("intrinsic", [{ t: "name", name: "mem.copy" }, v(d), v(s), v(n)], []);
      return [];
    }
    case "unsafe.free": {
      // A Slab's or a static object's reference has a tag, and isn't the heap's to take back.
      const r = fl.expr(te.args[0]!)[0]!;
      const tag = fl.op1("lshr.i64", [v(r), v(fl.iconst("i64", 48))], "i64");
      fl.trapIf(fl.op1("icmp.ne.i64", [v(tag), v(fl.iconst("i64", 0))], "i32"), "stale", 5, loc);
      const at = fl.refAddr(r);
      // A class with a tail is freed at its real size, as it was made (D69). `tmk milestone pipe-d`'s injected bug frees it
      // at its fixed size. Never set otherwise.
      const size =
        info.c!.tail !== undefined && process.env.TMK_TEST_TSL !== "tail-free-fixed"
          ? tailSizeIx(fl, info.c!, tailLen(fl, info.c!, at), loc)
          : fl.iconst("ix", Math.max(info.c!.size, 8));
      fl.emit("call", [{ t: "sym", name: "__heap_free" }, v(at), v(size)], []);
      return [];
    }
    case "unsafe.placeTail": {
      // placeObject for a class with a tail (D69): the moved object's fields, before its length, are copied into the
      // slot, and the rest, its length and its n elements, zeroed, and then the length written.
      const slot = fl.i64ToPtr(fl.expr(te.args[0]!)[0]!);
      const gen = fl.expr(te.args[1]!)[0]!;
      const n = fl.expr(te.args[2]!)[0]!;
      const item = fl.expr(te.args[3]!)[0]!;
      const c = info.c!;
      const lenAt = c.tail!.f.off;
      const dst = fl.memAddr(slot, SLOT_PREFIX);
      const bytes = tailSizeIx(fl, c, n, loc);
      const keepGiven = te.args.length > 4;
      const inlineZero = !r28LowerOff("zero");
      if (lenAt > 0 && (keepGiven || !inlineZero)) {
        fl.emit(
          "intrinsic",
          [{ t: "name", name: "mem.copy" }, v(dst), v(fl.refAddr(item)), v(fl.iconst("ix", lenAt))],
          [],
        );
      }
      const fill = (from: number, len: number): void => {
        fl.emit(
          "intrinsic",
          [{ t: "name", name: "mem.fill" }, v(from), v(fl.iconst("i32", 0)), v(len)],
          [],
        );
      };
      // R28: up to ZERO_INLINE bytes zeroed a word at a time in line, where what's zeroed starts at a multiple of 8 from
      // the slot's 16-aligned fields and is a multiple of 8 long: a short tail's zeroing was a call to the fill routine and
      // its setup, about 18 instructions before its first store. Longer, the routine, which stores 16 bytes a turn.
      const zeroWords = (from: number, len: number): void => {
        const small = fl.op1("icmp.ule.ix", [v(len), v(fl.iconst("ix", ZERO_INLINE))], "i32");
        const inl = fl.newBlock();
        const call = fl.newBlock();
        const done = fl.newBlock();
        fl.brif(small, inl, call);
        fl.seal(inl);
        fl.seal(call);
        fl.cur = call;
        fill(from, len);
        fl.br(done);
        fl.cur = inl;
        const words = fl.op1("lshr.ix", [v(len), v(fl.iconst("ix", 3))], "ix");
        // `tmk milestone pipe-d`'s injected bug: a word short. Never set otherwise.
        const to =
          process.env.TMK_TEST_TSL === "r28-zero-short"
            ? fl.op1("sub.ix", [v(words), v(fl.iconst("ix", 1))], "ix")
            : words;
        loop(fl, fl.iconst("ix", 0), to, (i) =>
          fl.emit("store.i64.na", [v(gep(fl, from, i, 8)), v(fl.iconst("i64", 0))], []),
        );
        fl.br(done);
        fl.seal(done);
        fl.cur = done;
      };
      if (keepGiven) {
        // R4: the tail's first `keep` elements are the caller's to write before anything reads them, so only what's
        // after them is zeroed, and the fixed part from the length to the tail. More than n traps 2.
        const keep = fl.expr(te.args[4]!)[0]!;
        fl.trapIf(fl.op1("icmp.ugt.ix", [v(keep), v(n)], "i32"), "bounds", 2, loc);
        const t = c.tail!;
        if (t.at > lenAt) fill(fl.memAddr(dst, lenAt), fl.iconst("ix", t.at - lenAt));
        const kept = fl.op1("mul.ix", [v(keep), v(fl.iconst("ix", t.esize))], "ix");
        const from = fl.op1("add.ix", [v(kept), v(fl.iconst("ix", t.at))], "ix");
        const big = fl.op1("icmp.ugt.ix", [v(from), v(bytes)], "i32");
        const len = fl.op1(
          "select.ix",
          [v(big), v(fl.iconst("ix", 0)), v(fl.op1("sub.ix", [v(bytes), v(from)], "ix"))],
          "ix",
        );
        const at = fl.op1(
          "gep",
          [v(dst), v(from), { t: "i", val: 1n }, { t: "i", val: 0n }],
          "ptr",
        );
        // keep elements of a multiple of 8 bytes from a tail at a multiple of 8 leave the rest a multiple of 8 from there
        if (inlineZero && t.esize % 8 === 0 && t.at % 8 === 0) zeroWords(at, len);
        else fill(at, len);
      } else if (inlineZero) {
        // R28: from the word the length is in to the end, then the fields before the length copied over that word's
        // first bytes (the item is the caller's, never the slot, so the order can't show)
        const z = lenAt - (lenAt % 8);
        zeroWords(fl.memAddr(dst, z), fl.op1("sub.ix", [v(bytes), v(fl.iconst("ix", z))], "ix"));
        if (lenAt > 0) {
          fl.emit(
            "intrinsic",
            [
              { t: "name", name: "mem.copy" },
              v(dst),
              v(fl.refAddr(item)),
              v(fl.iconst("ix", lenAt)),
            ],
            [],
          );
        }
      } else
        fill(fl.memAddr(dst, lenAt), fl.op1("sub.ix", [v(bytes), v(fl.iconst("ix", lenAt))], "ix"));
      fl.memStore(dst, { t: "i32", off: lenAt }, fl.op1("trunc.i32", [v(n)], "i32"));
      if (untaggedCounted(c.decl)) return [fl.ptrToI64(dst)];
      return [tagged(fl, dst, fl.op1("zext.i64", [v(gen)], "i64"))];
    }
    case "unsafe.tailBytes":
      return [tailSizeIx(fl, info.c!, fl.expr(te.args[0]!)[0]!, loc)];
    case "unsafe.objectBytes": {
      const c = info.c!;
      const r = fl.expr(te.args[0]!)[0]!;
      if (c.tail === undefined) return [fl.iconst("ix", c.size)];
      return [tailSizeIx(fl, c, tailLen(fl, c, fl.refAddr(r)), loc)];
    }
    case "unsafe.tailAddr": {
      const r = fl.expr(te.args[0]!)[0]!;
      return [fl.ptrToI64(fl.memAddr(fl.refAddr(r), info.c!.tail!.at))];
    }
    case "unsafe.setPageSource": {
      const f = te.args[0]!;
      if (f.k !== "fnref") throw new Error("setPageSource takes a function by name");
      const code = fl.op1("funcaddr", [{ t: "sym", name: f.inst.tirName }], "ptr");
      fl.emit("call", [{ t: "sym", name: "__page_source_use" }, v(code)], []);
      return [];
    }
    case "unsafe.releaseIndex": {
      // A release function's number (R1d): its code address compared with each of the set's, 0 if it's none of them.
      // A function value with an environment is its thunk's address, as a fnref of it makes (lower.ts).
      const fty = te.args[0]!.ty;
      const thunk = fty.k === "fn" && fty.env === true;
      const code = fl.ptrToI64(fl.expr(te.args[0]!)[0]!);
      let out = fl.iconst("i32", 0);
      const fns = info.fns ?? [];
      for (let i = fns.length - 1; i >= 0; i--) {
        const g = fns[i]!;
        if (thunk) fl.ctx.thunks.set(g.tirName, g);
        const name = thunk ? thunkName(g.tirName) : g.tirName;
        const at = fl.ptrToI64(fl.op1("funcaddr", [{ t: "sym", name }], "ptr"));
        const eq = fl.op1("icmp.eq.i64", [v(code), v(at)], "i32");
        out = fl.op1("select.i32", [v(eq), v(fl.iconst("i32", i + 1)), v(out)], "i32");
      }
      return [out];
    }
    // R6: the per-call region is the module's call arena, from where `__arena_use` began it (`mem.base`) to its top; in a
    // package tslc placed nothing in it, nothing is (region.ts).
    case "unsafe.inCallRegion":
    case "unsafe.addrInCallRegion": {
      const x = fl.expr(te.args[0]!)[0]!;
      if (!fl.ctx.region) return [fl.iconst("i32", 0)];
      const p = te.name === "unsafe.inCallRegion" ? fl.refAddr(x) : fl.i64ToPtr(x);
      const lo = fl.op1("intrinsic", [{ t: "name", name: "mem.base" }], "ptr");
      const top = fl.op1(
        "load.ptr.na",
        [v(fl.op1("globaladdr", [{ t: "sym", name: "__arena_top" }], "ptr"))],
        "ptr",
      );
      const above = fl.op1("icmp.uge.ptr", [v(p), v(lo)], "i32");
      const below = fl.op1("icmp.ult.ptr", [v(p), v(top)], "i32");
      return [fl.op1("and.i32", [v(above), v(below)], "i32")];
    }
    case "unsafe.callRegionBytes": {
      const n = fl.expr(te.args[0]!)[0]!;
      if (!fl.ctx.region) {
        fl.trapIf(fl.iconst("i32", 1), "memory", 14, loc);
        return [fl.iconst("i64", 0)];
      }
      // the injected `arena-grow-short` bug (R13): a buffer from the call arena given half the bytes it asked for, so an
      // array's elements past half its room overlap whatever the arena gives next
      const asked =
        process.env.TMK_TEST_TSL === "arena-grow-short"
          ? fl.op1("lshr.ix", [v(n), v(fl.iconst("ix", 1))], "ix")
          : n;
      return [fl.ptrToI64(fl.op1("call", [{ t: "sym", name: "__alloc" }, v(asked)], "ptr"))];
    }
    case "unsafe.sourcePages":
      return [
        fl.ptrToI64(
          fl.op1("call", [{ t: "sym", name: "__pages_try" }, v(fl.expr(te.args[0]!)[0]!)], "ptr"),
        ),
      ];
    case "key.bits64": {
      const x = fl.expr(te.args[0]!)[0]!;
      const hi = fl.op1("lshr.i64", [v(x), v(fl.iconst("i64", 32))], "i64");
      const m = fl.op1("xor.i64", [v(x), v(hi)], "i64");
      return [fl.op1("trunc.i32", [v(m)], "i32")];
    }
    case "unsafe.viewAt":
      return fl.expr(te.args[0]!);
    case "unsafe.addrOf":
      return [fl.ptrToI64(fl.refAddr(fl.expr(te.args[0]!)[0]!))];
    case "unsafe.place": {
      // Copies the object into its slot, and forms the reference that carries its generation (SPEC 3.5).
      const slot = fl.i64ToPtr(fl.expr(te.args[0]!)[0]!);
      const gen = fl.expr(te.args[1]!)[0]!;
      const item = fl.expr(te.args[2]!)[0]!;
      const size = info.c!.size;
      const dst = fl.memAddr(slot, SLOT_PREFIX);
      if (size > 0) {
        fl.emit(
          "intrinsic",
          [{ t: "name", name: "mem.copy" }, v(dst), v(fl.refAddr(item)), v(fl.iconst("ix", size))],
          [],
        );
      }
      if (untaggedCounted(info.c!.decl)) return [fl.ptrToI64(dst)];
      return [tagged(fl, dst, fl.op1("zext.i64", [v(gen)], "i64"))];
    }
    case "rc.objectAt": {
      // R28: callRelease's arm's object from the slot (elab-native.ts): its address for a class whose references have no
      // tag, or with the slot's generation, as `objectAt<Counted0>` made it before
      const slot = fl.i64ToPtr(fl.expr(te.args[0]!)[0]!);
      if (te.text === "untagged") return [fl.ptrToI64(fl.memAddr(slot, SLOT_PREFIX))];
      const gen = fl.memLoad(slot, { t: "i32", off: SLOT_PREFIX - 8 });
      return [tagged(fl, fl.memAddr(slot, SLOT_PREFIX), fl.op1("zext.i64", [v(gen)], "i64"))];
    }
    case "rc.untag": {
      // R28: a reference with its tag masked off, for callRelease's arm of a class whose references have none (elab-native.ts)
      const r = fl.expr(te.args[0]!)[0]!;
      return [fl.ptrToI64(fl.refAddr(r))];
    }
    case "unsafe.objectAt": {
      const slot = fl.i64ToPtr(fl.expr(te.args[0]!)[0]!);
      if (te.ty.k === "cls" && untaggedCounted(te.ty.c.decl))
        return [fl.ptrToI64(fl.memAddr(slot, SLOT_PREFIX))];
      const gen = fl.memLoad(slot, { t: "i32", off: SLOT_PREFIX - 8 });
      return [tagged(fl, fl.memAddr(slot, SLOT_PREFIX), fl.op1("zext.i64", [v(gen)], "i64"))];
    }
    case "unsafe.slotOfLive": {
      // A reference tslc's expansion counts exactly can't be stale (3.5, D74): its slot, with nothing checked (R1f).
      // `TMK_TEST_TSL=slot-live-checked` checks it as slotOf does, for measuring what the check cost.
      if (process.env.TMK_TEST_TSL !== "slot-live-checked") {
        const r = fl.expr(te.args[0]!)[0]!;
        // R28: a reference with no tag (untaggedRcClass) is its address already, with nothing to mask
        const a0 = te.args[0]!.ty;
        const addr = a0.k === "cls" && untaggedRcClass(a0.c) ? r : fl.ptrToI64(fl.refAddr(r));
        return [fl.op1("sub.i64", [v(addr), v(fl.iconst("i64", SLOT_PREFIX))], "i64")];
      }
    }
    // falls through
    case "unsafe.slotOf":
    case "unsafe.genOf": {
      const r = fl.expr(te.args[0]!)[0]!;
      const tag = fl.op1("lshr.i64", [v(r), v(fl.iconst("i64", 48))], "i64");
      // Only a slot's own reference has a live generation, and a static's never comes off.
      const odd = fl.op1("and.i64", [v(tag), v(fl.iconst("i64", 1))], "i64");
      const even = fl.op1("icmp.eq.i64", [v(odd), v(fl.iconst("i64", 0))], "i32");
      const isStatic = fl.op1("icmp.eq.i64", [v(tag), v(fl.iconst("i64", 0xffff))], "i32");
      fl.trapIf(fl.op1("or.i32", [v(even), v(isStatic)], "i32"), "stale", 5, loc);
      if (te.name === "unsafe.genOf") return [fl.op1("trunc.i32", [v(tag)], "i32")];
      const addr = fl.ptrToI64(fl.refAddr(r));
      return [fl.op1("sub.i64", [v(addr), v(fl.iconst("i64", SLOT_PREFIX))], "i64")];
    }
    case "layout.over": {
      const [p, len] = fl.expr(te.args[0]!) as [number, number];
      const off = fl.expr(te.args[1]!)[0]!;
      const c = info.c!;
      const at = gep(fl, p, off, 1);
      if (c.align > 1) {
        const low = fl.op1(
          "and.ix",
          [v(fl.op1("bitcast.ix", [v(at)], "ix")), v(fl.iconst("ix", c.align - 1))],
          "ix",
        );
        fl.trapIf(fl.op1("icmp.ne.ix", [v(low), v(fl.iconst("ix", 0))], "i32"), "align", 9, loc);
      }
      const end = fl.op1(
        "add.chk.u.ix",
        [v(off), v(fl.iconst("ix", c.size)), fl.trapOp("bounds", 2, loc)],
        "ix",
      );
      fl.trapIf(fl.op1("icmp.ugt.ix", [v(end), v(len)], "i32"), "bounds", 2, loc);
      return [fl.ptrToI64(at)];
    }
    case "layout.at": {
      const base = fl.expr(te.args[0]!)[0]!;
      const i = fl.expr(te.args[1]!)[0]!;
      const checked = fl.op1(
        "bounds.chk",
        [v(i), v(fl.iconst("ix", info.n!)), fl.trapOp("bounds", 2, loc)],
        "ix",
      );
      return [fl.ptrToI64(gep(fl, fl.i64ToPtr(base), checked, info.c!.size))];
    }
    case "bit.get": {
      const addr = fl.i64ToPtr(fl.expr(te.args[0]!)[0]!);
      const word = containerLoad(fl, addr, info.size!);
      const shifted = fl.op1("lshr.js32", [v(word), v(fl.iconst("i32", info.shift!))], "i32");
      const n = info.n!;
      if (n >= 32) return [shifted];
      return [fl.op1("and.i32", [v(shifted), v(fl.iconst("i32", 2 ** n - 1))], "i32")];
    }
    case "bit.set": {
      const addr = fl.i64ToPtr(fl.expr(te.args[0]!)[0]!);
      const val = fl.expr(te.args[1]!)[0]!;
      const n = info.n!;
      const shift = info.shift!;
      const mask = n >= 32 ? 0xffffffff : 2 ** n - 1;
      const word = containerLoad(fl, addr, info.size!);
      const placed = fl.op1(
        "shl.js32",
        [
          v(fl.op1("and.i32", [v(val), v(fl.iconst("i32", mask))], "i32")),
          v(fl.iconst("i32", shift)),
        ],
        "i32",
      );
      const hole = fl.iconst("i32", ~(mask * 2 ** shift) >>> 0);
      const kept = fl.op1("and.i32", [v(word), v(hole)], "i32");
      const next = fl.op1("or.i32", [v(kept), v(placed)], "i32");
      if (info.size === 4) fl.emit("store.i32.na", [v(addr), v(next)], []);
      else {
        const t: TirType = info.size === 1 ? "i8" : "i16";
        fl.emit(`store.${t}.na`, [v(addr), v(fl.op1(`trunc.${t}`, [v(next)], t))], []);
      }
      return [val];
    }
    case "enumValue": {
      const x = fl.expr(te.args[0]!)[0]!;
      const of = info.of!;
      let ok = fl.iconst("i32", 0);
      if (of.k === "enum") {
        for (const m of of.members.values()) {
          const eq = fl.op1("icmp.eq.i32", [v(x), v(fl.iconst("i32", BigInt(m)))], "i32");
          ok = fl.op1("or.i32", [v(ok), v(eq)], "i32");
        }
      }
      return [ok, x];
    }
    case "arr.subarray": {
      const [p, len] = fl.expr(te.args[0]!) as [number, number];
      const from = fl.expr(te.args[1]!)[0]!;
      const to = te.args[2] !== undefined ? minIx(fl, fl.expr(te.args[2])[0]!, len) : len;
      const begin = minIx(fl, from, len);
      const ok = fl.op1("icmp.ult.ix", [v(begin), v(to)], "i32");
      const diff = fl.op1("sub.ix", [v(to), v(begin)], "ix");
      const n = fl.op1("select.ix", [v(ok), v(diff), v(fl.iconst("ix", 0))], "ix");
      return [gep(fl, p, begin, info.size!), n];
    }
    case "arr.fill": {
      const [p, len] = fl.expr(te.args[0]!) as [number, number];
      const val = fl.expr(te.args[1]!)[0]!;
      const from = minIx(fl, fl.expr(te.args[2]!)[0]!, len);
      const to = te.args[3] !== undefined ? minIx(fl, fl.expr(te.args[3])[0]!, len) : len;
      const ty = te.args[0]!.ty;
      if (ty.k !== "arr") throw new Error("fill on a non-array");
      if ((ty.elem === "u8" || ty.elem === "i8") && !tslOptOff("bytefill")) {
        // A byte array's fill is one memset, its value's low byte, as a store of each element would keep: `bytesAt(a,
        // n).fill(0)` was a byte-at-a-time loop, which the global allocator's zeroing of a reused run paid for (D66).
        // The injected bug (pipe-d box 6): the fill starts a byte late, which a hole left dirty shows.
        const start =
          process.env.TMK_TEST_TSL === "bytefill-late"
            ? fl.op1("add.ix", [v(from), v(fl.iconst("ix", 1))], "ix")
            : from;
        const ok = fl.op1("icmp.ult.ix", [v(start), v(to)], "i32");
        const diff = fl.op1("sub.ix", [v(to), v(start)], "ix");
        const n = fl.op1("select.ix", [v(ok), v(diff), v(fl.iconst("ix", 0))], "ix");
        fl.emit(
          "intrinsic",
          [{ t: "name", name: "mem.fill" }, v(gep(fl, p, start, 1)), v(val), v(n)],
          [],
        );
        return [p, len];
      }
      loop(fl, from, to, (i) => {
        fl.storeElem(ty.elem, p, i, val);
      });
      return [p, len];
    }
    case "arr.set": {
      const [dp, dl] = fl.expr(te.args[0]!) as [number, number];
      const [sp, sl] = fl.expr(te.args[1]!) as [number, number];
      const off = fl.expr(te.args[2]!)[0]!;
      const end = fl.op1("add.chk.u.ix", [v(off), v(sl), fl.trapOp("bounds", 2, loc)], "ix");
      fl.trapIf(fl.op1("icmp.ugt.ix", [v(end), v(dl)], "i32"), "bounds", 2, loc);
      const bytes = fl.op1("mul.ix", [v(sl), v(fl.iconst("ix", info.size!))], "ix");
      fl.emit(
        "intrinsic",
        [{ t: "name", name: "mem.copy" }, v(gep(fl, dp, off, info.size!)), v(sp), v(bytes)],
        [],
      );
      return [];
    }
    case "arena.new": {
      const [p, len] = fl.expr(te.args[0]!) as [number, number];
      const a = fl.entryAlloca(24, 8, fl.trapOp("memory", 14, loc));
      fl.memStore(a, { t: "ptr", off: 0 }, p);
      fl.memStore(a, { t: "ix", off: 8 }, len);
      fl.memStore(a, { t: "ix", off: 16 }, fl.iconst("ix", 0));
      return [fl.ptrToI64(a)];
    }
    case "arena.take": {
      const a = fl.expr(te.args[0]!)[0]!;
      const n = fl.expr(te.args[1]!)[0]!;
      const size = info.size!;
      const bytes = fl.op1(
        "mul.chk.u.ix",
        [v(n), v(fl.iconst("ix", size)), fl.trapOp("bounds", 2, loc)],
        "ix",
      );
      return [arenaTake(fl, a, bytes, size, loc), n];
    }
    case "arena.make": {
      const a = fl.expr(te.args[0]!)[0]!;
      const c = info.c!;
      return [fl.ptrToI64(arenaTake(fl, a, fl.iconst("ix", c.size), c.align, loc))];
    }
    default:
      throw new Error(`no lowering for builtin ${te.name}`);
  }
}

function containerLoad(fl: FnLower, addr: number, size: number): number {
  if (size === 4) return fl.op1("load.i32.na", [v(addr)], "i32");
  const t: TirType = size === 1 ? "i8" : "i16";
  return fl.op1("zext.i32", [v(fl.op1(`load.${t}.na`, [v(addr)], t))], "i32");
}

function tagged(fl: FnLower, ptr: number, gen64: number): number {
  const low = fl.op1("and.i64", [v(gen64), v(fl.iconst("i64", 0xffff))], "i64");
  const hi = fl.op1("shl.i64", [v(low), v(fl.iconst("i64", 48))], "i64");
  return fl.op1("or.i64", [v(fl.ptrToI64(ptr)), v(hi)], "i64");
}

// --- closures: what each one captures

/** A variable a closure uses and doesn't declare. One that's reassigned anywhere lives in memory. */
export function computeCaptures(tm: TypedModule): void {
  const assigned = new Set<Var>();
  for (const f of tm.funcs) {
    if (f.isClosure === true) continue;
    walkTE(
      f.body,
      (te) => {
        if (te.k === "setvar") assigned.add(te.v);
      },
      true,
    );
  }
  for (const f of tm.funcs) {
    if (f.isClosure === true && f.captures === undefined) capturesOf(f);
  }
  for (const v of assigned) {
    if (capturedVars.has(v)) v.boxed = true;
  }
  capturedVars.clear();
}

const capturedVars = new Set<Var>();

function capturesOf(f: FuncInst): Var[] {
  if (f.captures !== undefined) return f.captures;
  const local = new Set<Var>(f.params);
  walkStmts(f.body, (s) => {
    if (s.k === "let" || s.k === "forof" || s.k === "using") local.add(s.v);
  });
  const used = new Set<Var>();
  const note = (x: Var): void => {
    if (!local.has(x) && !x.name.startsWith("$t")) used.add(x);
  };
  walkTE(
    f.body,
    (te) => {
      if (te.k === "var" || te.k === "setvar") note(te.v);
      if (te.k === "closure") for (const c of capturesOf(te.inst)) note(c);
    },
    false,
  );
  f.captures = [...used].sort((a, b) => a.id - b.id);
  for (const c of f.captures) capturedVars.add(c);
  return f.captures;
}

// --- generated functions

/** Puts what compile-time evaluation can't: addresses, and each static object's generation prefix. */
export function buildStatics(tm: TypedModule, ctx: ModuleCtx): Func | null {
  const objs = tm.globals.filter((g) => g.object !== undefined);
  if (objs.length === 0) return null;
  const types: TirType[] = [];
  const instrs: Block["instrs"] = [];
  const val = (t: TirType): number => {
    types.push(t);
    return types.length - 1;
  };
  const addrOf = (name: string, off: number): number => {
    const a = val("ptr");
    instrs.push({ op: "globaladdr", ops: [{ t: "sym", name }], res: [a] });
    const z = val("ix");
    instrs.push({ op: "iconst.ix", ops: [{ t: "i", val: 0n }], res: [z] });
    const out = val("ptr");
    instrs.push({
      op: "gep",
      ops: [v(a), v(z), { t: "i", val: 1n }, { t: "i", val: BigInt(off) }],
      res: [out],
    });
    return out;
  };
  for (const g of objs) {
    const o = g.object!;
    const prefix = addrOf(g.name, o.off - 8);
    const word = val("i32");
    instrs.push({ op: "iconst.i32", ops: [{ t: "i", val: 0xffffn }], res: [word] });
    instrs.push({ op: "store.i32.na", ops: [v(prefix), v(word)], res: [] });
    for (const r of o.relocs) {
      const at = addrOf(g.name, o.off + r.off);
      if (r.func !== undefined) {
        ctx.thunks.set(r.func.tirName, r.func);
        const code = val("ptr");
        instrs.push({
          op: "funcaddr",
          ops: [{ t: "sym", name: thunkName(r.func.tirName) }],
          res: [code],
        });
        instrs.push({ op: "store.ptr.na", ops: [v(at), v(code)], res: [] });
      } else if (r.obj !== undefined) {
        const target = addrOf(r.obj.name, r.obj.object!.off);
        const bits = val("i64");
        instrs.push({ op: "bitcast.i64", ops: [v(target)], res: [bits] });
        const tag = val("i64");
        instrs.push({ op: "iconst.i64", ops: [{ t: "i", val: 0xffffn << 48n }], res: [tag] });
        const out = val("i64");
        instrs.push({ op: "or.i64", ops: [v(bits), v(tag)], res: [out] });
        instrs.push({ op: "store.i64.na", ops: [v(at), v(out)], res: [] });
      }
    }
  }
  return {
    name: "__statics",
    params: [],
    rets: [],
    attrs: [],
    types,
    blocks: [{ id: 0, params: [], instrs, term: { k: "ret", vals: [] } }],
  };
}

/** A top-level function as a value: it takes the environment every indirect call passes, and ignores it. */
export function buildThunks(ctx: ModuleCtx): Func[] {
  const out: Func[] = [];
  for (const inst of ctx.thunks.values()) {
    const types: TirType[] = ["ptr"];
    const params = [0];
    const args: number[] = [];
    for (const p of inst.params) {
      for (const t of leaves(p.ty)) {
        types.push(t);
        params.push(types.length - 1);
        args.push(types.length - 1);
      }
    }
    const rets = leaves(inst.ret);
    const res = rets.map((t) => {
      types.push(t);
      return types.length - 1;
    });
    out.push({
      name: thunkName(inst.tirName),
      params,
      rets,
      attrs: [],
      types,
      blocks: [
        {
          id: 0,
          params: [],
          instrs: [{ op: "call", ops: [{ t: "sym", name: inst.tirName }, ...args.map(v)], res }],
          term: inst.ret.k === "never" ? { k: "unreachable" } : { k: "ret", vals: res },
        },
      ],
    });
  }
  return out;
}

export function elemBytes(e: ElemName): number {
  return elemSize(e);
}
