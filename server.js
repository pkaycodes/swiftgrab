#!/usr/bin/env node
/**
 * SwiftGrab server.
 *
 * Zero dependencies - everything here is Node's standard library plus the
 * built-in fetch. Run `node server.js` and open the printed URL.
 *
 *   node server.js                 bind to 127.0.0.1:8787 (this machine only)
 *   node server.js --lan           bind to 0.0.0.0 so your phone can use it
 *   node server.js --port 9000
 *   node server.js --allow-private let it fetch localhost/private addresses
 *   node server.js --no-open       do not open a browser window
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { networkInterfaces } from 'node:os';

import { toHttpError } from './lib/http.js';
import { resolveUrl, supportedSites } from './lib/resolve.js';
import { JobManager } from './lib/jobs.js';
import * as ytdlp from './lib/ytdlp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = Number(value('port', process.env.PORT ?? 8787));
const ON_RENDER = Boolean(process.env.RENDER);
const HOST = process.env.SWIFTGRAB_HOST
  ? process.env.SWIFTGRAB_HOST
  : (flag('lan') || ON_RENDER ? '0.0.0.0' : '127.0.0.1');
const ALLOW_PRIVATE = flag('allow-private');
const OPEN_BROWSER = !flag('no-open') && !ON_RENDER;

const jobs = new JobManager({ downloadDir: DOWNLOAD_DIR, allowPrivate: ALLOW_PRIVATE });

/** Live progress of an in-flight yt-dlp install, polled by the UI. */
let installState = null;

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(res, err) {
  const { message, status } = toHttpError(err);
  sendJson(res, status, {
    error: message,
    hint: err?.hint ?? null,
    attempts: Array.isArray(err?.attempts) ? err.attempts : undefined,
  });
}

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      const err = new Error('Request body too large.');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('Request body was not valid JSON.');
    err.status = 400;
    throw err;
  }
}

/** Content-Disposition that survives non-ASCII titles. */
function contentDisposition(filename, mode) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${mode}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Serve a file with byte-range support, so a downloaded clip can also be
 * previewed straight in the browser.
 */
async function serveFile(req, res, filePath, { download = false, inlineName = null } = {}) {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    sendJson(res, 404, { error: 'That file is no longer on disk.' });
    return;
  }

  const name = inlineName ?? path.basename(filePath);
  const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  const headers = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=0, must-revalidate',
    'content-disposition': contentDisposition(name, download ? 'attachment' : 'inline'),
  };

  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      let start = match[1] ? Number(match[1]) : 0;
      let end = match[2] ? Number(match[2]) : stat.size - 1;
      if (!match[1] && match[2]) {
        start = Math.max(0, stat.size - Number(match[2]));
        end = stat.size - 1;
      }
      if (start >= stat.size || end >= stat.size || start > end) {
        res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        ...headers,
        'content-range': `bytes ${start}-${end}/${stat.size}`,
        'content-length': end - start + 1,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }

  res.writeHead(200, { ...headers, 'content-length': stat.size });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

/** Only ever resolve inside a base directory. */
function safeJoin(base, candidate) {
  const resolved = path.resolve(base, candidate);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

/* ------------------------------------------------------------------ *
 * Resolve cache - lets the client download a variant without re-resolving
 * ------------------------------------------------------------------ */

const RESOLVE_TTL = 20 * 60 * 1000;
const resolveCache = new Map();

function cacheResolved(entry) {
  const rid = Math.random().toString(36).slice(2, 12);
  resolveCache.set(rid, { ...entry, createdAt: Date.now() });
  if (resolveCache.size > 200) {
    const oldest = [...resolveCache.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (oldest) resolveCache.delete(oldest[0]);
  }
  return rid;
}

function readCached(rid) {
  const entry = resolveCache.get(rid);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > RESOLVE_TTL) {
    resolveCache.delete(rid);
    return null;
  }
  return entry;
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

const routes = [];
const route = (method, pattern, handler) => {
  routes.push({ method, pattern, handler });
};

route('GET', /^\/api\/health$/, async (_req, res) => {
  const [tools] = await Promise.all([ytdlp.status()]);
  sendJson(res, 200, {
    ok: true,
    version: '1.0.0',
    ytdlp: tools,
    ffmpeg: ytdlp.hasFfmpeg(),
    downloadDir: DOWNLOAD_DIR,
    allowPrivate: ALLOW_PRIVATE,
    sites: supportedSites(),
  });
});

route('POST', /^\/api\/resolve$/, async (req, res) => {
  const body = await readJsonBody(req);
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) {
    sendJson(res, 400, { error: 'Paste a video link first.' });
    return;
  }

  // Accept "no scheme" pastes like "x.com/user/status/123", but reject any
  // other scheme outright rather than mangling it into something fetchable.
  let normalised;
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  if (schemeMatch && !schemeMatch[1].includes('.')) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      sendJson(res, 400, { error: `Only http and https links work - that one uses "${scheme}:".` });
      return;
    }
    normalised = url;
  } else {
    normalised = `https://${url.replace(/^\/+/, '')}`;
  }

  const started = Date.now();
  const trace = [];
  const { result, engine, hosts } = await resolveUrl(normalised, {
    allowPrivate: ALLOW_PRIVATE,
    forceEngine: body.forceEngine === 'ytdlp' ? 'ytdlp' : null,
    onTrace: (step) => trace.push(step),
  });

  const rid = cacheResolved({ result, engine, url: normalised });
  sendJson(res, 200, {
    rid,
    engine,
    attempts: hosts,
    trace,
    elapsedMs: Date.now() - started,
    result,
  });
});

route('POST', /^\/api\/jobs$/, async (req, res) => {
  const body = await readJsonBody(req);
  const cached = readCached(body.rid);
  if (!cached) {
    sendJson(res, 410, { error: 'That link expired. Resolve it again and retry the download.' });
    return;
  }

  const variants = cached.result.variants ?? [];
  const variant = body.variantId
    ? variants.find((v) => v.id === body.variantId)
    : variants[0];
  if (!variant) {
    sendJson(res, 404, { error: 'That quality is no longer available. Resolve the link again.' });
    return;
  }

  const job = await jobs.enqueue({
    title: `${cached.result.title ?? 'video'}${variant.kind === 'audio' ? ' (audio)' : ''}`,
    url: variant.url ?? cached.result.pageUrl ?? cached.url,
    formatId: variant.formatId ?? null,
    engine: variant.engine ?? 'direct',
    ext: variant.ext ?? 'mp4',
    headers: variant.headers ?? {},
    sourceLabel: cached.result.sourceLabel,
    pageUrl: cached.result.pageUrl ?? cached.url,
    expectedSize: variant.size ?? null,
  });

  sendJson(res, 201, serializeJob(job));
});

route('GET', /^\/api\/jobs$/, async (_req, res) => {
  sendJson(res, 200, { jobs: jobs.list().map(serializeJob) });
});

route('POST', /^\/api\/jobs\/([\w-]+)\/cancel$/, async (_req, res, params) => {
  const ok = jobs.cancel(params[0]);
  sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'That job is already finished.' });
});

route('DELETE', /^\/api\/jobs\/([\w-]+)$/, async (req, res, params) => {
  const url = new URL(req.url, 'http://localhost');
  const ok = await jobs.remove(params[0], { deleteFile: url.searchParams.get('file') === '1' });
  sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'No such job.' });
});

route('GET', /^\/api\/jobs\/([\w-]+)\/file$/, async (req, res, params) => {
  const job = jobs.get(params[0]);
  if (!job || job.status !== 'done' || !job.filePath) {
    sendJson(res, 404, { error: 'That download is not ready yet.' });
    return;
  }
  const download = new URL(req.url, 'http://localhost').searchParams.get('download') === '1';
  await serveFile(req, res, job.filePath, { download, inlineName: job.filename });
});

route('GET', /^\/api\/library$/, async (_req, res) => {
  sendJson(res, 200, { dir: DOWNLOAD_DIR, files: await jobs.library() });
});

route('GET', /^\/api\/library\/file$/, async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const name = url.searchParams.get('name');
  const filePath = name ? safeJoin(DOWNLOAD_DIR, path.basename(name)) : null;
  if (!filePath) {
    sendJson(res, 400, { error: 'A file name is required.' });
    return;
  }
  await serveFile(req, res, filePath, { download: url.searchParams.get('download') === '1' });
});

route('DELETE', /^\/api\/library$/, async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const name = url.searchParams.get('name');
  const filePath = name ? safeJoin(DOWNLOAD_DIR, path.basename(name)) : null;
  if (!filePath) {
    sendJson(res, 400, { error: 'A file name is required.' });
    return;
  }
  await fsp.rm(filePath, { force: true });
  sendJson(res, 200, { ok: true });
});

route('POST', /^\/api\/reveal$/, async (req, res) => {
  const body = await readJsonBody(req);
  const name = typeof body.name === 'string' ? path.basename(body.name) : null;
  const filePath = name ? safeJoin(DOWNLOAD_DIR, name) : DOWNLOAD_DIR;
  if (!filePath) {
    sendJson(res, 400, { error: 'Bad path.' });
    return;
  }
  if (process.platform !== 'darwin') {
    sendJson(res, 501, { error: 'Reveal in Finder only works on macOS. The folder is ' + DOWNLOAD_DIR });
    return;
  }
  execFile('open', ['-R', filePath], (err) => {
    if (err) sendJson(res, 500, { error: `Could not open Finder: ${err.message}` });
    else sendJson(res, 200, { ok: true, path: filePath });
  });
});

route('POST', /^\/api\/tools\/install-ytdlp$/, async (_req, res) => {
  let progress = { percent: 0, received: 0, total: 0, error: null, done: false };
  installState = progress;
  ytdlp
    .install((percent, received, total) => {
      Object.assign(progress, { percent, received, total });
    })
    .then((found) => {
      Object.assign(progress, { percent: 100, done: true });
      installState = null;
      void found;
    })
    .catch((err) => {
      Object.assign(progress, { error: err.message, done: true });
      installState = null;
    });
  sendJson(res, 202, { started: true });
});

route('GET', /^\/api\/tools\/status$/, async (_req, res) => {
  const tools = await ytdlp.status();
  sendJson(res, 200, { ...tools, ffmpeg: ytdlp.hasFfmpeg(), progress: installState });
});

/* ------------------------------------------------------------------ *
 * Static files
 * ------------------------------------------------------------------ */

const STATIC = new Set(['/', '/index.html', '/app.js', '/styles.css', '/favicon.svg', '/manifest.webmanifest']);

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (!STATIC.has(url.pathname)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const filePath = safeJoin(PUBLIC_DIR, relative);
  if (!filePath) {
    res.writeHead(400).end('Bad path');
    return;
  }
  const body = await fsp.readFile(filePath).catch(() => null);
  if (!body) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(body);
}

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');

  if (url.pathname.startsWith('/api/')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { allow: 'GET,POST,DELETE,OPTIONS' }).end();
      return;
    }
    for (const entry of routes) {
      if (entry.method !== req.method) continue;
      const match = entry.pattern.exec(url.pathname);
      if (!match) continue;
      try {
        await entry.handler(req, res, match.slice(1));
      } catch (err) {
        if (!res.headersSent) sendError(res, err);
        else res.end();
      }
      return;
    }
    sendJson(res, 404, { error: `No API route for ${req.method} ${url.pathname}` });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('Method not allowed');
    return;
  }

  try {
    await serveStatic(req, res);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(`Server error: ${err.message}`);
  }
});

function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

await fsp.mkdir(DOWNLOAD_DIR, { recursive: true });

server.listen(PORT, HOST, () => {
  const local = `http://127.0.0.1:${PORT}`;
  const lan = lanAddress();
  process.stdout.write(
    [
      '',
      '  SwiftGrab is running',
      `  ${'local'.padEnd(6)} ${local}`,
      HOST === '0.0.0.0' && lan ? `  ${'phone'.padEnd(6)} http://${lan}:${PORT}` : null,
      `  ${'saves'.padEnd(6)} ${DOWNLOAD_DIR}`,
      ALLOW_PRIVATE ? '  note   --allow-private is ON (local addresses are reachable)' : null,
      '',
      '  Ctrl+C to stop',
      '',
    ]
      .filter(Boolean)
      .join('\n') + '\n'
  );

  if (OPEN_BROWSER && process.platform === 'darwin' && !process.env.SWIFTGRAB_NO_OPEN) {
    execFile('open', [local], () => {});
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    jobs.dispose();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

function serializeJob(job) {
  return {
    id: job.id,
    status: job.status,
    engine: job.engine,
    sourceLabel: job.sourceLabel,
    pageUrl: job.pageUrl,
    filename: job.filename,
    filePath: job.filePath,
    percent: Number.isFinite(job.percent) ? job.percent : 0,
    received: job.received,
    total: job.total,
    speed: job.speed,
    eta: job.eta,
    attempts: job.attempts,
    error: job.error,
    hint: job.hint,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}
