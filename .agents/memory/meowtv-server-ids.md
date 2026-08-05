---
name: MeowTV server IDs
description: Current valid server IDs for the meowtv.ru API; old IDs return "Unknown server"
---

# MeowTV server IDs

## Current valid IDs (from JS bundle index-B9aCx_g0.js, August 2026)

| id       | label     | notes           |
|----------|-----------|-----------------|
| tik      | TCloud    |                 |
| ipcloud  | IPCloud   |                 |
| turkce   | Türkçe    | movieOnly: true |
| hindiv3  | Hindi v3  |                 |

## Old IDs (now return 400 "Unknown server")

`lynx`, `v5:Hindi`, `v4:Hindi`, `v6:Hindi`

**Why:** MeowTV rotated their server registry. Any id not in the frontend bundle's `rae` array returns 400.

**How to apply:** When adding/changing servers, verify IDs from the `rae` array in the latest JS bundle at `https://meowtv.ru/assets/index-*.js`. Search for `ipcloud` to find the array.

The `movieOnly` flag on `turkce` is enforced in `getMeowTvStreams` — series requests filter it out before calling the API.
