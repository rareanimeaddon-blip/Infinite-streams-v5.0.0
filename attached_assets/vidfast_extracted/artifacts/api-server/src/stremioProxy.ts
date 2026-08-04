import { createHmac, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import type { Request, Response } from "express";

type ProxyHeaders = Record<string, string>;

const configuredProxySecret = process.env["SESSION_SECRET"];
if (!configuredProxySecret) {
  throw new Error("SESSION_SECRET is required for Stremio playback proxy URLs.");
}
const proxySecret = configuredProxySecret;

function publicOrigin(): string {
  const host = (
    process.env["REPLIT_DOMAINS"] ??
    process.env["REPLIT_DEV_DOMAIN"] ??
    ""
  )
    .split(",")[0]
    .trim();

  if (!host) {
    throw new Error("A public Replit domain is required for Stremio playback URLs.");
  }

  return `https://${host}`;
}

function encodeHeaders(headers: ProxyHeaders): string {
  return Buffer.from(JSON.stringify(headers)).toString("base64url");
}

function sign(target: string, encodedHeaders: string): string {
  return createHmac("sha256", proxySecret)
    .update(`${target}\n${encodedHeaders}`)
    .digest("base64url");
}

export function createProxyUrl(
  target: string,
  headers: ProxyHeaders = {},
): string {
  const encodedHeaders = encodeHeaders(headers);
  const signature = sign(target, encodedHeaders);
  const query = new URLSearchParams({
    u: target,
    h: encodedHeaders,
    s: signature,
  });

  return `${publicOrigin()}/api/stremio/proxy?${query.toString()}`;
}

function readProxyRequest(req: Request): {
  target: URL;
  headers: ProxyHeaders;
} {
  const targetText = typeof req.query.u === "string" ? req.query.u : "";
  const encodedHeaders = typeof req.query.h === "string" ? req.query.h : "";
  const signature = typeof req.query.s === "string" ? req.query.s : "";

  if (!targetText || !encodedHeaders || !signature) {
    throw new Error("Missing playback proxy parameters.");
  }

  const expected = sign(targetText, encodedHeaders);
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    throw new Error("Invalid playback proxy signature.");
  }

  const target = new URL(targetText);
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new Error("Playback proxy only supports HTTP and HTTPS sources.");
  }

  let headers: ProxyHeaders;
  try {
    const decoded = JSON.parse(
      Buffer.from(encodedHeaders, "base64url").toString("utf8"),
    ) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error("Invalid headers.");
    }
    headers = Object.fromEntries(
      Object.entries(decoded).filter(
        ([key, value]) =>
          typeof key === "string" && typeof value === "string",
      ),
    );
  } catch {
    throw new Error("Invalid playback proxy headers.");
  }

  return { target, headers };
}

function isHls(target: URL, contentType: string, body: string): boolean {
  return (
    target.pathname.endsWith(".m3u8") ||
    contentType.includes("mpegurl") ||
    body.trimStart().startsWith("#EXTM3U")
  );
}

function proxyTargetUrl(target: URL, headers: ProxyHeaders): string {
  return createProxyUrl(target.toString(), headers);
}

function rewritePlaylist(
  body: string,
  target: URL,
  headers: ProxyHeaders,
): string {
  const rewrite = (value: string): string => {
    try {
      return proxyTargetUrl(new URL(value, target), headers);
    } catch {
      return value;
    }
  };

  return body
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim() || line.trimStart().startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => {
          return `URI="${rewrite(uri)}"`;
        });
      }
      return rewrite(line.trim());
    })
    .join("\n");
}

function forwardRequestHeaders(req: Request, playbackHeaders: ProxyHeaders) {
  const headers: Record<string, string> = { ...playbackHeaders };
  for (const name of ["range", "if-none-match", "if-modified-since"]) {
    const value = req.header(name);
    if (value) headers[name] = value;
  }
  return headers;
}

function copyResponseHeaders(upstream: globalThis.Response, res: Response) {
  for (const name of [
    "accept-ranges",
    "content-length",
    "content-range",
    "content-type",
    "etag",
    "last-modified",
  ]) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
}

export async function handlePlaybackProxy(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { target, headers } = readProxyRequest(req);
    const upstream = await fetch(target, {
      headers: forwardRequestHeaders(req, headers),
      redirect: "follow",
    });

    if (!upstream.ok && upstream.status !== 206) {
      res.status(upstream.status).send(`Playback source returned ${upstream.status}.`);
      return;
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    const likelyHls =
      target.pathname.endsWith(".m3u8") ||
      target.pathname.endsWith("/playlist") ||
      contentType.includes("mpegurl");

    if (likelyHls) {
      const body = await upstream.text();
      if (!isHls(target, contentType, body)) {
        copyResponseHeaders(upstream, res);
        res.status(upstream.status).send(body);
        return;
      }
      res.status(upstream.status);
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "no-store");
      res.send(rewritePlaylist(body, target, headers));
      return;
    }

    copyResponseHeaders(upstream, res);
    res.status(upstream.status);
    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Playback proxy failed.";
    res.status(400).send(message);
  }
}