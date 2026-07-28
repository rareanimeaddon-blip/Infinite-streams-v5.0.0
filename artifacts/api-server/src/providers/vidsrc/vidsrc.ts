// VidSrc provider entry point.
// Re-exports getVidsrcStreams for consumption by the main stream router (routes/stremio.ts).
// All implementation lives in the sibling files within this folder — fully self-contained.

export { getVidsrcStreams } from "./vidsrc-resolver.js";
export type { VidsrcStream } from "./vidsrc-resolver.js";
