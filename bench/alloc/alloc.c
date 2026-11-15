// Hand-written C doing what bench/alloc/alloc.ts does, with the same allocator design as ex-heap.ts, for
// `tmk bench alloc`. Built with clang -O2 -ffp-contract=off, and run in the same image by the same loop.
#include <stddef.h>
#include <stdint.h>

// No libc. Volatile, so clang can't turn these loops back into calls to themselves.
void *memset(void *d, int c, size_t n) {
  volatile uint8_t *p = d;
  while (n--) *p++ = (uint8_t)c;
  return d;
}
void *memcpy(void *d, const void *s, size_t n) {
  volatile uint64_t *p = d;
  const volatile uint64_t *q = s;
  for (; n >= 8; n -= 8) *p++ = *q++;
  volatile uint8_t *pb = (volatile uint8_t *)p;
  const volatile uint8_t *qb = (const volatile uint8_t *)q;
  while (n--) *pb++ = *qb++;
  return d;
}

#define PAGE 4096u
#define CLASSES 8u

typedef struct {
  uint8_t *pool;
  size_t used;
  uint64_t *heads;
  uint8_t *bump, *bump_end;
} heap_t;

static uint8_t *pages(heap_t *h, size_t n) {
  uint8_t *at = h->pool + h->used * PAGE;
  h->used += n;
  for (size_t i = 0; i < n * PAGE / 8; i++) ((uint64_t *)at)[i] = 0;
  return at;
}

static unsigned class_of(size_t bytes) {
  size_t size = 16;
  for (unsigned c = 0; c < CLASSES; c++) {
    if (bytes <= size) return c;
    size *= 2;
  }
  return CLASSES;
}

static void *heap_alloc(heap_t *h, size_t bytes) {
  if (h->heads == NULL) {
    uint8_t *first = pages(h, 1);
    h->heads = (uint64_t *)first;
    h->bump = first + 64;
    h->bump_end = first + PAGE;
  }
  unsigned c = class_of(bytes);
  if (c == CLASSES) return pages(h, (bytes + PAGE - 1) / PAGE);
  uint64_t block = h->heads[c];
  if (block != 0) {
    h->heads[c] = *(uint64_t *)block;
    return (void *)block;
  }
  size_t size = (size_t)16 << c;
  uintptr_t at = (((uintptr_t)h->bump + size - 1) / size) * size;
  if (at + size > (uintptr_t)h->bump_end) {
    uint8_t *page = pages(h, 1);
    h->bump = page + size;
    h->bump_end = page + PAGE;
    return page;
  }
  h->bump = (uint8_t *)(at + size);
  return (void *)at;
}

static void heap_free(heap_t *h, void *p, size_t bytes) {
  unsigned c = class_of(bytes);
  if (c == CLASSES) return;
  *(uint64_t *)p = h->heads[c];
  h->heads[c] = (uint64_t)p;
}

static uint32_t vec_push(uint8_t *pool, size_t n) {
  heap_t h = {pool, 0, NULL, NULL, NULL};
  uint32_t *buf = NULL;
  size_t len = 0, cap = 0;
  for (size_t i = 0; i < n; i++) {
    if (len == cap) {
      size_t next_cap = cap == 0 ? 4 : cap * 2;
      uint32_t *next = heap_alloc(&h, next_cap * 4);
      if (next == NULL) return 0;
      if (buf != NULL) {
        memcpy(next, buf, len * 4);
        heap_free(&h, buf, cap * 4);
      }
      buf = next;
      cap = next_cap;
    }
    buf[len++] = (uint32_t)i;
  }
  uint32_t r = buf[n - 1] + (uint32_t)len;
  heap_free(&h, buf, cap * 4);
  return r;
}

typedef struct {
  uint64_t a;
  uint32_t b, c;
} item_t;

typedef struct slot {
  struct slot *link;
  uint32_t gen, owner;
  item_t item;
} slot_t;

#define CHUNK 64u

typedef struct {
  heap_t *h;
  uint64_t chunks;
  slot_t *free_list;
  size_t count;
  uint32_t owner;
} slab_t;

static void slab_grow(slab_t *s) {
  uint8_t *chunk = heap_alloc(s->h, 16 + CHUNK * sizeof(slot_t));
  *(uint64_t *)chunk = s->chunks;
  s->chunks = (uint64_t)chunk;
  for (unsigned i = CHUNK; i > 0; i--) {
    slot_t *slot = (slot_t *)(chunk + 16 + (i - 1) * sizeof(slot_t));
    slot->gen = 0;
    slot->owner = s->owner;
    slot->link = s->free_list;
    s->free_list = slot;
  }
}

static item_t *slab_add(slab_t *s, uint64_t a, uint32_t b, uint32_t c) {
  if (s->free_list == NULL) slab_grow(s);
  slot_t *slot = s->free_list;
  s->free_list = slot->link;
  slot->gen++;
  s->count++;
  slot->item = (item_t){a, b, c};
  return &slot->item;
}

static void slab_remove(slab_t *s, item_t *it) {
  slot_t *slot = (slot_t *)((uint8_t *)it - 16);
  if (slot->owner != s->owner || (slot->gen & 1) == 0) __builtin_trap();
  slot->gen++;
  s->count--;
  slot->link = s->free_list;
  s->free_list = slot;
}

static uint32_t slab_cycle(uint8_t *pool, size_t rounds, size_t n) {
  heap_t h = {pool, 0, NULL, NULL, NULL};
  slab_t s = {&h, 0, NULL, 0, 1};
  item_t **refs = heap_alloc(&h, n * 8);
  for (size_t i = 0; i < n; i++) refs[i] = slab_add(&s, i, 1, 2);
  uint32_t sum = 0;
  for (size_t round = 0; round < rounds; round++) {
    for (size_t i = 0; i < n; i++) slab_remove(&s, refs[i]);
    for (size_t i = 0; i < n; i++) refs[i] = slab_add(&s, i, (uint32_t)round & 0xff, 2);
    sum += refs[round % n]->b;
  }
  heap_free(&h, refs, n * 8);
  return sum;
}

typedef struct node {
  struct node *next;
  uint64_t val;
} node_t;

static node_t *list_head;

static uint64_t walk_list(uint8_t *pool, size_t n, size_t rounds) {
  if (list_head == NULL) {
    node_t *nodes = (node_t *)pool;
    for (size_t i = 0; i < n; i++) {
      nodes[i].val = i;
      nodes[i].next = list_head;
      list_head = &nodes[i];
    }
  }
  uint64_t sum = 0;
  for (size_t r = 0; r < rounds; r++) {
    for (volatile node_t *cur = list_head; cur != NULL; cur = cur->next) sum += cur->val;
  }
  return sum;
}

__attribute__((section(".text.entry"))) uint64_t c_bench(uint64_t which, uint64_t p0, uint64_t n0,
                                                         uint64_t p1, uint64_t n1, uint64_t x) {
  (void)n1;
  (void)x;
  switch (which) {
    case 0:
      return vec_push((uint8_t *)p0, n0);
    case 1:
      return slab_cycle((uint8_t *)p0, n0, p1);
    default:
      return walk_list((uint8_t *)p0, n0, p1);
  }
}
