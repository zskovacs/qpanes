/**
 * Quick Filter matching policy (pure, no IPC):
 * - Unicode NFC normalization, so composed and decomposed names (common on
 *   macOS) match the same typed text.
 * - `String.prototype.toLowerCase`, i.e. the locale-independent Unicode default
 *   lowercase mapping. This is not full case folding: `ß` does not match `ss`,
 *   final/medial sigma are distinct, Turkish dotted/dotless I follow default
 *   (not Turkish locale) rules, and accents are significant.
 * - Substring match on the display name; the query is used literally
 *   (including spaces). An empty query disables filtering.
 */
export function filterKey(text: string): string {
  return text.normalize('NFC').toLowerCase();
}

/** Indices of matching keys in their original (already sorted) order. */
export function matchingIndices(keys: readonly string[], query: string): number[] {
  const needle = filterKey(query);
  const result: number[] = [];
  for (let index = 0; index < keys.length; index++) {
    if (keys[index].includes(needle)) result.push(index);
  }
  return result;
}

export function matchesFilter(name: string, query: string): boolean {
  return !query || filterKey(name).includes(filterKey(query));
}
