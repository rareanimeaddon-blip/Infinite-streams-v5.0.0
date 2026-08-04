---
name: MoviesDrive domain and scraping format
description: Current working domain, the two post formats (movie vs series), and the JSON API for the new search-recover link type.
---

# MoviesDrive domain and scraping format

**Working domain as of 2026-08-04:** `https://new1.moviesdrive.christmas`
Previous dead domain: `new4.moviesdrives.my`

Note: Official announced domains (`moviesdrives.mov`, `moviedrive.org`) are NXDOMAIN on all public DNS — they only resolve via certain regional ISPs. The `new1.moviesdrive.christmas` subdomain resolves globally.

## Two post formats (both still active)

### Movie posts — new format (2026-08)
- Links on the post page: `hubcloud.foo/drive/search-recover.php?from_ac=TOKEN&q=BASE64_QUERY`
- `hubcloud.foo` redirects to `hubcloud.cx`
- Quality label is in the preceding `<h5>` text before the link
- **JSON API:** `GET https://hubcloud.cx/drive/search-recover.php?api=search&q=QUERY&page=1&from_ac=TOKEN` with `Accept: application/json`
- Returns `{ hits: [{ file_name, url: "hubcloud.foo/drive/ID", size, mimeType }] }`
- `url` values are then resolved through the existing `resolveHubcloud()` function

### Series posts — old format (still active as of 2026-08)
- Post page links to `mdrive.lol/archive/NNN` (per-season)
- Archive pages contain `hubcloud.*/drive/ID` links per episode (labeled with "Episode N" text)
- Existing `extractArchiveLinks` + `extractHostLinks` chain handles these unchanged

## Code
- `artifacts/api-server/src/providers/moviesdrive/moviesdrive.ts`
- `extractSearchRecoverLinks()` — extracts new movie-format links from HTML
- `callSearchRecoverApi()` — hits the JSON API
- `resolveSearchRecoverLinks()` — orchestrates above, returns hostJobs
- `getStreams()` tries Path A (mdrive.lol) first; falls back to Path B (search-recover) if empty

**Why:** The site gradually migrated movie posts to the new CDN-agnostic search-recover system while keeping series on the old mdrive.lol archive structure.
