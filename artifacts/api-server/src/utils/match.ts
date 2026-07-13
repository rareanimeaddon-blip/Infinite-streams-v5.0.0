/**
 * Universal search-result matching system.
 *
 * Every provider that scrapes a list of search results from a third-party
 * site should hand that list to `findBestMatch` (or `findBestMatchWithRetry`)
 * instead of taking `results[0]` or rolling its own ad-hoc scoring. This is
 * the single place that decides "which of these search results is the one
 * the user actually asked for" — it does NOT touch how a provider fetches or
 * parses its search results (that scraping logic is untouched).
 *
 * Design goals (see replit.md "Universal matching system" section):
 *  - Never blindly pick the first result.
 *  - Score every candidate with a transparent, debuggable weighted formula.
 *  - Use year/type/season/episode as scoring signals, not hard filters, so a
 *    slightly-off year (common with regional release dates) doesn't reject an
 *    otherwise-correct match.
 *  - Support alternate titles (original title, aliases, IMDB/TMDB titles) so a
 *    provider can retry with different query strings and still get a single,
 *    consistent scoring pass across every attempt.
 */

import { logger } from "../lib/logger.js";

export type ContentType = "movie" | "series";

export interface MatchQuery {
  /** Primary title to match against (usually what was searched for). */
  title: string;
  /** Original-language title, if known (e.g. from TMDB `original_title`). */
  originalTitle?: string;
  /** Alternate titles / aliases (dubs, regional titles, TMDB alternative_titles, etc). */
  aliases?: string[];
  year?: number;
  type?: ContentType;
  season?: number;
  episode?: number;
}

export interface MatchCandidate<T = unknown> {
  title: string;
  originalTitle?: string;
  aliases?: string[];
  year?: number;
  type?: ContentType;
  season?: number;
  episode?: number;
  /** The provider's own search-result object, returned back unchanged on a match. */
  raw: T;
}

export interface ScoredCandidate<T = unknown> {
  candidate: MatchCandidate<T>;
  score: number;
  breakdown: Record<string, number>;
  /** Which title field produced the winning text score: "title" | "originalTitle" | "alias:<value>". */
  matchedOn: string;
}

export interface FindBestMatchOptions {
  /** Provider name, used only for log lines, e.g. "HDHub4U". */
  provider: string;
  /** Minimum composite score (0-1) required to accept a candidate. Default 0.45. */
  threshold?: number;
  /** The literal query string that was sent to the provider's search endpoint (for logging). */
  query?: string;
  /** Suppress per-candidate debug logging (still logs the summary). Default false. */
  quiet?: boolean;
}

export interface FindBestMatchResult<T = unknown> {
  best: MatchCandidate<T> | null;
  score: number;
  breakdown: Record<string, number>;
  matchedOn: string;
  reason: string;
  /** All candidates, ranked best-first. */
  ranked: ScoredCandidate<T>[];
}

// ─── Text normalization ─────────────────────────────────────────────────────

// Quality / release-noise tags that should never influence title comparison.
const QUALITY_TAGS =
  /\b(4k|2160p|1080p|720p|480p|360p|hd|fhd|uhd|hdr|web[-\s]?dl|webrip|web|bluray|blu-ray|brrip|bdrip|dvdrip|hdrip|hdtv|hdcam|cam|dual audio|multi audio|dual[-\s]?audio|multi[-\s]?audio|x264|x265|hevc|h264|h265|10bit|esub|esubs|msubs|amzn|nf|hin|eng|hindi|english|dubbed|dub|subbed|sub|season\s*\d+|s\d{1,2}|complete|full)\b/gi;

const STOP_WORDS = new Set(["the", "a", "an", "of", "in", "at", "to", "with", "and", "or", "for", "on"]);

/** Lowercase, strip punctuation, collapse whitespace. */
function baseNormalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/([a-z])\./g, "$1") // "K.G.F" -> "kgf"
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Full normalization used for the "normalized title match" signal: strips quality tags too. */
function normalizeStripQuality(s: string): string {
  const withoutQuality = s.replace(QUALITY_TAGS, " ");
  return baseNormalize(withoutQuality);
}

function tokenize(s: string): string[] {
  return baseNormalize(s).split(" ").filter(Boolean);
}

function significantTokens(s: string): string[] {
  return tokenize(s).filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

/** Character bigrams, used for the fuzzy (Dice coefficient) similarity signal. */
function bigrams(s: string): string[] {
  const clean = baseNormalize(s).replace(/\s+/g, "");
  const out: string[] = [];
  for (let i = 0; i < clean.length - 1; i++) out.push(clean.slice(i, i + 2));
  return out;
}

function diceCoefficient(a: string, b: string): number {
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.length === 0 || bb.length === 0) return ba.length === bb.length ? 1 : 0;
  const counts = new Map<string, number>();
  for (const g of ba) counts.set(g, (counts.get(g) ?? 0) + 1);
  let matches = 0;
  for (const g of bb) {
    const c = counts.get(g) ?? 0;
    if (c > 0) {
      matches++;
      counts.set(g, c - 1);
    }
  }
  return (2 * matches) / (ba.length + bb.length);
}

// ─── Title-vs-title text scoring ────────────────────────────────────────────

interface TextScoreBreakdown {
  exact: number;
  normalized: number;
  fuzzy: number;
  wholeWord: number;
  startsWith: number;
  score: number;
}

/**
 * Scores how well a single candidate title string matches a single query title
 * string, combining: exact match, normalized (punctuation/case/quality-tag
 * insensitive) match, fuzzy bigram+token similarity, whole-word overlap, and
 * starts-with matching. Weighted average, 0-1.
 */
function scoreTitleText(query: string, candidate: string): TextScoreBreakdown {
  if (!query || !candidate) {
    return { exact: 0, normalized: 0, fuzzy: 0, wholeWord: 0, startsWith: 0, score: 0 };
  }

  const exact = query.trim().toLowerCase() === candidate.trim().toLowerCase() ? 1 : 0;

  const nq = normalizeStripQuality(query);
  const nc = normalizeStripQuality(candidate);
  let normalized = nq === nc ? 1 : 0;
  // Collapsed comparison: "Shin Chan" <-> "Shinchan"
  if (!normalized && nq.replace(/\s+/g, "") === nc.replace(/\s+/g, "")) normalized = 0.92;

  const tokenJaccardOf = (): number => {
    const qa = new Set(significantTokens(nq));
    const ca = new Set(significantTokens(nc));
    if (qa.size === 0 || ca.size === 0) return 0;
    let intersection = 0;
    for (const t of qa) if (ca.has(t)) intersection++;
    const union = qa.size + ca.size - intersection;
    return union === 0 ? 0 : intersection / union;
  };
  const fuzzy = 0.5 * tokenJaccardOf() + 0.5 * diceCoefficient(nq, nc);

  const qSig = significantTokens(nq);
  const cSigSet = new Set(significantTokens(nc));
  const wholeWord =
    qSig.length === 0 ? 0 : qSig.filter((w) => cSigSet.has(w)).length / qSig.length;

  let startsWith = 0;
  if (nc.startsWith(nq) || nq.startsWith(nc)) startsWith = 1;
  else {
    const qFirst = nq.split(" ")[0];
    const cFirst = nc.split(" ")[0];
    if (qFirst && cFirst && qFirst === cFirst) startsWith = 0.5;
  }

  const score =
    exact * 0.35 + normalized * 0.25 + fuzzy * 0.2 + wholeWord * 0.1 + startsWith * 0.1;

  return { exact, normalized, fuzzy, wholeWord, startsWith, score: Math.min(1, score) };
}

/**
 * Scores a query title against every title a candidate carries (main title,
 * original title, aliases) and returns the best one, tagged with which field
 * won so debug logs can explain the pick.
 */
function bestTitleScore(
  query: MatchQuery,
  candidate: MatchCandidate,
): { score: number; breakdown: TextScoreBreakdown; matchedOn: string } {
  const attempts: Array<{ label: string; text: string }> = [{ label: "title", text: candidate.title }];
  if (candidate.originalTitle) attempts.push({ label: "originalTitle", text: candidate.originalTitle });
  for (const alias of candidate.aliases ?? []) attempts.push({ label: `alias:${alias}`, text: alias });

  const queryTitles = [query.title, query.originalTitle, ...(query.aliases ?? [])].filter(
    (t): t is string => !!t,
  );

  let best: { score: number; breakdown: TextScoreBreakdown; matchedOn: string } | null = null;
  for (const q of queryTitles) {
    for (const a of attempts) {
      const breakdown = scoreTitleText(q, a.text);
      if (!best || breakdown.score > best.score) {
        best = { score: breakdown.score, breakdown, matchedOn: a.label };
      }
    }
  }
  return best ?? { score: 0, breakdown: scoreTitleText("", ""), matchedOn: "title" };
}

// ─── Meta (year / type / season-episode) scoring ────────────────────────────

function scoreYear(query?: number, candidate?: number): number {
  if (!query || !candidate) return 0.5; // unknown — neutral, never a hard filter
  const diff = Math.abs(query - candidate);
  if (diff === 0) return 1;
  if (diff === 1) return 0.6; // regional release date drift is common
  if (diff === 2) return 0.3;
  return 0.05;
}

function scoreType(query?: ContentType, candidate?: ContentType): number {
  if (!query || !candidate) return 0.5;
  return query === candidate ? 1 : 0;
}

function scoreSeasonEpisode(query: MatchQuery, candidate: MatchCandidate): number {
  if (query.type !== "series") return 1; // n/a for movies
  if (query.season == null || candidate.season == null) return 0.7; // unknown — mild neutral
  if (query.season !== candidate.season) return 0.15;
  if (query.episode == null || candidate.episode == null) return 1;
  return query.episode === candidate.episode ? 1 : 0.6;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function scoreCandidate<T>(
  query: MatchQuery,
  candidate: MatchCandidate<T>,
): { score: number; breakdown: Record<string, number>; matchedOn: string } {
  const text = bestTitleScore(query, candidate);
  const year = scoreYear(query.year, candidate.year);
  const type = scoreType(query.type, candidate.type);
  const seasonEpisode = scoreSeasonEpisode(query, candidate);

  const score = text.score * 0.6 + year * 0.1 + type * 0.2 + seasonEpisode * 0.1;

  return {
    score: Math.min(1, Math.max(0, score)),
    matchedOn: text.matchedOn,
    breakdown: {
      textScore: round(text.score),
      exact: round(text.breakdown.exact),
      normalized: round(text.breakdown.normalized),
      fuzzy: round(text.breakdown.fuzzy),
      wholeWord: round(text.breakdown.wholeWord),
      startsWith: round(text.breakdown.startsWith),
      year: round(year),
      type: round(type),
      seasonEpisode: round(seasonEpisode),
    },
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

const DEFAULT_THRESHOLD = 0.45;

/**
 * Ranks every candidate returned by a provider's search and returns the
 * single best match — never the first result. Logs the query, candidate
 * count, every candidate's score, the selected result, and why it was (or
 * wasn't) selected.
 */
export function findBestMatch<T>(
  query: MatchQuery,
  candidates: Array<MatchCandidate<T>>,
  options: FindBestMatchOptions,
): FindBestMatchResult<T> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;

  const ranked: ScoredCandidate<T>[] = candidates
    .map((candidate) => {
      const { score, breakdown, matchedOn } = scoreCandidate(query, candidate);
      return { candidate, score, breakdown, matchedOn };
    })
    .sort((a, b) => b.score - a.score);

  if (!options.quiet) {
    logger.debug(
      {
        provider: options.provider,
        query: options.query ?? query.title,
        resultCount: candidates.length,
        candidates: ranked.map((r) => ({
          title: r.candidate.title,
          year: r.candidate.year,
          type: r.candidate.type,
          score: round(r.score),
          matchedOn: r.matchedOn,
        })),
      },
      `[Match:${options.provider}] scored candidates`,
    );
  }

  const top = ranked[0];
  if (!top) {
    logger.info(
      { provider: options.provider, query: options.query ?? query.title },
      `[Match:${options.provider}] no candidates returned by search`,
    );
    return { best: null, score: 0, breakdown: {}, matchedOn: "", reason: "no candidates returned by search", ranked };
  }

  const passed = top.score >= threshold;
  const reason = passed
    ? `best candidate "${top.candidate.title}" scored ${round(top.score)} (>= threshold ${threshold}) via ${top.matchedOn}`
    : `best candidate "${top.candidate.title}" scored ${round(top.score)} which is below threshold ${threshold} — rejected as a likely mismatch`;

  logger.info(
    {
      provider: options.provider,
      query: options.query ?? query.title,
      resultCount: candidates.length,
      selected: passed ? top.candidate.title : null,
      score: round(top.score),
      threshold,
      breakdown: top.breakdown,
      reason,
    },
    `[Match:${options.provider}] ${passed ? "selected result" : "rejected — no match above threshold"}`,
  );

  if (!passed) {
    return { best: null, score: top.score, breakdown: top.breakdown, matchedOn: top.matchedOn, reason, ranked };
  }

  return { best: top.candidate, score: top.score, breakdown: top.breakdown, matchedOn: top.matchedOn, reason, ranked };
}

/**
 * Retries a search across several query-string variants (e.g. resolved
 * title, original title, aliases, IMDB title, TMDB title) until one of them
 * produces a candidate above threshold. Every attempt's candidates are
 * scored with the same `findBestMatch` pass.
 *
 * If NO attempt clears the threshold, this returns `best: null` — the
 * content is treated as not-found rather than guessing. This was changed
 * (2026-07-12) from an earlier "return the best-scoring candidate anyway"
 * fallback: every caller across the codebase trusts `.best` unconditionally
 * without checking `.score`, so that fallback was silently turning "this
 * title isn't in this provider's catalog" into "return some other,
 * unrelated title's streams instead" — e.g. searching a site with no "House"
 * (House M.D.) would confidently return "House of Cards" or "Little House
 * on the Prairie" streams instead of admitting no match. A missing stream is
 * an honest, visible gap; a wrong stream is a silent correctness bug — this
 * function must prefer the former.
 *
 * `result.ranked` still exposes every candidate seen (with scores) for
 * callers/logs that want the near-miss info even when `best` is null.
 */
export async function findBestMatchWithRetry<T>(
  query: MatchQuery,
  variantTitles: string[],
  search: (variantTitle: string) => Promise<Array<MatchCandidate<T>>>,
  options: FindBestMatchOptions,
): Promise<FindBestMatchResult<T>> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const tried = new Set<string>();
  // Track the best-scoring result across all attempts purely for logging /
  // `.ranked` visibility — it is never returned as `.best` unless it clears
  // the threshold. See the doc comment above for why.
  let bestSoFar: FindBestMatchResult<T> | null = null;

  for (const variant of variantTitles) {
    const key = variant.trim().toLowerCase();
    if (!key || tried.has(key)) continue;
    tried.add(key);

    let candidates: Array<MatchCandidate<T>>;
    try {
      candidates = await search(variant);
    } catch (err) {
      logger.warn({ provider: options.provider, variant, err }, `[Match:${options.provider}] retry search failed`);
      continue;
    }
    if (!candidates.length) continue;

    const result = findBestMatch({ ...query, title: variant }, candidates, {
      ...options,
      query: variant,
    });

    if (!bestSoFar || result.score > bestSoFar.score) bestSoFar = result;

    if (result.best && result.score >= threshold) {
      logger.info(
        { provider: options.provider, variant, score: round(result.score) },
        `[Match:${options.provider}] retry succeeded with variant "${variant}"`,
      );
      return result;
    }
  }

  if (bestSoFar && bestSoFar.score > 0) {
    logger.info(
      {
        provider: options.provider,
        triedVariants: [...tried],
        bestScore: round(bestSoFar.score),
        bestTitle: bestSoFar.best?.title ?? bestSoFar.ranked[0]?.candidate.title ?? null,
        threshold,
      },
      `[Match:${options.provider}] no variant cleared threshold — treating as not found (near-miss logged, not returned)`,
    );
  } else {
    logger.info(
      { provider: options.provider, triedVariants: [...tried] },
      `[Match:${options.provider}] no results found across any title variant`,
    );
  }

  return {
    best: null,
    score: bestSoFar?.score ?? 0,
    breakdown: bestSoFar?.breakdown ?? {},
    matchedOn: bestSoFar?.matchedOn ?? "",
    reason: bestSoFar
      ? `best candidate across all variants scored ${round(bestSoFar.score)}, below threshold ${threshold} — rejected`
      : "no results found across any title variant",
    ranked: bestSoFar?.ranked ?? [],
  };
}

/** Convenience: build the ordered list of title variants to retry with, from a resolved-meta object. */
export function buildRetryTitleVariants(opts: {
  title: string;
  originalTitle?: string;
  aliases?: string[];
}): string[] {
  const variants = [opts.title, opts.originalTitle, ...(opts.aliases ?? [])].filter(
    (t): t is string => !!t && t.trim().length > 0,
  );
  return [...new Set(variants)];
}
