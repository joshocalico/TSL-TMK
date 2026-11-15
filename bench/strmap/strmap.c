// Hand-written C for what bench/strmap/strmap_lowered.ts does, where a comparison is fair: appending to a buffer, an
// insertion-ordered hash table with deletes, and a word count. UTF-16 as native's strings are, with an arena that's never freed,
// which is cheaper than what either other side does. Built as bench/alloc/alloc.c is, and run the same way.
#include <stddef.h>
#include <stdint.h>

void *memset(void *d, int c, size_t n) {
  volatile uint8_t *p = d;
  while (n--) *p++ = (uint8_t)c;
  return d;
}
void *memcpy(void *d, const void *s, size_t n) {
  volatile uint8_t *p = d;
  const uint8_t *q = s;
  while (n--) *p++ = *q++;
  return d;
}

static uint8_t *bump;
static void *arena(size_t n) {
  uint8_t *p = bump;
  bump += (n + 15) & ~(size_t)15;
  return p;
}
static uint32_t lcg(uint32_t x) { return (x * 1103515245u + 12345u) & 0x7fffffffu; }

static uint32_t mix(uint32_t h) {
  h ^= h >> 16;
  h *= 0x85ebca6bu;
  h ^= h >> 13;
  h *= 0xc2b2ae35u;
  return h ^ (h >> 16);
}

static uint64_t concat_work(uint64_t n) {
  uint32_t cap = 16, len = 0;
  uint16_t *s = arena(cap * 2);
  for (uint32_t i = 0; i < n; i++) {
    if (len == cap) {
      uint16_t *t = arena(cap * 4);
      for (uint32_t k = 0; k < len; k++) t[k] = s[k];
      s = t;
      cap *= 2;
    }
    s[len++] = "abcdefgh"[i & 7];
  }
  return (uint32_t)(len + s[n >> 1]);
}

typedef struct {
  int32_t *keys, *vals, *chain, *heads;
  int32_t used, cap, size;
} table;

static void grow(table *t) {
  int32_t want = t->cap == 0 ? 4 : t->cap;
  if (t->cap != 0 && t->size * 2 > t->used) want *= 2;
  int32_t *k = arena((size_t)want * 4), *v = arena((size_t)want * 4), *c = arena((size_t)want * 4), *h = arena((size_t)want * 4);
  for (int32_t i = 0; i < want; i++) h[i] = -1;
  int32_t to = 0;
  for (int32_t i = 0; i < t->used; i++) {
    if (t->chain[i] == -2) continue;
    k[to] = t->keys[i];
    v[to] = t->vals[i];
    uint32_t b = mix((uint32_t)k[to]) & (uint32_t)(want - 1);
    c[to] = h[b];
    h[b] = to;
    to++;
  }
  t->keys = k;
  t->vals = v;
  t->chain = c;
  t->heads = h;
  t->used = to;
  t->cap = want;
}

static uint64_t map_mix(uint64_t n) {
  table t = {0};
  int32_t range = (int32_t)(n >> 1) + 1;
  uint32_t x = 1;
  int32_t h = 0;
  for (uint32_t i = 0; i < n; i++) {
    x = lcg(x);
    int32_t k = (int32_t)(x % (uint32_t)range);
    uint32_t op = (x >> 27) & 3;
    uint32_t hb = mix((uint32_t)k);
    int32_t at = -1, prev = -1;
    if (t.cap != 0) {
      for (int32_t j = t.heads[hb & (uint32_t)(t.cap - 1)]; j >= 0; prev = j, j = t.chain[j]) {
        if (t.keys[j] == k) {
          at = j;
          break;
        }
      }
    }
    if (op <= 1) {
      if (at >= 0) t.vals[at] = (int32_t)i;
      else {
        if (t.used >= t.cap) grow(&t);
        uint32_t b = hb & (uint32_t)(t.cap - 1);
        t.keys[t.used] = k;
        t.vals[t.used] = (int32_t)i;
        t.chain[t.used] = t.heads[b];
        t.heads[b] = t.used++;
        t.size++;
      }
    } else if (op == 2) {
      if (at >= 0) h = (int32_t)((uint32_t)h + (uint32_t)t.vals[at]);
    } else if (at >= 0) {
      uint32_t b = hb & (uint32_t)(t.cap - 1);
      if (prev < 0) t.heads[b] = t.chain[at];
      else t.chain[prev] = t.chain[at];
      t.chain[at] = -2;
      t.size--;
    }
  }
  return (uint32_t)((uint32_t)h + (uint32_t)t.size);
}

typedef struct entry {
  struct entry *next;
  const uint16_t *s;
  uint32_t n, h;
  int32_t count;
} entry;

static uint32_t hash_units(const uint16_t *s, uint32_t n) {
  uint32_t d = 2166136261u;
  for (uint32_t i = 0; i < n; i++) d = (d ^ s[i]) * 16777619u;
  return d;
}

static uint64_t word_count(uint64_t n) {
  static uint16_t vocab[500][10];
  static uint32_t vlen[500];
  for (uint32_t i = 0; i < 500; i++) {
    uint32_t v = i * 7, l = 0;
    uint16_t tmp[6];
    vocab[i][l++] = 'w';
    uint32_t d = 0;
    do {
      tmp[d++] = (uint16_t)('0' + v % 10);
      v /= 10;
    } while (v != 0);
    while (d > 0) vocab[i][l++] = tmp[--d];
    vocab[i][l++] = 'x';
    vlen[i] = l;
  }
  uint32_t cap = 1024, len = 0;
  uint16_t *text = arena(cap * 2);
  uint32_t x = 1;
  for (uint32_t i = 0; i < n; i++) {
    x = lcg(x);
    uint32_t w = x % 500;
    if (len + vlen[w] + 1 > cap) {
      uint16_t *t = arena(cap * 4);
      for (uint32_t k = 0; k < len; k++) t[k] = text[k];
      text = t;
      cap *= 2;
    }
    for (uint32_t k = 0; k < vlen[w]; k++) text[len++] = vocab[w][k];
    text[len++] = ' ';
  }
  enum { BUCKETS = 1024 };
  entry **heads = arena(BUCKETS * sizeof(entry *));
  for (int i = 0; i < BUCKETS; i++) heads[i] = NULL;
  entry *all[501];
  uint32_t nall = 0;
  uint32_t start = 0;
  for (uint32_t i = 0; i < len; i++) {
    if (text[i] != ' ') continue;
    uint32_t wn = i - start;
    uint16_t *copy = arena(wn * 2);
    for (uint32_t k = 0; k < wn; k++) copy[k] = text[start + k];
    uint32_t h = hash_units(copy, wn);
    entry *e = heads[h & (BUCKETS - 1)];
    for (; e != NULL; e = e->next) {
      if (e->h == h && e->n == wn) {
        uint32_t k = 0;
        while (k < wn && e->s[k] == copy[k]) k++;
        if (k == wn) break;
      }
    }
    if (e == NULL) {
      e = arena(sizeof(entry));
      e->next = heads[h & (BUCKETS - 1)];
      heads[h & (BUCKETS - 1)] = e;
      e->s = copy;
      e->n = wn;
      e->h = h;
      e->count = 0;
      all[nall++] = e;
    }
    e->count++;
    start = i + 1;
  }
  uint32_t t = 0;
  for (uint32_t i = 0; i < nall; i++) t += (uint32_t)all[i]->count * (uint32_t)all[i]->count;
  return t;
}

__attribute__((section(".text.entry"))) uint64_t c_bench(uint64_t which, uint64_t p0, uint64_t n0,
                                                         uint64_t p1, uint64_t n1, uint64_t x) {
  (void)p1;
  (void)n1;
  (void)x;
  bump = (uint8_t *)p0;
  switch (which) {
    case 0:
      return concat_work(n0);
    case 1:
      return map_mix(n0);
    default:
      return word_count(n0);
  }
}
