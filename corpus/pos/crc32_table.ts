import { type bool, type u32, type usize } from "@tsl/core";

const TABLE = new Uint32Array(256);
let ready: bool = false; // no run-time module init, so the table fills on first use

function init(): void {
  for (let n: u32 = 0; n < 256; n++) {
    let c = n;
    for (let k: u32 = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    }
    TABLE[n] = c;
  }
  ready = true;
}

export function crc32(data: Uint8Array, seed: u32): u32 {
  if (!ready) init();
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i: usize = 0; i < data.length; i++) {
    const index: usize = (crc ^ data[i]!) & 0xff;
    crc = (TABLE[index]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
