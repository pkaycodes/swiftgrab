/**
 * The resolver: decides who handles a link and in what order.
 *
 * Order of preference
 *   1. A native extractor for that host  (fast, no external tools)
 *   2. A direct media URL                 (the link already IS the file)
 *   3. The generic page scraper           (og:video, JSON-LD, inline JSON)
 *   4. yt-dlp                             (when installed)
 *
 * Anything that only gives us an adaptive stream (m3u8/DASH) lands on yt-dlp
 * as well, because a plain HTTP GET cannot reassemble the segments.
 */

import { assertSafeUrl, toHttpError } from './http.js';
import { Result, finalizeVariants } from './util.js';
import * as ytdlp from './ytdlp.js';

import * as x from './extractors/x.js';
import * as tiktok from './extractors/tiktok.js';
import * as facebook from './extractors/facebook.js';
import * as instagram from './extractors/instagram.js';
import * as reddit from './extractors/reddit.js';
import * as vimeo from './extractors/vimeo.js';
import { extractors as extras, default as extrasDefault } from './extractors/extras.js';
import { direct, generic } from './extractors/generic.js';

const NATIVE = [x, tiktok, facebook, instagram, reddit, vimeo, ...(extras ?? extrasDefault)];

/**
 * Sites where writing our own parser would be pointless or fragile: the site
 * ships obfuscated, signed, JS-computed stream URLs. yt-dlp maintains the
 * machinery for these, so we hand them straight over.
 */
const YTDLP_FIRST = [
  'youtube.com',
  'youtu.be',
  'music.youtube.com',
  'twitch.tv',
  'soundcloud.com',
  'bandcamp.com',
  'bilibili.com',
  'vk.com',
  'ok.ru',
  'rumble.com',
  'odysee.com',
  'bitchute.com',
  'nicovideo.jp',
  'snapchat.com',
  'linkedin.com',
  'loom.com',
  'brighteon.com',
  'rumble.com',
  'spankbang.com', // generic coverage is nil for adult sites; yt-dlp knows them
  'crunchyroll.com',
  'kick.com',
  'caffeine.tv',
];

function hostMatches(hostname, suffix) {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  const bare = suffix.replace(/^www\./, '');
  return host === bare || host.endsWith(`.${bare}`);
}

function isYtdlpFirst(hostname) {
  return YTDLP_FIRST.some((suffix) => hostMatches(hostname, suffix));
}

/** Build a Result out of a yt-dlp info payload. */
function resultFromYtdlp(info, fallbackLabel) {
  const { variants } = ytdlp.variantsFromInfo(info);
  const usable = variants.filter((v) => v.engine === 'yt-dlp');
  if (!usable.length) {
    const err = new Error('yt-dlp found no downloadable format for that link.');
    err.status = 404;
    err.hint = 'yt-dlp';
    throw err;
  }

  const isGeneric = /^generic$/i.test(info?.extractor_key ?? '') || !info?.extractor_key;
  return Result.create({
    source: 'ytdlp',
    sourceLabel: info?.extractor_key ?? fallbackLabel,
    pageUrl: info?.webpage_url ?? null,
    title: info?.title?.trim() || info?.fulltitle?.trim() || `Video from ${info?.extractor ?? fallbackLabel}`,
    author: info?.uploader ?? info?.channel ?? info?.creator ?? null,
    authorUrl: info?.uploader_url ?? info?.channel_url ?? null,
    thumbnail: typeof info?.thumbnail === 'string' ? info.thumbnail : (info?.thumbnails?.at(-1)?.url ?? null),
    duration: Number(info?.duration) || null,
    description: info?.description?.trim()?.slice(0, 500) || null,
    variants: finalizeVariants(usable),
    note: isGeneric
      ? 'Resolved by yt-dlp.'
      : `Resolved by yt-dlp's dedicated ${info.extractor_key} extractor.`,
  });
}

async function viaYtdlp(url, { allowPrivate, label }) {
  const info = await ytdlp.listFormats(url.toString(), { allowPrivate });
  return resultFromYtdlp(info, label ?? url.hostname.replace(/^www\./, ''));
}

/**
 * @param {string} rawUrl
 * @param {{ allowPrivate?: boolean, forceEngine?: 'native'|'ytdlp'|null, depth?: number, onTrace?: (step: object) => void }} [options]
 */
export async function resolveUrl(rawUrl, options = {}) {
  const { allowPrivate = false, forceEngine = null, depth = 0, onTrace = () => {} } = options;
  if (depth > 2) {
    const err = new Error('That link redirected through too many other sites.');
    err.status = 400;
    throw err;
  }

  const url = await assertSafeUrl(rawUrl, { allowPrivate });
  const trace = (step, detail = {}) => onTrace({ depth, step, ...detail });
  const ytdlpInfo = await ytdlp.detect();
  const ctx = {
    allowPrivate,
    redispatch: (next) => resolveUrl(next, { ...options, depth: depth + 1 }),
  };

  if (forceEngine === 'ytdlp' || (forceEngine !== 'native' && isYtdlpFirst(url.hostname))) {
    if (!ytdlpInfo) {
      const err = new Error(
        `${url.hostname.replace(/^www\./, '')} needs yt-dlp - its video URLs are signed and computed in the browser, so they cannot be read from the page.`
      );
      err.status = 409;
      err.hint = 'yt-dlp';
      throw err;
    }
    trace('yt-dlp', { reason: forceEngine === 'ytdlp' ? 'requested' : 'site needs it' });
    return { result: await viaYtdlp(url, ctx), engine: 'yt-dlp', hosts: ['yt-dlp'] };
  }

  const native = NATIVE.find((module) => {
    try {
      return module.match(url);
    } catch {
      return false;
    }
  });

  const errors = [];
  const attempted = [];

  if (native && forceEngine !== 'ytdlp') {
    attempted.push(native.meta.id);
    trace(native.meta.id, { host: url.hostname });
    try {
      const result = await native.resolve(url, ctx);
      if (result?.variants?.length) {
        return { result, engine: native.meta.id, hosts: attempted };
      }
      errors.push(`${native.meta.label}: no variants`);
    } catch (err) {
      const { message } = toHttpError(err);
      errors.push(`${native.meta.label}: ${message}`);
      // Some answers are definitive and must not be papered over with
      // fallbacks: a 400 means the link itself is wrong for this site, a 422
      // means the post exists but holds no video.
      if (err?.status === 400 || err?.status === 422 || err?.hard) {
        err.attempts = errors;
        throw err;
      }
    }
  }

  if (!native && direct.match(url)) {
    attempted.push('direct');
    trace('direct', { path: url.pathname });
    try {
      const result = await direct.resolve(url, ctx);
      if (result?.variants?.length) return { result, engine: 'direct', hosts: attempted };
    } catch (err) {
      if (!err?.soft) {
        const { message } = toHttpError(err);
        errors.push(`Direct file: ${message}`);
      }
    }
  }

  // Page scraping. Skipped when a native extractor already owns the host and
  // returned a definitive answer, or when the site is JS-rendered.
  if (!native && !isYtdlpFirst(url.hostname)) {
    attempted.push('generic');
    trace('generic', { host: url.hostname });
    try {
      const result = await generic.resolve(url, ctx);
      if (result?.variants?.length) {
        return { result, engine: 'generic', hosts: attempted };
      }
    } catch (err) {
      const { message } = toHttpError(err);
      errors.push(`Page scan: ${message}`);
    }
  }

  if (ytdlpInfo) {
    attempted.push('yt-dlp');
    trace('yt-dlp', { reason: 'fallback' });
    try {
      return { result: await viaYtdlp(url, ctx), engine: 'yt-dlp', hosts: attempted };
    } catch (err) {
      const { message } = toHttpError(err);
      errors.push(`yt-dlp: ${message}`);
    }
  }

  const hint = ytdlpInfo ? null : 'yt-dlp';
  const error = new Error(
    `SwiftGrab could not find a downloadable video at that link.${errors.length ? ` Tried - ${errors.join(' | ')}` : ''}` +
      (hint ? ' Installing yt-dlp may cover this site.' : '')
  );
  error.status = 404;
  error.hint = hint;
  error.attempts = errors;
  throw error;
}

/** Which sites SwiftGrab claims to support, for the UI. */
export function supportedSites() {
  return [
    ...NATIVE.map((module) => ({ id: module.meta.id, label: module.meta.label, color: module.meta.color })),
    { id: 'direct', label: 'Direct media links', color: '#8b5cf6' },
    { id: 'generic', label: 'Any page with a video', color: '#64748b' },
    { id: 'ytdlp', label: '1,000+ more via yt-dlp', color: '#f59e0b' },
  ];
}
