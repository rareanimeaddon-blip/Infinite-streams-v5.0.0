import { createRequire } from "node:module";
import { Router, type IRouter } from "express";
import { createProxyUrl, handlePlaybackProxy } from "../stremioProxy";

const require = createRequire(import.meta.url);
const { addonBuilder, getRouter } = require("stremio-addon-sdk") as {
  addonBuilder: new (manifest: unknown) => {
    defineStreamHandler: (handler: (args: unknown) => Promise<unknown>) => void;
    getInterface: () => unknown;
  };
  getRouter: (addonInterface: unknown) => IRouter;
};
const { manifest, streamHandler } = require("./stremio-addon/src/addon.js") as {
  manifest: unknown;
  streamHandler: (args: unknown) => Promise<{
    streams: Array<{
      url: string;
      subtitles?: Array<{ url: string; [key: string]: unknown }>;
      behaviorHints?: {
        proxyHeaders?: { request?: Record<string, string> };
        [key: string]: unknown;
      };
      [key: string]: unknown;
    }>;
  }>;
};

const router: IRouter = Router();

router.get("/proxy", (req, res) => {
  void handlePlaybackProxy(req, res);
});

const builder = new addonBuilder(manifest);
builder.defineStreamHandler(async (args) => {
  const result = await streamHandler(args);
  return {
    streams: result.streams.map((stream) => {
      const headers = stream.behaviorHints?.proxyHeaders?.request ?? {};
      const { proxyHeaders: _proxyHeaders, ...behaviorHints } =
        stream.behaviorHints ?? {};

      return {
        ...stream,
        url: createProxyUrl(stream.url, headers),
        subtitles: stream.subtitles?.map((subtitle) => ({
          ...subtitle,
          url: createProxyUrl(subtitle.url, headers),
        })),
        behaviorHints: {
          ...behaviorHints,
          notWebReady: false,
        },
      };
    }),
  };
});

router.use(getRouter(builder.getInterface()));

export default router;