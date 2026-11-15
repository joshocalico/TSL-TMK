// Runtime failures that V8 throws as RangeError, as catchable exceptions where something can catch (SPEC 3.10, D49):
// string length and repeat counts, number formatting arguments, code points, array lengths, and recursion too deep.
function attempt(f: () => string): string {
  try {
    return `ok ${f()}`;
  } catch (e) {
    return e instanceof Error ? `${e.name}: ${e.message}` : `? ${String(e)}`;
  }
}

function sum(n: number): number {
  return n === 0 ? 0 : 1 + sum(n - 1);
}

function even(n: number): boolean {
  return n === 0 ? true : odd(n - 1);
}
function odd(n: number): boolean {
  return n === 0 ? false : even(n - 1);
}

export function repeat(n: number): string {
  return attempt(() => "ab".repeat(n).length.toString());
}

export function fixed(d: number): string {
  return attempt(() => (1.5).toFixed(d));
}

export function radix(r: number): string {
  return attempt(() => (255).toString(r));
}

export function codePoint(c: number): string {
  return attempt(() => String.fromCodePoint(c).length.toString());
}

export function arrayLength(n: number): string {
  return attempt(() => {
    const a = new Array<string>(n).fill("x");
    return `${a.length}`;
  });
}

export function deep(n: number): string {
  return attempt(() => `${sum(n)}`);
}

export function mutual(n: number): string {
  return attempt(() => `${even(n)}`);
}

export function deepThenFine(n: number): string {
  const first = attempt(() => `${sum(n)}`);
  return `${first.startsWith("RangeError") ? "overflowed" : first} then ${sum(100)}`;
}
