// Exceptions and the Error family (SPEC 3.10, 4.5, D49, D50), in ordinary TS, lowered by down.ts into the module that reaches
// them. `Error` and its standard subclasses are these classes: a program's `extends Error` extends TmkError, and `new
// RangeError(m)` makes a TmkRangeError. Each is a class like any other, so its counts, descriptors and collector barriers are
// the compiler's. JS keeps `name` on the prototype: here it's a field set by the constructor, which nothing can tell apart
// without reflection, and a subclass's own `name` overwrites it after `super()` as JS's own property would shadow it.
//
// An `unknown` value is one pointer: null for `undefined`, a class instance as itself, and anything else in a box below.
import { __dyn_class_name } from "./intrinsics.ts";

export interface TmkErrorOptions {
  cause?: unknown;
}

export class TmkError {
  message: string;
  name: string;
  cause: unknown;
  constructor(message?: string, options?: TmkErrorOptions) {
    this.name = "Error";
    this.message = message === undefined ? "" : message;
    this.cause = options === undefined ? undefined : options.cause;
  }
  toString(): string {
    const n = this.name;
    const m = this.message;
    if (n === "") return m;
    if (m === "") return n;
    return n + ": " + m;
  }
}

export class TmkTypeError extends TmkError {
  constructor(message?: string, options?: TmkErrorOptions) {
    super(message, options);
    this.name = "TypeError";
  }
}

export class TmkRangeError extends TmkError {
  constructor(message?: string, options?: TmkErrorOptions) {
    super(message, options);
    this.name = "RangeError";
  }
}

export class TmkSyntaxError extends TmkError {
  constructor(message?: string, options?: TmkErrorOptions) {
    super(message, options);
    this.name = "SyntaxError";
  }
}

export class TmkReferenceError extends TmkError {
  constructor(message?: string, options?: TmkErrorOptions) {
    super(message, options);
    this.name = "ReferenceError";
  }
}

export class TmkEvalError extends TmkError {
  constructor(message?: string, options?: TmkErrorOptions) {
    super(message, options);
    this.name = "EvalError";
  }
}

export class TmkURIError extends TmkError {
  constructor(message?: string, options?: TmkErrorOptions) {
    super(message, options);
    this.name = "URIError";
  }
}

/** What `using` throws when a disposal throws while another exception is on its way out (ES2026, 3.10). */
export class TmkSuppressedError extends TmkError {
  error: unknown;
  suppressed: unknown;
  constructor(error: unknown, suppressed: unknown, message?: string) {
    super(message);
    this.name = "SuppressedError";
    this.error = error;
    this.suppressed = suppressed;
  }
}

// --- boxes: a primitive as an `unknown`

export class TmkBoxNum {
  v: number;
  constructor(v: number) {
    this.v = v;
  }
}

export class TmkBoxStr {
  v: string;
  constructor(v: string) {
    this.v = v;
  }
}

export class TmkBoxBool {
  v: boolean;
  constructor(v: boolean) {
    this.v = v;
  }
}

export class TmkBoxNull {
  n = 0;
}

// --- text

/** `String(x)` of an `unknown`. A class's own `toString` is called, as JS would call it. */
export function tmkDynStr(e: unknown): string {
  if (e === undefined) return "undefined";
  if (e === null) return "null";
  if (typeof e === "string") return e;
  if (typeof e === "number") return String(e);
  if (typeof e === "boolean") return e ? "true" : "false";
  if (e instanceof Error) return e.toString();
  return "[object Object]";
}

function hex4(c: number): string {
  const d = "0123456789abcdef";
  return (
    d.charAt((c >> 12) & 15) + d.charAt((c >> 8) & 15) + d.charAt((c >> 4) & 15) + d.charAt(c & 15)
  );
}

function quote(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 34) out += '\\"';
    else if (c === 92) out += "\\\\";
    else if (c < 32) out += "\\u" + hex4(c);
    else out += s.charAt(i);
  }
  return out + '"';
}

/**
 * A thrown value as JSON, for a native caller that took it (SPEC 4.5, D36): what a JS caller would see of it, its
 * constructor, `name`, `message` and `cause`, and a SuppressedError's two parts.
 */
export function tmkExcDescribe(e: unknown): string {
  if (e === undefined) return '{"u":1}';
  if (e === null) return '{"z":1}';
  if (typeof e === "string") return '{"s":' + quote(e) + "}";
  if (typeof e === "number") return '{"n":"' + (e === 0 && 1 / e < 0 ? "-0" : String(e)) + '"}';
  if (typeof e === "boolean") return e ? '{"b":true}' : '{"b":false}';
  if (e instanceof Error) {
    let out =
      '{"e":' +
      quote(__dyn_class_name(e)) +
      ',"name":' +
      quote(e.name) +
      ',"message":' +
      quote(e.message);
    if (e.cause !== undefined) out += ',"cause":' + tmkExcDescribe(e.cause);
    if (e instanceof SuppressedError) {
      out +=
        ',"error":' + tmkExcDescribe(e.error) + ',"suppressed":' + tmkExcDescribe(e.suppressed);
    }
    return out + "}";
  }
  return '{"o":' + quote(__dyn_class_name(e)) + "}";
}

/**
 * `Number(x)` of an `unknown`: JS's ToNumber. An object's valueOf gives itself, and its text (an Error's included) isn't a
 * number, so it's NaN; down.ts keeps a fallback where a class that can be here has a valueOf or toString of its own.
 */
export function tmkDynNum(e: unknown): number {
  if (e === undefined) return NaN;
  if (e === null) return 0;
  if (typeof e === "number") return e;
  if (typeof e === "string") return Number(e);
  if (typeof e === "boolean") return e ? 1 : 0;
  return NaN;
}

/**
 * JS's ToBoolean of an `unknown`, for `if (e)`, `!e`, `e && x` and `Boolean(e)`: undefined, null, false, +0, -0, NaN
 * and "" are falsy, and everything else, an object of any class included, is truthy. A box is an object, but what it
 * stands for is the primitive inside it.
 */
export function tmkDynTruthy(e: unknown): boolean {
  if (e === undefined || e === null) return false;
  if (typeof e === "boolean") return e;
  if (typeof e === "number") return e !== 0 && e === e;
  if (typeof e === "string") return e.length !== 0;
  return true;
}

/** The same in a module with no run-time strings, where nothing can have put a string in a box. */
export function tmkDynTruthyNoStr(e: unknown): boolean {
  if (e === undefined || e === null) return false;
  if (typeof e === "boolean") return e;
  if (typeof e === "number") return e !== 0 && e === e;
  return true;
}

/** `typeof x` of an `unknown`, as a value. */
export function tmkTypeof(e: unknown): string {
  if (e === undefined) return "undefined";
  if (typeof e === "string") return "string";
  if (typeof e === "number") return "number";
  if (typeof e === "boolean") return "boolean";
  return "object";
}

/** What a recursive function throws when the stack is nearly gone, as V8 does (3.10). */
export function tmkStackOverflow(): unknown {
  return new RangeError("Maximum call stack size exceeded");
}
