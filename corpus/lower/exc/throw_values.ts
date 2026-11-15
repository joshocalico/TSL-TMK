// Throwing any value (SPEC 4.5, D49): strings, numbers, booleans, null, undefined, user objects that aren't Errors, and
// Errors; caught with and without a binding, narrowed by typeof and instanceof, and reaching the caller.
class Signal {
  constructor(
    public kind: string,
    public value: number,
  ) {}
}

function thrower(k: number): number {
  switch (k) {
    case 0:
      throw "a string";
    case 1:
      throw 42.5;
    case 2:
      throw -0;
    case 3:
      throw true;
    case 4:
      throw null;
    case 5:
      throw undefined;
    case 6:
      throw new Signal("stop", 7);
    case 7:
      throw new Error("an error");
    case 8:
      throw new URIError("bad uri");
    case 9:
      throw new EvalError("bad eval");
    case 10:
      throw new ReferenceError("bad ref");
    default:
      return k;
  }
}

export function describe(k: number): string {
  try {
    return `returned ${thrower(k)}`;
  } catch (e) {
    if (typeof e === "string") return `string ${e} ${e.length}`;
    if (typeof e === "number") return `number ${e} ${1 / e}`;
    if (typeof e === "boolean") return `boolean ${e ? "yes" : "no"}`;
    if (e === null) return "null";
    if (e === undefined) return "undefined";
    if (e instanceof Signal) return `signal ${e.kind} ${e.value}`;
    if (e instanceof Error) return `error ${e.name} ${e.message}`;
    return "unknown";
  }
}

export function text(k: number): string {
  try {
    thrower(k);
    return "none";
  } catch (e) {
    return `${String(e)}|${typeof e}`;
  }
}

export function noBinding(k: number): number {
  let n = 0;
  try {
    n = thrower(k);
  } catch {
    n = -1;
  }
  return n;
}

export function loose(k: number): string {
  try {
    thrower(k);
    return "-";
  } catch (e) {
    return e == null ? "nullish" : e === null ? "null" : "value";
  }
}

export function uncaught(k: number): number {
  return thrower(k) * 2;
}

export function rethrowTwice(k: number): string {
  let path = "";
  try {
    try {
      thrower(k);
    } catch (e) {
      path += "a";
      throw e;
    } finally {
      path += "f";
    }
  } catch (e) {
    path += typeof e;
  }
  return path;
}
