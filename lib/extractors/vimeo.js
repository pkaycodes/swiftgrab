/**
 * Vimeo extractor.
 *
 * The player config endpoint lists every progressive rendition a video has.
 * Older/unlisted videos freely hand them over; newer ones are HLS-only, in
 * which case we offer the m3u8 through yt-dlp.
 */

import { UA, getJson } from '../http.js';
import * as hls from '../hls.js';
import { Result, finalizeVariants } from '../util.js';

export const meta = {
  id: 'vimeo',
  label: 'Vimeo',
  color: '#1ab7ea',
  hosts: ['vimeo.com', 'www.vimeo.com', 'player.vimeo.com', 'vimeo.com.au'],
};

export function match(url) {
  return /(^|\.)vimeo\.com$/i.test(url.hostname);
}

export function videoId(url) {
  return (
    /\/video\/(\d{6,15})/.exec(url.pathname)?.[1] ??
    /^\/(\d{6,15})/.exec(url.pathname)?.[1] ??
    /\/channels\/[^/]+\/(\d{6,15})/.exec(url.pathname)?.[1] ??
    /\/groups\/[^/]+\/videos\/(\d{6,15})/.exec(url.pathname)?.[1] ??
    url.searchParams.get('clip_id') ??
    null
  );
}

export async function resolve(url, ctx = {}) {
  const id = videoId(url);
  if (!id) {
    const err = new Error('That Vimeo link has no video id. Use a link like https://vimeo.com/123456789.');
    err.status = 400;
    throw err;
  }

  const pageUrl = `https://vimeo.com/${id}`;
  const config = await getJson(`https://player.vimeo.com/video/${id}/config`, {
    allowPrivate: ctx.allowPrivate,
    label: 'Vimeo config',
    timeout: 20_000,
    headers: {
      'user-agent': UA.desktop,
      referer: pageUrl,
      accept: 'application/json',
    },
  });

  if (config?.error) {
    const err = new Error(`Vimeo refused the video: ${config.error}`);
    err.status = 404;
    throw err;
  }

  const video = config?.video ?? {};
  const files = config?.request?.files ?? {};
  const variants = [];
  let hidden = false;

  for (const [index, file] of (files.progressive ?? []).entries()) {
    if (!file?.url) continue;
    const height = Number(file.height) || null;
    variants.push({
      id: `p${index}`,
      label: file.quality ? String(file.quality) : height ? `${height}p` : `MP4 ${index + 1}`,
      ext: 'mp4',
      url: file.url,
      kind: 'video',
      quality: height,
      height,
      width: Number(file.width) || null,
      fps: Number(file.fps) || null,
      size: null,
      approx: true,
      headers: { referer: pageUrl, 'user-agent': UA.desktop },
    });
  }

  const hlsCdn = files.hls?.cdns ? Object.values(files.hls.cdns)[0] : null;
  const hlsUrl = files.hls?.url ?? hlsCdn?.url ?? null;
  const dashUrl = files.dash?.cdns?.[Object.keys(files.dash?.cdns ?? {})[0]]?.url ?? null;
  hidden = (files.progressive ?? []).length === 0;

  // Prefer assembling the HLS stream ourselves. Whether that is possible
  // depends on the stream's real packaging, which hls.inspect determines by
  // reading the init segment rather than trusting the playlist's DRM claim.
  if (hlsUrl) {
    try {
      const renditions = await hls.inspect(hlsUrl, {
        headers: { referer: pageUrl, 'user-agent': UA.desktop },
        label: 'Vimeo HLS',
        signal: ctx.signal,
      });
      renditions.forEach((rendition, index) => variants.push({ ...rendition, id: `hls_${index}` }));
    } catch (err) {
      variants.push({
        id: 'hls',
        label: `HLS${video.height ? ` ${video.height}p` : ''}`,
        ext: 'mp4',
        url: null,
        engine: 'yt-dlp',
        kind: 'video',
        quality: (Number(video.height) || 0) + 1,
        height: Number(video.height) || null,
        note: `${err.message} yt-dlp may still fetch it.`,
      });
    }
  } else if (dashUrl) {
    variants.push({
      id: 'dash',
      label: `DASH${video.height ? ` ${video.height}p` : ''}`,
      ext: 'mp4',
      url: null,
      engine: 'yt-dlp',
      kind: 'video',
      quality: (Number(video.height) || 0) + 1,
      height: Number(video.height) || null,
      note: 'DASH streams must be muxed, so this one needs yt-dlp.',
    });
  }

  if (!variants.length) {
    const err = new Error(
      'Vimeo exposed no downloadable stream for that video - it is likely password-protected, unlisted with domain restrictions, or a rental.'
    );
    err.status = 404;
    throw err;
  }

  const nativeAvailable = variants.some((v) => v.engine === 'hls');

  return Result.create({
    source: meta.id,
    sourceLabel: 'Vimeo',
    pageUrl,
    title: video.title?.trim() || config?.video?.title || `Vimeo video ${id}`,
    author: video.owner?.name ?? null,
    authorUrl: video.owner?.url ?? null,
    thumbnail: video.thumbs?.[video.thumbs.length - 1] ?? video.thumbnail_url ?? null,
    duration: Number(video.duration) || null,
    description: video.description?.trim()?.slice(0, 500) || null,
    variants: finalizeVariants(variants),
    note: hidden
      ? nativeAvailable
        ? 'This video has no single-file version, so SwiftGrab assembles the HLS renditions itself.'
        : 'Vimeo ships this video as DRM-protected adaptive chunks, so there is no plain file to download. yt-dlp is listed as an option but will probably fail too.'
      : null,
  });
}
