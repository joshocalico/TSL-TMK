// A validation library with an error hierarchy (SPEC 4.5, D49, D50): extends Error, a cause, instanceof to tell them apart,
// rethrowing, and errors that reach the caller.
class ValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ValidationError";
    this.field = field;
  }
}

class RangeCheckError extends ValidationError {
  readonly min: number;
  readonly max: number;
  constructor(field: string, min: number, max: number, got: number) {
    super(field, `${field} must be in [${min}, ${max}], got ${got}`);
    this.name = "RangeCheckError";
    this.min = min;
    this.max = max;
  }
}

class MissingError extends ValidationError {}

class ParseFailure extends Error {
  code = 400;
}

interface User {
  name: string;
  age: number;
  email: string;
}

function checkAge(age: number): number {
  if (!Number.isInteger(age)) throw new TypeError(`age must be an integer, got ${age}`);
  if (age < 0 || age > 150) throw new RangeCheckError("age", 0, 150, age);
  return age;
}

function checkName(name: string): string {
  if (name.length === 0) throw new MissingError("name", "name is required");
  return name.trim();
}

function checkEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0 || at === email.length - 1) throw new ValidationError("email", `bad email ${email}`);
  return email.toLowerCase();
}

function validate(name: string, age: number, email: string): User {
  return { name: checkName(name), age: checkAge(age), email: checkEmail(email) };
}

function parseUser(text: string): User {
  const parts = text.split(",");
  if (parts.length !== 3) throw new ParseFailure(`expected 3 fields, got ${parts.length}`);
  try {
    return validate(parts[0]!, Number(parts[1]!), parts[2]!);
  } catch (e) {
    if (e instanceof MissingError) throw new ParseFailure("incomplete record", { cause: e });
    throw e;
  }
}

/** Every record, and for each failure a line saying what kind it was. */
export function report(lines: string): string {
  const out: string[] = [];
  for (const line of lines.split(";")) {
    try {
      const u = parseUser(line);
      out.push(`ok ${u.name}/${u.age}/${u.email}`);
    } catch (e) {
      if (e instanceof RangeCheckError)
        out.push(`range ${e.field} ${e.min}..${e.max}: ${e.message}`);
      else if (e instanceof ValidationError)
        out.push(`invalid ${e.field}: ${e.name}: ${e.message}`);
      else if (e instanceof ParseFailure) {
        const why = e.cause instanceof Error ? ` (because ${e.cause.message})` : "";
        out.push(`parse ${e.code} ${e.message}${why}`);
      } else if (e instanceof TypeError) out.push(`type: ${String(e)}`);
      else out.push(`other ${String(e)}`);
    }
  }
  return out.join("\n");
}

/** Counts failures by class, for many records. */
export function tally(n: number): string {
  let ok = 0;
  let range = 0;
  let invalid = 0;
  let parse = 0;
  for (let i = 0; i < n; i++) {
    const line =
      i % 7 === 0
        ? `,${i},a@b`
        : i % 5 === 0
          ? `u${i},${i * 7},x@y`
          : i % 3 === 0
            ? `u${i},2,bad`
            : `u${i},${i % 90}`;
    try {
      parseUser(i % 11 === 0 ? `${line},z@z` : line.split(",").length === 2 ? `${line},q@q` : line);
      ok++;
    } catch (e) {
      if (e instanceof RangeCheckError) range++;
      else if (e instanceof ValidationError) invalid++;
      else parse++;
    }
  }
  return `${ok} ${range} ${invalid} ${parse}`;
}

/** An error that reaches the caller: its class, name, message and cause are what V8's are. */
export function strict(text: string): string {
  const u = parseUser(text);
  return u.name;
}

export function toStrings(): string {
  const a = new RangeCheckError("x", 1, 2, 3);
  const b = new Error();
  const c = new Error("plain");
  const d = new MissingError("y", "");
  return [String(a), String(b), String(c), String(d), a.toString(), `${c}`].join("|");
}
