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
 *   9 = vidlink
 *  10 = moviebox
 *  11 = meowtv
 *  12 = moviesdrive
 *  13 = hdghartv
 *  14 = vaplayer
 *  15 = hindmovies
 *  16 = fourkdhub
 *  17 = hdhub4u
 *
 * The config mask is an 18-character string of '0' or '1'.
 * '1' means enabled, '0' means disabled.
 * "111111111111111111" = all providers enabled (default).
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

export const ALL_PROVIDERS_MASK = "111111111111111111";

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
