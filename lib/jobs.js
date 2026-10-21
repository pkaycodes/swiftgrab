/**
 * Download jobs.
 *
 * One place that knows how to turn a resolved Variant into a file on disk,
 * with live progress, cancellation, a small concurrency queue and a retry
 * that resumes from where a flaky connection dropped.
 */

import { createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { UA, fetchSafe } from './http.js';
import * as ytdlp from './ytdlp.js';
import * as hls from './hls.js';
import { buildFilename, formatBytes, sanitizeFilename } from './util.js';

const MAX_CONCURRENT = 3;
const JOB_TTL_MS = 6 * 60 * 60 * 1000; // forget finished jobs after 6 hours
const STALL_TIMEOUT_MS = 45_000;

/** @typedef {{ id:string, url:string, headers:Record<string,string>, filename:string, dest:string, part:string, received:number }} Transfer */

export class JobManager {
  /**
   * @param {object} options
   * @param {string} options.downloadDir  absolute path where finished files land
   * @param {boolean} options.allowPrivate
   */
  constructor({ downloadDir, allowPrivate = false }) {
    this.downloadDir = downloadDir;
    this.allowPrivate = allowPrivate;
    /** @type {Map<string, any>} */
    this.jobs = new Map();
    /** @type {Map<string, () => void>} */
    this.cancellers = new Map();
    this.active = 0;
    this.tick = setInterval(() => this.sweep(), 10 * 60 * 1000);
    this.tick.unref?.();
  }

  dispose() {
    clearInterval(this.tick);
    for (const cancel of this.cancellers.values()) cancel();
    this.cancellers.clear();
  }

  sweep() {
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const [id, job] of this.jobs) {
      if (job.finishedAt && job.finishedAt < cutoff) this.jobs.delete(id);
    }
  }

  /** Build a non-clobbering absolute path inside the download dir. */
  async reservePath(desiredName) {
    await fsp.mkdir(this.downloadDir, { recursive: true });
    // `desiredName` is already a complete filename, extension included. Rebuild
    // it from its stem rather than appending the extension again, or every
    // download lands on disk as "clip.mp4.mp4".
    const raw = String(desiredName ?? '');
    const stem = sanitizeFilename(path.parse(raw).name, 'video');
    const ext = path.extname(raw).replace(/^\./, '') || 'mp4';
    const parsed = path.parse(buildFilename(stem, ext));
    for (let i = 0; i < 500; i += 1) {
      // `parsed.ext` already carries its own dot.
      const candidate = path.join(
        this.downloadDir,
        i === 0 ? parsed.base : `${parsed.name} (${i})${parsed.ext}`
      );
      const exists = await fsp
        .access(candidate)
        .then(() => true)
        .catch(() => false);
      const taken = [...this.jobs.values()].some(
        (job) => job.filePath === candidate || job.destPath === candidate
      );
      if (!exists && !taken) return candidate;
    }
    return path.join(this.downloadDir, `${parsed.name}-${Date.now()}${parsed.ext}`);
  }

  /**
   * Queue a download.
   *
   * @param {object} spec
   * @param {string} spec.title        used for the filename
   * @param {string} spec.url          direct media URL (engine "direct")
   * @param {string} [spec.formatId]   yt-dlp -f expression (engine "yt-dlp")
   * @param {string} spec.engine       "direct" | "yt-dlp"
   * @param {string} spec.ext
   * @param {Record<string,string>} [spec.headers]
   * @param {string} spec.sourceLabel
   * @param {string} spec.pageUrl
   * @param {number|null} spec.expectedSize
   */
  async enqueue(spec) {
    const id = randomUUID();
    const filename = buildFilename(spec.title || 'video', spec.ext || 'mp4');
    const target = await this.reservePath(filename);

    const job = {
      id,
      status: 'queued',
      engine: spec.engine,
      formatId: spec.formatId ?? null,
      url: spec.url ?? null,
      headers: spec.headers ?? {},
      sourceLabel: spec.sourceLabel ?? null,
      pageUrl: spec.pageUrl ?? null,
      filename: path.basename(target),
      filePath: target,
      destPath: target,
      percent: 0,
      received: 0,
      total: spec.expectedSize ?? null,
      speed: null,
      eta: null,
      attempts: 0,
      error: null,
      hint: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      bytesFormatted: formatBytes(spec.expectedSize ?? 0),
    };

    this.jobs.set(id, job);
    this.pump();
    return job;
  }

  /** Start queued jobs while we have capacity. */
  pump() {
    if (this.active >= MAX_CONCURRENT) return;
    const next = [...this.jobs.values()].find((job) => job.status === 'queued');
    if (!next) return;
    this.active += 1;
    this.run(next)
      .catch(() => {})
      .finally(() => {
        this.active -= 1;
        this.pump();
      });
  }

  async run(job) {
    job.status = 'downloading';
    job.startedAt = Date.now();
    job.etaStartedAt = Date.now();

    try {
      if (job.engine === 'yt-dlp') {
        await this.runYtdlp(job);
      } else if (job.engine === 'hls') {
        await this.runHls(job);
      } else {
        await this.runDirect(job);
      }

      if (job.status === 'cancelled') return;
      job.status = 'done';
      job.percent = 100;
      job.speed = null;
      job.eta = null;
      const stat = await fsp.stat(job.filePath).catch(() => null);
      if (stat) {
        job.total = stat.size;
        job.received = stat.size;
        job.bytesFormatted = formatBytes(stat.size);
      }
    } catch (err) {
      if (job.status === 'cancelled' || err?.cancelled) {
        job.status = 'cancelled';
        await fsp.rm(`${job.filePath}.part`, { force: true }).catch(() => {});
      } else {
        job.status = 'error';
        job.error = err?.message ?? 'Download failed.';
        job.hint = err?.hint ?? null;
      }
    } finally {
      job.finishedAt = Date.now();
      this.cancellers.delete(job.id);
    }
  }

  /* ---------------------------------------------------------------- *
   * Direct HTTP transfer
   * ---------------------------------------------------------------- */

  async runDirect(job) {
    const { url, headers } = job;
    const partPath = `${job.filePath}.part`;

    let attempt = 0;
    const maxAttempts = 3;
    let lastError = null;

    while (attempt < maxAttempts) {
      attempt += 1;
      job.attempts = attempt;
      let offset = 0;
      try {
        const existing = await fsp.stat(partPath).catch(() => null);
        offset = existing?.size ?? 0;
      } catch {
        offset = 0;
      }

      try {
        await this.transferOnce(job, { url, headers, partPath, offset });
        await fsp.rename(partPath, job.filePath);
        return;
      } catch (err) {
        if (job.status === 'cancelled' || err?.cancelled) throw err;
        lastError = err;
        // A 4xx (other than a range failure) will not fix itself.
        if (err?.status && err.status >= 400 && err.status < 500 && err.status !== 416) throw err;
        if (attempt < maxAttempts) {
          const backoff = 800 * attempt;
          await new Promise((resolve) => setTimeout(resolve, backoff));
        }
      }
    }

    await fsp.rm(partPath, { force: true }).catch(() => {});
    throw lastError ?? new Error('Download failed.');
  }

  async transferOnce(job, { url, headers, partPath, offset }) {
    const requestHeaders = {
      'user-agent': headers['user-agent'] ?? UA.desktop,
      accept: '*/*',
      ...headers,
      ...(offset > 0 ? { range: `bytes=${offset}-` } : {}),
    };
    // The CDN needs the referer, but a lowercase/uppercase mix confuses some
    // servers, so normalise the header names we care about.
    delete requestHeaders['User-Agent'];
    delete requestHeaders['Referer'];

    const controller = new AbortController();
    let cancelHandler = () => {
      controller.abort();
    };
    this.cancellers.set(job.id, cancelHandler);
    job.cancel = cancelHandler;

    // Guard against a connection that opens and then goes silent forever.
    let stallTimer = null;
    const armStallTimer = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => controller.abort(new Error('stalled')), STALL_TIMEOUT_MS);
    };
    armStallTimer();

    try {
      const res = await fetchSafe(url, {
        allowPrivate: this.allowPrivate,
        signal: controller.signal,
        label: 'media download',
        headers: requestHeaders,
        timeout: 60_000,
      });

      if (!res.ok && res.status !== 206) {
        const err = new Error(
          res.status === 403 || res.status === 401
            ? `The CDN refused the download (${res.status}). The link has probably expired - resolve the post again.`
            : `The server answered ${res.status} ${res.statusText} for the media file.`
        );
        err.status = res.status;
        if (res.status === 416 && offset > 0) {
          // Our .part file is longer than the remote file: start clean.
          await fsp.rm(partPath, { force: true }).catch(() => {});
        }
        throw err;
      }

      const resumed = offset > 0 && res.status === 206;
      if (offset > 0 && !resumed) offset = 0;

      const contentLength = Number(res.headers.get('content-length')) || 0;
      if (contentLength) {
        job.total = contentLength + offset;
        job.bytesFormatted = formatBytes(job.total);
      }

      job.received = offset;
      let windowBytes = 0;
      let windowStart = Date.now();

      const source = Readable.fromWeb(res.body);
      source.on('data', (chunk) => {
        job.received += chunk.length;
        windowBytes += chunk.length;
        armStallTimer();

        const elapsed = (Date.now() - windowStart) / 1000;
        if (elapsed >= 0.5) {
          const instant = windowBytes / elapsed;
          // Exponential moving average keeps the readout from jumping around.
          job.speed = job.speed ? job.speed * 0.6 + instant * 0.4 : instant;
          windowBytes = 0;
          windowStart = Date.now();
        }

        if (job.total) {
          job.percent = Math.min(99.9, (job.received / job.total) * 100);
          job.eta = job.speed > 1 ? (job.total - job.received) / job.speed : null;
        }
      });

      const sink = createWriteStream(partPath, { flags: resumed ? 'a' : 'w' });
      await pipeline(source, sink);
      job.percent = 100;
    } catch (err) {
      controller.abort();
      if (job.status === 'cancelled') {
        const cancelled = new Error('Cancelled.');
        cancelled.cancelled = true;
        cancelled.status = 499;
        throw cancelled;
      }
      if (err?.name === 'AbortError' || /aborted|stalled/i.test(err?.message ?? '')) {
        const timeout = new Error('The connection stalled and was cut off.');
        timeout.status = 504;
        throw timeout;
      }
      throw err;
    } finally {
      clearTimeout(stallTimer);
    }
  }

  /* ---------------------------------------------------------------- *
   * HLS assembly
   * ---------------------------------------------------------------- */

  async runHls(job) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    this.cancellers.set(job.id, cancel);
    job.cancel = cancel;

    const partPath = `${job.filePath}.part`;
    const started = Date.now();

    try {
      const result = await hls.assemble({
        playlistUrl: job.url,
        headers: job.headers,
        outputPath: partPath,
        signal: controller.signal,
        onProgress: (progress) => {
          job.received = progress.received;
          job.percent = progress.percent;
          const elapsed = (Date.now() - started) / 1000;
          if (elapsed > 1.5 && progress.received) job.speed = progress.received / elapsed;
          if (job.total) job.percent = Math.min(99, (job.received / job.total) * 100);
        },
      });

      if (controller.signal.aborted) {
        const err = new Error('Cancelled.');
        err.status = 499;
        err.cancelled = true;
        throw err;
      }

      await fsp.rename(partPath, job.filePath);
      job.received = result.bytes;
      job.total = result.bytes;
      job.bytesFormatted = formatBytes(result.bytes);
      job.segments = result.segments;
      job.percent = 100;

      if (result.tracks && result.tracks.video === 1 && result.tracks.audio === 0) {
        job.error = null;
        job.warning = 'This rendition has no audio track - the source stream keeps audio separate.';
      }
    } catch (err) {
      await fsp.rm(partPath, { force: true }).catch(() => {});
      throw err;
    }
  }

  /* ---------------------------------------------------------------- *
   * yt-dlp transfer
   * ---------------------------------------------------------------- */

  async runYtdlp(job) {
    // yt-dlp decides the extension, so hand it a base path without one.
    const parsed = path.parse(job.filePath);
    const outputBase = path.join(parsed.dir, parsed.name);
    job.filePath = outputBase;

    const handle = ytdlp.download({
      url: job.url ?? job.pageUrl,
      formatId: job.formatId,
      outputBase,
      outputDir: parsed.dir,
      onProgress: (progress) => {
        job.received = progress.received;
        if (progress.total) job.total = progress.total;
        job.percent = progress.percent;
        job.speed = progress.speed;
        job.eta = progress.eta;
        if (progress.total) job.bytesFormatted = formatBytes(progress.total);
        job.status = progress.percent >= 100 ? 'processing' : 'downloading';
      },
    });

    this.cancellers.set(job.id, handle.cancel);
    job.cancel = handle.cancel;

    const finalPath = await handle.promise;
    // The real file may have a different extension than we guessed.
    const stat = await fsp.stat(finalPath);
    job.filePath = finalPath;
    job.filename = path.basename(finalPath);
    job.total = stat.size;
    job.received = stat.size;
    job.percent = 100;
    job.status = 'downloading';
  }

  /* ---------------------------------------------------------------- *
   * Introspection
   * ---------------------------------------------------------------- */

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.finishedAt = Date.now();
      return true;
    }
    if (job.status === 'downloading' || job.status === 'processing') {
      job.status = 'cancelled';
      job.cancel?.();
      return true;
    }
    return false;
  }

  get(id) {
    return this.jobs.get(id) ?? null;
  }

  list() {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Remove a finished job and (optionally) its file. */
  async remove(id, { deleteFile = false } = {}) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === 'downloading' || job.status === 'processing') this.cancel(id);
    if (deleteFile && job.filePath) {
      const name = path.basename(job.filePath);
      await fsp.rm(path.join(this.downloadDir, name), { force: true }).catch(() => {});
      await fsp.rm(`${job.filePath}.part`, { force: true }).catch(() => {});
    }
    this.jobs.delete(id);
    return true;
  }

  /** Everything currently sitting in the download folder. */
  async library() {
    const entries = await fsp
      .readdir(this.downloadDir, { withFileTypes: true })
      .catch(() => /** @type {any} */ ([]));
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      const full = path.join(this.downloadDir, entry.name);
      const stat = await fsp.stat(full).catch(() => null);
      if (!stat) continue;
      files.push({
        name: entry.name,
        path: full,
        size: stat.size,
        sizeFormatted: formatBytes(stat.size),
        modified: stat.mtimeMs,
        partial: /\.(part|ytdl|temp)$/i.test(entry.name),
      });
    }
    return files.sort((a, b) => b.modified - a.modified);
  }
}
