// file: ex-memory.ts
import { arenaOver, toU32, type bool, type Result, type u32, type u64, type usize } from "@tsl/core";
import type { Heap } from "./ex-heap.ts";
import { Slab } from "./ex-slab.ts";

export enum TimerState { Idle = 0, Armed = 1, Fired = 2 }

export class Domain {
  constructor(public id: u32) {}
}

export class Timer {
  owner: Domain | null = null;
  state: TimerState = TimerState.Armed;
  constructor(public deadline: u64) {}

  expired(now: u64): bool {
    return now >= this.deadline;
  }
}

// Compiles to a small integer, and may be stored.
export type TimerError = "out-of-memory" | "already-expired";

export class Timers {
  private all: Slab<Timer>;

  constructor(heap: Heap) {
    this.all = new Slab<Timer>(heap, 64);
  }

  // A value union: no identity, no address, and the tag stays in registers.
  arm(now: u64, deadline: u64, owner: Domain): Result<Timer, TimerError> {
    if (deadline <= now) return { ok: false, error: "already-expired" };
    const timer = this.all.add(new Timer(deadline));
    if (timer === null) return { ok: false, error: "out-of-memory" };
    timer.owner = owner; // stores owner, so callers can't pass a stack object here
    return { ok: true, value: timer };
  }

  // A capturing closure is fine as long as it's only passed down.
  expire(now: u64, onFire: (t: Timer) => void): void {
    this.all.forEach((t) => {
      if (t.expired(now)) {
        t.state = TimerState.Fired;
        onFire(t);
        this.all.remove(t);
      }
    });
  }

  countExpired(now: u64): usize {
    let fired = 0;
    this.expire(now, () => {
      fired++;
    });
    return fired;
  }
}

type Pair = { readonly lo: u32; readonly hi: u32 };

export function split(x: u32): Pair {
  return { lo: x & 0xffff, hi: x >>> 16 };
}

// A stack object: gone at return, and can't be stored or returned.
export function ownerIdOfLocal(id: u32): u32 {
  const d = new Domain(id);
  return d.id;
}

export function totalLen(scratch: Uint8Array, n: usize): usize {
  using a = arenaOver(scratch);
  const lens = a.u32s(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    lens[i] = toU32(i) & 0xff; // bitwise ops need 32 bits or fewer, so usize converts first
    total += lens[i]!; // u32 widens to usize
  }
  return total;
}
