// The M5 benchmark set's inputs (SPEC M5): the same bytes in every configuration, from a fixed generator.
export interface Workload {
  name: string;
  program: string; // corpus/pos/<program>.ts
  fn: string;
  cIndex: number; // which function in bench/native/bench.c
  args: () => (Uint8Array | Int32Array | Float64Array | number)[];
  // Arguments to restore before each iteration, outside the timed part: the call overwrites them.
  restore: number[];
}

function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x;
  };
}

function bytes(n: number, seed: number): Uint8Array {
  const r = lcg(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = r() >>> 24;
  return out;
}

function ints(n: number, seed: number): Int32Array {
  const r = lcg(seed);
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) out[i] = r() | 0;
  return out;
}

function floats(n: number, seed: number): Float64Array {
  const r = lcg(seed);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = r() / 4294967296;
  return out;
}

export const WORKLOADS: Workload[] = [
  {
    name: "sha256_u32",
    program: "sha256_u32",
    fn: "sha256",
    cIndex: 0,
    args: () => [bytes(65536, 1), new Uint8Array(32)],
    restore: [],
  },
  {
    name: "crc32_table",
    program: "crc32_table",
    fn: "crc32",
    cIndex: 1,
    args: () => [bytes(1048576, 2), 0],
    restore: [],
  },
  {
    name: "sort_i32",
    program: "sort_i32",
    fn: "quick",
    cIndex: 2,
    args: () => [ints(20000, 3)],
    restore: [0],
  },
  {
    name: "mandel_f64",
    program: "mandel_f64",
    fn: "checksum",
    cIndex: 3,
    args: () => [128, 128, 64],
    restore: [],
  },
  {
    name: "matmul_f64",
    program: "matmul_f64",
    fn: "matmul",
    cIndex: 4,
    args: () => [floats(96 * 96, 4), floats(96 * 96, 5), new Float64Array(96 * 96), 96],
    restore: [],
  },
  {
    name: "fnv1a",
    program: "fnv1a",
    fn: "fnv32",
    cIndex: 5,
    args: () => [bytes(1048576, 6)],
    restore: [],
  },
];
