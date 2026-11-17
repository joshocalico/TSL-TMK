// The bare-metal runtime's hand-written part, assembled through the encoder (SPEC 5.10): the arm64
// Image header, start code, exception vectors, and the few routines that can't be TIR. It is scaffolding
// for the native proof, not the kernel. It boots at EL1, turns on FP, MMU and caches with an identity
// map, and runs everything on SP_EL0, so that a stack overflow can be reported from SP_EL1.
//
// Memory, low to high: image, bss, 3 pages of tables, then from the next 2 MiB boundary an unmapped
// 2 MiB guard, an 8 MiB stack, and the arena up to the end of RAM. Address 0 is unmapped, so a null
// dereference faults, and only the 2 MiB block holding the PL011 is mapped as device memory.
import { Code } from "./emit.ts";
import * as E from "./encode.ts";
import { Cond, XZR } from "./encode.ts";

export const RAM_BASE = 0x40000000;
const PL011_BLOCK = 0x09000000;
const BLOCK = 0x200000;
const STACK_BYTES = 8 * 1024 * 1024;
const TABLES_BYTES = 3 * 4096;
export const IMAGE_TAIL_BYTES = TABLES_BYTES;

/** A small assembler over the encoder, with labels: shared with the hosted runtime (hosted.ts, macos-arm64). */
export class A {
  code: Code;
  fixes: { at: number; label: number; kind: "b" | "bc" | "adr" | "cbz" }[] = [];
  labels: number[] = [];
  constructor(code: Code) {
    this.code = code;
  }
  label(): number {
    this.labels.push(-1);
    return this.labels.length - 1;
  }
  bind(l: number): void {
    this.labels[l] = this.code.here;
  }
  e(w: number): void {
    this.code.emit(w);
  }
  b(l: number): void {
    this.fixes.push({ at: this.code.here, label: l, kind: "b" });
    this.e(E.b(0));
  }
  bc(c: Cond, l: number): void {
    this.fixes.push({ at: this.code.here, label: l, kind: "bc" });
    this.e(E.bcond(c, 0));
  }
  cbnz(sf: boolean, r: number, l: number): void {
    this.fixes.push({ at: this.code.here, label: l, kind: "cbz" });
    this.e(E.cbnz(sf, r, 0));
  }
  cbz(sf: boolean, r: number, l: number): void {
    this.fixes.push({ at: this.code.here, label: l, kind: "cbz" });
    this.e(E.cbz(sf, r, 0));
  }
  adr(r: number, l: number): void {
    this.fixes.push({ at: this.code.here, label: l, kind: "adr" });
    this.e(E.adr(r, 0));
  }
  /** rd = the address of a symbol, position-independently. */
  la(rd: number, sym: string): void {
    this.code.fix("adrp", sym);
    this.code.words[this.code.here - 1] = rd;
    this.code.fix("add12", sym);
    this.code.words[this.code.here - 1] = rd + (rd << 5);
  }
  mov(rd: number, val: number | bigint): void {
    const v = BigInt.asUintN(64, BigInt(val));
    let first = true;
    for (let i = 0; i < 4; i++) {
      const p = Number((v >> BigInt(16 * i)) & 0xffffn);
      if (p === 0) continue;
      this.e(first ? E.movz(true, rd, p, i) : E.movk(true, rd, p, i));
      first = false;
    }
    if (first) this.e(E.movz(true, rd, 0));
  }
  mr(rd: number, rn: number): void {
    this.e(E.logicReg("orr", true, rd, XZR, rn));
  }
  resolve(): void {
    const w = this.code.words;
    for (const f of this.fixes) {
      const to = this.labels[f.label]!;
      if (to < 0) throw new Error("runtime: unbound label");
      const bytes = (to - f.at) * 4;
      const old = w[f.at]!;
      if (f.kind === "b") w[f.at] = E.b(bytes);
      else if (f.kind === "bc") w[f.at] = E.bcond(old & 15, bytes);
      else if (f.kind === "adr") w[f.at] = E.adr(old & 31, bytes);
      else w[f.at] = ((old & 0xff00001f) | (E.cbz(false, 0, bytes) & 0x00ffffe0)) >>> 0;
    }
    this.fixes = [];
  }
}

export interface HeaderFix {
  imageSizeAt: number; // the word index of image_size's low half
}

/** Emits header, start code and vectors. Everything else follows at a word index the caller sees. */
export function emitStart(
  code: Code,
  ramBytes: number,
  stackBytes = STACK_BYTES,
  bulkBytes = 0, // the RAM channel, past an unmapped block after RAM (SPEC 8.2)
): HeaderFix {
  if (ramBytes + (bulkBytes > 0 ? BLOCK + bulkBytes : 0) > 1 << 30) {
    throw new Error("this runtime maps at most 1 GiB of RAM");
  }
  const a = new A(code);
  const entry = a.label();
  const from = code.here;
  a.b(entry); // code0
  a.e(0); // code1
  a.e(0); // text_offset
  a.e(0);
  const imageSizeAt = code.here;
  a.e(0); // image_size, patched at link
  a.e(0);
  a.e(0x0a); // flags: little-endian, 4K pages, anywhere in RAM
  a.e(0);
  for (let i = 0; i < 6; i++) a.e(0); // reserved
  a.e(0x644d5241); // "ARM\x64"
  a.e(0);
  code.ranges.push({ name: "__image_header_branch", from, to: from + 1 });

  const start = code.here;
  a.bind(entry);
  a.e(E.MSR_DAIFSET_ALL);
  // FP and SIMD on, at EL1: nothing below this line may run compiled code before it.
  a.mov(1, 3 << 20);
  a.e(E.msr(E.CPACR_EL1, 1));
  a.e(E.ISB);
  a.e(E.msr(E.FPCR, XZR));
  a.e(E.msr(E.FPSR, XZR));

  // x19 = the 3 table pages at the image's end, x20 = the guard, x21 = stack top.
  a.la(19, "g:__tables");
  a.la(20, "g:__image_end");
  a.mov(1, BLOCK - 1);
  a.e(E.arithReg("add", true, 20, 20, 1));
  a.e(E.logicReg("bic", true, 20, 20, 1));
  a.mov(1, BLOCK + stackBytes);
  a.e(E.arithReg("add", true, 21, 20, 1));

  // Clear the tables. Caches are off, so this and the writes below go straight to RAM.
  a.mr(1, 19);
  a.mov(2, TABLES_BYTES);
  {
    const loop = a.label();
    a.bind(loop);
    a.e(E.memPair("stpx", "offset", XZR, XZR, 1, 0));
    a.e(E.arithImm("add", true, 1, 1, 16));
    a.e(E.arithImm("subs", true, 2, 2, 16));
    a.bc(Cond.NE, loop);
  }
  // L1: entry 0 is the low GiB with only the PL011's block, entry 1 is RAM.
  a.e(E.arithImm("add", true, 1, 19, 1, true)); // low L2
  a.e(E.logicImm("orr", true, 2, 1, E.bitmask(3n, true)!));
  a.e(E.memImm("strx", 2, 19, 0));
  a.e(E.arithImm("add", true, 3, 1, 1, true)); // RAM L2
  a.e(E.logicImm("orr", true, 2, 3, E.bitmask(3n, true)!));
  a.e(E.memImm("strx", 2, 19, 8));
  // The PL011's block: device, never executable.
  a.mov(2, 0x0060000000000401n | BigInt(PL011_BLOCK));
  a.e(E.memImm("strx", 2, 1, (PL011_BLOCK / BLOCK) * 8));
  // RAM: normal write-back, shareable, accessed. The guard block stays invalid.
  a.mov(4, RAM_BASE);
  a.mov(5, 0x705);
  a.mov(6, ramBytes / BLOCK);
  {
    const loop = a.label();
    const skip = a.label();
    a.bind(loop);
    a.e(E.arithReg("subs", true, XZR, 4, 20));
    a.bc(Cond.EQ, skip);
    a.e(E.logicReg("orr", true, 2, 4, 5));
    a.e(E.memImm("strx", 2, 3, 0));
    a.bind(skip);
    a.e(E.arithImm("add", true, 3, 3, 8));
    a.mov(2, BLOCK);
    a.e(E.arithReg("add", true, 4, 4, 2));
    a.e(E.arithImm("subs", true, 6, 6, 1));
    a.bc(Cond.NE, loop);
  }
  // The RAM channel: the block after RAM stays invalid, and nothing past it can run.
  if (bulkBytes > 0) {
    a.e(E.arithImm("add", true, 3, 3, 8));
    a.mov(2, BLOCK);
    a.e(E.arithReg("add", true, 4, 4, 2));
    a.mov(5, 0x0060000000000705n);
    a.mov(6, Math.ceil(bulkBytes / BLOCK));
    const loop = a.label();
    a.bind(loop);
    a.e(E.logicReg("orr", true, 2, 4, 5));
    a.e(E.memImm("strx", 2, 3, 0));
    a.e(E.arithImm("add", true, 3, 3, 8));
    a.mov(2, BLOCK);
    a.e(E.arithReg("add", true, 4, 4, 2));
    a.e(E.arithImm("subs", true, 6, 6, 1));
    a.bc(Cond.NE, loop);
  }
  // Written with the MMU off, read by a cached walk: clean and invalidate them.
  a.mr(1, 19);
  a.mov(2, TABLES_BYTES / 16);
  {
    const loop = a.label();
    a.bind(loop);
    a.e(0xd50b7e21); // dc civac, x1
    a.e(E.arithImm("add", true, 1, 1, 16));
    a.e(E.arithImm("subs", true, 2, 2, 1));
    a.bc(Cond.NE, loop);
  }
  a.e(E.DSB_SY);
  // MAIR: attr 0 device-nGnRnE, attr 1 normal write-back.
  a.mov(1, 0xff00);
  a.e(E.msr(E.MAIR_EL1, 1));
  // TCR: 32-bit VA from TTBR0 (level 1 start), walks cached and shareable, 4K pages, TTBR1 off, 40-bit PA.
  a.mov(1, 32n | (1n << 8n) | (1n << 10n) | (3n << 12n) | (1n << 23n) | (2n << 32n));
  a.e(E.msr(E.TCR_EL1, 1));
  a.e(E.msr(E.TTBR0_EL1, 19));
  a.e(E.ISB);
  a.e(E.TLBI_VMALLE1);
  a.e(E.DSB_SY);
  a.e(E.IC_IALLU);
  a.e(E.DSB_SY);
  a.e(E.ISB);
  // SCTLR: MMU, D-cache, I-cache, stack alignment checks. No alignment check on data.
  a.mov(1, 0x30d0181d);
  a.e(E.msr(E.SCTLR_EL1, 1));
  a.e(E.ISB);

  // Exception stack on SP_EL1, program stack on SP_EL0.
  a.la(1, "g:__exc_stack");
  a.mov(2, 16384);
  a.e(E.arithReg("add", true, 1, 1, 2));
  a.e(E.arithImm("add", true, E.SP, 1, 0));
  a.e(E.MSR_SPSEL_0);
  a.e(E.arithImm("add", true, E.SP, 21, 0));
  a.la(1, "f:__rt_vectors");
  a.e(E.msr(E.VBAR_EL1, 1));
  a.e(E.ISB);

  // Clear bss, now with caches on.
  a.la(1, "g:__bss_start");
  a.la(2, "g:__bss_end");
  {
    const loop = a.label();
    const done = a.label();
    a.bind(loop);
    a.e(E.arithReg("subs", true, XZR, 1, 2));
    a.bc(Cond.HS, done);
    a.e(E.memPair("stpx", "offset", XZR, XZR, 1, 0));
    a.e(E.arithImm("add", true, 1, 1, 16));
    a.b(loop);
    a.bind(done);
  }
  // __rt_main(arena start, arena end, guard). It doesn't return.
  a.mr(0, 21);
  a.mov(1, RAM_BASE + ramBytes);
  a.mr(2, 20);
  code.fix("bl26", "f:__rt_main");
  a.resolve();
  code.ranges.push({ name: "__start", from: start, to: code.here });

  code.alignWords(512); // VBAR needs 2 KiB alignment
  const vec = code.here;
  code.define("f:__rt_vectors");
  const common = a.label();
  for (let i = 0; i < 16; i++) {
    a.e(E.movz(true, 0, i));
    a.b(common);
    while ((code.here - vec) % 32 !== 0) a.e(E.NOP);
  }
  a.bind(common);
  a.e(E.mrs(1, E.ESR_EL1));
  a.e(E.mrs(2, E.ELR_EL1));
  a.e(E.mrs(3, E.FAR_EL1));
  code.fix("bl26", "f:__rt_exception");
  a.resolve();
  code.ranges.push({ name: "__rt_vectors", from: vec, to: code.here });
  return { imageSizeAt };
}

/** The routines compiled code calls by symbol. */
export function emitRoutines(code: Code): void {
  const a = new A(code);
  const from = code.here;

  code.define("f:__rt_off");
  a.mov(0, 0x84000008);
  a.e(E.HVC_0);
  {
    const spin = a.label();
    a.bind(spin);
    a.b(spin);
  }

  // __rt_try(fn): a setjmp and a call. The jump buffer's layout is private to these two routines.
  code.define("f:__rt_try");
  a.la(16, "g:__rt_jmp");
  a.e(E.memPair("stpx", "offset", 19, 20, 16, 0));
  a.e(E.memPair("stpx", "offset", 21, 22, 16, 16));
  a.e(E.memPair("stpx", "offset", 23, 24, 16, 32));
  a.e(E.memPair("stpx", "offset", 25, 26, 16, 48));
  a.e(E.memPair("stpx", "offset", 27, 28, 16, 64));
  a.e(E.memPair("stpx", "offset", 29, 30, 16, 80));
  a.e(E.arithImm("add", true, 17, E.SP, 0));
  a.e(E.memImm("strx", 17, 16, 96));
  a.e(E.memPair("stpd", "offset", 8, 9, 16, 112));
  a.e(E.memPair("stpd", "offset", 10, 11, 16, 128));
  a.e(E.memPair("stpd", "offset", 12, 13, 16, 144));
  a.e(E.memPair("stpd", "offset", 14, 15, 16, 160));
  a.e(E.movz(false, 17, 1));
  a.la(8, "g:__rt_try_active");
  a.e(E.memImm("strw", 17, 8, 0));
  a.e(E.blr(0));
  a.la(8, "g:__rt_try_active");
  a.e(E.memImm("strw", XZR, 8, 0));
  a.la(16, "g:__rt_jmp");
  a.e(E.memImm("ldrx", 30, 16, 88));
  a.e(E.movz(false, 0, 0));
  a.e(E.RET);

  // Back to the frame __rt_try saved, from either stack: ERET lands on SP_EL0 with interrupts masked.
  code.define("f:__rt_unwind");
  const resume = a.label();
  a.adr(0, resume);
  a.e(E.msr(E.ELR_EL1, 0));
  a.mov(0, 0x3c4);
  a.e(E.msr(E.SPSR_EL1, 0));
  a.e(E.ISB);
  a.e(E.ERET);
  a.bind(resume);
  a.la(16, "g:__rt_jmp");
  a.e(E.memPair("ldpx", "offset", 19, 20, 16, 0));
  a.e(E.memPair("ldpx", "offset", 21, 22, 16, 16));
  a.e(E.memPair("ldpx", "offset", 23, 24, 16, 32));
  a.e(E.memPair("ldpx", "offset", 25, 26, 16, 48));
  a.e(E.memPair("ldpx", "offset", 27, 28, 16, 64));
  a.e(E.memPair("ldpx", "offset", 29, 30, 16, 80));
  a.e(E.memImm("ldrx", 17, 16, 96));
  a.e(E.arithImm("add", true, E.SP, 17, 0));
  a.e(E.memPair("ldpd", "offset", 8, 9, 16, 112));
  a.e(E.memPair("ldpd", "offset", 10, 11, 16, 128));
  a.e(E.memPair("ldpd", "offset", 12, 13, 16, 144));
  a.e(E.memPair("ldpd", "offset", 14, 15, 16, 160));
  a.la(8, "g:__rt_try_active");
  a.e(E.memImm("strw", XZR, 8, 0));
  a.e(E.movz(false, 0, 1));
  a.e(E.RET);

  emitPortableRoutines(a);
  a.resolve();
  code.ranges.push({ name: "__rt_routines", from, to: code.here });
}

/**
 * The routines with nothing bare-metal in them, which a hosted runtime shares (hosted.ts, macos-arm64): __rt_toint32,
 * __rt_memset and __rt_memmove. The caller resolves `a`'s labels.
 */
export function emitPortableRoutines(a: A): void {
  const code = a.code;
  // __rt_toint32: bits in x16, return address in x17, result in w16. Only x8 and x16 change, so a
  // caller keeps everything in registers. ToInt32 from the bits, exact for every input.
  code.define("f:__rt_toint32");
  {
    const zero = a.label();
    const right = a.label();
    const sign = a.label();
    const pos = a.label();
    const done = a.label();
    a.e(E.memPair("stpx", "pre", 9, 10, E.SP, -16));
    a.e(E.ubfm(true, 8, 16, 52, 62));
    a.e(E.arithImm("subs", true, 8, 8, 1023));
    a.bc(Cond.LT, zero);
    a.e(E.arithImm("subs", true, XZR, 8, 83));
    a.bc(Cond.GT, zero);
    a.e(E.ubfm(true, 9, 16, 0, 51));
    a.e(E.movz(true, 10, 0x10, 3));
    a.e(E.logicReg("orr", true, 9, 9, 10));
    a.e(E.arithImm("subs", true, XZR, 8, 52));
    a.bc(Cond.LT, right);
    a.e(E.arithImm("sub", true, 8, 8, 52));
    a.e(E.shiftReg("lsl", true, 9, 9, 8));
    a.b(sign);
    a.bind(right);
    a.e(E.movz(true, 10, 52));
    a.e(E.arithReg("sub", true, 8, 10, 8));
    a.e(E.shiftReg("lsr", true, 9, 9, 8));
    a.bind(sign);
    a.e(E.arithImm("subs", true, XZR, 16, 0));
    a.bc(Cond.GE, pos);
    a.e(E.arithReg("sub", false, 9, XZR, 9));
    a.bind(pos);
    a.e(E.logicReg("orr", false, 16, XZR, 9));
    a.b(done);
    a.bind(zero);
    a.e(E.movz(false, 16, 0));
    a.bind(done);
    a.e(E.memPair("ldpx", "post", 9, 10, E.SP, 16));
    a.e(E.br(17));
  }

  // __rt_memset(p, v, n), for mem.fill.
  code.define("f:__rt_memset");
  {
    const small = a.label();
    const loop = a.label();
    const tail = a.label();
    const smallLoop = a.label();
    const done = a.label();
    a.e(E.logicImm("and", true, 1, 1, E.bitmask(0xffn, true)!));
    a.mov(3, 0x0101010101010101n);
    a.e(E.madd(true, 1, 1, 3, XZR));
    a.e(E.arithReg("add", true, 4, 0, 2)); // x4 = end
    a.e(E.arithImm("subs", true, XZR, 2, 16));
    a.bc(Cond.LO, small);
    a.e(E.memPair("stpx", "offset", 1, 1, 0, 0));
    a.e(E.arithImm("add", true, 3, 0, 16));
    a.e(E.logicImm("and", true, 3, 3, E.bitmask(0xfffffffffffffff0n, true)!));
    a.bind(loop);
    a.e(E.arithImm("add", true, 5, 3, 16));
    a.e(E.arithReg("subs", true, XZR, 5, 4));
    a.bc(Cond.HI, tail);
    a.e(E.memPair("stpx", "offset", 1, 1, 3, 0));
    a.mr(3, 5);
    a.b(loop);
    a.bind(tail);
    a.e(E.memPair("stpx", "offset", 1, 1, 4, -16));
    a.e(E.RET);
    // R20: under 16 bytes, by the bits of the count, an 8, 4, 2 and 1-byte store each (a byte at a time was 4
    // instructions a byte: a short string's tail zeroed when made).
    a.bind(small);
    a.bind(smallLoop);
    for (const [n, op] of [
      [8, "strx"],
      [4, "strw"],
      [2, "strh"],
      [1, "strb"],
    ] as const) {
      const next = a.label();
      a.e(E.logicImm("and", true, 5, 2, E.bitmask(BigInt(n), true)!));
      a.cbz(true, 5, next);
      // R20's injected bug (tools/r20-tests.ts): the 2-byte store left out. Never set otherwise.
      if (!(n === 2 && process.env.TMK_TEST_TSL === "memset-skip2")) a.e(E.memImm(op, 1, 0, 0));
      a.e(E.arithImm("add", true, 0, 0, n));
      a.bind(next);
    }
    a.bind(done);
    a.e(E.RET);
  }

  // __rt_memmove(d, s, n), for mem.copy: overlap allowed.
  code.define("f:__rt_memmove");
  {
    const back = a.label();
    const fwd = a.label();
    const fwdBytes = a.label();
    const backBytes = a.label();
    const done = a.label();
    a.cbz(true, 2, done);
    a.e(E.arithReg("subs", true, XZR, 0, 1));
    a.bc(Cond.EQ, done);
    a.bc(Cond.LO, fwd);
    a.e(E.arithReg("add", true, 3, 1, 2));
    a.e(E.arithReg("subs", true, XZR, 0, 3));
    a.bc(Cond.LO, back);
    a.bind(fwd);
    {
      const big = a.label();
      a.bind(big);
      a.e(E.arithImm("subs", true, XZR, 2, 32));
      a.bc(Cond.LO, fwdBytes);
      a.e(E.memPair("ldpq", "offset", 0, 1, 1, 0));
      a.e(E.memPair("stpq", "offset", 0, 1, 0, 0));
      a.e(E.arithImm("add", true, 1, 1, 32));
      a.e(E.arithImm("add", true, 0, 0, 32));
      a.e(E.arithImm("sub", true, 2, 2, 32));
      a.b(big);
    }
    // R20: what's left, under 32 bytes, by its bits, a 16, 8, 4, 2 and 1-byte step each, each loaded before it's stored
    // (a byte at a time was 7 instructions a byte, most of a short string's copy and of a 72-byte object's placing).
    // Forward, each step's bytes lie at or below the source's next, so a destination below the source is safe as before.
    a.bind(fwdBytes);
    tailSteps(a, false, done);
    a.bind(back);
    a.e(E.arithReg("add", true, 0, 0, 2));
    a.e(E.arithReg("add", true, 1, 1, 2));
    {
      const big = a.label();
      a.bind(big);
      a.e(E.arithImm("subs", true, XZR, 2, 32));
      a.bc(Cond.LO, backBytes);
      a.e(E.arithImm("sub", true, 1, 1, 32));
      a.e(E.arithImm("sub", true, 0, 0, 32));
      a.e(E.memPair("ldpq", "offset", 0, 1, 1, 0));
      a.e(E.memPair("stpq", "offset", 0, 1, 0, 0));
      a.e(E.arithImm("sub", true, 2, 2, 32));
      a.b(big);
    }
    // Backward, the same steps from the top of what's left down, so a destination above the source is safe as before.
    a.bind(backBytes);
    tailSteps(a, true, done);
    a.bind(done);
    a.e(E.RET);
  }
}

/**
 * R20: __rt_memmove's last bytes, under 32 (x2), as at most five steps by the bits of the count: 16 bytes through q0, then
 * 8, 4, 2 and 1 through x3, each step's bytes all loaded before any is stored. Forward, x0 and x1 point at the next bytes
 * and move up past each step; `back`, they point just past the last bytes left and move down before each. Ends at `done`.
 */
function tailSteps(a: A, back: boolean, done: number): void {
  const steps: [number, "q" | "x" | "w" | "h" | "b"][] = [
    [16, "q"],
    [8, "x"],
    [4, "w"],
    [2, "h"],
    [1, "b"],
  ];
  const ld = { q: "ldrq", x: "ldrx", w: "ldrw", h: "ldrh", b: "ldrb" } as const;
  const st = { q: "strq", x: "strx", w: "strw", h: "strh", b: "strb" } as const;
  // R20's injected bugs (tools/r20-tests.ts): the 4-byte step skipped either way, or the 1-byte step skipped copying up.
  // Never set otherwise.
  const fault = process.env.TMK_TEST_TSL;
  for (const [n, k] of steps) {
    const next = a.label();
    a.e(E.logicImm("and", true, 4, 2, E.bitmask(BigInt(n), true)!));
    a.cbz(true, 4, next);
    if (
      !(
        (fault === "memmove-skip4" && n === 4) ||
        (fault === "memmove-back-skip1" && back && n === 1)
      )
    ) {
      if (back) {
        a.e(E.arithImm("sub", true, 1, 1, n));
        a.e(E.arithImm("sub", true, 0, 0, n));
      }
      a.e(E.memImm(ld[k], 3, 1, 0));
      a.e(E.memImm(st[k], 3, 0, 0));
      if (!back) {
        a.e(E.arithImm("add", true, 1, 1, n));
        a.e(E.arithImm("add", true, 0, 0, n));
      }
    }
    a.bind(next);
  }
  a.b(done);
}
