// Builds TIR functions from code, for drivers and helpers too repetitive to write as text. Blocks and
// values are numbered as they are created, and canonicalize renumbers them for the printed form.
import type { Block, Func, Instr, Operand, Term, TirType } from "./ir.ts";

export class FuncBuilder {
  name: string;
  types: TirType[] = [];
  params: number[] = [];
  rets: TirType[];
  attrs: string[];
  blocks: Block[] = [];
  cur: Block;

  constructor(name: string, params: TirType[], rets: TirType[], attrs: string[] = []) {
    this.name = name;
    this.rets = rets;
    this.attrs = attrs;
    this.params = params.map((t) => this.val(t));
    this.cur = this.block();
  }

  val(t: TirType): number {
    this.types.push(t);
    return this.types.length - 1;
  }
  /** A new block, with parameters of these types. It doesn't become current until `at`. */
  block(params: TirType[] = []): Block {
    const b: Block = {
      id: this.blocks.length,
      params: params.map((t) => this.val(t)),
      instrs: [],
      term: { k: "unreachable" },
    };
    this.blocks.push(b);
    return b;
  }
  at(b: Block): void {
    this.cur = b;
  }
  raw(op: string, ops: Operand[], res: TirType[]): number[] {
    const out = res.map((t) => this.val(t));
    const ins: Instr = { op, ops, res: out };
    this.cur.instrs.push(ins);
    return out;
  }
  op(op: string, args: number[], res: TirType): number {
    return this.raw(
      op,
      args.map((id) => ({ t: "v", id })),
      [res],
    )[0]!;
  }
  void(op: string, args: number[]): void {
    this.raw(
      op,
      args.map((id) => ({ t: "v", id })),
      [],
    );
  }
  iconst(t: TirType, v: bigint | number): number {
    return this.raw(`iconst.${t}`, [{ t: "i", val: BigInt(v) }], [t])[0]!;
  }
  ix(v: bigint | number): number {
    return this.iconst("ix", v);
  }
  i32(v: bigint | number): number {
    return this.iconst("i32", v);
  }
  i64(v: bigint | number): number {
    return this.iconst("i64", v);
  }
  fbits(t: "f32" | "f64", bits: bigint): number {
    return this.raw(`fconst.${t}`, [{ t: "i", val: bits }], [t])[0]!;
  }
  f64(x: number): number {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, x);
    return this.fbits("f64", view.getBigUint64(0));
  }
  global(name: string): number {
    return this.raw("globaladdr", [{ t: "sym", name }], ["ptr"])[0]!;
  }
  func(name: string): number {
    return this.raw("funcaddr", [{ t: "sym", name }], ["ptr"])[0]!;
  }
  gep(base: number, index: number, scale: number, off: number): number {
    return this.raw(
      "gep",
      [
        { t: "v", id: base },
        { t: "v", id: index },
        { t: "i", val: BigInt(scale) },
        { t: "i", val: BigInt(off) },
      ],
      ["ptr"],
    )[0]!;
  }
  /** base + a constant offset. */
  at0(base: number, off: number): number {
    return this.gep(base, this.ix(0), 1, off);
  }
  load(t: TirType, addr: number): number {
    return this.op(`load.${t}.na`, [addr], t);
  }
  store(t: TirType, addr: number, v: number): void {
    this.void(`store.${t}.na`, [addr, v]);
  }
  call(name: string, args: number[], rets: TirType[] = []): number[] {
    return this.raw(
      "call",
      [{ t: "sym", name }, ...args.map((id): Operand => ({ t: "v", id }))],
      rets,
    );
  }
  intrinsic(name: string, args: number[], rets: TirType[] = []): number[] {
    return this.raw(
      "intrinsic",
      [{ t: "name", name }, ...args.map((id): Operand => ({ t: "v", id }))],
      rets,
    );
  }
  term(t: Term): void {
    this.cur.term = t;
  }
  br(to: Block, args: number[] = []): void {
    this.term({ k: "br", to: { block: to.id, args } });
  }
  brif(cond: number, t: Block, f: Block, targs: number[] = [], fargs: number[] = []): void {
    this.term({
      k: "brif",
      cond,
      t: { block: t.id, args: targs },
      f: { block: f.id, args: fargs },
    });
  }
  ret(vals: number[] = []): void {
    this.term({ k: "ret", vals });
  }
  finish(): Func {
    return {
      name: this.name,
      params: this.params,
      rets: this.rets,
      attrs: this.attrs,
      blocks: this.blocks,
      types: this.types,
    };
  }
}
