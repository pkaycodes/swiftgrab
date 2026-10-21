/**
 * yt-dlp fallback engine.
 *
 * Used for two things:
 *   1. Sites with no native extractor (YouTube, Twitch, SoundCloud, ...).
 *   2. Retrieving adaptive streams (m3u8 / DASH) that a plain HTTP download
 *      cannot reassemble.
 *
 * yt-dlp is optional. If it is missing we can fetch the standalone macOS
 * binary directly from GitHub - no Homebrew needed - which is why this module
 * owns an installer too.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSafe } from './http.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TOOLS_DIR = path.resolve(__dirname, '..', 'tools');
const LOCAL_BINARY = path.join(TOOLS_DIR, 'yt-dlp');
const DOWNLOAD_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';

/** @type {{ kind: 'path'|'local'|'python', bin: string, version: string }|null|undefined} */
let cached = undefined;
let installing = null;

function tryRun(command, args, timeout = 15_000) {
  try {
    const out = spawnSync(command, args, { encoding: 'utf8', timeout });
    return out.status === 0 ? out.stdout.trim().split('\n')[0] : null;
  } catch {
    return null;
  }
}

/** Where is yt-dlp, and does it actually run? Memoised. */
export async function detect(force = false) {
  if (cached !== undefined && !force) return cached;

  // 1. Bundled binary inside ./tools (what our installer writes).
  if (fs.existsSync(LOCAL_BINARY)) {
    const version = tryRun(LOCAL_BINARY, ['--version']);
    if (version) {
      cached = { kind: 'local', bin: LOCAL_BINARY, version };
      return cached;
    }
  }

  // 2. Anything on PATH.
  const onPath = tryRun('yt-dlp', ['--version']) ? 'yt-dlp' : tryRun('yt-dlp', ['--version'], 15_000) ?? null;
  if (onPath) {
    cached = { kind: 'path', bin: 'yt-dlp', version: onPath };
    return cached;
  }

  // 3. pip-installed module.
  const pythonCandidates = ['python3', 'python'];
  for (const python of pythonCandidates) {
    const version = tryRun(python, ['-m', 'yt_dlp', '--version']);
    if (version) {
      cached = { kind: 'python', bin: python, version };
      return cached;
    }
  }

  cached = null;
  return cached;
}

export async function status() {
  const found = await detect(true);
  return {
    installed: Boolean(found),
    version: found?.version ?? null,
    kind: found?.kind ?? null,
    path: found?.kind === 'local' ? LOCAL_BINARY : found?.bin ?? null,
    installing: Boolean(installing),
  };
}

/** Is ffmpeg reachable? Without it yt-dlp cannot merge separate tracks. */
export function hasFfmpeg() {
  return Boolean(tryRun('ffmpeg', ['-version']));
}

/** Build the argv for a call, honouring how yt-dlp was found. */
function argvFor(found, args) {
  if (found.kind === 'python') return [found.bin, ['-m', 'yt_dlp', ...args]];
  return [found.bin, args];
}

/**
 * Download the standalone yt-dlp binary into ./tools.
 * @param {(percent: number, received: number, total: number) => void} [onProgress]
 */
export function install(onProgress = () => {}) {
  if (installing) return installing;

  installing = (async () => {
    await fsp.mkdir(TOOLS_DIR, { recursive: true });
    const tmp = `${LOCAL_BINARY}.download`;

    const res = await fetchSafe(DOWNLOAD_URL, {
      headers: { 'user-agent': 'SwiftGrab/1.0', accept: 'application/octet-stream' },
      timeout: 180_000,
      label: 'yt-dlp download',
    });
    if (!res.ok) {
      throw new Error(`GitHub returned ${res.status} while downloading yt-dlp.`);
    }

    const total = Number(res.headers.get('content-length')) || 0;
    let received = 0;
    const handle = await fsp.open(tmp, 'w');
    try {
      for await (const chunk of res.body) {
        await handle.write(chunk);
        received += chunk.length;
        onProgress(total ? Math.min(100, (received / total) * 100) : 0, received, total);
      }
    } finally {
      await handle.close();
    }

    if (received < 1_000_000) {
      await fsp.rm(tmp, { force: true });
      throw new Error('The downloaded yt-dlp binary looks truncated - aborting.');
    }

    await fsp.chmod(tmp, 0o755);
    await fsp.rename(tmp, LOCAL_BINARY);

    const found = await detect(true);
    if (!found) {
      throw new Error('yt-dlp was downloaded but will not run. Your macOS version may require a newer build.');
    }
    onProgress(100, received, total || received);
    return found;
  })();

  installing.catch(() => {}).finally(() => {
    installing = null;
  });

  return installing;
}

/** Common flags for every invocation. */
function baseArgs() {
  const args = ['--no-playlist', '--no-warnings', '--no-simulate', '--newline', '--no-color'];
  const extra = process.env.SWIFTGRAB_YTDLP_ARGS?.trim();
  if (extra) args.push(...extra.split(/\s+/));
  return args;
}

/**
 * Ask yt-dlp for the metadata + format list of a URL.
 * @returns {Promise<any>} the parsed -J payload
 */
export async function listFormats(url, { allowPrivate = false, timeout = 90_000 } = {}) {
  const found = await detect();
  if (!found) {
    const err = new Error('yt-dlp is not installed.');
    err.status = 409;
    err.hint = 'yt-dlp';
    throw err;
  }

  const [bin, args] = argvFor(found, [...baseArgs(), '-J', '--no-download', url]);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      const err = new Error('yt-dlp timed out while inspecting that link.');
      err.status = 504;
      reject(err);
    }, timeout);

    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      const wrapped = new Error(`Could not run yt-dlp: ${err.message}`);
      wrapped.status = 500;
      reject(wrapped);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const err = new Error(`yt-dlp could not handle that link: ${summariseYtdlpError(stderr)}`);
        err.status = 502;
        err.hint = 'yt-dlp';
        reject(err);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        const err = new Error('yt-dlp returned output SwiftGrab could not read as JSON.');
        err.status = 502;
        reject(err);
      }
    });
    void allowPrivate;
  });
}

/** Pull the most useful ERROR line out of yt-dlp's chatter. */
export function summariseYtdlpError(stderr) {
  const lines = String(stderr)
    .split('\n')
    .map((l) => l.replace(/^ERROR:\s*/i, '').trim())
    .filter(Boolean);
  const useful =
    lines.find((l) => /ERROR/i.test(l)) ??
    lines.find((l) => /unsupported url/i.test(l)) ??
    lines[lines.length - 1] ??
    'unknown error';
  return useful.replace(/;\s*please report this issue.*$/i, '').slice(0, 300);
}

/**
 * Map yt-dlp's format list onto SwiftGrab's Variant shape.
 * @param {any} info the -J payload
 */
export function variantsFromInfo(info) {
  const found = cached ?? { kind: 'local' };
  const canMerge = hasFfmpeg();
  const formats = Array.isArray(info?.formats) ? info.formats : [];
  const variants = [];
  const duration = Number(info?.duration) || null;

  const heightOf = (f) => Number(f?.height) || null;
  const sizeOf = (f) => Number(f?.filesize) || Number(f?.filesize_approx) || null;

  // 1. The single "just get me the best one" option.
  variants.push({
    id: 'best',
    label: canMerge ? 'Best quality (video + audio)' : 'Best pre-muxed quality',
    ext: 'mp4',
    url: null,
    engine: 'yt-dlp',
    formatId: canMerge ? 'bv*+ba/b' : 'b[ext=mp4]/b',
    kind: 'video',
    quality: (heightOf(formats.reduce((a, b) => ((b?.height ?? 0) > (a?.height ?? 0) ? b : a), {})) ?? 0) + 10,
    height: heightOf(formats.reduce((a, b) => ((b?.height ?? 0) > (a?.height ?? 0) ? b : a), {})),
    size: null,
    approx: true,
    note: canMerge
      ? 'yt-dlp downloads the best video and audio tracks separately and muxes them.'
      : 'ffmpeg is not installed, so only pre-muxed formats can be fetched.',
  });

  // 2. Each real video rendition yt-dlp found.
  const videoFormats = formats
    .filter((f) => f && f.vcodec && f.vcodec !== 'none' && !/^(mhtml|storyboard)/i.test(String(f.format_note ?? '')))
    .sort((a, b) => (heightOf(b) ?? 0) - (heightOf(a) ?? 0) || (Number(b.tbr) || 0) - (Number(a.tbr) || 0));

  const seenHeights = new Set();
  for (const f of videoFormats) {
    const height = heightOf(f);
    const key = `${height ?? f.format_id}|${f.ext}`;
    // Keep at most two entries per resolution - best and a fallback codec.
    const perHeight = [...seenHeights].filter((k) => k.startsWith(`${height}|`)).length;
    if (height && perHeight >= 2) continue;
    seenHeights.add(key);

    const hasAudio = f.acodec && f.acodec !== 'none';
    const needsMerge = !hasAudio;
    if (needsMerge && !canMerge) continue;

    variants.push({
      id: `f_${f.format_id}`,
      label: `${height ? `${height}p` : (f.format_note || f.format_id)}${hasAudio ? '' : ' (video only)'}`,
      ext: f.ext ?? 'mp4',
      url: null,
      engine: 'yt-dlp',
      formatId: needsMerge ? `${f.format_id}+ba/b` : f.format_id,
      kind: 'video',
      quality: height,
      height,
      width: Number(f.width) || null,
      fps: Number(f.fps) || null,
      bitrate: Number(f.tbr) ? Math.round(Number(f.tbr) * 1000) : null,
      size: sizeOf(f) ?? (Number(f.tbr) && duration ? Math.round((Number(f.tbr) * 1000 * duration) / 8) : null),
      approx: !f.filesize,
      note: needsMerge && canMerge ? 'Video and audio will be muxed with ffmpeg.' : undefined,
    });
  }

  // 3. Audio-only.
  const audioFormats = formats
    .filter((f) => f && f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
    .sort((a, b) => (Number(b.abr) || Number(b.tbr) || 0) - (Number(a.abr) || Number(a.tbr) || 0));
  if (audioFormats.length) {
    const best = audioFormats[0];
    const abr = Number(best.abr) ? Math.round(Number(best.abr) * 1000) : Number(best.tbr) ? Math.round(Number(best.tbr) * 1000) : null;
    variants.push({
      id: 'audio',
      label: 'Audio only',
      ext: canMerge ? 'mp3' : best.ext ?? 'm4a',
      url: null,
      engine: 'yt-dlp',
      formatId: canMerge ? 'ba/b' : best.format_id,
      kind: 'audio',
      bitrate: abr,
      size: sizeOf(best),
      approx: !best.filesize,
      note: canMerge ? undefined : 'Saved in the source audio container because ffmpeg is not installed.',
    });
  }

  void found;
  return { variants, duration };
}

/**
 * Run an actual download.
 *
 * @param {object} job
 * @param {string} job.url
 * @param {string} job.formatId      yt-dlp -f expression, or null
 * @param {string} job.outputBase    absolute path without extension
 * @param {string} job.outputDir
 * @param {(progress: {percent:number, received:number, total:number, speed:number|null, eta:number|null}) => void} onProgress
 * @param {(filePath: string) => void} onOutputPath
 * @returns {{ promise: Promise<string>, cancel: () => void }} resolves with the final file path
 */
export function download({ url, formatId, outputBase, outputDir, headers = {}, onProgress, onOutputPath }) {
  const childRef = { child: null, cancelled: false };

  const promise = (async () => {
    const found = await detect();
    if (!found) {
      const err = new Error('yt-dlp is not installed.');
      err.status = 409;
      err.hint = 'yt-dlp';
      throw err;
    }

    await fsp.mkdir(outputDir, { recursive: true });
    const canMerge = hasFfmpeg();
    const format = formatId || (canMerge ? 'bv*+ba/b' : 'b[ext=mp4]/b');

    const args = [
      ...baseArgs(),
      '-f',
      format,
      '--no-part',
      '--retries',
      '5',
      '--fragment-retries',
      '5',
      '-o',
      `${outputBase}.%(ext)s`,
      '--progress-template',
      'download:@@SWIFTGRAB@@%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
    ];
    if (canMerge) args.push('--merge-output-format', 'mp4');
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === 'referer') args.push('--referer', value);
      else if (key.toLowerCase() === 'user-agent') args.push('--user-agent', value);
    }
    args.push(url);

    const [bin, finalArgs] = argvFor(found, args);

    await new Promise((resolve, reject) => {
      const child = spawn(bin, finalArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      childRef.child = child;
      let stderr = '';
      let buffer = '';

      const handleLine = (line) => {
        if (line.includes('@@SWIFTGRAB@@')) {
          const payload = line.slice(line.indexOf('@@SWIFTGRAB@@') + '@@SWIFTGRAB@@'.length);
          const [downloaded, total, estimate, speed, eta] = payload.split('|');
          const received = Number(downloaded) || 0;
          const bytes = Number(total) || Number(estimate) || 0;
          onProgress?.({
            received,
            total: bytes,
            percent: bytes ? Math.min(100, (received / bytes) * 100) : 0,
            speed: Number(speed) || null,
            eta: Number(eta) || null,
          });
          return;
        }
        const destination = /\[(?:download|Merger|ExtractAudio|ffmpeg)\][^"]*(?:Destination|into):\s*"?([^"\n]+)"?/.exec(line);
        if (destination) onOutputPath?.(destination[1].trim());
      };

      child.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) handleLine(line);
      });
      child.stderr.on('data', (data) => {
        stderr += data.toString();
        if (stderr.length > 40_000) stderr = stderr.slice(-20_000);
      });
      child.on('error', (err) => {
        const wrapped = new Error(`Could not run yt-dlp: ${err.message}`);
        wrapped.status = 500;
        reject(wrapped);
      });
      child.on('close', (code) => {
        if (buffer.trim()) handleLine(buffer);
        if (childRef.cancelled) {
          const err = new Error('Cancelled.');
          err.status = 499;
          err.cancelled = true;
          reject(err);
          return;
        }
        if (code !== 0) {
          const err = new Error(`yt-dlp failed: ${summariseYtdlpError(stderr)}`);
          err.status = 502;
          err.hint = 'yt-dlp';
          reject(err);
          return;
        }
        resolve();
      });
    });

    // yt-dlp decides the final extension, so find what it actually wrote.
    const base = path.basename(outputBase);
    const entries = await fsp.readdir(outputDir);
    const matches = entries
      .filter((name) => name.startsWith(base) && !/\.(part|ytdl|temp)$/i.test(name))
      .filter((name) => !/\.f\d+\./.test(name))
      .map((name) => ({ name, full: path.join(outputDir, name) }));

    let best = null;
    for (const match of matches) {
      const stat = await fsp.stat(match.full).catch(() => null);
      if (!stat?.isFile() || stat.size === 0) continue;
      if (!best || stat.mtimeMs > best.mtimeMs) best = { ...match, mtimeMs: stat.mtimeMs, size: stat.size };
    }

    // Tidy up any fragment files yt-dlp left behind.
    for (const entry of entries) {
      if (/\.(part|ytdl|temp)$/i.test(entry) || (entry.startsWith(base) && /\.f\d+\./.test(entry))) {
        await fsp.rm(path.join(outputDir, entry), { force: true }).catch(() => {});
      }
    }

    if (!best) {
      const err = new Error('yt-dlp reported success but no output file was found.');
      err.status = 500;
      throw err;
    }
    return best.full;
  })();

  return {
    promise,
    cancel() {
      childRef.cancelled = true;
      childRef.child?.kill('SIGTERM');
      setTimeout(() => childRef.child?.kill('SIGKILL'), 3000).unref?.();
    },
  };
}
