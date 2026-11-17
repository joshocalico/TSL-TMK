// R20: the runtime's copy and fill (`__rt_memmove`, `__rt_memset`) as TSL reaches them, each checked against a byte loop.
// A byte array's `set` from a run of itself is a copy over itself, a destination below its source (copied down) or above it
// (copied up), of every length to 40 and every distance to 9 either way; `fill` is a fill of every length to 24 at every
// start to 8. Each gives how many bytes differ from what a byte at a time gives (0), so a step of the last bytes lost,
// doubled or taken the wrong way shows.
import { toU32, wrapU8, type u32, type usize } from "@tsl/core";

/** What differs, counted (a class: the native elaborator's, which has typed arrays' `set` and `fill`). */
class Tally {
  bad: u32 = 0;
}

function pattern(b: Uint8Array, seed: u32): void {
  for (let i: usize = 0; i < b.length; i++) b[i] = wrapU8(toU32(i) * 37 + seed * 11 + 5);
}

/** Copies over itself, both ways, in `buf`, against the same done a byte at a time through `tmp` in `want`. */
export function moves(buf: Uint8Array, want: Uint8Array, tmp: Uint8Array): u32 {
  const t = new Tally();
  for (let len: usize = 0; len <= 40; len++) {
    for (let dist: usize = 1; dist <= 9; dist++) {
      for (let up: usize = 0; up < 2; up++) {
        const src: usize = up === 1 ? 3 : 3 + dist;
        const dst: usize = up === 1 ? 3 + dist : 3;
        pattern(buf, toU32(len + dist));
        pattern(want, toU32(len + dist));
        for (let i: usize = 0; i < len; i++) tmp[i] = want[src + i]!;
        for (let i: usize = 0; i < len; i++) want[dst + i] = tmp[i]!;
        buf.set(buf.subarray(src, src + len), dst);
        for (let i: usize = 0; i < buf.length; i++) if (buf[i]! !== want[i]!) t.bad++;
      }
    }
  }
  return t.bad;
}

/** Fills of every length and start, against a byte at a time. */
export function fills(buf: Uint8Array, want: Uint8Array): u32 {
  const t = new Tally();
  for (let len: usize = 0; len <= 24; len++) {
    for (let at: usize = 0; at <= 8; at++) {
      pattern(buf, toU32(len * 3 + at));
      pattern(want, toU32(len * 3 + at));
      const v = wrapU8(toU32(len) * 29 + toU32(at) + 1);
      for (let i: usize = 0; i < len; i++) want[at + i] = v;
      buf.fill(v, at, at + len);
      for (let i: usize = 0; i < buf.length; i++) if (buf[i]! !== want[i]!) t.bad++;
    }
  }
  return t.bad;
}
