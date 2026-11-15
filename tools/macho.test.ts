// The Mach-O object writer (macho.ts) and the hosted build (hosted.ts): the file's structure, and on a Mac with the
// command line tools, objects linked by the system `ld` and run, one relocation kind at a time.
//   node --test tools/macho.test.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FuncBuilder } from "../compiler/tir/build.ts";
import { canonicalize } from "../compiler/tir/ir.ts";
import * as E from "../compiler/backend-aarch64/encode.ts";
import { buildHostedObject, MACOS_MIN } from "../compiler/backend-aarch64/hosted.ts";
import {
  type MachoObject,
  type MachoReloc,
  S_ATTR_PURE_INSTRUCTIONS,
  S_ATTR_SOME_INSTRUCTIONS,
  S_REGULAR,
  S_ZEROFILL,
  writeMachoObject,
} from "../compiler/backend-aarch64/macho.ts";

const words = (ws: number[]): Uint8Array => {
  const b = new Uint8Array(ws.length * 4);
  const v = new DataView(b.buffer);
  ws.forEach((w, i) => v.setUint32(i * 4, w >>> 0, true));
  return b;
};

/** `_main` returns what it computes from `_data`; `relocs` and `data` say how. */
function object(
  code: number[],
  textRelocs: MachoReloc[],
  data: Uint8Array,
  dataRelocs: MachoReloc[] = [],
): MachoObject {
  return {
    sections: [
      {
        sectname: "__text",
        segname: "__TEXT",
        bytes: words(code),
        size: code.length * 4,
        align: 16,
        flags: S_REGULAR | S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS,
        relocs: textRelocs,
      },
      {
        sectname: "__data",
        segname: "__DATA",
        bytes: data,
        size: data.length,
        align: 16,
        flags: S_REGULAR,
        relocs: dataRelocs,
      },
      {
        sectname: "__bss",
        segname: "__DATA",
        bytes: null,
        size: 64,
        align: 16,
        flags: S_ZEROFILL,
        relocs: [],
      },
    ],
    symbols: [
      { name: "_main", section: 1, offset: 0, external: true },
      { name: "_data", section: 2, offset: 0, external: false },
      { name: "_zero", section: 3, offset: 0, external: false },
      { name: "_exit", section: 0, offset: 0, external: true },
    ],
    minos: MACOS_MIN,
    sdk: MACOS_MIN,
  };
}

const canLink =
  process.platform === "darwin" &&
  process.arch === "arm64" &&
  spawnSync("xcrun", ["--show-sdk-path"], { timeout: 30_000 }).status === 0;

/** Links and runs an object, giving its exit status and output. */
async function linkAndRun(bytes: Uint8Array): Promise<{ status: number | null; stdout: string }> {
  const { linkObject } = await import("./macho.ts");
  const dir = mkdtempSync(join(tmpdir(), "macho-test-"));
  try {
    writeFileSync(join(dir, "t.o"), bytes);
    const l = linkObject(join(dir, "t.o"), join(dir, "t"));
    assert.ok(l.ok, l.message);
    const r = spawnSync(join(dir, "t"), [], { encoding: "latin1", timeout: 20_000 });
    return { status: r.status, stdout: r.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the header, load commands and symbol order", () => {
  const data = new Uint8Array(16);
  const b = writeMachoObject(object([E.movz(false, 0, 0), E.RET], [], data));
  const v = new DataView(b.buffer);
  assert.equal(v.getUint32(0, true), 0xfeedfacf);
  assert.equal(v.getUint32(4, true), 0x0100000c); // arm64
  assert.equal(v.getUint32(12, true), 1); // MH_OBJECT
  assert.equal(v.getUint32(16, true), 4); // segment, build version, symtab, dysymtab
  assert.equal(v.getUint32(32, true), 0x19); // LC_SEGMENT_64 first
  assert.equal(v.getUint32(32 + 64, true), 3); // three sections
  // The bss section is zero fill: no file offset.
  const bss = 32 + 72 + 80 * 2;
  assert.equal(v.getUint32(bss + 48, true), 0);
  assert.equal(v.getUint32(bss + 64, true), S_ZEROFILL);
  // LC_DYSYMTAB: locals _data, _zero; then _main; then _exit.
  let c = 32 + v.getUint32(36, true) + 24;
  assert.equal(v.getUint32(c, true), 0x2); // LC_SYMTAB
  const symoff = v.getUint32(c + 8, true);
  const stroff = v.getUint32(c + 16, true);
  c += 24;
  assert.equal(v.getUint32(c, true), 0xb);
  assert.deepEqual(
    [12, 16, 20, 24, 28].map((o) => v.getUint32(c + o, true)),
    [2, 2, 1, 3, 1],
  );
  const name = (i: number): string => {
    let at = stroff + v.getUint32(symoff + 16 * i, true);
    let s = "";
    while (b[at] !== 0) s += String.fromCharCode(b[at++]!);
    return s;
  };
  assert.deepEqual([0, 1, 2, 3].map(name), ["_data", "_zero", "_main", "_exit"]);
  assert.equal(b[symoff + 16 * 3 + 4], 0x01); // N_UNDF | N_EXT
  assert.equal(b[symoff + 16 * 2 + 4], 0x0f); // N_SECT | N_EXT
});

test("an addend becomes an ARM64_RELOC_ADDEND right before what it modifies", () => {
  const b = writeMachoObject(
    object(
      [E.adrp(0, 0), E.RET],
      [{ address: 0, kind: "page21", symbol: "_data", addend: 40 }],
      new Uint8Array(64),
    ),
  );
  const v = new DataView(b.buffer);
  const text = 32 + 72;
  const reloff = v.getUint32(text + 56, true);
  assert.equal(v.getUint32(text + 60, true), 2);
  const r0 = v.getUint32(reloff + 4, true);
  const r1 = v.getUint32(reloff + 12, true);
  assert.equal(r0 >>> 28, 10); // ADDEND
  assert.equal(r0 & 0xffffff, 40);
  assert.equal(r1 >>> 28, 3); // PAGE21
  assert.equal((r1 >>> 24) & 1, 1); // pc-relative
  assert.equal((r1 >>> 27) & 1, 1); // extern
});

test("PAGE21 and PAGEOFF12 with an addend, linked and run", { skip: !canLink }, async () => {
  // _main: return the word at _data + 8
  const data = new Uint8Array(16);
  new DataView(data.buffer).setUint32(8, 42, true);
  const code = [E.adrp(0, 0), E.memImm("ldrw", 0, 0, 0), E.RET];
  const relocs: MachoReloc[] = [
    { address: 0, kind: "page21", symbol: "_data", addend: 8 },
    { address: 4, kind: "pageoff12", symbol: "_data", addend: 8 },
  ];
  const r = await linkAndRun(writeMachoObject(object(code, relocs, data)));
  assert.equal(r.status, 42);
});

test("BRANCH26 to an import, linked and run", { skip: !canLink }, async () => {
  // _main: exit(7) through libSystem
  const code = [
    E.memPair("stpx", "pre", 29, 30, E.SP, -16),
    E.arithImm("add", true, 29, E.SP, 0),
    E.movz(false, 0, 7),
    E.bl(0),
    E.RET,
  ];
  const r = await linkAndRun(
    writeMachoObject(
      object(code, [{ address: 12, kind: "branch26", symbol: "_exit" }], new Uint8Array(16)),
    ),
  );
  assert.equal(r.status, 7);
});

test(
  "SUBTRACTOR and UNSIGNED: a text address less a data address, linked and run",
  { skip: !canLink },
  async () => {
    // _data holds (_main + 4) - _data; _main returns 1 if adding _data's address back gives _main + 4.
    const data = new Uint8Array(16);
    new DataView(data.buffer).setBigInt64(0, 4n, true);
    const code = [
      E.adrp(1, 0), // x1 = &_data
      E.arithImm("add", true, 1, 1, 0),
      E.memImm("ldrx", 2, 1, 0), // x2 = the difference
      E.arithReg("add", true, 2, 2, 1), // x2 = _main + 4, if right
      E.adr(3, -12), // x3 = this instruction's address - 12 = _main + 4... at word 4: _main + 16 - 12
      E.arithReg("subs", true, 31, 2, 3),
      E.cset(false, 0, 0), // EQ
      E.RET,
    ];
    const relocs: MachoReloc[] = [
      { address: 0, kind: "page21", symbol: "_data" },
      { address: 4, kind: "pageoff12", symbol: "_data" },
    ];
    const dataRelocs: MachoReloc[] = [
      { address: 0, kind: "subtractor", symbol: "_data" },
      { address: 0, kind: "unsigned", symbol: "_main" },
    ];
    const r = await linkAndRun(writeMachoObject(object(code, relocs, data, dataRelocs)));
    assert.equal(r.status, 1);
  },
);

test(
  "a hosted object with no cases prints READY and DONE and exits 0",
  { skip: !canLink },
  async () => {
    const main = new FuncBuilder("__tmk_main", [], []);
    main.ret();
    const msg = new FuncBuilder("__rt_trap_message", ["i32"], []);
    msg.ret();
    const m = canonicalize({ sigs: [], globals: [], funcs: [], traps: [], externs: [] });
    const img = buildHostedObject({
      module: m,
      driverFuncs: [main.finish(), msg.finish()],
      driverGlobals: [],
      ramBytes: 64 << 20,
    });
    assert.deepEqual(img.imports, [
      "exit",
      "mmap",
      "mprotect",
      "sigaction",
      "sigaltstack",
      "write",
    ]);
    const r = await linkAndRun(img.bytes);
    assert.equal(r.stdout, "TMK:READY\nTMK:DONE\n");
    assert.equal(r.status, 0);
  },
);
