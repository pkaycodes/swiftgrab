/**
 * TikTok extractor.
 *
 * Three independent strategies, tried in order, because TikTok shuffles
 * which one answers on any given day:
 *   1. __UNIVERSAL_DATA_FOR_REHYDRATION__  - the current web payload
 *   2. SIGI_STATE                          - the older web payload, still served
 *   3. The mobile app feed API             - no signature needed for a single
 *                                            public aweme_id
 * Short links (vm.tiktok.com / vt.tiktok.com) are followed to the canonical
 * URL first.
 */

import { UA, fetchSafe, getJson, getText } from '../http.js';
import { Result, extractScriptJson, estimateSize, finalizeVariants, formatDuration } from '../util.js';

export const meta = {
  id: 'tiktok',
  label: 'TikTok',
  color: '#ff2d55',
  hosts: [
    'tiktok.com',
    'www.tiktok.com',
    'm.tiktok.com',
    'vm.tiktok.com',
    'vt.tiktok.com',
    'www.tiktokv.com',
    'tiktokv.com',
  ],
};

export function match(url) {
  return url.hostname.toLowerCase().endsWith('tiktok.com') || url.hostname.toLowerCase().endsWith('tiktokv.com');
}

/** CDN playback of TikTok media requires these three headers. */
const MEDIA_HEADERS = {
  referer: 'https://www.tiktok.com/',
  'user-agent': UA.desktop,
  accept: '*/*',
  acceptLanguage: '*',
  origin: 'https://www.tiktok.com',
};

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'tif', 'tiff']);

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
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

/** The app, mobile web and embed payloads name the image list differently. */
function imageEntries(post) {
  const images = post?.images ?? post?.displayImages ?? post?.display_images ?? post?.image_list;
  return Array.isArray(images) ? images : [];
}

function imageUrl(entry) {
  const lists = [
    entry?.imageURL?.urlList,
    entry?.imageUrl?.urlList,
    entry?.displayImage?.urlList,
    entry?.display_image?.url_list,
    entry?.image_url?.url_list,
    entry?.urlList,
    entry?.url_list,
  ];
  for (const list of lists) {
    const value = Array.isArray(list)
      ? list.find((url) => typeof url === 'string' && url)
      : typeof list === 'string'
        ? list
        : null;
    if (value) return String(value).replace(/^http:\/\//, 'https://').replace(/&amp;/g, '&');
  }
  return null;
}

function imageVariantsFromPost(post) {
  const images = imageEntries(post);
  const variants = [];
  for (let index = 0; index < images.length; index += 1) {
    const entry = images[index];
    const url = imageUrl(entry);
    if (!url) continue;
    const width = positive(
      entry?.imageWidth ??
        entry?.image_width ??
        entry?.width ??
        entry?.displayImage?.width ??
        entry?.display_image?.width
    );
    const height = positive(
      entry?.imageHeight ??
        entry?.image_height ??
        entry?.height ??
        entry?.displayImage?.height ??
        entry?.display_image?.height
    );
    variants.push({
      id: `img${index}`,
      label: images.length > 1 ? `Image ${index + 1} of ${images.length}` : 'Image',
      ext: imageExtension(url),
      kind: 'image',
      quality: height,
      width,
      height,
      url,
      headers: MEDIA_HEADERS,
    });
  }
  return variants;
}

export function videoId(url) {
  return (
    /\/(?:video|photo)\/(\d{6,25})/.exec(url.pathname)?.[1] ??
    url.searchParams.get('item_id') ??
    url.searchParams.get('aweme_id') ??
    null
  );
}

/** Follow vm./vt. short links to the canonical post URL. */
async function expandShortLink(url, allowPrivate) {
  const res = await fetchSafe(url.toString(), {
    method: 'GET',
    allowPrivate,
    headers: { 'user-agent': UA.iphone, accept: 'text/html,*/*' },
  });
  const location = res.headers.get('location');
  res.body?.cancel().catch(() => {});
  if (location) {
    try {
      const resolved = new URL(location, url);
      const id = videoId(resolved);
      if (id) return { url: resolved, html: null };
    } catch {
      /* fall through to the redirect-following fetch below */
    }
  }
  const html = await getText(url.toString(), {
    allowPrivate,
    label: 'TikTok short link',
    headers: { 'user-agent': UA.iphone, accept: 'text/html,application/xhtml+xml' },
  });
  const canonical = /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i.exec(html)?.[1];
  return { url: canonical ? new URL(canonical) : url, html };
}

/** Shape a TikTok `itemStruct` into our Variant list. */
export function variantsFromItem(item) {
  const imagePost = item?.imagePost ?? item?.imagePostInfo ?? item?.image_post_info;
  if (imagePost) {
    const variants = imageVariantsFromPost(imagePost);
    if (!variants.length) {
      const err = new Error('TikTok returned a photo post without any image URLs.');
      err.status = 404;
      throw err;
    }
    return { variants, durationSeconds: null };
  }

  const durationSeconds =
    Number.isFinite(item?.video?.duration)
      ? item.video.duration > 1000
        ? item.video.duration / 1000
        : item.video.duration
      : null;

  const variants = [];
  const seen = new Set();
  const add = (v) => {
    if (!v?.url) return;
    const url = String(v.url).replace(/^http:\/\//, 'https://');
    if (seen.has(url)) return;
    seen.add(url);
    variants.push({ ...v, url });
  };

  // The web-app CDN URLs: one entry per rendition, best labelled first.
  for (const entry of item?.video?.bitrateInfo ?? []) {
    const url =
      entry?.PlayAddr?.UrlList?.[0] ??
      entry?.playAddr?.UrlList?.[0] ??
      (typeof entry?.PlayAddr === 'string' ? entry.PlayAddr : null);
    if (!url) continue;
    const typeHint = String(entry?.QualityType ?? '');
    const gear = String(
      entry?.GearName ??
        entry?.gear_name ??
        (/^(?:normal|adapt|lower|higher)_/.test(typeHint) ? typeHint : '')
    );
    const gearHeight = Number(/(?:^|_)(\d{3,4})(?:_|$)/.exec(gear)?.[1]) || null;
    const actualHeight = positive(entry?.PlayAddr?.Height ?? entry?.playAddr?.Height);
    const actualWidth = positive(entry?.PlayAddr?.Width ?? entry?.playAddr?.Width);
    const hintedHeight = Number(typeHint) >= 144 ? Number(typeHint) : null;
    const quality = gearHeight ?? hintedHeight ?? actualHeight;
    add({
      id: `br${variants.length}`,
      label: quality ? `${quality}p` : 'MP4',
      ext: 'mp4',
      url,
      kind: 'video',
      quality,
      height: actualHeight,
      width: actualWidth,
      bitrate: Number.isFinite(entry?.Bitrate) && entry.Bitrate > 1000 ? entry.Bitrate : null,
      size: entry?.PlayAddr?.DataSize ?? entry?.playAddr?.DataSize ?? null,
      approx: !(entry?.PlayAddr?.DataSize ?? entry?.playAddr?.DataSize),
      headers: MEDIA_HEADERS,
    });
  }

  // downloadAddr is the watermarked-but-always-present fallback; playAddr is
  // the clean stream.
  const fallbacks = [
    ['play', item?.video?.playAddr, item?.video?.bitrateInfo?.length ? null : 'Video'],
    ['download', item?.video?.downloadAddr, 'Video (with watermark)'],
    ['play', item?.video?.playApi, 'Video'],
    ['playAddr', item?.video?.playAddr, 'Video'],
  ];
  for (const [key, value, label] of fallbacks) {
    const url = typeof value === 'string' ? value : value?.UrlList?.[0];
    if (!url) continue;
    add({
      id: key,
      label: label ?? 'Video',
      ext: 'mp4',
      url,
      kind: 'video',
      quality: null,
      size: typeof value === 'object' ? value?.DataSize ?? null : null,
      approx: !(typeof value === 'object' && value?.DataSize),
      headers: MEDIA_HEADERS,
      duration: durationSeconds,
    });
  }

  // Music-only option, when the post exposes a separate audio stream.
  const musicUrl = item?.music?.playUrl ? String(item.music.playUrl).replace(/^http:\/\//, 'https://') : null;
  if (musicUrl) {
    add({
      id: 'audio',
      label: `${item?.music?.title ? `${item.music.title} - ` : ''}Original sound`,
      ext: 'mp3',
      url: musicUrl,
      kind: 'audio',
      bitrate: item?.music?.bitrate ?? null,
      size: item?.music?.dataSize ?? null,
      approx: true,
      headers: MEDIA_HEADERS,
    });
  }

  return { variants, durationSeconds };
}

function resultFromItem(item, pageUrl, note) {
  const { variants, durationSeconds } = variantsFromItem(item);
  if (!variants.some((v) => v.kind !== 'audio')) {
    const err = new Error('TikTok did not return a playable video or image for that post.');
    err.status = 404;
    throw err;
  }
  const author = item?.author?.uniqueId ?? item?.author?.unique_id ?? null;
  const description = item?.desc?.trim() || item?.imagePost?.title?.trim() || null;
  const images = variants.filter((v) => v.kind === 'image');
  const imageNote = images.length
    ? `Photo post: ${images.length} image${images.length === 1 ? '' : 's'}.`
    : note;
  return Result.create({
    source: meta.id,
    sourceLabel: 'TikTok',
    pageUrl,
    title:
      description ||
      (author ? `TikTok ${images.length ? 'photo' : 'video'} by @${author}` : 'TikTok post'),
    author: item?.author?.nickname ?? author,
    authorUrl: author ? `https://www.tiktok.com/@${author}` : null,
    thumbnail:
      item?.video?.cover ??
      item?.video?.originCover ??
      item?.video?.dynamicCover ??
      images[0]?.url ??
      null,
    duration: durationSeconds,
    description,
    variants: finalizeVariants(variants),
    note: imageNote,
  });
}

/**
 * Pull TikTok's post payload out of a rendered page.
 *
 * Exported separately from `resolve` so it can be tested against a captured
 * page without touching the network.
 *
 * @param {string} html
 * @param {string|null} id
 * @returns {{ item: any, via: string } | null}
 */
export function extractItemFromHtml(html, id = null) {
  const hydration = extractScriptJson(html, '__UNIVERSAL_DATA_FOR_REHYDRATION__');
  const detail =
    hydration?.__DEFAULT_SCOPE__?.['webapp.video-detail'] ??
    hydration?.__DEFAULT_SCOPE__?.['webapp.video-detail-v2'] ??
    hydration?.__DEFAULT_SCOPE__?.['webapp.reflow.video.detail'];
  const item = detail?.itemInfo?.itemStruct;
  if (item) return { item, via: 'hydration payload' };

  const sigi = extractScriptJson(html, 'SIGI_STATE');
  if (sigi) {
    const moduleItem = sigi?.ItemModule?.[id] ?? Object.values(sigi?.ItemModule ?? {})[0];
    if (moduleItem) return { item: moduleItem, via: 'SIGI_STATE' };
  }

  return null;
}

/** Strategy 1 + 2: parse the hydration payloads out of the post page. */
async function viaPage(url, allowPrivate) {
  const html = await getText(url.toString(), {
    allowPrivate,
    label: 'TikTok page',
    timeout: 25_000,
    maxBytes: 8 * 1024 * 1024,
    headers: {
      'user-agent': UA.desktop,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'upgrade-insecure-requests': '1',
    },
  });

  const hydration = extractScriptJson(html, '__UNIVERSAL_DATA_FOR_REHYDRATION__');
  const detail =
    hydration?.__DEFAULT_SCOPE__?.['webapp.video-detail'] ??
    hydration?.__DEFAULT_SCOPE__?.['webapp.video-detail-v2'] ??
    hydration?.__DEFAULT_SCOPE__?.['webapp.reflow.video.detail'];
  if (detail?.statusCode && detail.statusCode !== 0 && !detail?.itemInfo?.itemStruct) {
    const err = new Error(
      `TikTok refused the page request (statusCode ${detail.statusCode}). The post may be private, deleted or region-locked.`
    );
    err.status = 404;
    throw err;
  }

  const found = extractItemFromHtml(html, videoId(url));
  if (found) return resultFromItem(found.item, url.toString(), null);

  // Last resort on the page itself: canonical title + any embedded mp4. A
  // /photo/ URL must never turn into a recommended video from the sidebar.
  const mp4 = /"(?:playAddr|downloadAddr|contentUrl)"\s*:\s*"(https?:\\?\/\\?\/[^"]+?\.mp4[^"]*)"|"(https:[^"]*?(?:v16|v19|v20)[^"]*?)"/i.exec(html);
  if (mp4 && !/\/photo\//.test(url.pathname)) {
    const raw = (mp4[1] ?? mp4[2]).replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
    return Result.create({
      source: meta.id,
      sourceLabel: 'TikTok',
      pageUrl: url.toString(),
      title: /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? 'TikTok video',
      variants: finalizeVariants([
        {
          id: 'html',
          label: 'Video',
          ext: 'mp4',
          url: raw,
          kind: 'video',
          headers: MEDIA_HEADERS,
        },
      ]),
      note: 'Recovered from the raw page HTML - quality is whatever TikTok embedded.',
    });
  }

  return null;
}

/**
 * Photo posts are often blocked on the desktop URL but still ship their full
 * item (including `imagePost`) on the mobile page.
 */
async function viaMobilePage(id, pageUrl, allowPrivate) {
  const html = await getText(`https://m.tiktok.com/v/${id}.html`, {
    allowPrivate,
    label: 'TikTok mobile page',
    timeout: 25_000,
    maxBytes: 8 * 1024 * 1024,
    headers: {
      'user-agent': UA.iphone,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
  });

  const found = extractItemFromHtml(html, id);
  if (found) return resultFromItem(found.item, pageUrl, "Resolved through TikTok's mobile page.");
  return null;
}

/** Strategy 3: the mobile feed API, which still answers unsigned. */
async function viaAppApi(id, pageUrl, allowPrivate) {
  const endpoint =
    'https://api16-normal-c-useast1a.tiktokv.com/aweme/v1/feed/?' +
    new URLSearchParams({
      aweme_id: id,
      version_code: '262',
      app_name: 'musical_ly',
      channel: 'App',
      device_id: '7318518857994389254',
      device_platform: 'android',
      device_type: 'Pixel 7',
      os_version: '13',
      version_name: '26.2.0',
      aid: '1233',
    }).toString();

  const payload = await getJson(endpoint, {
    allowPrivate,
    label: 'TikTok API',
    timeout: 20_000,
    headers: {
      'user-agent': UA.tiktokBot,
      accept: 'application/json',
      'accept-encoding': 'gzip',
    },
  });

  const item = payload?.aweme_list?.find((a) => String(a?.aweme_id) === String(id)) ?? payload?.aweme_list?.[0];
  if (!item) {
    const err = new Error('TikTok\'s API returned no media for that post id.');
    err.status = 404;
    throw err;
  }

  // The app API nests the good URL under video.play_addr.url_list.
  const normalized = {
    ...item,
    video: {
      ...item.video,
      playAddr: item?.video?.play_addr?.url_list?.[0] ?? item?.video?.playAddr,
      downloadAddr: item?.video?.download_addr?.url_list?.[0] ?? item?.video?.downloadAddr,
      cover: item?.video?.cover?.url_list?.[0] ?? item?.video?.origin_cover?.url_list?.[0],
      duration: item?.video?.duration,
      bitrateInfo: (item?.video?.bitrate_info ?? []).map((b) => ({
        Bitrate: b?.bit_rate,
        QualityType: b?.gear_name,
        PlayAddr: {
          UrlList: b?.play_addr?.url_list ?? [],
          DataSize: b?.play_addr?.data_size,
          Width: b?.play_addr?.width,
          Height: b?.play_addr?.height,
        },
      })),
    },
    music: item?.music
      ? {
          title: item.music.title,
          playUrl: item.music.play_url?.url_list?.[0],
          dataSize: item.music.play_url?.data_size,
        }
      : null,
    author: {
      uniqueId: item?.author?.unique_id,
      nickname: item?.author?.nickname,
    },
    imagePost: item?.imagePost ?? item?.imagePostInfo ?? item?.image_post_info ?? null,
  };

  // App CDN URLs are watermarked-safe only when we ask for them with https.
  return resultFromItem(normalized, pageUrl, 'Resolved through TikTok\'s public app API.');
}

export async function resolve(url, ctx = {}) {
  let target = url;
  if (/^(vm|vt)\.tiktok\.com$/i.test(url.hostname)) {
    const expanded = await expandShortLink(url, ctx.allowPrivate);
    target = expanded.url;
  }

  const id = videoId(target);
  if (!id) {
    const err = new Error('That TikTok link has no post id. Use a link like https://www.tiktok.com/@user/video/1234567890.');
    err.status = 400;
    throw err;
  }
  const kind = /\/photo\//.test(target.pathname) ? 'photo' : 'video';
  const pageUrl = `https://www.tiktok.com/@i/${kind}/${id}`;

  const errors = [];
  try {
    const fromPage = await viaPage(target, ctx.allowPrivate);
    if (fromPage?.variants?.length) return fromPage;
    errors.push('page payload had no media');
  } catch (err) {
    errors.push(err.message);
  }

  try {
    const fromMobile = await viaMobilePage(id, pageUrl, ctx.allowPrivate);
    if (fromMobile?.variants?.length) return fromMobile;
    errors.push('mobile page had no media');
  } catch (err) {
    errors.push(`mobile: ${err.message}`);
  }

  try {
    return await viaAppApi(id, pageUrl, ctx.allowPrivate);
  } catch (err) {
    errors.push(err.message);
  }

  const error = new Error(
    `TikTok would not give up this post. Tried: ${errors.join('; ')}. ` +
      'If yt-dlp is installed, SwiftGrab will retry through it.'
  );
  error.status = 502;
  throw error;
}
