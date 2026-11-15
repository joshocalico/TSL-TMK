// Casts of a caught `unknown`, `Number()` of an `unknown`, and a base constructor writing a field a subclass declares (D49,
// D50): the lines ordinary code is made of. `(e as Error).message` is a narrowing with the class id checked, so a lie traps
// 17 (corpus/lower/rc-only/cast_lie.ts), and here every cast tells the truth, as V8 can be compared with then.
class AppError extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}

function raise(kind: number): void {
  if (kind === 0) throw new Error("plain");
  if (kind === 1) throw new TypeError("typed");
  if (kind === 2) throw new RangeError("ranged", { cause: new Error("inner") });
  if (kind === 3) throw new AppError("app", 42);
  if (kind === 4) throw new Error("outer", { cause: new AppError("deep", 7) });
}

export function messageOf(kind: number): string {
  try {
    raise(kind);
    return "none";
  } catch (e) {
    const err = e as Error;
    return `${(e as Error).message}|${err.name}|${String((e as Error).cause)}`;
  }
}

export function causeMessage(kind: number): string {
  try {
    raise(kind);
    return "none";
  } catch (e) {
    const c = (e as Error).cause;
    if (c === undefined) return "no cause";
    return (c as Error).message + (c instanceof AppError ? `:${(c as AppError).code}` : "");
  }
}

export function codeOf(kind: number): number {
  try {
    raise(kind);
    return -1;
  } catch (e) {
    if (e instanceof AppError) return (e as AppError).code * 2;
    return (e as Error).message.length;
  }
}

export function primitiveCasts(k: number): string {
  try {
    if (k === 0) throw "a string";
    if (k === 1) throw 41;
    throw true;
  } catch (e) {
    if (k === 0) return (e as string).toUpperCase();
    if (k === 1) return String((e as number) + 1);
    return String(!(e as boolean));
  }
}

class Point {
  x = 1;
  y = 2;
}

export function numberOf(k: number): number {
  let y: unknown = undefined;
  if (k === 0) y = 12.5;
  else if (k === 1) y = "12";
  else if (k === 2) y = " 3.5 ";
  else if (k === 3) y = "abc";
  else if (k === 4) y = "";
  else if (k === 5) y = true;
  else if (k === 6) y = false;
  else if (k === 7) y = null;
  else if (k === 8) y = new Error("7");
  else if (k === 9) y = new Point();
  else if (k === 10) y = -0;
  else if (k === 11) y = "0x1f";
  return Number(y);
}

export function numberOfCaught(kind: number): number {
  try {
    if (kind === 0) throw 5;
    if (kind === 1) throw "6.25";
    if (kind === 2) throw null;
    throw new AppError("x", 1);
  } catch (e) {
    return Number(e);
  }
}

// A base constructor reaching an override that only writes a field the subclass declares: JS writes it, then the subclass's
// initialiser overwrites it.
class Base {
  constructor() {
    this.init();
  }
  init(): void {}
}

class Derived extends Base {
  seen = -1;
  label: string = "derived";
  items: number[] = [];
  override init(): void {
    this.seen = 9;
    this.label = "early";
    this.items = [1, 2, 3];
  }
}

export function writeBeforeInit(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    const d = new Derived();
    out += `${d.seen} ${d.label} ${d.items.length};`;
  }
  return out;
}

// `boolean` is `false | true` to the checker, and an `unknown` narrowed to it is the box's value, not the box's address:
// String(false) was "true" before this was right.
export function textOfBool(k: number): string {
  let y: unknown = k === 0;
  if (k === 2) y = "s";
  return `${String(y)} ${typeof y === "boolean" && !y ? "no" : "yes"}`;
}
