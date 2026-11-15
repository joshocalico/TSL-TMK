// The JS Math functions the corpus uses and TIR has no operation for (SPEC 4.3, 4.5): sin, cos, exp,
// log, atan2 and pow, as TIR, so they compile like everything else. The algorithms and coefficients are
// fdlibm's (Sun Microsystems, freely redistributable: see THIRD_PARTY), which is what V8's own
// ieee754 functions are derived from. The decoder uses none of these.
//
// Fused multiplies are not an optimisation here. V8 on arm64 is fdlibm compiled by clang, whose default
// contracts `a * b + c` within one C statement into FMADD, and that changes the last bit of about 1 in
// 50 results (MEASURED: 325 of 20,000 sines differ without it, none with it). So `fma` below marks
// each place clang's rule fires, statement by statement, and V8's results on x86-64 would differ.
//
// Limit, stated rather than hidden: sin and cos cover |x| up to about 2^19 * pi/2. Above that fdlibm
// needs its long 2/pi table reduction, which nothing here exercises, so the call panics (trap code 10)
// instead of returning a number that might be wrong.
import { FuncBuilder } from "../tir/build.ts";
import type { Func, Global } from "../tir/ir.ts";

/** Expression helpers, and control flow by value: a branch's results merge in block parameters. */
class L extends FuncBuilder {
  fw(hi: number, lo: number): number {
    return this.fbits("f64", (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0));
  }
  add(a: number, b: number): number {
    return this.op("fadd.f64", [a, b], "f64");
  }
  sub(a: number, b: number): number {
    return this.op("fsub.f64", [a, b], "f64");
  }
  mul(a: number, b: number): number {
    return this.op("fmul.f64", [a, b], "f64");
  }
  div(a: number, b: number): number {
    return this.op("fdiv.f64", [a, b], "f64");
  }
  neg(a: number): number {
    return this.op("fneg.f64", [a], "f64");
  }
  /** a * b + c, rounded once. */
  fma(a: number, b: number, c: number): number {
    return this.intrinsic("native.fma", [a, b, c], ["f64"])[0]!;
  }
  abs(a: number): number {
    return this.op("fabs.f64", [a], "f64");
  }
  bits(a: number): number {
    return this.op("bitcast.i64", [a], "i64");
  }
  fromBits(a: number): number {
    return this.op("bitcast.f64", [a], "f64");
  }
  hi(a: number): number {
    return this.op("trunc.i32", [this.op("lshr.i64", [this.bits(a), this.i64(32)], "i64")], "i32");
  }
  lo(a: number): number {
    return this.op("trunc.i32", [this.bits(a)], "i32");
  }
  words(hi: number, lo: number): number {
    const h = this.op("zext.i64", [hi], "i64");
    const l = this.op("zext.i64", [lo], "i64");
    return this.fromBits(
      this.op("or.i64", [this.op("shl.i64", [h, this.i64(32)], "i64"), l], "i64"),
    );
  }
  setHi(a: number, hi: number): number {
    return this.words(hi, this.lo(a));
  }
  setLo0(a: number): number {
    return this.words(this.hi(a), this.i32(0));
  }
  iadd(a: number, b: number): number {
    return this.op("add.i32", [a, b], "i32");
  }
  isub(a: number, b: number): number {
    return this.op("sub.i32", [a, b], "i32");
  }
  iand(a: number, b: number): number {
    return this.op("and.i32", [a, b], "i32");
  }
  ior(a: number, b: number): number {
    return this.op("or.i32", [a, b], "i32");
  }
  ixor(a: number, b: number): number {
    return this.op("xor.i32", [a, b], "i32");
  }
  shl(a: number, n: number): number {
    return this.op("shl.i32", [a, this.i32(n)], "i32");
  }
  shr(a: number, n: number): number {
    return this.op("lshr.i32", [a, this.i32(n)], "i32");
  }
  sar(a: number, n: number): number {
    return this.op("ashr.i32", [a, this.i32(n)], "i32");
  }
  lt(a: number, b: number): number {
    return this.op("icmp.slt.i32", [a, b], "i32");
  }
  ltK(a: number, k: number): number {
    return this.lt(a, this.i32(k));
  }
  gtK(a: number, k: number): number {
    return this.op("icmp.sgt.i32", [a, this.i32(k)], "i32");
  }
  geK(a: number, k: number): number {
    return this.op("icmp.sge.i32", [a, this.i32(k)], "i32");
  }
  leK(a: number, k: number): number {
    return this.op("icmp.sle.i32", [a, this.i32(k)], "i32");
  }
  eqK(a: number, k: number): number {
    return this.op("icmp.eq.i32", [a, this.i32(k)], "i32");
  }
  neK(a: number, k: number): number {
    return this.op("icmp.ne.i32", [a, this.i32(k)], "i32");
  }
  feq(a: number, b: number): number {
    return this.op("fcmp.eq.f64", [a, b], "i32");
  }
  flt(a: number, b: number): number {
    return this.op("fcmp.lt.f64", [a, b], "i32");
  }
  fgt(a: number, b: number): number {
    return this.op("fcmp.gt.f64", [a, b], "i32");
  }
  fne(a: number, b: number): number {
    return this.op("fcmp.ne.f64", [a, b], "i32");
  }
  toF(a: number): number {
    return this.op("sitofp.f64", [a], "f64");
  }
  /** C's (int)x, which fdlibm only uses in range. */
  toI(a: number): number {
    return this.op("fptosi.sat.i32", [a], "i32");
  }
  /** if (cond) return value(); and carry on in a fresh block. */
  retIf(cond: number, value: () => number[]): void {
    const yes = this.block();
    const no = this.block();
    this.brif(cond, yes, no);
    this.at(yes);
    this.ret(value());
    this.at(no);
  }
  /** cond ? t() : f(), where each side may do real work and has its own blocks. */
  ifElse(cond: number, t: () => number[], f: () => number[], types: ("f64" | "i32")[]): number[] {
    const yes = this.block();
    const no = this.block();
    const join = this.block(types);
    this.brif(cond, yes, no);
    this.at(yes);
    const tv = t();
    this.br(join, tv);
    this.at(no);
    const fv = f();
    this.br(join, fv);
    this.at(join);
    return join.params;
  }
  poly(z: number, coeffs: [number, number][]): number {
    // c0 + z*(c1 + z*(c2 + ...)), evaluated as fdlibm writes it.
    let acc = this.fw(coeffs[coeffs.length - 1]![0], coeffs[coeffs.length - 1]![1]);
    for (let i = coeffs.length - 2; i >= 0; i--) {
      acc = this.fma(z, acc, this.fw(coeffs[i]![0], coeffs[i]![1]));
    }
    return acc;
  }
}

function kernelSin(): Func {
  const b = new L("__k_sin", ["f64", "f64", "i32"], ["f64"]);
  const [x, y, iy] = b.params as [number, number, number];
  const ix = b.iand(b.hi(x), b.i32(0x7fffffff));
  b.retIf(b.ltK(ix, 0x3e400000), () => [x]);
  const z = b.mul(x, x);
  const v = b.mul(z, x);
  const r = b.poly(z, [
    [0x3f811111, 0x1110f8a6],
    [0xbf2a01a0, 0x19c161d5],
    [0x3ec71de3, 0x57b1fe7d],
    [0xbe5ae5e6, 0x8a2b9ceb],
    [0x3de5d93a, 0x5acfd57c],
  ]);
  const s1 = b.fw(0xbfc55555, 0x55555549);
  const half = b.f64(0.5);
  b.retIf(b.eqK(iy, 0), () => [b.fma(v, b.fma(z, r, s1), x)]);
  const inner = b.fma(z, b.fma(half, y, b.neg(b.mul(v, r))), b.neg(y));
  b.ret([b.sub(x, b.fma(b.neg(v), s1, inner))]);
  return b.finish();
}

function kernelCos(): Func {
  const b = new L("__k_cos", ["f64", "f64"], ["f64"]);
  const [x, y] = b.params as [number, number];
  const one = b.f64(1);
  const ix = b.iand(b.hi(x), b.i32(0x7fffffff));
  b.retIf(b.ltK(ix, 0x3e400000), () => [one]);
  const z = b.mul(x, x);
  const r = b.mul(
    z,
    b.poly(z, [
      [0x3fa55555, 0x5555554c],
      [0xbf56c16c, 0x16c15177],
      [0x3efa01a0, 0x19cb1590],
      [0xbe927e4f, 0x809c52ad],
      [0x3e21ee9e, 0xbdb4b1c4],
      [0xbda8fae9, 0xbe8838d4],
    ]),
  );
  const half = b.f64(0.5);
  const zr = b.fma(z, r, b.neg(b.mul(x, y)));
  b.retIf(b.ltK(ix, 0x3fd33333), () => [b.sub(one, b.fma(half, z, b.neg(zr)))]);
  const qx = b.ifElse(
    b.gtK(ix, 0x3fe90000),
    () => [b.f64(0.28125)],
    () => [b.words(b.isub(ix, b.i32(0x00200000)), b.i32(0))],
    ["f64"],
  )[0]!;
  const iz = b.fma(half, z, b.neg(qx));
  const a = b.sub(one, qx);
  b.ret([b.sub(a, b.sub(iz, zr))]);
  return b.finish();
}

const PIO2_HW = (() => {
  // The high word of n * pi/2, for fdlibm's check on whether cancellation is possible.
  const d = new DataView(new ArrayBuffer(8));
  const out: number[] = [];
  for (let n = 1; n <= 32; n++) {
    d.setFloat64(0, (n * Math.PI) / 2);
    out.push(d.getUint32(0));
  }
  return out;
})();

/** Reduces x by pi/2: returns (y0, y1, n). Above the medium range it panics, as the header says. */
function remPio2(): Func {
  const b = new L("__rem_pio2", ["f64"], ["f64", "f64", "i32"]);
  const x = b.params[0]!;
  const hx = b.hi(x);
  const ix = b.iand(hx, b.i32(0x7fffffff));
  const pio2_1 = b.fw(0x3ff921fb, 0x54400000);
  const pio2_1t = b.fw(0x3dd0b461, 0x1a626331);
  const pio2_2 = b.fw(0x3dd0b461, 0x1a600000);
  const pio2_2t = b.fw(0x3ba3198a, 0x2e037073);
  const pio2_3 = b.fw(0x3ba3198a, 0x2e000000);
  const pio2_3t = b.fw(0x397b839a, 0x252049c1);
  const invpio2 = b.fw(0x3fe45f30, 0x6dc9c883);
  const half = b.f64(0.5);
  b.retIf(b.ltK(ix, 0x4002d97c), () => {
    const positive = b.gtK(hx, 0);
    const notNear = b.neK(ix, 0x3ff921fb);
    const res = b.ifElse(
      positive,
      () => {
        const z = b.sub(x, pio2_1);
        return b.ifElse(
          notNear,
          () => {
            const y0 = b.sub(z, pio2_1t);
            return [y0, b.sub(b.sub(z, y0), pio2_1t), b.i32(1)];
          },
          () => {
            const z2 = b.sub(z, pio2_2);
            const y0 = b.sub(z2, pio2_2t);
            return [y0, b.sub(b.sub(z2, y0), pio2_2t), b.i32(1)];
          },
          ["f64", "f64", "i32"],
        );
      },
      () => {
        const z = b.add(x, pio2_1);
        return b.ifElse(
          notNear,
          () => {
            const y0 = b.add(z, pio2_1t);
            return [y0, b.add(b.sub(z, y0), pio2_1t), b.i32(-1)];
          },
          () => {
            const z2 = b.add(z, pio2_2);
            const y0 = b.add(z2, pio2_2t);
            return [y0, b.add(b.sub(z2, y0), pio2_2t), b.i32(-1)];
          },
          ["f64", "f64", "i32"],
        );
      },
      ["f64", "f64", "i32"],
    );
    return res;
  });
  const big = b.block();
  const medium = b.block();
  b.brif(b.gtK(ix, 0x413921fb), big, medium);
  b.at(big);
  b.intrinsic("trap.code", [b.i32(10)]);
  b.term({ k: "unreachable" });
  b.at(medium);
  const t = b.abs(x);
  const n = b.toI(b.fma(t, invpio2, half));
  const fn = b.toF(n);
  const r0 = b.fma(b.neg(fn), pio2_1, t);
  const w0 = b.mul(fn, pio2_1t);
  // n < 32 and x isn't close to n*pi/2: no cancellation, and the first answer stands.
  let tableHit = b.i32(0);
  PIO2_HW.forEach((hw, i) => {
    const here = b.op("icmp.eq.i32", [ix, b.i32(hw)], "i32");
    const isN = b.eqK(n, i + 1);
    tableHit = b.ior(tableHit, b.iand(here, isN));
  });
  const quick = b.iand(b.ltK(n, 33), b.op("icmp.eq.i32", [tableHit, b.i32(0)], "i32"));
  const [y0a, ra, wa] = b.ifElse(
    quick,
    () => [b.sub(r0, w0), r0, w0],
    () => {
      const j = b.shr(ix, 20);
      const y01 = b.sub(r0, w0);
      const i1 = b.isub(j, b.iand(b.shr(b.hi(y01), 20), b.i32(0x7ff)));
      return b.ifElse(
        b.gtK(i1, 16),
        () => {
          const t2 = r0;
          const w2 = b.mul(fn, pio2_2);
          const r2 = b.sub(t2, w2);
          const w2b = b.fma(fn, pio2_2t, b.neg(b.sub(b.sub(t2, r2), w2)));
          const y02 = b.sub(r2, w2b);
          const i2 = b.isub(j, b.iand(b.shr(b.hi(y02), 20), b.i32(0x7ff)));
          return b.ifElse(
            b.gtK(i2, 49),
            () => {
              const t3 = r2;
              const w3 = b.mul(fn, pio2_3);
              const r3 = b.sub(t3, w3);
              const w3b = b.fma(fn, pio2_3t, b.neg(b.sub(b.sub(t3, r3), w3)));
              return [b.sub(r3, w3b), r3, w3b];
            },
            () => [y02, r2, w2b],
            ["f64", "f64", "f64"] as never,
          );
        },
        () => [y01, r0, w0],
        ["f64", "f64", "f64"] as never,
      );
    },
    ["f64", "f64", "f64"] as never,
  ) as [number, number, number];
  const y1a = b.sub(b.sub(ra, y0a), wa);
  b.retIf(b.ltK(hx, 0), () => [b.neg(y0a), b.neg(y1a), b.isub(b.i32(0), n)]);
  b.ret([y0a, y1a, n]);
  return b.finish();
}

function trig(name: "sin" | "cos"): Func {
  const b = new L(`__math.${name}`, ["f64"], ["f64"]);
  const x = b.params[0]!;
  const ix = b.iand(b.hi(x), b.i32(0x7fffffff));
  const zero = b.f64(0);
  const ksin = (a: number, c: number, iy: number): number =>
    b.call("__k_sin", [a, c, b.i32(iy)], ["f64"])[0]!;
  const kcos = (a: number, c: number): number => b.call("__k_cos", [a, c], ["f64"])[0]!;
  b.retIf(b.op("icmp.sle.i32", [ix, b.i32(0x3fe921fb)], "i32"), () =>
    name === "sin" ? [ksin(x, zero, 0)] : [kcos(x, zero)],
  );
  b.retIf(b.geK(ix, 0x7ff00000), () => [b.sub(x, x)]);
  const [y0, y1, n] = b.call("__rem_pio2", [x], ["f64", "f64", "i32"]) as [number, number, number];
  const q = b.iand(n, b.i32(3));
  if (name === "sin") {
    b.retIf(b.eqK(q, 0), () => [ksin(y0, y1, 1)]);
    b.retIf(b.eqK(q, 1), () => [kcos(y0, y1)]);
    b.retIf(b.eqK(q, 2), () => [b.neg(ksin(y0, y1, 1))]);
    b.ret([b.neg(kcos(y0, y1))]);
  } else {
    b.retIf(b.eqK(q, 0), () => [kcos(y0, y1)]);
    b.retIf(b.eqK(q, 1), () => [b.neg(ksin(y0, y1, 1))]);
    b.retIf(b.eqK(q, 2), () => [b.neg(kcos(y0, y1))]);
    b.ret([ksin(y0, y1, 1)]);
  }
  return b.finish();
}

const EXP_P: [number, number][] = [
  [0x3fc55555, 0x5555553e],
  [0xbf66c16c, 0x16bebd93],
  [0x3f11566a, 0xaf25de2c],
  [0xbebbbd41, 0xc5d26bf1],
  [0x3e663769, 0x72bea4d0],
];

function exp(): Func {
  const b = new L("__math.exp", ["f64"], ["f64"]);
  const x0 = b.params[0]!;
  const hx0 = b.hi(x0);
  const xsb = b.iand(b.shr(hx0, 31), b.i32(1));
  const hx = b.iand(hx0, b.i32(0x7fffffff));
  const one = b.f64(1);
  const two = b.f64(2);
  const huge = b.f64(1e300);
  const twom1000 = b.fw(0x01700000, 0);
  const ln2HI0 = b.fw(0x3fe62e42, 0xfee00000);
  const ln2LO0 = b.fw(0x3dea39ef, 0x35793c76);
  const invln2 = b.fw(0x3ff71547, 0x652b82fe);
  const inf = b.fw(0x7ff00000, 0);
  b.retIf(b.feq(x0, inf), () => [x0]);
  b.retIf(b.fne(x0, x0), () => [b.add(x0, x0)]);
  b.retIf(b.feq(x0, b.neg(inf)), () => [b.f64(0)]);
  b.retIf(b.fgt(x0, b.fw(0x40862e42, 0xfefa39ef)), () => [b.mul(huge, huge)]);
  b.retIf(b.flt(x0, b.fw(0xc0874910, 0xd52d3051)), () => [b.mul(twom1000, twom1000)]);
  // V8 special-cases exp(1) to return E exactly, where the formula gets the last bit wrong.
  b.retIf(b.feq(x0, one), () => [b.fw(0x4005bf0a, 0x8b145769)]);
  const signMul = b.ifElse(
    b.eqK(xsb, 0),
    () => [one],
    () => [b.f64(-1)],
    ["f64"],
  )[0]!;
  const [x, hi, lo, k] = b.ifElse(
    b.gtK(hx, 0x3fd62e42),
    () =>
      b.ifElse(
        b.ltK(hx, 0x3ff0a2b2),
        () => {
          const h = b.sub(x0, b.mul(signMul, ln2HI0));
          const l = b.mul(signMul, ln2LO0);
          const kk = b.isub(b.i32(1), b.iadd(xsb, xsb));
          return [b.sub(h, l), h, l, kk];
        },
        () => {
          const half = b.mul(signMul, b.f64(0.5));
          const kk = b.toI(b.fma(invln2, x0, half));
          const t = b.toF(kk);
          const h = b.fma(b.neg(t), ln2HI0, x0);
          const l = b.mul(t, ln2LO0);
          return [b.sub(h, l), h, l, kk];
        },
        ["f64", "f64", "f64", "i32"] as never,
      ),
    () => {
      const zero = b.f64(0);
      return [x0, zero, zero, b.i32(0)];
    },
    ["f64", "f64", "f64", "i32"] as never,
  ) as [number, number, number, number];
  b.retIf(b.ltK(hx, 0x3e300000), () => [b.add(one, x0)]);
  const t = b.mul(x, x);
  const c = b.fma(b.neg(t), b.poly(t, EXP_P), x);
  b.retIf(b.eqK(k, 0), () => [b.sub(one, b.sub(b.div(b.mul(x, c), b.sub(c, two)), x))]);
  const y = b.sub(one, b.sub(b.sub(lo, b.div(b.mul(x, c), b.sub(two, c))), hi));
  const big = b.geK(k, -1021);
  const r = b.ifElse(
    big,
    () => {
      const special = b.eqK(k, 1024);
      return b.ifElse(
        special,
        () => [b.mul(b.mul(y, two), b.fw(0x7fe00000, 0))],
        () => {
          const twopk = b.words(b.iadd(b.i32(0x3ff00000), b.shl(k, 20)), b.i32(0));
          return [b.mul(y, twopk)];
        },
        ["f64"],
      );
    },
    () => {
      const twopk = b.words(b.iadd(b.i32(0x3ff00000), b.shl(b.iadd(k, b.i32(1000)), 20)), b.i32(0));
      return [b.mul(b.mul(y, twopk), twom1000)];
    },
    ["f64"],
  )[0]!;
  b.ret([r]);
  return b.finish();
}

function log(): Func {
  const b = new L("__math.log", ["f64"], ["f64"]);
  const x0 = b.params[0]!;
  const ln2_hi = b.fw(0x3fe62e42, 0xfee00000);
  const ln2_lo = b.fw(0x3dea39ef, 0x35793c76);
  const zero = b.f64(0);
  const one = b.f64(1);
  const half = b.f64(0.5);
  const two = b.f64(2);
  const hx0 = b.hi(x0);
  const lx0 = b.lo(x0);
  b.retIf(
    b.op("icmp.eq.i32", [b.ior(b.iand(hx0, b.i32(0x7fffffff)), lx0), b.i32(0)], "i32"),
    () => [b.fw(0xfff00000, 0)],
  );
  b.retIf(b.ltK(hx0, 0), () => [b.fw(0x7ff80000, 0)]);
  b.retIf(b.geK(hx0, 0x7ff00000), () => [b.add(x0, x0)]);
  const [x1, k0] = b.ifElse(
    b.ltK(hx0, 0x00100000),
    () => [b.mul(x0, b.fw(0x43500000, 0)), b.i32(-54)],
    () => [x0, b.i32(0)],
    ["f64", "i32"],
  ) as [number, number];
  const hx1 = b.hi(x1);
  const k1 = b.iadd(k0, b.isub(b.shr(hx1, 20), b.i32(1023)));
  const hx = b.iand(hx1, b.i32(0x000fffff));
  const i = b.iand(b.iadd(hx, b.i32(0x95f64)), b.i32(0x100000));
  const x = b.setHi(x1, b.ior(hx, b.ixor(i, b.i32(0x3ff00000))));
  const k = b.iadd(k1, b.shr(i, 20));
  const f = b.sub(x, one);
  const dk = b.toF(k);
  const k0Is = b.eqK(k, 0);
  b.retIf(b.ltK(b.iand(b.i32(0x000fffff), b.iadd(b.i32(2), hx)), 3), () => {
    return b.ifElse(
      b.feq(f, zero),
      () =>
        b.ifElse(
          k0Is,
          () => [zero],
          () => [b.fma(dk, ln2_hi, b.mul(dk, ln2_lo))],
          ["f64"],
        ),
      () => {
        const third = b.f64(0.3333333333333333);
        const R = b.mul(b.mul(f, f), b.fma(b.neg(third), f, half));
        return b.ifElse(
          k0Is,
          () => [b.sub(f, R)],
          () => [b.fma(dk, ln2_hi, b.neg(b.sub(b.fma(b.neg(dk), ln2_lo, R), f)))],
          ["f64"],
        );
      },
      ["f64"],
    );
  });
  const s = b.div(f, b.add(two, f));
  const z = b.mul(s, s);
  const ii = b.isub(hx, b.i32(0x6147a));
  const w = b.mul(z, z);
  const j = b.isub(b.i32(0x6b851), hx);
  const lg2 = b.fw(0x3fd99999, 0x9997fa04);
  const lg4 = b.fw(0x3fcc71c5, 0x1d8e78af);
  const lg6 = b.fw(0x3fc39a09, 0xd078c69f);
  const lg1 = b.fw(0x3fe55555, 0x55555593);
  const lg3 = b.fw(0x3fd24924, 0x94229359);
  const lg5 = b.fw(0x3fc74664, 0x96cb03de);
  const lg7 = b.fw(0x3fc2f112, 0xdf3e5244);
  const t1 = b.mul(w, b.fma(w, b.fma(w, lg6, lg4), lg2));
  const t2 = b.mul(z, b.fma(w, b.fma(w, b.fma(w, lg7, lg5), lg3), lg1));
  const R = b.add(t2, t1);
  const big = b.gtK(b.ior(ii, j), 0);
  const r = b.ifElse(
    big,
    () => {
      const hfsq = b.mul(b.mul(half, f), f);
      return b.ifElse(
        k0Is,
        () => [b.sub(f, b.fma(b.neg(s), b.add(hfsq, R), hfsq))],
        () => [
          b.fma(
            dk,
            ln2_hi,
            b.neg(b.sub(b.sub(hfsq, b.fma(s, b.add(hfsq, R), b.mul(dk, ln2_lo))), f)),
          ),
        ],
        ["f64"],
      );
    },
    () =>
      b.ifElse(
        k0Is,
        () => [b.fma(b.neg(s), b.sub(f, R), f)],
        () => [b.fma(dk, ln2_hi, b.neg(b.sub(b.fma(s, b.sub(f, R), b.neg(b.mul(dk, ln2_lo))), f)))],
        ["f64"],
      ),
    ["f64"],
  )[0]!;
  b.ret([r]);
  return b.finish();
}

function atan(): Func {
  const b = new L("__atan", ["f64"], ["f64"]);
  const x0 = b.params[0]!;
  const hx = b.hi(x0);
  const ix = b.iand(hx, b.i32(0x7fffffff));
  const atanhi: [number, number][] = [
    [0x3fddac67, 0x0561bb4f],
    [0x3fe921fb, 0x54442d18],
    [0x3fef730b, 0xd281f69b],
    [0x3ff921fb, 0x54442d18],
  ];
  const atanlo: [number, number][] = [
    [0x3c7a2b7f, 0x222f65e2],
    [0x3c81a626, 0x33145c07],
    [0x3c700788, 0x7af0cbbd],
    [0x3c91a626, 0x33145c07],
  ];
  const big = b.block();
  const rest = b.block();
  b.brif(b.geK(ix, 0x44100000), big, rest);
  b.at(big);
  b.retIf(b.fne(x0, x0), () => [b.add(x0, x0)]);
  const huge3 = b.add(b.fw(atanhi[3]![0], atanhi[3]![1]), b.fw(atanlo[3]![0], atanlo[3]![1]));
  b.retIf(b.gtK(hx, 0), () => [huge3]);
  b.ret([b.neg(huge3)]);
  b.at(rest);
  b.retIf(b.ltK(ix, 0x3e200000), () => [x0]);
  const aT: [number, number][] = [
    [0x3fd55555, 0x5555550d],
    [0xbfc99999, 0x9998ebc4],
    [0x3fc24924, 0x920083ff],
    [0xbfbc71c6, 0xfe231671],
    [0x3fb745cd, 0xc54c206e],
    [0xbfb3b0f2, 0xaf749a6d],
    [0x3fb10d66, 0xa0d03d51],
    [0xbfadde2d, 0x52defd9a],
    [0x3fa97b4b, 0x24760deb],
    [0xbfa2b444, 0x2c6a6c2f],
    [0x3f90ad3a, 0xe322da11],
  ];
  const finish = (x: number): [number, number] => {
    const z = b.mul(x, x);
    const w = b.mul(z, z);
    const odd = [aT[0]!, aT[2]!, aT[4]!, aT[6]!, aT[8]!, aT[10]!];
    const even = [aT[1]!, aT[3]!, aT[5]!, aT[7]!, aT[9]!];
    const s1 = b.mul(z, b.poly(w, odd));
    const s2 = b.mul(w, b.poly(w, even));
    return [s1, s2];
  };
  b.retIf(b.ltK(ix, 0x3fdc0000), () => {
    const [s1, s2] = finish(x0);
    return [b.fma(b.neg(x0), b.add(s1, s2), x0)];
  });
  const ax = b.abs(x0);
  const one = b.f64(1);
  const two = b.f64(2);
  const onehalf = b.f64(1.5);
  const reduce = (id: number, x: number): number[] => {
    const [s1, s2] = finish(x);
    const hiC = b.fw(atanhi[id]![0], atanhi[id]![1]);
    const loC = b.fw(atanlo[id]![0], atanlo[id]![1]);
    const z = b.sub(hiC, b.sub(b.fma(x, b.add(s1, s2), b.neg(loC)), x));
    return b.ifElse(
      b.ltK(hx, 0),
      () => [b.neg(z)],
      () => [z],
      ["f64"],
    );
  };
  b.retIf(b.ltK(ix, 0x3fe60000), () =>
    reduce(0, b.div(b.fma(two, ax, b.neg(one)), b.add(two, ax))),
  );
  b.retIf(b.ltK(ix, 0x3ff30000), () => reduce(1, b.div(b.sub(ax, one), b.add(ax, one))));
  b.retIf(b.ltK(ix, 0x40038000), () =>
    reduce(2, b.div(b.sub(ax, onehalf), b.fma(onehalf, ax, one))),
  );
  b.ret(reduce(3, b.div(b.f64(-1), ax)));
  return b.finish();
}

function atan2(): Func {
  const b = new L("__math.atan2", ["f64", "f64"], ["f64"]);
  const [y, x] = b.params as [number, number];
  const tiny = b.f64(1e-300);
  const pi_o_4 = b.fw(0x3fe921fb, 0x54442d18);
  const pi_o_2 = b.fw(0x3ff921fb, 0x54442d18);
  const pi = b.fw(0x400921fb, 0x54442d18);
  const pi_lo = b.fw(0x3ca1a626, 0x33145c07);
  const zero = b.f64(0);
  const hx = b.hi(x);
  const lx = b.lo(x);
  const hy = b.hi(y);
  const ly = b.lo(y);
  const ix = b.iand(hx, b.i32(0x7fffffff));
  const iy = b.iand(hy, b.i32(0x7fffffff));
  b.retIf(b.ior(b.fne(x, x), b.fne(y, y)), () => [b.add(x, y)]);
  b.retIf(b.eqK(b.ior(b.isub(hx, b.i32(0x3ff00000)), lx), 0), () => [
    b.call("__atan", [y], ["f64"])[0]!,
  ]);
  const m = b.ior(b.iand(b.shr(hy, 31), b.i32(1)), b.iand(b.shr(hx, 30), b.i32(2)));
  const piT = b.add(pi, tiny);
  const npiT = b.sub(b.neg(pi), tiny);
  const halfT = b.add(pi_o_2, tiny);
  const nhalfT = b.sub(b.neg(pi_o_2), tiny);
  const sel = (vals: number[]): number => {
    let r = vals[3]!;
    for (const i of [2, 1, 0]) r = b.op("select.f64", [b.eqK(m, i), vals[i]!, r], "f64");
    return r;
  };
  b.retIf(b.eqK(b.ior(iy, ly), 0), () => [sel([y, y, piT, npiT])]);
  b.retIf(b.eqK(b.ior(ix, lx), 0), () => [
    b.op("select.f64", [b.ltK(hy, 0), nhalfT, halfT], "f64"),
  ]);
  b.retIf(b.eqK(ix, 0x7ff00000), () => {
    return b.ifElse(
      b.eqK(iy, 0x7ff00000),
      () => {
        const three = b.mul(b.f64(3), pi_o_4);
        return [
          sel([
            b.add(pi_o_4, tiny),
            b.sub(b.neg(pi_o_4), tiny),
            b.add(three, tiny),
            b.sub(b.neg(three), tiny),
          ]),
        ];
      },
      () => [sel([zero, b.neg(zero), piT, npiT])],
      ["f64"],
    );
  });
  b.retIf(b.eqK(iy, 0x7ff00000), () => [b.op("select.f64", [b.ltK(hy, 0), nhalfT, halfT], "f64")]);
  const k = b.sar(b.isub(iy, ix), 20);
  const [z, m2] = b.ifElse(
    b.gtK(k, 60),
    () => [b.fma(b.f64(0.5), pi_lo, pi_o_2), b.iand(m, b.i32(1))],
    () =>
      b.ifElse(
        b.iand(b.ltK(hx, 0), b.ltK(k, -60)),
        () => [zero, m],
        () => [b.call("__atan", [b.abs(b.div(y, x))], ["f64"])[0]!, m],
        ["f64", "i32"],
      ),
    ["f64", "i32"],
  ) as [number, number];
  b.retIf(b.eqK(m2, 0), () => [z]);
  b.retIf(b.eqK(m2, 1), () => [b.neg(z)]);
  b.retIf(b.eqK(m2, 2), () => [b.sub(pi, b.sub(z, pi_lo))]);
  b.ret([b.sub(b.sub(z, pi_lo), pi)]);
  return b.finish();
}

function pow(): Func {
  const b = new L("__math.pow", ["f64", "f64"], ["f64"]);
  const [x, y] = b.params as [number, number];
  const zero = b.f64(0);
  const one = b.f64(1);
  const two = b.f64(2);
  const huge = b.f64(1e300);
  const tiny = b.f64(1e-300);
  const nan = b.fw(0x7ff80000, 0);
  const hx = b.hi(x);
  const lx = b.lo(x);
  const hy = b.hi(y);
  const ly = b.lo(y);
  const ix = b.iand(hx, b.i32(0x7fffffff));
  const iy = b.iand(hy, b.i32(0x7fffffff));
  // JS: anything to the zero is 1, a NaN either way is NaN, and +-1 to +-Infinity is NaN (not 1, as C).
  b.retIf(b.eqK(b.ior(iy, ly), 0), () => [one]);
  b.retIf(b.ior(b.fne(x, x), b.fne(y, y)), () => [nan]);
  // Whether y is an integer, when x is negative: 0 no, 1 odd, 2 even.
  const yisint = (() => {
    return b.ifElse(
      b.ltK(hx, 0),
      () =>
        b.ifElse(
          b.geK(iy, 0x43400000),
          () => [b.i32(2)],
          () =>
            b.ifElse(
              b.geK(iy, 0x3ff00000),
              () => {
                const k = b.isub(b.shr(iy, 20), b.i32(0x3ff));
                return b.ifElse(
                  b.gtK(k, 20),
                  () => {
                    const s = b.isub(b.i32(52), k);
                    const j = b.op("lshr.i32", [ly, s], "i32");
                    const back = b.op("shl.i32", [j, s], "i32");
                    const same = b.op("icmp.eq.i32", [back, ly], "i32");
                    const odd = b.isub(b.i32(2), b.iand(j, b.i32(1)));
                    return [b.op("select.i32", [same, odd, b.i32(0)], "i32")];
                  },
                  () =>
                    b.ifElse(
                      b.eqK(ly, 0),
                      () => {
                        const s = b.isub(b.i32(20), k);
                        const j = b.op("lshr.i32", [iy, s], "i32");
                        const back = b.op("shl.i32", [j, s], "i32");
                        const same = b.op("icmp.eq.i32", [back, iy], "i32");
                        const odd = b.isub(b.i32(2), b.iand(j, b.i32(1)));
                        return [b.op("select.i32", [same, odd, b.i32(0)], "i32")];
                      },
                      () => [b.i32(0)],
                      ["i32"],
                    ),
                  ["i32"],
                );
              },
              () => [b.i32(0)],
              ["i32"],
            ),
          ["i32"],
        ),
      () => [b.i32(0)],
      ["i32"],
    )[0]!;
  })();
  // y is +-inf, +-1, +-2 or 0.5.
  b.retIf(b.eqK(b.ior(b.isub(iy, b.i32(0x7ff00000)), ly), 0), () => {
    return b.ifElse(
      b.eqK(b.ior(b.isub(ix, b.i32(0x3ff00000)), lx), 0),
      () => [nan],
      () =>
        b.ifElse(
          b.geK(ix, 0x3ff00000),
          () => [b.op("select.f64", [b.geK(hy, 0), y, zero], "f64")],
          () => [b.op("select.f64", [b.ltK(hy, 0), b.neg(y), zero], "f64")],
          ["f64"],
        ),
      ["f64"],
    );
  });
  b.retIf(b.eqK(b.ior(b.isub(iy, b.i32(0x3ff00000)), ly), 0), () => [
    b.op("select.f64", [b.ltK(hy, 0), b.div(one, x), x], "f64"),
  ]);
  b.retIf(b.eqK(b.ior(b.isub(hy, b.i32(0x40000000)), ly), 0), () => [b.mul(x, x)]);
  b.retIf(b.iand(b.eqK(b.ior(b.isub(hy, b.i32(0x3fe00000)), ly), 0), b.geK(hx, 0)), () => [
    b.op("fsqrt.f64", [x], "f64"),
  ]);
  const ax = b.abs(x);
  // x is +-0, +-inf or +-1.
  const special = b.iand(
    b.eqK(lx, 0),
    b.ior(b.ior(b.eqK(ix, 0x7ff00000), b.eqK(ix, 0)), b.eqK(ix, 0x3ff00000)),
  );
  b.retIf(special, () => {
    const z0 = b.op("select.f64", [b.ltK(hy, 0), b.div(one, ax), ax], "f64");
    return b.ifElse(
      b.ltK(hx, 0),
      () =>
        b.ifElse(
          b.eqK(b.ior(b.isub(ix, b.i32(0x3ff00000)), yisint), 0),
          () => [b.fw(0x7ff80000, 0)],
          () => [b.op("select.f64", [b.eqK(yisint, 1), b.neg(z0), z0], "f64")],
          ["f64"],
        ),
      () => [z0],
      ["f64"],
    );
  });
  const n0 = b.shr(hx, 31);
  const nS = b.isub(n0, b.i32(1));
  b.retIf(b.eqK(b.ior(nS, yisint), 0), () => [nan]);
  const s = b.op(
    "select.f64",
    [b.eqK(b.ior(nS, b.isub(yisint, b.i32(1))), 0), b.f64(-1), one],
    "f64",
  );

  const ivln2 = b.fw(0x3ff71547, 0x652b82fe);
  const ivln2_h = b.fw(0x3ff71547, 0x60000000);
  const ivln2_l = b.fw(0x3e54ae0b, 0xf85ddf44);
  const [t1, t2] = b.ifElse(
    b.gtK(iy, 0x41e00000),
    () => {
      // |y| is huge.
      const over = b.op("select.f64", [b.ltK(hy, 0), b.mul(huge, huge), b.mul(tiny, tiny)], "f64");
      const under = b.op("select.f64", [b.gtK(hy, 0), b.mul(huge, huge), b.mul(tiny, tiny)], "f64");
      const veryBig = b.gtK(iy, 0x43f00000);
      b.retIf(b.iand(veryBig, b.leK(ix, 0x3fefffff)), () => [over]);
      b.retIf(b.iand(veryBig, b.geK(ix, 0x3ff00000)), () => [under]);
      b.retIf(b.ltK(ix, 0x3fefffff), () => [
        b.op(
          "select.f64",
          [b.ltK(hy, 0), b.mul(b.mul(s, huge), huge), b.mul(b.mul(s, tiny), tiny)],
          "f64",
        ),
      ]);
      b.retIf(b.gtK(ix, 0x3ff00000), () => [
        b.op(
          "select.f64",
          [b.gtK(hy, 0), b.mul(b.mul(s, huge), huge), b.mul(b.mul(s, tiny), tiny)],
          "f64",
        ),
      ]);
      const t = b.sub(ax, one);
      const w = b.mul(
        b.mul(t, t),
        b.fma(b.neg(t), b.fma(b.neg(t), b.f64(0.25), b.f64(0.3333333333333333)), b.f64(0.5)),
      );
      const u = b.mul(ivln2_h, t);
      const v = b.fma(t, ivln2_l, b.neg(b.mul(w, ivln2)));
      const t10 = b.setLo0(b.add(u, v));
      return [t10, b.sub(v, b.sub(t10, u))];
    },
    () => {
      const [ax1, n1] = b.ifElse(
        b.ltK(ix, 0x00100000),
        () => [b.mul(ax, b.fw(0x43400000, 0)), b.i32(-53)],
        () => [ax, b.i32(0)],
        ["f64", "i32"],
      ) as [number, number];
      const ix1 = b.hi(ax1);
      const n2 = b.iadd(n1, b.isub(b.sar(ix1, 20), b.i32(0x3ff)));
      const j0 = b.iand(ix1, b.i32(0x000fffff));
      const ix2 = b.ior(j0, b.i32(0x3ff00000));
      const [k, n3, ix3] = b.ifElse(
        b.leK(j0, 0x3988e),
        () => [b.i32(0), n2, ix2],
        () =>
          b.ifElse(
            b.ltK(j0, 0xbb67a),
            () => [b.i32(1), n2, ix2],
            () => [b.i32(0), b.iadd(n2, b.i32(1)), b.isub(ix2, b.i32(0x00100000))],
            ["i32", "i32", "i32"],
          ),
        ["i32", "i32", "i32"],
      ) as [number, number, number];
      const ax2 = b.setHi(ax1, ix3);
      const kIs1 = b.eqK(k, 1);
      const bp = b.op("select.f64", [kIs1, b.f64(1.5), one], "f64");
      const dp_h = b.op("select.f64", [kIs1, b.fw(0x3fe2b803, 0x40000000), zero], "f64");
      const dp_l = b.op("select.f64", [kIs1, b.fw(0x3e4cfdeb, 0x43cfd006), zero], "f64");
      const u = b.sub(ax2, bp);
      const v = b.div(one, b.add(ax2, bp));
      const ss = b.mul(u, v);
      const s_h = b.setLo0(ss);
      const t_h = b.words(
        b.iadd(b.iadd(b.ior(b.sar(ix3, 1), b.i32(0x20000000)), b.i32(0x00080000)), b.shl(k, 18)),
        b.i32(0),
      );
      const t_l = b.sub(ax2, b.sub(t_h, bp));
      const s_l = b.mul(v, b.fma(b.neg(s_h), t_l, b.fma(b.neg(s_h), t_h, u)));
      const s2 = b.mul(ss, ss);
      const L: [number, number][] = [
        [0x3fe33333, 0x33333303],
        [0x3fdb6db6, 0xdb6fabff],
        [0x3fd55555, 0x518f264d],
        [0x3fd17460, 0xa91d4101],
        [0x3fcd864a, 0x93c9db65],
        [0x3fca7e28, 0x4a454eef],
      ];
      const r0 = b.mul(b.mul(s2, s2), b.poly(s2, L));
      const r = b.fma(s_l, b.add(s_h, ss), r0);
      const s2b = b.mul(s_h, s_h);
      const three = b.f64(3);
      const th0 = b.setLo0(b.add(b.add(three, s2b), r));
      const tl0 = b.sub(r, b.sub(b.sub(th0, three), s2b));
      const u2 = b.mul(s_h, th0);
      const v2 = b.fma(s_l, th0, b.mul(tl0, ss));
      const p_h = b.setLo0(b.add(u2, v2));
      const p_l = b.sub(v2, b.sub(p_h, u2));
      const cp_h = b.fw(0x3feec709, 0xe0000000);
      const cp_l = b.fw(0xbe3e2fe0, 0x145b01f5);
      const cp = b.fw(0x3feec709, 0xdc3a03fd);
      const z_h = b.mul(cp_h, p_h);
      const z_l = b.add(b.fma(cp_l, p_h, b.mul(p_l, cp)), dp_l);
      const t = b.toF(n3);
      const t1b = b.setLo0(b.add(b.add(b.add(z_h, z_l), dp_h), t));
      const t2b = b.sub(z_l, b.sub(b.sub(b.sub(t1b, t), dp_h), z_h));
      return [t1b, t2b];
    },
    ["f64", "f64"],
  ) as [number, number];

  // Split y into y1+y2 and compute (y1+y2)*(t1+t2).
  const y1 = b.setLo0(y);
  const p_l = b.fma(b.sub(y, y1), t1, b.mul(y, t2));
  const p_h0 = b.mul(y1, t1);
  const z0 = b.add(p_l, p_h0);
  const j = b.hi(z0);
  const i0 = b.lo(z0);
  const ovt = b.f64(8.008566259537294e-17);
  const hugeS = b.mul(b.mul(s, huge), huge);
  const tinyS = b.mul(b.mul(s, tiny), tiny);
  // Overflow and underflow, including the exact boundary, which only the rounding error can decide.
  const boundaryHi = b.geK(j, 0x40900000);
  b.retIf(b.iand(boundaryHi, b.neK(b.ior(b.isub(j, b.i32(0x40900000)), i0), 0)), () => [hugeS]);
  b.retIf(b.iand(boundaryHi, b.fgt(b.add(p_l, ovt), b.sub(z0, p_h0))), () => [hugeS]);
  const boundaryLo = b.iand(b.ltK(j, 0x40900000), b.geK(b.iand(j, b.i32(0x7fffffff)), 0x4090cc00));
  b.retIf(b.iand(boundaryLo, b.neK(b.ior(b.isub(j, b.i32(0xc090cc00 | 0)), i0), 0)), () => [tinyS]);
  b.retIf(b.iand(boundaryLo, b.op("fcmp.le.f64", [p_l, b.sub(z0, p_h0)], "i32")), () => [tinyS]);
  // Compute 2^(p_h+p_l).
  const i1 = b.iand(j, b.i32(0x7fffffff));
  const k1 = b.isub(b.sar(i1, 20), b.i32(0x3ff));
  const [n, p_h1] = b.ifElse(
    b.gtK(i1, 0x3fe00000),
    () => {
      const nA = b.iadd(j, b.op("ashr.i32", [b.i32(0x00100000), b.iadd(k1, b.i32(1))], "i32"));
      const k2 = b.isub(b.sar(b.iand(nA, b.i32(0x7fffffff)), 20), b.i32(0x3ff));
      const t = b.words(
        b.iand(nA, b.op("not.i32", [b.op("ashr.i32", [b.i32(0x000fffff), k2], "i32")], "i32")),
        b.i32(0),
      );
      const n3 = b.op(
        "lshr.i32",
        [b.ior(b.iand(nA, b.i32(0x000fffff)), b.i32(0x00100000)), b.isub(b.i32(20), k2)],
        "i32",
      );
      const n4 = b.op("select.i32", [b.ltK(j, 0), b.isub(b.i32(0), n3), n3], "i32");
      return [n4, b.sub(p_h0, t)];
    },
    () => [b.i32(0), p_h0],
    ["i32", "f64"],
  ) as [number, number];
  const lg2 = b.fw(0x3fe62e42, 0xfefa39ef);
  const lg2_h = b.fw(0x3fe62e43, 0);
  const lg2_l = b.fw(0xbe205c61, 0x0ca86c39);
  const t0 = b.setLo0(b.add(p_l, p_h1));
  const u = b.mul(t0, lg2_h);
  const v = b.fma(b.sub(p_l, b.sub(t0, p_h1)), lg2, b.mul(t0, lg2_l));
  const z1 = b.add(u, v);
  const w = b.sub(v, b.sub(z1, u));
  const tq = b.mul(z1, z1);
  const t11 = b.fma(b.neg(tq), b.poly(tq, EXP_P), z1);
  const r = b.sub(b.div(b.mul(z1, t11), b.sub(t11, two)), b.fma(z1, w, w));
  const z2 = b.sub(one, b.sub(r, z1));
  const jz = b.iadd(b.hi(z2), b.shl(n, 20));
  const z3 = b.ifElse(
    b.leK(b.sar(jz, 20), 0),
    () => [b.call("__scalbn", [z2, n], ["f64"])[0]!],
    () => [b.words(jz, b.lo(z2))],
    ["f64"],
  )[0]!;
  b.ret([b.mul(s, z3)]);
  return b.finish();
}

/** scalbn for the one case pow needs: a result near or below the subnormal boundary. */
function scalbn(): Func {
  const b = new L("__scalbn", ["f64", "i32"], ["f64"]);
  const [x0, n0] = b.params as [number, number];
  // Multiply in steps no wider than the exponent range, so only the last can round.
  const head = b.block(["f64", "i32"]);
  b.br(head, [x0, n0]);
  b.at(head);
  const [x, n] = head.params as [number, number];
  const body = b.block();
  const down = b.block();
  const done = b.block();
  b.brif(b.gtK(n, 1023), body, down);
  b.at(body);
  b.br(head, [b.mul(x, b.fw(0x7fe00000, 0)), b.isub(n, b.i32(1023))]);
  b.at(down);
  const under = b.block();
  b.brif(b.ltK(n, -1022), under, done);
  b.at(under);
  // 2^-969 keeps the intermediate exact until the final scaling, which alone rounds.
  b.br(head, [b.mul(x, b.fw(0x03600000, 0)), b.iadd(n, b.i32(969))]);
  b.at(done);
  const scale = b.words(b.shl(b.iadd(n, b.i32(1023)), 20), b.i32(0));
  b.ret([b.mul(x, scale)]);
  return b.finish();
}

let cache: { funcs: Func[]; globals: Global[] } | null = null;

export function libmFuncs(): { funcs: Func[]; globals: Global[] } {
  if (cache === null) {
    cache = {
      funcs: [
        kernelSin(),
        kernelCos(),
        remPio2(),
        trig("sin"),
        trig("cos"),
        exp(),
        log(),
        atan(),
        atan2(),
        pow(),
        scalbn(),
      ],
      globals: [],
    };
  }
  return cache;
}
