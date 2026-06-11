/**
 * Find every non-overlapping, case-insensitive occurrence of `needle` in `haystack`.
 * Returns `[start, end)` character offsets. A needle that is empty or all-whitespace
 * matches nothing.
 *
 * Pure (no DOM, no React) so it can be unit-tested under vitest's node environment;
 * `useTranscriptSearch` maps these offsets onto the rendered text nodes as DOM Ranges.
 */
export function findMatches(haystack: string, needle: string): Array<[number, number]> {
  if (!needle.trim()) return []
  const hay = haystack.toLowerCase()
  const ndl = needle.toLowerCase()
  const out: Array<[number, number]> = []
  let from = 0
  // Cap the per-node match count so a 1-char query against a huge text node can't run away.
  while (out.length < 10000) {
    const i = hay.indexOf(ndl, from)
    if (i === -1) break
    out.push([i, i + ndl.length])
    from = i + ndl.length
  }
  return out
}
