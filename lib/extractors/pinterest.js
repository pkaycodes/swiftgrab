/**
 * Pinterest pins.
 *
 * A pin can be a video or a picture (and story pins can hold several pages).
 * Pinterest ships two copies of the pin in the HTML, depending on the route:
 *
 *   __PWS_INITIAL_PROPS__          Redux state - usually populated for videos
 *   relay "completed request" JSON  GraphQL response - populated for images
 *
 * Both are parsed, merged, and the media is read from the JSON. The old
 * implementation only regexed for `video_url`, which is why every image pin
 * came back as "that pin has no video".
 */

import { UA, fetchSafe, getJson, getText } from '../http.js';
import {
  Result,
  decodeEntities,
  extractScriptJson,
  finalizeVariants,
  scrapeImageCandidate,
  scrapeTitle,
} from '../util.js';

export const meta = {
  id: 'pinterest',
  label: 'Pinterest',
  color: '#e60023',
  hosts: ['pinterest.com', 'www.pinterest.com', 'pin.it', 'pinterest.co.uk'],
};

export function match(url) {
  return /(^|\.)(pinterest\.[a-z.]+|pin\.it)$/i.test(url.hostname);
}

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'tif', 'tiff']);

const positive = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function cleanUrl(value) {
  if (typeof value !== 'string') return null;
  const url = value.replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&').trim();
  return url || null;
}

function imageObject(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const url = cleanUrl(value);
    return url ? { url, width: null, height: null } : null;
  }
  if (typeof value !== 'object') return null;
  const url = cleanUrl(value.url ?? value.contentUrl ?? null);
  if (!url) return null;
  return { url, width: positive(value.width), height: positive(value.height) };
}

function imageExtension(url) {
  try {
    const ext = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
    if (ext === 'jpeg') return 'jpg';
    return ext && IMAGE_EXT.has(ext) ? ext : 'jpg';
  } catch {
    return 'jpg';
  }
}

/** Best picture on a pin, a story block, or a carousel slot. */
function bestImage(entity) {
  if (!entity || typeof entity !== 'object') return null;

  for (const key of ['images_orig', 'imagesOrig']) {
    const image = imageObject(entity[key]);
    if (image) return image;
  }

  const images = entity.images;
  if (images && typeof images === 'object' && !Array.isArray(images)) {
    for (const key of ['orig', '1200x', '750x', '736x', '600x315', '564x', '474x', '236x']) {
      const image = imageObject(images[key]);
      if (image) return image;
    }
  }

  for (const key of [
    'images_1200x',
    'images_750x',
    'images_736x',
    'images_600x315',
    'images_564x',
    'images_474x',
    'images_236x',
  ]) {
    const image = imageObject(entity[key]);
    if (image) return image;
  }

  return imageObject(entity.image);
}

function uniqueImages(images) {
  const seen = new Set();
  const out = [];
  for (const image of images) {
    if (!image?.url || seen.has(image.url)) continue;
    seen.add(image.url);
    out.push(image);
  }
  return out;
}

export function pinIdFromUrl(pageUrl) {
  try {
    const { pathname } = new URL(pageUrl);
    const match = /--(\d{6,})\/?$/.exec(pathname) ?? /\/pin\/(\d{6,})\/?$/.exec(pathname) ?? /\/(\d{6,})\/?$/.exec(pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function balancedJson(text, start) {
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
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Pinterest embeds GraphQL responses as:
 *   __PWS_RELAY_REGISTER_COMPLETED_REQUEST__("<url-encoded query>", { ...json... });
 * The response is raw JSON, so walk its braces instead of regexing the pin out.
 */
function relayPins(html) {
  const pins = [];
  const marker = '__PWS_RELAY_REGISTER_COMPLETED_REQUEST__("';
  let cursor = 0;
  while ((cursor = html.indexOf(marker, cursor)) !== -1) {
    const queryEnd = html.indexOf('",', cursor + marker.length);
    if (queryEnd === -1) break;
    const objectStart = html.indexOf('{', queryEnd + 2);
    if (objectStart === -1) break;
    const json = balancedJson(html, objectStart);
    if (json) {
      try {
        const payload = JSON.parse(json);
        const pin = payload?.data?.v3GetPinQueryv2?.data;
        if (pin && typeof pin === 'object') pins.push(pin);
      } catch {
        /* an unrelated or partial relay payload */
      }
    }
    cursor = objectStart + 1;
  }
  return pins;
}

function initialPins(html) {
  const props = extractScriptJson(html, '__PWS_INITIAL_PROPS__');
  const pins = props?.initialReduxState?.pins;
  if (!pins || typeof pins !== 'object') return [];
  return Object.values(pins).filter((pin) => pin && typeof pin === 'object');
}

function hasAuthor(pinner) {
  return Boolean(
    pinner &&
      (pinner.username || pinner.fullName || pinner.full_name || pinner.firstName || pinner.first_name)
  );
}

/**
 * Relay responses repeat the pin, and each copy carries a different subset:
 * one has the dimensions, another the author's username. Merge the useful
 * non-empty fields instead of letting the last copy win.
 */
function mergePins(pins) {
  const merged = {};
  for (const pin of pins) {
    for (const [key, value] of Object.entries(pin)) {
      if (value == null || value === '') continue;
      if (typeof value === 'string' && !value.trim()) continue;

      if (key === 'pinner') {
        if (!merged.pinner || (!hasAuthor(merged.pinner) && hasAuthor(value))) merged.pinner = value;
        continue;
      }
      if (key === 'images_orig' || key === 'imagesOrig') {
        if (!merged[key] || (!merged[key].width && value?.width)) merged[key] = value;
        continue;
      }
      if (!(key in merged)) merged[key] = value;
    }
  }
  return merged;
}

function cleanTitle(value) {
  if (!value) return null;
  return decodeEntities(value).split(' | ')[0].trim() || null;
}

function pinTitle(pin, html) {
  const direct = firstString(
    pin.title,
    pin.gridTitle,
    pin.grid_title,
    pin.closeupUnifiedTitle,
    pin.closeup_unified_title,
    pin.unauthOnPageTitle,
    pin.unauth_on_page_title
  );
  if (direct) return cleanTitle(direct);

  const seo = firstString(pin.seoTitle, pin.seo_title);
  if (seo) return cleanTitle(seo);

  return cleanTitle(scrapeTitle(html));
}

function authorFrom(pin) {
  const pinner = pin.pinner ?? pin.originPinner ?? pin.origin_pinner ?? {};
  const raw = firstString(
    pinner.fullName,
    pinner.full_name,
    pinner.firstName,
    pinner.first_name,
    pinner.username
  );
  const name = raw ? decodeEntities(raw).split(' | ')[0].trim() : null;
  return {
    name: name || null,
    url:
      typeof pinner.username === 'string' && pinner.username.trim()
        ? `https://www.pinterest.com/${pinner.username.trim()}/`
        : null,
  };
}

function descriptionFrom(pin) {
  const raw = firstString(
    pin.closeupUnifiedDescription,
    pin.closeup_unified_description,
    pin.description
  );
  if (!raw) return null;
  // Pinterest's generated SEO description starts with a date; it is noise.
  if (/^[A-Z][a-z]{2} \d{1,2}, \d{4} — /.test(raw)) return null;
  return raw.slice(0, 500);
}

function durationSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n >= 1000 ? Math.round(n / 100) / 10 : n;
}

function videoVariants(pins, html) {
  const variants = [];
  const seen = new Set();
  let duration = null;
  let thumbnail = null;

  const add = (rawUrl, { quality = null, width = null, height = null, thumb = null, durationMs = null, key = null } = {}) => {
    const url = cleanUrl(rawUrl);
    if (!url || seen.has(url)) return;
    try {
      if (!/\.(?:mp4|m4v|mov|webm)(?:$|[?#])/i.test(new URL(url).pathname)) return;
    } catch {
      return;
    }
    seen.add(url);
    const q =
      quality ??
      positive(/V_(\d+)P/i.exec(key ?? '')?.[1]) ??
      positive(/(?:\/|_)(\d{3,4})p(?:\/|\.|_)/i.exec(url)?.[1]);
    variants.push({
      id: `pinterest_video_${variants.length}`,
      label: q ? `${q}p` : 'Video',
      ext: 'mp4',
      url,
      kind: 'video',
      quality: q,
      width: positive(width),
      height: positive(height) ?? q,
      headers: { referer: 'https://www.pinterest.com/' },
    });
    if (duration == null) duration = durationSeconds(durationMs);
    if (!thumbnail && thumb) thumbnail = cleanUrl(thumb);
  };

  for (const pin of pins) {
    const videos = pin?.videos;
    const list = videos?.video_list ?? videos?.videoList ?? pin?.video_list ?? null;
    if (!list || typeof list !== 'object') continue;
    const entries = Array.isArray(list)
      ? list.map((entry, index) => [`entry${index}`, entry])
      : Object.entries(list);
    for (const [key, entry] of entries) {
      if (!entry || typeof entry !== 'object' || !entry.url) continue;
      add(entry.url, {
        key,
        quality: positive(/V_(\d+)P/i.exec(key)?.[1]),
        width: entry.width,
        height: entry.height,
        thumb: entry.thumbnail,
        durationMs: entry.duration,
      });
    }
  }

  // Older pages only expose the MP4 URLs in inline JSON.
  if (!variants.length) {
    const re = /https?:\\?\/\\?\/v1\.pinimg\.com\\?\/videos[^"'\s<]*?\.mp4[^"'\s<]*/gi;
    let match;
    while ((match = re.exec(html))) add(match[0].replace(/\\\//g, '/'));
  }

  return { variants, duration, thumbnail };
}

function carouselImages(pins) {
  const images = [];
  for (const pin of pins) {
    const carousel = pin.carouselData ?? pin.carousel_data;
    if (!carousel || typeof carousel !== 'object') continue;

    const lists = [];
    for (const key of ['carouselSlots', 'carousel_slots', 'slots', 'items']) {
      const value = carousel[key];
      if (Array.isArray(value)) lists.push(value);
      else if (value && typeof value === 'object') lists.push(Object.values(value));
    }
    for (const list of lists) {
      for (const slot of list) {
        const image = bestImage(slot) ?? imageObject(slot?.image) ?? bestImage(slot?.data);
        if (image) images.push(image);
      }
    }
  }
  return uniqueImages(images);
}

/** Story pins can have multiple pages; single-page ones just use the cover. */
function storyImages(pins) {
  const images = [];
  for (const pin of pins) {
    const story = pin.storyPinData ?? pin.story_pin_data;
    const pages = Array.isArray(story?.pages) ? story.pages : [];
    if (pages.length < 2) continue;
    for (const page of pages) {
      for (const block of Array.isArray(page?.blocks) ? page.blocks : []) {
        const image = bestImage(block) ?? imageObject(block?.image);
        if (image) images.push(image);
      }
    }
  }
  return uniqueImages(images);
}

function imageVariants(images) {
  return images.map((image, index) => ({
    id: `pinterest_image_${index}`,
    label: images.length > 1 ? `Image ${index + 1} of ${images.length}` : 'Image',
    ext: imageExtension(image.url),
    url: image.url,
    kind: 'image',
    quality: image.height ?? null,
    width: image.width ?? null,
    height: image.height ?? null,
    headers: { referer: 'https://www.pinterest.com/' },
  }));
}

/** Parse a Pinterest pin page into a Result. Exported for offline tests. */
export function parsePin(html, pageUrl) {
  const pins = [...initialPins(html), ...relayPins(html)];
  const pin = mergePins(pins);

  const video = videoVariants(pins, html);
  const variants = [...video.variants];

  let images = carouselImages(pins);
  if (!images.length) images = storyImages(pins);
  if (!images.length && !video.variants.length) {
    const image = bestImage(pin);
    const fallback = image ? null : scrapeImageCandidate(html, pageUrl);
    images = image ? [image] : fallback ? [fallback] : [];
  }
  variants.push(...imageVariants(images));

  const author = authorFrom(pin);
  const thumbnail = images[0]?.url ?? video.thumbnail ?? bestImage(pin)?.url ?? null;

  return Result.create({
    source: 'pinterest',
    sourceLabel: 'Pinterest',
    pageUrl,
    title: pinTitle(pin, html) ?? 'Pinterest pin',
    author: author.name,
    authorUrl: author.url,
    thumbnail,
    duration: video.duration,
    description: descriptionFrom(pin),
    variants: finalizeVariants(variants),
  });
}

async function viaOembed(target, ctx) {
  const endpoint = `https://www.pinterest.com/oembed.json?url=${encodeURIComponent(target.toString())}`;
  const data = await getJson(endpoint, {
    allowPrivate: ctx.allowPrivate,
    label: 'Pinterest oEmbed',
    headers: { 'user-agent': UA.desktop },
  });

  const preview = cleanUrl(data?.thumbnail_url);
  if (!preview) return null;
  // oEmbed only hands back a 236px thumbnail; the 736px rendition is usually
  // the same image at a useful size, and the pin page has the original anyway.
  const image = { url: preview.replace(/\/(?:236x|474x|564x|600x315|736x)\//, '/736x/'), width: null, height: null };
  if (!image.url) return null;

  const title = firstString(data?.title);
  const author = firstString(data?.author_name);
  return Result.create({
    source: 'pinterest',
    sourceLabel: 'Pinterest',
    pageUrl: target.toString(),
    title: title ? decodeEntities(title).trim() : 'Pinterest pin',
    author: author ? decodeEntities(author).trim() : null,
    authorUrl: firstString(data?.author_url),
    thumbnail: image.url,
    variants: finalizeVariants(imageVariants([image])),
    note: 'Pinterest only returned a preview image for this pin.',
  });
}

export async function resolve(url, ctx = {}) {
  let target = url;
  if (/(^|\.)pin\.it$/i.test(url.hostname)) {
    const res = await fetchSafe(url.toString(), {
      allowPrivate: ctx.allowPrivate,
      headers: { 'user-agent': UA.desktop },
    });
    res.body?.cancel().catch(() => {});
    target = new URL(res.headers.get('location') ?? res.url);
  }

  let html = null;
  let pageError = null;
  try {
    html = await getText(target.toString(), {
      allowPrivate: ctx.allowPrivate,
      label: 'Pinterest pin',
      maxBytes: 8 * 1024 * 1024,
      headers: { 'user-agent': UA.googlebot },
    });
  } catch (err) {
    pageError = err;
  }

  let result = html ? parsePin(html, target.toString()) : null;
  if (!result?.variants.length) {
    try {
      const fallback = await viaOembed(target, ctx);
      if (fallback?.variants.length) result = fallback;
    } catch {
      /* oEmbed is a bonus, not the primary path */
    }
  }

  if (!result?.variants.length) {
    if (pageError) throw pageError;
    const err = new Error(
      'That pin has no downloadable video or image. It may be private, removed, or only show a preview.'
    );
    err.status = 422;
    throw err;
  }
  return result;
}
