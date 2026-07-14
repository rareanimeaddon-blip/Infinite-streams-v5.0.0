import { Router } from "express";
import axios from "axios";
import { getEntries, getResolveEvents, clearEntries } from "../lib/debug-log.js";
import { PROVIDER_LIST } from "../lib/provider-config.js";
import { BASE_PATH } from "../lib/base-path.js";

const router = Router();

router.get("/debug", (_req, res) => {
  const proxy = getEntries();
  const resolve = getResolveEvents();

  function statusColor(s: number | string) {
    if (s === "ok") return "#34d399";
    if (s === "fail") return "#f87171";
    if (s === "skip") return "#888";
    if (typeof s === "number") {
      if (s >= 500) return "#f87171";
      if (s >= 400) return "#fb923c";
      if (s === 206) return "#34d399";
      return "#60a5fa";
    }
    return "#ccc";
  }

  // Provider health — check if a provider appears in the last 20 resolve events
  const recentEvents = resolve.slice(0, 40);
  const providerEmojis: Record<string, string> = {
    animesalt: "⛩️",
    rareanime: "🌙",
    animedekho: "🇮🇳",
    netmirror: "🌐",
    dooflix: "🎬",
    moviebox: "🍿",
    hindmovies: "🎞️",
  };
  const providerStatus = PROVIDER_LIST.map((p) => {
    const events = recentEvents.filter(
      (e) =>
        e.detail.toLowerCase().includes(p.replace("movies", "movie")) ||
        e.step.toLowerCase().includes(p.replace("movies", "movie")),
    );
    const hasFail = events.some((e) => e.status === "fail");
    const hasOk = events.some((e) => e.status === "ok");
    const status = hasOk ? "ok" : hasFail ? "fail" : "idle";
    return { name: p, status, emoji: providerEmojis[p] ?? "🔌" };
  });

  const providerCards = providerStatus
    .map((p) => {
      const dot = p.status === "ok" ? "#34d399" : p.status === "fail" ? "#f87171" : "#555";
      const label = p.status === "ok" ? "Healthy" : p.status === "fail" ? "Error" : "Idle";
      return `<div class="pc" style="border-color:${dot}20">
        <span class="pc-e">${p.emoji}</span>
        <span class="pc-n">${p.name}</span>
        <span class="pc-s" style="color:${dot}">${label}</span>
      </div>`;
    })
    .join("");

  const resolveRows = resolve
    .map(
      (e) => `<tr>
    <td class="id">#${e.id}</td>
    <td class="time">${e.time.slice(11, 23)}</td>
    <td class="path">${e.imdbId}</td>
    <td class="method">${e.step}</td>
    <td class="status" style="color:${statusColor(e.status)}">${e.status}</td>
    <td class="target" style="white-space:normal;word-break:break-all">${e.detail}</td>
  </tr>`,
    )
    .join("\n");

  const proxyRows = proxy
    .map((e) => {
      const shortPath = e.path.length > 55 ? e.path.slice(0, 55) + "…" : e.path;
      const shortTarget = e.targetUrl
        ? e.targetUrl.length > 65
          ? e.targetUrl.slice(0, 65) + "…"
          : e.targetUrl
        : "";
      return `<tr>
      <td class="id">#${e.id}</td>
      <td class="time">${e.time.slice(11, 23)}</td>
      <td class="method">${e.method}</td>
      <td class="path" title="${e.path}">${shortPath}</td>
      <td class="range">${e.rangeHeader ?? "—"}</td>
      <td class="target" title="${e.targetUrl ?? ""}">${shortTarget}</td>
      <td class="status" style="color:${statusColor(e.status)}">${e.status}</td>
      <td class="ct">${e.contentType ?? "—"}</td>
      <td class="bytes">${e.bytesSent != null ? e.bytesSent.toLocaleString() : "—"}</td>
      <td class="dur">${e.durationMs}ms</td>
      <td class="err" style="color:#f87171">${e.error ?? ""}</td>
    </tr>`;
    })
    .join("\n");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="refresh" content="10"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>♾️ INFINITE STREAMS — Debug</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#08080f;--bg2:#0d0d1a;--bg3:#111120;
  --border:rgba(255,255,255,0.07);--border2:rgba(255,255,255,0.13);
  --accent:#7c5cfc;--accent2:#a78bfa;--success:#22d3a0;--warn:#fb923c;--err:#f87171;
  --text:#f0eeff;--text2:#9492b8;--text3:#4a4870;
}
html{-webkit-font-smoothing:antialiased}
body{background:var(--bg);color:var(--text);font-family:'SF Mono',ui-monospace,'Cascadia Code',monospace;font-size:12px;min-height:100vh;overflow-x:auto}
a{color:var(--accent2);text-decoration:none}
a:hover{text-decoration:underline}

/* ── NAV ── */
.nav{display:flex;align-items:center;justify-content:space-between;padding:12px 20px;background:rgba(8,8,16,.85);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100}
.nav-brand{display:flex;align-items:center;gap:10px}
.nav-mark{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:900;color:#fff}
.nav-name{font-size:14px;font-weight:800;letter-spacing:-.03em;color:var(--text);font-family:system-ui,sans-serif}
.nav-badge{font-size:10px;padding:2px 8px;border-radius:999px;background:rgba(124,92,252,.12);border:1px solid rgba(124,92,252,.25);color:var(--accent2);margin-left:6px;font-weight:700}
.nav-right{display:flex;align-items:center;gap:10px}
.nav-link{font-size:11px;color:var(--text3);font-family:system-ui,sans-serif;transition:color .15s}
.nav-link:hover{color:var(--accent2)}
.refresh-tag{font-size:10px;color:var(--text3);padding:3px 8px;border-radius:4px;background:rgba(255,255,255,.04);border:1px solid var(--border)}

/* ── MAIN ── */
.main{max-width:1800px;margin:0 auto;padding:20px}

/* ── SECTION HEADER ── */
.section-header{display:flex;align-items:center;justify-content:space-between;margin:28px 0 12px;gap:8px}
.section-title{font-size:13px;font-weight:700;color:var(--text);font-family:system-ui,sans-serif;display:flex;align-items:center;gap:8px}
.section-count{font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(124,92,252,.12);border:1px solid rgba(124,92,252,.2);color:var(--accent2);font-weight:700}
.clear-btn{background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.2);color:#f87171;padding:4px 12px;border-radius:5px;cursor:pointer;font-family:inherit;font-size:11px;font-weight:600;transition:background .15s}
.clear-btn:hover{background:rgba(248,113,113,.15)}

/* ── PROVIDER CARDS ── */
.provider-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-bottom:8px}
.pc{background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:12px;display:flex;flex-direction:column;align-items:flex-start;gap:4px;transition:border-color .2s}
.pc-e{font-size:20px;line-height:1}
.pc-n{font-size:11px;font-weight:700;color:var(--text);font-family:system-ui,sans-serif;text-transform:capitalize}
.pc-s{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}

/* ── TABLE ── */
.tbl-wrap{overflow-x:auto;border-radius:10px;border:1px solid var(--border);margin-bottom:24px}
table{width:100%;border-collapse:collapse;min-width:700px}
thead{position:sticky;top:60px}
th{background:var(--bg2);color:var(--text3);padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:700;border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:5px 10px;border-bottom:1px solid rgba(255,255,255,.03);vertical-align:top;white-space:nowrap}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(255,255,255,.02)}
.id{color:var(--text3);width:40px}
.time{color:var(--text3);width:90px}
.method{color:var(--accent2);width:60px;font-weight:700}
.path{color:#e0e0f0;max-width:240px;overflow:hidden;text-overflow:ellipsis}
.range{color:var(--warn);width:100px}
.target{color:var(--text3);max-width:260px;overflow:hidden;text-overflow:ellipsis}
.status{font-weight:700;width:50px}
.ct{color:var(--text3);max-width:120px;overflow:hidden;text-overflow:ellipsis}
.bytes{color:var(--success);width:80px;text-align:right}
.dur{color:var(--text3);width:70px;text-align:right}
.err{max-width:180px;overflow:hidden;text-overflow:ellipsis}
.empty{color:var(--text3);text-align:center;padding:24px;font-style:italic}
</style>
</head>
<body>

<nav class="nav">
  <div class="nav-brand">
    <div class="nav-mark">♾</div>
    <span class="nav-name">INFINITE STREAMS</span>
    <span class="nav-badge">Debug Console</span>
  </div>
  <div class="nav-right">
    <a class="nav-link" href="${BASE_PATH}/debug/health">🩺 Health Check</a>
    <span class="refresh-tag">Auto-refresh 10s</span>
    <a class="nav-link" href="${BASE_PATH}/">← Back to Home</a>
  </div>
</nav>

<div class="main">

  <!-- PROVIDER HEALTH -->
  <div class="section-header">
    <div class="section-title">🔌 Provider Health</div>
    <span style="font-size:10px;color:var(--text3);font-family:system-ui">Play something in Stremio to see live status</span>
  </div>
  <div class="provider-grid">${providerCards}</div>

  <!-- STREAM RESOLUTION PIPELINE -->
  <div class="section-header">
    <div class="section-title">
      ⚡ Stream Resolution Pipeline
      <span class="section-count">${resolve.length} events</span>
    </div>
    <form method="POST" action="${BASE_PATH}/debug/clear">
      <button class="clear-btn">🗑 Clear all logs</button>
    </form>
  </div>
  <div class="tbl-wrap">
    <table>
      <thead>
        <tr><th>#</th><th>Time</th><th>IMDB / ID</th><th>Step</th><th>Status</th><th>Detail</th></tr>
      </thead>
      <tbody>
        ${resolveRows || '<tr><td colspan="6" class="empty">No resolution events yet — play something in Stremio</td></tr>'}
      </tbody>
    </table>
  </div>

  <!-- PROXY REQUESTS -->
  <div class="section-header">
    <div class="section-title">
      🌐 Proxy Requests
      <span class="section-count">${proxy.length} entries</span>
    </div>
  </div>
  <div class="tbl-wrap">
    <table>
      <thead>
        <tr><th>#</th><th>Time</th><th>Method</th><th>Path</th><th>Range</th><th>Target CDN URL</th><th>Status</th><th>Content-Type</th><th>Bytes</th><th>Duration</th><th>Error</th></tr>
      </thead>
      <tbody>
        ${proxyRows || '<tr><td colspan="11" class="empty">No proxy requests yet</td></tr>'}
      </tbody>
    </table>
  </div>

</div>
</body>
</html>`);
});

router.post("/debug/clear", (_req, res) => {
  clearEntries();
  res.redirect(`${BASE_PATH}/debug`);
});

// ─── URL diagnostics ─────────────────────────────────────────────────────────
router.get("/debug/url", (req, res) => {
  const publicUrl = process.env["PUBLIC_URL"];
  const replitDomains = process.env["REPLIT_DOMAINS"];
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol ?? "https";
  const host = (req.headers["x-forwarded-host"] as string | undefined) ?? (req.headers["host"] as string | undefined) ?? "localhost";
  const computed = publicUrl
    ? publicUrl.replace(/\/$/, "")
    : replitDomains
      ? `https://${replitDomains.split(",")[0]}`
      : `${proto}://${host}`;
  res.json({
    computed_public_url: computed,
    env_PUBLIC_URL: publicUrl ?? null,
    env_REPLIT_DOMAINS: replitDomains ?? null,
    env_BASE_PATH: process.env["BASE_PATH"] ?? null,
    headers: {
      host: req.headers["host"] ?? null,
      "x-forwarded-host": req.headers["x-forwarded-host"] ?? null,
      "x-forwarded-proto": req.headers["x-forwarded-proto"] ?? null,
      "x-forwarded-for": req.headers["x-forwarded-for"] ?? null,
    },
  });
});

// ─── Provider health probe data endpoint ────────────────────────────────────

interface ProbeResult {
  provider: string;
  movieStreams: number;
  seriesStreams: number;
  animeStreams: number;
  totalStreams: number;
  status: "ok" | "fail" | "partial";
  probeMs: number;
}

// IMPORTANT: keep this in sync with PROVIDER_LIST (lib/provider-config.ts) — every
// provider must have an entry here, matching the exact `name`/`title` string it sets
// on its stream objects (see each provider's stream-building code), or the health
// check will always report it as "fail" even when it's actually returning streams.
const PROVIDER_PATTERNS: Record<string, RegExp> = {
  kartoons:     /Kartoons/i,
  animesalt:    /AnimeSalt/i,
  rareanime:    /RareAnime/i,
  animedekho:   /AnimeDekho/i,
  piratexplay:  /PirateXPlay/i,
  netmirror:    /NetMirror/i,
  streamflix:   /StreamFlix/i,
  dooflix:      /DooFlix/i,
  castletv:     /CastleTV/i,
  onetouchtv:   /OneTouchTV/i,
  vidlink:      /VidLink/i,
  moviebox:     /MovieBox/i,
  meowtv:       /MeowTV/i,
  vidsrc:       /VidSrc/i,
  moviesdrive:  /MoviesDrive/i,
  hdghartv:     /HDGharTV/i,
  vaplayer:     /VaPlayer/i,
  cinefreak:    /CineFreak/i,
  hindmovies:   /HindMoviez/i,
  movies4u:     /Movies4u/i,
  fourkdhub:    /4KHDHub/i,
  hdhub4u:      /HDHub4U/i,
};

function countByProvider(streams: { name?: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of streams) {
    const name = s.name ?? "";
    for (const [key, pat] of Object.entries(PROVIDER_PATTERNS)) {
      if (pat.test(name)) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
        break;
      }
    }
  }
  return counts;
}

router.get("/debug/health/data", async (req, res) => {
  const port = process.env["PORT"] ?? "10000";
  const base = `http://localhost:${port}${BASE_PATH}`;

  const t0 = Date.now();
  const [movieR, seriesR, animeR] = await Promise.allSettled([
    axios.get<{ streams: { name?: string }[] }>(
      `${base}/stream/movie/tt12042730.json`,  // Project Hail Mary
      { timeout: 40000 },
    ),
    axios.get<{ streams: { name?: string }[] }>(
      `${base}/stream/series/tt0903747%3A1%3A1.json`, // Breaking Bad S01E01
      { timeout: 40000 },
    ),
    axios.get<{ streams: { name?: string }[] }>(
      `${base}/stream/series/tt12853970%3A1%3A2.json`, // Shin Chan S01E02
      { timeout: 40000 },
    ),
  ]);
  const probeMs = Date.now() - t0;

  const movieStreams  = movieR.status  === "fulfilled" ? (movieR.value.data.streams  ?? []) : [];
  const seriesStreams = seriesR.status === "fulfilled" ? (seriesR.value.data.streams ?? []) : [];
  const animeStreams  = animeR.status  === "fulfilled" ? (animeR.value.data.streams  ?? []) : [];

  const movieCounts  = countByProvider(movieStreams);
  const seriesCounts = countByProvider(seriesStreams);
  const animeCounts  = countByProvider(animeStreams);

  const results: ProbeResult[] = PROVIDER_LIST.map((p) => {
    const m = movieCounts.get(p)  ?? 0;
    const s = seriesCounts.get(p) ?? 0;
    const a = animeCounts.get(p)  ?? 0;
    const total = m + s + a;
    const status: ProbeResult["status"] = total > 0 ? "ok" : "fail";
    return { provider: p, movieStreams: m, seriesStreams: s, animeStreams: a, totalStreams: total, status, probeMs };
  });

  res.json({
    probeMs,
    checkedAt: new Date().toISOString(),
    movieTotal:  movieStreams.length,
    seriesTotal: seriesStreams.length,
    animeTotal:  animeStreams.length,
    results,
  });
});

// ─── Health check HTML page ──────────────────────────────────────────────────

router.get("/debug/health", (_req, res) => {
  // IMPORTANT: keep this in sync with PROVIDER_LIST (lib/provider-config.ts) — any
  // provider missing here still renders (via the fallback below) but with a generic
  // icon/label, so add new providers as they're added to PROVIDER_LIST.
  const providerMeta: Record<string, { emoji: string; label: string; types: string }> = {
    kartoons:     { emoji: "🎌",  label: "Kartoons",      types: "Anime" },
    animesalt:    { emoji: "⛩️",  label: "AnimeSalt",     types: "Anime" },
    rareanime:    { emoji: "🌙",  label: "RareAnime",     types: "Anime" },
    animedekho:   { emoji: "🇮🇳", label: "AnimeDekho",    types: "Anime" },
    piratexplay:  { emoji: "☠️",  label: "PirateXPlay",   types: "Movies · Series" },
    netmirror:    { emoji: "🌐",  label: "NetMirror",     types: "Movies · Series" },
    streamflix:   { emoji: "🎬",  label: "StreamFlix",    types: "Movies · Series" },
    dooflix:      { emoji: "🎥",  label: "DooFlix",       types: "Movies · Series" },
    castletv:     { emoji: "🏰",  label: "CastleTV",      types: "Movies · Series" },
    onetouchtv:   { emoji: "📺",  label: "OneTouchTV",    types: "Movies · Series" },
    vidlink:      { emoji: "🔗",  label: "VidLink",       types: "Movies · Series" },
    moviebox:     { emoji: "🍿",  label: "MovieBox",      types: "Movies · Series" },
    meowtv:       { emoji: "🐱",  label: "MeowTV",        types: "Movies · Series" },
    vidsrc:       { emoji: "📽️", label: "VidSrc",        types: "Movies · Series" },
    moviesdrive:  { emoji: "🚗",  label: "MoviesDrive",   types: "Movies · Series" },
    hdghartv:     { emoji: "🏚️", label: "HDGharTV",      types: "Movies · Series" },
    vaplayer:     { emoji: "🎮",  label: "VaPlayer",      types: "Movies · Series" },
    cinefreak:    { emoji: "🧊",  label: "CineFreak",     types: "Movies · Series" },
    hindmovies:   { emoji: "🎞️", label: "HindMoviez",    types: "Movies · Series" },
    movies4u:     { emoji: "📀",  label: "Movies4u",      types: "Movies · Series" },
    fourkdhub:    { emoji: "🔵",  label: "4KHDHub",       types: "Movies · Series" },
    hdhub4u:      { emoji: "📡",  label: "HDHub4U",       types: "Movies · Series" },
  };

  const cards = PROVIDER_LIST.map((p) => {
    const m = providerMeta[p] ?? { emoji: "🔌", label: p, types: "—" };
    return `<div class="card" id="card-${p}" data-provider="${p}">
  <div class="card-top">
    <span class="card-emoji">${m.emoji}</span>
    <span class="card-status idle" id="status-${p}">Idle</span>
  </div>
  <div class="card-name">${m.label}</div>
  <div class="card-types">${m.types}</div>
  <div class="card-streams" id="streams-${p}">—</div>
  <div class="card-bar"><div class="card-bar-fill" id="bar-${p}" style="width:0%"></div></div>
</div>`;
  }).join("\n");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>♾️ INFINITE STREAMS — Health Check</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#08080f;--bg2:#0d0d1a;--bg3:#111120;--bg4:#13131f;
  --border:rgba(255,255,255,0.07);--border2:rgba(255,255,255,0.13);
  --accent:#7c5cfc;--accent2:#a78bfa;
  --ok:#22d3a0;--fail:#f87171;--warn:#fb923c;--idle:#4a4870;
  --text:#f0eeff;--text2:#9492b8;--text3:#4a4870;
}
html{-webkit-font-smoothing:antialiased}
body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;font-size:13px;min-height:100vh}

/* NAV */
.nav{display:flex;align-items:center;justify-content:space-between;padding:12px 24px;background:rgba(8,8,16,.9);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100}
.nav-brand{display:flex;align-items:center;gap:10px}
.nav-mark{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:900;color:#fff}
.nav-name{font-size:14px;font-weight:800;letter-spacing:-.03em}
.nav-badge{font-size:10px;padding:2px 8px;border-radius:999px;background:rgba(124,92,252,.12);border:1px solid rgba(124,92,252,.25);color:var(--accent2);font-weight:700}
.nav-links{display:flex;align-items:center;gap:16px}
.nav-link{font-size:11px;color:var(--text3);text-decoration:none;transition:color .15s}
.nav-link:hover{color:var(--accent2)}

/* MAIN */
.main{max-width:1300px;margin:0 auto;padding:28px 24px}

/* HERO */
.hero{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:28px;flex-wrap:wrap}
.hero-left h1{font-size:22px;font-weight:800;letter-spacing:-.04em;margin-bottom:4px}
.hero-left p{font-size:12px;color:var(--text2);line-height:1.5;max-width:480px}
.hero-right{display:flex;align-items:center;gap:10px;flex-shrink:0}

/* STATS BAR */
.stats{display:flex;gap:12px;margin-bottom:28px;flex-wrap:wrap}
.stat{background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px 18px;min-width:110px}
.stat-val{font-size:24px;font-weight:800;letter-spacing:-.04em;color:var(--text)}
.stat-lbl{font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.08em;margin-top:2px}

/* RUN BUTTON */
.run-btn{display:inline-flex;align-items:center;gap:7px;background:linear-gradient(135deg,var(--accent),#6d4fe8);color:#fff;border:none;padding:10px 22px;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;transition:opacity .15s,transform .1s;white-space:nowrap}
.run-btn:hover{opacity:.9}
.run-btn:active{transform:scale(.97)}
.run-btn:disabled{opacity:.45;cursor:not-allowed}
.run-btn .spin{display:none;animation:spin .7s linear infinite}
.running .run-btn .spin{display:inline}
.running .run-btn .icon{display:none}
@keyframes spin{to{transform:rotate(360deg)}}

/* PROGRESS */
.progress-wrap{margin-bottom:20px;display:none}
.running .progress-wrap{display:block}
.progress-track{height:3px;background:rgba(255,255,255,.06);border-radius:2px;overflow:hidden;margin-bottom:6px}
.progress-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:2px;transition:width .4s ease;width:0%}
.progress-label{font-size:11px;color:var(--text3)}

/* GRID */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;margin-bottom:32px}

/* CARD */
.card{background:var(--bg3);border:1px solid var(--border);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:5px;transition:border-color .3s,box-shadow .3s}
.card.ok{border-color:rgba(34,211,160,.25);box-shadow:0 0 18px rgba(34,211,160,.06)}
.card.fail{border-color:rgba(248,113,113,.2);box-shadow:0 0 18px rgba(248,113,113,.05)}
.card.checking{border-color:rgba(124,92,252,.2)}
.card-top{display:flex;align-items:center;justify-content:space-between}
.card-emoji{font-size:22px;line-height:1}
.card-status{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;padding:2px 8px;border-radius:999px}
.card-status.idle{background:rgba(74,72,112,.18);color:var(--idle)}
.card-status.checking{background:rgba(124,92,252,.12);color:var(--accent2)}
.card-status.ok{background:rgba(34,211,160,.1);color:var(--ok)}
.card-status.fail{background:rgba(248,113,113,.1);color:var(--fail)}
.card-name{font-size:14px;font-weight:700;letter-spacing:-.02em;margin-top:2px}
.card-types{font-size:10px;color:var(--text3)}
.card-streams{font-size:12px;color:var(--text2);min-height:16px}
.card-bar{height:2px;background:rgba(255,255,255,.05);border-radius:2px;margin-top:4px;overflow:hidden}
.card-bar-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--ok));border-radius:2px;transition:width .5s ease}

/* TEST TITLES */
.tests{background:var(--bg3);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:28px}
.tests h3{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text3);margin-bottom:14px}
.test-list{display:flex;flex-direction:column;gap:8px}
.test-row{display:flex;align-items:center;gap:10px}
.test-badge{font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;text-transform:uppercase;letter-spacing:.06em;min-width:54px;text-align:center}
.test-badge.movie{background:rgba(99,102,241,.15);color:#818cf8}
.test-badge.series{background:rgba(245,158,11,.12);color:#fbbf24}
.test-badge.anime{background:rgba(34,211,160,.1);color:#34d399}
.test-name{font-size:12px;color:var(--text2)}
.test-id{font-size:11px;color:var(--text3);font-family:monospace}
.test-count{margin-left:auto;font-size:12px;font-weight:700;color:var(--text3)}
.test-count.has{color:var(--ok)}

/* TIMESTAMP */
.timestamp{font-size:11px;color:var(--text3);text-align:center;padding:8px;margin-top:8px}
</style>
</head>
<body>

<nav class="nav">
  <div class="nav-brand">
    <div class="nav-mark">♾</div>
    <span class="nav-name">INFINITE STREAMS</span>
    <span class="nav-badge">Health Check</span>
  </div>
  <div class="nav-links">
    <a class="nav-link" href="${BASE_PATH}/debug">← Debug Console</a>
    <a class="nav-link" href="${BASE_PATH}/">← Home</a>
  </div>
</nav>

<div class="main" id="root">

  <div class="hero">
    <div class="hero-left">
      <h1>Provider Health Check</h1>
      <p>Probes all ${PROVIDER_LIST.length} providers with real test titles — a movie, a series, and an anime. Streams are attributed to each provider and shown below.</p>
    </div>
    <div class="hero-right">
      <button class="run-btn" id="runBtn" onclick="runCheck()">
        <span class="icon">▶ Run Check</span>
        <span class="spin">⟳</span>&nbsp;Running…
      </button>
    </div>
  </div>

  <!-- STATS -->
  <div class="stats">
    <div class="stat"><div class="stat-val" id="stat-total">—</div><div class="stat-lbl">Total Streams</div></div>
    <div class="stat"><div class="stat-val" id="stat-ok">—</div><div class="stat-lbl">Providers OK</div></div>
    <div class="stat"><div class="stat-val" id="stat-fail">—</div><div class="stat-lbl">Providers Down</div></div>
    <div class="stat"><div class="stat-val" id="stat-time">—</div><div class="stat-lbl">Probe Time</div></div>
  </div>

  <!-- PROGRESS -->
  <div class="progress-wrap" id="progress">
    <div class="progress-track"><div class="progress-fill" id="progressFill"></div></div>
    <div class="progress-label" id="progressLabel">Probing providers…</div>
  </div>

  <!-- TEST TITLES -->
  <div class="tests">
    <h3>Test Titles</h3>
    <div class="test-list">
      <div class="test-row">
        <span class="test-badge movie">Movie</span>
        <span class="test-name">Project Hail Mary (2026)</span>
        <span class="test-id">tt12042730</span>
        <span class="test-count" id="tc-movie">—</span>
      </div>
      <div class="test-row">
        <span class="test-badge series">Series</span>
        <span class="test-name">Breaking Bad S01E01</span>
        <span class="test-id">tt0903747:1:1</span>
        <span class="test-count" id="tc-series">—</span>
      </div>
      <div class="test-row">
        <span class="test-badge anime">Anime</span>
        <span class="test-name">Shin Chan S01E02</span>
        <span class="test-id">tt12853970:1:2</span>
        <span class="test-count" id="tc-anime">—</span>
      </div>
    </div>
  </div>

  <!-- PROVIDER GRID -->
  <div class="grid" id="grid">
${cards}
  </div>

  <div class="timestamp" id="ts"></div>

</div>

<script>
async function runCheck() {
  const btn = document.getElementById('runBtn');
  const root = document.getElementById('root');
  const fill = document.getElementById('progressFill');
  const lbl  = document.getElementById('progressLabel');
  btn.disabled = true;
  root.classList.add('running');
  fill.style.width = '5%';
  lbl.textContent = 'Sending probes to all ${PROVIDER_LIST.length} providers…';

  // reset cards
  document.querySelectorAll('.card').forEach(c => {
    c.className = 'card checking';
    const p = c.dataset.provider;
    document.getElementById('status-' + p).className = 'card-status checking';
    document.getElementById('status-' + p).textContent = 'Checking';
    document.getElementById('streams-' + p).textContent = '—';
    document.getElementById('bar-' + p).style.width = '0%';
  });

  // animate fill while waiting
  let pct = 5;
  const ticker = setInterval(() => {
    pct = Math.min(pct + (95 - pct) * 0.06, 92);
    fill.style.width = pct + '%';
  }, 600);

  try {
    const resp = await fetch('${BASE_PATH}/debug/health/data');
    const data = await resp.json();
    clearInterval(ticker);
    fill.style.width = '100%';

    // update test counts
    const tcm = document.getElementById('tc-movie');
    const tcs = document.getElementById('tc-series');
    const tca = document.getElementById('tc-anime');
    tcm.textContent = data.movieTotal + ' streams';
    tcs.textContent = data.seriesTotal + ' streams';
    tca.textContent = data.animeTotal + ' streams';
    if (data.movieTotal  > 0) tcm.classList.add('has');
    if (data.seriesTotal > 0) tcs.classList.add('has');
    if (data.animeTotal  > 0) tca.classList.add('has');

    let okCount = 0, failCount = 0, totalStreams = 0;
    const maxStreams = Math.max(...data.results.map(r => r.totalStreams), 1);

    for (const r of data.results) {
      const card   = document.getElementById('card-' + r.provider);
      const status = document.getElementById('status-' + r.provider);
      const stream = document.getElementById('streams-' + r.provider);
      const bar    = document.getElementById('bar-' + r.provider);

      card.className = 'card ' + r.status;
      status.className = 'card-status ' + r.status;
      status.textContent = r.status === 'ok' ? 'Online' : 'No streams';

      const parts = [];
      if (r.movieStreams  > 0) parts.push(r.movieStreams  + ' movie');
      if (r.seriesStreams > 0) parts.push(r.seriesStreams + ' series');
      if (r.animeStreams  > 0) parts.push(r.animeStreams  + ' anime');
      stream.textContent = parts.length ? parts.join(' · ') : 'No streams found';

      bar.style.width = Math.round((r.totalStreams / maxStreams) * 100) + '%';
      if (r.status === 'ok') okCount++; else failCount++;
      totalStreams += r.totalStreams;
    }

    document.getElementById('stat-total').textContent = totalStreams;
    document.getElementById('stat-ok').textContent   = okCount + ' / ${PROVIDER_LIST.length}';
    document.getElementById('stat-fail').textContent  = failCount;
    document.getElementById('stat-time').textContent  = (data.probeMs / 1000).toFixed(1) + 's';
    document.getElementById('ts').textContent = 'Last checked: ' + new Date(data.checkedAt).toLocaleString();

    lbl.textContent = 'Done — ' + okCount + ' of ${PROVIDER_LIST.length} providers returned streams.';
    setTimeout(() => root.classList.remove('running'), 600);

  } catch (e) {
    clearInterval(ticker);
    lbl.textContent = 'Probe failed: ' + e.message;
    root.classList.remove('running');
  }

  btn.disabled = false;
}

// auto-run on load
window.addEventListener('load', runCheck);
</script>
</body>
</html>`);
});

// ─── HLS manifest analyzer ───────────────────────────────────────────────────
// GET /debug/manifest          → HTML tool page
// GET /debug/manifest/analyze  → JSON analysis (fetches the given URL via server)
//
// Lets the user paste any /as-relay or /m3u8 URL and instantly see whether
// #EXT-X-MEDIA:TYPE=AUDIO entries are present — without needing an LG TV.

router.get("/debug/manifest", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HLS Manifest Analyzer</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f172a;color:#e2e8f0;font-family:system-ui,sans-serif;padding:24px}
  h1{font-size:1.4rem;font-weight:700;margin-bottom:4px;color:#f8fafc}
  .sub{color:#94a3b8;font-size:.85rem;margin-bottom:24px}
  a{color:#60a5fa;text-decoration:none}a:hover{text-decoration:underline}
  label{display:block;font-size:.8rem;color:#94a3b8;margin-bottom:6px;font-weight:500;text-transform:uppercase;letter-spacing:.05em}
  input{width:100%;background:#1e293b;border:1px solid #334155;border-radius:8px;color:#f1f5f9;padding:10px 14px;font-size:.95rem;outline:none}
  input:focus{border-color:#60a5fa}
  button{background:#3b82f6;color:#fff;border:none;border-radius:8px;padding:10px 22px;font-size:.95rem;font-weight:600;cursor:pointer;margin-top:12px}
  button:hover{background:#2563eb}button:disabled{opacity:.5;cursor:default}
  .card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:20px;margin-top:24px}
  .badge{display:inline-block;border-radius:5px;padding:2px 9px;font-size:.78rem;font-weight:700;margin-right:6px}
  .green{background:#064e3b;color:#34d399}.red{background:#450a0a;color:#f87171}
  .blue{background:#0c1a4a;color:#60a5fa}.grey{background:#1e293b;color:#94a3b8;border:1px solid #334155}
  .track{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:12px 16px;margin-top:10px;font-size:.88rem}
  .track-name{font-weight:700;color:#f1f5f9;font-size:.95rem}
  .track-kv{color:#94a3b8;margin-top:4px;word-break:break-all}
  .track-uri{color:#60a5fa;margin-top:4px;word-break:break-all;font-size:.8rem}
  pre{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:16px;overflow-x:auto;font-size:.8rem;line-height:1.6;margin-top:10px;max-height:480px}
  .hl-audio{color:#34d399;font-weight:600}
  .hl-key{color:#fb923c}.hl-map{color:#a78bfa}.hl-stream{color:#60a5fa}
  .hl-comment{color:#64748b}.hl-url{color:#e2e8f0}
  #status{color:#94a3b8;font-size:.85rem;margin-top:8px;min-height:20px}
  .summary-row{display:flex;gap:16px;flex-wrap:wrap;margin-top:16px}
  .stat{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:12px 18px;text-align:center}
  .stat-num{font-size:1.8rem;font-weight:700;color:#f1f5f9}
  .stat-label{font-size:.75rem;color:#94a3b8;margin-top:2px}
</style>
</head>
<body>
<p style="margin-bottom:16px"><a href="${BASE_PATH}/debug">← Debug Console</a></p>
<h1>🎵 HLS Manifest Analyzer</h1>
<p class="sub">Paste an <code>/as-relay</code> or <code>/m3u8</code> URL to see exactly what LG TV receives — no TV needed.</p>

<label>Manifest URL</label>
<input id="url" type="text" placeholder="https://…/api/as-relay?hash=…&amp;player=…" spellcheck="false">
<br>
<button id="btn" onclick="analyze()">Analyze</button>
<p id="status"></p>
<div id="out"></div>

<script>
async function analyze() {
  const url = document.getElementById('url').value.trim();
  if (!url) return;
  const btn = document.getElementById('btn');
  const status = document.getElementById('status');
  const out = document.getElementById('out');
  btn.disabled = true;
  status.textContent = 'Fetching manifest through server…';
  out.innerHTML = '';
  try {
    const r = await fetch('${BASE_PATH}/debug/manifest/analyze?url=' + encodeURIComponent(url));
    const d = await r.json();
    if (!r.ok) { status.textContent = 'Error: ' + (d.error || r.status); btn.disabled=false; return; }
    status.textContent = '';
    renderResult(d);
  } catch(e) {
    status.textContent = 'Fetch failed: ' + e.message;
  }
  btn.disabled = false;
}

function hl(line) {
  const t = line.trim();
  if (!t) return line;
  if (t.startsWith('#EXT-X-MEDIA') && t.includes('TYPE=AUDIO')) return '<span class="hl-audio">' + esc(line) + '</span>';
  if (t.startsWith('#EXT-X-KEY')) return '<span class="hl-key">' + esc(line) + '</span>';
  if (t.startsWith('#EXT-X-MAP')) return '<span class="hl-map">' + esc(line) + '</span>';
  if (t.startsWith('#EXT-X-STREAM-INF')) return '<span class="hl-stream">' + esc(line) + '</span>';
  if (t.startsWith('#')) return '<span class="hl-comment">' + esc(line) + '</span>';
  return '<span class="hl-url">' + esc(line) + '</span>';
}
function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function renderResult(d) {
  const hasAudio = d.audioTracks.length > 0;
  const verdict = hasAudio
    ? '<span class="badge green">✅ ' + d.audioTracks.length + ' audio track' + (d.audioTracks.length>1?'s':'') + ' found</span>'
    : '<span class="badge red">❌ No audio tracks in manifest</span>';

  const tracksHtml = d.audioTracks.map(t => \`
    <div class="track">
      <div class="track-name">\${esc(t.name || '(unnamed)')}\${t.default ? ' <span class="badge green" style="font-size:.7rem">DEFAULT</span>' : ''}\${t.forced ? ' <span class="badge blue" style="font-size:.7rem">FORCED</span>' : ''}</div>
      <div class="track-kv">Language: \${esc(t.language||'—')} &nbsp;|&nbsp; Group: \${esc(t.groupId||'—')}</div>
      \${t.uri ? '<div class="track-uri">Rendition playlist: <a href="' + esc(t.uri) + '" target="_blank">' + esc(t.uri.length > 80 ? t.uri.slice(0,80)+'…' : t.uri) + '</a></div>' : '<div class="track-kv" style="color:#f87171">⚠ No URI — in-band/muxed audio only; players cannot switch tracks</div>'}
    </div>
  \`).join('');

  const lines = d.raw.split('\\n');
  const highlighted = lines.map(hl).join('\\n');

  document.getElementById('out').innerHTML = \`
    <div class="card">
      <div>\${verdict}
        \${d.hasMap ? '<span class="badge blue" style="background:#1e1b4b;color:#a78bfa">#EXT-X-MAP (fMP4/CMAF) — proxied ✅</span>' : '<span class="badge grey">#EXT-X-MAP absent (TS segments)</span>'}
        \${d.variantCount ? '<span class="badge grey">' + d.variantCount + ' quality variants</span>' : ''}
      </div>

      \${hasAudio ? '<div style="margin-top:12px;font-size:.85rem;color:#34d399;font-weight:600">LG TV should display the audio track selector ✅</div>' : '<div style="margin-top:12px;font-size:.85rem;color:#f87171">The CDN is not serving separate audio renditions — LG TV cannot show a selector. The audio is muxed inside the video segments.</div>'}

      \${tracksHtml ? '<div style="margin-top:16px"><div style="font-size:.8rem;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Audio Renditions</div>' + tracksHtml + '</div>' : ''}

      <div style="margin-top:20px">
        <div style="font-size:.8rem;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">
          Raw Manifest <span style="font-weight:400;text-transform:none">(<span style="color:#34d399">■</span> audio &nbsp;<span style="color:#a78bfa">■</span> EXT-X-MAP &nbsp;<span style="color:#fb923c">■</span> key &nbsp;<span style="color:#60a5fa">■</span> variant)</span>
        </div>
        <pre>\${highlighted}</pre>
      </div>
    </div>
  \`;
}

document.getElementById('url').addEventListener('keydown', e => { if(e.key==='Enter') analyze(); });
</script>
</body>
</html>`);
});

router.get("/debug/manifest/analyze", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const rawUrl = (req.query["url"] as string | undefined)?.trim();
  if (!rawUrl) { res.status(400).json({ error: "Missing url param" }); return; }

  let targetUrl: string;
  try {
    targetUrl = rawUrl;
    new URL(targetUrl);
  } catch {
    res.status(400).json({ error: "Invalid URL" }); return;
  }

  let text: string;
  try {
    const r = await fetch(targetUrl, {
      headers: { "User-Agent": "HLS-Manifest-Analyzer/1.0" },
      signal: AbortSignal.timeout(20_000),
      redirect: "follow",
    });
    if (!r.ok) { res.status(502).json({ error: `Upstream returned ${r.status}` }); return; }
    text = await r.text();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `Fetch failed: ${msg}` }); return;
  }

  const lines = text.split("\n");

  const audioTracks: {
    name: string; language: string; groupId: string;
    default: boolean; forced: boolean; uri: string | null;
  }[] = [];

  let variantCount = 0;
  let hasMap = false;

  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("#EXT-X-MEDIA") && t.includes("TYPE=AUDIO")) {
      const get = (k: string) => { const m = t.match(new RegExp(k + '="([^"]*)"')); return m ? m[1]! : ""; };
      const getBool = (k: string) => t.includes(k + "=YES");
      const uriMatch = t.match(/URI="([^"]+)"/);
      audioTracks.push({
        name: get("NAME"),
        language: get("LANGUAGE"),
        groupId: get("GROUP-ID"),
        default: getBool("DEFAULT"),
        forced: getBool("FORCED"),
        uri: uriMatch ? uriMatch[1]! : null,
      });
    }
    if (t.startsWith("#EXT-X-STREAM-INF")) variantCount++;
    if (t.startsWith("#EXT-X-MAP") && t.includes('URI="')) hasMap = true;
  }

  res.json({ audioTracks, variantCount, hasMap, raw: text.slice(0, 32_000) });
});

export default router;
