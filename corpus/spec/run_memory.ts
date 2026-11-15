// Runs ex-memory.ts as the spec has it, on a static-array page source.
import { type bool, type u32, type u64, type usize } from "@tsl/core";
import { Heap } from "./ex-heap.ts";
import { Domain, Timer, Timers, TimerState, ownerIdOfLocal, split, totalLen } from "./ex-memory.ts";
import { Slab } from "./ex-slab.ts";
import { pages } from "./pages.ts";

const heap = new Heap(pages);
const domains = new Slab<Domain>(heap, 4);

function owner(): Domain {
  return domains.add(new Domain(7))!;
}

export function arm(): u32 {
  const wheel = new Timers(heap);
  const o = owner();
  const a = wheel.arm(0n, 10n, o);
  const b = wheel.arm(0n, 50n, o);
  const c = wheel.arm(5n, 5n, o);
  let out: u32 = 0;
  if (a.ok) out += a.value.owner!.id;
  if (b.ok && b.value.deadline === 50n) out += 10;
  if (!c.ok && c.error === "already-expired") out += 100;
  return out;
}

export function fields(): bool {
  const wheel = new Timers(heap);
  const o = owner();
  const a = wheel.arm(0n, 10n, o);
  if (!a.ok) return false;
  const t: Timer = a.value;
  return (
    t.deadline === 10n &&
    t.state === TimerState.Armed &&
    t.owner === o &&
    !t.expired(9n) &&
    t.expired(10n)
  );
}

export function expire(): u64 {
  const wheel = new Timers(heap);
  const o = owner();
  wheel.arm(0n, 10n, o);
  wheel.arm(0n, 50n, o);
  let seen: u64 = 0n;
  wheel.expire(20n, (t) => {
    seen += t.deadline;
  });
  return seen * 1000n + (wheel.countExpired(100n) === 1 ? 1n : 0n);
}

export function stale(): u64 {
  const wheel = new Timers(heap);
  const a = wheel.arm(0n, 10n, owner());
  wheel.expire(20n, (_t) => {});
  if (!a.ok) return 0n;
  return a.value.deadline;
}

export function record(x: u32): u32 {
  const p = split(x);
  return p.lo + p.hi * 2;
}

export function stackObject(id: u32): u32 {
  return ownerIdOfLocal(id);
}

export function arena(buf: Uint8Array, n: usize): usize {
  return totalLen(buf, n);
}
