/**
 * Instagram extractor.
 *
 * Public posts expose their media through Instagram's own web GraphQL
 * document, which is reachable with the public `x-ig-app-id` header. We also
 * scrape the rendered page as a backup, because Instagram serves both
 * variants depending on how it feels about the request.
 */

import { UA, getText, fetchSafe } from '../http.js';
import { Result, decodeEntities, finalizeVariants, scrapeMediaCandidates } from '../util.js';

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

function variantsFromMedia(media) {
  const durationSeconds = Number.isFinite(media?.video_duration) ? media.video_duration : null;
  const variants = [];
  const seen = new Set();

  const push = (v) => {
    if (!v?.url) return;
    const url = String(v.url).replace(/&amp;/g, '&');
    if (seen.has(url)) return;
    seen.add(url);
    variants.push({ headers: { referer: 'https://www.instagram.com/', 'user-agent': UA.desktop }, duration: durationSeconds, ...v, url });
  };

  // video_versions is ordered best-first by Instagram.
  (media?.video_versions ?? []).forEach((version, index) => {
    const height = version?.height ?? null;
    push({
      id: `vv${index}`,
      label: height ? `${height}p` : `Video ${index + 1}`,
      ext: 'mp4',
      kind: 'video',
      quality: height,
      height,
      width: version?.width ?? null,
    });
  });

  if (!variants.length && media?.video_url) {
    push({ id: 'single', label: 'Video', ext: 'mp4', kind: 'video', quality: null });
  }

  return variants;
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

  // Carousels: collect video children from each edge.
  const children = media?.edge_sidecar_to_children?.edges?.map((e) => e?.node).filter(Boolean) ?? [];
  const videoNodes = children.filter((n) => n?.is_video && (n?.video_url || n?.video_versions));
  const source = videoNodes.length ? videoNodes[0] : media;

  const variants = variantsFromMedia(source);
  if (videoNodes.length > 1) {
    videoNodes.slice(1).forEach((node, i) => {
      variantsFromMedia(node).forEach((v) => variants.push({ ...v, id: `child${i + 1}_${v.id}`, label: `${v.label} (clip ${i + 2})` }));
    });
  }

  if (!variants.length) {
    const err = new Error('That Instagram post holds photos, not a video.');
    err.status = 422;
    throw err;
  }

  const owner = source?.owner ?? media?.owner ?? {};
  return Result.create({
    source: meta.id,
    sourceLabel: 'Instagram',
    pageUrl: canonicalUrl(code),
    title:
      (source?.edge_media_to_caption?.edges?.[0]?.node?.text ?? media?.caption?.text ?? '')
        ?.trim()
        .split('\n')[0]
        ?.slice(0, 140) || `Instagram post by @${owner.username ?? 'unknown'}`,
    author: owner.full_name ?? owner.username ?? null,
    authorUrl: owner.username ? `https://www.instagram.com/${owner.username}/` : null,
    thumbnail: source?.display_url ?? media?.display_url ?? null,
    duration: source?.video_duration ?? null,
    description: (source?.edge_media_to_caption?.edges?.[0]?.node?.text ?? media?.caption?.text ?? '')?.trim() || null,
    variants: finalizeVariants(variants),
    note: videoNodes.length > 1 ? `Carousel: ${videoNodes.length} videos, all listed.` : 'Public post resolved through Instagram GraphQL.',
  });
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

  const variants = [];
  const seen = new Set();

  // video_versions array: [{type, width, height, url}, ...]
  const versionsRe = /"video_versions"\s*:\s*\[([\s\S]{0,4000}?)\]/g;
  let block;
  while ((block = versionsRe.exec(html))) {
    const urlRe = /"url"\s*:\s*"(https:\\?\/\\?\/[^"]+?)"/g;
    let u;
    while ((u = urlRe.exec(block[1]))) {
      const url = u[1].replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
      if (seen.has(url)) continue;
      seen.add(url);
      const ctx = block[1].slice(Math.max(0, u.index - 240), u.index);
      const height = Number(/"height"\s*:\s*(\d+)/.exec(ctx)?.[1]) || null;
      const width = Number(/"width"\s*:\s*(\d+)/.exec(ctx)?.[1]) || null;
      variants.push({
        id: `p${variants.length}`,
        label: height ? `${height}p` : `Video ${variants.length + 1}`,
        ext: 'mp4',
        url,
        kind: 'video',
        quality: height,
        height,
        width,
        headers: { referer: 'https://www.instagram.com/', 'user-agent': UA.desktop },
      });
    }
  }

  if (!variants.length) {
    const single = /"video_url"\s*:\s*"(https:\\?\/\\?\/[^"]+?)"/.exec(html)?.[1];
    if (single) {
      variants.push({
        id: 'single',
        label: 'Video',
        ext: 'mp4',
        url: single.replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&'),
        kind: 'video',
        quality: null,
        headers: { referer: 'https://www.instagram.com/', 'user-agent': UA.desktop },
      });
    }
  }

  if (!variants.length) {
    // Anything at all, as a last attempt.
    for (const candidate of scrapeMediaCandidates(html, canonicalUrl(code))) {
      if (!/\.mp4|\/v\//.test(candidate.url)) continue;
      variants.push({
        id: `g${variants.length}`,
        label: 'Video',
        ext: 'mp4',
        url: candidate.url,
        kind: 'video',
        headers: { referer: 'https://www.instagram.com/', 'user-agent': UA.desktop },
      });
      break;
    }
  }

  if (!variants.length) return null;

  const title = decodeEntities(
    /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1] ?? ''
  ).trim();
  const image = /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1] ?? null;

  return Result.create({
    source: meta.id,
    sourceLabel: 'Instagram',
    pageUrl: canonicalUrl(code),
    title: title || `Instagram post ${code}`,
    thumbnail: image,
    variants: finalizeVariants(variants),
    note: 'Resolved by scraping the public page.',
  });
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
    errors.push('page scrape found no video');
  } catch (err) {
    errors.push(`page: ${err.message}`);
  }

  const error = new Error(
    `Instagram would not hand over that video (${errors.join('; ')}). Instagram gates most posts behind a login - ` +
      'installing yt-dlp with your Instagram session cookie is the reliable fix.'
  );
  error.status = 401;
  error.hint = 'yt-dlp';
  throw error;
}
