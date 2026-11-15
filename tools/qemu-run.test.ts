// The RAM channel's reader, with no guest: what it must accept, and everything it must refuse (SPEC 8.2).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseSerial } from "./native-exec.ts";
import { channelOf, channelSum, readChannel } from "./qemu-run.ts";

const layout = { ramBytes: 4096, offset: 8192, bytes: 65536 };

function withRam(text: Buffer, f: (ram: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "tmk-channel-"));
  try {
    const ram = join(dir, "ram.bin");
    const file = Buffer.alloc(layout.offset + layout.bytes);
    text.copy(file, layout.offset);
    writeFileSync(ram, file);
    f(ram);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const TEXT = Buffer.from(
  "TMK:C 0 R 0000000000000001 \nTMK:M 0000000040400010 0102\nTMK:M 0000000040401ffe 03040506\nTMK:E 0\nTMK:C 1 T 14 out\nTMK:E 1\n",
  "latin1",
);
const trailerFor = (t: Buffer, n = t.length): string => {
  const padded = Buffer.alloc(Math.ceil(n / 4) * 4 + 4);
  t.copy(padded, 0, 0, n);
  return `TMK:BULK ${n} ${channelSum(padded, n).toString(16).padStart(16, "0")}`;
};

test("reads back what the trailer describes, and memory lines stay bytes", () => {
  withRam(TEXT, (ram) => {
    const r = readChannel(ram, layout, ["TMK:READY", trailerFor(TEXT), "TMK:DONE"]);
    assert.equal(r.problem, null);
    assert.equal(r.text.length, TEXT.length);
    assert.equal(r.lines.filter((l) => l.startsWith("TMK:MR ")).length, 1);
    assert.equal(r.lines.at(-1), "TMK:E 1");
  });
});

test("a changed byte, a short count, a long count and no trailer are all refused", () => {
  withRam(TEXT, (ram) => {
    const wrongSum = trailerFor(Buffer.from(TEXT).fill(65, 0, 1));
    assert.match(readChannel(ram, layout, [wrongSum, "TMK:DONE"]).problem ?? "", /checksum/);
    const short = trailerFor(TEXT, TEXT.length - 8);
    assert.match(
      readChannel(ram, layout, [short, "TMK:DONE"]).problem ?? "",
      /more in it|checksum/,
    );
    assert.match(
      readChannel(ram, layout, ["TMK:BULK 999999 0", "TMK:DONE"]).problem ?? "",
      /past the channel/,
    );
    assert.match(readChannel(ram, layout, ["TMK:DONE"]).problem ?? "", /no TMK:BULK/);
  });
});

test("with no trailer and no DONE, what's there up to the first zero is what the guest got through", () => {
  withRam(TEXT.subarray(0, 40), (ram) => {
    const r = readChannel(ram, layout, ["TMK:READY", "TMK:FATAL exception"]);
    assert.equal(r.problem, null);
    assert.equal(r.text.length, 40);
  });
});

test("a case's memory lines stay with that case", () => {
  withRam(TEXT, (ram) => {
    const r = readChannel(ram, layout, [trailerFor(TEXT), "TMK:DONE"]);
    assert.equal(channelOf(r.lines), undefined); // qemuRun registers it, with the lines it returns
    const parsed = parseSerial(r.lines);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0]!.memoryRanges.length, 1);
    assert.equal(parsed[1]!.memoryRanges.length, 0);
    assert.equal(parsed[1]!.trap?.code, 14);
    assert.equal(parsed[1]!.finished, true);
  });
});
