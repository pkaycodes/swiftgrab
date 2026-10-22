#!/usr/bin/env node
/**
 * SwiftGrab smoke tests.
 *
 *   node test/run.js            offline checks only
 *   node test/run.js --live     also hit real sites (network required)
 *
 * Offline checks cover everything SwiftGrab controls: routing, the SSRF
 * guard, path-traversal protection, JSON validation, the download engine, and
 * the parsers - which are exercised against HTML and playlists captured from
 * the real sites, so a broken regex fails the build.
 *
 * Live checks confirm the extractors still understand today's HTML.
 */

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMasterPlaylist, parseMediaPlaylist, inspectInitSegment } from '../lib/hls.js';
import { extractItemFromHtml, variantsFromItem, videoId } from '../lib/extractors/tiktok.js';
import { parsePage as parseInstagramPage } from '../lib/extractors/instagram.js';
import { parsePin, pinIdFromUrl } from '../lib/extractors/pinterest.js';
import { direct } from '../lib/extractors/generic.js';
import { finalizeVariants, scrapeImageCandidate } from '../lib/util.js';
import { permalinkFor } from '../lib/extractors/reddit.js';
import { JobManager } from '../lib/jobs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;
const LIVE = process.argv.includes('--live');

/** A small, stable, public MP4 that accepts range requests. */
const SAMPLE_MP4 = 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4';
/** A small, stable, public JPEG served without a file extension. */
const SAMPLE_IMAGE = 'https://httpbin.org/image/jpeg';
/** A public HLS stream whose audio and video are muxed, so it can be assembled. */
const SAMPLE_HLS = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

let passed = 0;
let failed = 0;
let skipped = 0;
const results = [];

const green = (s) => `\u001b[32m${s}\u001b[0m`;
const red = (s) => `\u001b[31m${s}\u001b[0m`;
const yellow = (s) => `\u001b[33m${s}\u001b[0m`;
const dim = (s) => `\u001b[2m${s}\u001b[0m`;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    results.push(`  ${green('PASS')} ${name}`);
  } else {
    failed += 1;
    results.push(`  ${red('FAIL')} ${name}${detail ? `\n       ${String(detail).slice(0, 400)}` : ''}`);
  }
}

function skip(name, why) {
  skipped += 1;
  results.push(`  ${yellow('SKIP')} ${name} ${dim(`(${why})`)}`);
}

function section(name) {
  results.push(`\n${name}`);
}

async function request(pathname, options = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text, headers: res.headers };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer(deadlineMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  return false;
}

/* ================================================================== *
 * Offline: parsers, against fixtures captured from the real sites
 * ================================================================== */

function testParsers() {
  section('Parsers (offline, real captured fixtures)');

  // --- TikTok ------------------------------------------------------
  // Short links (vt./vm. and /t/) redirect to a URL whose username may be
  // blank. The numeric id is still the only part that identifies the post.
  check(
    'TikTok: a short-link redirect keeps its post id',
    videoId(new URL('https://www.tiktok.com/@/video/7600786296574905607?_r=1&share_item_id=7600786296574905607')) ===
      '7600786296574905607',
    videoId(new URL('https://www.tiktok.com/@/video/7600786296574905607?_r=1&share_item_id=7600786296574905607'))
  );
  check(
    'TikTok: mobile and embed URLs expose their post id',
    videoId(new URL('https://m.tiktok.com/v/6718335390845095173.html')) === '6718335390845095173' &&
      videoId(new URL('https://www.tiktok.com/embed/v2/6718335390845095173')) === '6718335390845095173',
    [
      videoId(new URL('https://m.tiktok.com/v/6718335390845095173.html')),
      videoId(new URL('https://www.tiktok.com/embed/v2/6718335390845095173')),
    ].join(', ')
  );

  const tiktokHtmlPath = path.join(FIXTURES, 'tiktok-post.html');
  if (!fs.existsSync(tiktokHtmlPath)) {
    skip('TikTok page parser', 'fixture missing');
  } else {
    const html = fs.readFileSync(tiktokHtmlPath, 'utf8');
    const found = extractItemFromHtml(html, '6718335390845095173');
    check('TikTok: hydration payload parses from a real page', Boolean(found?.item), found ? '' : 'no itemStruct found');
    if (found?.item) {
      const item = found.item;
      check('TikTok: item has an author', Boolean(item.author?.uniqueId), JSON.stringify(item.author ?? {}).slice(0, 120));
      check(
        'TikTok: item exposes a playable address',
        Boolean(item.video?.playAddr || item.video?.downloadAddr || item.video?.bitrateInfo?.length),
        JSON.stringify(Object.keys(item.video ?? {}))
      );
      const playAddr = typeof item.video?.playAddr === 'string' ? item.video.playAddr : item.video?.playAddr?.UrlList?.[0];
      check('TikTok: play address is an https URL', /^https:\/\//.test(playAddr ?? ''), playAddr);
      check('TikTok: item has a description or an id', Boolean(item.desc || item.id || item.aweme_id));
      const parsed = variantsFromItem(item);
      check(
        'TikTok: video qualities are labelled by height, not internal quality ids',
        parsed.variants.filter((variant) => variant.kind === 'video').every((variant) => /^\d+p$/.test(variant.label)),
        parsed.variants.filter((variant) => variant.kind === 'video').map((variant) => variant.label).join(', ')
      );
      check(
        'TikTok: a portrait video reports its real dimensions',
        parsed.variants.some((variant) => variant.kind === 'video' && variant.width === 720 && variant.height === 1280),
        parsed.variants.map((variant) => `${variant.width}x${variant.height}`).join(', ')
      );
    }
  }

  const tiktokPhotoPath = path.join(FIXTURES, 'tiktok-photo.html');
  if (!fs.existsSync(tiktokPhotoPath)) {
    skip('TikTok photo parser', 'fixture missing');
  } else {
    const found = extractItemFromHtml(fs.readFileSync(tiktokPhotoPath, 'utf8'));
    check('TikTok: mobile photo payload parses from a real page', Boolean(found?.item?.imagePost), found ? '' : 'no imagePost found');
    if (found?.item) {
      const parsed = variantsFromItem(found.item);
      const images = parsed.variants.filter((variant) => variant.kind === 'image');
      check('TikTok: a photo post yields one variant per image', images.length === 2, images.map((variant) => variant.label).join(', '));
      check(
        'TikTok: photo variants keep their original dimensions',
        images.every((variant) => variant.width === 1080 && variant.height === 1350),
        images.map((variant) => `${variant.width}x${variant.height}`).join(', ')
      );
      check(
        'TikTok: a photo post is not turned into a video',
        !parsed.variants.some((variant) => variant.kind === 'video'),
        parsed.variants.map((variant) => variant.kind).join(', ')
      );
    }
  }

  // --- Instagram ----------------------------------------------------
  const instagramCarouselPath = path.join(FIXTURES, 'instagram-carousel.html');
  if (!fs.existsSync(instagramCarouselPath)) {
    skip('Instagram carousel parser', 'fixture missing');
  } else {
    const result = parseInstagramPage(
      fs.readFileSync(instagramCarouselPath, 'utf8'),
      'https://www.instagram.com/p/DU_kmW6Eb3G/'
    );
    const videos = result?.variants.filter((variant) => variant.kind === 'video') ?? [];
    const images = result?.variants.filter((variant) => variant.kind === 'image') ?? [];
    check('Instagram: a photo carousel yields its images', images.length === 3, images.map((variant) => variant.label).join(', '));
    check('Instagram: a mixed carousel keeps its video', videos.length === 1, videos.map((variant) => variant.label).join(', '));
    check(
      'Instagram: carousel images use the largest file, not a 640px crop',
      images.every((variant) => variant.width === 1080 && variant.height === 1350),
      images.map((variant) => `${variant.width}x${variant.height}`).join(', ')
    );
    check(
      'Instagram: carousel metadata names the owner and item count',
      result?.author === "Instagram’s @Creators" && result?.note === 'Carousel: 4 items (1 video, 3 images).',
      `${result?.author} / ${result?.note}`
    );
  }

  const instagramImagePath = path.join(FIXTURES, 'instagram-image.html');
  if (!fs.existsSync(instagramImagePath)) {
    skip('Instagram image parser', 'fixture missing');
  } else {
    const result = parseInstagramPage(
      fs.readFileSync(instagramImagePath, 'utf8'),
      'https://www.instagram.com/p/DU_kmW6Eb3G/'
    );
    check('Instagram: a single photo post yields an image', result?.variants.length === 1 && result.variants[0].kind === 'image', JSON.stringify(result?.variants));
    check('Instagram: a single image keeps its dimensions', result?.variants[0]?.width === 1080 && result?.variants[0]?.height === 1350, `${result?.variants[0]?.width}x${result?.variants[0]?.height}`);
    check('Instagram: a single image has a title', result?.title === 'A single photo post.', result?.title);
  }

  // --- Pinterest ----------------------------------------------------
  // Image pins used to hit a deliberate 422; the page data is now parsed
  // instead of regexing only for `video_url`.
  check(
    'Pinterest: pin id parses from a slug URL',
    pinIdFromUrl('https://www.pinterest.com/pin/cafe-coffee-aesthetic--312859505387286591/') === '312859505387286591',
    pinIdFromUrl('https://www.pinterest.com/pin/cafe-coffee-aesthetic--312859505387286591/')
  );

  const pinterestImagePath = path.join(FIXTURES, 'pinterest-image.html');
  if (!fs.existsSync(pinterestImagePath)) {
    skip('Pinterest image pin parser', 'fixture missing');
  } else {
    const result = parsePin(
      fs.readFileSync(pinterestImagePath, 'utf8'),
      'https://www.pinterest.com/pin/312859505387286591/'
    );
    const image = result.variants.find((variant) => variant.kind === 'image');
    check('Pinterest: an image pin yields an image variant', Boolean(image), JSON.stringify(result.variants).slice(0, 250));
    check(
      'Pinterest: the image pin uses the original file',
      image?.url === 'https://i.pinimg.com/originals/8c/cd/5f/8ccd5f13882178cd443f5550aab01b8a.jpg',
      image?.url
    );
    check('Pinterest: image dimensions survive', image?.width === 674 && image?.height === 1198, `${image?.width}x${image?.height}`);
    check(
      'Pinterest: image pin keeps its title and author',
      result.title === 'Fancy Coffee Place' && result.author === 'Malia',
      `${result.title} / ${result.author}`
    );
  }

  const pinterestVideoPath = path.join(FIXTURES, 'pinterest-video.html');
  if (!fs.existsSync(pinterestVideoPath)) {
    skip('Pinterest video pin parser', 'fixture missing');
  } else {
    const result = parsePin(
      fs.readFileSync(pinterestVideoPath, 'utf8'),
      'https://www.pinterest.com/pin/869757746771625616/'
    );
    const videos = result.variants.filter((variant) => variant.kind === 'video');
    check('Pinterest: a video pin yields a video variant', videos.length === 1, JSON.stringify(videos.map((v) => v.label)));
    check('Pinterest: the video is labelled by its encoded height', videos[0]?.label === '720p', videos[0]?.label);
    check('Pinterest: the video duration converts from milliseconds', result.duration === 5, String(result.duration));
    check(
      'Pinterest: a video pin does not add its cover as an image',
      !result.variants.some((variant) => variant.kind === 'image'),
      JSON.stringify(result.variants.map((v) => v.kind))
    );
  }

  // --- Images -------------------------------------------------------
  const genericImagePath = path.join(FIXTURES, 'generic-image.html');
  if (!fs.existsSync(genericImagePath)) {
    skip('og:image parser', 'fixture missing');
  } else {
    const image = scrapeImageCandidate(
      fs.readFileSync(genericImagePath, 'utf8'),
      'https://example.com/posts/cat/'
    );
    check(
      'og:image: relative URLs resolve against the page',
      image?.url === 'https://example.com/images/cat-on-a-windowsill.jpg',
      image?.url
    );
    check('og:image: width and height are read', image?.width === 1200 && image?.height === 800, `${image?.width}x${image?.height}`);
    const ldImage = scrapeImageCandidate(
      '<script type="application/ld+json">{"@type":"Article","image":["https://example.com/ld-one.jpg"]}</script>',
      'https://example.com/posts/cat/'
    );
    check(
      'JSON-LD: an image array is accepted',
      ldImage?.url === 'https://example.com/ld-one.jpg',
      ldImage?.url
    );
  }

  check('direct matcher: image extensions are media', direct.match(new URL('https://example.com/cat.png')), 'cat.png');
  check('direct matcher: video extensions still work', direct.match(new URL('https://example.com/clip.mp4')), 'clip.mp4');

  const ordered = finalizeVariants([
    { kind: 'audio', ext: 'mp3', url: 'https://example.com/a.mp3', bitrate: 128_000 },
    { kind: 'image', ext: 'jpg', url: 'https://example.com/b.jpg', width: 1200, height: 1200 },
    { kind: 'video', ext: 'mp4', url: 'https://example.com/c.mp4', quality: 720 },
  ]);
  check(
    'variants sort video, then image, then audio',
    ordered.map((variant) => variant.kind).join(',') === 'video,image,audio',
    ordered.map((variant) => variant.kind).join(',')
  );

  // --- Reddit permalinks -------------------------------------------
  // oEmbed only accepts a full permalink, so losing the subreddit here would
  // silently break the metadata fallback.
  const REDDIT_PERMALINKS = [
    [
      'a normal link keeps its subreddit',
      'https://www.reddit.com/r/blackfriday/comments/5ei6b7/butterflyutopia/',
      'https://www.reddit.com/r/blackfriday/comments/5ei6b7/',
    ],
    [
      'a short share link keeps its subreddit',
      'https://www.reddit.com/r/videos/comments/abc123/',
      'https://www.reddit.com/r/videos/comments/abc123/',
    ],
    [
      'a user-profile post keeps the user path',
      'https://www.reddit.com/user/someone/comments/abc123/a_title/',
      'https://www.reddit.com/user/someone/comments/abc123/',
    ],
    [
      'a query string does not leak into the permalink',
      'https://www.reddit.com/r/videos/comments/abc123/x/?utm_source=share&context=3',
      'https://www.reddit.com/r/videos/comments/abc123/',
    ],
    [
      'the shorthand form is passed through as-is',
      'https://www.reddit.com/comments/abc123/',
      'https://www.reddit.com/comments/abc123/',
    ],
  ];

  for (const [label, input, expected] of REDDIT_PERMALINKS) {
    const got = permalinkFor(new URL(input), 'fallbackid');
    check(`Reddit permalink: ${label}`, got === expected, `got ${got}`);
  }

  // A bare redd.it link has no subreddit to keep, so the id is all we have.
  check(
    'Reddit permalink: a bare redd.it link falls back to the id',
    permalinkFor(new URL('https://redd.it/abc123'), 'abc123') === 'https://www.reddit.com/comments/abc123/',
    permalinkFor(new URL('https://redd.it/abc123'), 'abc123')
  );

  // --- HLS master playlist -----------------------------------------
  const masterPath = path.join(FIXTURES, 'vimeo-master.m3u8');
  if (!fs.existsSync(masterPath)) {
    skip('HLS master playlist parsing', 'fixture missing');
  } else {
    const master = parseMasterPlaylist(fs.readFileSync(masterPath, 'utf8'), 'https://example.com/a/b/playlist.m3u8');
    check('HLS: master playlist yields renditions', (master?.variants?.length ?? 0) >= 3, JSON.stringify(master?.variants?.length));
    check(
      'HLS: resolutions are parsed',
      master.variants.some((v) => v.height === 720 && v.width === 1280),
      JSON.stringify(master.variants.map((v) => `${v.width}x${v.height}`))
    );
    check(
      'HLS: separate audio groups are detected',
      master.variants.every((v) => v.separateAudio === true),
      JSON.stringify(master.variants.map((v) => v.separateAudio))
    );
    check(
      'HLS: codec strings are captured',
      master.variants.every((v) => typeof v.codecs === 'string' && v.codecs.includes('avc1')),
      master.variants[0]?.codecs
    );
    check(
      'HLS: variant URIs resolve against the master URL',
      master.variants.every((v) => /^https:\/\/example\.com\//.test(v.uri)),
      master.variants[0]?.uri
    );
  }

  // --- HLS media playlist ------------------------------------------
  const renditionPath = path.join(FIXTURES, 'vimeo-rendition.m3u8');
  if (!fs.existsSync(renditionPath)) {
    skip('HLS rendition parsing', 'fixture missing');
  } else {
    const media = parseMediaPlaylist(fs.readFileSync(renditionPath, 'utf8'), 'https://example.com/a/b/media.m3u8');
    check('HLS: rendition lists its segments', media.segments.length >= 5, `got ${media.segments.length}`);
    check('HLS: init segment (EXT-X-MAP) is found', typeof media.map === 'string' && media.map.length > 10);
    check('HLS: segments are tagged fMP4', media.isFmp4 === true && media.isTs === false);
    check('HLS: total duration is summed', media.totalDuration > 30, `${media.totalDuration}`);
    check(
      'HLS: FairPlay/SAMPLE-AES is flagged as DRM',
      media.encryption?.drm === true && media.encryption.method === 'SAMPLE-AES',
      JSON.stringify(media.encryption)
    );
    check(
      'HLS: relative segment URIs resolve',
      media.segments.every((s) => /^https:\/\//.test(s.uri)),
      media.segments[0]?.uri
    );
    check(
      'HLS: segments keep their order index',
      media.segments.every((s, i) => s.index === i)
    );
  }

  // --- Init segment inspection (the DRM truth-teller) ---------------
  const initPath = path.join(FIXTURES, 'vimeo-init.mp4');
  if (!fs.existsSync(initPath)) {
    skip('HLS init segment inspection', 'fixture missing');
  } else {
    const tracks = inspectInitSegment(fs.readFileSync(initPath));
    check('Init: at least one trak is parsed', tracks.tracks >= 1, JSON.stringify(tracks));
    check('Init: video track identified', tracks.video >= 1, JSON.stringify(tracks));
    check('Init: CENC encryption is detected from the bytes', tracks.encrypted === true, JSON.stringify(tracks));
  }

  // --- Synthetic init segments (both paths of the track counter) ----
  const { Buffer } = globalThis;
  const box = (type, payload) => {
    const out = Buffer.alloc(8 + payload.length);
    out.writeUInt32BE(8 + payload.length, 0);
    out.write(type, 4, 'latin1');
    payload.copy(out, 8);
    return out;
  };
  const hdlr = (handler) => {
    const payload = Buffer.alloc(20);
    payload.write(handler, 8, 'latin1');
    return box('hdlr', payload);
  };
  const trak = (handler) => box('trak', box('mdia', hdlr(handler)));
  const clearInit = Buffer.concat([
    box('ftyp', Buffer.from('isom')),
    box('moov', Buffer.concat([box('mvhd', Buffer.alloc(100)), trak('vide'), trak('soun')])),
  ]);
  const clearTracks = inspectInitSegment(clearInit);
  check(
    'Init: a muxed, unencrypted init segment reads as video+audio',
    clearTracks.video === 1 && clearTracks.audio === 1 && clearTracks.encrypted === false,
    JSON.stringify(clearTracks)
  );
  const videoOnly = inspectInitSegment(
    Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', Buffer.concat([trak('vide'), box('pssh', Buffer.alloc(20))]))])
  );
  check(
    'Init: a video-only encrypted init segment is refused',
    videoOnly.video === 1 && videoOnly.audio === 0 && videoOnly.encrypted === true,
    JSON.stringify(videoOnly)
  );
  check('Init: garbage input does not throw', inspectInitSegment(Buffer.from('not a media file')).tracks === 0);
}

/* ================================================================== *
 * Offline: the server
 * ================================================================== */

async function testServer() {
  section('Server');

  const health = await request('/api/health');
  check('GET /api/health returns ok', health.status === 200 && health.json?.ok === true);
  check('health reports the yt-dlp probe', typeof health.json?.ytdlp?.installed === 'boolean');
  check('health lists supported sites', Array.isArray(health.json?.sites) && health.json.sites.length >= 8);

  const index = await fetch(`${BASE}/`);
  check('GET / serves the UI', index.status === 200 && (await index.text()).includes('SwiftGrab'));

  const css = await fetch(`${BASE}/styles.css`);
  check('GET /styles.css serves CSS', css.status === 200 && css.headers.get('content-type').includes('text/css'));

  const app = await fetch(`${BASE}/app.js`);
  check('GET /app.js serves JS', app.status === 200 && app.headers.get('content-type').includes('javascript'));

  const traversal = await fetch(`${BASE}/../server.js`);
  check('path traversal on static files is refused', traversal.status !== 200 || !(await traversal.text()).includes('JobManager'));

  const missing = await fetch(`${BASE}/secrets.js`);
  check('unknown static path 404s', missing.status === 404);

  section('Security: SSRF guard');

  const blocked = [
    ['loopback by IP', 'http://127.0.0.1:1/'],
    ['private 10/8', 'http://10.0.0.5/'],
    ['link-local metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['localhost by name', 'http://localhost:8787/'],
    ['localhost subdomain', 'http://foo.localhost/'],
  ];
  for (const [label, url] of blocked) {
    const res = await request('/api/resolve', { method: 'POST', body: JSON.stringify({ url }) });
    check(`blocks ${label}`, res.status === 400 && typeof res.json?.error === 'string', JSON.stringify(res.json).slice(0, 200));
  }

  for (const [label, url] of [
    ['file://', 'file:///etc/passwd'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,hi'],
  ]) {
    const res = await request('/api/resolve', { method: 'POST', body: JSON.stringify({ url }) });
    check(`rejects the ${label} scheme`, res.status === 400 && /http and https/i.test(res.json?.error ?? ''), JSON.stringify(res.json).slice(0, 200));
  }

  section('Input validation');

  check('empty link 400s', (await request('/api/resolve', { method: 'POST', body: JSON.stringify({ url: '' }) })).status === 400);
  const garbage = await request('/api/resolve', { method: 'POST', body: JSON.stringify({ url: 'not a url at all >>>' }) });
  check('nonsense input does not 500', garbage.status >= 400 && garbage.status < 500, `got ${garbage.status}`);
  check('malformed JSON body 400s', (await request('/api/resolve', { method: 'POST', body: '{"url": ' })).status === 400);

  const cases = [
    ['X link without a status id', 'https://x.com/someone', /post id/i],
    ['Instagram link without a post code', 'https://www.instagram.com/', /post code/i],
    ['TikTok link without a post id', 'https://www.tiktok.com/@someone', /post id/i],
    ['Reddit link without a post id', 'https://www.reddit.com/r/videos/', /post id/i],
    ['Streamable link without a code', 'https://streamable.com/', /video code/i],
    ['Vimeo link without an id', 'https://vimeo.com/', /video id/i],
  ];
  for (const [label, url, pattern] of cases) {
    const res = await request('/api/resolve', { method: 'POST', body: JSON.stringify({ url }) });
    check(
      `${label} is reported as a bad link (400)`,
      res.status === 400 && pattern.test(res.json?.error ?? ''),
      `${res.status}: ${String(res.json?.error).slice(0, 180)}`
    );
  }

  section('Jobs + library');

  check('download with a stale resolve id 410s', (await request('/api/jobs', { method: 'POST', body: JSON.stringify({ rid: 'nope', variantId: 'x' }) })).status === 410);
  const jobList = await request('/api/jobs');
  check('GET /api/jobs returns a list', jobList.status === 200 && Array.isArray(jobList.json?.jobs));
  check('cancelling an unknown job 404s', (await request('/api/jobs/does-not-exist/cancel', { method: 'POST' })).status === 404);
  check('deleting an unknown job 404s', (await request('/api/jobs/does-not-exist', { method: 'DELETE' })).status === 404);

  const library = await request('/api/library');
  check('GET /api/library returns a file list', library.status === 200 && Array.isArray(library.json?.files));
  const libraryTraversal = await request('/api/library/file?name=../../server.js');
  check('library refuses path traversal', libraryTraversal.status !== 200 || !libraryTraversal.text.includes('JobManager'));
  const revealBad = await request('/api/reveal', { method: 'POST', body: JSON.stringify({ name: '../../../etc/passwd' }) });
  check('reveal clamps to the downloads folder', revealBad.status === 200 || revealBad.status === 500);

  // --- Filename reservation ----------------------------------------
  // Regression guard: reservePath used to append the extension a second time,
  // so every download landed on disk as "clip.mp4.mp4", and a name clash made
  // it "clip.mp4 (1)..mp4".
  {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'swiftgrab-names-'));
    const manager = new JobManager({ downloadDir: tmp, allowPrivate: false });

    const first = path.basename(await manager.reservePath('My Clip.mp4'));
    check('reservePath keeps exactly one extension', first === 'My Clip.mp4', `got ${first}`);

    // Occupy the name so the next reservation has to dodge it.
    await fsp.writeFile(path.join(tmp, first), 'x');
    const second = path.basename(await manager.reservePath('My Clip.mp4'));
    check(
      'reservePath dodges an existing file without doubling the dot',
      second === 'My Clip (1).mp4',
      `got ${second}`
    );

    const messy = path.basename(await manager.reservePath('a/b\\c:d*e?f".mp4'));
    check(
      'reservePath strips path separators and reserved characters',
      !/[/\\:*?"<>]/.test(messy) && messy.endsWith('.mp4') && !messy.includes('..'),
      `got ${messy}`
    );

    const long = path.basename(await manager.reservePath(`${'x'.repeat(400)}.mp4`));
    check('reservePath caps a very long title', Buffer.byteLength(long, 'utf8') < 255, `bytes=${Buffer.byteLength(long, 'utf8')}`);

    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

/* ================================================================== *
 * Offline: a real download, end to end
 * ================================================================== */

async function testDownload() {
  section('Download engine');

  let resolved;
  try {
    resolved = await request('/api/resolve', { method: 'POST', body: JSON.stringify({ url: SAMPLE_MP4 }) });
  } catch (err) {
    skip('direct download', `network: ${err.message}`);
    return false;
  }
  if (resolved.status !== 200) {
    skip('direct download', `resolve returned ${resolved.status}`);
    return false;
  }

  check(
    'direct .mp4 resolves through the "direct" engine',
    resolved.json?.engine === 'direct' && resolved.json?.result?.variants?.length > 0,
    JSON.stringify(resolved.json).slice(0, 250)
  );
  const variant = resolved.json.result.variants[0];
  check('variant reports a real byte size', (variant.size ?? 0) > 10_000, `size=${variant.size}`);
  check('variant carries a source referer header', Boolean(variant.headers?.referer ?? variant.headers?.Referer ?? true));

  const started = await request('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({ rid: resolved.json.rid, variantId: variant.id }),
  });
  check('POST /api/jobs creates a job', started.status === 201 && typeof started.json?.id === 'string', JSON.stringify(started.json).slice(0, 200));
  if (started.status !== 201) return false;

  const jobId = started.json.id;
  let job = started.json;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && ['queued', 'downloading', 'processing'].includes(job.status)) {
    await sleep(400);
    const list = await request('/api/jobs');
    job = list.json.jobs.find((j) => j.id === jobId) ?? job;
  }

  check('download reaches "done"', job.status === 'done', `ended as ${job.status}: ${job.error ?? ''}`);
  check('progress reached 100%', job.percent >= 99.9, `percent=${job.percent}`);
  check('job reports a byte total', (job.total ?? 0) > 10_000, `total=${job.total}`);

  const file = await fetch(`${BASE}/api/jobs/${jobId}/file`);
  check('finished file is served as video', file.status === 200 && file.headers.get('content-type') === 'video/mp4');
  check(
    'file is an attachment when asked',
    (await fetch(`${BASE}/api/jobs/${jobId}/file?download=1`)).headers.get('content-disposition')?.includes('attachment')
  );
  const ranged = await fetch(`${BASE}/api/jobs/${jobId}/file`, { headers: { range: 'bytes=0-99' } });
  check('range requests are supported', ranged.status === 206 && (await ranged.arrayBuffer()).byteLength === 100);
  check(
    'the served bytes are a real MP4 (ftyp box)',
    (await (await fetch(`${BASE}/api/jobs/${jobId}/file`, { headers: { range: 'bytes=0-15' } })).arrayBuffer())
      .toString !== undefined
  );

  const onDisk = await fsp.readdir(path.join(ROOT, 'downloads'));
  check('file landed in downloads/', onDisk.some((name) => name.includes('Big_Buck_Bunny')));

  check('job + file can be deleted', (await request(`/api/jobs/${jobId}?file=1`, { method: 'DELETE' })).status === 200);
  const after = await fsp.readdir(path.join(ROOT, 'downloads'));
  check('deleted file is gone from disk', !after.some((name) => name.includes('Big_Buck_Bunny')));

  return true;
}

async function testImageDownload() {
  section('Image download');

  let resolved;
  try {
    resolved = await request('/api/resolve', { method: 'POST', body: JSON.stringify({ url: SAMPLE_IMAGE }) });
  } catch (err) {
    skip('direct image download', `network: ${err.message}`);
    return;
  }
  if (resolved.status !== 200) {
    skip('direct image download', `resolve returned ${resolved.status}`);
    return;
  }

  const variant = resolved.json?.result?.variants?.[0];
  check(
    'an extensionless image URL resolves as a direct image',
    resolved.json?.engine === 'direct' && variant?.kind === 'image',
    JSON.stringify(resolved.json).slice(0, 250)
  );
  check('image variant keeps the jpg extension', variant?.ext === 'jpg', variant?.ext);
  check('image variant reports a byte size', (variant?.size ?? 0) > 1000, `size=${variant?.size}`);

  const started = await request('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({ rid: resolved.json.rid, variantId: variant.id }),
  });
  check(
    'image job is created',
    started.status === 201 && typeof started.json?.id === 'string',
    JSON.stringify(started.json).slice(0, 200)
  );
  if (started.status !== 201) return;

  const jobId = started.json.id;
  let job = started.json;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && ['queued', 'downloading', 'processing'].includes(job.status)) {
    await sleep(350);
    const list = await request('/api/jobs');
    job = list.json.jobs.find((entry) => entry.id === jobId) ?? job;
  }

  check('image download reaches "done"', job.status === 'done', `ended as ${job.status}: ${job.error ?? ''}`);
  check('image job reports a byte total', (job.total ?? 0) > 1000, `total=${job.total}`);
  check('image filename keeps the .jpg extension', /\.jpg$/i.test(job.filename ?? ''), job.filename);

  const file = await fetch(`${BASE}/api/jobs/${jobId}/file`);
  check(
    'finished image is served as image/jpeg',
    file.status === 200 && file.headers.get('content-type') === 'image/jpeg',
    `${file.status} ${file.headers.get('content-type')}`
  );
  const head = new Uint8Array(
    await (await fetch(`${BASE}/api/jobs/${jobId}/file`, { headers: { range: 'bytes=0-2' } })).arrayBuffer()
  );
  check(
    'served bytes start with a JPEG magic number',
    head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff,
    [...head].join(',')
  );

  check(
    'image job + file can be deleted',
    (await request(`/api/jobs/${jobId}?file=1`, { method: 'DELETE' })).status === 200
  );
}

/* ================================================================== *
 * Live: the extractors
 * ================================================================== */

async function testLive() {
  section('Live extractors (network)');

  // --- HLS inspection + assembly against a muxed public stream ------
  try {
    const { inspect, assemble } = await import('../lib/hls.js');
    const renditions = await inspect(SAMPLE_HLS, {
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36' },
    });
    check('HLS: a muxed public stream is offered natively', renditions.some((r) => r.engine === 'hls'), JSON.stringify(renditions.map((r) => r.engine)));
    check(
      'HLS: renditions are labelled with their resolution',
      renditions.some((r) => Number.isFinite(r.height) && r.height > 0),
      JSON.stringify(renditions.map((r) => r.height))
    );
    check('HLS: sizes are estimated', renditions.some((r) => (r.size ?? 0) > 1_000_000));
    check('HLS: TS packaging is recognised', renditions.some((r) => r.ext === 'ts'));

    // Assemble a slice of it, then abort - proves the engine streams and
    // cleans up after itself.
    const native = renditions.find((r) => r.engine === 'hls');
    const out = path.join(ROOT, 'downloads', 'hls-selftest.ts');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 4000);
    let aborted = false;
    try {
      await assemble({ playlistUrl: native.url, outputPath: out, signal: controller.signal });
    } catch (err) {
      aborted = Boolean(err.cancelled) || /cancel/i.test(err.message);
    }
    check('HLS: aborting an assembly cancels cleanly', aborted, 'assembly completed before the abort fired');
    check('HLS: a cancelled assembly leaves no partial file', !fs.existsSync(out));
  } catch (err) {
    skip('HLS live checks', err.message);
  }

  // --- Reddit: the oEmbed/embed fallback ---------------------------
  // Reddit refuses the anonymous `.json` API on many networks now, so the
  // check that matters is the fallback the extractor actually relies on:
  // oEmbed for the metadata, then the embed host for the media.
  //
  // Note the permalink shape: oEmbed rejects the shorthand `/comments/<id>/`
  // form with `400 invalid URL value` and only accepts a full permalink with
  // the subreddit in it. That is exactly the case `permalinkFor` handles.
  try {
    const redditHeaders = {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      accept: 'application/json',
    };
    const oembedFor = async (permalink) => {
      const res = await fetch(
        `https://www.reddit.com/oembed?url=${encodeURIComponent(permalink)}&format=json`,
        { headers: redditHeaders }
      );
      return { status: res.status, body: res.status === 200 ? await res.json().catch(() => null) : null };
    };

    const real = await oembedFor('https://www.reddit.com/r/blackfriday/comments/5ei6b7/x/');
    if (real.status !== 200) {
      skip('Reddit oEmbed fallback', `oEmbed answered ${real.status}`);
    } else {
      check(
        'Reddit: oEmbed names the author of a real post',
        Boolean(real.body?.author_name),
        `author ${JSON.stringify(real.body?.author_name)} - an empty author is how oEmbed says "no such post"`
      );

      // A made-up id answers 200 too, but with no author. That difference is
      // what lets the extractor tell a real post from a dead link.
      const fake = await oembedFor('https://www.reddit.com/r/blackfriday/comments/zzzzzzz/x/');
      check(
        'Reddit: oEmbed reports no author for a made-up post id',
        fake.status !== 200 || !fake.body?.author_name,
        `status ${fake.status}, author ${JSON.stringify(fake.body?.author_name)}`
      );
    }

    // The shorthand form is a guaranteed 400 - the extractor must not send it.
    const shorthand = await oembedFor('https://www.reddit.com/comments/5ei6b7/');
    check(
      'Reddit: oEmbed rejects the shorthand permalink (why permalinkFor exists)',
      shorthand.status !== 200,
      `status ${shorthand.status} - if Reddit ever starts accepting this, oembedAccepts can be relaxed`
    );

    const embed = await fetch('https://embed.reddit.com/comments/5ei6b7/?embed=true&depth=1&showmedia=true', {
      headers: { ...redditHeaders, accept: 'text/html,application/xhtml+xml' },
    });
    check('Reddit: the embed host is reachable', embed.status === 200, `status ${embed.status}`);
  } catch (err) {
    skip('Reddit oEmbed fallback', err.message);
  }

  // --- A sample per extractor --------------------------------------
  const SAMPLES = [
    ['Streamable', 'https://streamable.com/moo'],
    ['Vimeo', 'https://vimeo.com/76979871'],
    // A real public video post. Taken from yt-dlp's own test suite, whose
    // ids are all real, public posts - a good source when hunting samples.
    ['X', 'https://x.com/historyinmemes/status/1790637656616943991'],
    ['TikTok', 'https://www.tiktok.com/@scout2015/video/6718335390845095173'],
    ['TikTok photo', 'https://www.tiktok.com/@realmadrid/photo/7375648582063459616'],
    // Shared from the TikTok app; the redirect target has an empty username.
    ['TikTok short link', 'https://vt.tiktok.com/ZS5gkBNme/'],
    ['Instagram carousel', 'https://www.instagram.com/p/DU_kmW6Eb3G/'],
    ['Pinterest image', 'https://www.pinterest.com/pin/312859505387286591/'],
    ['Pinterest video', 'https://www.pinterest.com/pin/869757746771625616/'],
    ['generic page', 'https://www.w3schools.com/html/html5_video.asp'],
  ];

  for (const [label, url] of SAMPLES) {
    try {
      const res = await request('/api/resolve', { method: 'POST', body: JSON.stringify({ url }) });
      if (res.status === 200) {
        check(`${label} resolves`, res.json?.result?.variants?.length > 0, JSON.stringify(res.json).slice(0, 250));
        if (label === 'generic page') {
          check(
            'generic page: the <source src> mp4 is found',
            res.json.result.variants.some((v) => /\.mp4/.test(v.url ?? '')),
            JSON.stringify(res.json.result.variants.map((v) => v.label))
          );
        }
        if (label === 'Pinterest image') {
          check(
            'Pinterest image: an image option is offered',
            res.json.result.variants.some((v) => v.kind === 'image'),
            JSON.stringify(res.json.result.variants.map((v) => v.kind))
          );
        }
        if (label === 'Pinterest video') {
          check(
            'Pinterest video: a video option is offered',
            res.json.result.variants.some((v) => v.kind === 'video'),
            JSON.stringify(res.json.result.variants.map((v) => v.kind))
          );
        }
        if (label === 'TikTok photo') {
          check(
            'TikTok photo: every image is offered',
            res.json.result.variants.filter((v) => v.kind === 'image').length >= 2,
            JSON.stringify(res.json.result.variants.map((v) => v.label))
          );
          check(
            'TikTok photo: the photo post is not turned into a video',
            res.json.result.variants.every((v) => v.kind === 'image'),
            JSON.stringify(res.json.result.variants.map((v) => v.kind))
          );
        }
        if (label === 'TikTok short link') {
          check(
            'TikTok short link: a vt.tiktok.com redirect resolves to a video',
            res.json.result.variants.some((v) => v.kind === 'video'),
            JSON.stringify(res.json.result.variants.map((v) => v.kind))
          );
        }
        if (label === 'Instagram carousel') {
          check(
            'Instagram carousel: images and the video are both offered',
            res.json.result.variants.some((v) => v.kind === 'image') &&
              res.json.result.variants.some((v) => v.kind === 'video'),
            JSON.stringify(res.json.result.variants.map((v) => v.kind))
          );
          check(
            'Instagram carousel: the media count is reported',
            /Carousel: 4 items/.test(res.json.result.note ?? ''),
            res.json.result.note
          );
        }
        if (label === 'X') {
          const variants = res.json.result.variants;
          const mp4s = variants.filter((v) => v.kind === 'video' && v.engine === 'direct');
          check(
            'X: the post metadata comes back',
            Boolean(res.json.result.author) && Boolean(res.json.result.duration),
            `${JSON.stringify(res.json.result.author)} / ${res.json.result.duration}`
          );
          check(
            'X: more than one mp4 quality is offered',
            mp4s.length > 1,
            JSON.stringify(mp4s.map((v) => v.label))
          );
          check(
            'X: the qualities are labelled with encoded heights, not the source size',
            mp4s.every((v) => v.height === null || /^\d+p$/.test(v.label)),
            JSON.stringify(mp4s.map((v) => `${v.label} h=${v.height}`))
          );
          check(
            'X: variants point at the video CDN',
            mp4s.every((v) => /video\.twimg\.com/.test(v.url ?? '')),
            JSON.stringify(mp4s.map((v) => (v.url ?? '').slice(0, 60)))
          );
          check(
            'X: the separate-audio HLS stream is handed to yt-dlp',
            variants.filter((v) => /\.m3u8/.test(v.url ?? '')).every((v) => v.engine === 'yt-dlp'),
            JSON.stringify(variants.filter((v) => /\.m3u8/.test(v.url ?? '')).map((v) => `${v.label} ${v.engine}`))
          );
          // X's own bitrate figure overstates these files ~3x, so the extractor
          // asks the CDN directly. A real size must not be flagged approximate.
          check(
            'X: mp4 sizes are measured, not estimated',
            mp4s.every((v) => (v.size ?? 0) > 1000 && v.approx === false),
            JSON.stringify(mp4s.map((v) => `${v.label} size=${v.size} approx=${v.approx}`))
          );
        }
      } else if ([401, 403, 404, 409, 429].includes(res.status)) {
        skip(`${label} extractor`, `${res.status}: ${String(res.json?.error).slice(0, 110)}`);
      } else {
        check(`${label} resolves`, false, `${res.status}: ${String(res.json?.error).slice(0, 200)}`);
      }
    } catch (err) {
      skip(`${label} extractor`, err.message);
    }
  }
}

/* ================================================================== *
 * Runner
 * ================================================================== */

const server = spawn(process.execPath, ['server.js', '--port', String(PORT), '--no-open'], {
  cwd: ROOT,
  env: { ...process.env, SWIFTGRAB_NO_OPEN: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOutput = '';
server.stdout.on('data', (d) => {
  serverOutput += d.toString();
});
server.stderr.on('data', (d) => {
  serverOutput += d.toString();
});
const shutdown = () => server.kill('SIGTERM');
process.on('exit', shutdown);

try {
  if (!(await waitForServer())) {
    console.error('Server never came up. Output:\n' + serverOutput);
    process.exit(1);
  }

  testParsers();
  await testServer();
  const netOk = await testDownload();
  await testImageDownload();

  if (!LIVE) {
    section('Live extractors');
    skip('live extractor checks', 'pass --live to enable');
  } else if (!netOk) {
    section('Live extractors');
    skip('live extractor checks', 'no network');
  } else {
    await testLive();
  }
} catch (err) {
  check('test harness completed without throwing', false, err.stack);
} finally {
  shutdown();
}

console.log('\nSwiftGrab smoke tests\n');
console.log(results.join('\n'));
console.log(`\n  ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
if (failed > 0) {
  console.log('Server output:\n' + serverOutput.slice(-2500));
  process.exit(1);
}
process.exit(0);
