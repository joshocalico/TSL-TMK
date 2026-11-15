// The encoder cross-check (SPEC M5): llvm-objdump agrees with this backend's own decoder on every
// instruction in an image, and llvm-mc reassembling llvm-objdump's text gives the same bytes back.
// Those tools are for checking only, and are never in the path that builds an image.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "../compiler/backend-aarch64/decode.ts";

const LLVM = "/opt/homebrew/opt/llvm/bin";

export interface CheckStats {
  images: number;
  instructions: number;
  uniqueWords: number;
  uniqueTexts: number;
  decoderMismatches: string[];
  mcMismatches: string[];
  unknown: string[];
  skipped: string | null;
}

/** The least ELF that llvm-objdump will read: one executable .text at address 0. */
function wrapElf(code: Uint8Array): Uint8Array {
  const shstr = new TextEncoder().encode("\0.text\0.shstrtab\0");
  const textOff = 0x40;
  const strOff = textOff + code.length;
  const shOff = (strOff + shstr.length + 7) & ~7;
  const out = new Uint8Array(shOff + 3 * 64);
  const v = new DataView(out.buffer);
  out.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  v.setUint16(16, 1, true); // ET_REL
  v.setUint16(18, 183, true); // EM_AARCH64
  v.setUint32(20, 1, true);
  v.setBigUint64(40, BigInt(shOff), true);
  v.setUint16(52, 64, true);
  v.setUint16(58, 64, true);
  v.setUint16(60, 3, true);
  v.setUint16(62, 2, true);
  out.set(code, textOff);
  out.set(shstr, strOff);
  const sec = (
    i: number,
    name: number,
    type: number,
    flags: number,
    off: number,
    size: number,
  ): void => {
    const at = shOff + i * 64;
    v.setUint32(at, name, true);
    v.setUint32(at + 4, type, true);
    v.setBigUint64(at + 8, BigInt(flags), true);
    v.setBigUint64(at + 24, BigInt(off), true);
    v.setBigUint64(at + 32, BigInt(size), true);
    v.setBigUint64(at + 48, 4n, true);
  };
  sec(1, 1, 1, 6, textOff, code.length); // .text, PROGBITS, AX
  sec(2, 7, 3, 0, strOff, shstr.length); // .shstrtab
  return out;
}

const normal = (t: string): string =>
  t
    .replace(/\s*\/\/.*$/, "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*<[^>]*>$/, "");

/** PC-relative targets as offsets, the form llvm-mc reads back with no labels. */
function toAssembler(text: string, pc: number): string {
  const m = /^(b|bl|b\.\w+|cbz|cbnz|adr|adrp|ldr) (?:([\w]+), )?(0x[0-9a-f]+)$/.exec(text);
  if (m === null) return text;
  const target = Number(m[3]);
  const reg = m[2] !== undefined ? `${m[2]}, ` : "";
  const off = m[1] === "adrp" ? target - Math.floor(pc / 4096) * 4096 : target - pc;
  return `${m[1]!} ${reg}#${off}`;
}

export function checkImages(
  images: {
    name: string;
    bytes: Uint8Array;
    ranges: { name: string; from: number; to: number }[];
  }[],
): CheckStats {
  const stats: CheckStats = {
    images: images.length,
    instructions: 0,
    uniqueWords: 0,
    uniqueTexts: 0,
    decoderMismatches: [],
    mcMismatches: [],
    unknown: [],
    skipped: null,
  };
  const dir = mkdtempSync(join(tmpdir(), "tmk-enc-"));
  // One entry per word and address class: assembler text to its expected bytes.
  const wanted = new Map<string, number>();
  const seenWords = new Set<number>();
  try {
    images.forEach((img, n) => {
      const end = Math.max(...img.ranges.map((r) => r.to));
      const elf = join(dir, `i${n}.o`);
      writeFileSync(elf, wrapElf(img.bytes.subarray(0, end)));
      const r = spawnSync(join(LLVM, "llvm-objdump"), ["-d", "--no-show-raw-insn", elf], {
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 1 << 28,
      });
      if (r.error !== undefined || r.status !== 0) {
        stats.skipped = `llvm-objdump failed: ${r.error?.message ?? r.stderr}`;
        return;
      }
      const view = new DataView(img.bytes.buffer, img.bytes.byteOffset, img.bytes.byteLength);
      const llvmAt = new Map<number, string>();
      for (const line of r.stdout.split("\n")) {
        const m = /^\s*([0-9a-f]+):\s+(.*)$/.exec(line);
        if (m !== null) llvmAt.set(Number.parseInt(m[1]!, 16), normal(m[2]!));
      }
      for (const range of img.ranges) {
        for (let pc = range.from; pc < range.to; pc += 4) {
          const word = view.getUint32(pc, true);
          stats.instructions++;
          seenWords.add(word);
          const theirs = llvmAt.get(pc);
          const mine = decode(word, pc);
          if (
            theirs === undefined ||
            theirs.startsWith("<unknown>") ||
            theirs.startsWith(".word")
          ) {
            if (stats.unknown.length < 40) {
              stats.unknown.push(
                `${img.name} ${range.name}+${pc - range.from}: ${word.toString(16)} llvm: ${String(theirs)}`,
              );
            }
            continue;
          }
          if (mine !== theirs) {
            if (stats.decoderMismatches.length < 60) {
              stats.decoderMismatches.push(
                `${word.toString(16).padStart(8, "0")} at ${pc.toString(16)} in ${range.name}: own "${String(mine)}", llvm "${theirs}"`,
              );
            }
          }
          const asm = toAssembler(theirs, pc);
          wanted.set(asm, word);
        }
      }
    });
    stats.uniqueWords = seenWords.size;
    stats.uniqueTexts = wanted.size;
    // llvm-mc on the whole set, one encoding back per line.
    const list = [...wanted.entries()];
    const src = join(dir, "all.s");
    writeFileSync(src, `${list.map(([t]) => t).join("\n")}\n`);
    const mc = spawnSync(
      join(LLVM, "llvm-mc"),
      ["--triple=aarch64", "--show-encoding", "--assemble", "--mattr=+fullfp16", src],
      { encoding: "utf8", timeout: 120_000, maxBuffer: 1 << 28 },
    );
    if (mc.error !== undefined || mc.status !== 0) {
      stats.mcMismatches.push(`llvm-mc failed: ${mc.error?.message ?? mc.stderr.slice(0, 1500)}`);
      return stats;
    }
    const encodings: number[] = [];
    for (const line of mc.stdout.split("\n")) {
      const m = /encoding: \[0x([0-9a-f]+),0x([0-9a-f]+),0x([0-9a-f]+),0x([0-9a-f]+)\]/.exec(line);
      if (m !== null) {
        encodings.push(
          Number.parseInt(m[1]!, 16) +
            Number.parseInt(m[2]!, 16) * 256 +
            Number.parseInt(m[3]!, 16) * 65536 +
            Number.parseInt(m[4]!, 16) * 16777216,
        );
      }
    }
    if (encodings.length !== list.length) {
      stats.mcMismatches.push(
        `llvm-mc gave ${encodings.length} encodings for ${list.length} instructions`,
      );
      return stats;
    }
    list.forEach(([t, w], i) => {
      if (encodings[i] !== w && stats.mcMismatches.length < 60) {
        stats.mcMismatches.push(
          `"${t}": emitted ${w.toString(16)}, llvm-mc ${encodings[i]!.toString(16)}`,
        );
      }
    });
    return stats;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
