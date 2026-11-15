// Hand-written C doing what bench/memory/manual/list_manual.ts does (0), and list_leak.ts (1), with the allocator
// design of ex-heap.ts cut down to its one size class. Built as bench/alloc/alloc.c is, and run the same way.
#include <stddef.h>
#include <stdint.h>

void *memset(void *d, int c, size_t n) {
  volatile uint8_t *p = d;
  while (n--) *p++ = (uint8_t)c;
  return d;
}

typedef struct node {
  struct node *next;
  uint32_t val;
} node_t;

static node_t *free_list;
static uint8_t *bump;
static node_t *volatile list_head;

static node_t *node_alloc(uint8_t *pool, int reuse) {
  if (reuse && free_list != NULL) {
    node_t *n = free_list;
    free_list = n->next;
    return n;
  }
  if (bump == NULL) bump = pool;
  node_t *n = (node_t *)bump;
  bump += sizeof(node_t);
  return n;
}

static uint64_t list_cycle(uint8_t *pool, uint64_t count, int frees) {
  node_t *h = NULL;
  for (uint32_t i = 0; i < count; i++) {
    node_t *c = node_alloc(pool, frees);
    c->val = i;
    c->next = h;
    h = c;
  }
  list_head = h;
  uint32_t t = 0;
  for (int r = 0; r < 4; r++) {
    for (volatile node_t *c = list_head; c != NULL; c = c->next) t += c->val;
  }
  if (frees) {
    while (list_head != NULL) {
      node_t *c = list_head;
      list_head = c->next;
      c->next = free_list;
      free_list = c;
    }
  }
  return t;
}

// What bench/memory/churn_lowered.ts does, with an explicit free of the whole window: a free list, as C would do it.
static node_t *volatile window_head;

static uint64_t churn_cycle(uint8_t *pool, uint64_t count) {
  uint32_t t = 0;
  uint32_t live = 0;
  for (uint32_t i = 0; i < count; i++) {
    node_t *c = node_alloc(pool, 1);
    c->val = i;
    c->next = window_head;
    window_head = c;
    live++;
    if (live == 64) {
      while (window_head != NULL) {
        node_t *d = window_head;
        window_head = d->next;
        d->next = free_list;
        free_list = d;
      }
      live = 0;
    }
    t += i;
  }
  return t;
}

__attribute__((section(".text.entry"))) uint64_t c_bench(uint64_t which, uint64_t p0, uint64_t n0,
                                                         uint64_t p1, uint64_t n1, uint64_t x) {
  (void)p1;
  (void)n1;
  (void)x;
  if (which == 2) return churn_cycle((uint8_t *)p0, n0);
  return list_cycle((uint8_t *)p0, n0, which == 0);
}
