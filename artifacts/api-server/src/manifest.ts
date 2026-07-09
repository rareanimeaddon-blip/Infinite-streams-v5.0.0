export const ADDON_ID = "community.infinitestreams.stremio";

export const manifest = {
  id: ADDON_ID,
  version: "8.8.0",
  name: "INFINITE STREAMS",
  description: "Http addon for endless streaming by @Master_si",
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
      id: "kartoons_anime",
      name: "🎌 Kartoons — Anime",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "series",
      id: "kartoons_cartoons",
      name: "🎌 Kartoons — Cartoons",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "movie",
      id: "kartoons_movies",
      name: "🎌 Kartoons — Movies",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
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
    { name: "meta", types: ["movie", "series"], idPrefixes: ["animedekho:", "rareanime:", "atoon:", "kartoons:"] },
    { name: "stream", types: ["movie", "series"], idPrefixes: ["tt", "tmdb:", "animedekho:", "rareanime:", "atoon:", "kartoons:"] },
    { name: "subtitles", types: ["movie", "series"], idPrefixes: ["tt"] },
  ],
  idPrefixes: ["tt", "tmdb:", "animedekho:", "rareanime:", "atoon:", "kartoons:"],
  behaviorHints: {
    adult: false,
    p2p: false,
    configurable: true,
    configurationRequired: false,
  },
};

// Provider config — order must match PROVIDER_LIST in lib/provider-config.ts
// Index: 0=kartoons 1=animesalt 2=rareanime 3=animedekho 4=piratexplay 5=netmirror 6=streamflix 7=dooflix 8=castletv 9=onetouchtv 10=vidlink 11=moviebox 12=meowtv 13=moviesdrive 14=hdghartv 15=vaplayer 16=hindmovies 17=fourkdhub 18=hdhub4u
export const ALL_ENABLED_MASK = "1111111111111111111";
