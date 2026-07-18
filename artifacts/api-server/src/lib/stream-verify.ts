/**
 * Universal Content Verification Engine
 *
 * Runs after every provider resolver and before streams are returned to Stremio.
 * Detects title mismatches, type conflicts (movie vs series), and episode conflicts.
 *
 * Design principles:
 *  - Conservative: when evidence is absent, streams PASS (never over-reject).
 *  - Only reject on clear contradicting signals.
 *  - Does NOT touch stream URLs, headers, or any playback logic.
 *  - Internal fields (_resolvedTitle, _resolvedType, _idVerified) are stripped
 *    from every accepted stream before it reaches Stremio.
 */

import { titleSimilarityScore } from "../utils/title-score.js";
import { logger } from "./logger.js";

// ─── Public API ───────────────────────────────────────────────────────────────

export interface VerifyContext {
  /** Human-readable provider name for logging (e.g. "HDHub4U"). */
  provider: string;
  /** Official title resolved from Cinemeta/TMDB. */
  requestedTitle: string;
  /** "movie" or "series". */
  requestedType: "movie" | "series";
  /** Season number (1 for movies / no-season requests). */
  requestedSeason: number;
  /** Episode number (1 for movies / no-episode requests). */
  requestedEpisode: number;
  /** IMDb ID of the requested content, e.g. "tt0108778". */
  requestedImdbId?: string;
  /** Release year (optional, used for future year-based checks). */
  requestedYear?: number;
  /** Alternate titles from Cinemeta / TMDB alternative_titles. */
  aliases?: string[];
}

/**
 * Verify and filter a batch of streams from a single provider.
 *
 * Before calling this, attach verification metadata to each stream using the
 * helper fields below:
 *   _resolvedTitle : string   — title the provider actually resolved to
 *   _resolvedType  : string   — "movie" | "series" the provider resolved
 *   _idVerified    : true     — provider used IMDb/TMDB ID for lookup
 *
 * All _-prefixed fields are stripped from every returned stream.
 * Returns only accepted streams.
 */
export function filterVerifiedStreams(
  streams: Record<string, unknown>[],
  ctx: VerifyContext,
): Record<string, unknown>[] {
  if (!streams.length) return streams;

  const accepted: Record<string, unknown>[] = [];
  let rejectedCount = 0;

  for (const stream of streams) {
    const result = _scoreStream(stream, ctx);

    if (result.action === "REJECTED") {
      rejectedCount++;
      logger.warn(
        {
          provider: ctx.provider,
          requestedTitle: ctx.requestedTitle,
          requestedType: ctx.requestedType,
          season: ctx.requestedSeason,
          episode: ctx.requestedEpisode,
          resolvedTitle: stream["_resolvedTitle"] ?? "(none)",
          resolvedType: stream["_resolvedType"] ?? "(none)",
          idVerified: stream["_idVerified"] ?? false,
          score: result.score,
          reason: result.reason,
        },
        "[VERIFY] REJECTED",
      );
    } else {
      logger.debug(
        {
          provider: ctx.provider,
          requestedTitle: ctx.requestedTitle,
          score: result.score,
          reason: result.reason,
        },
        "[VERIFY] ACCEPTED",
      );

      // Strip internal verify fields before passing the stream downstream
      const clean: Record<string, unknown> = { ...stream };
      for (const k of _VERIFY_KEYS) delete clean[k];
      accepted.push(clean);
    }
  }

  if (rejectedCount > 0) {
    logger.info(
      {
        provider: ctx.provider,
        requested: `"${ctx.requestedTitle}" ${ctx.requestedType} S${ctx.requestedSeason}E${ctx.requestedEpisode}`,
        total: streams.length,
        accepted: accepted.length,
        rejected: rejectedCount,
      },
      "[VERIFY] Provider batch filtered",
    );
  }

  return accepted;
}

// ─── Provider capability report ───────────────────────────────────────────────

/**
 * Static report of provider verification capabilities.
 * Exposed via GET /api/debug/verify-report.
 */
export const PROVIDER_VERIFY_REPORT = {
  summary: "Universal content verification runs after every provider and before streams reach Stremio.",
  threshold: 15,
  scoring: {
    base: 50,
    idVerifiedBoost: "+20 (provider used IMDb/TMDB ID for lookup)",
    titleMatchStrong: "+25 (resolved title similarity ≥ 0.75)",
    titleMatchPartial: "+10 (resolved title similarity 0.50–0.74)",
    titleMatchWeak: "-15 (resolved title similarity 0.35–0.49)",
    titleMismatch: "-50 (resolved title similarity < 0.35)",
    typeMatch: "+10 (resolved type matches requested type)",
    typeConflictSeriesAsMovie: "-65 (series requested, provider resolved movie)",
    typeConflictMovieAsSeries: "-30 (movie requested, provider resolved series)",
    episodeMatch: "+25 (S/E pattern in stream text matches request)",
    episodeConflict: "-60 (S/E pattern in stream text conflicts with request)",
    fullMovieSignal: "-35 ('Full Movie' text in stream when series was requested)",
  },
  providers: {
    imdbVerified: {
      providers: ["AnimeSalt", "DooFlix", "MeowTV", "HindMoviez", "VaPlayer", "NetMirror"],
      note: "These providers receive the exact IMDb ID for lookup. They get +20 trust boost. Stream objects contain quality/server metadata only — no embedded content titles. Title/type mismatches at the provider backend cannot be detected from stream objects alone.",
    },
    tmdbVerified: {
      providers: ["StreamFlix", "MovieBox"],
      note: "These providers receive the exact TMDB ID for lookup. They get +20 trust boost. MovieBox additionally performs IMDB ID cross-check via TMDB on each candidate.",
    },
    resolvedTitleTracked: {
      providers: ["HDHub4U", "4KHDHub"],
      note: "Title-search providers. The resolved provider title is attached to each stream and compared against the requested title. Both title mismatch and type conflict are detected.",
    },
    approximateTitleVerification: {
      providers: ["Kartoons", "RareAnime", "AnimeDekho", "HDGharTV", "CastleTV", "CineFreak"],
      note: "Title-search providers where similarity filtering is applied inside the provider wrapper. Streams are tagged with the requested title as approximation. AnimeDekho additionally reports its resolved content type, enabling type-conflict detection.",
    },
    limitationsNotes: {
      HindMoviez:
        "Uses IMDb ID scraper. Stream name/title fields contain only quality and server info — title-level mismatch cannot be detected from stream objects alone.",
      NetMirror:
        "Resolves IMDB → TMDB internally then queries Netflix/Prime/Hotstar/Disney APIs. The TMDB lookup is trusted; platform-side title matching relies on the platform's own search. Stream objects contain only resolution info — title-level mismatch cannot be detected from stream objects alone.",
    },
  },
} as const;

// ─── Internals ────────────────────────────────────────────────────────────────

const _VERIFY_KEYS = ["_resolvedTitle", "_resolvedType", "_idVerified"] as const;
const _REJECT_THRESHOLD = 15;

interface _VerifyResult {
  score: number;
  action: "ACCEPTED" | "REJECTED";
  reason: string;
}

/**
 * Extract an S/E pattern from any text field.
 * Returns null if no pattern is found.
 */
function _extractSeasonEpisode(text: string): { season: number; episode: number } | null {
  // S01E01 / s01e01 / S1E1
  const m1 = text.match(/\bS(\d{1,3})E(\d{1,3})\b/i);
  if (m1) return { season: parseInt(m1[1]!, 10), episode: parseInt(m1[2]!, 10) };

  // Season 1 Episode 1 / Season 01 Episode 01
  const m2 = text.match(/\bSeason\s+(\d{1,3})\s+Episode\s+(\d{1,3})\b/i);
  if (m2) return { season: parseInt(m2[1]!, 10), episode: parseInt(m2[2]!, 10) };

  return null;
}

/** Returns true when text contains a clear "this is a standalone movie, not a series episode" signal. */
function _hasFullMovieSignal(text: string): boolean {
  return /\bfull[\s\-]?movie\b/i.test(text);
}

function _scoreStream(stream: Record<string, unknown>, ctx: VerifyContext): _VerifyResult {
  const name = String(stream["name"] ?? "");
  const title = String(stream["title"] ?? "");
  const url = String(stream["url"] ?? "");
  const resolvedTitle = stream["_resolvedTitle"] as string | undefined;
  const resolvedType = stream["_resolvedType"] as string | undefined;
  const idVerified = Boolean(stream["_idVerified"]);

  // Combine all text fields for pattern matching
  const allText = `${name} ${title} ${url}`;

  let score = 50; // neutral — pass when no signals
  const reasons: string[] = [];

  // ── 1. IMDb/TMDB ID-verification boost ──────────────────────────────────────
  if (idVerified) {
    score += 20;
    reasons.push("id-verified(+20)");
  }

  // ── 2. Resolved title similarity check ──────────────────────────────────────
  if (resolvedTitle) {
    const candidates = [ctx.requestedTitle, ...(ctx.aliases ?? [])].filter(Boolean);
    // Best similarity across requested title and all known aliases
    const bestSim = Math.max(0, ...candidates.map((t) => titleSimilarityScore(resolvedTitle, t)));

    if (bestSim >= 0.75) {
      score += 25;
      reasons.push(`title-match(${bestSim.toFixed(2)},+25)`);
    } else if (bestSim >= 0.50) {
      score += 10;
      reasons.push(`title-partial(${bestSim.toFixed(2)},+10)`);
    } else if (bestSim >= 0.35) {
      score -= 15;
      reasons.push(`title-weak(${bestSim.toFixed(2)},-15)`);
    } else {
      // Clear mismatch — provider resolved to an unrelated title
      score -= 50;
      reasons.push(`title-mismatch(${bestSim.toFixed(2)},resolved="${resolvedTitle}",-50)`);
    }
  }

  // ── 3. Content type conflict check ──────────────────────────────────────────
  if (resolvedType) {
    if (resolvedType !== ctx.requestedType) {
      if (ctx.requestedType === "series") {
        // Series episode requested but provider resolved a movie — strong signal to reject
        score -= 65;
        reasons.push("type-conflict(series-req/movie-resolved,-65)");
      } else {
        // Movie requested but provider resolved series — softer penalty (might be a special/OVA)
        score -= 30;
        reasons.push("type-conflict(movie-req/series-resolved,-30)");
      }
    } else {
      score += 10;
      reasons.push("type-match(+10)");
    }
  }

  // ── 4. Season/episode conflict from stream text ──────────────────────────────
  if (ctx.requestedType === "series") {
    const se = _extractSeasonEpisode(allText);
    if (se) {
      if (se.season === ctx.requestedSeason && se.episode === ctx.requestedEpisode) {
        score += 25;
        reasons.push(`ep-match(S${se.season}E${se.episode},+25)`);
      } else {
        // A different specific episode was found — reject
        score -= 60;
        reasons.push(
          `ep-conflict(req=S${ctx.requestedSeason}E${ctx.requestedEpisode},got=S${se.season}E${se.episode},-60)`,
        );
      }
    }

    // If the stream text says "Full Movie" but we requested a series episode → suspicious
    if (_hasFullMovieSignal(allText)) {
      score -= 35;
      reasons.push("full-movie-signal(-35)");
    }
  }

  const action: "ACCEPTED" | "REJECTED" = score >= _REJECT_THRESHOLD ? "ACCEPTED" : "REJECTED";
  const reason = reasons.length ? reasons.join("; ") : "no-signals(pass)";

  return { score, action, reason };
}
