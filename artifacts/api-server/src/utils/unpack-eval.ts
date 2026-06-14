const MEDIA_URL_PATTERN = /https?:\/\/[^\s"'<>\\]+\.(?:m3u8|mp4|mkv|webm)(?:[?][^\s"'<>\\]*)?/gi;

export function unpackEval(script: string): string | null {
  if (!script.includes("eval(function(p,a,c,k,e")) return null;
  try {
    const match = /eval\(function\(p,a,c,k,e[^)]*\)\{[\s\S]*?\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/.exec(script);
    if (!match) return null;

    const [, p, a, c, k] = match;
    const aNum = parseInt(a!);
    const cNum = parseInt(c!);
    const keys = k!.split("|");

    function d(e: string): string {
      if (!e) return e;
      const base = aNum;
      let n = 0;
      for (let i = 0; i < e.length; i++) {
        const ch = e[i]!;
        const val = ch >= "0" && ch <= "9"
          ? ch.charCodeAt(0) - 48
          : ch >= "a" && ch <= "z"
          ? ch.charCodeAt(0) - 87
          : ch >= "A" && ch <= "Z"
          ? ch.charCodeAt(0) - 29
          : 0;
        n = n * base + val;
      }
      const key = keys[n];
      return key && key.length > 0 ? key : e;
    }

    let body = p!;
    for (let i = cNum - 1; i >= 0; i--) {
      const re = new RegExp("\\b" + i.toString(aNum) + "\\b", "g");
      body = body.replace(re, d(i.toString(aNum)));
    }
    return body;
  } catch {
    return null;
  }
}

export function extractUrlsFromScript(script: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  MEDIA_URL_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MEDIA_URL_PATTERN.exec(script)) !== null) {
    const url = m[0]!.replace(/\\+/g, "");
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  MEDIA_URL_PATTERN.lastIndex = 0;
  return urls;
}
