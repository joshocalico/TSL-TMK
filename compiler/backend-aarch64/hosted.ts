// The macos-arm64 target (D56, D57): the same TIR, runtime and driver as the bare-metal Image, compiled for a user-space
// process on macOS and written as a Mach-O relocatable object (macho.ts) for the system linker. What differs from the
// bare-metal build is only here and behind `EmitContext.hosted`:
//
// - The start is the C `main`, called by dyld with libSystem ready. It installs a signal handler on an alternate stack,
//   maps a stack with a 2 MiB guard below it and an arena with mmap, switches to that stack and calls __rt_main, as the
//   bare-metal start code does after building its page tables.
// - Output: `native.putc` goes to __rt_putc, which buffers bytes and writes them to fd 1 through libSystem's `write`
//   when the buffer fills and at exit. It changes no register but x16 and x17, as the PL011 store did.
// - `native.off` is __rt_off: flush, then `exit` with __rt_exit_status, which is 1 unless __rt_main got to TMK:DONE.
// - Faults: a SIGSEGV, SIGBUS, SIGILL or SIGTRAP handler (SA_SIGINFO, on the alternate stack) rewrites the interrupted
//   context so that, after the kernel's sigreturn, the thread runs __rt_exception(0, esr, pc, far) on the exception stack,
//   as the bare-metal vectors do. The report, the R7 null-check table (__rt_null_pcs: a fault at a listed load is trap 6),
//   the guard (trap 14) and native.try's unwinding are then the bare-metal runtime's TIR, unchanged.
//
// Only libSystem's C functions are called, through the Apple arm64 convention, never system calls (their ABI isn't
// stable). x18 is never used. Every hand-written routine that calls builds a frame record and keeps SP 16-byte aligned.
import { FREM_HELPER } from "../tir/helpers.ts";
import { assemble } from "../tir/asm.ts";
import { canonicalize, type Func, type Global, type Module } from "../tir/ir.ts";
import { printModule } from "../tir/text.ts";
import { verifyModule } from "../tir/verify.ts";
import { backendFaults, Code, emitFunction, type EmitContext } from "./emit.ts";
import * as E from "./encode.ts";
import { Cond, XZR } from "./encode.ts";
import {
  type ImageInput,
  type ImageOutput,
  reachable,
  ROOTS,
  usedGlobals,
  withStatics,
} from "./image.ts";
import { libmFuncs } from "./libm.ts";
import {
  type MachoReloc,
  type MachoSection,
  type MachoSymbol,
  S_ATTR_PURE_INSTRUCTIONS,
  S_ATTR_SOME_INSTRUCTIONS,
  S_REGULAR,
  S_ZEROFILL,
  writeMachoObject,
} from "./macho.ts";
import { rtModule } from "./rt-tir.ts";
import { A, emitPortableRoutines, IMAGE_TAIL_BYTES } from "./runtime.ts";

const BLOCK = 0x200000; // the guard below the stack, and the arena's alignment, as on bare metal
const STACK_BYTES = 8 * 1024 * 1024;
const OBUF_BYTES = 65536; // a multiple of 4096: putc compares the count by its 4 KiB units
const ALT_STACK_BYTES = 64 * 1024;
const EXC_STACK_BYTES = 16384; // rt-tir.ts's __exc_stack

// macOS arm64 values, from the SDK's headers (checked by compiling a probe against them; no header is copied).
const SIGILL = 4;
const SIGTRAP = 5;
const SIGBUS = 10;
const SIGSEGV = 11;
const SA_ONSTACK = 0x1;
const SA_SIGINFO = 0x40;
const PROT_RW = 3;
const MAP_PRIVATE_ANON = 0x1002;
const EXIT_NO_MEMORY = 71;
// ucontext_t's uc_mcontext pointer, and in __darwin_mcontext64 the exception state (far, esr) and the thread state.
const UC_MCONTEXT = 48;
const MC_FAR = 0;
const MC_ESR = 8;
const MC_X0 = 16;
const MC_FP = 248;
const MC_LR = 256;
const MC_SP = 264;
const MC_PC = 272;
const NZCV: E.SysReg = { op0: 3, op1: 3, crn: 4, crm: 2, op2: 0 };
const BRK_0 = 0xd4200000;

/** The minimum macOS this target asks the linker for. */
export const MACOS_MIN: [number, number, number] = [11, 0, 0];

// --- the runtime's TIR: the bare-metal module with __rt_main ending in exit status 0

const S_READY = "TMK:READY\n";
const S_DONE = "TMK:DONE\n";

const HOSTED_MAIN = `
extern @__tmk_main() -> ()
extern @__rt_puts(ptr, ix) -> ()
global @__mem_base size=8 align=8 section=data
global @__mem_limit size=8 align=8 section=data
global @__rt_guard size=8 align=8 section=data
global @__s_ready size=${S_READY.length} align=1 section=data
global @__s_done size=${S_DONE.length} align=1 section=data
global @__rt_exit_status size=4 align=4 section=data
func @__rt_main(%arena: ptr, %limit: ptr, %guard: ptr) -> () {
bb_e:
  %b = globaladdr @__mem_base
  store.ptr.na %b, %arena
  %l = globaladdr @__mem_limit
  store.ptr.na %l, %limit
  %g = globaladdr @__rt_guard
  store.ptr.na %g, %guard
  %pa = globaladdr @__s_ready
  %na = iconst.ix ${S_READY.length}
  call @__rt_puts %pa, %na
  call @__tmk_main
  %pb = globaladdr @__s_done
  %nb = iconst.ix ${S_DONE.length}
  call @__rt_puts %pb, %nb
  %st = globaladdr @__rt_exit_status
  %z = iconst.i32 0
  store.i32.na %st, %z
  intrinsic native.off
  unreachable
}
`;

const HOSTED_GLOBALS: Global[] = [
  {
    name: "__rt_exit_status",
    size: 4,
    align: 4,
    section: "data",
    bytes: new Uint8Array([1, 0, 0, 0]),
  },
  { name: "__rt_obuf", size: 8 + OBUF_BYTES, align: 16, section: "data" }, // a count, then the bytes
  { name: "__rt_altstack", size: ALT_STACK_BYTES, align: 16, section: "data" },
];

function hostedRt(): Module {
  const rt = rtModule(0);
  const main = assemble(HOSTED_MAIN).funcs.find((f) => f.name === "__rt_main")!;
  return {
    ...rt,
    funcs: rt.funcs.map((f) => (f.name === "__rt_main" ? main : f)),
    globals: [...rt.globals, ...HOSTED_GLOBALS],
  };
}

// --- the hand-written part

/** __rt_putc, __rt_flush, __rt_off, __rt_try, __rt_unwind, the signal handler, and the portable routines. */
function emitHostedRoutines(code: Code): void {
  const a = new A(code);
  const from = code.here;

  // __rt_putc: the byte in x16, the return address in x17 (emit.ts's hosted native.putc). Only x16 and x17 change.
  code.define("f:__rt_putc");
  {
    const flush = a.label();
    a.e(E.memPair("stpx", "pre", 0, 1, E.SP, -16));
    a.la(0, "g:__rt_obuf");
    a.e(E.memImm("ldrx", 1, 0, 0));
    a.e(E.arithImm("add", true, 1, 1, 1));
    a.e(E.memImm("strx", 1, 0, 0));
    a.e(E.arithReg("add", true, 0, 0, 1));
    a.e(E.memImm("strb", 16, 0, 7)); // the bytes start at 8, and x1 is the new count
    // Written when the buffer is full and at exit, not at each newline (T2): a program whose results are read from memory
    // prints its pages a line at a time, and a `write` a line was nearly all of its run (500,000 lines, 0.9 s in the kernel).
    a.e(E.arithImm("subs", true, XZR, 1, OBUF_BYTES >>> 12, true));
    a.bc(Cond.HS, flush);
    a.e(E.memPair("ldpx", "post", 0, 1, E.SP, 16));
    a.e(E.br(17));
    a.bind(flush);
    a.e(E.memPair("ldpx", "post", 0, 1, E.SP, 16));
    // On into __rt_flush_saving, with x17 still the return address.
  }

  // __rt_flush_saving: __rt_flush with every register compiled code could hold kept, then back through x17.
  code.define("f:__rt_flush_saving");
  {
    const frame = 528; // x0-x15, x17 and the flags, then q0-q7 and q16-q31
    a.e(E.memPair("stpx", "pre", 29, 30, E.SP, -16));
    a.e(E.arithImm("add", true, 29, E.SP, 0));
    a.e(E.arithImm("sub", true, E.SP, E.SP, frame));
    for (let r = 0; r < 16; r += 2) a.e(E.memPair("stpx", "offset", r, r + 1, E.SP, r * 8));
    a.e(E.mrs(0, NZCV));
    a.e(E.memPair("stpx", "offset", 17, 0, E.SP, 128));
    const qs = [0, 2, 4, 6, 16, 18, 20, 22, 24, 26, 28, 30];
    qs.forEach((q, i) => a.e(E.memPair("stpq", "offset", q, q + 1, E.SP, 144 + 32 * i)));
    code.fix("bl26", "f:__rt_flush");
    qs.forEach((q, i) => a.e(E.memPair("ldpq", "offset", q, q + 1, E.SP, 144 + 32 * i)));
    a.e(E.memPair("ldpx", "offset", 17, 0, E.SP, 128));
    a.e(E.msr(NZCV, 0));
    for (let r = 0; r < 16; r += 2) a.e(E.memPair("ldpx", "offset", r, r + 1, E.SP, r * 8));
    a.e(E.arithImm("add", true, E.SP, E.SP, frame));
    a.e(E.memPair("ldpx", "post", 29, 30, E.SP, 16));
    a.e(E.br(17));
  }

  // __rt_flush(): writes the buffer to fd 1 and empties it. The C convention; a short write goes on from where it stopped.
  code.define("f:__rt_flush");
  {
    const loop = a.label();
    const done = a.label();
    a.e(E.memPair("stpx", "pre", 29, 30, E.SP, -32));
    a.e(E.arithImm("add", true, 29, E.SP, 0));
    a.e(E.memPair("stpx", "offset", 19, 20, E.SP, 16));
    a.la(19, "g:__rt_obuf");
    a.e(E.movz(true, 20, 0));
    a.bind(loop);
    a.e(E.memImm("ldrx", 2, 19, 0));
    a.e(E.arithReg("subs", true, 2, 2, 20));
    a.bc(Cond.LS, done);
    a.e(E.movz(false, 0, 1));
    a.e(E.arithImm("add", true, 1, 19, 8));
    a.e(E.arithReg("add", true, 1, 1, 20));
    code.fix("bl26", "c:write");
    a.e(E.arithImm("subs", true, XZR, 0, 0));
    a.bc(Cond.LE, done);
    a.e(E.arithReg("add", true, 20, 20, 0));
    a.b(loop);
    a.bind(done);
    a.e(E.memImm("strx", XZR, 19, 0));
    a.e(E.memPair("ldpx", "offset", 19, 20, E.SP, 16));
    a.e(E.memPair("ldpx", "post", 29, 30, E.SP, 32));
    a.e(E.RET);
  }

  // __rt_off: native.off. Flush, then exit with the status: 0 only after TMK:DONE.
  code.define("f:__rt_off");
  a.e(E.memPair("stpx", "pre", 29, 30, E.SP, -16)); // a frame record, so a backtrace from inside shows who stopped
  a.e(E.arithImm("add", true, 29, E.SP, 0));
  code.fix("bl26", "f:__rt_flush");
  a.la(0, "g:__rt_exit_status");
  a.e(E.memImm("ldrw", 0, 0, 0));
  code.fix("bl26", "c:exit");
  a.e(BRK_0);

  // __rt_try(fn): as on bare metal, a setjmp and a call. The jump buffer's layout is private to these two routines.
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

  // __rt_unwind: back to the frame __rt_try saved. Hosted there is one privilege level and a fault arrives here through the
  // signal handler's rewritten context, so it's the bare-metal routine with no ERET.
  code.define("f:__rt_unwind");
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

  // __rt_signal(sig, info, uc): the C convention, a leaf. The interrupted thread is made to resume in
  // __rt_exception(0, esr, pc, far) on the exception stack, with a frame chain that ends there. A data or instruction abort
  // from user space has its exception class made the same-level one, which is what the bare-metal TIR tests for.
  code.define("f:__rt_signal");
  {
    const bump = a.label();
    const keep = a.label();
    a.e(E.memImm("ldrx", 9, 2, UC_MCONTEXT));
    a.e(E.memImm("ldrx", 10, 9, MC_FAR));
    a.e(E.memImm("ldrw", 11, 9, MC_ESR));
    a.e(E.memImm("ldrx", 12, 9, MC_PC));
    a.e(E.ubfm(false, 13, 11, 26, 31));
    a.e(E.arithImm("subs", false, XZR, 13, 0x24));
    a.bc(Cond.EQ, bump);
    a.e(E.arithImm("subs", false, XZR, 13, 0x20));
    a.bc(Cond.NE, keep);
    a.bind(bump);
    a.e(E.movz(false, 14, 0x0400, 1));
    a.e(E.arithReg("add", false, 11, 11, 14));
    a.bind(keep);
    a.e(E.memImm("strx", XZR, 9, MC_X0));
    a.e(E.memImm("strx", 11, 9, MC_X0 + 8));
    a.e(E.memImm("strx", 12, 9, MC_X0 + 16));
    a.e(E.memImm("strx", 10, 9, MC_X0 + 24));
    a.la(13, "g:__exc_stack");
    a.e(E.arithImm("add", true, 13, 13, EXC_STACK_BYTES >>> 12, true));
    a.e(E.memImm("strx", 13, 9, MC_SP));
    a.e(E.memImm("strx", XZR, 9, MC_FP));
    a.e(E.memImm("strx", XZR, 9, MC_LR));
    a.la(13, "f:__rt_exception");
    a.e(E.memImm("strx", 13, 9, MC_PC));
    a.e(E.RET);
  }

  emitPortableRoutines(a);
  a.resolve();
  code.ranges.push({ name: "__rt_routines", from, to: code.here });
}

/** The C `main`: signals, the stack and the arena, then __rt_main(arena, limit, guard) on the new stack. */
function emitHostedMain(code: Code, arenaBytes: number, stackBytes: number): void {
  const a = new A(code);
  const from = code.here;
  const fail = a.label();
  code.define("x:_main");
  a.e(E.memPair("stpx", "pre", 29, 30, E.SP, -16));
  a.e(E.arithImm("add", true, 29, E.SP, 0));
  a.e(E.arithImm("sub", true, E.SP, E.SP, 32));
  // sigaltstack(&{ ss_sp, ss_size, ss_flags = 0 }, NULL)
  a.la(0, "g:__rt_altstack");
  a.e(E.memImm("strx", 0, E.SP, 0));
  a.mov(0, ALT_STACK_BYTES);
  a.e(E.memImm("strx", 0, E.SP, 8));
  a.e(E.memImm("strx", XZR, E.SP, 16));
  a.e(E.arithImm("add", true, 0, E.SP, 0));
  a.e(E.movz(true, 1, 0));
  code.fix("bl26", "c:sigaltstack");
  // sigaction(sig, &{ handler, sa_mask = 0, sa_flags }, NULL) for each fault signal
  a.la(0, "f:__rt_signal");
  a.e(E.memImm("strx", 0, E.SP, 0));
  a.mov(0, BigInt(SA_SIGINFO | SA_ONSTACK) << 32n);
  a.e(E.memImm("strx", 0, E.SP, 8));
  for (const sig of [SIGILL, SIGTRAP, SIGBUS, SIGSEGV]) {
    a.e(E.movz(false, 0, sig));
    a.e(E.arithImm("add", true, 1, E.SP, 0));
    a.e(E.movz(true, 2, 0));
    code.fix("bl26", "c:sigaction");
  }
  const mmap = (bytes: number): void => {
    a.e(E.movz(true, 0, 0));
    a.mov(1, bytes);
    a.e(E.movz(false, 2, PROT_RW));
    a.e(E.movz(false, 3, MAP_PRIVATE_ANON));
    a.e(E.movn(false, 4, 0));
    a.e(E.movz(true, 5, 0));
    code.fix("bl26", "c:mmap");
    a.e(E.arithImm("adds", true, XZR, 0, 1)); // MAP_FAILED is -1
    a.bc(Cond.EQ, fail);
  };
  // x19 = the guard, with the stack above it
  mmap(BLOCK + stackBytes);
  a.mr(19, 0);
  a.mov(1, BLOCK);
  a.e(E.movz(false, 2, 0));
  code.fix("bl26", "c:mprotect");
  a.cbnz(false, 0, fail);
  // x20 = the arena, 2 MiB aligned, x21 = its end
  mmap(arenaBytes + BLOCK);
  a.mov(1, BLOCK - 1);
  a.e(E.arithReg("add", true, 20, 0, 1));
  a.e(E.logicReg("bic", true, 20, 20, 1));
  a.mov(1, arenaBytes);
  a.e(E.arithReg("add", true, 21, 20, 1));
  // onto the new stack; x29 still addresses this frame's record, on the old one
  a.mov(1, BLOCK + stackBytes);
  a.e(E.arithReg("add", true, 1, 19, 1));
  a.e(E.arithImm("add", true, E.SP, 1, 0));
  a.mr(0, 20);
  a.mr(1, 21);
  a.mr(2, 19);
  code.fix("bl26", "f:__rt_main");
  a.e(BRK_0);
  a.bind(fail);
  a.e(E.movz(false, 0, EXIT_NO_MEMORY));
  code.fix("bl26", "c:exit");
  a.e(BRK_0);
  a.resolve();
  code.ranges.push({ name: "_main", from, to: code.here });
}

// --- the object

/** The Mach-O symbol for a code or data name: TIR's live under `_tsl$`, the C entry and imports are C names. */
function symbolName(sym: string): string {
  if (sym.startsWith("f:")) return `_tsl$${sym.slice(2)}`;
  if (sym.startsWith("g:")) return `_tsl$g$${sym.slice(2)}`;
  if (sym.startsWith("x:")) return sym.slice(2);
  if (sym.startsWith("c:")) return `_${sym.slice(2)}`;
  throw new Error(`hosted: no symbol form for ${sym}`);
}

export interface HostedOutput extends ImageOutput {
  /** The libSystem functions the object imports, by C name. */
  imports: string[];
  /** R7: how many loads stand for a null check, in __rt_null_pcs. */
  nullListed: number;
}

/**
 * The program, its runtime and driver as one Mach-O relocatable object for macOS on arm64, whose `_main` runs it. The
 * input is the bare-metal image's; `bulkBytes` must be 0 (output goes to fd 1). `bytes` is the object, for `ld`.
 */
export function buildHostedObject(inp: ImageInput): HostedOutput {
  if (inp.module.externs.length > 0) {
    throw new Error(
      `hosted: a build with no fallback can't have externs: ${inp.module.externs.map((e) => e.name).join(", ")}`,
    );
  }
  if ((inp.bulkBytes ?? 0) > 0)
    throw new Error("hosted: there is no RAM channel; output goes to fd 1");
  const rt = hostedRt();
  const helpers = [FREM_HELPER(), ...libmFuncs().funcs];
  const merged: Module = {
    sigs: [...inp.module.sigs, ...(inp.extraSigs ?? [])],
    globals: [...inp.module.globals, ...rt.globals, ...inp.driverGlobals, ...libmFuncs().globals],
    funcs: [...inp.module.funcs, ...rt.funcs, ...helpers, ...withStatics(inp)],
    traps: [...inp.module.traps, ...rt.traps, ...(inp.driverTraps ?? [])],
    externs: [],
  };
  const byName = new Map<string, Func>();
  for (const f of merged.funcs) {
    if (byName.has(f.name)) throw new Error(`hosted: two functions named @${f.name}`);
    byName.set(f.name, f);
  }
  const keep = reachable(byName, ROOTS);
  const kept = merged.funcs.filter((f) => keep.has(f.name));
  const globalsUsed = usedGlobals(kept);
  for (const g of [
    "__mem_base",
    "__mem_limit",
    "__exc_stack",
    "__rt_jmp",
    "__rt_try_active",
    ...HOSTED_GLOBALS.map((h) => h.name),
  ]) {
    globalsUsed.add(g);
  }
  const m = canonicalize({
    ...merged,
    funcs: kept,
    globals: merged.globals.filter((g) => globalsUsed.has(g.name)),
  });
  const errors = verifyModule(m);
  if (errors.length > 0) throw new Error(`hosted: TIR verifier:\n${errors.join("\n")}`);

  const code = new Code();
  code.define("f:__tmk_text"); // the start of the text, which __rt_null_pcs's entries are measured from
  emitHostedRoutines(code);
  const trapCode = new Map<number, number>();
  for (const t of m.traps) trapCode.set(t.id, t.code);
  const level = inp.level ?? inp.module.opt ?? 0;
  const programFuncs = new Set(inp.module.funcs.map((f) => f.name));
  const ctx: EmitContext = {
    code,
    m,
    trapCode,
    funcs: byName,
    stats: { spilledValues: 0, frames: 0 },
    shape: (f) => (level > 0 && programFuncs.has(f.name) ? backendFaults() : null),
    nullPcs: [],
    hosted: true,
  };
  for (const f of m.funcs) emitFunction(f, ctx);

  // Data: initialised globals in __data, the rest in __bss, each at its alignment.
  const initialised: Global[] = [];
  const zero: Global[] = [];
  const nullPcs = ctx.nullPcs!;
  const nullAt = m.globals.findIndex((g) => g.name === "__rt_null_pcs");
  if (nullAt >= 0 && nullPcs.length > 0) {
    const size = 8 * (2 * nullPcs.length + 1);
    const table = { ...m.globals[nullAt]!, size, bytes: new Uint8Array(size) };
    const view = new DataView(table.bytes.buffer);
    view.setBigUint64(0, BigInt(nullPcs.length), true);
    nullPcs.forEach((x, i) => {
      view.setBigInt64(8 * (2 * i + 1), BigInt(x.pc * 4), true); // + the text's address - the table's, by relocation
      view.setBigInt64(8 * (2 * i + 2), BigInt(x.off), true);
    });
    m.globals[nullAt] = table;
  }
  for (const g of m.globals) (g.bytes?.some((b) => b !== 0) === true ? initialised : zero).push(g);
  const place = (gs: Global[]): { at: Map<string, number>; size: number; align: number } => {
    const at = new Map<string, number>();
    let off = 0;
    let maxAlign = 16;
    for (const g of gs) {
      const al = Math.max(g.align, 1);
      maxAlign = Math.max(maxAlign, al);
      off = Math.ceil(off / al) * al;
      at.set(g.name, off);
      off += g.size;
    }
    return { at, size: Math.ceil(off / 16) * 16, align: maxAlign };
  };
  const data = place(initialised);
  const bss = place(zero);

  // The arena is what the bare-metal image would have left of the same RAM after itself, a guard and the stack.
  const stackBytes = inp.stackBytes ?? STACK_BYTES;
  const hostedOnly = HOSTED_GLOBALS.reduce((n, g) => n + g.size, 0);
  const imageEnd =
    Math.ceil((code.here * 4 + 1024) / 4096) * 4096 +
    data.size +
    bss.size -
    hostedOnly +
    IMAGE_TAIL_BYTES;
  const stackTop = Math.ceil(imageEnd / BLOCK) * BLOCK + BLOCK + stackBytes;
  const arenaBytes = inp.ramBytes - stackTop;
  if (arenaBytes <= 0) throw new Error("hosted: no room for an arena in ramBytes");
  emitHostedMain(code, arenaBytes, stackBytes);
  const codeBytes = code.here * 4;

  // Text: branches within it are resolved here, everything else is a relocation for ld.
  const textRelocs: MachoReloc[] = [];
  const imports = new Set<string>();
  const w = code.words;
  for (const fx of code.fixups) {
    const pc = fx.at * 4;
    const word = w[fx.at]!;
    if (fx.kind === "b26" || fx.kind === "bl26") {
      if (fx.sym.startsWith("c:")) {
        imports.add(fx.sym.slice(2));
        w[fx.at] = fx.kind === "b26" ? E.b(0) : E.bl(0);
        textRelocs.push({ address: pc, kind: "branch26", symbol: symbolName(fx.sym) });
        continue;
      }
      const target = code.symbols.get(fx.sym);
      if (target === undefined) throw new Error(`hosted: undefined symbol ${fx.sym}`);
      w[fx.at] = fx.kind === "b26" ? E.b(target * 4 - pc) : E.bl(target * 4 - pc);
      continue;
    }
    const defined = fx.sym.startsWith("f:")
      ? code.symbols.has(fx.sym)
      : data.at.has(fx.sym.slice(2)) || bss.at.has(fx.sym.slice(2));
    if (!defined) throw new Error(`hosted: undefined symbol ${fx.sym}`);
    const addend = fx.addend ?? 0;
    switch (fx.kind) {
      case "adrp":
        w[fx.at] = E.adrp(word & 31, 0);
        textRelocs.push({ address: pc, kind: "page21", symbol: symbolName(fx.sym), addend });
        break;
      case "add12":
        w[fx.at] = E.arithImm("add", true, word & 31, (word >>> 5) & 31, 0);
        textRelocs.push({ address: pc, kind: "pageoff12", symbol: symbolName(fx.sym) });
        break;
      case "lo12":
        w[fx.at] = (word & ~(0xfff << 10)) >>> 0;
        textRelocs.push({ address: pc, kind: "pageoff12", symbol: symbolName(fx.sym), addend });
        break;
      case "ldr12x":
        throw new Error("unused fixup");
    }
  }
  const text = new Uint8Array(codeBytes);
  const tv = new DataView(text.buffer);
  for (let i = 0; i < w.length; i++) tv.setUint32(i * 4, w[i]!, true);

  const dataBytes = new Uint8Array(data.size);
  for (const g of initialised) dataBytes.set(g.bytes!, data.at.get(g.name)!);
  const dataRelocs: MachoReloc[] = [];
  if (nullAt >= 0 && nullPcs.length > 0) {
    const base = data.at.get("__rt_null_pcs")!;
    nullPcs.forEach((_, i) => {
      const address = base + 8 * (2 * i + 1);
      dataRelocs.push({ address, kind: "subtractor", symbol: symbolName("g:__rt_null_pcs") });
      dataRelocs.push({ address, kind: "unsigned", symbol: symbolName("f:__tmk_text") });
    });
  }

  const sections: MachoSection[] = [
    {
      sectname: "__text",
      segname: "__TEXT",
      bytes: text,
      size: codeBytes,
      align: 16,
      flags: S_REGULAR | S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS,
      relocs: textRelocs,
    },
    {
      sectname: "__data",
      segname: "__DATA",
      bytes: dataBytes,
      size: data.size,
      align: data.align,
      flags: S_REGULAR,
      relocs: dataRelocs,
    },
    {
      sectname: "__bss",
      segname: "__DATA",
      bytes: null,
      size: bss.size,
      align: bss.align,
      flags: S_ZEROFILL,
      relocs: [],
    },
  ];
  const symbols: MachoSymbol[] = [];
  const offsets = new Map<string, number>();
  for (const [name, word] of [...code.symbols].sort(
    (x, y) => x[1] - y[1] || (x[0] < y[0] ? -1 : 1),
  )) {
    symbols.push({
      name: symbolName(name),
      section: 1,
      offset: word * 4,
      external: name.startsWith("x:"),
    });
    offsets.set(name, word * 4);
  }
  for (const g of initialised) {
    symbols.push({
      name: symbolName(`g:${g.name}`),
      section: 2,
      offset: data.at.get(g.name)!,
      external: false,
    });
    offsets.set(`g:${g.name}`, data.at.get(g.name)!);
  }
  for (const g of zero) {
    symbols.push({
      name: symbolName(`g:${g.name}`),
      section: 3,
      offset: bss.at.get(g.name)!,
      external: false,
    });
    offsets.set(`g:${g.name}`, bss.at.get(g.name)!);
  }
  for (const c of [...imports].sort())
    symbols.push({ name: `_${c}`, section: 0, offset: 0, external: true });

  const bytes = writeMachoObject({ sections, symbols, minos: MACOS_MIN, sdk: MACOS_MIN });
  return {
    bytes,
    codeBytes,
    dataBytes: data.size,
    bssBytes: bss.size,
    ranges: code.ranges.map((r) => ({ name: r.name, from: r.from * 4, to: r.to * 4 })),
    symbols: offsets,
    get tirText(): string {
      return printModule(m);
    },
    stats: { functions: m.funcs.length, spilledSlots: ctx.stats.spilledValues },
    imports: [...imports].sort(),
    nullListed: nullAt >= 0 ? nullPcs.length : 0,
  };
}
