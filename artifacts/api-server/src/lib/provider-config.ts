/**
 * Provider configuration — controls which providers are used for stream aggregation.
 *
 * Provider order (index must match here, in PROVIDER_LIST, and in the landing page checkboxes):
 *   0 = kartoons
 *   1 = animesalt
 *   2 = rareanime
 *   3 = animedekho
 *   4 = piratexplay
 *   5 = streamflix
 *   6 = dooflix
 *   7 = castletv
 *   8 = onetouchtv
 *   9 = vidlink
 *  10 = moviebox
 *  11 = meowtv
 *  12 = vidsrc
 *  13 = moviesdrive
 *  14 = hdghartv
 *  15 = vaplayer
 *  16 = cinefreak
 *  17 = hindmovies
 *  18 = fourkdhub
 *  19 = hdhub4u
 *  20 = netmirror
 *  21 = zxcstreams
 *
 * The config mask is a 22-character string of '0' or '1'.
 * '1' means enabled, '0' means disabled.
 * "1111111111111111111111" = all providers enabled (default).
 */

export const PROVIDER_LIST = [
  "kartoons",
  "animesalt",
  "rareanime",
  "animedekho",
  "piratexplay",
  "streamflix",
  "dooflix",
  "castletv",
  "onetouchtv",
  "vidlink",
  "moviebox",
  "meowtv",
  "vidsrc",
  "moviesdrive",
  "hdghartv",
  "vaplayer",
  "cinefreak",
  "hindmovies",
  "fourkdhub",
  "hdhub4u",
  "netmirror",
  "zxcstreams",
] as const;

export type ProviderKey = (typeof PROVIDER_LIST)[number];

export const ALL_PROVIDERS_MASK = "1111111111111111111111";

export function parseProviderConfig(config: string): Set<ProviderKey> {
  const enabled = new Set<ProviderKey>();
  for (let i = 0; i < PROVIDER_LIST.length; i++) {
    if (!config[i] || config[i] !== "0") {
      enabled.add(PROVIDER_LIST[i]!);
    }
  }
  return enabled;
}

export function isEnabled(config: Set<ProviderKey>, provider: ProviderKey): boolean {
  return config.has(provider);
}

export function maskToConfig(mask: string): Set<ProviderKey> {
  const clean = mask.replace(/[^01]/g, "1").padEnd(PROVIDER_LIST.length, "1");
  return parseProviderConfig(clean);
}
