/**
 * X / Twitter extractor.
 *
 * Public tweets (and their video) are readable without auth via the
 * syndication payload X serves to embedded tweets. We ask the FxTwitter
 * mirror first because it returns one clean, already-deduplicated URL list,
 * then fall back to X's own CDN endpoint.
 */

import { UA, fetchSafe, getJson, probe } from '../http.js';
import { Result, finalizeVariants } from '../util.js';

export const meta = {
  id: 'x',
  label: 'X',
  color: '#1d9bf0',
  hosts: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'm.twitter.com', 't.co'],
};

export function match(url) {
  return meta.hosts.includes(url.hostname.toLowerCase().replace(/^m\./, 'm.'));
}

/** Extract the numeric status id from any of X's many URL shapes. */
export function statusId(url) {
  return (
    /\/status(?:es)?\/(\d{5,25})/.exec(url.pathname)?.[1] ??
    /\/i\/web\/status\/(\d{5,25})/.exec(url.pathname)?.[1] ??
    // Some clients emit /user/status/1234567890?ref_src=... which the first
    // pattern already covers; this catches bare-id links.
    url.searchParams.get('status') ??
    null
  );
}

function syndicationToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

/**
 * The encoded size of an X video variant lives in its URL path, e.g.
 * `/vid/avc1/728x720/kF5AeH6MK.mp4`. fxtwitter's own `width`/`height` describe
 * the *source* video instead - it reports 886x876 for that same file - so the
 * path is the honest source for a quality label.
 */
function dimensionsFromVariantUrl(rawUrl) {
  const match = /\/(\d{2,5})x(\d{2,5})\//.exec(rawUrl ?? '');
  if (!match) return { width: null, height: null };
  return { width: Number(match[1]), height: Number(match[2]) };
}

function qualityLabel(height, bitrate) {
  if (height) return `${height}p`;
  if (bitrate) return `${Math.round(bitrate / 1000)} kbps`;
  return 'Video';
}

/**
 * Every variant fxtwitter knows about for one video, so the quality picker
 * offers a real choice rather than whatever fxtwitter happened to pick.
 *
 * The m3u8 entry is marked yt-dlp on purpose: X serves that stream with its
 * audio in separate renditions, so only yt-dlp can mux it into one file.
 *
 * Sizes are deliberately left null: fxtwitter's `bitrate` for these files is
 * the manifest's combined audio+video bandwidth and overstates the mp4 by
 * roughly 3x, so `viaFxTwitter` asks the CDN for the real length instead.
 */
function variantsFromVideo(video, videoIndex) {
  const list =
    Array.isArray(video.variants) && video.variants.length ? video.variants : (video.formats ?? []);

  const out = [];
  for (const variant of list) {
    if (!variant?.url) continue;
    const isHls = /\.m3u8(\?|$)/i.test(variant.url) || /mpegurl/i.test(variant.content_type ?? '');
    const { width, height } = dimensionsFromVariantUrl(variant.url);
    const bitrate = Number(variant.bitrate) || null;
    out.push({
      id: `fx${videoIndex}_${out.length}`,
      label: isHls ? (height || bitrate ? `HLS ${qualityLabel(height, bitrate)}` : 'HLS') : qualityLabel(height, bitrate),
      ext: 'mp4',
      url: variant.url,
      kind: 'video',
      quality: height,
      width,
      height,
      // Only trustworthy for the HLS entry, where it is the manifest's own figure.
      bitrate: isHls ? bitrate : null,
      size: null,
      approx: false,
      engine: isHls ? 'yt-dlp' : 'direct',
      note: isHls ? "X keeps this stream's audio separate, so yt-dlp muxes it into one file." : null,
      headers: { referer: 'https://x.com/', 'user-agent': UA.desktop },
    });
  }

  // A payload with no variant list still names one playable file.
  if (!out.length && video.url) {
    out.push({
      id: `fx${videoIndex}_0`,
      label: 'Video',
      ext: video.url.match(/\.(\w{2,4})(?:\?|$)/)?.[1] ?? 'mp4',
      url: video.url,
      kind: 'video',
      quality: video.height ?? null,
      width: video.width ?? null,
      height: video.height ?? null,
      size: null,
      headers: { referer: 'https://x.com/', 'user-agent': UA.desktop },
    });
  }

  return out;
}

/** Fill in real byte sizes, since these files are small and X's own figure is not. */
async function attachRealSizes(variants, ctx) {
  await Promise.all(
    variants
      .filter((v) => v.engine === 'direct' && v.url)
      .map(async (variant) => {
        const info = await probe(variant.url, {
          headers: variant.headers,
          allowPrivate: ctx.allowPrivate,
          signal: ctx.signal,
        });
        if (info?.size) variant.size = info.size;
      })
  );
}

/** Every mp4 quality from the fxtwitter mirror. */
async function viaFxTwitter(id, pageUrl, ctx = {}) {
  let payload;
  try {
    payload = await getJson(`https://api.fxtwitter.com/status/${id}`, {
      label: 'fxtwitter',
      headers: { 'user-agent': UA.desktop },
      timeout: 15_000,
    });
  } catch {
    return null;
  }
  const tweet = payload?.tweet;
  if (!tweet) return null;

  const media = tweet.media ?? {};
  const videos = Array.isArray(media.videos) ? media.videos : [];
  if (!videos.length) return null;

  const duration = Number.isFinite(videos[0]?.duration) ? videos[0].duration : null;
  const variants = videos.flatMap((video, index) => variantsFromVideo(video, index));
  if (!variants.length) return null;

  await attachRealSizes(variants, ctx).catch(() => {});

  return Result.create({
    source: meta.id,
    sourceLabel: 'X',
    pageUrl,
    title: tweet.text?.trim() || `Tweet by @${tweet.author?.screen_name ?? 'unknown'}`,
    author: tweet.author?.name ?? null,
    authorUrl: tweet.author?.url ?? (tweet.author?.screen_name ? `https://x.com/${tweet.author.screen_name}` : null),
    thumbnail: media.thumbnail_url ?? tweet.author?.avatar_url ?? null,
    duration,
    description: tweet.text?.trim() || null,
    variants: finalizeVariants(variants),
    note: videos.length > 1 ? `${videos.length} videos in this post - each is listed below.` : null,
  });
}

/** Highest quality mp4 straight from X's own syndication CDN. */
async function viaSyndication(id, pageUrl) {
  const token = syndicationToken(id);
  const payload = await getJson(
    `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token}&lang=en`,
    {
      label: 'X syndication',
      headers: {
        'user-agent': UA.desktop,
        referer: 'https://platform.twitter.com/',
        accept: 'application/json',
      },
      timeout: 15_000,
    }
  );

  const mediaDetails = Array.isArray(payload?.mediaDetails) ? payload.mediaDetails : [];
  const videoMedia = mediaDetails.filter((m) => m?.type === 'video' && m.video_info?.variants);
  if (!videoMedia.length) {
    const err = new Error(
      'This post has no downloadable video. If it is a photo, video-only or login-only post, SwiftGrab cannot fetch it.'
    );
    err.status = 404;
    throw err;
  }

  const variants = [];
  videoMedia.forEach((item, itemIndex) => {
    const durationSeconds = Number.isFinite(item.video_info?.duration_millis)
      ? item.video_info.duration_millis / 1000
      : null;
    const mp4s = (item.video_info.variants ?? [])
      .filter((v) => v?.content_type === 'video/mp4' && v.url)
      .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
    mp4s.forEach((v, i) => {
      variants.push({
        id: `sy${itemIndex}_${i}`,
        label: mp4s.length > 1 ? (v.bitrate ? `${Math.round(v.bitrate / 1000)} kbps` : `MP4 ${i + 1}`) : 'MP4',
        ext: 'mp4',
        url: v.url,
        kind: 'video',
        bitrate: v.bitrate ?? null,
        size: estimateSize(v.bitrate, durationSeconds),
        approx: true,
        headers: { referer: 'https://x.com/', 'user-agent': UA.desktop },
      });
    });
  });

  const user = payload.user ?? {};
  return Result.create({
    source: meta.id,
    sourceLabel: 'X',
    pageUrl,
    title: payload.text?.trim() || `Tweet by @${user.screen_name ?? 'unknown'}`,
    author: user.name ?? null,
    authorUrl: user.screen_name ? `https://x.com/${user.screen_name}` : null,
    thumbnail: mediaDetails[0]?.media_url_https ?? null,
    duration: (payload.video?.duration_millis ?? videoMedia[0]?.video_info?.duration_millis) / 1000 || null,
    description: payload.text?.trim() || null,
    variants: finalizeVariants(variants),
    note: videoMedia.length > 1 ? `${videoMedia.length} videos in this post.` : null,
  });
}

/**
 * Resolve an X link. t.co short links are followed first so the extractor
 * still works when someone pastes a shared link.
 */
export async function resolve(url, ctx = {}) {
  let target = url;

  if (url.hostname.toLowerCase() === 't.co') {
    const res = await fetchSafe(url.toString(), {
      method: 'GET',
      headers: { 'user-agent': UA.desktop },
      allowPrivate: ctx.allowPrivate,
    });
    res.body?.cancel().catch(() => {});
    const landed = res.headers.get('location') ?? res.url;
    target = new URL(landed);
    if (!match(target)) {
      const err = new Error(`That t.co link points to ${target.hostname}, which is not an X post.`);
      err.status = 400;
      throw err;
    }
  }

  const id = statusId(target);
  if (!id) {
    const err = new Error('That X link has no post id. Use a link like https://x.com/user/status/1234567890.');
    err.status = 400;
    throw err;
  }

  const pageUrl = `https://x.com/i/status/${id}`;
  const primary = await viaFxTwitter(id, pageUrl, ctx).catch(() => null);
  if (primary?.variants?.length) return primary;
  return viaSyndication(id, pageUrl);
}
