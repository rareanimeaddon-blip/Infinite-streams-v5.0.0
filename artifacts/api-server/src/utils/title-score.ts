function normalize(s: string): string {
  return s
    .toLowerCase()
    // Collapse abbreviation dots before stripping punctuation:
    // "K.G.F" → "kgf",  "U.S.A." → "usa"
    .replace(/([a-z])\./g, "$1")
    .replace(/[^\w\s]/g, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s: string): Set<string> {
  return new Set(normalize(s).split(" ").filter((w) => w.length > 1));
}

export function titleSimilarityScore(a: string, b: string): number {
  if (!a || !b) return 0;

  const na = normalize(a);
  const nb = normalize(b);

  if (na === nb) return 1.0;

  // Collapsed comparison: "Shin Chan" ↔ "Shinchan", "Shin-chan" ↔ "Shinchan", etc.
  // Handles titles written as one word vs. two (common in anime/Bollywood transliterations).
  const naCollapsed = na.replace(/\s+/g, "");
  const nbCollapsed = nb.replace(/\s+/g, "");
  if (naCollapsed === nbCollapsed) return 0.96;

  const tokensA = tokenize(a);
  const tokensB = tokenize(b);

  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }

  const union = tokensA.size + tokensB.size - intersection;
  const jaccard = intersection / union;

  // containsBonus: reward when query contains result (result is a "clean core" of the query)
  // but do NOT reward when result contains query and is much longer — that means the result is
  // a different, more-specific work (e.g. "Shin-chan: Me and the Professor..." for query "Shin-chan").
  const lengthRatio = tokensA.size / Math.max(tokensB.size, 1);
  const containsBonus =
    na.includes(nb) ? 0.15 :                                      // result ⊆ query (exact subset)
    nb.includes(na) && lengthRatio >= 0.6 ? 0.10 :                // query ⊆ result, but not much longer
    0;

  // Penalise when the result title is significantly longer than the search query.
  // Threshold 0.6: if query has fewer than 60% of result's tokens, it's likely a different work.
  const lengthPenalty = lengthRatio < 0.6 ? (0.6 - lengthRatio) * 0.7 : 0;

  return Math.min(1, Math.max(0, jaccard + containsBonus - lengthPenalty));
}
