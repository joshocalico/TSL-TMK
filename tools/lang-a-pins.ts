// Which pinned tirhashes language phase A moves, and why (SPEC M5, Language phase A).
/**
 * Language phase A (D49, D50): programs whose module uses exceptions, classes or `typeof` and now lowers in a mode, and two
 * that reach `toString(radix)`, whose RangeError's message was wrong and is now V8's. Their tirhashes move in a mode, and
 * `tmk milestone lang-a` pins them in corpus/memory/lang-a-tirhash.json. Strict's don't move.
 */
export const LANG_A_MOVED: Record<string, string> = {
  "corpus/lower/fallback/inheritance.ts": "extends, which lowers in a mode (D50)",
  "corpus/lower/fallback/reflection.ts": "typeof of a number, known from its shape in a mode",
  "corpus/lower/fallback/throw_value.ts":
    "throw 5 and an Error as a value, which lower in a mode (D49)",
  "corpus/lower/fallback/try_catch.ts": "try/catch, which lowers in a mode (D49)",
  "corpus/lower/strmap/app_json.ts":
    "reaches toString(radix), whose RangeError message is now V8's",
  "corpus/lower/strmap/num_text.ts":
    "reaches toString(radix), whose RangeError message is now V8's",
};
