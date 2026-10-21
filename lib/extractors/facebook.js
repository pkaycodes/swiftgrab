/**
 * Facebook extractor.
 *
 * Facebook only exposes a video's real CDN URLs to requests that look like
 * their own link-preview crawler, so every request here uses
 * `facebookexternalhit`. When that fails (private, age-gated, region-locked,
 * or a login-walled watch page) we say so plainly and let yt-dlp try.
 */

import { UA, getJson, getText, probe } from '../http.js';
import { Result, decodeEntities, finalizeVariants } from '../util.js';

export const meta = {
  id: 'facebook',
  label: 'Facebook',
  color: '#1877f2',
  hosts: [
    'facebook.com',
    'www.facebook.com',
    'm.facebook.com',
    'web.facebook.com',
    'mbasic.facebook.com',
    'fb.watch',
    'fb.com',
    'www.fb.com',
  ],
};

const FB_HOST_RE = /(^|\.)(facebook\.com|fb\.watch|fb\.com)$/i;

export function match(url) {
  return FB_HOST_RE.test(url.hostname);
}

/** Recover a real URL from the JSON-escaped strings Facebook embeds. */
function unescapeUrl(raw) {
  return String(raw)
    .replace(/\\u002F/gi, '/')
    .replace(/\\u0025/gi, '%')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003A/gi, ':')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .trim();
}

/** Every media key Facebook has used over the years, in quality order. */
const MEDIA_KEYS = [
  ['browser_native_hd_url', 'HD', 1080],
  ['browser_native_sd_url', 'SD', 480],
  ['playable_url_quality_hd', 'HD', 1080],
  ['playable_url', 'SD', 480],
  ['hd_src_no_ratelimit', 'HD', 1080],
  ['hd_src', 'HD', 1080],
  ['sd_src_no_ratelimit', 'SD', 480],
  ['sd_src', 'SD', 480],
  ['progressive_url', 'SD', 480],
  ['video_url', 'Video', null],
];

function collectMediaUrls(html) {
  const out = [];
  const seen = new Set();
  for (const [key, label, height] of MEDIA_KEYS) {
    const re = new RegExp(`"${key}"\\s*:\\s*"(https:[^"]+?)"`, 'g');
    let m;
    while ((m = re.exec(html))) {
      const url = unescapeUrl(m[1]);
      if (!url.startsWith('http')) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ url, label, height, key });
    }
  }
  return out;
}

export function videoId(url) {
  const path = url.pathname;
  return (
    /\/videos\/(?:[^/]+\/)?(\d{6,25})/.exec(path)?.[1] ??
    /\/reels?\/(\d{6,25})/.exec(path)?.[1] ??
    /\/watch\/?\?.*\bv=(\d{6,25})/.exec(url.toString())?.[1] ??
    url.searchParams.get('v') ??
    /\/story\.php.*\bstory_fbid=(\d{6,25})/.exec(url.toString())?.[1] ??
    null
  );
}

/** Link-preview oEmbed gives clean metadata even when the media is locked. */
async function oembed(url, allowPrivate) {
  try {
    return await getJson(
      `https://www.facebook.com/plugins/video/oembed.json/?url=${encodeURIComponent(url)}`,
      {
        allowPrivate,
        label: 'Facebook oEmbed',
        timeout: 15_000,
        headers: { 'user-agent': UA.facebookBot },
      }
    );
  } catch {
    return null;
  }
}

async function fetchPage(pageUrl, allowPrivate, ua) {
  return getText(pageUrl, {
    allowPrivate,
    label: 'Facebook page',
    timeout: 25_000,
    maxBytes: 10 * 1024 * 1024,
    headers: {
      'user-agent': ua,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      ...(ua === UA.facebookBot ? { 'x-purpose': 'preview' } : {}),
    },
  });
}

/** Follow fb.watch / share links to a canonical facebook.com URL. */
async function canonicalize(url, allowPrivate) {
  if (!['fb.watch', 'fb.com', 'www.fb.com'].includes(url.hostname.toLowerCase()) && !/\/share\//.test(url.pathname)) {
    return url;
  }
  const html = await fetchPage(url.toString(), allowPrivate, UA.facebookBot).catch(() => '');
  const canonical =
    /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1] ??
    /"canonical"\s*:\s*"(https:[^"]+)"/i.exec(html)?.[1]?.replace(/\\\//g, '/');
  if (canonical) {
    try {
      const candidate = new URL(decodeEntities(canonical));
      if (FB_HOST_RE.test(candidate.hostname)) return candidate;
    } catch {
      /* keep the original */
    }
  }
  return url;
}

export async function resolve(url, ctx = {}) {
  let target = url;
  if (url.hostname.toLowerCase().includes('fb.watch') || url.pathname.startsWith('/share/')) {
    target = await canonicalize(url, ctx.allowPrivate);
  }

  const pageUrl = target.toString();
  const id = videoId(target);
  const errors = [];

  // The /plugins/video.php embed page is the softest target: it serves the
  // player fragment, which always carries the CDN URLs for a public video.
  const candidates = [];
  if (id) {
    candidates.push({
      url: `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(pageUrl)}&show_text=false`,
      why: 'embed player',
    });
    candidates.push({ url: `https://www.facebook.com/video/embed?video_id=${id}`, why: 'video embed' });
  }
  candidates.push({ url: pageUrl, why: 'post page' });
  if (id) candidates.push({ url: `https://m.facebook.com/watch/?v=${id}`, why: 'mobile page' });

  let pageHtml = '';
  let firstHtml = '';
  for (const candidate of candidates) {
    try {
      const html = await fetchPage(candidate.url, ctx.allowPrivate, UA.facebookBot);
      if (!firstHtml) firstHtml = html;
      const media = collectMediaUrls(html);
      if (media.length) {
        pageHtml = html;
        break;
      }
    } catch (err) {
      errors.push(`${candidate.why}: ${err.message}`);
    }
  }

  const media = pageHtml ? collectMediaUrls(pageHtml) : [];
  const info = await oembed(pageUrl, ctx.allowPrivate);
  const title =
    info?.title?.trim() ||
    /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(pageHtml || firstHtml)?.[1]?.trim() ||
    'Facebook video';

  if (!media.length) {
    const loginWall = /log ?in|loginform|you must log in|isn't available/i.test(firstHtml.slice(0, 200_000));
    const error = new Error(
      loginWall
        ? 'Facebook is asking for a login for that video. SwiftGrab runs without cookies, so only genuinely public videos work - install yt-dlp and pass cookies to get the rest.'
        : 'Facebook did not expose a downloadable stream for that link. Only public videos work without cookies.'
    );
    error.status = loginWall ? 401 : 404;
    error.hint = 'yt-dlp';
    throw error;
  }

  const durationSeconds = (() => {
    const raw =
      /"playable_duration_in_ms":(\d+)/.exec(pageHtml)?.[1] ??
      /"duration_in_ms":(\d+)/.exec(pageHtml)?.[1] ??
      /"videoDuration":(\d+)/.exec(pageHtml)?.[1];
    return raw ? Number(raw) / 1000 : null;
  })();

  const variants = media.map((entry, index) => {
    const qualityFromUrl = /[_-](\d{3,4})p?\.mp4/i.exec(entry.url)?.[1];
    const height = entry.height ?? (qualityFromUrl ? Number(qualityFromUrl) : null);
    return {
      id: `fb${index}`,
      label: entry.label + (entry.label === 'Video' ? '' : ''),
      ext: 'mp4',
      url: entry.url,
      kind: 'video',
      quality: height,
      height,
      size: null,
      approx: true,
      // The fbcdn URLs are time-limited and demand the crawler UA + Referer.
      headers: {
        'user-agent': UA.facebookBot,
        referer: 'https://www.facebook.com/',
      },
      duration: durationSeconds,
    };
  });

  return Result.create({
    source: meta.id,
    sourceLabel: 'Facebook',
    pageUrl,
    title,
    author: info?.author_name ?? null,
    authorUrl: info?.author_url ?? null,
    thumbnail: info?.thumbnail_url ?? null,
    duration: durationSeconds,
    description: null,
    variants: finalizeVariants(variants),
    note: 'Facebook CDN links expire quickly, so download soon after resolving.',
  });
}


