// Which pinned tirhashes the pipeline's phase 2 moves, and why (SPEC M5, D64): TSL proper's classes made as fast as lowered
// objects, so class printing meets the speed rule. Each program is listed with the changes that move it, found by computing
// its tirhashes with one change on at a time (TMK_TSL_OPT_OFF). TSL proper only: no lowered program's pinned tirhash moves.
export const PIPE_B_MOVED: Record<string, string> = {
  "corpus/mem/alloc_heap.ts":
    "a class nothing of which can go stale is plain now (D64): its references are plain pointers, with no tag to mask, and in leak its objects have no prefix",
  "corpus/mem/alloc_slab.ts":
    "a class nothing of which can go stale is plain now (D64): its references are plain pointers, with no tag to mask, and in leak its objects have no prefix",
  "corpus/mem/alloc_vec.ts":
    "a class nothing of which can go stale is plain now (D64): its references are plain pointers, with no tag to mask, and in leak its objects have no prefix",
  "corpus/mem/closures.ts":
    "a class nothing of which can go stale is plain now (D64): its references are plain pointers, with no tag to mask, and in leak its objects have no prefix",
  "corpus/mem/gen_adversarial.ts":
    "a class nothing of which can go stale is plain now (D64): its references are plain pointers, with no tag to mask, and in leak its objects have no prefix",
  "corpus/mem/inline_mem.ts":
    "a class nothing of which can go stale is plain now (D64): its references are plain pointers, with no tag to mask, and in leak its objects have no prefix",
  "corpus/mem/lang_misc.ts":
    "at -O1 and -O2 a second mask of one reference in a block is the first (D64); and a class nothing of which can go stale is plain now (D64): its references are plain pointers, with no tag to mask, and in leak its objects have no prefix",
  "corpus/mem/layout.ts":
    "at -O1 and -O2 a second mask of one reference in a block is the first (D64)",
  "corpus/mem/plain_class.ts":
    "a class nothing of which can go stale is plain now (D64): its references are plain pointers, with no tag to mask, and in leak its objects have no prefix",
  "corpus/memory/leak/leak_exhaust.ts":
    "at -O1 and -O2 a second mask of one reference in a block is the first (D64); and a class nothing of which can go stale is plain now (D64): its references are plain pointers, with no tag to mask, and in leak its objects have no prefix",
  "corpus/memory/leak/leak_list.ts":
    "at -O1 and -O2 a second mask of one reference in a block is the first (D64); and a class nothing of which can go stale is plain now (D64): its references are plain pointers, with no tag to mask, and in leak its objects have no prefix",
  "corpus/memory/leak/leak_pages.ts":
    "at -O1 and -O2 a second mask of one reference in a block is the first (D64); and a class nothing of which can go stale is plain now (D64): its references are plain pointers, with no tag to mask, and in leak its objects have no prefix",
  "corpus/memory/leak/leak_slab.ts":
    "at -O1 and -O2 a second mask of one reference in a block is the first (D64)",
  "corpus/memory/manual/manual_free.ts":
    "at -O1 and -O2 a second mask of one reference in a block is the first (D64); and a class nothing of which can go stale is plain now (D64): its references are plain pointers, with no tag to mask, and in leak its objects have no prefix",
  "corpus/memory/manual/manual_list.ts":
    "at -O1 and -O2 a second mask of one reference in a block is the first (D64); and a class nothing of which can go stale is plain now (D64): its references are plain pointers, with no tag to mask, and in leak its objects have no prefix",
  "corpus/memory/manual/manual_pages.ts":
    "at -O1 and -O2 a second mask of one reference in a block is the first (D64); and a class nothing of which can go stale is plain now (D64): its references are plain pointers, with no tag to mask, and in leak its objects have no prefix",
  "corpus/memory/manual/manual_slab.ts":
    "at -O1 and -O2 a second mask of one reference in a block is the first (D64)",
  "corpus/memory/strict_user.ts":
    "at -O1 and -O2 a second mask of one reference in a block is the first (D64); and a class nothing of which can go stale is plain now (D64): its references are plain pointers, with no tag to mask, and in leak its objects have no prefix",
  "corpus/spec/run_memory.ts":
    "a class nothing of which can go stale is plain now (D64): its references are plain pointers, with no tag to mask, and in leak its objects have no prefix",
  "corpus/std/builder.ts":
    "at -O1 and -O2 a second mask of one reference in a block is the first (D64); and a class nothing of which can go stale is plain now (D64): its references are plain pointers, with no tag to mask, and in leak its objects have no prefix",
  "corpus/std/ergo_alloc.ts":
    "a class nothing of which can go stale is plain now (D64): its references are plain pointers, with no tag to mask, and in leak its objects have no prefix",
  "corpus/std/nosource/std_no_source.ts":
    "at -O1 and -O2 a second mask of one reference in a block is the first (D64); and a class nothing of which can go stale is plain now (D64): its references are plain pointers, with no tag to mask, and in leak its objects have no prefix",
  "corpus/std/sort.ts":
    "at -O1 and -O2 a second mask of one reference in a block is the first (D64); and a class nothing of which can go stale is plain now (D64): its references are plain pointers, with no tag to mask, and in leak its objects have no prefix",
  "corpus/std/stack_holders.ts":
    "at -O1 and -O2 a second mask of one reference in a block is the first (D64); and a class nothing of which can go stale is plain now (D64): its references are plain pointers, with no tag to mask, and in leak its objects have no prefix",
  "corpus/std/std_default.ts":
    "at -O1 and -O2 a second mask of one reference in a block is the first (D64); and a class nothing of which can go stale is plain now (D64): its references are plain pointers, with no tag to mask, and in leak its objects have no prefix",
  "corpus/std/std_gen_adversarial.ts":
    "at -O1 and -O2 a second mask of one reference in a block is the first (D64); and a class nothing of which can go stale is plain now (D64): its references are plain pointers, with no tag to mask, and in leak its objects have no prefix",
  "corpus/std/std_replaced.ts":
    "at -O1 and -O2 a second mask of one reference in a block is the first (D64); and a class nothing of which can go stale is plain now (D64): its references are plain pointers, with no tag to mask, and in leak its objects have no prefix",
  "corpus/std/std_slab_safety.ts":
    "at -O1 and -O2 a second mask of one reference in a block is the first (D64); and a class nothing of which can go stale is plain now (D64): its references are plain pointers, with no tag to mask, and in leak its objects have no prefix",
  "corpus/std/std_vec_safety.ts":
    "at -O1 and -O2 a second mask of one reference in a block is the first (D64); and a class nothing of which can go stale is plain now (D64): its references are plain pointers, with no tag to mask, and in leak its objects have no prefix",
  "corpus/std/tree.ts":
    "at -O1 and -O2 a second mask of one reference in a block is the first (D64); and a class nothing of which can go stale is plain now (D64): its references are plain pointers, with no tag to mask, and in leak its objects have no prefix",
};

export const pipeBMoved = (k: string): boolean =>
  Object.keys(PIPE_B_MOVED).some((p) => k === p || k.startsWith(`${p}@`));
