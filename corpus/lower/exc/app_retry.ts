// A retry loop with `finally` cleanup (SPEC 4.5, D49): an operation that fails in several ways, a policy that retries some
// and not others, a lock released in `finally` on every path, and a final error with a cause.
class TransientError extends Error {
  constructor(
    message: string,
    public attempt: number,
  ) {
    super(message);
    this.name = "TransientError";
  }
}
class FatalError extends Error {
  override name = "FatalError";
}
class GaveUp extends Error {
  constructor(
    public attempts: number,
    cause: unknown,
  ) {
    super(`gave up after ${attempts} attempts`, { cause });
    this.name = "GaveUp";
  }
}

class Lock {
  held: string[] = [];
  log: string[] = [];
  acquire(who: string): void {
    if (this.held.length > 0) throw new Error(`already held by ${this.held[0]}`);
    this.held.push(who);
    this.log.push(`+${who}`);
  }
  release(who: string): void {
    const i = this.held.indexOf(who);
    if (i < 0) throw new Error(`${who} doesn't hold it`);
    this.held.splice(i, 1);
    this.log.push(`-${who}`);
  }
}

class Service {
  calls = 0;
  constructor(public plan: string) {}
  call(): number {
    const c = this.plan.charAt(this.calls);
    this.calls++;
    if (c === "t") throw new TransientError(`timeout on call ${this.calls}`, this.calls);
    if (c === "f") throw new FatalError(`refused on call ${this.calls}`);
    if (c === "x") throw "a bare string";
    return this.calls * 10;
  }
}

function withRetry(s: Service, lock: Lock, max: number): number {
  let last: unknown = undefined;
  for (let attempt = 1; attempt <= max; attempt++) {
    lock.acquire(`a${attempt}`);
    try {
      return s.call();
    } catch (e) {
      last = e;
      if (e instanceof TransientError) continue;
      throw e;
    } finally {
      lock.release(`a${attempt}`);
    }
  }
  throw new GaveUp(max, last);
}

export function attempt(plan: string, max: number): string {
  const s = new Service(plan);
  const lock = new Lock();
  let r: string;
  try {
    r = `ok ${withRetry(s, lock, max)}`;
  } catch (e) {
    if (e instanceof GaveUp) {
      const c = e.cause;
      r = `gave up (${e.attempts}): ${c instanceof Error ? c.message : String(c)}`;
    } else if (e instanceof FatalError) r = `fatal: ${e.message}`;
    else r = `other: ${String(e)}`;
  }
  return `${r} calls=${s.calls} held=${lock.held.length} ${lock.log.join("")}`;
}

export function direct(plan: string, max: number): number {
  return withRetry(new Service(plan), new Lock(), max);
}

export function batch(n: number): string {
  const plans = ["", "t", "tt", "ttt", "f", "tf", "x", "ttttt"];
  let ok = 0;
  let failed = 0;
  let calls = 0;
  for (let i = 0; i < n; i++) {
    const s = new Service(plans[i % plans.length]!);
    const lock = new Lock();
    try {
      withRetry(s, lock, 3);
      ok++;
    } catch {
      failed++;
    }
    calls += s.calls;
    if (lock.held.length !== 0) return "leaked a lock";
  }
  return `${ok} ${failed} ${calls}`;
}
