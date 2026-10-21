/**
 * Reddit extractor.
 *
 * Reddit is the most awkward of the bunch in 2026, and what is reachable
 * differs a lot by network. On the network this was developed against, the
 * verified reality is:
 *
 *   - the anonymous `.json` API      403s with a block page
 *   - old.reddit.com                 redirects to a login wall (reason=lor2)
 *   - /svc/shreddit/comments/...     serves the shreddit shell, no media
 *   - embed.reddit.com               serves the shreddit shell too - the HTML
 *                                    carries a thumbnail and nothing else,
 *                                    because the player fetches its source
 *                                    from /svc/shreddit/graphql at runtime
 *   - RSS (both listings and a single post)  works, but is tightly rate
 *                                    limited (429 after a couple of requests)
 *                                    and is metadata only - no media URL
 *   - oEmbed                         works, and is the one reliable metadata
 *                                    source. It refuses the shorthand
 *                                    `/comments/<id>/` form with
 *                                    `400 invalid URL value` and insists on a
 *                                    full permalink with the subreddit in it,
 *                                    which is what `permalinkFor` preserves.
 *
 * So metadata is reliable and the media URL usually is not, which is why the
 * failure path points at yt-dlp instead of pretending to have failed for an
 * unknown reason. The strategies below are tried in order of what they yield:
 *
 *   1. the public post JSON  (full metadata + media, where Reddit still allows it)
 *   2. oEmbed for metadata, then embed.reddit.com in case it carries media
 *   3. a clear "this needs yt-dlp" error rather than a mystery 404
 *
 * One quirk worth knowing: Reddit serves video and audio as *separate*
 * tracks. The plain MP4 is silent. When the tracks are split, only yt-dlp can
 * produce a single file with sound, so the variants say so explicitly and the
 * audio track is offered on its own.
 */

import { UA, getJson, getText, probe } from '../http.js';
import * as hls from '../hls.js';
import { Result, estimateSize, finalizeVariants } from '../util.js';

export const meta = {
  id: 'reddit',
  label: 'Reddit',
  color: '#ff4500',
  hosts: [
    'reddit.com',
    'www.reddit.com',
    'old.reddit.com',
    'new.reddit.com',
    'm.reddit.com',
    'np.reddit.com',
    'redd.it',
    'v.redd.it',
    'i.redd.it',
    'packaged-media.redd.it',
  ],
};

const REDDIT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const REDDIT_HEADERS = { 'user-agent': REDDIT_UA, referer: 'https://www.reddit.com/' };

export function match(url) {
  return /(^|\.)redd\.it$|(^|\.)reddit\.com$/i.test(url.hostname);
}

export function postId(url) {
  return (
    /\/comments\/([a-z0-9]{5,12})/i.exec(url.pathname)?.[1] ??
    /^\/([a-z0-9]{5,12})\/?$/i.exec(url.pathname)?.[1] ??
    null
  );
}

/** The v.redd.it media id hiding in any of the URL shapes Reddit uses. */
function videoIdFromUrl(url) {
  const match = /^\/?([a-z0-9]{6,10})(?:[/.]|$)/i.exec(url.pathname);
  return match ? match[1] : null;
}

/**
 * Build the canonical permalink for a post.
 *
 * This matters more than it looks: Reddit's oEmbed endpoint answers
 * `400 invalid URL value` to the shorthand `/comments/<id>/` form and only
 * accepts the full permalink with the subreddit in it. So when the link the
 * user pasted already names the subreddit - which is the normal case - keep
 * it instead of throwing that information away.
 */
export function permalinkFor(inputUrl, id) {
  const typed = /\/(r|user)\/([^/]+)\/comments\/([a-z0-9]{5,12})/i.exec(inputUrl.pathname);
  if (typed) {
    const [, kind, name, foundId] = typed;
    return `https://www.reddit.com/${kind}/${name}/comments/${foundId}/`;
  }

  const shorthand = /\/comments\/([a-z0-9]{5,12})/i.exec(inputUrl.pathname);
  if (shorthand) return `https://www.reddit.com/comments/${shorthand[1]}/`;

  return `https://www.reddit.com/comments/${id}/`;
}

/** True when a permalink carries the subreddit oEmbed requires. */
function oembedAccepts(permalink) {
  return /^\/(?:r|user)\//i.test(new URL(permalink).pathname);
}

/** Reddit's progressive MP4 is video-only; the audio track is a sibling file. */
function deriveAudioUrl(fallbackUrl) {
  if (!fallbackUrl) return null;
  try {
    const url = new URL(fallbackUrl);
    const file = url.pathname.split('/').pop() ?? '';
    if (!/^DASH.*\.mp4$/i.test(file)) return null;
    const audioName = file.replace(/DASH_[^.]+\.mp4$/i, 'DASH_audio.mp4');
    if (audioName === file) return null;
    url.pathname = url.pathname.replace(/[^/]+$/, audioName);
    return url.toString();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Media discovery from loose HTML / JSON
 * ------------------------------------------------------------------ */

const MEDIA_KEY_RE =
  /"(fallback_url|hls_url|dash_url|scrubber_media_url|content_url|url)"\s*:\s*"(https:[^"]+?)"/g;
const V_REDDIT_RE = /https?:(?:\\?\/){2}v\.redd\.it\\?\/([a-z0-9]{6,10})\\?\/([A-Za-z0-9_.]+\.(?:mp4|m3u8))/gi;

function collectRedditMedia(html) {
  const found = { fallback: null, hls: null, dash: null, videoId: null, progressive: new Set() };

  let match;
  while ((match = MEDIA_KEY_RE.exec(html))) {
    const url = match[2].replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
    if (!url.startsWith('http')) continue;
    if (match[1] === 'fallback_url' && !found.fallback) found.fallback = url;
    if (match[1] === 'hls_url' && !found.hls) found.hls = url;
    if (match[1] === 'dash_url' && !found.dash) found.dash = url;
    const id = /v\.redd\.it\/([a-z0-9]{6,10})\//i.exec(url)?.[1];
    if (id) found.videoId ??= id;
  }

  while ((match = V_REDDIT_RE.exec(html))) {
    const [rawUrl, id, file] = match;
    const url = rawUrl.replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
    found.videoId ??= id;
    if (/HLSPlaylist\.m3u8/i.test(file)) found.hls ??= url;
    else if (/DASH.*\.mp4/i.test(file)) found.progressive.add(url);
    else if (/\.m3u8/i.test(file)) found.hls ??= url;
  }

  // The embed player declares its source as an attribute.
  const playerSrc = /<shreddit-player[^>]+src=["']([^"']+)["']/i.exec(html)?.[1];
  if (playerSrc) {
    const id = /v\.redd\.it\/([a-z0-9]{6,10})\//i.exec(playerSrc)?.[1];
    if (id) found.videoId ??= id;
    if (/\.m3u8/i.test(playerSrc)) found.hls ??= playerSrc;
  }

  return found;
}

/* ------------------------------------------------------------------ *
 * Variant construction
 * ------------------------------------------------------------------ */

/**
 * @param {ReturnType<typeof collectRedditMedia>} media
 * @param {{title?: string, author?: string|null, permalink?: string, duration?: number|null}} info
 */
async function buildResult(media, info, ctx = {}) {
  const variants = [];
  const videoId = media.videoId;

  // 1. HLS first. If Reddit's packaging has muxed audio, SwiftGrab can
  //    assemble it into one real file, and hls.inspect tells us.
  const hlsUrl = media.hls ?? (videoId ? `https://v.redd.it/${videoId}/HLSPlaylist.m3u8` : null);
  if (hlsUrl) {
    try {
      const renditions = await hls.inspect(hlsUrl, {
        headers: REDDIT_HEADERS,
        label: 'Reddit HLS',
        signal: ctx.signal,
      });
      renditions.forEach((rendition, index) => variants.push({ ...rendition, id: `hls_${index}` }));
    } catch (err) {
      variants.push({
        id: 'hls',
        label: 'HLS stream',
        ext: 'mp4',
        url: null,
        engine: 'yt-dlp',
        kind: 'video',
        quality: 9999,
        note: `${err.message} yt-dlp can fetch and mux it.`,
      });
    }
  }

  // 2. The progressive MP4, when Reddit still offers one.
  const progressive = media.fallback ?? [...media.progressive][0] ?? null;
  if (progressive) {
    const info2 = await probe(progressive, { allowPrivate: ctx.allowPrivate });
    const height = /DASH_(\d{3,4})/i.exec(progressive)?.[1];
    variants.push({
      id: 'progressive',
      label: `MP4${height ? ` ${height}p` : ''}`,
      ext: 'mp4',
      url: progressive,
      kind: 'video',
      quality: height ? Number(height) : null,
      height: height ? Number(height) : null,
      size: info2.size,
      headers: REDDIT_HEADERS,
    });
  }

  // 3. The audio track on its own, so a silent MP4 can be paired up manually.
  const audioUrl = deriveAudioUrl(progressive ?? media.fallback);
  if (audioUrl) {
    variants.push({
      id: 'audio',
      label: 'Audio track only',
      ext: 'm4a',
      url: audioUrl,
      kind: 'audio',
      bitrate: 128_000,
      size: estimateSize(128_000, info.duration ?? null),
      approx: true,
      headers: REDDIT_HEADERS,
    });
  }

  // 4. DASH needs a muxer, so it is always a yt-dlp job.
  if (media.dash && !variants.some((v) => v.kind === 'video' && v.engine === 'hls')) {
    variants.push({
      id: 'dash',
      label: 'DASH stream',
      ext: 'mp4',
      url: null,
      engine: 'yt-dlp',
      kind: 'video',
      quality: 9998,
      note: 'DASH must be muxed, so this one needs yt-dlp.',
    });
  }

  if (!variants.some((v) => v.kind === 'video')) {
    const err = new Error('No downloadable video was found for that Reddit post.');
    err.status = 404;
    err.hint = 'yt-dlp';
    throw err;
  }

  const hasNativeMuxed = variants.some((v) => v.kind === 'video' && v.engine === 'hls');
  const hasYtdlp = variants.some((v) => v.engine === 'yt-dlp');

  return Result.create({
    source: meta.id,
    sourceLabel: 'Reddit',
    pageUrl: info.permalink ?? null,
    title: info.title?.trim() || 'Reddit video',
    author: info.author ?? null,
    authorUrl: info.author?.startsWith('u/') ? `https://www.reddit.com/user/${info.author.slice(2)}/` : null,
    thumbnail: info.thumbnail ?? null,
    duration: info.duration ?? null,
    variants: finalizeVariants(variants),
    note: hasNativeMuxed
      ? 'Reddit stores this as one muxed stream, so it downloads as a single playable file.'
      : hasYtdlp
        ? 'Reddit keeps video and audio apart. The plain MP4 is silent - the yt-dlp entry is the one that gives you a single file with sound.'
        : 'Reddit keeps video and audio apart, so the MP4 here is video-only. Grab the audio track too if you need sound.',
  });
}

/* ------------------------------------------------------------------ *
 * Strategy 1: the public post JSON
 * ------------------------------------------------------------------ */

async function viaPostJson(id, ctx) {
  const endpoints = [
    `https://www.reddit.com/comments/${id}.json?raw_json=1&limit=1`,
    `https://old.reddit.com/comments/${id}.json?raw_json=1&limit=1`,
  ];

  for (const endpoint of endpoints) {
    let listing;
    try {
      listing = await getJson(endpoint, {
        allowPrivate: ctx.allowPrivate,
        label: 'Reddit post JSON',
        timeout: 20_000,
        headers: { ...REDDIT_HEADERS, accept: 'application/json' },
      });
    } catch {
      continue;
    }

    const post = Array.isArray(listing)
      ? listing[0]?.data?.children?.[0]?.data
      : listing?.data?.children?.[0]?.data;
    if (!post) continue;

    const redditVideo = [
      post.secure_media?.reddit_video,
      post.media?.reddit_video,
      post.preview?.reddit_video_preview,
      post.crosspost_parent_list?.[0]?.secure_media?.reddit_video,
    ].find(Boolean);

    const info = {
      title: post.title,
      author: post.author ? `u/${post.author}` : null,
      permalink: `https://www.reddit.com${post.permalink ?? `/comments/${id}/`}`,
      thumbnail: post.thumbnail?.startsWith('http') ? post.thumbnail : null,
      duration: Number.isFinite(redditVideo?.duration) ? redditVideo.duration : null,
    };

    if (redditVideo) {
      return buildResult(
        {
          fallback: redditVideo.fallback_url ? String(redditVideo.fallback_url).replace(/&amp;/g, '&') : null,
          hls: redditVideo.hls_url ? String(redditVideo.hls_url).replace(/&amp;/g, '&') : null,
          dash: redditVideo.dash_url ? String(redditVideo.dash_url).replace(/&amp;/g, '&') : null,
          videoId: /v\.redd\.it\/([a-z0-9]{6,10})\//i.exec(String(redditVideo.fallback_url ?? ''))?.[1] ?? null,
          progressive: new Set(),
        },
        info,
        ctx
      );
    }

    if (post.is_gallery) {
      const err = new Error('That is a Reddit image gallery, not a video.');
      err.status = 422;
      throw err;
    }

    // The post links somewhere else - hand the destination back to the
    // resolver so a Reddit post about a TikTok link still works.
    const external = post.url_overridden_by_dest || post.url;
    if (external && !/reddit\.com|redd\.it/.test(external) && typeof ctx.redispatch === 'function') {
      try {
        const nested = await ctx.redispatch(external);
        return {
          ...nested,
          note: `Reddit post by ${info.author ?? 'someone'} linking to ${nested.sourceLabel}. ${nested.note ?? ''}`.trim(),
        };
      } catch {
        /* fall through */
      }
    }

    if (external && /\.(mp4|m4v|mov|webm)(\?|$)/i.test(external)) {
      return Result.create({
        source: meta.id,
        sourceLabel: 'Reddit',
        pageUrl: info.permalink,
        title: info.title,
        author: info.author,
        variants: finalizeVariants([
          {
            id: 'direct',
            label: 'Video',
            ext: external.match(/\.(mp4|m4v|mov|webm)/i)?.[1]?.toLowerCase() ?? 'mp4',
            url: external,
            kind: 'video',
            headers: REDDIT_HEADERS,
          },
        ]),
      });
    }

    const err = new Error('That Reddit post does not contain a video.');
    err.status = 422;
    throw err;
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * Strategies 2 and 3: oEmbed, then the embed player page
 * ------------------------------------------------------------------ */

async function viaOembedAndEmbed(url, id, ctx) {
  let permalink = permalinkFor(url, id);
  let title = null;
  let author = null;

  // oEmbed only answers when the permalink names the subreddit - the shorthand
  // form is a guaranteed 400, so don't spend a request (and a rate-limit slot)
  // finding that out.
  if (oembedAccepts(permalink)) {
    try {
      const oembed = await getJson(
        `https://www.reddit.com/oembed?url=${encodeURIComponent(permalink)}&format=json`,
        {
          allowPrivate: ctx.allowPrivate,
          label: 'Reddit oEmbed',
          timeout: 15_000,
          headers: { ...REDDIT_HEADERS, accept: 'application/json' },
        }
      );
      // oEmbed answers 200 even for ids that do not exist - an empty author is
      // how it says "no such post".
      if (oembed?.author_name) {
        title = oembed.title ?? null;
        author = `u/${oembed.author_name}`;
        const canonical = /href="(https:\/\/www\.reddit\.com\/[^"]*\/comments\/[^"]+)"/i.exec(oembed.html ?? '')?.[1];
        if (canonical) permalink = canonical;
      }
    } catch {
      /* keep the fallback permalink */
    }
  }

  const embedPath = new URL(permalink).pathname.replace(/\/?$/, '/');
  const embedUrl = `https://embed.reddit.com${embedPath}?embed=true&depth=1&showmedia=true`;

  let html = '';
  try {
    html = await getText(embedUrl, {
      allowPrivate: ctx.allowPrivate,
      label: 'Reddit embed page',
      timeout: 25_000,
      maxBytes: 8 * 1024 * 1024,
      headers: { ...REDDIT_HEADERS, accept: 'text/html,application/xhtml+xml' },
    });
  } catch {
    /* the embed host is occasionally slow; report what we know below */
  }

  const media = collectRedditMedia(html);

  // The embed page's own title is a decent fallback when oEmbed was empty.
  title ??= /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(html)?.[1]?.replace(/\s*-\s*Reddit\s*$/i, '').trim() ?? null;
  author ??= /"author"\s*:\s*"([^"]{2,32})"/.exec(html)?.[1] ? `u/${/"author"\s*:\s*"([^"]{2,32})"/.exec(html)[1]}` : null;
  const thumbnail = /"thumbnail"\s*:\s*"(https:[^"]+)"/.exec(html)?.[1]?.replace(/\\\//g, '/') ?? null;

  if (!media.fallback && !media.hls && !media.videoId) {
    const err = new Error(
      title
        ? `Reddit would not hand over the media for "${title}". Reddit blocks anonymous access from this network, so this one needs yt-dlp (and it may need your cookies too).`
        : 'Reddit blocked the request for that post. Its anonymous API refuses many networks now, so this one needs yt-dlp.'
    );
    err.status = 401;
    err.hint = 'yt-dlp';
    throw err;
  }

  return buildResult(media, { title, author, permalink, thumbnail, duration: null }, ctx);
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export async function resolve(url, ctx = {}) {
  // A bare v.redd.it link: the media id is right there in the path.
  if (/v\.redd\.it$/i.test(url.hostname)) {
    const videoId = videoIdFromUrl(url);
    if (!videoId) {
      const err = new Error('That v.redd.it link has no media id.');
      err.status = 400;
      throw err;
    }
    const isProgressive = /\.mp4$/i.test(url.pathname);
    return buildResult(
      {
        fallback: isProgressive ? url.toString() : null,
        hls: isProgressive ? null : `https://v.redd.it/${videoId}/HLSPlaylist.m3u8`,
        dash: null,
        videoId,
        progressive: new Set(),
      },
      { title: `Reddit video ${videoId}`, permalink: url.toString() },
      ctx
    );
  }

  const id = postId(url);
  if (!id) {
    const err = new Error(
      'That Reddit link has no post id. Use a link like https://www.reddit.com/r/sub/comments/abc123/title/.'
    );
    err.status = 400;
    throw err;
  }

  // Strategy 1 is best when it works: it has full metadata.
  const fromJson = await viaPostJson(id, ctx).catch((err) => {
    if (err?.status === 422) throw err;
    return null;
  });
  if (fromJson) return fromJson;

  // Otherwise: oEmbed for metadata, the embed page for the media.
  return viaOembedAndEmbed(url, id, ctx);
}
