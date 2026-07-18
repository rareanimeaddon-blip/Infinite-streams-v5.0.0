// Central manifest — used by /manifest.json and referenced by the landing page.
export const ADDON_MANIFEST = {
  id: "community.mapple-zxc",
  version: "1.0.0",
  name: "ZXCStream",
  description:
    "Streams from mapple.club and zxcstream.xyz (Icarus + Berkas). All HLS streams are proxied for in-app playback.",
  logo: "https://mapple.club/favicon.ico",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [
    {
      type: "movie",
      id: "gm_movie_trending",
      name: "GM Trending Movies",
      extra: [{ name: "search", isRequired: false }, { name: "skip" }],
    },
    {
      type: "movie",
      id: "gm_movie_popular",
      name: "GM Popular Movies",
      extra: [{ name: "search", isRequired: false }, { name: "skip" }],
    },
    {
      type: "series",
      id: "gm_series_trending",
      name: "GM Trending Series",
      extra: [{ name: "search", isRequired: false }, { name: "skip" }],
    },
    {
      type: "series",
      id: "gm_series_popular",
      name: "GM Popular Series",
      extra: [{ name: "search", isRequired: false }, { name: "skip" }],
    },
  ],
  behaviorHints: { configurable: false, configurationRequired: false },
} as const;
