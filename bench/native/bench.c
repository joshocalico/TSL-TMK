// Hand-written C for the M5 benchmark set, with the same algorithms and the same data as the TSL in
// corpus/pos, for gate G2 (SPEC M5). Built with clang -O2 for the same target, and run in the same
// image by the same timing loop. No libc: clang may still emit calls to these two.
#include <stddef.h>
#include <stdint.h>

void *memset(void *d, int c, size_t n) {
  volatile uint8_t *p = d;
  while (n--) *p++ = (uint8_t)c;
  return d;
}
void *memcpy(void *d, const void *s, size_t n) {
  volatile uint8_t *p = d;
  const volatile uint8_t *q = s;
  while (n--) *p++ = *q++;
  return d;
}

static const uint32_t K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

static inline uint32_t rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

static uint32_t W[64], H[8];
static uint8_t BLOCK[64];

static void compress(void) {
  for (int t = 0; t < 16; t++) {
    const uint8_t *p = BLOCK + t * 4;
    W[t] = ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
  }
  for (int t = 16; t < 64; t++) {
    uint32_t s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >> 3);
    uint32_t s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >> 10);
    W[t] = W[t - 16] + s0 + W[t - 7] + s1;
  }
  uint32_t a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
  for (int t = 0; t < 64; t++) {
    uint32_t s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    uint32_t ch = (e & f) ^ (~e & g);
    uint32_t t1 = h + s1 + ch + K[t] + W[t];
    uint32_t s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
    uint32_t t2 = s0 + maj;
    h = g;
    g = f;
    f = e;
    e = d + t1;
    d = c;
    c = b;
    b = a;
    a = t1 + t2;
  }
  H[0] += a;
  H[1] += b;
  H[2] += c;
  H[3] += d;
  H[4] += e;
  H[5] += f;
  H[6] += g;
  H[7] += h;
}

static void sha256(const uint8_t *msg, size_t n, uint8_t *out) {
  static const uint32_t init[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                   0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  for (int i = 0; i < 8; i++) H[i] = init[i];
  size_t filled = 0;
  for (size_t i = 0; i < n; i++) {
    BLOCK[filled++] = msg[i];
    if (filled == 64) {
      compress();
      filled = 0;
    }
  }
  BLOCK[filled++] = 0x80;
  if (filled > 56) {
    while (filled < 64) BLOCK[filled++] = 0;
    compress();
    filled = 0;
  }
  while (filled < 56) BLOCK[filled++] = 0;
  uint32_t bits = (uint32_t)(n * 8);
  BLOCK[56] = BLOCK[57] = BLOCK[58] = BLOCK[59] = 0;
  BLOCK[60] = bits >> 24;
  BLOCK[61] = (bits >> 16) & 0xff;
  BLOCK[62] = (bits >> 8) & 0xff;
  BLOCK[63] = bits & 0xff;
  compress();
  for (int i = 0; i < 8; i++) {
    out[i * 4] = H[i] >> 24;
    out[i * 4 + 1] = (H[i] >> 16) & 0xff;
    out[i * 4 + 2] = (H[i] >> 8) & 0xff;
    out[i * 4 + 3] = H[i] & 0xff;
  }
}

static uint32_t TABLE[256];
static int ready;
static uint32_t crc32(const uint8_t *data, size_t n, uint32_t seed) {
  if (!ready) {
    for (uint32_t i = 0; i < 256; i++) {
      uint32_t c = i;
      for (int k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >> 1) : c >> 1;
      TABLE[i] = c;
    }
    ready = 1;
  }
  uint32_t crc = seed ^ 0xffffffff;
  for (size_t i = 0; i < n; i++) crc = TABLE[(crc ^ data[i]) & 0xff] ^ (crc >> 8);
  return crc ^ 0xffffffff;
}

static size_t partition(int32_t *a, size_t lo, size_t hi) {
  int32_t pivot = a[(lo + hi) / 2];
  size_t i = lo, j = hi;
  for (;;) {
    while (a[i] < pivot) i++;
    while (a[j] > pivot) j--;
    if (i >= j) return j;
    int32_t t = a[i];
    a[i] = a[j];
    a[j] = t;
    i++;
    j--;
  }
}
static void quick_range(int32_t *a, size_t lo, size_t hi) {
  if (lo >= hi) return;
  size_t p = partition(a, lo, hi);
  quick_range(a, lo, p);
  quick_range(a, p + 1, hi);
}

static uint32_t mandel_escape(double cr, double ci, uint32_t limit) {
  double zr = 0, zi = 0;
  for (uint32_t n = 0; n < limit; n++) {
    double zr2 = zr * zr, zi2 = zi * zi;
    if (zr2 + zi2 > 4) return n;
    zi = 2 * zr * zi + ci;
    zr = zr2 - zi2 + cr;
  }
  return limit;
}
static uint32_t mandel(uint32_t width, uint32_t height, uint32_t limit) {
  uint32_t sum = 0;
  for (uint32_t y = 0; y < height; y++) {
    for (uint32_t x = 0; x < width; x++) {
      double cr = -2 + (3 * (double)x) / (double)width;
      double ci = -1 + (2 * (double)y) / (double)height;
      sum = sum * 31 + mandel_escape(cr, ci, limit);
    }
  }
  return sum;
}

static void matmul(const double *a, const double *b, double *out, size_t n) {
  for (size_t i = 0; i < n; i++) {
    for (size_t j = 0; j < n; j++) {
      double sum = 0;
      for (size_t k = 0; k < n; k++) sum += a[i * n + k] * b[k * n + j];
      out[i * n + j] = sum;
    }
  }
}

static uint32_t fnv32(const uint8_t *data, size_t n) {
  uint32_t h = 0x811c9dc5;
  for (size_t i = 0; i < n; i++) h = (h ^ data[i]) * 0x01000193;
  return h;
}

// The one entry point, at offset 0 of the blob: the bench driver calls it through a pointer.
__attribute__((section(".text.entry"))) uint64_t c_bench(uint64_t which, uint64_t p0, uint64_t n0,
                                                         uint64_t p1, uint64_t n1, uint64_t x) {
  switch (which) {
    case 0:
      sha256((const uint8_t *)p0, n0, (uint8_t *)p1);
      return 0;
    case 1:
      return crc32((const uint8_t *)p0, n0, (uint32_t)x);
    case 2:
      if (n0 > 1) quick_range((int32_t *)p0, 0, n0 - 1);
      return 0;
    case 3:
      return mandel((uint32_t)p0, (uint32_t)n0, (uint32_t)p1);
    case 4:
      matmul((const double *)p0, (const double *)p1, (double *)n1, x);
      return 0;
    default:
      return fnv32((const uint8_t *)p0, n0);
  }
}
