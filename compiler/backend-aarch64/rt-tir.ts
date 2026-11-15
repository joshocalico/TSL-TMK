// The bare-metal runtime's portable part, in TIR and compiled like everything else: serial output,
// trap reporting and SHA-256 (SPEC 8.2, 4.5). Reports use only TMK: lines.
import { assemble } from "../tir/asm.ts";
import type { Module } from "../tir/ir.ts";

/** An unmapped gap between the end of the guest's RAM and the channel, so running off RAM still faults. */
export const BULK_GUARD_BYTES = 0x200000;
export const BULK_SUM_START = 2166136261 | 0;
export type BulkFault = "flip" | "short" | "truncate" | "no-trailer";

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function hexBytes(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) out += s.charCodeAt(i).toString(16).padStart(2, "0");
  return out;
}

function kTable(): string {
  let out = "";
  for (const k of K) {
    out += (k & 0xff).toString(16).padStart(2, "0");
    out += ((k >>> 8) & 0xff).toString(16).padStart(2, "0");
    out += ((k >>> 16) & 0xff).toString(16).padStart(2, "0");
    out += ((k >>> 24) & 0xff).toString(16).padStart(2, "0");
  }
  return out;
}

const lit = (name: string, s: string): string =>
  `global @${name} size=${s.length} align=1 section=data bytes=${hexBytes(s)}\n`;

const putLit = (name: string, n: number, tag: string): string => `
  %p_${tag} = globaladdr @${name}
  %n_${tag} = iconst.ix ${n}
  call @__rt_puts %p_${tag}, %n_${tag}`;

const S = {
  ready: "TMK:READY\n",
  done: "TMK:DONE\n",
  panic: "TMK:PANIC trap ",
  caseT: "TMK:C ",
  t: " T ",
  fatal: "TMK:FATAL exception kind=",
  esr: " esr=",
  elr: " elr=",
  far: " far=",
};

/**
 * The RAM channel for a test image's bulk output (SPEC 8.2, D45). What would have gone to the PL011 goes to memory past the end of
 * the guest's RAM instead, and only sentinels stay on serial: READY, PANIC, FATAL, DONE, and BULK, which says how many bytes
 * there are and their checksum. With `__rt_bulk_cur` zero, output goes to serial: before the channel opens, and from when it
 * closes or the guest is dying.
 */
function bulkText(bulkBytes: number, fault?: BulkFault): string {
  // Each of these is the channel going wrong, for a test that the harness notices (SPEC 8.2, `tmk milestone native-g`).
  const beforeSum =
    fault === "truncate"
      ? "  %cut = iconst.ix 4096\n  %cur = call @__rt_bulk_cut %cur0, %cut\n"
      : "  %z0 = iconst.ix 0\n  %cur = gep %cur0, %z0, 1, 0\n";
  const afterSum =
    fault === "flip"
      ? "  %fb = load.i8.na %start\n  %fw = zext.i32 %fb\n  %f1 = iconst.i32 1\n  %fx = xor.i32 %fw, %f1\n  %fn = trunc.i8 %fx\n  store.i8.na %start, %fn\n"
      : "";
  const reported =
    fault === "short"
      ? "  %eight = iconst.ix 8\n  %n1 = sub.ix %n, %eight\n"
      : "  %n1 = bitcast.ix %n\n";
  return `
global @__rt_bulk_start size=8 align=8 section=data
global @__rt_bulk_cur size=8 align=8 section=data
global @__rt_bulk_end size=8 align=8 section=data
${lit("__s_bulk", "TMK:BULK ")}${lit("__s_full", "TMK:FATAL bulk channel full\n")}
func @__rt_bulk_open(%limit: ptr) -> () {
bb_e:
  %guard = iconst.ix ${BULK_GUARD_BYTES}
  %start = gep %limit, %guard, 1, 0
  %size = iconst.ix ${bulkBytes}
  %end = gep %start, %size, 1, 0
  %gs = globaladdr @__rt_bulk_start
  store.ptr.na %gs, %start
  %gc = globaladdr @__rt_bulk_cur
  store.ptr.na %gc, %start
  %ge = globaladdr @__rt_bulk_end
  store.ptr.na %ge, %end
  ret
}
func @__rt_bulk_stop() -> () {
bb_e:
  %z = iconst.ptr 0
  %gc = globaladdr @__rt_bulk_cur
  store.ptr.na %gc, %z
  %ge = globaladdr @__rt_bulk_end
  store.ptr.na %ge, %z
  ret
}
func @__rt_out(%c: i32) -> () {
bb_e:
  %gc = globaladdr @__rt_bulk_cur
  %p = load.ptr.na %gc
  %ge = globaladdr @__rt_bulk_end
  %end = load.ptr.na %ge
  %room = icmp.ult.ptr %p, %end
  brif %room, bb_ram, bb_not
bb_ram:
  %b = trunc.i8 %c
  store.i8.na %p, %b
  %zero = iconst.ix 0
  %next = gep %p, %zero, 1, 1
  store.ptr.na %gc, %next
  ret
bb_not:
  %z = iconst.ptr 0
  %off = icmp.eq.ptr %p, %z
  brif %off, bb_serial, bb_full
bb_serial:
  intrinsic native.putc %c
  ret
bb_full:
  call @__rt_bulk_stop
  ${putLit("__s_full", 28, "full")}
  intrinsic native.off
  unreachable
}
func @__rt_bulk_close() -> () {
bb_e:
  %gs = globaladdr @__rt_bulk_start
  %start = load.ptr.na %gs
  %gc = globaladdr @__rt_bulk_cur
  %cur0 = load.ptr.na %gc
${beforeSum}  %a = bitcast.ix %start
  %b = bitcast.ix %cur
  %n = sub.ix %b, %a
  %h0 = iconst.i32 ${BULK_SUM_START}
  call @__rt_bulk_stop
  br bb_loop(%start, %h0)
bb_loop(%p: ptr, %h: i32):
  %more = icmp.ult.ptr %p, %cur
  brif %more, bb_word, bb_done
bb_word:
  %w = load.i32.na %p
  %x = xor.i32 %h, %w
  %prime = iconst.i32 16777619
  %y = mul.i32 %x, %prime
  %zero = iconst.ix 0
  %q = gep %p, %zero, 1, 4
  br bb_loop(%q, %y)
bb_done:
${afterSum}${fault === "no-trailer" ? "  ret\n}\n" : ""}${fault === "no-trailer" ? "func @__rt_unused(%n: ix, %h: i32) -> () {\nbb_e:\n" : ""}  ${putLit("__s_bulk", 9, "bulk")}
${fault === "no-trailer" ? "  %n1 = bitcast.ix %n\n" : reported}  %n64 = bitcast.i64 %n1
  call @__rt_udec %n64
  call @__rt_sp
  %h64 = zext.i64 %h
  call @__rt_hex64 %h64
  call @__rt_nl
  ret
}
`;
}

/** Drops the last bytes the guest wrote, zeroing them, as if they had never been there. */
const BULK_CUT = `
func @__rt_bulk_cut(%cur: ptr, %cut: ix) -> (ptr) {
bb_e:
  %gs = globaladdr @__rt_bulk_start
  %start = load.ptr.na %gs
  %a = bitcast.ix %cur
  %b = bitcast.ix %start
  %n = sub.ix %a, %b
  %keep0 = sub.ix %n, %cut
  %zero = iconst.ix 0
  %neg = icmp.ugt.ix %cut, %n
  %keep = select.ix %neg, %zero, %keep0
  %to = gep %start, %keep, 1, 0
  %drop = sub.ix %n, %keep
  %z = iconst.i32 0
  intrinsic mem.fill %to, %z, %drop
  ret %to
}
`;

function rtText(bulkBytes = 0, fault?: BulkFault): string {
  const bulk = bulkBytes > 0;
  const text = `
extern @__tmk_main() -> ()
extern @__rt_trap_message(i32) -> ()
global @__rt_try_active size=4 align=4 section=data
global @__rt_jmp size=176 align=16 section=data
global @__rt_case size=8 align=8 section=data
global @__rt_guard size=8 align=8 section=data
global @__rt_in_exc size=4 align=4 section=data
global @__rt_null_pcs size=8 align=8 section=data
global @__mem_base size=8 align=8 section=data
global @__mem_limit size=8 align=8 section=data
global @__exc_stack size=16384 align=16 section=data
global @__sha_k size=256 align=4 section=data bytes=${kTable()}
global @__sha_h size=32 align=4 section=data
global @__sha_w size=256 align=4 section=data
global @__sha_block size=64 align=4 section=data
global @__sha_digest size=32 align=1 section=data
${lit("__s_ready", S.ready)}${lit("__s_done", S.done)}${lit("__s_panic", S.panic)}${lit("__s_c", S.caseT)}${lit("__s_t", S.t)}${lit("__s_fatal", S.fatal)}${lit("__s_esr", S.esr)}${lit("__s_elr", S.elr)}${lit("__s_far", S.far)}${lit("__s_m", "TMK:M ")}
func @__rt_main(%arena: ptr, %limit: ptr, %guard: ptr) -> () {
bb_e:
  %b = globaladdr @__mem_base
  store.ptr.na %b, %arena
  %l = globaladdr @__mem_limit
  store.ptr.na %l, %limit
  %g = globaladdr @__rt_guard
  store.ptr.na %g, %guard
  ${putLit("__s_ready", S.ready.length, "a")}
  ${bulk ? "call @__rt_bulk_open %limit" : ""}
  call @__tmk_main
  ${bulk ? "call @__rt_bulk_close" : ""}
  ${putLit("__s_done", S.done.length, "b")}
  intrinsic native.off
  unreachable
}
func @__rt_puts(%p: ptr, %n: ix) -> () {
bb_e:
  %zero = iconst.ix 0
  br bb_loop(%zero)
bb_loop(%i: ix):
  %more = icmp.ult.ix %i, %n
  brif %more, bb_body, bb_done
bb_body:
  %a = gep %p, %i, 1, 0
  %c = load.i8.na %a
  %w = zext.i32 %c
  intrinsic native.putc %w
  %one = iconst.ix 1
  %j = add.ix %i, %one
  br bb_loop(%j)
bb_done:
  ret
}
func @__rt_nl() -> () {
bb_e:
  %c = iconst.i32 10
  intrinsic native.putc %c
  ret
}
func @__rt_sp() -> () {
bb_e:
  %c = iconst.i32 32
  intrinsic native.putc %c
  ret
}
func @__rt_nibble(%v: i32) -> () {
bb_e:
  %ten = iconst.i32 10
  %small = icmp.ult.i32 %v, %ten
  %d0 = iconst.i32 48
  %d1 = iconst.i32 87
  %base = select.i32 %small, %d0, %d1
  %c = add.i32 %v, %base
  intrinsic native.putc %c
  ret
}
func @__rt_hex8(%v: i32) -> () {
bb_e:
  %four = iconst.i32 4
  %hi = lshr.i32 %v, %four
  %m = iconst.i32 15
  %hm = and.i32 %hi, %m
  call @__rt_nibble %hm
  %lm = and.i32 %v, %m
  call @__rt_nibble %lm
  ret
}
func @__rt_hex64(%v: i64) -> () {
bb_e:
  %start = iconst.i32 60
  br bb_loop(%start)
bb_loop(%s: i32):
  %s64 = zext.i64 %s
  %sh = lshr.i64 %v, %s64
  %t = trunc.i32 %sh
  %m = iconst.i32 15
  %n = and.i32 %t, %m
  call @__rt_nibble %n
  %zero = iconst.i32 0
  %end = icmp.eq.i32 %s, %zero
  brif %end, bb_done, bb_next
bb_next:
  %four = iconst.i32 4
  %s2 = sub.i32 %s, %four
  br bb_loop(%s2)
bb_done:
  ret
}
func @__rt_hexbytes(%p: ptr, %n: ix) -> () {
bb_e:
  %zero = iconst.ix 0
  br bb_loop(%zero)
bb_loop(%i: ix):
  %more = icmp.ult.ix %i, %n
  brif %more, bb_body, bb_done
bb_body:
  %a = gep %p, %i, 1, 0
  %c = load.i8.na %a
  %w = zext.i32 %c
  call @__rt_hex8 %w
  %one = iconst.ix 1
  %j = add.ix %i, %one
  br bb_loop(%j)
bb_done:
  ret
}
func @__rt_dec(%v: i64) -> () {
bb_e:
  %zero = iconst.i64 0
  %neg = icmp.slt.i64 %v, %zero
  brif %neg, bb_minus, bb_abs(%v)
bb_minus:
  %c = iconst.i32 45
  intrinsic native.putc %c
  %m = sub.i64 %zero, %v
  br bb_abs(%m)
bb_abs(%x: i64):
  call @__rt_udec %x
  ret
}
func @__rt_udec(%x: i64) -> () {
bb_e:
  %ten = iconst.i64 10
  %big = icmp.uge.i64 %x, %ten
  brif %big, bb_up, bb_digit
bb_up:
  %q = udiv.i64 %x, %ten, t900001
  call @__rt_udec %q
  br bb_digit
bb_digit:
  %r = urem.i64 %x, %ten, t900001
  %t = trunc.i32 %r
  %d = iconst.i32 48
  %c = add.i32 %t, %d
  intrinsic native.putc %c
  ret
}
func @__rt_trap(%code: i32) -> () {
bb_e:
  %active = globaladdr @__rt_try_active
  %a = load.i32.na %active
  %code64 = zext.i64 %code
  brif %a, bb_case, bb_panic
bb_case:
  ${putLit("__s_c", S.caseT.length, "c")}
  %cp = globaladdr @__rt_case
  %idx = load.i64.na %cp
  call @__rt_udec %idx
  ${putLit("__s_t", S.t.length, "d")}
  call @__rt_udec %code64
  call @__rt_sp
  call @__rt_trap_message %code
  call @__rt_nl
  intrinsic native.unwind
  unreachable
bb_panic:
  ${bulk ? "call @__rt_bulk_stop" : ""}
  ${putLit("__s_panic", S.panic.length, "e")}
  call @__rt_udec %code64
  call @__rt_sp
  call @__rt_trap_message %code
  call @__rt_nl
  intrinsic native.off
  unreachable
}
func @__rt_exception(%kind: i64, %esr: i64, %elr: i64, %far: i64) -> () {
bb_e:
  %flag = globaladdr @__rt_in_exc
  %was = load.i32.na %flag
  brif %was, bb_off, bb_first
bb_off:
  intrinsic native.off
  unreachable
bb_first:
  ; A write below the stack is the guard block: stack exhausted, trap 14 (SPEC 3.10, divergence 4).
  %ec_sh = iconst.i64 26
  %ec = lshr.i64 %esr, %ec_sh
  %da = iconst.i64 37
  %isda = icmp.eq.i64 %ec, %da
  %gp = globaladdr @__rt_guard
  %guard = load.i64.na %gp
  %d = sub.i64 %far, %guard
  %size = iconst.i64 2097152
  %inguard = icmp.ult.i64 %d, %size
  %hit = and.i32 %isda, %inguard
  brif %hit, bb_overflow, bb_null0
bb_overflow:
  %code = iconst.i32 14
  call @__rt_trap %code
  unreachable
bb_null0:
  ; A load or store near address 0 is a null dereference: V8 throws, and this is trap 6 (SPEC 3.10).
  ; Outside a native.try it falls through to the full report, with the ESR and FAR.
  %low = iconst.i64 65536
  %isnull = icmp.ult.i64 %far, %low
  %active = globaladdr @__rt_try_active
  %inTry = load.i32.na %active
  %n1 = and.i32 %isda, %isnull
  %n2 = and.i32 %n1, %inTry
  brif %n2, bb_null, bb_listed0
bb_listed0:
  ; R7: a load standing for an explicit null check (the image's __rt_null_pcs, shape.ts's implicitNullChecks) is trap 6
  ; outside a try too, as the check it stands for was: TMK:PANIC trap 6, not the full report.
  brif %n1, bb_listed, bb_fatal
bb_listed:
  %listed = call @__rt_null_listed %elr, %far
  brif %listed, bb_null, bb_fatal
bb_null:
  %code6 = iconst.i32 6
  call @__rt_trap %code6
  unreachable
bb_fatal:
  %one = iconst.i32 1
  store.i32.na %flag, %one
  ${bulk ? "call @__rt_bulk_stop" : ""}
  ${putLit("__s_fatal", S.fatal.length, "f")}
  call @__rt_udec %kind
  ${putLit("__s_esr", S.esr.length, "g")}
  call @__rt_hex64 %esr
  ${putLit("__s_elr", S.elr.length, "h")}
  call @__rt_hex64 %elr
  ${putLit("__s_far", S.far.length, "i")}
  call @__rt_hex64 %far
  call @__rt_nl
  intrinsic native.off
  unreachable
}
func @__rt_null_listed(%pc: i64, %far: i64) -> (i32) {
bb_e:
  ; The table: a count, then for each listed load its address less the table's own (the image is placed whole, so the
  ; difference is the same wherever it's loaded) and the address it faults at through null, its offset: a fault elsewhere
  ; was through a reference that wasn't null, which the check passed at -O0, and is reported as before.
  %t = globaladdr @__rt_null_pcs
  %n = load.i64.na %t
  %ti = bitcast.i64 %t
  %rel = sub.i64 %pc, %ti
  %zero = iconst.i64 0
  br bb_loop(%zero)
bb_loop(%i: i64):
  %more = icmp.ult.i64 %i, %n
  brif %more, bb_at, bb_no
bb_at:
  %one = iconst.i64 1
  %j = add.i64 %i, %one
  %sixteen = iconst.i64 16
  %off = mul.i64 %i, %sixteen
  %offx = bitcast.ix %off
  %slot = gep %t, %offx, 1, 8
  %v = load.i64.na %slot
  %hit = icmp.eq.i64 %v, %rel
  %fslot = gep %t, %offx, 1, 16
  %fv = load.i64.na %fslot
  %fhit = icmp.eq.i64 %fv, %far
  %both = and.i32 %hit, %fhit
  brif %both, bb_yes, bb_next
bb_next:
  br bb_loop(%j)
bb_yes:
  %y = iconst.i32 1
  ret %y
bb_no:
  %nn = iconst.i32 0
  ret %nn
}
func @__rt_putf64(%x: f64) -> () {
bb_e:
  %t = ftrunc.f64 %x
  %same = fcmp.eq.f64 %t, %x
  %abs = fabs.f64 %x
  %lim = fconst.f64 0x4340000000000000
  %small = fcmp.lt.f64 %abs, %lim
  %ok = and.i32 %same, %small
  brif %ok, bb_int, bb_bits
bb_int:
  %i = fptosi.sat.i64 %x
  call @__rt_dec %i
  ret
bb_bits:
  %c1 = iconst.i32 123
  intrinsic native.putc %c1
  %b = bitcast.i64 %x
  call @__rt_hex64 %b
  %c2 = iconst.i32 125
  intrinsic native.putc %c2
  ret
}
func @__rt_dump(%from: ptr, %to: ptr) -> () {
bb_e:
  %zero = iconst.ix 0
  br bb_loop(%from)
bb_loop(%p: ptr):
  %more = icmp.ult.ptr %p, %to
  brif %more, bb_chunk, bb_done
bb_chunk:
  ; 32 bytes a line, and all-zero chunks say nothing: unwritten memory reads as zero on the host.
  %next = gep %p, %zero, 1, 32
  %over = icmp.ugt.ptr %next, %to
  %end = select.ptr %over, %to, %next
  br bb_scan(%p)
bb_scan(%q: ptr):
  %smore = icmp.ult.ptr %q, %end
  brif %smore, bb_scan1, bb_skip
bb_scan1:
  %b = load.i8.na %q
  %wb = zext.i32 %b
  brif %wb, bb_line, bb_scan2
bb_scan2:
  %q1 = gep %q, %zero, 1, 1
  br bb_scan(%q1)
bb_line:
  ${putLit("__s_m", 6, "m")}
  %a64 = bitcast.i64 %p
  call @__rt_hex64 %a64
  call @__rt_sp
  %start = bitcast.ix %p
  %stop = bitcast.ix %end
  %len = sub.ix %stop, %start
  call @__rt_hexbytes %p, %len
  call @__rt_nl
  br bb_skip
bb_skip:
  br bb_loop(%end)
bb_done:
  ret
}
func @__rt_rotr(%x: i32, %n: i32) -> (i32) {
bb_e:
  %a = lshr.i32 %x, %n
  %t = iconst.i32 32
  %m = sub.i32 %t, %n
  %b = shl.i32 %x, %m
  %c = or.i32 %a, %b
  ret %c
}
func @__rt_sha_compress(%block: ptr) -> () {
bb_e:
  %w = globaladdr @__sha_w
  %zero = iconst.ix 0
  br bb_load(%zero)
bb_load(%i: ix):
  %sixteen = iconst.ix 16
  %more = icmp.ult.ix %i, %sixteen
  brif %more, bb_load1, bb_ext0
bb_load1:
  %pi = gep %block, %i, 4, 0
  %raw = load.i32.na %pi
  %sw = call @__rt_bswap %raw
  %wi = gep %w, %i, 4, 0
  store.i32.na %wi, %sw
  %one = iconst.ix 1
  %i2 = add.ix %i, %one
  br bb_load(%i2)
bb_ext0:
  br bb_ext(%sixteen)
bb_ext(%t: ix):
  %sixtyfour = iconst.ix 64
  %m2 = icmp.ult.ix %t, %sixtyfour
  brif %m2, bb_ext1, bb_rounds0
bb_ext1:
  %w15p = gep %w, %t, 4, -60
  %w15 = load.i32.na %w15p
  %r7 = iconst.i32 7
  %r18 = iconst.i32 18
  %s3 = iconst.i32 3
  %a1 = call @__rt_rotr %w15, %r7
  %a2 = call @__rt_rotr %w15, %r18
  %a3 = lshr.i32 %w15, %s3
  %ax = xor.i32 %a1, %a2
  %s0 = xor.i32 %ax, %a3
  %w2p = gep %w, %t, 4, -8
  %w2 = load.i32.na %w2p
  %r17 = iconst.i32 17
  %r19 = iconst.i32 19
  %s10 = iconst.i32 10
  %b1 = call @__rt_rotr %w2, %r17
  %b2 = call @__rt_rotr %w2, %r19
  %b3 = lshr.i32 %w2, %s10
  %bx = xor.i32 %b1, %b2
  %s1 = xor.i32 %bx, %b3
  %w16p = gep %w, %t, 4, -64
  %w16 = load.i32.na %w16p
  %w7p = gep %w, %t, 4, -28
  %w7 = load.i32.na %w7p
  %s01 = add.i32 %w16, %s0
  %s02 = add.i32 %s01, %w7
  %s03 = add.i32 %s02, %s1
  %wt = gep %w, %t, 4, 0
  store.i32.na %wt, %s03
  %one2 = iconst.ix 1
  %t2 = add.ix %t, %one2
  br bb_ext(%t2)
bb_rounds0:
  %h = globaladdr @__sha_h
  %h0p = gep %h, %zero, 4, 0
  %h1p = gep %h, %zero, 4, 4
  %h2p = gep %h, %zero, 4, 8
  %h3p = gep %h, %zero, 4, 12
  %h4p = gep %h, %zero, 4, 16
  %h5p = gep %h, %zero, 4, 20
  %h6p = gep %h, %zero, 4, 24
  %h7p = gep %h, %zero, 4, 28
  %ia = load.i32.na %h0p
  %ib = load.i32.na %h1p
  %ic = load.i32.na %h2p
  %id = load.i32.na %h3p
  %ie = load.i32.na %h4p
  %if = load.i32.na %h5p
  %ig = load.i32.na %h6p
  %ih = load.i32.na %h7p
  %k = globaladdr @__sha_k
  br bb_round(%zero, %ia, %ib, %ic, %id, %ie, %if, %ig, %ih)
bb_round(%r: ix, %va: i32, %vb: i32, %vc: i32, %vd: i32, %ve: i32, %vf: i32, %vg: i32, %vh: i32):
  %m3 = icmp.ult.ix %r, %sixtyfour
  brif %m3, bb_round1, bb_finish
bb_round1:
  %r6 = iconst.i32 6
  %r11 = iconst.i32 11
  %r25 = iconst.i32 25
  %e1 = call @__rt_rotr %ve, %r6
  %e2 = call @__rt_rotr %ve, %r11
  %e3 = call @__rt_rotr %ve, %r25
  %ex = xor.i32 %e1, %e2
  %bs1 = xor.i32 %ex, %e3
  %ef = and.i32 %ve, %vf
  %ne = not.i32 %ve
  %ng = and.i32 %ne, %vg
  %ch = xor.i32 %ef, %ng
  %kp = gep %k, %r, 4, 0
  %kr = load.i32.na %kp
  %wp = gep %w, %r, 4, 0
  %wr = load.i32.na %wp
  %t1a = add.i32 %vh, %bs1
  %t1b = add.i32 %t1a, %ch
  %t1c = add.i32 %t1b, %kr
  %t1 = add.i32 %t1c, %wr
  %r2 = iconst.i32 2
  %r13 = iconst.i32 13
  %r22 = iconst.i32 22
  %f1 = call @__rt_rotr %va, %r2
  %f2 = call @__rt_rotr %va, %r13
  %f3 = call @__rt_rotr %va, %r22
  %fx = xor.i32 %f1, %f2
  %bs0 = xor.i32 %fx, %f3
  %ab = and.i32 %va, %vb
  %ac = and.i32 %va, %vc
  %bc = and.i32 %vb, %vc
  %abx = xor.i32 %ab, %ac
  %maj = xor.i32 %abx, %bc
  %t2a = add.i32 %bs0, %maj
  %newe = add.i32 %vd, %t1
  %newa = add.i32 %t1, %t2a
  %one3 = iconst.ix 1
  %r1 = add.ix %r, %one3
  br bb_round(%r1, %newa, %va, %vb, %vc, %newe, %ve, %vf, %vg)
bb_finish:
  %oa = add.i32 %ia, %va
  store.i32.na %h0p, %oa
  %ob = add.i32 %ib, %vb
  store.i32.na %h1p, %ob
  %oc = add.i32 %ic, %vc
  store.i32.na %h2p, %oc
  %od = add.i32 %id, %vd
  store.i32.na %h3p, %od
  %oe = add.i32 %ie, %ve
  store.i32.na %h4p, %oe
  %of = add.i32 %if, %vf
  store.i32.na %h5p, %of
  %og = add.i32 %ig, %vg
  store.i32.na %h6p, %og
  %oh = add.i32 %ih, %vh
  store.i32.na %h7p, %oh
  ret
}
func @__rt_bswap(%x: i32) -> (i32) {
bb_e:
  %s8 = iconst.i32 8
  %s24 = iconst.i32 24
  %m1 = iconst.i32 65280
  %m2 = iconst.i32 16711680
  %a = shl.i32 %x, %s24
  %b0 = and.i32 %x, %m1
  %b = shl.i32 %b0, %s8
  %c0 = and.i32 %x, %m2
  %c = lshr.i32 %c0, %s8
  %d = lshr.i32 %x, %s24
  %ab = or.i32 %a, %b
  %cd = or.i32 %c, %d
  %r = or.i32 %ab, %cd
  ret %r
}
func @__rt_sha256(%p: ptr, %n: ix) -> () {
bb_e:
  %h = globaladdr @__sha_h
  %zero = iconst.ix 0
  %i0 = iconst.i32 1779033703
  %a0 = gep %h, %zero, 4, 0
  store.i32.na %a0, %i0
  %i1 = iconst.i32 3144134277
  %a1 = gep %h, %zero, 4, 4
  store.i32.na %a1, %i1
  %i2 = iconst.i32 1013904242
  %a2 = gep %h, %zero, 4, 8
  store.i32.na %a2, %i2
  %i3 = iconst.i32 2773480762
  %a3 = gep %h, %zero, 4, 12
  store.i32.na %a3, %i3
  %i4 = iconst.i32 1359893119
  %a4 = gep %h, %zero, 4, 16
  store.i32.na %a4, %i4
  %i5 = iconst.i32 2600822924
  %a5 = gep %h, %zero, 4, 20
  store.i32.na %a5, %i5
  %i6 = iconst.i32 528734635
  %a6 = gep %h, %zero, 4, 24
  store.i32.na %a6, %i6
  %i7 = iconst.i32 1541459225
  %a7 = gep %h, %zero, 4, 28
  store.i32.na %a7, %i7
  %s64 = iconst.ix 64
  br bb_blocks(%p, %n)
bb_blocks(%at: ptr, %left: ix):
  %whole = icmp.uge.ix %left, %s64
  brif %whole, bb_block, bb_tail
bb_block:
  call @__rt_sha_compress %at
  %at2 = gep %at, %zero, 1, 64
  %left2 = sub.ix %left, %s64
  br bb_blocks(%at2, %left2)
bb_tail:
  %b = globaladdr @__sha_block
  %fillz = iconst.i32 0
  intrinsic mem.fill %b, %fillz, %s64
  intrinsic mem.copy %b, %at, %left
  %endp = gep %b, %left, 1, 0
  %pad = iconst.i8 128
  store.i8.na %endp, %pad
  %room = iconst.ix 56
  %fits = icmp.ult.ix %left, %room
  brif %fits, bb_len, bb_extra
bb_extra:
  call @__rt_sha_compress %b
  intrinsic mem.fill %b, %fillz, %s64
  br bb_len
bb_len:
  %three = iconst.i64 3
  %n64 = bitcast.i64 %n
  %nb = shl.i64 %n64, %three
  %hi = iconst.i64 32
  %hi0 = lshr.i64 %nb, %hi
  %hi32 = trunc.i32 %hi0
  %lo32 = trunc.i32 %nb
  %shi = call @__rt_bswap %hi32
  %slo = call @__rt_bswap %lo32
  %lp1 = gep %b, %zero, 1, 56
  store.i32.na %lp1, %shi
  %lp2 = gep %b, %zero, 1, 60
  store.i32.na %lp2, %slo
  call @__rt_sha_compress %b
  ret
}
func @__rt_sha_print() -> () {
bb_e:
  %h = globaladdr @__sha_h
  %zero = iconst.ix 0
  br bb_loop(%zero)
bb_loop(%i: ix):
  %eight = iconst.ix 8
  %more = icmp.ult.ix %i, %eight
  brif %more, bb_body, bb_done
bb_body:
  %p = gep %h, %i, 4, 0
  %v = load.i32.na %p
  %s24 = iconst.i32 24
  %s16 = iconst.i32 16
  %s8 = iconst.i32 8
  %m = iconst.i32 255
  %a = lshr.i32 %v, %s24
  call @__rt_hex8 %a
  %b0 = lshr.i32 %v, %s16
  %b = and.i32 %b0, %m
  call @__rt_hex8 %b
  %c0 = lshr.i32 %v, %s8
  %c = and.i32 %c0, %m
  call @__rt_hex8 %c
  %d = and.i32 %v, %m
  call @__rt_hex8 %d
  %one = iconst.ix 1
  %j = add.ix %i, %one
  br bb_loop(%j)
bb_done:
  ret
}
`;
  return bulk
    ? `${text.replaceAll("intrinsic native.putc ", "call @__rt_out ")}${bulkText(bulkBytes, fault)}${fault === "truncate" ? BULK_CUT : ""}`
    : text;
}

export const RT_TRAP_DIV: { id: number; kind: string; code: number; loc: string } = {
  id: 900002,
  kind: "div",
  code: 3,
  loc: "runtime",
};

/** `bulkBytes`, with the RAM channel; with none, the runtime is what it always was. */
export function rtModule(bulkBytes = 0, fault?: BulkFault): Module {
  const m = assemble(rtText(bulkBytes, fault).replaceAll("t900001", `t${RT_TRAP_DIV.id}`));
  m.traps.push(RT_TRAP_DIV);
  m.externs = []; // the driver defines those two: the parser only needed their signatures
  return m;
}
