// A field read before it's set is undefined in JS, and a zeroed struct can't say so.
// expect-fallback: early unsupported
class Late {
  value!: number;
}
export function early(): boolean {
  return new Late().value === undefined;
}
