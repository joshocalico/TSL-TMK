// An event system with handlers overriding a base (SPEC 4.5, D49, D50): handlers registered by event name in a Map, a base
// class whose subclasses override handle() and filter(), handlers that throw, errors collected per dispatch, and a
// handler that stops propagation by throwing a signal.
class Event {
  constructor(
    public name: string,
    public payload: number,
  ) {}
}

class StopPropagation {
  constructor(public by: string) {}
}

abstract class Handler {
  calls = 0;
  constructor(public id: string) {}
  filter(_e: Event): boolean {
    return true;
  }
  abstract handle(e: Event): string;
  run(e: Event): string | null {
    if (!this.filter(e)) return null;
    this.calls++;
    return this.handle(e);
  }
}

class Logger extends Handler {
  handle(e: Event): string {
    return `${this.id} saw ${e.name}:${e.payload}`;
  }
}

class Threshold extends Handler {
  constructor(
    id: string,
    public limit: number,
  ) {
    super(id);
  }
  override filter(e: Event): boolean {
    return e.payload >= 0;
  }
  handle(e: Event): string {
    if (e.payload > this.limit) throw new RangeError(`${this.id}: ${e.payload} over ${this.limit}`);
    return `${this.id} ok`;
  }
}

class Stopper extends Logger {
  override handle(e: Event): string {
    if (e.payload === 0) throw new StopPropagation(this.id);
    return super.handle(e) + " (and let it through)";
  }
}

class Bus {
  handlers = new Map<string, Handler[]>();
  errors: string[] = [];
  on(name: string, h: Handler): void {
    const list = this.handlers.get(name);
    if (list === undefined) this.handlers.set(name, [h]);
    else list.push(h);
  }
  emit(e: Event): string[] {
    const out: string[] = [];
    const list = this.handlers.get(e.name) ?? [];
    try {
      list.forEach((h) => {
        try {
          const r = h.run(e);
          if (r !== null) out.push(r);
        } catch (err) {
          if (err instanceof StopPropagation) throw err;
          this.errors.push(err instanceof Error ? `${err.name} in ${h.id}: ${err.message}` : "?");
        }
      });
    } catch (err) {
      if (err instanceof StopPropagation) out.push(`stopped by ${err.by}`);
      else throw err;
    }
    return out;
  }
}

export function scenario(payloads: number[]): string {
  const bus = new Bus();
  const a = new Logger("log");
  const t = new Threshold("thr", 10);
  const s = new Stopper("stop");
  bus.on("tick", a);
  bus.on("tick", s);
  bus.on("tick", t);
  bus.on("tock", t);
  const lines: string[] = [];
  for (const p of payloads) {
    for (const name of ["tick", "tock", "none"]) {
      const r = bus.emit(new Event(name, p));
      if (r.length > 0) lines.push(`${name}(${p}): ${r.join("; ")}`);
    }
  }
  const counts = [...bus.handlers.values()]
    .map((hs) => hs.map((h) => `${h.id}=${h.calls}`).join(","))
    .join(" ");
  return `${lines.join("\n")}\nerrors: ${bus.errors.join(" | ")}\ncalls: ${counts}`;
}
