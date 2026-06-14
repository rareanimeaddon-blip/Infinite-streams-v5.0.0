export const ADDON_ID = "community.infinitestreams.stremio";

export const manifest = {
  id: ADDON_ID,
  version: "8.3.0",
  name: "INFINITE STREAMS",
  description:
    "♾️ 12 providers. One addon. Zero compromise.\n" +
    "⛩️ AnimeSalt — Hindi, English & Japanese multi-audio anime HLS.\n" +
    "🌙 RareAnime India — Hindi & Tamil dubbed anime (rareanimes.buzz + animetoonhindi).\n" +
    "🇮🇳 AnimeDekho — Hindi/Tamil/Telugu dubbed anime via 15+ extractors.\n" +
    "🌐 NetMirror — 1080p mirrors of Netflix, Prime Video & Hotstar.\n" +
    "🎬 StreamFlix — Multi-audio & multilingual streaming library.\n" +
    "🏰 Castle TV — Tamil/Hindi/English multi-language streams.\n" +
    "💀 DahmerMovies — High-quality 1080p/4K direct file streams.\n" +
    "🎞️ HindMoviez — Bollywood, Hollywood & Hindi-dubbed in 480p–4K.\n" +
    "🍿 MovieBox — Multi-audio: Hindi, Bengali, English & more.\n" +
    "🎬 DooFlix — HLS streams via xpass.top for movies & series.\n" +
    "📡 HDHub4U — Hindi/Dual-audio movies & series via HubCloud CDN.\n" +
    "🔵 4KHDHub — 4K/1080p Hindi & Dual-audio streams via HubCloud CDN.\n" +
    "Supports IMDB, TMDB & Cinemeta IDs. | By @Master_si",
  logo: "https://i.imgur.com/YPqM5vW.png",
  background: "https://i.imgur.com/f4Rj2Qp.jpg",
  types: ["movie", "series"],
  catalogs: [
    {
      type: "movie",
      id: "infinitestreams_movies",
      name: "♾️ INFINITE STREAMS — Movies",
      extra: [{ name: "skip", isRequired: false }],
    },
    {
      type: "series",
      id: "infinitestreams_series",
      name: "♾️ INFINITE STREAMS — Series",
      extra: [{ name: "skip", isRequired: false }],
    },
    {
      type: "series",
      id: "animesalt-anime",
      name: "⛩️ Anime Series",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "movie",
      id: "animesalt-anime-movies",
      name: "⛩️ Anime Movies",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "series",
      id: "animedekho-series",
      name: "🇮🇳 AnimeDekho — Series & Anime",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
        { name: "genre", isRequired: false },
      ],
    },
    {
      type: "movie",
      id: "animedekho-movies",
      name: "🇮🇳 AnimeDekho — Movies",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "movie",
      id: "hindmoviez-movies",
      name: "🎞️ HindMoviez — Movies",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "series",
      id: "hindmoviez-series",
      name: "🎞️ HindMoviez — Series",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "series",
      id: "rareanime-series",
      name: "🌙 RareAnime Series (Hindi)",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "movie",
      id: "rareanime-movies",
      name: "🌙 RareAnime Movies (Hindi)",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "series",
      id: "atoon-series",
      name: "🌙 AnimeToon Hindi Series",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "movie",
      id: "atoon-movies",
      name: "🌙 AnimeToon Hindi Movies",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
  ],
  resources: [
    "catalog",
    { name: "meta", types: ["movie", "series"], idPrefixes: ["animedekho:", "rareanime:", "atoon:"] },
    { name: "stream", types: ["movie", "series"], idPrefixes: ["tt", "tmdb:", "animedekho:", "rareanime:", "atoon:"] },
    { name: "subtitles", types: ["movie", "series"], idPrefixes: ["tt"] },
  ],
  idPrefixes: ["tt", "tmdb:", "animedekho:", "rareanime:", "atoon:"],
  behaviorHints: {
    adult: false,
    p2p: false,
    configurable: true,
    configurationRequired: false,
  },
};

// Provider config — order must match PROVIDER_LIST in lib/provider-config.ts
// Index: 0=animesalt 1=rareanime 2=animedekho 3=netmirror 4=streamflix 5=dooflix 6=castletv 7=moviebox 8=dahmermovies 9=hindmovies 10=hdhub4u 11=fourkdhub
export const ALL_ENABLED_MASK = "111111111111";
