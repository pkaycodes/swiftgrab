/**
 * Instagram extractor.
 *
 * Public posts expose their media through Instagram's own web GraphQL
 * document, which is reachable with the public `x-ig-app-id` header. The
 * rendered page is the reliable backup: it embeds the main post as a Polaris
 * media object, separate from all the recommended posts around it.
 *
 * Both shapes can hold videos, photos and mixed carousels. The old extractor
 * only looked for videos (and could pick a recommended video on a photo post),
 * so the media is now read from the post object and shaped into variants.
 */

import { UA, getText, fetchSafe } from '../http.js';
import {
  Result,
  decodeEntities,
  finalizeVariants,
  scrapeTitle,
} from '../util.js';

export const meta = {
  id: 'instagram',
  label: 'Instagram',
  color: '#e1306c',
  hosts: [
    'instagram.com',
    'www.instagram.com',
    'm.instagram.com',
    'instagr.am',
    'www.instagr.am',
    'ddinstagram.com',
    'www.ddinstagram.com',
  ],
};

/** The public web app id Instagram ships in every browser session. */
const IG_APP_ID = '936619743392459';
/** PolarisPostRootQuery - the document the post page itself uses. */
const POST_DOC_ID = '8845758582119845';

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'tif', 'tiff']);
const MEDIA_HEADERS = {
  referer: 'https://www.instagram.com/',
  'user-agent': UA.desktop,
};

export function match(url) {
  return /(^|\.)(instagram\.com|instagr\.am|ddinstagram\.com)$/i.test(url.hostname);
}

export function shortcode(url) {
  return (
    /\/(?:p|reel|reels|tv|share)\/([A-Za-z0-9_-]{5,32})/.exec(url.pathname)?.[1] ??
    url.searchParams.get('shortcode') ??
    null
  );
}

function canonicalUrl(code) {
  return `https://www.instagram.com/p/${code}/`;
}

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function cleanUrl(value) {
  if (typeof value !== 'string') return null;
  const url = value
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .trim();
  return url || null;
}

function imageExtension(value) {
  try {
    const ext = /\.([a-z0-9]{2,5})$/i.exec(new URL(value).pathname)?.[1]?.toLowerCase();
    if (ext === 'jpeg') return 'jpg';
    return ext && IMAGE_EXT.has(ext) ? ext : 'jpg';
  } catch {
    return 'jpg';
  }
}

function metaContent(html, key) {
  const wanted = key.toLowerCase();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const property = /(?:property|name)=["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    if (property !== wanted) continue;
    const content = /content=["']([^"']*)["']/i.exec(tag)?.[1];
    if (content !== undefined) return decodeEntities(content);
  }
  return null;
}

function imageCandidates(media) {
  const out = [];

  for (const candidate of media?.image_versions2?.candidates ?? []) {
    out.push({
      url: cleanUrl(candidate?.url),
      width: positive(candidate?.width),
      height: positive(candidate?.height),
    });
  }

  for (const candidate of media?.display_resources ?? []) {
    out.push({
      url: cleanUrl(candidate?.src ?? candidate?.url),
      width: positive(candidate?.config_width ?? candidate?.width),
      height: positive(candidate?.config_height ?? candidate?.height),
    });
  }

  const display = cleanUrl(media?.display_uri ?? media?.display_url);
  if (display) {
    out.push({
      url: display,
      width: positive(media?.original_width ?? media?.dimensions?.width),
      height: positive(media?.original_height ?? media?.dimensions?.height),
    });
  }

  return out.filter((candidate) => candidate.url);
}

/** Largest version of a photo, not Instagram's 640px display crop. */
function bestImage(media) {
  const candidates = imageCandidates(media);
  if (!candidates.length) return null;
  return candidates.reduce((best, candidate) => {
    const area = (candidate.width ?? 0) * (candidate.height ?? 0);
    const bestArea = (best.width ?? 0) * (best.height ?? 0);
    return area > bestArea ? candidate : best;
  }, candidates[0]);
}

function isVideo(media) {
  if (media?.is_video === true) return true;
  if (/video/i.test(String(media?.__typename ?? ''))) return true;
  if (Array.isArray(media?.video_versions) && media.video_versions.length) return true;
  if (Array.isArray(media?.video_resources) && media.video_resources.length) return true;
  return typeof media?.video_url === 'string' && Boolean(media.video_url);
}

function imageVariant(media, index, total) {
  const image = bestImage(media);
  if (!image) return null;
  return {
    id: `img${index}`,
    label: total > 1 ? `Image ${index + 1} of ${total}` : 'Image',
    ext: imageExtension(image.url),
    kind: 'image',
    quality: image.height ?? null,
    width: image.width,
    height: image.height,
    url: image.url,
    headers: MEDIA_HEADERS,
  };
}

function videoVariants(media, index, total) {
  const suffix = total > 1 ? ` (item ${index + 1})` : '';
  const versions = Array.isArray(media?.video_versions)
    ? media.video_versions
    : Array.isArray(media?.video_resources)
      ? media.video_resources
      : [];
  const duration = positive(media?.video_duration ?? media?.duration);
  const out = [];

  for (const version of versions) {
    const url = cleanUrl(version?.url ?? version?.src);
    if (!url) continue;
    const height = positive(version?.height ?? version?.config_height);
    const width = positive(version?.width ?? version?.config_width);
    out.push({
      id: `vid${index}_${out.length}`,
      label: `${height ? `${height}p` : `Video ${out.length + 1}`}${suffix}`,
      ext: 'mp4',
      kind: 'video',
      quality: height,
      width,
      height,
      url,
      headers: MEDIA_HEADERS,
      duration,
    });
  }

  if (!out.length) {
    const url = cleanUrl(media?.video_url);
    if (url) {
      out.push({
        id: `vid${index}`,
        label: `Video${suffix}`,
        ext: 'mp4',
        kind: 'video',
        quality: null,
        url,
        headers: MEDIA_HEADERS,
        duration,
      });
    }
  }

  return out;
}

function variantsFromMedia(media, index, total) {
  if (!media) return [];
  return isVideo(media)
    ? videoVariants(media, index, total)
    : [imageVariant(media, index, total)].filter(Boolean);
}

function mediaItems(post) {
  const carousel = post?.carousel_media;
  if (Array.isArray(carousel) && carousel.length) return carousel;
  const edges = post?.edge_sidecar_to_children?.edges;
  if (Array.isArray(edges) && edges.length) {
    return edges.map((edge) => edge?.node).filter(Boolean);
  }
  return post ? [post] : [];
}

function captionText(post) {
  const caption =
    post?.caption?.text ??
    post?.edge_media_to_caption?.edges?.[0]?.node?.text ??
    '';
  return typeof caption === 'string' ? caption.trim() : '';
}

function ownerOf(post, items) {
  return (
    post?.user ??
    items.find((item) => item?.user)?.user ??
    post?.owner ??
    items.find((item) => item?.owner)?.owner ??
    {}
  );
}

function resultFromPost(post, pageUrl, note) {
  const items = mediaItems(post);
  const variants = items.flatMap((item, index) => variantsFromMedia(item, index, items.length));
  if (!variants.length) return null;

  const owner = ownerOf(post, items);
  const caption = captionText(post);
  const videoCount = items.filter((item) => isVideo(item)).length;
  const imageCount = items.length - videoCount;
  const firstImage = bestImage(items[0]);
  const timer = items.length === 1 && isVideo(items[0])
    ? positive(items[0]?.video_duration ?? items[0]?.duration)
    : null;

  let noteText = note;
  if (items.length > 1) {
    const parts = [];
    if (videoCount) parts.push(`${videoCount} video${videoCount === 1 ? '' : 's'}`);
    if (imageCount) parts.push(`${imageCount} image${imageCount === 1 ? '' : 's'}`);
    noteText = `Carousel: ${items.length} items${parts.length ? ` (${parts.join(', ')})` : ''}.`;
  }

  return Result.create({
    source: meta.id,
    sourceLabel: 'Instagram',
    pageUrl,
    title:
      caption.split('\n')[0]?.slice(0, 140) ||
      `Instagram post by @${owner.username ?? 'unknown'}`,
    author: owner.full_name ?? owner.username ?? null,
    authorUrl: owner.username ? `https://www.instagram.com/${owner.username}/` : null,
    thumbnail:
      cleanUrl(post?.display_uri ?? post?.display_url) ??
      firstImage?.url ??
      null,
    duration: timer,
    description: caption || null,
    variants: finalizeVariants(variants),
    note: noteText,
  });
}

/** Find the JSON object after `"marker":` without regexing into nested JSON. */
function jsonAfter(text, from) {
  const start = text.indexOf('{', from);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function pagePost(html) {
  for (const marker of ['"xig_polaris_media":', '"shortcode_media":', '"xdt_shortcode_media":']) {
    let from = 0;
    while (true) {
      const at = html.indexOf(marker, from);
      if (at === -1) break;
      from = at + marker.length;
      const raw = jsonAfter(html, from);
      if (!raw) continue;
      let object;
      try {
        object = JSON.parse(raw);
      } catch {
        continue;
      }
      const post = object?.if_not_gated_logged_out ?? object?.shortcode_media ?? object;
      if (
        post &&
        typeof post === 'object' &&
        (post.carousel_media ||
          post.edge_sidecar_to_children ||
          post.image_versions2 ||
          post.display_url ||
          post.display_uri)
      ) {
        return post;
      }
    }
  }
  return null;
}

function firstEmbeddedVideo(html) {
  const single = /"video_url"\s*:\s*"(https?:\\?\/\\?\/[^"]+?)"/.exec(html)?.[1];
  if (single) return cleanUrl(single);
  const version = /"video_versions"\s*:\s*\[[\s\S]{0,4000}?"url"\s*:\s*"(https?:\\?\/\\?\/[^"]+?)"/.exec(html)?.[1];
  return version ? cleanUrl(version) : null;
}

function resultFromMeta(html, pageUrl) {
  const image = metaContent(html, 'og:image') ?? metaContent(html, 'twitter:image');
  const type = metaContent(html, 'og:type') ?? '';
  const video =
    metaContent(html, 'og:video') ??
    metaContent(html, 'og:video:secure_url') ??
    (/video/i.test(type) ? firstEmbeddedVideo(html) : null);
  const title = scrapeTitle(html) ?? `Instagram post`;
  const description = metaContent(html, 'og:description');
  const poster = image;

  if (video) {
    return Result.create({
      source: meta.id,
      sourceLabel: 'Instagram',
      pageUrl,
      title: title || 'Instagram video',
      thumbnail: poster,
      description: description || null,
      variants: finalizeVariants([
        {
          id: 'meta-video',
          label: 'Video',
          ext: 'mp4',
          kind: 'video',
          url: video,
          headers: MEDIA_HEADERS,
        },
      ]),
      note: 'Resolved from page metadata.',
    });
  }

  if (!image) return null;

  const width = positive(metaContent(html, 'og:image:width'));
  const height = positive(metaContent(html, 'og:image:height'));
  return Result.create({
    source: meta.id,
    sourceLabel: 'Instagram',
    pageUrl,
    title: title || 'Instagram photo',
    thumbnail: image,
    description: description || null,
    variants: finalizeVariants([
      {
        id: 'meta-image',
        label: 'Image',
        ext: imageExtension(image),
        kind: 'image',
        quality: height ?? null,
        width,
        height,
        url: image,
        headers: MEDIA_HEADERS,
      },
    ]),
    note: 'Resolved from page metadata.',
  });
}

/**
 * Parse a rendered Instagram page. Exported so a captured page can be tested
 * without touching the network.
 */
export function parsePage(html, pageUrl) {
  const post = pagePost(html);
  if (post) {
    const result = resultFromPost(post, pageUrl, 'Public post resolved from the page.');
    if (result) return result;
  }
  return resultFromMeta(html, pageUrl);
}

/** Ask Instagram's own GraphQL endpoint for the post. */
async function viaGraphql(code, allowPrivate) {
  const res = await fetchSafe('https://www.instagram.com/graphql/query', {
    method: 'POST',
    allowPrivate,
    label: 'Instagram GraphQL',
    timeout: 20_000,
    headers: {
      'user-agent': UA.desktop,
      'content-type': 'application/x-www-form-urlencoded',
      'x-ig-app-id': IG_APP_ID,
      'x-fb-lsd': 'AVqbxe3J_ZY',
      'x-asbd-id': '129477',
      accept: '*/*',
      origin: 'https://www.instagram.com',
      referer: canonicalUrl(code),
      'sec-fetch-site': 'same-origin',
    },
    body: new URLSearchParams({
      doc_id: POST_DOC_ID,
      variables: JSON.stringify({ shortcode: code }),
    }).toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Instagram GraphQL responded ${res.status}.`);
    err.status = res.status === 404 ? 404 : 502;
    throw err;
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    const err = new Error('Instagram returned non-JSON for the GraphQL query.');
    err.status = 502;
    throw err;
  }

  const media =
    payload?.data?.xdt_shortcode_media ??
    payload?.data?.shortcode_media ??
    payload?.data?.xdt_api__v1__media__shortcode__web_info?.items?.[0] ??
    null;
  if (!media) {
    const err = new Error('Instagram GraphQL returned no media for that post.');
    err.status = 404;
    throw err;
  }

  const result = resultFromPost(media, canonicalUrl(code), 'Public post resolved through Instagram GraphQL.');
  if (!result) {
    const err = new Error('That Instagram post has no downloadable video or image.');
    err.status = 422;
    throw err;
  }
  return result;
}

/** Scrape the rendered page as Googlebot, which skips the login wall. */
async function viaPage(code, allowPrivate) {
  const html = await getText(canonicalUrl(code), {
    allowPrivate,
    label: 'Instagram page',
    timeout: 25_000,
    maxBytes: 10 * 1024 * 1024,
    headers: {
      'user-agent': UA.googlebot,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
  });

  return parsePage(html, canonicalUrl(code));
}

export async function resolve(url, ctx = {}) {
  const code = shortcode(url);
  if (!code) {
    const err = new Error('That Instagram link has no post code. Use a link like https://www.instagram.com/reel/ABC123/.');
    err.status = 400;
    throw err;
  }

  const errors = [];
  try {
    return await viaGraphql(code, ctx.allowPrivate);
  } catch (err) {
    errors.push(`GraphQL: ${err.message}`);
  }
  try {
    const fromPage = await viaPage(code, ctx.allowPrivate);
    if (fromPage) return fromPage;
    errors.push('page scrape found no media');
  } catch (err) {
    errors.push(`page: ${err.message}`);
  }

  const error = new Error(
    `Instagram would not hand over that post (${errors.join('; ')}). Instagram gates most posts behind a login - ` +
      'installing yt-dlp with your Instagram session cookie is the reliable fix.'
  );
  error.status = 401;
  error.hint = 'yt-dlp';
  throw error;
}
