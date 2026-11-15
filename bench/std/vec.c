// Hand-written C doing what vecPushRead does in bench/std. Built as bench/alloc/alloc.c is, and run the same way.
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

__attribute__((section(".text.entry"))) uint64_t c_bench(uint64_t which, uint64_t p0, uint64_t n0,
                                                         uint64_t p1, uint64_t n1, uint64_t x) {
  (void)which;
  (void)p1;
  (void)n1;
  (void)x;
  uint8_t *bump = (uint8_t *)p0;
  uint32_t n = (uint32_t)n0;
  uint32_t cap = 4, len = 0;
  uint32_t *a = (uint32_t *)bump;
  bump += cap * 4;
  for (uint32_t i = 0; i < n; i++) {
    if (len == cap) {
      uint32_t *next = (uint32_t *)bump;
      bump += cap * 8;
      memcpy(next, a, len * 4);
      a = next;
      cap *= 2;
    }
    a[len++] = i;
  }
  uint32_t s = 0;
  for (uint32_t i = 0; i < n; i++) s += a[i];
  return s + len;
}
