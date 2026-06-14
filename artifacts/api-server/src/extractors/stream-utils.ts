const FILE_HOSTING_BLOCKLIST =
  /gofile\.io|mega[0-9]*\.dp\.ua|megaup\.net|pandafiles\.com|clicknupload|desiupload\.co|uploadhub\.|indishare\.|gdflix\.|filescloud\.|mega\.nz|drive\.google|dropbox\.com|mediafire\.com|zippyshare|filecrypt\.|uploadrar\.|rapidgator\.|nitroflare\.|turbobit\.|1fichier\.|alfafile\.|katfile\.|ddownload\.|rockfile\.|hitfile\.|worldbytez\./i;

const CDN_ALLOWLIST =
  /workers\.dev|r2\.dev|glasscdn\.buzz|fukggl\.buzz|neetflixcdn|faceboook\.workers|aiplex-server|microsoft-cdn\.workers|hubcloud.*workers|telegramcdn\.workers|jiocloud.*workers|filescloud.*workers|drive\.jodise|bsnl-route|gdrivebot|pub-[a-f0-9]+\./i;

export function isDirectStreamUrl(url: string): boolean {
  if (!url) return false;
  if (url.startsWith("magnet:") || url.startsWith("mailto:") || url.startsWith("javascript:")) return false;
  if (!url.startsWith("http://") && !url.startsWith("https://")) return false;
  if (FILE_HOSTING_BLOCKLIST.test(url)) return false;
  if (/\.(m3u8|mp4|mkv|avi|mpd)(\?|$)/i.test(url)) return true;
  if (CDN_ALLOWLIST.test(url)) return true;
  return false;
}
