/**
 * Provider configuration — controls which providers are used for stream aggregation.
 *
 * Provider order (index must match here, in PROVIDER_LIST, and in the landing page checkboxes):
 *   0 = kartoons
 *   1 = animesalt
 *   2 = rareanime
 *   3 = animedekho
 *   4 = piratexplay
 *   5 = netmirror
 *   6 = streamflix
 *   7 = dooflix
 *   8 = castletv
 *   9 = onetouchtv
 *  10 = vidlink
 *  11 = moviebox
 *  12 = meowtv
 *  13 = moviesdrive
 *  14 = hdghartv
 *  15 = vaplayer
 *  16 = hindmovies
 *  17 = fourkdhub
 *  18 = hdhub4u
 *
 * The config mask is a 19-character string of '0' or '1'.
 * '1' means enabled, '0' means disabled.
 * "1111111111111111111" = all providers enabled (default).
 */

export const PROVIDER_LIST = [
  "kartoons",
  "animesalt",
  "rareanime",
  "animedekho",
  "piratexplay",
  "netmirror",
  "streamflix",
  "dooflix",
  "castletv",
  "onetouchtv",
  "vidlink",
  "moviebox",
  "meowtv",
  "moviesdrive",
  "hdghartv",
  "vaplayer",
  "hindmovies",
  "fourkdhub",
  "hdhub4u",
] as const;

export type ProviderKey = (typeof PROVIDER_LIST)[number];

export const ALL_PROVIDERS_MASK = "1111111111111111111";

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
