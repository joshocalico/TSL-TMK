// A disassembler for every instruction this backend emits, written from the Arm ARM's encoding tables
// and independent of encode.ts: it reads fields out of a word, and never calls the encoder. It prints
// what llvm-objdump prints, aliases included, so the two can be compared line by line (SPEC M5).
// Returns null for a word it doesn't recognise.

const COND = [
  "eq",
  "ne",
  "hs",
  "lo",
  "mi",
  "pl",
  "vs",
  "vc",
  "hi",
  "ls",
  "ge",
  "lt",
  "gt",
  "le",
  "al",
  "nv",
];

function bits(w: number, hi: number, lo: number): number {
  return (w >>> lo) & (2 ** (hi - lo + 1) - 1);
}

function hex(n: number | bigint): string {
  return `0x${n.toString(16)}`;
}

function simm(v: number, width: number): number {
  return v >= 2 ** (width - 1) ? v - 2 ** width : v;
}

const r = (n: number, sf: boolean): string =>
  n === 31 ? (sf ? "xzr" : "wzr") : `${sf ? "x" : "w"}${n}`;
const rsp = (n: number, sf: boolean): string =>
  n === 31 ? (sf ? "sp" : "wsp") : `${sf ? "x" : "w"}${n}`;

/** The bitmask immediate from N:immr:imms, per the Arm ARM's DecodeBitMasks. */
function decodeBitmask(n: number, immr: number, imms: number, sf: boolean): bigint | null {
  const combined = (n << 6) | (~imms & 0x3f);
  if (combined === 0) return null;
  const len = 31 - Math.clz32(combined);
  const size = 1 << len;
  const s = imms & (size - 1);
  const rot = immr & (size - 1);
  if (s === size - 1) return null;
  const big = BigInt(size);
  const emask = big === 64n ? (1n << 64n) - 1n : (1n << big) - 1n;
  const ones = (1n << BigInt(s + 1)) - 1n;
  const ur = BigInt(rot);
  const e = rot === 0 ? ones : ((ones >> ur) | (ones << (big - ur))) & emask;
  let out = 0n;
  for (let at = 0; at < (sf ? 64 : 32); at += size) out |= e << BigInt(at);
  return out & (sf ? (1n << 64n) - 1n : (1n << 32n) - 1n);
}

/** A mov alias's immediate: LLVM prints it signed, in the register's width. */
function movImm(value: bigint, sf: boolean): string {
  const v = BigInt.asIntN(sf ? 64 : 32, value);
  return v < 0n ? `#-${hex(-v)}` : `#${hex(v)}`;
}

const SYSREG: Record<string, string> = {
  "3:0:1:0:0": "SCTLR_EL1",
  "3:0:1:0:2": "CPACR_EL1",
  "3:0:2:0:0": "TTBR0_EL1",
  "3:0:2:0:2": "TCR_EL1",
  "3:0:4:0:0": "SPSR_EL1",
  "3:0:4:0:1": "ELR_EL1",
  "3:0:4:1:0": "SP_EL0",
  "3:0:5:2:0": "ESR_EL1",
  "3:0:6:0:0": "FAR_EL1",
  "3:0:10:2:0": "MAIR_EL1",
  "3:0:12:0:0": "VBAR_EL1",
  "3:3:14:0:0": "CNTFRQ_EL0",
  "3:3:14:0:2": "CNTVCT_EL0",
  "3:3:4:4:0": "FPCR",
  "3:3:4:4:1": "FPSR",
};

const SHIFT = ["lsl", "lsr", "asr", "ror"];

function fpImmValue(imm8: number): string {
  const sign = (imm8 >> 7) & 1;
  const exp = ((imm8 >> 4) & 7) ^ 4; // the top exponent bit is inverted, with -3 to +4 as a result
  const e = exp >= 4 ? exp - 8 : exp;
  const frac = 16 + (imm8 & 15);
  const v = ((sign === 1 ? -1 : 1) * frac * 2 ** (e + 1)) / 32;
  const text = v.toFixed(8);
  return `#${text
    .replace(/(\.\d*?[1-9])0+$/, "$1")
    .replace(/\.0+$/, ".0")
    .padEnd(0)}`;
}

export function decode(w: number, pc: number): string | null {
  const sf = w >>> 31 === 1;
  // --- system
  switch (w) {
    case 0xd503201f:
      return "nop";
    case 0xd5033fdf:
      return "isb";
    case 0xd5033f9f:
      return "dsb sy";
    case 0xd5033b9f:
      return "dsb ish";
    case 0xd4000002:
      return "hvc #0";
    case 0xd508751f:
      return "ic iallu";
    case 0xd508871f:
      return "tlbi vmalle1";
    case 0xd5034fdf:
      return "msr DAIFSet, #0xf";
    case 0xd50040bf:
      return "msr SPSel, #0x0";
    case 0xd50041bf:
      return "msr SPSel, #0x1";
    case 0xd65f03c0:
      return "ret";
    case 0xd69f03e0:
      return "eret";
  }
  if ((w & 0xffffffe0) >>> 0 === 0xd50b7e20) return `dc civac, ${r(w & 31, true)}`;
  if ((w & 0xffd00000) >>> 0 === 0xd5100000) {
    const key = `${2 + bits(w, 19, 19)}:${bits(w, 18, 16)}:${bits(w, 15, 12)}:${bits(w, 11, 8)}:${bits(w, 7, 5)}`;
    const name = SYSREG[key];
    if (name === undefined) return null;
    return bits(w, 21, 21) === 1
      ? `mrs ${r(w & 31, true)}, ${name}`
      : `msr ${name}, ${r(w & 31, true)}`;
  }
  // --- branches
  if ((w & 0xfc000000) >>> 0 === 0x14000000 || (w & 0xfc000000) >>> 0 === 0x94000000) {
    const name = w >>> 31 === 1 ? "bl" : "b";
    return `${name} ${hex(pc + simm(bits(w, 25, 0), 26) * 4)}`;
  }
  if ((w & 0xff000010) >>> 0 === 0x54000000) {
    return `b.${COND[w & 15]!} ${hex(pc + simm(bits(w, 23, 5), 19) * 4)}`;
  }
  if ((w & 0x7e000000) >>> 0 === 0x34000000) {
    const name = bits(w, 24, 24) === 1 ? "cbnz" : "cbz";
    return `${name} ${r(w & 31, sf)}, ${hex(pc + simm(bits(w, 23, 5), 19) * 4)}`;
  }
  if ((w & 0xfffffc1f) >>> 0 === 0xd61f0000) return `br ${r(bits(w, 9, 5), true)}`;
  if ((w & 0xfffffc1f) >>> 0 === 0xd63f0000) return `blr ${r(bits(w, 9, 5), true)}`;
  if ((w & 0x9f000000) >>> 0 === 0x10000000) {
    const imm = simm(bits(w, 23, 5) * 4 + bits(w, 30, 29), 21);
    return `adr ${r(w & 31, true)}, ${hex(pc + imm)}`;
  }
  if ((w & 0x9f000000) >>> 0 === 0x90000000) {
    const imm = simm(bits(w, 23, 5) * 4 + bits(w, 30, 29), 21);
    return `adrp ${r(w & 31, true)}, ${hex(Math.floor(pc / 4096) * 4096 + imm * 4096)}`;
  }
  // --- add and subtract, immediate
  if ((w & 0x1f000000) >>> 0 === 0x11000000) {
    const op = bits(w, 30, 30);
    const s = bits(w, 29, 29);
    const sh = bits(w, 23, 22);
    if (sh > 1) return null;
    const imm = bits(w, 21, 10);
    const rd = w & 31;
    const rn = bits(w, 9, 5);
    const suffix = sh === 1 ? `, lsl #12` : "";
    if (s === 1 && rd === 31) {
      return `${op === 1 ? "cmp" : "cmn"} ${rsp(rn, sf)}, #${hex(imm)}${suffix}`;
    }
    if (op === 0 && s === 0 && imm === 0 && sh === 0 && (rd === 31 || rn === 31)) {
      return `mov ${rsp(rd, sf)}, ${rsp(rn, sf)}`;
    }
    const name = (op === 1 ? "sub" : "add") + (s === 1 ? "s" : "");
    return `${name} ${s === 1 ? r(rd, sf) : rsp(rd, sf)}, ${rsp(rn, sf)}, #${hex(imm)}${suffix}`;
  }
  // --- add and subtract, shifted register
  if ((w & 0x1f200000) >>> 0 === 0x0b000000) {
    const op = bits(w, 30, 30);
    const s = bits(w, 29, 29);
    const kind = bits(w, 23, 22);
    if (kind === 3) return null;
    const rm = bits(w, 20, 16);
    const amt = bits(w, 15, 10);
    const rn = bits(w, 9, 5);
    const rd = w & 31;
    const sh = amt === 0 && kind === 0 ? "" : `, ${SHIFT[kind]!} #${amt}`;
    if (s === 1 && rd === 31) return `${op === 1 ? "cmp" : "cmn"} ${r(rn, sf)}, ${r(rm, sf)}${sh}`;
    if (op === 1 && rn === 31) return `${s === 1 ? "negs" : "neg"} ${r(rd, sf)}, ${r(rm, sf)}${sh}`;
    const name = (op === 1 ? "sub" : "add") + (s === 1 ? "s" : "");
    return `${name} ${r(rd, sf)}, ${r(rn, sf)}, ${r(rm, sf)}${sh}`;
  }
  // --- add and subtract, extended register
  if ((w & 0x1fe00000) >>> 0 === 0x0b200000) {
    const op = bits(w, 30, 30);
    const s = bits(w, 29, 29);
    const rm = bits(w, 20, 16);
    const option = bits(w, 15, 13);
    const amt = bits(w, 12, 10);
    const rn = bits(w, 9, 5);
    const rd = w & 31;
    const ext = ["uxtb", "uxth", "uxtw", "uxtx", "sxtb", "sxth", "sxtw", "sxtx"][option]!;
    const rmReg = r(rm, sf && (option & 3) === 3);
    const tail = amt === 0 ? `, ${ext}` : `, ${ext} #${amt}`;
    if (s === 1 && rd === 31) return `${op === 1 ? "cmp" : "cmn"} ${rsp(rn, sf)}, ${rmReg}${tail}`;
    return `${(op === 1 ? "sub" : "add") + (s === 1 ? "s" : "")} ${rsp(rd, sf)}, ${rsp(rn, sf)}, ${rmReg}${tail}`;
  }
  // --- logical, immediate
  if ((w & 0x1f800000) >>> 0 === 0x12000000) {
    const opc = bits(w, 30, 29);
    const n = bits(w, 22, 22);
    const value = decodeBitmask(n, bits(w, 21, 16), bits(w, 15, 10), sf);
    if (value === null) return null;
    const rd = w & 31;
    const rn = bits(w, 9, 5);
    if (opc === 1 && rn === 31) return `mov ${rsp(rd, sf)}, ${movImm(value, sf)}`;
    if (opc === 3 && rd === 31) return `tst ${r(rn, sf)}, #${hex(value)}`;
    const name = ["and", "orr", "eor", "ands"][opc]!;
    return `${name} ${opc === 3 ? r(rd, sf) : rsp(rd, sf)}, ${r(rn, sf)}, #${hex(value)}`;
  }
  // --- logical, shifted register
  if ((w & 0x1f000000) >>> 0 === 0x0a000000) {
    const opc = bits(w, 30, 29);
    const inv = bits(w, 21, 21);
    const kind = bits(w, 23, 22);
    const rm = bits(w, 20, 16);
    const amt = bits(w, 15, 10);
    const rn = bits(w, 9, 5);
    const rd = w & 31;
    const sh = amt === 0 && kind === 0 ? "" : `, ${SHIFT[kind]!} #${amt}`;
    if (opc === 1 && inv === 0 && rn === 31 && sh === "") return `mov ${r(rd, sf)}, ${r(rm, sf)}`;
    if (opc === 1 && inv === 1 && rn === 31) return `mvn ${r(rd, sf)}, ${r(rm, sf)}${sh}`;
    if (opc === 3 && inv === 0 && rd === 31) return `tst ${r(rn, sf)}, ${r(rm, sf)}${sh}`;
    const name = (inv === 1 ? ["bic", "orn", "eon", "bics"] : ["and", "orr", "eor", "ands"])[opc]!;
    return `${name} ${r(rd, sf)}, ${r(rn, sf)}, ${r(rm, sf)}${sh}`;
  }
  // --- move wide
  if ((w & 0x1f800000) >>> 0 === 0x12800000) {
    const opc = bits(w, 30, 29);
    const hw = bits(w, 22, 21);
    const imm = bits(w, 20, 5);
    const rd = w & 31;
    const shift = hw * 16;
    if (opc === 3) return `movk ${r(rd, sf)}, #${hex(imm)}${hw === 0 ? "" : `, lsl #${shift}`}`;
    if (opc === 2) {
      if (imm === 0 && hw !== 0) return `movz ${r(rd, sf)}, #${hex(imm)}, lsl #${shift}`;
      return `mov ${r(rd, sf)}, ${movImm(BigInt(imm) << BigInt(shift), sf)}`;
    }
    if (opc === 0) {
      // MOVN prints as a mov of its value, which LLVM reads as signed in the register's width.
      if (imm === 0 && hw !== 0) return `movn ${r(rd, sf)}, #${hex(imm)}, lsl #${shift}`;
      if (!sf && imm === 0xffff)
        return `movn ${r(rd, sf)}, #${hex(imm)}${hw === 0 ? "" : `, lsl #${shift}`}`;
      const width = sf ? 64 : 32;
      const value = BigInt.asIntN(width, ~(BigInt(imm) << BigInt(shift)));
      return `mov ${r(rd, sf)}, ${movImm(value, sf)}`;
    }
    return null;
  }
  // --- bitfield
  if ((w & 0x1f800000) >>> 0 === 0x13000000) {
    const opc = bits(w, 30, 29);
    const immr = bits(w, 21, 16);
    const imms = bits(w, 15, 10);
    const rd = w & 31;
    const rn = bits(w, 9, 5);
    const width = sf ? 64 : 32;
    if (opc === 2) {
      if (imms !== width - 1 && imms + 1 === immr)
        return `lsl ${r(rd, sf)}, ${r(rn, sf)}, #${width - 1 - imms}`;
      if (imms === width - 1) return `lsr ${r(rd, sf)}, ${r(rn, sf)}, #${immr}`;
      if (imms < immr) return `ubfiz ${r(rd, sf)}, ${r(rn, sf)}, #${width - immr}, #${imms + 1}`;
      return `ubfx ${r(rd, sf)}, ${r(rn, sf)}, #${immr}, #${imms - immr + 1}`;
    }
    if (opc === 0) {
      if (imms === width - 1) return `asr ${r(rd, sf)}, ${r(rn, sf)}, #${immr}`;
      if (immr === 0 && imms === 7) return `sxtb ${r(rd, sf)}, ${r(rn, false)}`;
      if (immr === 0 && imms === 15) return `sxth ${r(rd, sf)}, ${r(rn, false)}`;
      if (immr === 0 && imms === 31) return `sxtw ${r(rd, sf)}, ${r(rn, false)}`;
      return `sbfx ${r(rd, sf)}, ${r(rn, sf)}, #${immr}, #${imms - immr + 1}`;
    }
    if (opc === 1) {
      if (imms < immr) return `bfi ${r(rd, sf)}, ${r(rn, sf)}, #${width - immr}, #${imms + 1}`;
      return `bfxil ${r(rd, sf)}, ${r(rn, sf)}, #${immr}, #${imms - immr + 1}`;
    }
    return null;
  }
  // --- data processing, two sources
  if ((w & 0x5fe00000) >>> 0 === 0x1ac00000) {
    const opcode = bits(w, 15, 10);
    const rm = bits(w, 20, 16);
    const rn = bits(w, 9, 5);
    const rd = w & 31;
    const names: Record<number, string> = { 2: "udiv", 3: "sdiv", 8: "lsl", 9: "lsr", 10: "asr" };
    const name = names[opcode];
    if (name === undefined) return null;
    return `${name} ${r(rd, sf)}, ${r(rn, sf)}, ${r(rm, sf)}`;
  }
  if ((w & 0x7ffffc00) >>> 0 === 0x5ac01000) return `clz ${r(w & 31, sf)}, ${r(bits(w, 9, 5), sf)}`;
  // --- multiply
  if ((w & 0x7fe00000) >>> 0 === 0x1b000000) {
    const rm = bits(w, 20, 16);
    const o0 = bits(w, 15, 15);
    const ra = bits(w, 14, 10);
    const rn = bits(w, 9, 5);
    const rd = w & 31;
    if (ra === 31) return `${o0 === 1 ? "mneg" : "mul"} ${r(rd, sf)}, ${r(rn, sf)}, ${r(rm, sf)}`;
    return `${o0 === 1 ? "msub" : "madd"} ${r(rd, sf)}, ${r(rn, sf)}, ${r(rm, sf)}, ${r(ra, sf)}`;
  }
  if ((w & 0xffe0fc00) >>> 0 === 0x9b207c00) {
    return `smull ${r(w & 31, true)}, ${r(bits(w, 9, 5), false)}, ${r(bits(w, 20, 16), false)}`;
  }
  if ((w & 0xffe0fc00) >>> 0 === 0x9ba07c00) {
    return `umull ${r(w & 31, true)}, ${r(bits(w, 9, 5), false)}, ${r(bits(w, 20, 16), false)}`;
  }
  if ((w & 0xffe0fc00) >>> 0 === 0x9b407c00) {
    return `smulh ${r(w & 31, true)}, ${r(bits(w, 9, 5), true)}, ${r(bits(w, 20, 16), true)}`;
  }
  if ((w & 0xffe0fc00) >>> 0 === 0x9bc07c00) {
    return `umulh ${r(w & 31, true)}, ${r(bits(w, 9, 5), true)}, ${r(bits(w, 20, 16), true)}`;
  }
  // --- conditional select
  if ((w & 0x7fe00c00) >>> 0 === 0x1a800000) {
    return `csel ${r(w & 31, sf)}, ${r(bits(w, 9, 5), sf)}, ${r(bits(w, 20, 16), sf)}, ${COND[bits(w, 15, 12)]!}`;
  }
  if ((w & 0x7fe00c00) >>> 0 === 0x1a800400) {
    const rm = bits(w, 20, 16);
    const rn = bits(w, 9, 5);
    const c = bits(w, 15, 12);
    if (rm === 31 && rn === 31) return `cset ${r(w & 31, sf)}, ${COND[c ^ 1]!}`;
    return `csinc ${r(w & 31, sf)}, ${r(rn, sf)}, ${r(rm, sf)}, ${COND[c]!}`;
  }
  // --- loads and stores
  const mem = decodeMem(w, pc);
  if (mem !== null) return mem;
  return decodeFp(w);
}

function decodeMem(w: number, pc: number): string | null {
  // Literal.
  if ((w & 0x3b000000) >>> 0 === 0x18000000) {
    const opc = bits(w, 31, 30);
    const v = bits(w, 26, 26);
    const target = hex(pc + simm(bits(w, 23, 5), 19) * 4);
    const rt = w & 31;
    if (v === 0) return opc > 1 ? null : `ldr ${r(rt, opc === 1)}, ${target}`;
    return opc > 1 ? null : `ldr ${opc === 1 ? "d" : "s"}${rt}, ${target}`;
  }
  // Pairs.
  if ((w & 0x3a000000) >>> 0 === 0x28000000) {
    const opc = bits(w, 31, 30);
    const v = bits(w, 26, 26);
    const mode = bits(w, 24, 23);
    const l = bits(w, 22, 22);
    const rt = w & 31;
    const rt2 = bits(w, 14, 10);
    const rn = bits(w, 9, 5);
    const size = v === 1 ? 4 << opc : opc === 2 ? 8 : 4;
    const off = simm(bits(w, 21, 15), 7) * size;
    const offText = off < 0 ? `-${hex(-off)}` : hex(off);
    const reg = (n: number): string =>
      v === 1 ? `${opc === 0 ? "s" : opc === 1 ? "d" : "q"}${n}` : r(n, opc === 2);
    const base = rsp(rn, true);
    const name = l === 1 ? "ldp" : "stp";
    if (mode === 2)
      return `${name} ${reg(rt)}, ${reg(rt2)}, [${base}${off === 0 ? "" : `, #${offText}`}]`;
    if (mode === 3) return `${name} ${reg(rt)}, ${reg(rt2)}, [${base}, #${offText}]!`;
    if (mode === 1) return `${name} ${reg(rt)}, ${reg(rt2)}, [${base}], #${offText}`;
    return null;
  }
  // Single register.
  if ((w & 0x3a000000) >>> 0 === 0x38000000) {
    const size = bits(w, 31, 30);
    const v = bits(w, 26, 26);
    const opc = bits(w, 23, 22);
    const rt = w & 31;
    const rn = bits(w, 9, 5);
    const base = rsp(rn, true);
    let name: string;
    let reg: string;
    let scale: number;
    if (v === 1) {
      const q = size === 0 && opc >= 2;
      scale = q ? 16 : 1 << size;
      name = opc === 1 || opc === 3 ? "ldr" : "str";
      reg = `${q ? "q" : size === 3 ? "d" : size === 2 ? "s" : size === 1 ? "h" : "b"}${rt}`;
    } else {
      scale = 1 << size;
      const suffix = size === 0 ? "b" : size === 1 ? "h" : "";
      if (opc === 0) name = `str${suffix}`;
      else if (opc === 1) name = `ldr${suffix}`;
      else if (opc === 3 && size < 2) name = `ldrs${suffix}`;
      else return null;
      reg = r(rt, size === 3);
    }
    if (bits(w, 24, 24) === 1) {
      const off = bits(w, 21, 10) * scale;
      return `${name} ${reg}, [${base}${off === 0 ? "" : `, #${hex(off)}`}]`;
    }
    if (bits(w, 21, 21) === 1 && bits(w, 11, 10) === 2) {
      const option = bits(w, 15, 13);
      if (option !== 3) return null;
      const s = bits(w, 12, 12);
      const rm = r(bits(w, 20, 16), true);
      const shift =
        scale === 1
          ? s === 1
            ? ", lsl #0"
            : ""
          : s === 1
            ? `, lsl #${31 - Math.clz32(scale)}`
            : "";
      return `${name} ${reg}, [${base}, ${rm}${shift}]`;
    }
    if (bits(w, 21, 21) === 0 && bits(w, 11, 10) === 0) {
      const off = simm(bits(w, 20, 12), 9);
      const uname = name.replace("ldr", "ldur").replace("str", "stur");
      const text = off < 0 ? `#-${hex(-off)}` : `#${hex(off)}`;
      return `${uname} ${reg}, [${base}${off === 0 ? "" : `, ${text}`}]`;
    }
    return null;
  }
  return null;
}

function decodeFp(w: number): string | null {
  if (w >>> 0 === (0x2f00e400 | (w & 31)) >>> 0) return `movi d${w & 31}, #0000000000000000`;
  if ((w & 0x7f000000) >>> 0 === 0x1e000000 || (w & 0xff000000) >>> 0 === 0x9e000000) {
    const sf = w >>> 31 === 1;
    const ftype = bits(w, 23, 22);
    if (ftype > 1) return null;
    const d = ftype === 1;
    const f = (n: number): string => `${d ? "d" : "s"}${n}`;
    const rd = w & 31;
    const rn = bits(w, 9, 5);
    const rm = bits(w, 20, 16);
    if (bits(w, 21, 21) !== 1) return null;
    // Conversions to and from integers.
    if (bits(w, 15, 10) === 0) {
      const rmode = bits(w, 20, 19);
      const opcode = bits(w, 18, 16);
      const ir = (n: number): string => r(n, sf);
      if (rmode === 0 && opcode === 2) return `scvtf ${f(rd)}, ${ir(rn)}`;
      if (rmode === 0 && opcode === 3) return `ucvtf ${f(rd)}, ${ir(rn)}`;
      if (rmode === 3 && opcode === 0) return `fcvtzs ${ir(rd)}, ${f(rn)}`;
      if (rmode === 3 && opcode === 1) return `fcvtzu ${ir(rd)}, ${f(rn)}`;
      if (rmode === 0 && opcode === 6) return `fmov ${ir(rd)}, ${f(rn)}`;
      if (rmode === 0 && opcode === 7) return `fmov ${f(rd)}, ${ir(rn)}`;
      return null;
    }
    if (sf) return null;
    if (bits(w, 14, 10) === 0b10000) {
      const opcode = bits(w, 20, 15);
      const un: Record<number, string> = {
        0: "fmov",
        1: "fabs",
        2: "fneg",
        3: "fsqrt",
        8: "frintn",
        9: "frintp",
        10: "frintm",
        11: "frintz",
      };
      const name = un[opcode];
      if (name !== undefined) return `${name} ${f(rd)}, ${f(rn)}`;
      if (opcode === 5 && !d) return `fcvt d${rd}, s${rn}`;
      if (opcode === 4 && d) return `fcvt s${rd}, d${rn}`;
      return null;
    }
    if (bits(w, 15, 10) === 0b001000 && bits(w, 4, 0) === 0) return `fcmp ${f(rn)}, ${f(rm)}`;
    if (bits(w, 12, 10) === 0b100 && bits(w, 9, 5) === 0)
      return `fmov ${f(rd)}, ${fpImmValue(bits(w, 20, 13))}`;
    if (bits(w, 11, 10) === 3)
      return `fcsel ${f(rd)}, ${f(rn)}, ${f(rm)}, ${COND[bits(w, 15, 12)]!}`;
    if (bits(w, 11, 10) === 2) {
      const opcode = bits(w, 15, 12);
      const bin: Record<number, string> = {
        0: "fmul",
        1: "fdiv",
        2: "fadd",
        3: "fsub",
        4: "fmax",
        5: "fmin",
      };
      const name = bin[opcode];
      return name === undefined ? null : `${name} ${f(rd)}, ${f(rn)}, ${f(rm)}`;
    }
    return null;
  }
  if ((w & 0xffe08000) >>> 0 === 0x1f400000 || (w & 0xffe08000) >>> 0 === 0x1f000000) {
    const d = bits(w, 22, 22) === 1;
    const f = (n: number): string => `${d ? "d" : "s"}${n}`;
    return `fmadd ${f(w & 31)}, ${f(bits(w, 9, 5))}, ${f(bits(w, 20, 16))}, ${f(bits(w, 14, 10))}`;
  }
  return null;
}
