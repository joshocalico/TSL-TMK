// Math functions, on floats, with JS's exact edge cases. Those with no TIR op use the host's.
// expect-tir: math\.sin
export function sines(x: number): number[] {
  return [
    Math.sin(x),
    Math.cos(x),
    Math.atan2(x, 2),
    Math.pow(x, 3),
    x ** 2,
    Math.log(x),
    Math.exp(x),
  ];
}
export function rounding(x: number): number[] {
  return [
    Math.floor(x),
    Math.ceil(x),
    Math.round(x),
    Math.trunc(x),
    Math.abs(x),
    Math.sign(x),
    Math.sqrt(x),
    Math.fround(x),
  ];
}
export function ints(x: number): number[] {
  return [Math.imul(x, 3), Math.clz32(x), Math.abs(x | 0), x | 0, x >>> 0, ~x, x << 1, x >> 1];
}
export function constants(): number[] {
  return [Math.PI, Math.E, Number.MAX_SAFE_INTEGER, Number.EPSILON];
}
export function predicates(x: number): boolean[] {
  return [Number.isInteger(x), Number.isNaN(x), Number.isFinite(x), isNaN(x), isFinite(x)];
}
