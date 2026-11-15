/**
 * Baseline and progressive JPEG decoding (8-bit, Huffman) to RGBA.
 *
 * Coefficients for the whole frame are kept until the last scan, because progressive scans
 * refine them in several passes; the inverse DCT and colour conversion run once at the end.
 * EXIF orientation is left to the caller.
 */
type ImageData = { rgba: Uint8Array; width: number; height: number };

export type JpegDecodeOptions = {
  /** Long edge the caller will show; lets the decoder skip work. */
  maxEdge?: number;
};

const MAX_SIDE = 16384;
const MAX_PIXELS = 100_000_000;
/** Huffman codes up to this length resolve with one table lookup; longer ones walk the tree. */
const LOOKUP_BITS = 9;

/** Zigzag scan position → natural (row-major) position in the 8×8 block. */
const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

/** AAN scale factors, cos(kπ/16)·√2 for k > 0; folded into the dequantisation table. */
const AAN_SCALE = [
  1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.5411961, 0.275899379,
];

type Huffman = {
  /** (length << 8) | symbol for codes of at most LOOKUP_BITS bits, 0 when longer. */
  lookup: Uint16Array;
  maxCode: Int32Array;
  valueOffset: Int32Array;
  values: Uint8Array;
};

type Component = {
  id: number;
  h: number;
  v: number;
  quantTable: number;
  blocksPerLine: number;
  blocksPerColumn: number;
  /** Blocks per row in storage, padded to whole MCUs. */
  stride: number;
  coefficients: Int16Array;
  pred: number;
  dcTable?: Huffman;
  acTable?: Huffman;
};

type Frame = {
  progressive: boolean;
  width: number;
  height: number;
  hMax: number;
  vMax: number;
  mcusPerLine: number;
  mcusPerColumn: number;
  components: Component[];
};

function buildHuffman(counts: Uint8Array, values: Uint8Array): Huffman {
  const lookup = new Uint16Array(1 << LOOKUP_BITS);
  const maxCode = new Int32Array(18).fill(-1);
  const valueOffset = new Int32Array(18);
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    const count = counts[length - 1]!;
    valueOffset[length] = k - code;
    for (let i = 0; i < count; i++, k++, code++) {
      if (length <= LOOKUP_BITS) {
        const shift = LOOKUP_BITS - length;
        const entry = (length << 8) | values[k]!;
        for (let fill = 0; fill < 1 << shift; fill++) lookup[(code << shift) | fill] = entry;
      }
    }
    if (count) maxCode[length] = code - 1;
    code <<= 1;
  }
  return { lookup, maxCode, valueOffset, values };
}

/** Entropy-coded bits, with byte stuffing removed and zeros fed past a marker or the end. */
class BitReader {
  private acc = 0;
  private bits = 0;
  /** Zero bits fed past the end of the data; once only those remain, the data has run out. */
  private padding = 0;
  private atMarker = false;
  constructor(
    private readonly data: Uint8Array,
    public pos: number,
  ) {}

  private fill(): void {
    while (this.bits <= 24) {
      let byte = 0;
      if (this.atMarker) {
        // Zeros pad the last bits before a marker; they are part of the scan.
      } else if (this.pos >= this.data.length) {
        this.padding += 8;
      } else {
        byte = this.data[this.pos]!;
        if (byte === 0xff) {
          const next = this.data[this.pos + 1];
          if (next === 0) this.pos += 2;
          else {
            this.atMarker = true;
            byte = 0;
          }
        } else this.pos++;
      }
      this.acc = ((this.acc << 8) | byte) >>> 0;
      this.bits += 8;
    }
  }

  get exhausted(): boolean {
    return this.padding > 0 && this.bits <= this.padding;
  }

  private consume(count: number): void {
    this.bits -= count;
    if (this.padding > this.bits) this.padding = this.bits;
  }

  readBits(count: number): number {
    if (count === 0) return 0;
    if (this.bits < count) this.fill();
    const value = (this.acc >>> (this.bits - count)) & ((1 << count) - 1);
    this.consume(count);
    return value;
  }

  readBit(): number {
    return this.readBits(1);
  }

  /** A value of `count` bits in JPEG's sign-extended form. */
  receiveExtend(count: number): number {
    if (count === 0) return 0;
    const value = this.readBits(count);
    return value < 1 << (count - 1) ? value - (1 << count) + 1 : value;
  }

  decode(table: Huffman): number {
    if (this.bits < 16) this.fill();
    const entry =
      table.lookup[(this.acc >>> (this.bits - LOOKUP_BITS)) & ((1 << LOOKUP_BITS) - 1)]!;
    if (entry) {
      this.consume(entry >> 8);
      return entry & 0xff;
    }
    for (let length = LOOKUP_BITS + 1; length <= 16; length++) {
      const code = (this.acc >>> (this.bits - length)) & ((1 << length) - 1);
      if (code <= table.maxCode[length]!) {
        this.consume(length);
        return table.values[code + table.valueOffset[length]!] ?? 0;
      }
    }
    // A corrupt code: skip a bit so the scan still ends.
    this.consume(1);
    return 0;
  }

  /** Drop to the byte after the next RSTn marker, at a restart interval boundary. */
  restart(): void {
    this.acc = 0;
    this.bits = 0;
    this.padding = 0;
    this.atMarker = false;
    const data = this.data;
    for (let at = this.pos; at + 1 < data.length; at++) {
      if (data[at] !== 0xff) continue;
      const marker = data[at + 1]!;
      if (marker >= 0xd0 && marker <= 0xd7) {
        this.pos = at + 2;
        return;
      }
      if (marker !== 0 && marker !== 0xff) {
        this.pos = at;
        return;
      }
    }
  }
}

type ScanDecoder = (component: Component, offset: number) => void;

function decodeScan(
  data: Uint8Array,
  start: number,
  frame: Frame,
  components: Component[],
  resetInterval: number,
  spectralStart: number,
  spectralEnd: number,
  approxHigh: number,
  approxLow: number,
): number {
  const reader = new BitReader(data, start);
  let eobrun = 0;

  const baseline: ScanDecoder = (c, offset) => {
    const t = reader.decode(c.dcTable!);
    c.pred += reader.receiveExtend(t);
    c.coefficients[offset] = c.pred;
    for (let k = 1; k < 64;) {
      const rs = reader.decode(c.acTable!);
      const s = rs & 15;
      const r = rs >> 4;
      if (s === 0) {
        if (r < 15) break;
        k += 16;
        continue;
      }
      k += r;
      if (k > 63) break;
      c.coefficients[offset + ZIGZAG[k]!] = reader.receiveExtend(s);
      k++;
    }
  };
  const dcFirst: ScanDecoder = (c, offset) => {
    const t = reader.decode(c.dcTable!);
    c.pred += reader.receiveExtend(t);
    c.coefficients[offset] = c.pred * (1 << approxLow);
  };
  const dcRefine: ScanDecoder = (c, offset) => {
    if (reader.readBit()) c.coefficients[offset]! |= 1 << approxLow;
  };
  const acFirst: ScanDecoder = (c, offset) => {
    if (eobrun > 0) {
      eobrun--;
      return;
    }
    for (let k = spectralStart; k <= spectralEnd;) {
      const rs = reader.decode(c.acTable!);
      const s = rs & 15;
      const r = rs >> 4;
      if (s === 0) {
        if (r < 15) {
          eobrun = reader.readBits(r) + (1 << r) - 1;
          break;
        }
        k += 16;
        continue;
      }
      k += r;
      if (k > 63) break;
      c.coefficients[offset + ZIGZAG[k]!] = reader.receiveExtend(s) * (1 << approxLow);
      k++;
    }
  };
  // Follows libjpeg's decode_mcu_AC_refine: each new coefficient is placed after skipping `r`
  // zero-history positions, while every nonzero one passed gets a correction bit.
  const acRefine: ScanDecoder = (c, offset) => {
    const coefficients = c.coefficients;
    const p1 = 1 << approxLow;
    const m1 = -1 << approxLow;
    const refine = (at: number) => {
      const value = coefficients[at]!;
      if (reader.readBit() && (value & p1) === 0) coefficients[at] = value + (value >= 0 ? p1 : m1);
    };
    let k = spectralStart;
    if (eobrun === 0) {
      for (; k <= spectralEnd; k++) {
        const rs = reader.decode(c.acTable!);
        let r = rs >> 4;
        let value = 0;
        if (rs & 15) value = reader.readBit() ? p1 : m1;
        else if (r !== 15) {
          eobrun = (1 << r) + reader.readBits(r);
          break;
        }
        while (k <= spectralEnd) {
          const at = offset + ZIGZAG[k]!;
          if (coefficients[at] !== 0) refine(at);
          else if (--r < 0) break;
          k++;
        }
        if (value && k <= spectralEnd) coefficients[offset + ZIGZAG[k]!] = value;
      }
    }
    if (eobrun > 0) {
      for (; k <= spectralEnd; k++) {
        const at = offset + ZIGZAG[k]!;
        if (coefficients[at] !== 0) refine(at);
      }
      eobrun--;
    }
  };

  const decodeBlock: ScanDecoder = !frame.progressive
    ? baseline
    : spectralStart === 0
      ? approxHigh === 0
        ? dcFirst
        : dcRefine
      : approxHigh === 0
        ? acFirst
        : acRefine;

  for (const component of components) component.pred = 0;
  const single = components.length === 1 ? components[0]! : null;
  const total = single
    ? single.blocksPerLine * single.blocksPerColumn
    : frame.mcusPerLine * frame.mcusPerColumn;
  for (let n = 0; n < total; n++) {
    if (resetInterval && n > 0 && n % resetInterval === 0) {
      reader.restart();
      for (const component of components) component.pred = 0;
      eobrun = 0;
    }
    if (reader.exhausted) break;
    if (single) {
      const row = Math.floor(n / single.blocksPerLine);
      const column = n % single.blocksPerLine;
      decodeBlock(single, (row * single.stride + column) * 64);
      continue;
    }
    const mcuRow = Math.floor(n / frame.mcusPerLine);
    const mcuColumn = n % frame.mcusPerLine;
    for (const component of components)
      for (let j = 0; j < component.v; j++)
        for (let i = 0; i < component.h; i++) {
          const row = mcuRow * component.v + j;
          const column = mcuColumn * component.h + i;
          decodeBlock(component, (row * component.stride + column) * 64);
        }
  }
  return reader.pos;
}

/** Separable AAN float IDCT (libjpeg's jidctflt) of one block into an 8×8 patch of `out`. */
function idctBlock(
  input: Int16Array,
  offset: number,
  quant: Float32Array,
  out: Uint8Array,
  outOffset: number,
  stride: number,
  work: Float32Array,
): void {
  for (let column = 0; column < 8; column++) {
    const at = offset + column;
    if (
      input[at + 8] === 0 &&
      input[at + 16] === 0 &&
      input[at + 24] === 0 &&
      input[at + 32] === 0 &&
      input[at + 40] === 0 &&
      input[at + 48] === 0 &&
      input[at + 56] === 0
    ) {
      const dc = input[at]! * quant[column]!;
      for (let row = 0; row < 8; row++) work[row * 8 + column] = dc;
      continue;
    }
    const q = (row: number) => input[at + row * 8]! * quant[row * 8 + column]!;
    let tmp0 = q(0);
    let tmp1 = q(2);
    let tmp2 = q(4);
    let tmp3 = q(6);
    let tmp10 = tmp0 + tmp2;
    let tmp11 = tmp0 - tmp2;
    let tmp13 = tmp1 + tmp3;
    let tmp12 = (tmp1 - tmp3) * 1.414213562 - tmp13;
    tmp0 = tmp10 + tmp13;
    tmp3 = tmp10 - tmp13;
    tmp1 = tmp11 + tmp12;
    tmp2 = tmp11 - tmp12;
    const tmp4 = q(1);
    const tmp5 = q(3);
    const tmp6 = q(5);
    const tmp7 = q(7);
    const z13 = tmp6 + tmp5;
    const z10 = tmp6 - tmp5;
    const z11 = tmp4 + tmp7;
    const z12 = tmp4 - tmp7;
    const o7 = z11 + z13;
    tmp11 = (z11 - z13) * 1.414213562;
    const z5 = (z10 + z12) * 1.847759065;
    tmp10 = z5 - z12 * 1.0823922;
    tmp12 = z5 - z10 * 2.61312593;
    const o6 = tmp12 - o7;
    const o5 = tmp11 - o6;
    const o4 = tmp10 - o5;
    work[column] = tmp0 + o7;
    work[56 + column] = tmp0 - o7;
    work[8 + column] = tmp1 + o6;
    work[48 + column] = tmp1 - o6;
    work[16 + column] = tmp2 + o5;
    work[40 + column] = tmp2 - o5;
    work[24 + column] = tmp3 + o4;
    work[32 + column] = tmp3 - o4;
  }
  for (let row = 0; row < 8; row++) {
    const w = row * 8;
    let tmp10 = work[w]! + work[w + 4]!;
    let tmp11 = work[w]! - work[w + 4]!;
    let tmp13 = work[w + 2]! + work[w + 6]!;
    let tmp12 = (work[w + 2]! - work[w + 6]!) * 1.414213562 - tmp13;
    const tmp0 = tmp10 + tmp13;
    const tmp3 = tmp10 - tmp13;
    const tmp1 = tmp11 + tmp12;
    const tmp2 = tmp11 - tmp12;
    const z13 = work[w + 5]! + work[w + 3]!;
    const z10 = work[w + 5]! - work[w + 3]!;
    const z11 = work[w + 1]! + work[w + 7]!;
    const z12 = work[w + 1]! - work[w + 7]!;
    const o7 = z11 + z13;
    tmp11 = (z11 - z13) * 1.414213562;
    const z5 = (z10 + z12) * 1.847759065;
    tmp10 = z5 - z12 * 1.0823922;
    tmp12 = z5 - z10 * 2.61312593;
    const o6 = tmp12 - o7;
    const o5 = tmp11 - o6;
    const o4 = tmp10 - o5;
    const dest = outOffset + row * stride;
    // Uint8Array stores clamp nothing, so clamp explicitly; +128.5 recentres and rounds.
    const put = (at: number, value: number) => {
      const v = (value + 128.5) | 0;
      out[dest + at] = v < 0 ? 0 : v > 255 ? 255 : v;
    };
    put(0, tmp0 + o7);
    put(7, tmp0 - o7);
    put(1, tmp1 + o6);
    put(6, tmp1 - o6);
    put(2, tmp2 + o5);
    put(5, tmp2 - o5);
    put(3, tmp3 + o4);
    put(4, tmp3 - o4);
  }
}

/** One plane per component at `scale` (1: full, 8: one sample per block from its DC term). */
function componentPlane(
  component: Component,
  rawQuant: Uint16Array,
  scale: 1 | 8,
): { data: Uint8Array; width: number } {
  const blockSize = 8 / scale;
  const width = component.stride * blockSize;
  const rows = component.coefficients.length / 64 / component.stride;
  const data = new Uint8Array(width * rows * blockSize);
  if (scale === 8) {
    const dcScale = rawQuant[0]! / 8;
    for (let block = 0; block * 64 < component.coefficients.length; block++) {
      const v = Math.round(component.coefficients[block * 64]! * dcScale + 128);
      data[block] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    return { data, width };
  }
  const quant = new Float32Array(64);
  for (let i = 0; i < 64; i++)
    quant[i] = (rawQuant[i]! * AAN_SCALE[i >> 3]! * AAN_SCALE[i & 7]!) / 8;
  const work = new Float32Array(64);
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < component.stride; column++)
      idctBlock(
        component.coefficients,
        (row * component.stride + column) * 64,
        quant,
        data,
        row * 8 * width + column * 8,
        width,
        work,
      );
  return { data, width };
}

type ColourSpace = "gray" | "ycc" | "rgb" | "cmyk" | "ycck";

function toRgba(
  frame: Frame,
  quantTables: Uint16Array[],
  space: ColourSpace,
  scale: 1 | 8,
): ImageData {
  const width = Math.ceil(frame.width / scale);
  const height = Math.ceil(frame.height / scale);
  const planes = frame.components.map((component) => {
    const plane = componentPlane(
      component,
      quantTables[component.quantTable] ?? new Uint16Array(64).fill(1),
      scale,
    );
    // Nearest-sample upsampling of subsampled components: a column index per output x.
    const columns = new Int32Array(width);
    for (let x = 0; x < width; x++) columns[x] = Math.floor((x * component.h) / frame.hMax);
    return { ...plane, columns, v: component.v };
  });
  const rgba = new Uint8Array(width * height * 4);
  const clamp = (value: number) => (value < 0 ? 0 : value > 255 ? 255 : (value + 0.5) | 0);
  for (let y = 0; y < height; y++) {
    const rows = planes.map((plane) => Math.floor((y * plane.v) / frame.vMax) * plane.width);
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const c0 = planes[0]!.data[rows[0]! + planes[0]!.columns[x]!]!;
      rgba[at + 3] = 255;
      if (space === "gray") {
        rgba[at] = rgba[at + 1] = rgba[at + 2] = c0;
        continue;
      }
      const c1 = planes[1]!.data[rows[1]! + planes[1]!.columns[x]!]!;
      const c2 = planes[2]!.data[rows[2]! + planes[2]!.columns[x]!]!;
      let r = c0;
      let g = c1;
      let b = c2;
      if (space === "ycc" || space === "ycck") {
        r = c0 + 1.402 * (c2 - 128);
        g = c0 - 0.344136 * (c1 - 128) - 0.714136 * (c2 - 128);
        b = c0 + 1.772 * (c1 - 128);
      }
      if (space === "cmyk" || space === "ycck") {
        // Adobe stores CMYK inverted (255 is no ink); YCCK is that inverted CMYK with its first
        // three channels YCbCr-coded from 255 − value.
        const k = planes[3]!.data[rows[3]! + planes[3]!.columns[x]!]!;
        const [c, m, yy] = space === "ycck" ? [255 - r, 255 - g, 255 - b] : [r, g, b];
        r = (c * k) / 255;
        g = (m * k) / 255;
        b = (yy * k) / 255;
      }
      rgba[at] = clamp(r);
      rgba[at + 1] = clamp(g);
      rgba[at + 2] = clamp(b);
    }
  }
  return { rgba, width, height };
}

const isSof = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

/** The frame's size from its SOF segment, without decoding; null when not a JPEG. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    if (isSof(marker))
      return {
        height: (bytes[at + 5]! << 8) | bytes[at + 6]!,
        width: (bytes[at + 7]! << 8) | bytes[at + 8]!,
      };
    at += 2 + ((bytes[at + 2]! << 8) | bytes[at + 3]!);
  }
  return null;
}

export function decodeJpeg(bytes: Uint8Array, options: JpegDecodeOptions = {}): ImageData {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Not a JPEG image.");
  const quantTables: Uint16Array[] = [];
  const dcTables: Huffman[] = [];
  const acTables: Huffman[] = [];
  let frame: Frame | null = null;
  let resetInterval = 0;
  let jfif = false;
  let adobeTransform: number | null = null;
  let scans = 0;
  const u16 = (at: number) => (bytes[at]! << 8) | bytes[at + 1]!;

  let at = 2;
  markers: while (at + 1 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at++;
      continue;
    }
    const marker = bytes[at + 1]!;
    at += 2;
    if (marker === 0xff) {
      at--;
      continue;
    }
    if (marker === 0 || marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7))
      continue;
    if (marker === 0xd9) break;
    if (at + 2 > bytes.length) break;
    const length = u16(at);
    const end = Math.min(bytes.length, at + length);
    const body = at + 2;
    switch (marker) {
      case 0xe0:
        if (String.fromCharCode(...bytes.subarray(body, body + 4)) === "JFIF") jfif = true;
        break;
      case 0xee:
        if (String.fromCharCode(...bytes.subarray(body, body + 5)) === "Adobe")
          adobeTransform = bytes[body + 11] ?? 0;
        break;
      case 0xdb:
        for (let p = body; p < end;) {
          const wide = bytes[p]! >> 4;
          const id = bytes[p]! & 15;
          p++;
          const table = new Uint16Array(64);
          for (let i = 0; i < 64; i++, p += wide ? 2 : 1)
            table[ZIGZAG[i]!] = wide ? u16(p) : bytes[p]!;
          quantTables[id] = table;
        }
        break;
      case 0xc4:
        for (let p = body; p + 17 <= end;) {
          const tableClass = bytes[p]! >> 4;
          const id = bytes[p]! & 15;
          const counts = bytes.subarray(p + 1, p + 17);
          const total = counts.reduce((sum, count) => sum + count, 0);
          const table = buildHuffman(counts, bytes.subarray(p + 17, p + 17 + total));
          (tableClass === 0 ? dcTables : acTables)[id] = table;
          p += 17 + total;
        }
        break;
      case 0xdd:
        resetInterval = u16(body);
        break;
      case 0xc0:
      case 0xc1:
      case 0xc2: {
        if (frame) throw new Error("JPEG has more than one frame.");
        if (bytes[body] !== 8) throw new Error("Only 8-bit JPEG images are supported.");
        const height = u16(body + 1);
        const width = u16(body + 3);
        if (!width || !height) throw new Error("JPEG has no image size (DNL is unsupported).");
        if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS)
          throw new Error(`JPEG is too large to decode (${width}×${height}).`);
        const count = bytes[body + 5]!;
        const specs = Array.from({ length: count }, (_, i) => {
          const p = body + 6 + i * 3;
          return {
            id: bytes[p]!,
            h: Math.max(1, bytes[p + 1]! >> 4),
            v: Math.max(1, bytes[p + 1]! & 15),
            quantTable: bytes[p + 2]!,
          };
        });
        const hMax = Math.max(...specs.map((spec) => spec.h));
        const vMax = Math.max(...specs.map((spec) => spec.v));
        const mcusPerLine = Math.ceil(width / (8 * hMax));
        const mcusPerColumn = Math.ceil(height / (8 * vMax));
        frame = {
          progressive: marker === 0xc2,
          width,
          height,
          hMax,
          vMax,
          mcusPerLine,
          mcusPerColumn,
          components: specs.map((spec) => {
            const stride = mcusPerLine * spec.h;
            return {
              ...spec,
              blocksPerLine: Math.ceil(Math.ceil((width * spec.h) / hMax) / 8),
              blocksPerColumn: Math.ceil(Math.ceil((height * spec.v) / vMax) / 8),
              stride,
              coefficients: new Int16Array(stride * mcusPerColumn * spec.v * 64),
              pred: 0,
            };
          }),
        };
        break;
      }
      case 0xda: {
        if (!frame) throw new Error("JPEG scan comes before its frame header.");
        const count = bytes[body]!;
        const components = Array.from({ length: count }, (_, i) => {
          const p = body + 1 + i * 2;
          const component = frame!.components.find((candidate) => candidate.id === bytes[p]);
          if (!component) throw new Error("JPEG scan names an unknown component.");
          component.dcTable = dcTables[bytes[p + 1]! >> 4];
          component.acTable = acTables[bytes[p + 1]! & 15];
          return component;
        });
        const p = body + 1 + count * 2;
        at = decodeScan(
          bytes,
          end,
          frame,
          components,
          resetInterval,
          bytes[p]!,
          bytes[p + 1]!,
          bytes[p + 2]! >> 4,
          bytes[p + 2]! & 15,
        );
        scans++;
        continue markers;
      }
      default:
        if (isSof(marker))
          throw new Error("Arithmetic, lossless and hierarchical JPEGs are not supported.");
    }
    at = end;
  }
  if (!frame || scans === 0) throw new Error("JPEG has no image data.");

  const ids = frame.components.map((component) => component.id);
  const count = frame.components.length;
  const space: ColourSpace =
    count === 1
      ? "gray"
      : count === 4
        ? adobeTransform === 2
          ? "ycck"
          : "cmyk"
        : jfif
          ? "ycc"
          : adobeTransform !== null
            ? adobeTransform === 0
              ? "rgb"
              : "ycc"
            : ids[0] === 0x52 && ids[1] === 0x47 && ids[2] === 0x42
              ? "rgb"
              : "ycc";
  if (count !== 1 && count !== 3 && count !== 4)
    throw new Error(`JPEG with ${count} components is not supported.`);
  const maxEdge = options.maxEdge;
  const scale = maxEdge && Math.max(frame.width, frame.height) / 8 >= maxEdge ? 8 : 1;
  return toRgba(frame, quantTables, space, scale);
}
