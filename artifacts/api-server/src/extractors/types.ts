export interface Stream {
  name: string;
  title: string;
  url: string;
  type?: "hls" | "mp4" | "torrent";
  headers?: Record<string, string>;
  /** HubCloud landing page URL (no expiry) — used by the proxy to re-extract
   *  a fresh signed CDN URL when the stored one has expired. */
  reExtractUrl?: string;
  behaviorHints?: {
    notWebReady?: boolean;
    proxyHeaders?: {
      request?: Record<string, string>;
    };
  };
}

export interface Subtitle {
  lang: string;
  url: string;
}
