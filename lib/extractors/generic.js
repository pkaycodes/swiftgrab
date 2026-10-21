/**
 * Direct file + generic page extractors - the long tail.
 *
 * `direct`  : the link already IS a media file (or an HLS/DASH manifest).
 * `generic` : any other page. Scrapes every place a page hides a video and,
 *             when there is no video, falls back to its main image.
 */

import { UA, getText, probe } from '../http.js';
import * as hls from '../hls.js';
import {
  Result,
  decodeEntities,
  estimateSize,
  finalizeVariants,
  scrapeImageCandidate,
  scrapeMediaCandidates,
  scrapeTitle,
} from '../util.js';

const MEDIA_EXT_RE = /\.(mp4|m4v|mov|webm|m4a|mp3|jpe?g|png|webp|gif|avif|bmp|tiff?)(?:\?|#|$)/i;
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|avif|bmp|tiff?)(?:\?|#|$)/i;
const MANIFEST_EXT_RE = /\.(m3u8|mpd)(?:\?|#|$)/i;

const IMAGE_EXT_BY_PATH = {
  jpg: 'jpg',
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  gif: 'gif',
  avif: 'avif',
  bmp: 'bmp',
  tif: 'tif',
  tiff: 'tif',
};

function imageExtFromUrl(value) {
  try {
    const ext = /\.([a-z0-9]{2,5})$/i.exec(new URL(value).pathname)?.[1]?.toLowerCase();
    return IMAGE_EXT_BY_PATH[ext] ?? null;
  } catch {
    return null;
  }
}

const EXT_BY_MIME = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/mpeg': 'mpg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'm4a',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/tiff': 'tif',
  'application/vnd.apple.mpegurl': 'mp4',
  'application/x-mpegurl': 'mp4',
  'application/dash+xml': 'mp4',
};

/* ------------------------------------------------------------------ *
 * direct - a media URL was pasted
 * ------------------------------------------------------------------ */

export const direct = {
  meta: {
    id: 'direct',
    label: 'Direct file',
    color: '#8b5cf6',
    hosts: [],
  },
  match(url) {
    return MEDIA_EXT_RE.test(url.pathname) || MANIFEST_EXT_RE.test(url.pathname);
  },
  async resolve(url, ctx = {}) {
    const target = url.toString();

    if (MANIFEST_EXT_RE.test(url.pathname)) {
      const err = new Error(
        'That is an HLS/DASH manifest, not a single file. The segments have to be joined, which needs yt-dlp.'
      );
      err.status = 409;
      err.hint = 'yt-dlp';
      err.soft = true; // the caller may retry through yt-dlp
      throw err;
    }

    const info = ctx.probeInfo ?? (await probe(target, { allowPrivate: ctx.allowPrivate }));
    const mime = info.contentType?.split(';')[0].trim().toLowerCase() ?? '';
    const fromPath = url.pathname.match(MEDIA_EXT_RE)?.[1]?.toLowerCase() ?? null;
    const isImageByPath = IMAGE_EXT_RE.test(url.pathname);
    const kind = mime.startsWith('audio/')
      ? 'audio'
      : mime.startsWith('image/') || (!mime && isImageByPath)
        ? 'image'
        : 'video';
    const ext =
      EXT_BY_MIME[mime] ||
      (fromPath === 'jpeg' ? 'jpg' : fromPath === 'tiff' ? 'tif' : fromPath) ||
      (kind === 'image' ? 'jpg' : 'mp4');

    const allowed =
      !mime ||
      (/^(video|audio|image)\//i.test(mime) && mime !== 'image/svg+xml') ||
      /^application\/(octet-stream|vnd\.apple|dash|x-mpegurl)/i.test(mime);
    if (!allowed) {
      const err = new Error(`That link serves "${info.contentType}", not a media file.`);
      err.status = 422;
      throw err;
    }

    const name = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? 'media');
    return Result.create({
      source: 'direct',
      sourceLabel: 'Direct file',
      pageUrl: target,
      title: name.replace(MEDIA_EXT_RE, '') || (kind === 'image' ? 'image' : 'video'),
      variants: finalizeVariants([
        {
          id: 'file',
          label: kind === 'audio' ? 'Audio' : kind === 'image' ? 'Original image' : 'Original file',
          ext,
          url: target,
          kind,
          size: info.size,
          headers: { referer: `${url.protocol}//${url.hostname}/` },
        },
      ]),
      note: 'Downloaded straight from the source - no re-encoding.',
    });
  },
};

/* ------------------------------------------------------------------ *
 * generic - any other page
 * ------------------------------------------------------------------ */

export const generic = {
  meta: {
    id: 'generic',
    label: 'Web page',
    color: '#64748b',
    hosts: [],
  },
  match() {
    return true;
  },
  async resolve(url, ctx = {}) {
    const html = await getText(url.toString(), {
      allowPrivate: ctx.allowPrivate,
      label: `page ${url.hostname}`,
      maxBytes: 8 * 1024 * 1024,
      timeout: 25_000,
      headers: {
        'user-agent': UA.desktop,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
      },
    });

    const candidates = scrapeMediaCandidates(html, url.toString());
    // Manifests first: they are almost always the real stream on modern sites.
    candidates.sort((a, b) => {
      const score = (c) => (MANIFEST_EXT_RE.test(c.url) ? 0 : MEDIA_EXT_RE.test(c.url) ? 1 : 2);
      return score(a) - score(b);
    });

    const pageHeaders = { referer: `${url.protocol}//${url.hostname}/`, 'user-agent': UA.desktop };
    const checked = await Promise.all(
      candidates.slice(0, 8).map(async (candidate) => {
        if (MANIFEST_EXT_RE.test(candidate.url)) {
          return { candidate, manifest: true };
        }
        const info = await probe(candidate.url, { allowPrivate: ctx.allowPrivate });
        const type = info.contentType?.split(';')[0].trim() ?? '';
        if (!/^(video|audio)\//.test(type)) return null;
        return { candidate, info, type };
      })
    );

    const variants = [];

    // The first HLS manifest is worth opening properly: if SwiftGrab can
    // assemble it itself, that is a real download with no external tools.
    const manifest = checked.find((entry) => entry?.manifest && /\.m3u8/i.test(entry.candidate.url));
    if (manifest) {
      try {
        const renditions = await hls.inspect(manifest.candidate.url, {
          headers: pageHeaders,
          signal: ctx.signal,
        });
        for (const rendition of renditions) {
          variants.push({ ...rendition, id: `g_hls_${variants.length}` });
        }
      } catch (err) {
        const message = err?.hint === 'yt-dlp' ? err.message : `${err.message} yt-dlp can often still fetch it.`;
        variants.push({
          id: 'g_hls',
          label: 'Adaptive stream (HLS)',
          ext: 'mp4',
          url: null,
          engine: 'yt-dlp',
          kind: 'video',
          quality: 2000,
          note: message,
        });
      }
    }

    for (const entry of checked) {
      if (!entry || entry.manifest) continue;
      const height = /\/(\d{3,4})p?[/_.-]/.exec(entry.candidate.url)?.[1];
      variants.push({
        id: `g${variants.length}`,
        label: entry.type.startsWith('audio/')
          ? 'Audio'
          : height
            ? `${height}p`
            : entry.candidate.note.includes('og:video')
              ? 'Video (page metadata)'
              : 'Video',
        ext: EXT_BY_MIME[entry.type] ?? 'mp4',
        url: entry.candidate.url,
        kind: entry.type.startsWith('audio/') ? 'audio' : 'video',
        quality: height ? Number(height) : null,
        size: entry.info?.size ?? null,
        headers: pageHeaders,
      });
    }

    // A DASH manifest cannot be assembled natively, but yt-dlp can fetch it.
    const dash = checked.find((entry) => entry?.manifest && /\.mpd/i.test(entry.candidate.url));
    if (dash && !variants.some((v) => v.engine === 'yt-dlp')) {
      variants.push({
        id: 'g_dash',
        label: 'Adaptive stream (DASH)',
        ext: 'mp4',
        url: null,
        engine: 'yt-dlp',
        kind: 'video',
        quality: 1900,
        note: 'DASH streams must be muxed, so this one needs yt-dlp.',
      });
    }

    // No video: a page's main picture is still worth saving.
    if (!variants.length) {
      const image = scrapeImageCandidate(html, url.toString());
      if (image) {
        const info = await probe(image.url, { allowPrivate: ctx.allowPrivate }).catch(() => null);
        const type = info?.contentType?.split(';')[0].trim() ?? '';
        if (!type || (/^image\//i.test(type) && type !== 'image/svg+xml')) {
          variants.push({
            id: 'g_image',
            label: 'Image',
            ext: EXT_BY_MIME[type] ?? imageExtFromUrl(image.url) ?? 'jpg',
            url: image.url,
            kind: 'image',
            quality: image.height ?? null,
            width: image.width ?? null,
            height: image.height ?? null,
            size: info?.size ?? null,
            headers: pageHeaders,
          });
        }
      }
    }

    if (!variants.length) {
      const err = new Error(
        `No downloadable video or image found on ${url.hostname}. ` +
          'The page may require JavaScript, a login, or be behind a paywall - yt-dlp has dedicated extractors for many such sites.'
      );
      err.status = 404;
      err.hint = 'yt-dlp';
      err.soft = true;
      throw err;
    }

    const duration = variants.some((v) => v.kind === 'video')
      ? (() => {
          const raw =
            /"duration"\s*:\s*"?(\d+(?:\.\d+)?)"?/.exec(html)?.[1] ??
            /(?:PT|T)(\d+)M?(\d+(?:\.\d+)?)S/.exec(/<meta[^>]+itemprop=["']duration["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1] ?? '')?.[0];
          const value = Number(raw);
          return Number.isFinite(value) && value > 0 && value < 86_400 ? value : null;
        })()
      : null;

    const thumbnail =
      variants.find((v) => v.kind === 'image')?.url ??
      /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1] ??
      null;

    // Fill in estimated sizes now that we know the duration.
    for (const v of variants) {
      if (!v.size && v.bitrate) v.size = estimateSize(v.bitrate, duration);
      if (v.size && !v.approx) v.approx = false;
    }

    const title = scrapeTitle(html);
    const author =
      /<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1] ?? null;

    return Result.create({
      source: 'generic',
      sourceLabel: url.hostname.replace(/^www\./, ''),
      pageUrl: url.toString(),
      title: title || url.hostname,
      author: decodeEntities(author ?? '') || null,
      thumbnail,
      duration,
      variants: finalizeVariants(variants),
      note: variants.some((v) => v.engine === 'yt-dlp')
        ? 'The best quality on this page is an adaptive stream, which yt-dlp can fetch.'
        : variants.some((v) => v.kind === 'image')
          ? "This page's main image, taken from its metadata."
          : null,
    });
  },
};

export const extractors = [direct, generic];
export default extractors;
