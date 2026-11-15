// In a memory mode, a derived field a base constructor reaches before it's set: JS reads undefined, which `number`
// can't hold here, so this is a fallback with its root cause, never a silent 0 (D50).
// expect-fallback-mem: early field-before-init
class Base {
  constructor() {
    this.hook();
  }
  hook(): number {
    return 0;
  }
}

class Early extends Base {
  n: number = 3;
  override hook(): number {
    return this.n + 1;
  }
}

export function early(): number {
  return new Early().hook();
}

// `+=` reads before it writes: still undefined in JS, so still a fallback. A plain `this.n = 9` only writes, and lowers
// (corpus/lower/exc/cast_unknown.ts, writeBeforeInit).
// expect-fallback-mem: bumped field-before-init
class Counter {
  constructor() {
    this.start();
  }
  start(): void {}
}

class Bumped extends Counter {
  n: number = 3;
  override start(): void {
    this.n += 1;
  }
}

export function bumped(): number {
  return new Bumped().n;
}
