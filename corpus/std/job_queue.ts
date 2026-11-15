// A job queue with priorities and dependencies, in `strict`: objects in a Slab, references in a Vec and a Map (SPEC 3.5).
import { toU32, u32, type bool, type usize } from "@tsl/core";
import { ExactMap, ref, Slab, Vec } from "@tsl/std";

class Job {
  waitingOn = new Vec(u32);
  done: bool = false;
  constructor(
    public id: u32,
    public priority: u32,
  ) {}
}

class Queue {
  private jobs = new Slab<Job>();
  private byId = new ExactMap(u32, ref<Job>());
  private pending = new Vec(ref<Job>());

  submit(id: u32, priority: u32): Job {
    const j = this.jobs.add(new Job(id, priority));
    this.byId.set(id, j);
    this.pending.push(j);
    return j;
  }

  private ready(j: Job): bool {
    for (let i: usize = 0; i < j.waitingOn.length; i++) {
      if (!this.byId.get(j.waitingOn.get(i)).done) return false;
    }
    return true;
  }

  /** The highest-priority job with nothing left to wait for, taken off the queue, or 0 with none. */
  runNext(): u32 {
    let best: usize = this.pending.length;
    for (let i: usize = 0; i < this.pending.length; i++) {
      const j = this.pending.get(i);
      if (!this.ready(j)) continue;
      if (best === this.pending.length || j.priority > this.pending.get(best).priority) best = i;
    }
    if (best === this.pending.length) return 0;
    const j = this.pending.removeAt(best);
    j.done = true;
    return j.id;
  }

  get left(): usize {
    return this.pending.length;
  }

  forget(id: u32): void {
    const j = this.byId.get(id);
    this.byId.delete(id);
    j.waitingOn.free();
    this.jobs.remove(j);
  }

  free(): void {
    this.jobs.forEach((j) => {
      j.waitingOn.free();
    });
    this.byId.free();
    this.pending.free();
  }
}

/** Runs n jobs, each after the one three before it, with priorities out of order. The digest is the order they ran. */
export function runAll(n: u32): u32 {
  const q = new Queue();
  for (let i: u32 = 1; i <= n; i++) {
    const j = q.submit(i, (i * 7919) % 101);
    if (i > 3) j.waitingOn.push(i - 3);
  }
  let digest: u32 = 0;
  for (;;) {
    const id: u32 = q.runNext();
    if (id === 0) break;
    digest = ((Math.imul(digest, 31) >>> 0) + id) >>> 0;
  }
  const left = toU32(q.left);
  q.free();
  return (digest + left) >>> 0;
}

/** A cycle of dependencies never runs, and it's not an error: they stay on the queue. */
export function deadlocked(): u32 {
  const q = new Queue();
  q.submit(1, 1).waitingOn.push(2);
  q.submit(2, 1).waitingOn.push(1);
  q.submit(3, 1);
  const first = q.runNext();
  const second = q.runNext();
  const left = toU32(q.left);
  q.free();
  return first === 3 && second === 0 ? 300 + left : 0;
}

/** A job that's been forgotten is gone from the Map, and asking for it traps 2. */
export function forgotten(): u32 {
  const q = new Queue();
  q.submit(1, 1);
  q.submit(2, 1).waitingOn.push(1);
  q.runNext();
  q.forget(1);
  return q.runNext();
}

const shared = new Queue();

export function aStaticQueue(id: u32): u32 {
  shared.submit(id, id);
  return toU32(shared.left);
}

export function takeFromStaticQueue(): u32 {
  return shared.runNext();
}
