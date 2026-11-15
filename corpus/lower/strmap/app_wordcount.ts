// A word count, as ordinary TS writes one: split, a Map, sort the entries, print a table.
const TEXT = `It was the best of times, it was the worst of times, it was the age of wisdom,
it was the age of foolishness, it was the epoch of belief, it was the epoch of incredulity.
Déjà vu: naïve café – 日本語のテキスト 😀 😀 and the rest of the times.`;

function isWordChar(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c >= 128;
}

function lower(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i]!;
  }
  return out;
}

export function words(text: string): string[] {
  const out: string[] = [];
  let start = -1;
  for (let i = 0; i <= text.length; i++) {
    const w = i < text.length && isWordChar(text.charCodeAt(i));
    if (w && start < 0) start = i;
    if (!w && start >= 0) {
      out.push(lower(text.slice(start, i)));
      start = -1;
    }
  }
  return out;
}

export function count(text: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of words(text)) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
}

export function top(text: string, n: number): string[] {
  const entries = [...count(text)];
  entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries.slice(0, n).map(([w, c]) => `${w}: ${c}`);
}

export function table(): string {
  const lines: string[] = [];
  for (const [w, c] of count(TEXT)) {
    if (c > 1) lines.push(`${w.padEnd(12, ".")}${String(c).padStart(3)}`);
  }
  return lines.join("\n");
}

export function bySplit(text: string): number {
  const seen = new Set<string>();
  for (const line of text.split("\n"))
    for (const w of line.split(" ")) if (w !== "") seen.add(w.trim());
  return seen.size;
}

export function repeated(text: string, times: number): number {
  let total = 0;
  for (let i = 0; i < times; i++) total += count(text).size;
  return total;
}

export function builtin(): string[] {
  return top(TEXT, 8);
}
