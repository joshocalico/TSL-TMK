// A small Mach-O relocatable object writer, arm64 only (D57: "Mach-O ... objects for the system linker first"). It writes
// MH_OBJECT files with one unnamed segment, the sections it is given, their relocations, a symbol table and the build
// version, which the system `ld` links against libSystem into an executable (and signs). Nothing here reads a clock, a path
// or a hash order: the same input gives the same bytes. Values are from <mach-o/loader.h>, <mach-o/nlist.h>,
// <mach-o/reloc.h> and <mach-o/arm64/reloc.h> (Apple's headers, read for the constants only).

const MH_MAGIC_64 = 0xfeedfacf;
const CPU_TYPE_ARM64 = 0x0100000c;
const CPU_SUBTYPE_ARM64_ALL = 0;
const MH_OBJECT = 1;
const LC_SEGMENT_64 = 0x19;
const LC_SYMTAB = 0x2;
const LC_DYSYMTAB = 0xb;
const LC_BUILD_VERSION = 0x32;
const PLATFORM_MACOS = 1;
const N_EXT = 0x01;
const N_SECT = 0x0e;
const N_UNDF = 0x00;

export const S_REGULAR = 0x0;
export const S_ZEROFILL = 0x1;
export const S_ATTR_PURE_INSTRUCTIONS = 0x80000000;
export const S_ATTR_SOME_INSTRUCTIONS = 0x00000400;

/** The arm64 relocation types this writer emits (<mach-o/arm64/reloc.h>). */
const ARM64_RELOC_UNSIGNED = 0;
const ARM64_RELOC_SUBTRACTOR = 1;
const ARM64_RELOC_BRANCH26 = 2;
const ARM64_RELOC_PAGE21 = 3;
const ARM64_RELOC_PAGEOFF12 = 4;
const ARM64_RELOC_ADDEND = 10;

export type RelocKind =
  | "branch26" // b or bl to a symbol
  | "page21" // adrp: the symbol's 4 KiB page, PC-relative
  | "pageoff12" // add or a load or store's unsigned offset: the low 12 bits, scaled by the access as the linker sees fit
  | "subtractor" // with the "unsigned" that must follow it: an 8-byte (that symbol - this one + what's in the bytes)
  | "unsigned"; // an 8-byte address of the symbol plus what's in the bytes

export interface MachoReloc {
  address: number; // byte offset in its section
  kind: RelocKind;
  symbol: string;
  addend?: number; // page21 and pageoff12 only: an ARM64_RELOC_ADDEND before it, 24-bit signed
}

export interface MachoSection {
  sectname: string;
  segname: string;
  bytes: Uint8Array | null; // null: zero fill, no bytes in the file
  size: number;
  align: number; // bytes, a power of two
  flags: number;
  relocs: MachoReloc[];
}

export interface MachoSymbol {
  name: string;
  section: number; // 1-based index into the sections, or 0 for an undefined (imported) symbol
  offset: number; // within its section
  external: boolean;
}

export interface MachoObject {
  sections: MachoSection[];
  symbols: MachoSymbol[];
  /** macOS versions as [major, minor, patch]. */
  minos: [number, number, number];
  sdk: [number, number, number];
}

const version = (v: [number, number, number]): number => (v[0] << 16) | (v[1] << 8) | v[2];
const align = (n: number, a: number): number => Math.ceil(n / a) * a;
const log2 = (n: number): number => {
  const l = Math.log2(n);
  if (!Number.isInteger(l)) throw new Error(`macho: alignment ${n} isn't a power of two`);
  return l;
};

class Out {
  bytes: Uint8Array;
  view: DataView;
  constructor(n: number) {
    this.bytes = new Uint8Array(n);
    this.view = new DataView(this.bytes.buffer);
  }
  u8(at: number, v: number): void {
    this.view.setUint8(at, v);
  }
  u16(at: number, v: number): void {
    this.view.setUint16(at, v, true);
  }
  u32(at: number, v: number): void {
    this.view.setUint32(at, v >>> 0, true);
  }
  u64(at: number, v: number): void {
    this.view.setBigUint64(at, BigInt(v), true);
  }
  name16(at: number, s: string): void {
    if (s.length > 16) throw new Error(`macho: name ${s} is longer than 16 bytes`);
    for (let i = 0; i < s.length; i++) this.bytes[at + i] = s.charCodeAt(i);
  }
}

export function writeMachoObject(o: MachoObject): Uint8Array {
  // Symbols: locals first, then defined externals, then undefined ones, each external group by name, as ld expects.
  const locals = o.symbols.filter((s) => !s.external && s.section !== 0);
  const extdefs = o.symbols
    .filter((s) => s.external && s.section !== 0)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const undefs = o.symbols
    .filter((s) => s.section === 0)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const ordered = [...locals, ...extdefs, ...undefs];
  const index = new Map<string, number>();
  ordered.forEach((s, i) => {
    if (index.has(s.name)) throw new Error(`macho: symbol ${s.name} twice`);
    index.set(s.name, i);
  });

  // Section addresses in the object's own address space, one after another.
  const addrs: number[] = [];
  let addr = 0;
  for (const s of o.sections) {
    addr = align(addr, s.align);
    addrs.push(addr);
    addr += s.size;
  }
  const vmsize = addr;

  // The relocation entries of each section, as words: an ADDEND goes right before what it modifies, a SUBTRACTOR right
  // before its UNSIGNED.
  const relocWords = o.sections.map((s) => {
    const words: number[] = [];
    const entry = (
      address: number,
      symnum: number,
      pcrel: number,
      length: number,
      ext: number,
      type: number,
    ): void => {
      words.push(
        address,
        (symnum & 0xffffff) | (pcrel << 24) | (length << 25) | (ext << 27) | (type << 28),
      );
    };
    for (const r of s.relocs) {
      const sym = index.get(r.symbol);
      if (sym === undefined)
        throw new Error(`macho: relocation against unknown symbol ${r.symbol}`);
      if (r.addend !== undefined && r.addend !== 0) {
        if (r.kind !== "page21" && r.kind !== "pageoff12")
          throw new Error(`macho: an addend on a ${r.kind} relocation`);
        if (r.addend < -(1 << 23) || r.addend >= 1 << 23)
          throw new Error(`macho: addend ${r.addend} too large`);
        entry(r.address, r.addend, 0, 2, 0, ARM64_RELOC_ADDEND);
      }
      switch (r.kind) {
        case "branch26":
          entry(r.address, sym, 1, 2, 1, ARM64_RELOC_BRANCH26);
          break;
        case "page21":
          entry(r.address, sym, 1, 2, 1, ARM64_RELOC_PAGE21);
          break;
        case "pageoff12":
          entry(r.address, sym, 0, 2, 1, ARM64_RELOC_PAGEOFF12);
          break;
        case "subtractor":
          entry(r.address, sym, 0, 3, 1, ARM64_RELOC_SUBTRACTOR);
          break;
        case "unsigned":
          entry(r.address, sym, 0, 3, 1, ARM64_RELOC_UNSIGNED);
          break;
      }
    }
    return words;
  });

  // The string table: index 0 is the empty name.
  const strParts: number[] = [0];
  const strx = new Map<string, number>();
  for (const s of ordered) {
    strx.set(s.name, strParts.length);
    for (const b of new TextEncoder().encode(s.name)) strParts.push(b);
    strParts.push(0);
  }
  while (strParts.length % 8 !== 0) strParts.push(0);

  // File layout: header, load commands, section bytes, relocations, symbols, strings.
  const nsects = o.sections.length;
  const segSize = 72 + 80 * nsects;
  const sizeofcmds = segSize + 24 + 24 + 80;
  let at = 32 + sizeofcmds;
  const fileoffs: number[] = [];
  const segFileoff = align(at, 8);
  at = segFileoff;
  o.sections.forEach((s, i) => {
    if (s.bytes === null) {
      fileoffs.push(0);
      return;
    }
    // Keep each section at the same offset from the segment's start in the file as in memory.
    at = segFileoff + addrs[i]!;
    fileoffs.push(at);
    at += s.size;
  });
  const segFilesize = at - segFileoff;
  at = align(at, 8);
  const reloffs: number[] = [];
  for (const w of relocWords) {
    reloffs.push(w.length > 0 ? at : 0);
    at += w.length * 4;
  }
  at = align(at, 8);
  const symoff = at;
  at += ordered.length * 16;
  const stroff = at;
  at += strParts.length;

  const out = new Out(at);
  // mach_header_64
  out.u32(0, MH_MAGIC_64);
  out.u32(4, CPU_TYPE_ARM64);
  out.u32(8, CPU_SUBTYPE_ARM64_ALL);
  out.u32(12, MH_OBJECT);
  out.u32(16, 4); // ncmds
  out.u32(20, sizeofcmds);
  out.u32(24, 0); // flags: no MH_SUBSECTIONS_VIA_SYMBOLS, so ld keeps each section whole and in our order
  out.u32(28, 0);
  // LC_SEGMENT_64, unnamed, holding every section
  let c = 32;
  out.u32(c, LC_SEGMENT_64);
  out.u32(c + 4, segSize);
  out.u64(c + 24, 0); // vmaddr
  out.u64(c + 32, vmsize);
  out.u64(c + 40, segFileoff);
  out.u64(c + 48, segFilesize);
  out.u32(c + 56, 7); // maxprot
  out.u32(c + 60, 7); // initprot
  out.u32(c + 64, nsects);
  out.u32(c + 68, 0);
  o.sections.forEach((s, i) => {
    const h = c + 72 + 80 * i;
    out.name16(h, s.sectname);
    out.name16(h + 16, s.segname);
    out.u64(h + 32, addrs[i]!);
    out.u64(h + 40, s.size);
    out.u32(h + 48, fileoffs[i]!);
    out.u32(h + 52, log2(s.align));
    out.u32(h + 56, reloffs[i]!);
    out.u32(h + 60, relocWords[i]!.length / 2);
    out.u32(h + 64, s.flags);
  });
  c += segSize;
  // LC_BUILD_VERSION, so ld knows the platform without guessing
  out.u32(c, LC_BUILD_VERSION);
  out.u32(c + 4, 24);
  out.u32(c + 8, PLATFORM_MACOS);
  out.u32(c + 12, version(o.minos));
  out.u32(c + 16, version(o.sdk));
  out.u32(c + 20, 0); // ntools
  c += 24;
  // LC_SYMTAB
  out.u32(c, LC_SYMTAB);
  out.u32(c + 4, 24);
  out.u32(c + 8, symoff);
  out.u32(c + 12, ordered.length);
  out.u32(c + 16, stroff);
  out.u32(c + 20, strParts.length);
  c += 24;
  // LC_DYSYMTAB: the three symbol groups, nothing else
  out.u32(c, LC_DYSYMTAB);
  out.u32(c + 4, 80);
  out.u32(c + 8, 0);
  out.u32(c + 12, locals.length);
  out.u32(c + 16, locals.length);
  out.u32(c + 20, extdefs.length);
  out.u32(c + 24, locals.length + extdefs.length);
  out.u32(c + 28, undefs.length);

  o.sections.forEach((s, i) => {
    if (s.bytes !== null) out.bytes.set(s.bytes.subarray(0, s.size), fileoffs[i]!);
    relocWords[i]!.forEach((w, j) => out.u32(reloffs[i]! + 4 * j, w));
  });
  ordered.forEach((s, i) => {
    const e = symoff + 16 * i;
    out.u32(e, strx.get(s.name)!);
    out.u8(e + 4, s.section === 0 ? N_UNDF | N_EXT : N_SECT | (s.external ? N_EXT : 0));
    out.u8(e + 5, s.section);
    out.u16(e + 6, 0);
    out.u64(e + 8, s.section === 0 ? 0 : addrs[s.section - 1]! + s.offset);
  });
  out.bytes.set(strParts, stroff);
  return out.bytes;
}
