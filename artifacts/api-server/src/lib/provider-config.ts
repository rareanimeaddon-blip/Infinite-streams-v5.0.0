/**
 * Provider configuration — controls which providers are used for stream aggregation.
 *
 * Provider order (index must match here, in PROVIDER_LIST, and in the landing page checkboxes):
 *   0 = animesalt
 *   1 = rareanime
 *   2 = animedekho
 *   3 = netmirror
 *   4 = streamflix
 *   5 = dooflix
 *   6 = castletv
 *   7 = moviebox
 *   8 = meowtv
 *   9 = dahmermovies
 *  10 = hindmovies
 *  11 = fourkdhub
 *  12 = hdhub4u
 *
 * The config mask is a 13-character string of '0' or '1'.
 * '1' means enabled, '0' means disabled.
 * "1111111111111" = all providers enabled (default).
 */

export const PROVIDER_LIST = [
  "animesalt",
  "rareanime",
  "animedekho",
  "netmirror",
  "streamflix",
  "dooflix",
  "castletv",
  "moviebox",
  "meowtv",
  "dahmermovies",
  "hindmovies",
  "fourkdhub",
  "hdhub4u",
] as const;

export type ProviderKey = (typeof PROVIDER_LIST)[number];

export const ALL_PROVIDERS_MASK = "1111111111111";

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
