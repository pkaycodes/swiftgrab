/**
 * Native HLS (m3u8) assembler.
 *
 * Why this exists: a plain HTTP download cannot fetch an adaptive stream, and
 * that used to mean "you need yt-dlp" for anything on Vimeo or any modern
 * site. But most HLS these days is *fragmented MP4*: an init segment holding
 * ftyp+moov followed by media segments holding moof+mdat. Concatenating them
 * in order produces a perfectly valid MP4 that QuickTime, VLC and every
 * browser can play - no ffmpeg, no muxing, no re-encoding.
 *
 * So SwiftGrab assembles those itself. It refuses when:
 *   - the stream is genuinely DRM'd (SAMPLE-AES / FairPlay / Widevine)
 *   - video and audio live in separate renditions (that needs a real muxer)
 *
 * Both cases fall through to yt-dlp, which is the honest answer.
 */

import fsp from 'node:fs/promises';
import { createDecipheriv } from 'node:crypto';
import { fetchSafe } from './http.js';

const SEGMENT_CONCURRENCY = 5;
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * Playlist parsing
 * ------------------------------------------------------------------ */

function attributes(line) {
  const out = {};
  // ATTR=value where value may be quoted and contain commas.
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) {
    out[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return out;
}

function resolveUri(uri, baseUrl) {
  try {
    return new URL(uri, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * @param {string} text
 * @param {string} baseUrl
 * @returns {null | { variants: Array<{uri:string, bandwidth:number|null, width:number|null, height:number|null, codecs:string|null, audioGroup:string|null, name:string|null}> }}
 */
export function parseMasterPlaylist(text, baseUrl) {
  if (!/#EXT-X-STREAM-INF/.test(text)) return null;
  const lines = text.split(/\r?\n/);
  const variants = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const attrs = attributes(lines[i]);
    const nextUri = lines
      .slice(i + 1)
      .find((line) => line.trim() && !line.startsWith('#'));
    if (!nextUri) continue;
    const uri = resolveUri(nextUri.trim(), baseUrl);
    if (!uri) continue;

    const resolution = attrs.RESOLUTION ?? '';
    const [, width, height] = /^(\d+)x(\d+)$/.exec(resolution) ?? [];
    variants.push({
      uri,
      bandwidth: Number(attrs.BANDWIDTH) || Number(attrs['AVERAGE-BANDWIDTH']) || null,
      width: width ? Number(width) : null,
      height: height ? Number(height) : null,
      codecs: attrs.CODECS ?? null,
      audioGroup: attrs.AUDIO ?? null,
      name: attrs.NAME ?? null,
    });
  }

  // Separate audio renditions, if the master declares any.
  const audioGroups = new Set();
  for (const line of lines) {
    if (!line.startsWith('#EXT-X-MEDIA')) continue;
    const attrs = attributes(line);
    if ((attrs.TYPE ?? '').toUpperCase() === 'AUDIO') audioGroups.add(attrs['GROUP-ID'] ?? '');
  }

  for (const variant of variants) {
    variant.separateAudio = Boolean(variant.audioGroup && audioGroups.has(variant.audioGroup));
    // CODECS listing both a video and an audio codec is a strong hint of a
    // muxed rendition; separateAudio overrides it, and the init segment
    // settles the question definitively.
    variant.codecsSuggestMuxed = Boolean(
      variant.codecs && /(avc1|hvc1|hev1|vp0?9|av01)/i.test(variant.codecs) && /(mp4a|opus|ac-3|ec-3)/i.test(variant.codecs)
    );
  }

  return { variants };
}

/**
 * @param {string} text
 * @param {string} baseUrl
 */
export function parseMediaPlaylist(text, baseUrl) {
  if (!text?.includes('#EXTM3U')) {
    const err = new Error('That HLS playlist is empty or malformed.');
    err.status = 502;
    throw err;
  }

  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const segments = [];
  let map = null;
  let encryption = null;
  let totalDuration = 0;
  let isTs = false;
  let mediaSequence = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;

    if (line.startsWith('#EXT-X-MAP')) {
      map = resolveUri(attributes(line).URI ?? '', baseUrl);
    } else if (line.startsWith('#EXT-X-KEY')) {
      const attrs = attributes(line);
      const method = (attrs.METHOD ?? 'NONE').toUpperCase();
      if (method === 'NONE') {
        encryption = null;
      } else if (method === 'AES-128') {
        encryption = {
          method,
          keyUri: resolveUri(attrs.URI ?? '', baseUrl),
          iv: attrs.IV ? Buffer.from(attrs.IV.replace(/^0x/i, ''), 'hex') : null,
          drm: false,
        };
      } else {
        // SAMPLE-AES, SAMPLE-AES-CTR, FairPlay (skd://), Widevine: real DRM.
        encryption = { method, keyUri: attrs.URI ?? null, iv: null, drm: true };
      }
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
      mediaSequence = Number(line.split(':')[1]) || 0;
    } else if (line.startsWith('#EXTINF')) {
      const duration = Number(line.slice(line.indexOf(':') + 1).split(',')[0]) || 0;
      totalDuration += duration;
      const uri = lines.slice(i + 1).find((next) => next && !next.startsWith('#'));
      if (uri) {
        const absolute = resolveUri(uri, baseUrl);
        if (absolute) {
          if (/\.ts(\?|$)/i.test(absolute)) isTs = true;
          segments.push({ uri: absolute, duration, index: segments.length });
        }
      }
    }
  }

  // A playlist with no EXT-X-MAP and non-.ts segments might still be fMP4 with
  // an init segment referenced by .m4s naming; treat the absence of a map as
  // "progressive single file" only if there is exactly one segment.
  const isFmp4 = Boolean(map) || (!isTs && segments.some((s) => /\.(m4s|mp4|cmfv|m4v)(\?|$)/i.test(s.uri)));

  return { map, segments, encryption, totalDuration, isTs, isFmp4, mediaSequence };
}

/* ------------------------------------------------------------------ *
 * ISO-BMFF inspection - how many tracks does the init segment declare?
 * ------------------------------------------------------------------ */

const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'mvex', 'moof', 'traf']);

/** Walk the top level of an ISO-BMFF buffer, invoking `visit(type, start, end)`. */
function walkBoxes(buffer, visit, start = 0, end = buffer.length) {
  let offset = start;
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      size = Number(buffer.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) break;
    if (!visit(type, offset + header, offset + size)) return;
    offset += size;
  }
}

/**
 * Count video and audio tracks in an init segment, and decide whether the
 * samples are actually encrypted.
 *
 * This is the honest way to handle DRM: an `#EXT-X-KEY` tag is not proof.
 * Vimeo's player, for instance, advertises FairPlay on playlists whose bytes
 * are plain fMP4. What *is* proof is the CENC signalling inside `moov` -
 * `pssh` (a DRM system header) or `sinf`/`tenc` (per-track encryption). No
 * such boxes means the samples are clear, whatever the playlist claims.
 *
 * @param {Buffer} init
 * @returns {{ video: number, audio: number, tracks: number, brands: string|null, encrypted: boolean }}
 */
export function inspectInitSegment(init) {
  let moovRange = null;
  let brands = null;

  walkBoxes(init, (type, start, end) => {
    if (type === 'ftyp' || type === 'styp') {
      brands = init.toString('latin1', start, Math.min(start + 4, end));
    }
    if (type === 'moov') {
      moovRange = [start, end];
      return false;
    }
    return true;
  });

  const encrypted = ['pssh', 'sinf', 'tenc', 'senc'].some((box) => init.includes(Buffer.from(box)));

  if (!moovRange) return { video: 0, audio: 0, tracks: 0, brands, encrypted };

  let trakRanges = [];
  walkBoxes(init, (type, start, end) => {
    if (type === 'trak') trakRanges.push([start, end]);
    return true;
  }, moovRange[0], moovRange[1]);

  let video = 0;
  let audio = 0;
  for (const [start, end] of trakRanges) {
    let kind = null;
    const visit = (type, boxStart, boxEnd) => {
      if (type === 'hdlr') {
        // version/flags(4) + predefined(4) + handler_type(4)
        const handler = init.toString('latin1', boxStart + 8, boxStart + 12);
        if (handler === 'vide') kind = 'video';
        else if (handler === 'soun') kind = 'audio';
        return false;
      }
      if (CONTAINER_BOXES.has(type)) {
        walkBoxes(init, visit, boxStart, boxEnd);
      }
      return kind === null;
    };
    walkBoxes(init, visit, start, end);
    if (kind === 'video') video += 1;
    else if (kind === 'audio') audio += 1;
  }

  return { video, audio, tracks: trakRanges.length, brands, encrypted };
}

/* ------------------------------------------------------------------ *
 * Inspection: turn an m3u8 into SwiftGrab variants
 * ------------------------------------------------------------------ */

async function fetchText(url, { headers, signal, label }) {
  const res = await fetchSafe(url, {
    headers,
    signal,
    label,
    timeout: 30_000,
    maxBytes: MAX_PLAYLIST_BYTES,
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${label} responded ${res.status}.`);
    err.status = res.status === 404 ? 404 : 502;
    throw err;
  }
  return text;
}

async function fetchBuffer(url, { headers, signal, label }) {
  const res = await fetchSafe(url, { headers, signal, label, timeout: 60_000 });
  if (!res.ok) {
    const err = new Error(`${label} responded ${res.status}.`);
    err.status = res.status;
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Inspect an HLS manifest and return downloadable variants.
 *
 * Each variant reports `engine: 'hls'` when SwiftGrab can assemble it itself,
 * or `engine: 'yt-dlp'` when the stream is DRM'd or has separate audio tracks.
 *
 * @param {string} masterUrl
 * @param {{ headers?: Record<string,string>, signal?: AbortSignal, label?: string }} [options]
 */
export async function inspect(masterUrl, options = {}) {
  const headers = options.headers ?? {};
  const text = await fetchText(masterUrl, { ...options, headers, label: options.label ?? 'HLS manifest' });
  const master = parseMasterPlaylist(text, masterUrl);

  // Single-rendition manifest: the pasted URL is already the media playlist.
  if (!master) {
    const media = parseMediaPlaylist(text, masterUrl);
    const probe = { muxed: null, encrypted: null, tracks: null };
    if (media.map) {
      try {
        const init = await fetchBuffer(media.map, { ...options, headers, label: 'HLS init segment' });
        const tracks = inspectInitSegment(init);
        probe.tracks = tracks;
        probe.encrypted = tracks.encrypted;
        if (!tracks.encrypted) probe.muxed = tracks.video === 1 && tracks.audio >= 1;
      } catch {
        /* fall back on declarations */
      }
    }
    const rendition = await describeRendition({
      media,
      url: masterUrl,
      headers,
      label: 'HLS stream',
      height: null,
      width: null,
      bandwidth: null,
      codecsSuggestMuxed: true,
      separateAudio: false,
      probe,
    });
    return rendition ? [rendition] : [];
  }

  const sorted = master.variants
    .slice()
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0));

  // Probe once, cheaply, then apply the answer to every rendition: fetch the
  // best rendition's playlist and its init segment (~1 KB). The init tells us
  // the real track layout and whether the samples are actually encrypted,
  // which is what decides native assembly vs yt-dlp.
  const considered = sorted.slice(0, 6);
  const described = [];
  const probe = { muxed: null, encrypted: null, tracks: null };

  for (const variant of considered) {
    let media;
    try {
      const playlistText = await fetchText(variant.uri, { ...options, headers, label: 'HLS rendition' });
      media = parseMediaPlaylist(playlistText, variant.uri);
    } catch {
      continue;
    }

    if (probe.muxed === null && media.map) {
      try {
        const init = await fetchBuffer(media.map, { ...options, headers, label: 'HLS init segment' });
        const tracks = inspectInitSegment(init);
        probe.tracks = tracks;
        probe.encrypted = tracks.encrypted;
        if (!tracks.encrypted) probe.muxed = tracks.video === 1 && tracks.audio >= 1;
      } catch {
        /* leave undecided; the codec hints and audio-group declarations decide */
      }
    }

    const rendition = await describeRendition({
      media,
      url: variant.uri,
      headers,
      label: `${variant.height ?? ''}p`.trim() || 'HLS stream',
      height: variant.height,
      width: variant.width,
      bandwidth: variant.bandwidth,
      codecsSuggestMuxed: variant.codecsSuggestMuxed,
      separateAudio: variant.separateAudio,
      probe,
    });
    if (rendition) described.push(rendition);
  }

  if (!described.length) {
    const err = new Error('No usable rendition found in that HLS manifest.');
    err.status = 404;
    throw err;
  }
  return described;
}

async function describeRendition({ media, url, headers, label, height, width, bandwidth, codecsSuggestMuxed, separateAudio, probe }) {
  if (!media.segments.length) return null;

  const estimate = bandwidth && media.totalDuration ? Math.round((bandwidth / 8) * media.totalDuration) : null;
  const native = canAssemble({ media, codecsSuggestMuxed, separateAudio, probe });
  const ext = media.isTs ? 'ts' : 'mp4';

  const reason = probe.encrypted
    ? 'This stream is DRM-protected (CENC), so only yt-dlp can be tried, and it will likely fail too.'
    : media.encryption?.drm && probe.muxed === null
      ? `The playlist declares ${media.encryption.method} and the segment format hides whether that is real, so SwiftGrab will not guess.`
      : probe.muxed === false
        ? 'Video and audio are separate renditions here, which needs a real muxer - yt-dlp does that.'
        : 'ffmpeg and yt-dlp are needed for this rendition.';

  return {
    id: `hls_${label.replace(/[^a-z0-9]/gi, '')}_${height ?? 'auto'}`,
    label: media.isTs ? `${label} (MPEG-TS)` : label,
    ext,
    // An assembled stream is not a single URL; the engine knows the playlist.
    url: native ? url : null,
    engine: native ? 'hls' : 'yt-dlp',
    kind: 'video',
    quality: height,
    height,
    width: width ?? null,
    bitrate: bandwidth ?? null,
    size: estimate,
    approx: true,
    headers,
    note: native
      ? `Assembled from ${media.segments.length} ${media.isTs ? 'TS' : 'fMP4'} fragments${
          media.encryption?.method === 'AES-128' ? ', AES-128 decrypted' : ''
        }.`
      : reason,
    segmentCount: media.segments.length,
  };
}

/** The single place that decides "can SwiftGrab fetch this itself?". */
function canAssemble({ media, codecsSuggestMuxed, separateAudio, probe }) {
  // Provably encrypted samples: never attempt.
  if (probe.encrypted === true) return false;
  // Provably muxed with clear samples: go.
  if (probe.muxed === true) return true;
  // TS segments cannot be introspected, so a declared DRM scheme is a stop sign.
  if (media.isTs) return !media.encryption?.drm && !separateAudio;
  // fMP4 we could not probe: rely on the master playlist's declarations.
  if (media.encryption?.drm) return false;
  if (probe.muxed === false) return false;
  if (separateAudio) return false;
  return Boolean(codecsSuggestMuxed);
}

/* ------------------------------------------------------------------ *
 * Assembly: write the fragments out as one file
 * ------------------------------------------------------------------ */

/**
 * Download an HLS rendition and write it as a single playable file.
 *
 * Segments are fetched with bounded concurrency but always written in stream
 * order, so the output does not depend on network timing.
 *
 * @param {object} spec
 * @param {string} spec.playlistUrl
 * @param {Record<string,string>} [spec.headers]
 * @param {string} spec.outputPath
 * @param {AbortSignal} [spec.signal]
 * @param {(progress: {received:number, total:number, percent:number}) => void} [spec.onProgress]
 * @returns {Promise<{ bytes: number, segments: number, tracks: object|null }>}
 */
export async function assemble({ playlistUrl, headers = {}, outputPath, signal, onProgress }) {
  const playlistText = await fetchText(playlistUrl, { headers, signal, label: 'HLS manifest' });
  const master = parseMasterPlaylist(playlistText, playlistUrl);

  let media;
  if (master?.variants?.length) {
    const best = master.variants
      .slice()
      .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
    const bestText = await fetchText(best.uri, { headers, signal, label: 'HLS rendition' });
    media = parseMediaPlaylist(bestText, best.uri);
  } else {
    media = parseMediaPlaylist(playlistText, playlistUrl);
  }

  if (!media.segments.length) {
    const err = new Error('That HLS playlist listed no segments.');
    err.status = 502;
    throw err;
  }

  // AES-128 is a plain cipher we can undo ourselves; everything else that
  // claims encryption is either CENC (checked below) or a real DRM system.
  const declaredDrm = Boolean(media.encryption?.drm);

  // AES-128: fetch the key once and decrypt each segment as it arrives.
  let key = null;
  if (media.encryption?.method === 'AES-128' && media.encryption.keyUri) {
    key = await fetchBuffer(media.encryption.keyUri, { headers, signal, label: 'HLS decryption key' });
    if (key.length !== 16) {
      const err = new Error('The HLS decryption key was not 16 bytes.');
      err.status = 502;
      throw err;
    }
  }

  const handle = await fsp.open(outputPath, 'w');
  let bytes = 0;
  let tracks = null;

  try {
    // Init segment first - it defines the tracks and proves whether the
    // samples are encrypted, which settles any DRM claim in the playlist.
    if (media.map) {
      const init = await fetchBuffer(media.map, { headers, signal, label: 'HLS init segment' });
      tracks = inspectInitSegment(init);
      if (tracks.encrypted) {
        const err = new Error('That stream uses CENC DRM and cannot be assembled.');
        err.status = 409;
        err.hint = 'yt-dlp';
        throw err;
      }
      await handle.write(init);
      bytes += init.length;
      onProgress?.({ received: bytes, total: 0, percent: 0 });
    } else if (declaredDrm) {
      // MPEG-TS with no init segment: nothing to inspect, so do not guess.
      const err = new Error(`That stream declares ${media.encryption.method} encryption and cannot be verified as clear.`);
      err.status = 409;
      err.hint = 'yt-dlp';
      throw err;
    }

    const pending = new Map();
    let nextToWrite = 0;
    let nextToFetch = 0;
    let fetched = 0;

    const decrypt = (buffer, index) => {
      if (!key) return buffer;
      const iv =
        media.encryption.iv ??
        (() => {
          const buf = Buffer.alloc(16);
          buf.writeUInt32BE((media.mediaSequence + index) >>> 0, 12);
          return buf;
        })();
      const decipher = createDecipheriv('aes-128-cbc', key, iv);
      decipher.setAutoPadding(false);
      return Buffer.concat([decipher.update(buffer), decipher.final()]);
    };

    const fetchSegment = async (segment) => {
      const buffer = await fetchBuffer(segment.uri, {
        headers,
        signal,
        label: `segment ${segment.index + 1}`,
      });
      return decrypt(buffer, segment.index);
    };

    const progress = (done) => {
      const percent = media.segments.length ? (done / media.segments.length) * 100 : 0;
      onProgress?.({ received: bytes, total: 0, percent: Math.min(99, percent) });
    };

    while (nextToWrite < media.segments.length) {
      // Fill the window.
      while (
        nextToFetch < media.segments.length &&
        pending.size < SEGMENT_CONCURRENCY &&
        nextToFetch < nextToWrite + SEGMENT_CONCURRENCY * 2
      ) {
        const segment = media.segments[nextToFetch];
        const promise = fetchSegment(segment)
          .then((buffer) => ({ index: segment.index, buffer }))
          .catch((err) => ({ index: segment.index, error: err }));
        pending.set(segment.index, promise);
        nextToFetch += 1;
      }

      const settled = await pending.get(nextToWrite);
      pending.delete(nextToWrite);
      if (!settled) break;

      if (settled.error) {
        if (signal?.aborted) {
          const err = new Error('Cancelled.');
          err.status = 499;
          err.cancelled = true;
          throw err;
        }
        throw settled.error;
      }

      if (settled.buffer.length) {
        await handle.write(settled.buffer);
        bytes += settled.buffer.length;
      }
      nextToWrite += 1;
      fetched += 1;
      if (fetched % 4 === 0 || nextToWrite === media.segments.length) progress(fetched);
    }

    if (nextToWrite < media.segments.length) {
      const err = new Error(`Only ${nextToWrite} of ${media.segments.length} HLS segments could be fetched.`);
      err.status = 502;
      throw err;
    }
  } catch (err) {
    await handle.close();
    await fsp.rm(outputPath, { force: true }).catch(() => {});
    throw err;
  } finally {
    await handle.close().catch(() => {});
  }

  onProgress?.({ received: bytes, total: bytes, percent: 100 });
  return { bytes, segments: media.segments.length, tracks };
}
