// R14 (R13's carried TSL1008): a typed array held in a field that may be null, compared with null, which class printing in
// `leak` and `manual` printed as `null` against a Ref and tslc refused; now `nullRef()`, as R13 prints it in `strict`.
const shared = new Uint16Array(8);

class H {
  buf: Uint16Array | null = null;
}

export function pick(n: number): number {
  const h = new H();
  if ((n | 0) > 2) h.buf = shared;
  const b = h.buf;
  return b === null ? -1 : b.length + (b !== null ? 1 : 0);
}

export function fill(n: number): number {
  const h = new H();
  h.buf = (n | 0) % 2 === 0 ? shared : null;
  if (h.buf !== null) {
    h.buf[1] = (n | 0) & 0xffff;
    return h.buf[1]!;
  }
  return -2;
}
