import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import { manifest, ALL_ENABLED_MASK } from "./manifest.js";
import { PROVIDER_LIST } from "./lib/provider-config.js";
import { BASE_PATH } from "./lib/base-path.js";

const _dirname = dirname(fileURLToPath(import.meta.url));
const logoPngBuffer = (() => {
  try { return readFileSync(resolve(_dirname, "logo.png")); }
  catch { return null; }
})();

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(
  cors({
    origin: "*",
    methods: ["GET", "HEAD", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept", "Origin", "X-Requested-With"],
    preflightContinue: false,
    optionsSuccessStatus: 204,
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function getPublicBase(req: express.Request): string {
  const domains = process.env["REPLIT_DOMAINS"];
  if (domains) return `https://${domains.split(",")[0]}`;
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  const host = req.headers["x-forwarded-host"] ?? req.headers["host"] ?? "localhost";
  return `${proto}://${host}`;
}

function serveLandingPage(req: express.Request, res: express.Response) {
  const base = getPublicBase(req);
  const defaultManifestUrl = `${base}${BASE_PATH}/manifest.json`;
  const stremioUrl = defaultManifestUrl.replace(/^https?:\/\//, "stremio://");

  // Provider order MUST match PROVIDER_LIST in lib/provider-config.ts
  // 0=kartoons 1=animesalt 2=rareanime 3=animedekho 4=netmirror 5=streamflix
  // 6=castletv 7=dooflix 8=moviebox 9=meowtv 10=dahmermovies 11=hindmovies 12=fourkdhub 13=hdhub4u
  const providers: Array<{
    key: string;
    name: string;
    emoji: string;
    color: string;
    glow: string;
    tags: string[];
    desc: string;
    category: string;
  }> = [
    {
      key: "kartoons",
      name: "Kartoons",
      emoji: "🎌",
      color: "#22c55e",
      glow: "rgba(34,197,94,0.25)",
      tags: ["Anime", "Cartoons", "Hindi", "English"],
      desc: "479 shows & 515 movies: Hindi & English dubbed anime and cartoons via dedicated Kartoons streaming API.",
      category: "anime",
    },
    {
      key: "animesalt",
      name: "AnimeSalt",
      emoji: "⛩️",
      color: "#e879f9",
      glow: "rgba(232,121,249,0.25)",
      tags: ["Anime", "Hindi Dub", "Eng Sub", "HLS"],
      desc: "Dedicated anime streaming with Hindi, English and Japanese multi-audio HLS streams.",
      category: "anime",
    },
    {
      key: "rareanime",
      name: "RareAnime India",
      emoji: "🌙",
      color: "#8b5cf6",
      glow: "rgba(139,92,246,0.25)",
      tags: ["Anime", "Hindi Dub", "Tamil", "HLS"],
      desc: "Hindi & Tamil dubbed anime from rareanimes.buzz and animetoonhindi.com with proxied HLS playback.",
      category: "anime",
    },
    {
      key: "animedekho",
      name: "AnimeDekho",
      emoji: "🇮🇳",
      color: "#f43f5e",
      glow: "rgba(244,63,94,0.25)",
      tags: ["Hindi Dub", "Tamil", "Telugu", "15+ Extractors"],
      desc: "Hindi, Tamil & Telugu dubbed anime with 15+ extractors — StreamWish, FileMoon, GDMirrorbot and more.",
      category: "anime",
    },
    {
      key: "netmirror",
      name: "NetMirror",
      emoji: "🌐",
      color: "#06b6d4",
      glow: "rgba(6,182,212,0.25)",
      tags: ["Netflix", "Prime", "Hotstar", "1080p"],
      desc: "1080p mirror streams from Netflix, Prime Video & Hotstar with no geo-restrictions.",
      category: "movies",
    },
    {
      key: "streamflix",
      name: "StreamFlix",
      emoji: "🎬",
      color: "#6366f1",
      glow: "rgba(99,102,241,0.25)",
      tags: ["Multi-Audio", "Multi-Lang", "TMDB", "HLS"],
      desc: "Broad multilingual streaming library matched by TMDB ID with multi-audio track support.",
      category: "movies",
    },
    {
      key: "dooflix",
      name: "DooFlix",
      emoji: "📺",
      color: "#a855f7",
      glow: "rgba(168,85,247,0.25)",
      tags: ["HLS", "Movies", "Series", "IMDB"],
      desc: "HLS streams via xpass.top — movie and series content matched by IMDB ID with M3U8 rewriting.",
      category: "movies",
    },
    {
      key: "castletv",
      name: "Castle TV",
      emoji: "🏰",
      color: "#f97316",
      glow: "rgba(249,115,22,0.25)",
      tags: ["Tamil", "Hindi", "English", "Multi-Lang"],
      desc: "Multi-language streaming with Tamil, Hindi & English content via title-matched Jaccard scoring.",
      category: "movies",
    },
    {
      key: "moviebox",
      name: "MovieBox",
      emoji: "🍿",
      color: "#f59e0b",
      glow: "rgba(245,158,11,0.25)",
      tags: ["Multi-Audio", "Hindi", "Bengali", "English"],
      desc: "Rich multi-audio library with Original, Hindi, English, Bengali and more audio tracks.",
      category: "movies",
    },
    {
      key: "meowtv",
      name: "MeowTV",
      emoji: "🐱",
      color: "#ec4899",
      glow: "rgba(236,72,153,0.25)",
      tags: ["Lynx", "Hindi", "TCloud", "HLS"],
      desc: "Multi-server HLS streams via meowtv.ru — Lynx, Pseudo, TCloud, IPCloud & Hindi (v1/v2/v3) servers.",
      category: "movies",
    },
    {
      key: "dahmermovies",
      name: "DahmerMovies",
      emoji: "💀",
      color: "#ef4444",
      glow: "rgba(239,68,68,0.25)",
      tags: ["1080p", "4K", "Direct Links", "Movies & TV"],
      desc: "High-quality 1080p and 4K direct file streams with strict size filtering for premium sources.",
      category: "movies",
    },
    {
      key: "hindmovies",
      name: "HindMoviez",
      emoji: "🎞️",
      color: "#10b981",
      glow: "rgba(16,185,129,0.25)",
      tags: ["Bollywood", "Hindi Dub", "480p–4K", "Series"],
      desc: "Bollywood, Hollywood & Hindi-dubbed movies and series in 480p, 720p, 1080p & 4K.",
      category: "movies",
    },
    {
      key: "fourkdhub",
      name: "4KHDHub",
      emoji: "🔵",
      color: "#3b82f6",
      glow: "rgba(59,130,246,0.25)",
      tags: ["4K", "1080p", "Hindi", "Dual Audio"],
      desc: "4K and 1080p Hindi & Dual-audio streams via HubCloud CDN with quality-aware extraction.",
      category: "movies",
    },
    {
      key: "hdhub4u",
      name: "HDHub4U",
      emoji: "📡",
      color: "#f59e0b",
      glow: "rgba(245,158,11,0.25)",
      tags: ["1080p", "Hindi", "Dual Audio", "HubCloud"],
      desc: "Hindi & Dual-audio movies and series resolved via HubCloud, PixelDrain & HdStream4u CDN.",
      category: "movies",
    },
  ];

  const providerCards = providers
    .map(
      (p) => `
    <div class="provider-card" data-cat="${p.category}" style="--clr:${p.color};--glow:${p.glow}">
      <div class="card-color-bar" style="background:${p.color}"></div>
      <div class="provider-card-body">
        <div class="provider-card-top">
          <span class="provider-emoji">${p.emoji}</span>
          <div>
            <h3 class="provider-name">${p.name}</h3>
            <span class="provider-cat-badge provider-cat-${p.category}">${p.category === "anime" ? "Anime" : "Movies & TV"}</span>
          </div>
        </div>
        <p class="provider-desc">${p.desc}</p>
        <div class="provider-tags">${p.tags.map((t) => `<span class="provider-tag">${t}</span>`).join("")}</div>
      </div>
    </div>`,
    )
    .join("");

  const providerCheckboxes = providers
    .map(
      (p, i) => `
    <label class="cb-row" data-index="${i}">
      <div class="cb-left">
        <div class="cb-box" id="cb-${p.key}" data-checked="1" onclick="toggleProvider('${p.key}',${i})">
          <svg class="cb-check" viewBox="0 0 12 12" fill="none">
            <path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <span class="cb-emoji">${p.emoji}</span>
        <div class="cb-info">
          <span class="cb-name">${p.name}</span>
          <span class="cb-tags">${p.tags.slice(0, 2).join(" · ")}</span>
        </div>
      </div>
      <div class="cb-pill" id="pill-${p.key}" style="--c:${p.color}">ON</div>
    </label>`,
    )
    .join("");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<meta name="description" content="INFINITE STREAMS — 14 providers, one addon. Kartoons, AnimeSalt, RareAnime, AnimeDekho, NetMirror, StreamFlix, CastleTV, DooFlix, MovieBox, MeowTV, DahmerMovies, HindMoviez, 4KHDHub, HDHub4U. Install in one click."/>
<title>INFINITE STREAMS — Stremio Addon</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,300..900;1,14..32,300..900&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#020209;--bg2:#07071a;--bg3:#0d0d24;--bg4:#101028;
  --border:rgba(255,255,255,0.06);--border2:rgba(255,255,255,0.12);
  --accent:#7c5cfc;--accent2:#a78bfa;--accent3:#c4b5fd;
  --blue:#38bdf8;--blue2:#7dd3fc;
  --text:#eeeeff;--text2:#8e8cb5;--text3:#484670;
  --success:#22d3a0;--r:16px;
}
html{scroll-behavior:smooth;-webkit-font-smoothing:antialiased}
body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;line-height:1.6;min-height:100vh;overflow-x:hidden}
a{color:inherit;text-decoration:none}
::-webkit-scrollbar{width:5px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:rgba(124,92,252,0.35);border-radius:999px}

/* ── Aurora background ── */
.aurora{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
.aurora-blob{position:absolute;border-radius:50%;filter:blur(120px);animation:drift 18s ease-in-out infinite alternate}
.aurora-blob:nth-child(1){width:700px;height:700px;top:-200px;left:-150px;background:radial-gradient(circle,rgba(124,92,252,0.18) 0%,transparent 70%);animation-duration:22s}
.aurora-blob:nth-child(2){width:600px;height:600px;top:-100px;right:-100px;background:radial-gradient(circle,rgba(56,189,248,0.14) 0%,transparent 70%);animation-duration:18s;animation-delay:-6s}
.aurora-blob:nth-child(3){width:500px;height:500px;bottom:10%;left:20%;background:radial-gradient(circle,rgba(167,139,250,0.1) 0%,transparent 70%);animation-duration:25s;animation-delay:-12s}
@keyframes drift{0%{transform:translate(0,0) scale(1)}50%{transform:translate(40px,-40px) scale(1.05)}100%{transform:translate(-30px,30px) scale(0.98)}}

/* ── Noise overlay ── */
body::after{content:'';position:fixed;inset:0;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.03'/%3E%3C/svg%3E");pointer-events:none;z-index:0;opacity:0.35}

.container{max-width:1100px;margin:0 auto;padding:0 24px;position:relative;z-index:1}

/* ── Nav ── */
nav{position:sticky;top:0;z-index:200;padding:0 24px;height:62px;display:flex;align-items:center;justify-content:space-between;background:rgba(2,2,9,0.65);backdrop-filter:blur(28px) saturate(200%);border-bottom:1px solid var(--border)}
.nav-logo{display:flex;align-items:center;gap:10px}
.nav-logo img{width:30px;height:30px;border-radius:8px;object-fit:cover}
.nav-name{font-size:14px;font-weight:800;letter-spacing:-0.03em;color:var(--text)}
.nav-right{display:flex;align-items:center;gap:8px}
.nav-version{font-size:11px;padding:3px 9px;border-radius:999px;background:rgba(124,92,252,0.1);border:1px solid rgba(124,92,252,0.2);color:var(--accent2);font-weight:600;letter-spacing:0.02em}
.nav-install{display:inline-flex;align-items:center;gap:7px;padding:8px 16px;background:linear-gradient(135deg,var(--accent),#5b21b6);color:#fff;border-radius:9px;font-size:12px;font-weight:700;transition:opacity .15s,transform .15s;box-shadow:0 4px 20px rgba(124,92,252,0.3)}
.nav-install:hover{opacity:.88;transform:translateY(-1px)}

/* ── Hero ── */
.hero{padding:110px 0 80px;text-align:center;position:relative;overflow:hidden}
.hero-grid{position:absolute;inset:0;background-image:linear-gradient(rgba(124,92,252,0.04) 1px,transparent 1px),linear-gradient(90deg,rgba(124,92,252,0.04) 1px,transparent 1px);background-size:48px 48px;mask-image:radial-gradient(ellipse 75% 55% at 50% 0%,black 0%,transparent 80%);pointer-events:none}
.hero-pill{display:inline-flex;align-items:center;gap:8px;padding:6px 14px 6px 8px;border-radius:999px;background:rgba(124,92,252,0.07);border:1px solid rgba(124,92,252,0.18);font-size:12px;color:var(--accent3);font-weight:600;margin-bottom:32px;letter-spacing:0.01em}
.hero-pill-dot{width:7px;height:7px;border-radius:50%;background:var(--success);box-shadow:0 0 0 3px rgba(34,211,160,0.2);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 0 3px rgba(34,211,160,0.2)}50%{box-shadow:0 0 0 7px rgba(34,211,160,0.04)}}
.brand-logo{width:96px;height:96px;margin:0 auto 32px;display:block}
.brand-logo img{width:100%;height:100%;object-fit:contain;border-radius:22px;filter:drop-shadow(0 0 40px rgba(124,92,252,0.7)) drop-shadow(0 0 80px rgba(56,189,248,0.35))}
h1{font-size:clamp(52px,9vw,100px);font-weight:900;letter-spacing:-0.05em;line-height:0.95;margin-bottom:24px}
.h1-word1{display:block;color:#eeeeff;text-shadow:0 0 120px rgba(180,170,255,0.25)}
.h1-word2{display:block;background:linear-gradient(90deg,var(--blue) 0%,var(--blue2) 45%,var(--accent2) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.hero-sub{font-size:clamp(15px,2.2vw,18px);color:var(--text2);max-width:520px;margin:0 auto 16px;line-height:1.7;font-weight:400}
.credit-tag{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--text3);padding:4px 12px;border-radius:999px;border:1px solid var(--border);margin-bottom:40px;transition:border-color .2s}
.credit-tag:hover{border-color:var(--border2)}
.credit-tag a{color:var(--accent2);font-weight:700}

/* ── Install box ── */
.install-box{max-width:560px;margin:0 auto 48px;background:rgba(255,255,255,0.025);border:1px solid rgba(124,92,252,0.2);border-radius:22px;padding:28px;position:relative;overflow:hidden;backdrop-filter:blur(12px)}
.install-box::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse at top,rgba(124,92,252,0.07),transparent 65%);pointer-events:none}
.install-box::after{content:'';position:absolute;top:-1px;left:20%;right:20%;height:1px;background:linear-gradient(90deg,transparent,rgba(167,139,250,0.5),transparent)}
.install-box-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:var(--text3);margin-bottom:14px}
.install-btn-big{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;padding:17px 24px;background:linear-gradient(135deg,var(--accent) 0%,#5b21b6 45%,#0e93d8 100%);color:#fff;border:none;border-radius:13px;font-size:16px;font-weight:800;cursor:pointer;font-family:inherit;letter-spacing:-0.02em;box-shadow:0 8px 36px rgba(124,92,252,0.45),0 3px 16px rgba(14,165,233,0.2),inset 0 1px 0 rgba(255,255,255,0.12);transition:transform .15s,box-shadow .15s;text-decoration:none;margin-bottom:16px;position:relative}
.install-btn-big:hover{transform:translateY(-2px);box-shadow:0 14px 44px rgba(124,92,252,0.55),0 5px 24px rgba(14,165,233,0.25),inset 0 1px 0 rgba(255,255,255,0.12)}
.install-btn-sub{font-size:10px;font-weight:400;opacity:0.65;letter-spacing:0}
.install-divider{display:flex;align-items:center;gap:12px;margin-bottom:14px;color:var(--text3);font-size:11px;font-weight:500}
.install-divider::before,.install-divider::after{content:'';flex:1;height:1px;background:var(--border)}
.url-row{display:flex;gap:8px}
.url-input{flex:1;background:rgba(255,255,255,0.035);border:1px solid var(--border);border-radius:10px;padding:11px 14px;font-size:11px;font-family:'SF Mono',ui-monospace,monospace;color:var(--text2);outline:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:text;transition:border-color .15s}
.url-input:focus{border-color:rgba(124,92,252,0.35)}
.copy-btn{display:inline-flex;align-items:center;gap:6px;padding:11px 16px;background:rgba(124,92,252,0.1);border:1px solid rgba(124,92,252,0.22);border-radius:10px;color:var(--accent2);font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s;font-family:inherit}
.copy-btn:hover{background:rgba(124,92,252,0.18);border-color:rgba(124,92,252,0.38)}
.copy-btn.copied{background:rgba(34,211,160,0.1);border-color:rgba(34,211,160,0.28);color:var(--success)}
.install-note{margin-top:12px;font-size:11px;color:var(--text3);text-align:center;line-height:1.5}

/* ── Stats ── */
.stats-row{display:flex;justify-content:center;gap:0;border:1px solid var(--border);border-radius:18px;background:rgba(255,255,255,0.015);overflow:hidden;max-width:560px;margin:0 auto}
.stat{flex:1;padding:22px 12px;text-align:center;border-right:1px solid var(--border)}
.stat:last-child{border-right:none}
.stat-num{font-size:28px;font-weight:900;letter-spacing:-0.04em;background:linear-gradient(135deg,var(--text) 0%,var(--accent2) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.stat-lbl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:var(--text3);margin-top:3px}

/* ── Feature badges ── */
.feature-strip{display:flex;justify-content:center;gap:10px;flex-wrap:wrap;margin-top:40px}
.feature-badge{display:flex;align-items:center;gap:8px;padding:8px 16px;border-radius:999px;border:1px solid var(--border);background:rgba(255,255,255,0.02);font-size:12px;font-weight:600;color:var(--text2);transition:border-color .2s,background .2s;white-space:nowrap}
.feature-badge:hover{border-color:rgba(124,92,252,0.3);background:rgba(124,92,252,0.05);color:var(--accent3)}
.fb-icon{font-size:15px;line-height:1}

/* ── Sections ── */
.section{padding:90px 0;position:relative;z-index:1}
.section-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:var(--accent2);margin-bottom:10px}
.section-title{font-size:clamp(30px,4.5vw,46px);font-weight:900;letter-spacing:-0.04em;margin-bottom:16px;line-height:1.05}
.section-sub{font-size:15px;color:var(--text2);max-width:500px;line-height:1.75}
.section-divider{height:1px;background:linear-gradient(90deg,transparent,var(--border2),transparent);margin:0 0}

/* ── Category filter ── */
.cat-tabs{display:flex;gap:6px;margin:36px 0 -6px;flex-wrap:wrap}
.cat-tab{padding:7px 18px;border-radius:999px;font-size:12px;font-weight:700;border:1px solid var(--border);color:var(--text3);background:transparent;cursor:pointer;font-family:inherit;transition:all .15s;letter-spacing:0.02em}
.cat-tab.active,.cat-tab:hover{background:rgba(124,92,252,0.1);border-color:rgba(124,92,252,0.28);color:var(--accent2)}
.cat-tab.active{background:rgba(124,92,252,0.12);border-color:rgba(124,92,252,0.35)}

/* ── Provider cards ── */
.providers-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;margin-top:48px}
.provider-card{background:rgba(255,255,255,0.025);border:1px solid var(--border);border-radius:var(--r);overflow:hidden;transition:border-color .2s,box-shadow .2s,transform .2s;cursor:default;backdrop-filter:blur(8px)}
.provider-card:hover{border-color:var(--clr);box-shadow:0 0 0 1px color-mix(in srgb,var(--clr) 40%,transparent),0 12px 40px var(--glow);transform:translateY(-2px)}
.card-color-bar{height:3px;width:100%;opacity:0.85}
.provider-card-body{padding:18px 20px 20px}
.provider-card-top{display:flex;align-items:flex-start;gap:12px;margin-bottom:10px}
.provider-emoji{font-size:26px;line-height:1;flex-shrink:0;margin-top:2px}
.provider-name{font-size:15px;font-weight:700;color:var(--text);line-height:1.2;margin-bottom:3px}
.provider-cat-badge{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding:2px 7px;border-radius:999px;display:inline-block}
.provider-cat-anime{background:rgba(232,121,249,0.1);color:#e879f9;border:1px solid rgba(232,121,249,0.2)}
.provider-cat-movies{background:rgba(56,189,248,0.08);color:#38bdf8;border:1px solid rgba(56,189,248,0.18)}
.provider-desc{font-size:12px;color:var(--text2);line-height:1.65;margin-bottom:12px}
.provider-tags{display:flex;flex-wrap:wrap;gap:5px}
.provider-tag{font-size:10px;font-weight:600;padding:3px 8px;border-radius:999px;background:rgba(255,255,255,0.04);border:1px solid var(--border);color:var(--text3)}

/* ── Configure box ── */
.configure-box{background:rgba(255,255,255,0.02);border:1px solid var(--border);border-radius:22px;padding:32px;margin-top:48px;backdrop-filter:blur(8px)}
.configure-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:12px}
.configure-title{font-size:17px;font-weight:800;letter-spacing:-0.03em}
.sel-count{font-size:12px;padding:5px 13px;border-radius:999px;background:rgba(124,92,252,0.1);border:1px solid rgba(124,92,252,0.2);color:var(--accent2);font-weight:700}
.configure-actions{display:flex;gap:8px;margin-bottom:20px}
.cfg-action-btn{padding:6px 14px;border-radius:8px;font-size:11px;font-weight:700;border:1px solid var(--border);background:transparent;color:var(--text3);cursor:pointer;font-family:inherit;transition:all .15s;letter-spacing:0.02em}
.cfg-action-btn:hover{border-color:rgba(124,92,252,0.3);color:var(--accent2);background:rgba(124,92,252,0.07)}
.cb-list{display:flex;flex-direction:column;gap:2px;margin-bottom:24px}
.cb-row{display:flex;align-items:center;justify-content:space-between;padding:11px 14px;border-radius:11px;cursor:pointer;transition:background .15s}
.cb-row:hover{background:rgba(255,255,255,0.035)}
.cb-left{display:flex;align-items:center;gap:12px}
.cb-box{width:20px;height:20px;border-radius:6px;border:1.5px solid rgba(124,92,252,0.35);background:rgba(124,92,252,0.07);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:background .15s,border-color .15s;flex-shrink:0}
.cb-box[data-checked="1"]{background:var(--accent);border-color:var(--accent)}
.cb-box[data-checked="0"]{background:rgba(255,255,255,0.03);border-color:var(--border)}
.cb-check{width:12px;height:12px;color:#fff}
.cb-box[data-checked="0"] .cb-check{display:none}
.cb-emoji{font-size:18px;flex-shrink:0}
.cb-info{display:flex;flex-direction:column;gap:2px}
.cb-name{font-size:13px;font-weight:600;color:var(--text)}
.cb-tags{font-size:10px;color:var(--text3)}
.cb-pill{font-size:10px;font-weight:700;padding:3px 10px;border-radius:999px;background:rgba(124,92,252,0.1);border:1px solid rgba(124,92,252,0.22);color:var(--c,var(--accent2));letter-spacing:0.05em;flex-shrink:0;transition:all .15s}
.cb-pill.off{background:rgba(255,255,255,0.03);border-color:var(--border);color:var(--text3)}
.custom-install-box{background:rgba(124,92,252,0.04);border:1px solid rgba(124,92,252,0.14);border-radius:14px;padding:20px}
.custom-install-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:var(--text3);margin-bottom:14px}

/* ── FAQ ── */
.faq-list{margin-top:48px;display:flex;flex-direction:column;gap:0}
.faq-item{border-bottom:1px solid var(--border)}
.faq-q{display:flex;align-items:center;justify-content:space-between;width:100%;padding:20px 0;background:none;border:none;color:var(--text);font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;text-align:left;gap:16px;transition:color .15s}
.faq-q:hover{color:var(--accent3)}
.faq-q svg{flex-shrink:0;transition:transform .2s;color:var(--text3)}
.faq-item.open .faq-q svg{transform:rotate(45deg)}
.faq-a{font-size:14px;color:var(--text2);line-height:1.75;padding-bottom:20px;display:none}
.faq-item.open .faq-a{display:block}

/* ── Footer ── */
footer{border-top:1px solid var(--border);padding:52px 0;text-align:center}
.footer-inner{max-width:480px;margin:0 auto}
.footer-logo{display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:14px}
.footer-logo img{width:30px;height:30px;border-radius:8px;object-fit:cover}
.footer-name{font-size:14px;font-weight:800;letter-spacing:-0.03em}
.footer-desc{font-size:13px;color:var(--text3);line-height:1.7;margin-bottom:20px}
.footer-links{display:flex;justify-content:center;gap:16px;margin-bottom:16px;flex-wrap:wrap}
.footer-links a{font-size:12px;color:var(--text3);transition:color .15s;padding:3px 0}
.footer-links a:hover{color:var(--text2)}
.footer-debug-btn{background:rgba(124,92,252,0.07);border:1px solid rgba(124,92,252,0.18)!important;border-radius:6px;padding:3px 10px;color:var(--accent2)!important}
.footer-status{display:inline-flex;align-items:center;gap:7px;font-size:11px;color:var(--text3)}
.footer-status-dot{width:5px;height:5px;border-radius:50%;background:var(--success);box-shadow:0 0 0 3px rgba(34,211,160,0.2)}

/* ── Sticky bar ── */
.sticky-bar{position:fixed;bottom:0;left:0;right:0;z-index:300;background:rgba(2,2,9,0.88);backdrop-filter:blur(28px);border-top:1px solid var(--border);padding:12px 20px;display:flex;align-items:center;justify-content:space-between;transform:translateY(100%);transition:transform .3s cubic-bezier(.4,0,.2,1)}
.sticky-bar.visible{transform:translateY(0)}
.sticky-bar-left{display:flex;align-items:center;gap:10px}
.sticky-bar-left img{width:28px;height:28px;border-radius:7px;object-fit:cover;flex-shrink:0}
.sticky-bar-title{font-size:13px;font-weight:700;color:var(--text)}
.sticky-bar-sub{font-size:10px;color:var(--text3)}
.sticky-install{display:inline-flex;align-items:center;gap:7px;padding:10px 20px;background:linear-gradient(135deg,var(--accent),#5b21b6);color:#fff;border-radius:10px;font-size:13px;font-weight:700;transition:opacity .15s,transform .15s;box-shadow:0 4px 16px rgba(124,92,252,0.35)}
.sticky-install:hover{opacity:.88;transform:translateY(-1px)}

@media(max-width:640px){
  .stats-row{flex-wrap:wrap}
  .stat{min-width:50%;border-bottom:1px solid var(--border)}
  .providers-grid{grid-template-columns:1fr}
  h1{letter-spacing:-0.04em}
  .configure-box{padding:20px}
}
</style>
</head>
<body>

<div class="aurora">
  <div class="aurora-blob"></div>
  <div class="aurora-blob"></div>
  <div class="aurora-blob"></div>
</div>

<nav>
  <div class="nav-logo">
    <img src="${BASE_PATH}/logo.png" alt="∞"/>
    <span class="nav-name">INFINITE STREAMS</span>
  </div>
  <div class="nav-right">
    <span class="nav-version">v${manifest.version}</span>
    <a href="${stremioUrl}" class="nav-install">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12l7 7 7-7" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      Add to Stremio
    </a>
  </div>
</nav>

<section class="hero">
  <div class="hero-grid"></div>
  <div class="container">

    <div class="hero-pill">
      <div class="hero-pill-dot"></div>
      ${manifest.catalogs.length} catalogs &nbsp;·&nbsp; 14 providers &nbsp;·&nbsp; Live
    </div>

    <div class="brand-logo">
      <img src="${BASE_PATH}/logo.png" alt="INFINITE STREAMS"/>
    </div>

    <h1>
      <span class="h1-word1">INFINITE</span>
      <span class="h1-word2">STREAMS</span>
    </h1>

    <p class="hero-sub">14 providers. One addon. Zero compromise.<br/>Movies, series &amp; anime — all in one install.</p>
    <div class="credit-tag">Made by <a href="https://t.me/Master_si" target="_blank">@Master_si</a></div>

    <div class="install-box">
      <div class="install-box-label">Install Addon</div>
      <a href="${stremioUrl}" class="install-btn-big">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12l7 7 7-7" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Add to Stremio
        <span class="install-btn-sub">Opens Stremio automatically</span>
      </a>
      <div class="install-divider">or copy URL</div>
      <div class="url-row">
        <input id="manifest-input" class="url-input" type="text" value="${defaultManifestUrl}" readonly onclick="this.select()"/>
        <button class="copy-btn" id="copy-btn" onclick="copyUrl()">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2"/></svg>
          Copy
        </button>
      </div>
      <p class="install-note">Manual install: Stremio → Addons → Install from URL → paste above</p>
    </div>

    <div class="stats-row">
      <div class="stat"><div class="stat-num">13</div><div class="stat-lbl">Providers</div></div>
      <div class="stat"><div class="stat-num">${manifest.catalogs.length}</div><div class="stat-lbl">Catalogs</div></div>
      <div class="stat"><div class="stat-num">4K</div><div class="stat-lbl">Max Quality</div></div>
      <div class="stat"><div class="stat-num">∞</div><div class="stat-lbl">Content</div></div>
    </div>

    <div class="feature-strip">
      <div class="feature-badge"><span class="fb-icon">⚡</span> Ultra Fast Streams</div>
      <div class="feature-badge"><span class="fb-icon">🎬</span> Up to 4K Quality</div>
      <div class="feature-badge"><span class="fb-icon">🇮🇳</span> Indian Language Support</div>
      <div class="feature-badge"><span class="fb-icon">🆓</span> Completely Free</div>
      <div class="feature-badge"><span class="fb-icon">🔒</span> No P2P / No Torrents</div>
    </div>

  </div>
</section>

<div class="section-divider"></div>

<section class="section">
  <div class="container">
    <div class="section-label">Providers</div>
    <h2 class="section-title">13 sources, one install</h2>
    <p class="section-sub">Every provider is queried in parallel and deduplicated — you always get the best available stream.</p>

    <div class="cat-tabs">
      <button class="cat-tab active" onclick="filterCat('all',this)">All (13)</button>
      <button class="cat-tab" onclick="filterCat('anime',this)">🎌 Anime (3)</button>
      <button class="cat-tab" onclick="filterCat('movies',this)">🎬 Movies &amp; TV (10)</button>
    </div>

    <div class="providers-grid" id="providers-grid">${providerCards}</div>
  </div>
</section>

<div class="section-divider"></div>

<section class="section" id="configure">
  <div class="container">
    <div class="section-label">Configure</div>
    <h2 class="section-title">Choose your providers</h2>
    <p class="section-sub">Toggle providers on or off, then copy your custom manifest URL to install only what you want.</p>
    <div class="configure-box">
      <div class="configure-header">
        <span class="configure-title">Provider Selection</span>
        <span class="sel-count" id="sel-count">13 / 13 selected</span>
      </div>
      <div class="configure-actions">
        <button class="cfg-action-btn" onclick="selectAll()">Select All</button>
        <button class="cfg-action-btn" onclick="selectNone()">Select None</button>
        <button class="cfg-action-btn" onclick="selectAnime()">Anime Only</button>
        <button class="cfg-action-btn" onclick="selectMovies()">Movies &amp; TV Only</button>
      </div>
      <div class="cb-list">${providerCheckboxes}</div>
      <div class="custom-install-box">
        <div class="custom-install-title">Your Custom Manifest URL</div>
        <div class="url-row" style="margin-bottom:12px">
          <input id="custom-manifest-input" class="url-input" type="text" value="${defaultManifestUrl}" readonly onclick="this.select()"/>
          <button class="copy-btn" id="custom-copy-btn" onclick="copyCustomUrl()">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2"/></svg>
            Copy
          </button>
        </div>
        <a href="${stremioUrl}" class="install-btn-big" id="custom-install-btn" style="font-size:14px;padding:14px 20px">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12l7 7 7-7" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Install Custom Addon
        </a>
      </div>
    </div>
  </div>
</section>

<div class="section-divider"></div>

<section class="section">
  <div class="container">
    <div class="section-label">FAQ</div>
    <h2 class="section-title">Common questions</h2>
    <div class="faq-list">
      <div class="faq-item">
        <button class="faq-q" onclick="toggleFaq(this)">
          Is this addon free?
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <div class="faq-a">Yes, completely free. No account, no subscription, no hidden fees. Just install and stream.</div>
      </div>
      <div class="faq-item">
        <button class="faq-q" onclick="toggleFaq(this)">
          Does it use torrents or P2P?
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <div class="faq-a">No. Every stream is a direct HTTP/HLS link served from CDNs — no BitTorrent, no peer-to-peer.</div>
      </div>
      <div class="faq-item">
        <button class="faq-q" onclick="toggleFaq(this)">
          The "Add to Stremio" button didn't open Stremio — what do I do?
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <div class="faq-a">Copy the manifest URL and use Manual Install: open Stremio → Addons → My Addons → Install from URL, then paste the URL.</div>
      </div>
      <div class="faq-item">
        <button class="faq-q" onclick="toggleFaq(this)">
          Can I select which providers to use?
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <div class="faq-a">Yes — use the "Choose your providers" section above. Toggle providers, then install with the generated custom URL.</div>
      </div>
      <div class="faq-item">
        <button class="faq-q" onclick="toggleFaq(this)">
          Who made this?
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <div class="faq-a">INFINITE STREAMS is made by @Master_si. For updates and support, head to Telegram.</div>
      </div>
    </div>
  </div>
</section>

<footer>
  <div class="footer-inner">
    <div class="footer-logo">
      <img src="${BASE_PATH}/logo.png" alt="∞"/>
      <span class="footer-name">INFINITE STREAMS</span>
    </div>
    <p class="footer-desc">14 providers, zero compromise. Movies, series &amp; anime from every corner of the web. Free forever.</p>
    <div class="footer-links">
      <a href="${defaultManifestUrl}" target="_blank">manifest.json</a>
      <a href="${base}${BASE_PATH}/debug" class="footer-debug-btn">🛠 Debug Console</a>
      <a href="https://t.me/Master_si" target="_blank">@Master_si</a>
    </div>
    <div class="footer-status">
      <div class="footer-status-dot"></div>
      By @Master_si &nbsp;·&nbsp; v${manifest.version} &nbsp;·&nbsp; 13 Providers
    </div>
  </div>
</footer>

<div class="sticky-bar" id="sticky-bar">
  <div class="sticky-bar-left">
    <img src="${BASE_PATH}/logo.png" alt="∞"/>
    <div>
      <div class="sticky-bar-title">INFINITE STREAMS</div>
      <div class="sticky-bar-sub">14 providers · one addon</div>
    </div>
  </div>
  <a href="${stremioUrl}" class="sticky-install" id="sticky-install-btn">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12l7 7 7-7" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    Add to Stremio
  </a>
</div>

<script>
const BASE = ${JSON.stringify(base)};
const BP = ${JSON.stringify(BASE_PATH)};
const PROVIDER_KEYS = ${JSON.stringify(PROVIDER_LIST)};
const PROVIDER_CATS = ${JSON.stringify(providers.map(p => p.category))};
let mask = Array(13).fill(1);

function getMask(){ return mask.join(""); }

function buildManifestUrl(){
  const m = getMask();
  if(m === "${ALL_ENABLED_MASK}") return BASE + BP + "/manifest.json";
  return BASE + BP + "/" + m + "/manifest.json";
}

function buildStremioUrl(){
  return buildManifestUrl().replace(/^https?:\\/\\//, "stremio://");
}

function updateUrls(){
  const mUrl = buildManifestUrl();
  const sUrl = buildStremioUrl();
  const count = mask.filter(v => v === 1).length;
  document.getElementById("custom-manifest-input").value = mUrl;
  document.getElementById("custom-install-btn").href = sUrl;
  const sc = document.getElementById("sel-count");
  sc.textContent = count + " / 13 selected";
  sc.style.color = count > 0 ? "" : "#f87171";
}

function setProvider(key, index, enabled){
  mask[index] = enabled ? 1 : 0;
  const cb = document.getElementById("cb-" + key);
  const pill = document.getElementById("pill-" + key);
  cb.dataset.checked = String(mask[index]);
  pill.textContent = mask[index] === 1 ? "ON" : "OFF";
  pill.className = "cb-pill" + (mask[index] === 0 ? " off" : "");
}

function toggleProvider(key, index){
  setProvider(key, index, mask[index] !== 1);
  updateUrls();
}

function selectAll(){
  PROVIDER_KEYS.forEach((k, i) => setProvider(k, i, true));
  updateUrls();
}

function selectNone(){
  PROVIDER_KEYS.forEach((k, i) => setProvider(k, i, false));
  updateUrls();
}

function selectAnime(){
  PROVIDER_KEYS.forEach((k, i) => setProvider(k, i, PROVIDER_CATS[i] === "anime"));
  updateUrls();
}

function selectMovies(){
  PROVIDER_KEYS.forEach((k, i) => setProvider(k, i, PROVIDER_CATS[i] === "movies"));
  updateUrls();
}

function filterCat(cat, btn){
  document.querySelectorAll(".cat-tab").forEach(t => t.classList.remove("active"));
  btn.classList.add("active");
  document.querySelectorAll(".provider-card").forEach(card => {
    const show = cat === "all" || card.dataset.cat === cat;
    card.style.display = show ? "" : "none";
  });
}

function copyUrl(){
  const input = document.getElementById("manifest-input");
  navigator.clipboard.writeText(input.value).then(() => {
    const btn = document.getElementById("copy-btn");
    btn.classList.add("copied");
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Copied';
    setTimeout(() => { btn.classList.remove("copied"); btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2"/></svg> Copy'; }, 2000);
  });
}

function copyCustomUrl(){
  const input = document.getElementById("custom-manifest-input");
  navigator.clipboard.writeText(input.value).then(() => {
    const btn = document.getElementById("custom-copy-btn");
    btn.classList.add("copied");
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Copied';
    setTimeout(() => { btn.classList.remove("copied"); btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2"/></svg> Copy'; }, 2000);
  });
}

function toggleFaq(btn){
  btn.closest(".faq-item").classList.toggle("open");
}

const hero = document.querySelector(".hero");
const stickyBar = document.getElementById("sticky-bar");
const observer = new IntersectionObserver(([e]) => {
  stickyBar.classList.toggle("visible", !e.isIntersecting);
}, { threshold: 0.1 });
observer.observe(hero);
</script>
</body>
</html>`);
}

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#7C5CFC"/>
      <stop offset="100%" stop-color="#4f3bbf"/>
    </linearGradient>
    <linearGradient id="sym" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#d4c6ff"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="110" fill="url(#bg)"/>
  <text x="256" y="345" text-anchor="middle" font-family="Arial,Helvetica,sans-serif"
        font-size="290" font-weight="bold" fill="url(#sym)">&#x221E;</text>
</svg>`;

app.get(`${BASE_PATH}/logo.png`, (_req, res) => {
  if (!logoPngBuffer) { res.status(404).send("not found"); return; }
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=604800, immutable");
  res.send(logoPngBuffer);
});

app.get(`${BASE_PATH}/logo.svg`, (_req, res) => {
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=604800, immutable");
  res.send(LOGO_SVG);
});

app.get(`${BASE_PATH}/configure`, (_req, res) => {
  res.redirect(302, `${BASE_PATH}/#configure`);
});

app.get("/", serveLandingPage);
if (BASE_PATH) {
  app.get(BASE_PATH, serveLandingPage);
  app.get(`${BASE_PATH}/`, serveLandingPage);
}

app.use(BASE_PATH || "/", router);

export default app;
