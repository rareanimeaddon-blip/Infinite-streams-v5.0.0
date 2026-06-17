/**
 * Provider health-check script.
 * Tests every provider against a curated set of movies and series,
 * reports stream counts per provider, and flags suspicious results.
 *
 * Usage: pnpm --filter @workspace/scripts run provider-test
 */

const BASE = `http://localhost:${process.env["PORT"] ?? "5000"}/api`;

// ── Test cases ────────────────────────────────────────────────────────────────
const MOVIES: { title: string; imdb: string }[] = [
  { title: "Inception",               imdb: "tt1375666"  },
  { title: "The Dark Knight",         imdb: "tt0468569"  },
  { title: "Interstellar",            imdb: "tt0816692"  },
  { title: "KGF: Chapter 2",          imdb: "tt10698680" },
  { title: "Pushpa 2: The Rule",      imdb: "tt16539454" },
  { title: "Project Hail Mary",       imdb: "tt12042730" },
];

const SERIES: { title: string; imdb: string; s: number; e: number }[] = [
  { title: "Breaking Bad",  imdb: "tt0903747",  s: 1, e: 1 },
  { title: "The Boys",      imdb: "tt1190634",  s: 1, e: 1 },
  { title: "Mirzapur",      imdb: "tt6473300",  s: 1, e: 1 },
  { title: "Panchayat",     imdb: "tt12004706", s: 1, e: 1 },
];

// ── Types ─────────────────────────────────────────────────────────────────────
interface StremioStream {
  name?: string;
  title?: string;
  url?: string;
  infoHash?: string;
  behaviorHints?: { notWebReady?: boolean };
}

interface StreamResponse {
  streams?: StremioStream[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────
// Stream name formats used by each provider:
//   HDHub4U  : "📡 HDHub4U\n{quality} | {server}"
//   4KHDHub  : "🔵 4KHDHub\n{quality} | {server}"
//   DooFlix  : "DooFlix\n{label}"
//   HindMoviez: "HindMoviez\n{specs}"
//   NetMirror: "NetMirror | {service.name}"
//   AnimeSalt: "ALLINONE | AnimeSalt"
//   MovieBox : "MovieBox"
//   AnimeDekho: "AnimeDekho"
//   RareAnime: "🌙 RareAnime [HLS]"
//   CastleTV, DahmerMovies, StreamFlix, TIK2: pass-through s.name from provider
// → ALWAYS take the FIRST line as the provider identifier.
function extractProvider(stream: StremioStream): string {
  const raw = (stream.name ?? stream.title ?? "").trim();
  return raw.split(/\n/)[0].trim() || "Unknown";
}

function normaliseProvider(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("hdhub4u") || n.includes("📡"))          return "HDHub4U";
  if (n.includes("4kdhub") || n.includes("4khdhub") || n.includes("🔵")) return "4KHDHub";
  if (n.includes("hindmovie"))                             return "HindMoviez";
  if (n.includes("dahmermovie") || n.includes("dahmer"))  return "DahmerMovies";
  if (n.includes("moviebox"))                              return "MovieBox";
  if (n.includes("castletv") || n.includes("castle tv"))  return "CastleTV";
  if (n.includes("dooflix"))                               return "DooFlix";
  if (n.includes("streamflix"))                            return "StreamFlix";
  if (n.includes("netmirror"))                             return "NetMirror";
  if (n.includes("animesalt") || n.includes("allinone"))  return "AnimeSalt";
  if (n.includes("rareanime"))                             return "RareAnime";
  if (n.includes("animedekho"))                            return "AnimeDekho";
  if (n.includes("tik"))                                   return "TIK2";
  return name.slice(0, 28);
}

const TIMEOUT_MS = 45_000;

async function fetchStreams(url: string): Promise<StremioStream[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const json = (await res.json()) as StreamResponse;
    return json.streams ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function providerMap(streams: StremioStream[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of streams) {
    const p = normaliseProvider(extractProvider(s));
    m.set(p, (m.get(p) ?? 0) + 1);
  }
  return m;
}

// ── Title mismatch detection ──────────────────────────────────────────────────
function titleWords(t: string): Set<string> {
  return new Set(t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2));
}

function looksRelevant(expected: string, stream: StremioStream): boolean {
  const text = `${stream.name ?? ""} ${stream.title ?? ""}`.toLowerCase();
  const words = titleWords(expected);
  // A stream is "relevant" if the stream metadata contains at least one key word of the title,
  // OR if it has a raw URL (can't easily verify), OR has no text metadata at all.
  if (!stream.name && !stream.title) return true; // no text to check
  for (const w of words) {
    if (text.includes(w)) return true;
  }
  return false;
}

// ── Formatting ────────────────────────────────────────────────────────────────
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED    = "\x1b[31m";
const CYAN   = "\x1b[36m";
const BOLD   = "\x1b[1m";
const RESET  = "\x1b[0m";

function col(count: number): string {
  if (count === 0) return `${RED}  0${RESET}`;
  if (count < 3)   return `${YELLOW}${String(count).padStart(3)}${RESET}`;
  return `${GREEN}${String(count).padStart(3)}${RESET}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
const ALL_PROVIDERS = [
  "HDHub4U", "4KHDHub", "HindMoviez", "DahmerMovies", "MovieBox",
  "CastleTV", "DooFlix", "StreamFlix", "NetMirror", "TIK2",
  "AnimeSalt", "RareAnime", "AnimeDekho",
];

interface RowResult {
  label: string;
  kind: string;
  total: number;
  perProvider: Map<string, number>;
  mismatch: boolean;
}

async function testItem(
  label: string,
  kind: "movie" | "series",
  imdb: string,
  s?: number,
  e?: number,
): Promise<RowResult> {
  const url =
    kind === "movie"
      ? `${BASE}/stream/movie/${imdb}.json`
      : `${BASE}/stream/series/${imdb}%3A${s}%3A${e}.json`;

  process.stdout.write(`  Fetching ${kind.padEnd(6)} ${label.padEnd(25)} … `);
  const streams = await fetchStreams(url);
  const perProvider = providerMap(streams);
  const mismatch = streams.length > 0 && streams.some((s) => !looksRelevant(label, s));
  const indicator = streams.length === 0 ? `${RED}✗${RESET}` : mismatch ? `${YELLOW}⚠${RESET}` : `${GREEN}✓${RESET}`;
  console.log(`${indicator} ${streams.length} streams`);
  return { label, kind, total: streams.length, perProvider, mismatch };
}

async function main(): Promise<void> {
  console.log(`\n${BOLD}${CYAN}══════════════════════════════════════════════════════`);
  console.log(`  INFINITE STREAMS — Provider Health Check`);
  console.log(`══════════════════════════════════════════════════════${RESET}\n`);

  const results: RowResult[] = [];

  console.log(`${BOLD}● Movies${RESET}`);
  for (const m of MOVIES) {
    results.push(await testItem(m.title, "movie", m.imdb));
  }

  console.log(`\n${BOLD}● Series (S01E01)${RESET}`);
  for (const s of SERIES) {
    results.push(await testItem(s.title, "series", s.imdb, s.s, s.e));
  }

  // ── Per-provider summary table ──────────────────────────────────────────────
  console.log(`\n${BOLD}${CYAN}── Per-Provider Stream Counts ─────────────────────────${RESET}`);

  // Collect every provider seen across all results
  const seenProviders = new Set<string>();
  for (const r of results) r.perProvider.forEach((_, p) => seenProviders.add(p));
  const providerList = ALL_PROVIDERS.filter((p) => seenProviders.has(p));
  for (const p of seenProviders) if (!ALL_PROVIDERS.includes(p)) providerList.push(p);

  // Header
  const labelW = 26;
  const provW  = 12;
  const header = "Title".padEnd(labelW) + providerList.map((p) => p.slice(0, provW - 1).padStart(provW)).join("");
  console.log(`${BOLD}${header}${RESET}`);
  console.log("─".repeat(labelW + providerList.length * provW));

  for (const r of results) {
    const prefix = r.mismatch ? `${YELLOW}⚠${RESET} ` : "  ";
    const rowLabel = (r.label + (r.kind === "series" ? " [S]" : "")).padEnd(labelW - 2);
    const cols = providerList.map((p) => col(r.perProvider.get(p) ?? 0).padStart(provW)).join("");
    console.log(`${prefix}${rowLabel}${cols}`);
  }

  // ── Provider totals ─────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(labelW + providerList.length * provW));
  const totalRow = "TOTAL".padEnd(labelW);
  const totalCols = providerList.map((p) => {
    const t = results.reduce((sum, r) => sum + (r.perProvider.get(p) ?? 0), 0);
    return col(t).padStart(provW);
  }).join("");
  console.log(`${BOLD}${totalRow}${totalCols}${RESET}`);

  // ── Pass / warn / fail summary ──────────────────────────────────────────────
  const passed  = results.filter((r) => r.total > 0 && !r.mismatch).length;
  const warned  = results.filter((r) => r.total > 0 &&  r.mismatch).length;
  const failed  = results.filter((r) => r.total === 0).length;
  const total   = results.length;

  console.log(`\n${BOLD}${CYAN}── Summary ────────────────────────────────────────────${RESET}`);
  console.log(`  ${GREEN}✓ Passed${RESET}  : ${passed} / ${total}`);
  if (warned) console.log(`  ${YELLOW}⚠ Warning${RESET} : ${warned} / ${total}  (streams returned but title may not match)`);
  if (failed) console.log(`  ${RED}✗ Failed${RESET}  : ${failed} / ${total}  (zero streams)`);
  console.log();

  if (failed > 0) {
    console.log(`${RED}Failed items:${RESET}`);
    results.filter((r) => r.total === 0).forEach((r) =>
      console.log(`  ✗ ${r.label} (${r.kind})`));
    console.log();
  }
  if (warned > 0) {
    console.log(`${YELLOW}Warning items (possible mismatch):${RESET}`);
    results.filter((r) => r.mismatch).forEach((r) =>
      console.log(`  ⚠ ${r.label} (${r.kind}) — check stream names`));
    console.log();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
