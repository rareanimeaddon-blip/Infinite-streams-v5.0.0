import * as cheerio from "cheerio";
import { getHtml, getNoRedirect, BROWSER_HEADERS } from "../utils/request.js";
import { getBaseUrl, getIndexQuality, cleanTitle } from "../utils/index.js";
import { logger } from "../lib/logger.js";
import type { Stream } from "./types.js";

const TAG = "HubCloud";

export async function extractHubCloud(
  url: string,
  referer = "",
): Promise<Stream[]> {
  const streams: Stream[] = [];
  logger.info({ url }, `${TAG}: starting extraction`);

  try {
    const uri = new URL(url);
    const baseUrl = `${uri.protocol}//${uri.host}`;

    let href: string;
    if (url.includes("hubcloud.php")) {
      href = url;
    } else {
      const html = await getHtml(url);
      const $ = cheerio.load(html);
      const rawHref = $("#download").attr("href") ?? "";
      if (rawHref) {
        href = rawHref.startsWith("http")
          ? rawHref
          : `${baseUrl.replace(/\/+$/, "")}/${rawHref.replace(/^\/+/, "")}`;
      } else {
        // Fallback: some HubCloud pages store the download URL in a JS variable
        const varMatch = /var\s+url\s*=\s*['"]([^'"]+)['"]/.exec(html);
        href = varMatch?.[1] ?? "";
        if (href && !href.startsWith("http")) {
          href = `${baseUrl.replace(/\/+$/, "")}/${href.replace(/^\/+/, "")}`;
        }
      }
    }

    if (!href) {
      logger.warn({ url }, `${TAG}: no href found`);
      return streams;
    }

    // Use the download page URL as Referer — that is what the browser sends
    // when a user clicks the FSL/S3/Direct button on the HubCloud download page.
    // Backblaze B2 / FSL / S3 buckets check the Referer against the originating
    // page URL, not the root HubCloud domain.  Origin stays as the base domain.
    const bucketHeaders: Record<string, string> = {
      Referer: href.endsWith("/") ? href : `${href}/`,
      Origin: baseUrl,
    };

    logger.info({ href }, `${TAG}: fetching download page`);
    const downloadHtml = await getHtml(href);
    const $d = cheerio.load(downloadHtml);

    const size = $d("i#size").first().text() ?? "";
    const header = $d("div.card-header").first().text() ?? "";
    const headerDetails = cleanTitle(header);
    const quality = getIndexQuality(header);

    const labelExtras = [
      headerDetails ? `[${headerDetails}]` : "",
      size ? `[${size}]` : "",
    ]
      .filter(Boolean)
      .join(" ");

    const buzzPromises: Promise<void>[] = [];

    $d("a.btn, a[class*='btn'], a[class*='button'], a[class*='download']").each((_, el) => {
      const link = $d(el).attr("href") ?? "";
      const text = $d(el).text().toLowerCase().trim();
      const srcName = referer || "HubCloud";

      logger.debug({ text, link }, `${TAG}: processing button`);

      if (!link || link === "#" || link.startsWith("javascript:")) return;

      if (text.includes("fsl server")) {
        streams.push({
          name: `${srcName} [FSL Server]`,
          title: `FSL Server ${labelExtras}`,
          url: link,
          type: "mp4",
          headers: bucketHeaders,
          behaviorHints: { notWebReady: false },
        });
      } else if (text.includes("fslv2")) {
        streams.push({
          name: `${srcName} [FSLv2]`,
          title: `FSLv2 ${labelExtras}`,
          url: link,
          type: "mp4",
          headers: bucketHeaders,
          behaviorHints: { notWebReady: false },
        });
      } else if (text.includes("download file") || text.includes("direct download") || text.includes("direct link")) {
        streams.push({
          name: srcName,
          title: `Direct Download ${labelExtras}`,
          url: link,
          type: "mp4",
          headers: bucketHeaders,
          behaviorHints: { notWebReady: false },
        });
      } else if (text.includes("s3 server")) {
        streams.push({
          name: `${srcName} [S3 Server]`,
          title: `S3 ${labelExtras}`,
          url: link,
          type: "mp4",
          headers: bucketHeaders,
          behaviorHints: { notWebReady: false },
        });
      } else if (text.includes("mega server")) {
        streams.push({
          name: `${srcName} [Mega Server]`,
          title: `Mega ${labelExtras}`,
          url: link,
          type: "mp4",
          headers: bucketHeaders,
          behaviorHints: { notWebReady: false },
        });
      } else if (
        text.includes("pixeldra") ||
        text.includes("pixel server") ||
        text.includes("pixeldrain")
      ) {
        const pixelBase = getBaseUrl(link);
        const finalUrl = link.includes("download")
          ? link
          : `${pixelBase}/api/file/${link.split("/").pop()}?download`;
        streams.push({
          name: `${srcName} [Pixeldrain]`,
          title: `Pixeldrain ${labelExtras}`,
          url: finalUrl,
          type: "mp4",
          behaviorHints: { notWebReady: false },
        });
      } else if (text.includes("buzzserver") || text.includes("buzz server") || text.includes("buzz")) {
        buzzPromises.push(extractBuzzServer(link, srcName, labelExtras, quality, streams));
      } else if (text.includes("10gbps") || link.includes("hubcloud.cx")) {
        // 10Gbps server: may need to follow a redirect to extract the link= param
        buzzPromises.push(extract10Gbps(link, srcName, labelExtras, bucketHeaders, streams));
      } else if (text.includes("zipdisk") || link.includes("workers.dev")) {
        streams.push({
          name: `${srcName} [ZipDisk]`,
          title: `ZipDisk ${labelExtras}`,
          url: link,
          type: "mp4",
          headers: bucketHeaders,
          behaviorHints: { notWebReady: false },
        });
      } else if (link.includes("r2.dev")) {
        // Include ALL R2 URLs — presigned or plain private bucket.
        // The proxy will attempt re-extraction for a better CDN URL
        // (BuzzServer / 10Gbps), then falls back to a 302 redirect so the
        // player's own IP can reach the R2 bucket directly.
        streams.push({
          name: `${srcName} [Direct R2]`,
          title: `Direct ${labelExtras}`,
          url: link,
          type: "mp4",
          headers: bucketHeaders,
          behaviorHints: { notWebReady: false },
        });
      } else if (text.includes("v-cloud") || text.includes("vcloud") || text.includes("v cloud")) {
        streams.push({
          name: `${srcName} [V-Cloud]`,
          title: `V-Cloud ${labelExtras}`,
          url: link,
          type: "mp4",
          headers: bucketHeaders,
          behaviorHints: { notWebReady: false },
        });
      } else if (text.includes("worker") || text.includes("cf worker") || text.includes("cloudflare")) {
        streams.push({
          name: `${srcName} [Worker]`,
          title: `CF Worker ${labelExtras}`,
          url: link,
          type: "mp4",
          headers: bucketHeaders,
          behaviorHints: { notWebReady: false },
        });
      } else if (text.includes("instant") || text.includes("fast server") || /server\s*\d+/i.test(text)) {
        streams.push({
          name: `${srcName} [${text.charAt(0).toUpperCase() + text.slice(1, 20)}]`,
          title: `${labelExtras}`,
          url: link,
          type: "mp4",
          headers: bucketHeaders,
          behaviorHints: { notWebReady: false },
        });
      } else {
        logger.debug({ text, link }, `${TAG}: unknown button type`);
      }
    });

    if (buzzPromises.length > 0) {
      await Promise.allSettled(buzzPromises);
    }

    // Stamp every extracted stream with the landing page URL so the proxy can
    // re-run full 2-step extraction (landing → download page → fresh CDN URL)
    // when the short-lived R2/S3 token has expired at playback time.
    // Only applies when url is the stable landing page (no "hubcloud.php" token).
    if (!url.includes("hubcloud.php")) {
      for (const s of streams) {
        s.reExtractUrl = url;
      }
    }

    logger.info({ count: streams.length }, `${TAG}: extraction complete`);
  } catch (e) {
    logger.error({ err: e, url }, `${TAG}: error`);
  }
  return streams;
}

async function extractBuzzServer(
  link: string,
  srcName: string,
  labelExtras: string,
  _quality: number,
  streams: Stream[],
) {
  try {
    // Use fetch directly (not getNoRedirect) so we can read the body when
    // BuzzServer returns 200 HTML instead of a redirect header.
    const resp = await fetch(`${link}/download`, {
      headers: BROWSER_HEADERS,
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
    });

    // Old BuzzServer behaviour: sends hx-redirect or location header.
    let dlink = resp.headers.get("hx-redirect") || resp.headers.get("location") || "";

    // New BuzzServer behaviour (2025-06+): returns 200 HTML with a
    // "Link Generated! Download Here" page.  The CDN URL is in id="download".
    if (!dlink && resp.status === 200) {
      const html = await resp.text();
      const m =
        /id="download"[^>]*\shref="([^"]+)"/i.exec(html) ||
        /href="([^"]+)"[^>]*\sid="download"/i.exec(html);
      if (m?.[1]) {
        dlink = m[1].replace(/&amp;/gi, "&");
        logger.info({ dlink: dlink.slice(0, 80) }, "HubCloud BuzzServer: extracted CDN URL from HTML page");
      }
    }

    if (dlink && dlink.startsWith("http")) {
      streams.push({
        name: `${srcName} [BuzzServer]`,
        title: `BuzzServer ${labelExtras}`,
        url: dlink,
        type: "mp4",
        behaviorHints: { notWebReady: false },
      });
    } else {
      logger.warn({ status: resp.status }, "HubCloud BuzzServer: no CDN URL found");
    }
  } catch (e) {
    logger.error({ err: e }, "HubCloud BuzzServer: error");
  }
}

/**
 * hubcloud.cx redirect chain:
 *   gpdl.hubcloud.cx/?id=... → gpdl.*.workers.dev/?id=... → gamerxyt.com/dl.php?link=VIDEO_URL
 *
 * The final hop (dl.php) returns 200 HTML — the actual video URL is the `link=`
 * query parameter on that URL.  We follow all redirects and extract it.
 */
async function resolveHubcloudCxUrl(link: string): Promise<string> {
  try {
    const resp = await fetch(link, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    const finalUrl = resp.url;
    try {
      const u = new URL(finalUrl);
      const videoLink = u.searchParams.get("link");
      if (videoLink && videoLink.startsWith("http")) {
        logger.info({ videoLink: videoLink.slice(0, 80) }, "HubCloud 10Gbps: extracted video URL via dl.php chain");
        return videoLink;
      }
    } catch { /* invalid URL, fall through */ }
    // If the final URL itself is a direct video URL (not an HTML wrapper), use it
    if (finalUrl && finalUrl.startsWith("http") && !/\.php(\?|$)/.test(finalUrl)) {
      return finalUrl;
    }
    logger.warn({ link, finalUrl }, "HubCloud 10Gbps: redirect chain did not resolve to a video URL");
    return "";
  } catch (e) {
    logger.warn({ err: e, link }, "HubCloud 10Gbps: resolveHubcloudCxUrl error");
    return "";
  }
}

async function extract10Gbps(
  link: string,
  srcName: string,
  labelExtras: string,
  headers: Record<string, string>,
  streams: Stream[],
) {
  try {
    let finalUrl = "";
    if (link.includes("hubcloud.cx")) {
      // Follow the full chain: hubcloud.cx → workers.dev → dl.php?link=VIDEO_URL
      finalUrl = await resolveHubcloudCxUrl(link);
    } else {
      // Follow redirect to extract the link= query param
      const resp = await getNoRedirect(link);
      const loc = resp.headers["location"] ?? "";
      if (loc.includes("link=")) {
        finalUrl = loc.substring(loc.indexOf("link=") + 5);
      } else if (loc && loc.startsWith("http")) {
        finalUrl = loc;
      }
      // If no redirect found, finalUrl stays empty — don't push an HTML page as stream
    }
    if (!finalUrl) {
      logger.warn({ link }, "HubCloud 10Gbps: no CDN URL found — skipping");
      return;
    }
    streams.push({
      name: `${srcName} [10Gbps]`,
      title: `10Gbps ${labelExtras}`,
      url: finalUrl,
      type: "mp4",
      headers,
      behaviorHints: { notWebReady: false },
    });
  } catch (e) {
    logger.error({ err: e }, "HubCloud 10Gbps: error");
  }
}
