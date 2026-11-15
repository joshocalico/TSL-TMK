// Which pinned tirhashes R4 moves (SPEC M5's R4 record, D74), and why. Found by computing every pinned tirhash (pre-std,
// strict, modes, rc off, pre-strings, opt, maps, lang-a and pipe-a's TSL-route pins) with R4's tree as it is, once with
// AUTO_RC off and once on, and comparing: with it off none moved that an earlier list doesn't already account for; with it
// on these 13 programs' `rc` builds moved, at -O0 (pre-std, pre-strings), -O1 and -O2 (opt), and nothing else. Only `rc`
// builds in `auto`: a build with an rc option of D39's heap's own (the collector off, checks, counters) stays direct.
const VIA_TSL =
  "auto now builds it in rc through the TSL route (R4: AUTO_RC on): class printing counted by tslc's expansion onto @tsl/gc, where it was down-lowering's counted heap (D39); the dual route shows the two agree";

export const R4_MOVED: Record<string, string> = {
  "corpus/lower/pos/float_rem.ts": VIA_TSL,
  "corpus/lower/pos/floor_div.ts": VIA_TSL,
  "corpus/lower/pos/literal_param.ts": VIA_TSL,
  "corpus/lower/pos/number_float.ts": VIA_TSL,
  "corpus/lower/pos/number_int.ts": VIA_TSL,
  "corpus/lower/pos/object_is.ts": VIA_TSL,
  "corpus/lower/fallback/closure_outlives.ts": VIA_TSL,
  "corpus/lower/fallback/escape_global.ts": VIA_TSL,
  "corpus/lower/fallback/inheritance.ts": VIA_TSL,
  "corpus/lower/memory/store_closure.ts": VIA_TSL,
  "corpus/native/math_values.ts": VIA_TSL,
  "bench/memory/list_lowered.ts": VIA_TSL,
  "bench/memory/churn_lowered.ts": VIA_TSL,
};

/** A pin R4 moved: one of these programs' `rc` builds in `auto`, at any level (`file@rc`, `file@rc@O1`, `file@rc@O2`). */
export const r4Moved = (k: string): boolean => {
  const [f, mode, level] = k.split("@");
  return (
    R4_MOVED[f!] !== undefined && mode === "rc" && (level === undefined || /^O\d$/.test(level))
  );
};
