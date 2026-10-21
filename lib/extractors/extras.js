/**
 * Smaller, high-signal extractors that each take only a few lines of API
 * honestly given. Anything not covered here still works when yt-dlp is
 * installed, and the generic scraper covers a lot of long-tail sites.
 */

import { UA, getJson, getText, probe, fetchSafe } from '../http.js';
import { Result, decodeEntities, finalizeVariants } from '../util.js';

/* ------------------------------------------------------------------ *
 * Streamable
 * ------------------------------------------------------------------ */

const streamable = {
  meta: {
    id: 'streamable',
    label: 'Streamable',
    color: '#0f8b8d',
    hosts: ['streamable.com', 'www.streamable.com'],
  },
  match: (url) => /(^|\.)streamable\.com$/i.test(url.hostname),
  async resolve(url, ctx = {}) {
    const code = /^\/(?:e|s|o)?\/?([a-z0-9]{3,12})/i.exec(url.pathname)?.[1];
    if (!code) {
      const err = new Error('That Streamable link has no video code.');
      err.status = 400;
      throw err;
    }
    const data = await getJson(`https://api.streamable.com/videos/${code}`, {
      allowPrivate: ctx.allowPrivate,
      label: 'Streamable API',
      headers: { 'user-agent': UA.desktop },
    });

    const variants = [];
    for (const [key, file] of Object.entries(data?.files ?? {})) {
      if (!file?.url) continue;
      const isAudio = key === 'audio';
      const height = Number(file.height) || null;
      variants.push({
        id: key,
        label: isAudio ? 'Audio only' : file.height ? `${file.height}p` : key,
        ext: 'mp4',
        url: file.url.startsWith('http') ? file.url : `https://cdn-cf-east.streamable.com${file.url}`,
        kind: isAudio ? 'audio' : 'video',
        quality: height,
        height,
        width: Number(file.width) || null,
        size: Number(file.size) || null,
        headers: { referer: 'https://streamable.com/' },
      });
    }
    if (!variants.length) {
      const err = new Error('Streamable returned no files for that video.');
      err.status = 404;
      throw err;
    }

    return Result.create({
      source: 'streamable',
      sourceLabel: 'Streamable',
      pageUrl: `https://streamable.com/${code}`,
      title: data?.title?.trim() || `Streamable ${code}`,
      thumbnail: data?.thumbnail_url ?? null,
      duration: Number(data?.duration) || null,
      variants: finalizeVariants(variants),
    });
  },
};

/* ------------------------------------------------------------------ *
 * Dailymotion
 * ------------------------------------------------------------------ */

const dailymotion = {
  meta: {
    id: 'dailymotion',
    label: 'Dailymotion',
    color: '#00aaff',
    hosts: ['dailymotion.com', 'www.dailymotion.com', 'dai.ly'],
  },
  match: (url) => /(^|\.)(dailymotion\.com|dai\.ly)$/i.test(url.hostname),
  async resolve(url, ctx = {}) {
    let target = url;
    if (/(^|\.)dai\.ly$/i.test(url.hostname)) {
      const res = await fetchSafe(url.toString(), { allowPrivate: ctx.allowPrivate, headers: { 'user-agent': UA.desktop } });
      res.body?.cancel().catch(() => {});
      target = new URL(res.headers.get('location') ?? res.url);
    }
    const id = /\/video\/([a-z0-9]{5,10})/i.exec(target.pathname)?.[1] ?? /^\/?([a-z0-9]{5,10})$/i.exec(target.pathname)?.[1];
    if (!id) {
      const err = new Error('That Dailymotion link has no video id.');
      err.status = 400;
      throw err;
    }

    const data = await getJson(`https://www.dailymotion.com/player/metadata/video/${id}`, {
      allowPrivate: ctx.allowPrivate,
      label: 'Dailymotion metadata',
      headers: { 'user-agent': UA.desktop, referer: `https://www.dailymotion.com/video/${id}` },
    });

    const variants = [];
    const seen = new Set();
    for (const [quality, list] of Object.entries(data?.qualities ?? {})) {
      for (const entry of Array.isArray(list) ? list : []) {
        const fileUrl = typeof entry === 'string' ? entry : entry?.url;
        if (!fileUrl || seen.has(fileUrl)) continue;
        seen.add(fileUrl);
        const fromUrl = /[_-](\d{3,4})\.mp4/i.exec(fileUrl)?.[1];
        const height = Number.isFinite(Number(quality)) ? Number(quality) : fromUrl ? Number(fromUrl) : null;
        variants.push({
          id: `${quality}_${variants.length}`,
          label: height ? `${height}p` : quality,
          ext: 'mp4',
          url: fileUrl,
          kind: 'video',
          quality: height,
          height,
          bitrate: /H264-(\d+)\.mp4/.exec(fileUrl)?.[1] ? Number(/H264-(\d+)\.mp4/.exec(fileUrl)[1]) * 1000 : null,
          headers: { referer: `https://www.dailymotion.com/video/${id}` },
        });
      }
    }
    if (!variants.length) {
      const err = new Error('Dailymotion returned no downloadable quality for that video.');
      err.status = 404;
      throw err;
    }

    return Result.create({
      source: 'dailymotion',
      sourceLabel: 'Dailymotion',
      pageUrl: `https://www.dailymotion.com/video/${id}`,
      title: data?.title?.trim() || `Dailymotion ${id}`,
      author: data?.owner?.screenname ?? null,
      thumbnail: data?.thumbnail_1080_url ?? data?.thumbnail_720_url ?? null,
      duration: Number(data?.duration) || null,
      variants: finalizeVariants(variants),
      note: data?.isOnAir ? 'This looks like a live stream - only the point-in-time file is offered.' : null,
    });
  },
};

/* ------------------------------------------------------------------ *
 * Tumblr
 * ------------------------------------------------------------------ */

const tumblr = {
  meta: {
    id: 'tumblr',
    label: 'Tumblr',
    color: '#36465d',
    hosts: ['tumblr.com', 'www.tumblr.com'],
  },
  match: (url) => /(^|\.)tumblr\.com$/i.test(url.hostname),
  async resolve(url, ctx = {}) {
    const html = await getText(url.toString(), {
      allowPrivate: ctx.allowPrivate,
      label: 'Tumblr post',
      maxBytes: 8 * 1024 * 1024,
      headers: { 'user-agent': UA.googlebot },
    });

    const variants = [];
    const seen = new Set();
    const patterns = [
      /"(?:video_url|videoUrl|source_url)"\s*:\s*"(https:[^"]+?)"/g,
      /(https:\\?\/\\?\/[a-z0-9.-]*tumblr\.com\\?\/[^"'\s]*?\.mp4[^"'\s]*)/gi,
      /<meta[^>]+property=["']og:video(?::secure_url|:url)?["'][^>]*content=["']([^"']+)["']/gi,
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(html))) {
        const raw = (m[1] ?? m[0]).replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
        if (!raw.startsWith('http') || seen.has(raw)) continue;
        seen.add(raw);
        const fromName = /_(\d{3,4})\.mp4/i.exec(raw)?.[1];
        variants.push({
          id: `t${variants.length}`,
          label: fromName ? `${fromName}p` : 'Video',
          ext: 'mp4',
          url: raw,
          kind: 'video',
          quality: fromName ? Number(fromName) : null,
          headers: { referer: 'https://www.tumblr.com/' },
        });
      }
    }
    if (!variants.length) {
      const err = new Error('No video found on that Tumblr post.');
      err.status = 422;
      throw err;
    }

    return Result.create({
      source: 'tumblr',
      sourceLabel: 'Tumblr',
      pageUrl: url.toString(),
      title: decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim() || 'Tumblr video',
      thumbnail: /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1] ?? null,
      variants: finalizeVariants(variants),
    });
  },
};

/* ------------------------------------------------------------------ *
 * Imgur - the .mp4 sibling of an image id
 * ------------------------------------------------------------------ */

const imgur = {
  meta: {
    id: 'imgur',
    label: 'Imgur',
    color: '#89c623',
    hosts: ['imgur.com', 'www.imgur.com', 'i.imgur.com'],
  },
  match: (url) => /(^|\.)imgur\.com$/i.test(url.hostname),
  async resolve(url, ctx = {}) {
    if (/i\.imgur\.com$/i.test(url.hostname)) {
      const info = await probe(url.toString(), { allowPrivate: ctx.allowPrivate });
      if (!info.contentType?.startsWith('video/')) {
        const err = new Error('That Imgur link is not a video.');
        err.status = 422;
        throw err;
      }
      return Result.create({
        source: 'imgur',
        sourceLabel: 'Imgur',
        pageUrl: url.toString(),
        title: url.pathname.split('/').pop(),
        variants: finalizeVariants([
          {
            id: 'direct',
            label: info.size ? 'MP4' : 'Video',
            ext: 'mp4',
            url: url.toString(),
            kind: 'video',
            size: info.size,
            headers: { referer: 'https://imgur.com/' },
          },
        ]),
      });
    }

    const id = /^\/(?:a\/|gallery\/)?([a-zA-Z0-9]{5,10})/.exec(url.pathname)?.[1];
    if (!id) {
      const err = new Error('That Imgur link has no media id.');
      err.status = 400;
      throw err;
    }
    const mp4Url = `https://i.imgur.com/${id}.mp4`;
    const info = await probe(mp4Url, { allowPrivate: ctx.allowPrivate });
    if (!info.ok || !info.contentType?.startsWith('video/')) {
      const err = new Error('That Imgur post has no video version.');
      err.status = 422;
      throw err;
    }
    return Result.create({
      source: 'imgur',
      sourceLabel: 'Imgur',
      pageUrl: `https://imgur.com/${id}`,
      title: `Imgur ${id}`,
      variants: finalizeVariants([
        {
          id: 'mp4',
          label: 'MP4',
          ext: 'mp4',
          url: mp4Url,
          kind: 'video',
          size: info.size,
          headers: { referer: 'https://imgur.com/' },
        },
      ]),
    });
  },
};

export const extractors = [streamable, dailymotion, tumblr, imgur];
export default extractors;
