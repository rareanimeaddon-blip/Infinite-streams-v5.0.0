# 111477 Direct — Stremio Addon

Direct `.mkv` / `.mp4` streams for movies and TV shows from
`a.111477.xyz`, served through the public mirror `ldh10.971188.xyz`.

## Why it just works (no 429, no access-denied)

`a.111477.xyz` sits behind a redirect + Cloudflare interstitial
(`p.111477.xyz/bulk?u=…`) that scrapers can't automate. But every file
under `/movies/…` and `/tvs/…` also lives on the mirror
`ldh10.971188.xyz`, which serves the video file **directly** with
`Content-Type: video/x-matroska` and `Accept-Ranges: bytes`.

So the addon:

1. Uses **TMDB** (via the IMDb id Stremio sends) to get the title / year
   or show / season / episode.
2. Looks up the matching folder in the mirror's directory index.
3. Returns the direct file URL to Stremio.

Stremio (desktop or Android) then fetches the file **itself**, from the
user's IP. Nothing is proxied through this addon at play time — that's
what avoids the 429 rate-limit and "access denied" errors you get when
an addon proxies for the client.

## Install locally

```bash
npm install
npm start
```

Then in Stremio → Add-ons → *Community add-ons* → paste:

```
http://127.0.0.1:7000/manifest.json
```

Or open directly:

```
stremio://127.0.0.1:7000/manifest.json
```

## Deploying

Any Node host works (Render, Fly, Railway, a VPS). Just:

```bash
PORT=7000 npm start
```

then use `https://<your-host>/manifest.json` as the install URL.

## Env vars

| Var           | Default                                | Purpose                        |
|---------------|----------------------------------------|--------------------------------|
| `MIRROR_HOST` | `ldh10.971188.xyz`                     | Mirror hostname                |
| `TMDB_API_KEY`| (bundled)                              | TMDB v3 key                    |
| `PORT`        | `7000`                                 | HTTP port                      |

## Notes

- The mirror hostname can rotate. If `ldh10.971188.xyz` ever stops
  responding, set `MIRROR_HOST` to whatever `a.111477.xyz` currently
  redirects to (open a movie file URL in a browser and copy the host
  from the final URL bar).
- The addon caches directory listings for 6 hours in memory.
- Movies and TV series only (no anime / kdrama sections yet — trivial
  to add if you want them).
