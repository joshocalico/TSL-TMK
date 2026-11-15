// Wasm binary encoding primitives. Hand-written, no dependencies (SPEC 4.4).

export class ByteWriter {
  bytes: number[] = [];
  byte(b: number): void {
    this.bytes.push(b & 0xff);
  }
  u32(n: number): void {
    let v = n >>> 0;
    for (let guard = 0; guard < 5; guard++) {
      const b = v & 0x7f;
      v >>>= 7;
      if (v === 0) {
        this.bytes.push(b);
        return;
      }
      this.bytes.push(b | 0x80);
    }
  }
  /** Signed LEB128 of a value that fits `bits` bits. */
  sleb(value: bigint, bits: number): void {
    let v = BigInt.asIntN(bits, value);
    for (let guard = 0; guard < 11; guard++) {
      const b = Number(v & 0x7fn);
      v >>= 7n;
      const signBit = (b & 0x40) !== 0;
      if ((v === 0n && !signBit) || (v === -1n && signBit)) {
        this.bytes.push(b);
        return;
      }
      this.bytes.push(b | 0x80);
    }
  }
  append(other: readonly number[]): void {
    for (let i = 0; i < other.length; i++) this.bytes.push(other[i]!);
  }
  name(s: string): void {
    const encoded = Buffer.from(s, "utf8");
    this.u32(encoded.length);
    for (const b of encoded) this.bytes.push(b);
  }
  /** Little-endian bytes of a bit pattern, for f32.const and f64.const. */
  bitsLE(value: bigint, width: number): void {
    let v = BigInt.asUintN(width * 8, value);
    for (let i = 0; i < width; i++) {
      this.bytes.push(Number(v & 0xffn));
      v >>= 8n;
    }
  }
}

export const VALTYPE = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, funcref: 0x70 } as const;

export function section(out: ByteWriter, id: number, body: ByteWriter): void {
  out.byte(id);
  out.u32(body.bytes.length);
  out.append(body.bytes);
}
