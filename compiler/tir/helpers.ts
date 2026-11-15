// Operations in SPEC 4.3 that a target may have no instruction for, written once in TIR.
import { assemble } from "./asm.ts";
import type { Func } from "./ir.ts";

export const FREM_HELPER_NAME = "__frem.f64";

// fmod by shift and subtract on the mantissas, exact for all inputs, as JS `%` requires. The
// result takes the dividend's sign. Exponents are held as i64, where they can't overflow.
const FREM_TEXT = `
func @__frem.f64(%x: f64, %y: f64) -> (f64) {
bb_entry:
  %ux = bitcast.i64 %x
  %uy = bitcast.i64 %y
  %n52 = iconst.i64 52
  %n63 = iconst.i64 63
  %n12 = iconst.i64 12
  %one = iconst.i64 1
  %zero = iconst.i64 0
  %mask = iconst.i64 2047
  %ex0 = lshr.i64 %ux, %n52
  %ex = and.i64 %ex0, %mask
  %ey0 = lshr.i64 %uy, %n52
  %ey = and.i64 %ey0, %mask
  %sign = lshr.i64 %ux, %n63
  %ax = shl.i64 %ux, %one
  %ay = shl.i64 %uy, %one
  %c1 = icmp.eq.i64 %ay, %zero
  %c2 = fcmp.ne.f64 %y, %y
  %c3 = icmp.eq.i64 %ex, %mask
  %c12 = or.i32 %c1, %c2
  %bad = or.i32 %c12, %c3
  brif %bad, bb_nan, bb_finite
bb_nan:
  %nan = fconst.f64 0x7ff8000000000000
  ret %nan
bb_finite:
  %le = icmp.ule.i64 %ax, %ay
  brif %le, bb_small, bb_norm_x
bb_small:
  %same = icmp.eq.i64 %ax, %ay
  brif %same, bb_signed_zero, bb_same_x
bb_same_x:
  ret %x
bb_signed_zero:
  %fz = fconst.f64 0x0
  %sz = fcopysign.f64 %fz, %x
  ret %sz
bb_norm_x:
  %hidden = shl.i64 %one, %n52
  %manti = sub.i64 %hidden, %one
  %x_sub = icmp.eq.i64 %ex, %zero
  %ix0 = shl.i64 %ux, %n12
  brif %x_sub, bb_xs(%ix0, %zero), bb_x_normal
bb_xs(%xi: i64, %xe: i64):
  %xtop = lshr.i64 %xi, %n63
  %xdone = icmp.ne.i64 %xtop, %zero
  brif %xdone, bb_xs_done, bb_xs_step
bb_xs_step:
  %xi1 = shl.i64 %xi, %one
  %xe1 = sub.i64 %xe, %one
  br bb_xs(%xi1, %xe1)
bb_xs_done:
  %xsh = sub.i64 %one, %xe
  %xm0 = shl.i64 %ux, %xsh
  br bb_norm_y(%xm0, %xe)
bb_x_normal:
  %xm1 = and.i64 %ux, %manti
  %xm2 = or.i64 %xm1, %hidden
  br bb_norm_y(%xm2, %ex)
bb_norm_y(%mx: i64, %exn: i64):
  %y_sub = icmp.eq.i64 %ey, %zero
  %iy0 = shl.i64 %uy, %n12
  brif %y_sub, bb_ys(%iy0, %zero), bb_y_normal
bb_ys(%yi: i64, %ye: i64):
  %ytop = lshr.i64 %yi, %n63
  %ydone = icmp.ne.i64 %ytop, %zero
  brif %ydone, bb_ys_done, bb_ys_step
bb_ys_step:
  %yi1 = shl.i64 %yi, %one
  %ye1 = sub.i64 %ye, %one
  br bb_ys(%yi1, %ye1)
bb_ys_done:
  %ysh = sub.i64 %one, %ye
  %ym0 = shl.i64 %uy, %ysh
  br bb_loop(%mx, %exn, %ym0, %ye)
bb_y_normal:
  %ym1 = and.i64 %uy, %manti
  %ym2 = or.i64 %ym1, %hidden
  br bb_loop(%mx, %exn, %ym2, %ey)
bb_loop(%m: i64, %e: i64, %my: i64, %eyn: i64):
  %more = icmp.sgt.i64 %e, %eyn
  brif %more, bb_step, bb_last
bb_step:
  %d = sub.i64 %m, %my
  %dneg = icmp.slt.i64 %d, %zero
  brif %dneg, bb_shift(%m), bb_nonneg
bb_nonneg:
  %dz = icmp.eq.i64 %d, %zero
  brif %dz, bb_signed_zero2, bb_shift(%d)
bb_signed_zero2:
  %fz2 = fconst.f64 0x0
  %sz2 = fcopysign.f64 %fz2, %x
  ret %sz2
bb_shift(%keep: i64):
  %m1 = shl.i64 %keep, %one
  %e1 = sub.i64 %e, %one
  br bb_loop(%m1, %e1, %my, %eyn)
bb_last:
  %d2 = sub.i64 %m, %my
  %d2neg = icmp.slt.i64 %d2, %zero
  brif %d2neg, bb_renorm(%m, %e), bb_last2
bb_last2:
  %d2z = icmp.eq.i64 %d2, %zero
  brif %d2z, bb_signed_zero3, bb_renorm(%d2, %e)
bb_signed_zero3:
  %fz3 = fconst.f64 0x0
  %sz3 = fcopysign.f64 %fz3, %x
  ret %sz3
bb_renorm(%r: i64, %re: i64):
  %rtop = lshr.i64 %r, %n52
  %rdone = icmp.ne.i64 %rtop, %zero
  brif %rdone, bb_pack, bb_renorm_step
bb_renorm_step:
  %r1 = shl.i64 %r, %one
  %re1 = sub.i64 %re, %one
  br bb_renorm(%r1, %re1)
bb_pack:
  %pos = icmp.sgt.i64 %re, %zero
  brif %pos, bb_pack_normal, bb_pack_sub
bb_pack_normal:
  %hid = shl.i64 %one, %n52
  %r2 = sub.i64 %r, %hid
  %eb = shl.i64 %re, %n52
  %r3 = or.i64 %r2, %eb
  br bb_done(%r3)
bb_pack_sub:
  %sh = sub.i64 %one, %re
  %r4 = lshr.i64 %r, %sh
  br bb_done(%r4)
bb_done(%bits: i64):
  %sb = shl.i64 %sign, %n63
  %res = or.i64 %bits, %sb
  %out = bitcast.f64 %res
  ret %out
}
`;

export function FREM_HELPER(): Func {
  return assemble(FREM_TEXT).funcs[0]!;
}
