/**
 * Shared helpers for extractors.
 *
 * EXTRACTOR CONTRACT
 * ------------------
 * Every module in this folder exports:
 *
 *   meta: {
 *     id:     string                       stable id, used as the cache key
 *     label:  string                       human label, shown as a badge
 *     color:  string                       accent colour for the badge
 *     hosts:  string[]                     hostnames this extractor claims
 *   }
 *   match(url: URL): boolean               can this module handle the link?
 *   resolve(url: URL, ctx): Promise<Result>
 *
 * Result = {
 *   source, sourceLabel, pageUrl,
 *   title, author, authorUrl, thumbnail, duration, description,
 *   variants: Variant[],
 *   note?: string
 * }
 *
 * Variant = {
 *   id:       string          stable within one Result
 *   label:    string          e.g. "1080p", "Audio only"
 *   ext:      string          "mp4" | "m4a" | "webm" | "mp3"
 *   url:      string|null     direct media URL (null when engine is yt-dlp)
 *   formatId: string?         for engine: "yt-dlp"
 *   engine:   "direct" | "yt-dlp"
 *   size:     number|null     bytes, null when unknown
 *   approx:   boolean         true when size is an estimate
 *   quality:  number|null     vertical pixels when known (for sorting)
 *   bitrate:  number|null     bits/sec
 *   width, height, fps: number|null
 *   kind:     "video" | "audio"
 *   headers:  Record<string,string>   extra request headers the CDN demands
 * }
 */

export const Result = {
  create(partial) {
    return {
      source: 'generic',
      sourceLabel: 'Web',
      pageUrl: null,
      title: null,
      author: null,
      authorUrl: null,
      thumbnail: null,
      duration: null,
      description: null,
      variants: [],
      note: null,
      ...partial,
    };
  },
};

/** Format a byte count the way a download manager would. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** Format seconds as m:ss / h:mm:ss. */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Strip characters that break file systems, collapse whitespace, cap the length. */
export function sanitizeFilename(name, fallback = 'video') {
  let out = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Keep it well under the 255-byte per-component limit on APFS/HFS+.
  if (Buffer.byteLength(out, 'utf8') > 180) {
    out = out.slice(0, 180);
  }
  out = out.replace(/[\s.\-_]+$/, '');
  return out || fallback;
}

/** Build a filename from a title + extension, avoiding "..mp4". */
export function buildFilename(title, ext, fallback = 'video') {
  const base = sanitizeFilename(title, fallback);
  const cleanExt = String(ext || 'mp4').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp4';
  return `${base}.${cleanExt}`;
}

/** Extract the first capture group of `re` from `text`, or null. */
export function grab(text, re) {
  if (!text) return null;
  const m = re.exec(text);
  return m ? (m[1] ?? m[0]) : null;
}

/** Last path segment, without query string or trailing slash. */
export function lastSegment(url) {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/** Estimate a file size from a bitrate and a duration. Marked approximate. */
export function estimateSize(bitrate, durationSeconds) {
  if (!Number.isFinite(bitrate) || !Number.isFinite(durationSeconds)) return null;
  const bytes = (bitrate / 8) * durationSeconds;
  return bytes > 4096 ? Math.round(bytes) : null;
}

/** Pick a sensible "best" variant: highest quality video. */
export function pickBest(variants) {
  const video = variants.filter((v) => v.kind !== 'audio');
  const pool = video.length ? video : variants;
  return pool.reduce((best, v) => ((v.quality ?? 0) > (best.quality ?? 0) ? v : best), pool[0]);
}

/**
 * Pull a JSON blob out of a <script id="..."> tag without needing a DOM parser.
 * Walks from the opening tag, tracking brace depth so nested braces inside
 * strings are handled.
 */
export function extractScriptJson(html, scriptId) {
  const patterns = [
    new RegExp(`<script[^>]+id=["']${scriptId}["'][^>]*>([\\s\\S]*?)</script>`, 'i'),
    new RegExp(`<script[^>]+id=["']${scriptId}["'][^>]*>([\\s\\S]*)$`, 'i'),
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (!m) continue;
    const raw = m[1].trim().replace(/;$/, '');
    // Sometimes the payload is HTML-escaped.
    for (const candidate of [raw, raw.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&')]) {
      try {
        return JSON.parse(candidate);
      } catch {
        /* try the next form */
      }
    }
  }
  return null;
}

/** Collect every candidate media URL in a page's meta tags / JSON-LD / inline JSON. */
export function scrapeMediaCandidates(html, baseUrl) {
  const found = new Map();
  const push = (raw, note) => {
    if (!raw || typeof raw !== 'string') return;
    let value = raw.trim().replace(/&amp;/g, '&').replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
    if (!value || value.startsWith('data:') || value.startsWith('blob:')) return;
    let absolute;
    try {
      absolute = new URL(value, baseUrl).toString();
    } catch {
      return;
    }
    if (!/^https?:/.test(absolute)) return;
    if (!found.has(absolute)) found.set(absolute, note);
  };

  const metaRe =
    /<meta[^>]+(?:property|name)=["']([^"']+)["'][^>]*content=["']([^"']+)["']/gi;
  const metaReReversed =
    /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']([^"']+)["']/gi;
  const META_KEYS = [
    'og:video:secure_url',
    'og:video:url',
    'og:video',
    'twitter:player:stream',
    'twitter:player:stream:content_type',
    'video_src',
    'og:audio',
  ];
  for (const re of [metaRe, metaReReversed]) {
    let m;
    while ((m = re.exec(html))) {
      const [key, value] = re === metaRe ? [m[1], m[2]] : [m[2], m[1]];
      if (META_KEYS.includes(key.toLowerCase())) push(value, `meta ${key.toLowerCase()}`);
    }
  }

  // JSON-LD VideoObject
  const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let ld;
  while ((ld = ldRe.exec(html))) {
    try {
      const parsed = JSON.parse(ld[1].trim());
      const nodes = Array.isArray(parsed) ? parsed : [parsed, ...(parsed['@graph'] ?? [])];
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const type = String(node['@type'] ?? '');
        if (!/VideoObject|Clip|MediaObject/i.test(type)) continue;
        const contentUrl = node.contentUrl;
        if (Array.isArray(contentUrl)) contentUrl.forEach((c) => push(c, 'JSON-LD contentUrl'));
        else if (typeof contentUrl === 'string') push(contentUrl, 'JSON-LD contentUrl');
        if (typeof node.embedUrl === 'string') push(node.embedUrl, 'JSON-LD embedUrl');
      }
    } catch {
      /* malformed JSON-LD is common; ignore */
    }
  }

  // Inline JSON / JS string keys that overwhelmingly mean "here is the video".
  const keyRe =
    /"(?:contentUrl|video_url|videoUrl|playable_url|browser_native_hd_url|browser_native_sd_url|hd_src|sd_src|playAddr|downloadAddr|play_addr|source_url|mp4_url|media_url|video_src)"\s*:\s*"([^"]{12,})"/gi;
  let k;
  while ((k = keyRe.exec(html))) push(k[1], 'inline page data');

  // <video src> / <source src>. These are frequently relative, which is why
  // this pass resolves against the page URL rather than demanding absolute.
  const tagRe = /<(?:video|source|audio)\b[^>]*\bsrc=["']([^"']+)["']/gi;
  let tag;
  while ((tag = tagRe.exec(html))) {
    const value = tag[1];
    if (!/\.(mp4|m4v|mov|webm|m3u8|mpd|ts)(\?|#|$)/i.test(value)) continue;
    push(value, 'video/source tag');
  }

  // Bare .mp4 links sitting in the markup.
  const mp4Re = /https?:\\?\/\\?\/[^\s"'<>\\)]+?\.(?:mp4|m4v|mov|webm)(?:\?[^\s"'<>\\)]*)?/gi;
  let mp4;
  while ((mp4 = mp4Re.exec(html))) push(mp4[0], 'inline .mp4 link');

  return [...found].map(([url, note]) => ({ url, note }));
}

/** Page title, og:title and similar, with HTML entities decoded. */
export function scrapeTitle(html) {
  const first = (re) => {
    const m = re.exec(html);
    return m ? m[1] : null;
  };
  const raw =
    first(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
    first(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i) ||
    first(/<meta[^>]+name=["']twitter:title["'][^>]*content=["']([^"']+)["']/i) ||
    first(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return raw ? decodeEntities(raw).trim() : null;
}

export function decodeEntities(input) {
  return String(input)
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

/** Deduplicate + sort a variant list: best video first, audio last. */
export function finalizeVariants(variants) {
  const seen = new Set();
  const out = [];
  for (const v of variants) {
    if (!v) continue;
    if (v.engine !== 'yt-dlp' && !v.url) continue;
    const key = `${v.ext}|${v.quality ?? ''}|${v.bitrate ?? ''}|${v.url ?? v.formatId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: 'video',
      size: null,
      approx: false,
      quality: null,
      bitrate: null,
      width: null,
      height: null,
      fps: null,
      headers: {},
      engine: 'direct',
      ...v,
    });
  }
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'audio' ? 1 : -1;
    if (b.kind === 'audio') return (b.bitrate ?? 0) - (a.bitrate ?? 0);
    const q = (b.quality ?? 0) - (a.quality ?? 0);
    if (q !== 0) return q;
    return (b.bitrate ?? 0) - (a.bitrate ?? 0);
  });
  return out;
}
