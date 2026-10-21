/**
 * Networking helpers shared by every extractor.
 *
 * Two jobs:
 *   1. Look like a real browser so the sites hand us their public HTML/JSON.
 *   2. Never let a user-supplied link turn the server into a probe for the
 *      local network (SSRF). Every hop of every redirect is validated.
 */

import dns from 'node:dns/promises';
import net from 'node:net';

const DEFAULT_TIMEOUT = 20_000;
const MAX_REDIRECTS = 5;
const MAX_BYTES = 12 * 1024 * 1024; // extractor pages are small; cap the read

export const UA = {
  desktop:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  android:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  googlebot:
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  facebookBot: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  tiktokBot: 'TikTok 26.2.0 rv:262018 (iPhone; iOS 14.4.2; en_US) Cronet',
  curl: 'curl/8.6.0',
};

/** Hosts we must never touch on behalf of a user-supplied link. */
const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.goog',
]);

/**
 * Classify an IP literal. Anything not globally routable is off limits.
 * Returns a reason string when the address must be blocked, else null.
 */
function blockedAddressReason(ip, version) {
  if (version === 4) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return 'malformed IPv4 address';
    }
    const [a, b] = parts;
    if (a === 0) return 'this-network (0.0.0.0/8)';
    if (a === 10) return 'private network (10.0.0.0/8)';
    if (a === 127) return 'loopback (127.0.0.0/8)';
    if (a === 169 && b === 254) return 'link-local / cloud metadata (169.254.0.0/16)';
    if (a === 172 && b >= 16 && b <= 31) return 'private network (172.16.0.0/12)';
    if (a === 192 && b === 168) return 'private network (192.168.0.0/16)';
    if (a === 192 && b === 0) return 'reserved (192.0.0.0/24)';
    if (a === 198 && (b === 18 || b === 19)) return 'benchmarking (198.18.0.0/15)';
    if (a >= 224) return 'multicast / reserved (224.0.0.0/4)';
    return null;
  }
  const ipv6 = ip.toLowerCase().split('%')[0];
  if (ipv6 === '::' || ipv6 === '::1') return 'loopback (::1)';
  if (ipv6.startsWith('fe80')) return 'link-local (fe80::/10)';
  if (ipv6.startsWith('fc') || ipv6.startsWith('fd')) return 'unique-local (fc00::/7)';
  if (ipv6.startsWith('ff')) return 'multicast (ff00::/8)';
  // IPv4-mapped / IPv4-embedded forms such as ::ffff:127.0.0.1
  const tail = ipv6.includes('.') ? ipv6.slice(ipv6.lastIndexOf(':') + 1) : null;
  if (tail && net.isIPv4(tail)) return blockedAddressReason(tail, 4);
  return null;
}

/**
 * Validate a URL for outbound fetching.
 * @param {string} raw
 * @param {{ allowPrivate?: boolean }} [opts]
 * @returns {Promise<URL>}
 */
export async function assertSafeUrl(raw, opts = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    const err = new Error('That does not look like a valid URL.');
    err.status = 400;
    throw err;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    const err = new Error(`Unsupported protocol "${url.protocol}" - only http and https links work.`);
    err.status = 400;
    throw err;
  }
  if (opts.allowPrivate) return url;

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (BLOCKED_HOSTS.has(host)) {
    const err = new Error(`Refusing to fetch internal host "${host}".`);
    err.status = 400;
    throw err;
  }

  // A literal IP can be judged without DNS.
  if (net.isIP(host)) {
    const reason = blockedAddressReason(host, net.isIPv6(host) ? 6 : 4);
    if (reason) {
      const err = new Error(`Refusing to fetch ${host}: ${reason}.`);
      err.status = 400;
      throw err;
    }
    return url;
  }

  // Otherwise resolve every A/AAAA record and reject if any is internal.
  try {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    for (const record of records) {
      const reason = blockedAddressReason(record.address, record.family);
      if (reason) {
        const err = new Error(`Refusing to fetch ${host}: resolves to ${reason}.`);
        err.status = 400;
        throw err;
      }
    }
  } catch (err) {
    if (err.status) throw err;
    const wrapped = new Error(`Could not resolve host "${host}".`);
    wrapped.status = 502;
    wrapped.cause = err;
    throw wrapped;
  }

  return url;
}

function mergeSignals(signal, timeoutMs) {
  const timer = AbortSignal.timeout(timeoutMs);
  if (!signal) return timer;
  return AbortSignal.any([signal, timer]);
}

/**
 * fetch() with the safety checks applied, redirects followed manually so each
 * hop is validated, and a hard cap on how much body we are willing to read.
 *
 * @param {string} rawUrl
 * @param {RequestInit & { allowPrivate?: boolean, timeout?: number, label?: string }} [init]
 * @returns {Promise<Response>}
 */
export async function fetchSafe(rawUrl, init = {}) {
  const { allowPrivate = false, timeout = DEFAULT_TIMEOUT, label = 'request', ...rest } = init;
  let current = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = await assertSafeUrl(current, { allowPrivate });
    const res = await fetch(url, {
      ...rest,
      redirect: 'manual',
      signal: mergeSignals(rest.signal, timeout),
    });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) return res;
      current = new URL(location, url).toString();
      // 303 (and 302 in practice) downgrade to GET and drop the body.
      if (res.status === 303) {
        rest.method = 'GET';
        rest.body = undefined;
      }
      continue;
    }

    return res;
  }

  const err = new Error(`Too many redirects while fetching ${label}.`);
  err.status = 502;
  throw err;
}

async function readCapped(res, maxBytes = MAX_BYTES) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * GET a page as text. Throws a friendly error on non-2xx.
 * @returns {Promise<string>}
 */
export async function getText(rawUrl, { headers = {}, maxBytes, label, ...rest } = {}) {
  const res = await fetchSafe(rawUrl, {
    ...rest,
    label: label ?? rawUrl,
    headers: { 'user-agent': UA.desktop, accept: '*/*', ...headers },
  });
  const body = await readCapped(res, maxBytes);
  if (!res.ok) {
    const err = new Error(
      `${label ?? new URL(rawUrl).host} responded ${res.status} ${res.statusText}.`
    );
    err.status = res.status === 404 ? 404 : 502;
    err.body = body.slice(0, 300);
    throw err;
  }
  return body;
}

/**
 * GET a URL as JSON.
 * @returns {Promise<any>}
 */
export async function getJson(rawUrl, options = {}) {
  const text = await getText(rawUrl, { ...options, headers: { accept: 'application/json, text/plain, */*', ...options.headers } });
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error(`Expected JSON from ${options.label ?? new URL(rawUrl).host} but got something else.`);
    err.status = 502;
    err.body = text.slice(0, 300);
    throw err;
  }
}

/**
 * HEAD (falling back to a 1-byte ranged GET) to learn a media file's type and size.
 * @returns {Promise<{ contentType: string|null, size: number|null, finalUrl: string, ok: boolean, status: number }>}
 */
export async function probe(url, { headers = {}, signal, allowPrivate = false } = {}) {
  const attempt = async (method) => {
    const res = await fetchSafe(url, {
      method,
      allowPrivate,
      signal,
      timeout: 12_000,
      label: 'media probe',
      headers: {
        'user-agent': UA.desktop,
        ...(method === 'GET' ? { range: 'bytes=0-0' } : {}),
        ...headers,
      },
    });
    const range = res.headers.get('content-range');
    const length = res.headers.get('content-length');
    let size = length ? Number(length) : null;
    if (range && range.includes('/')) {
      const total = Number(range.split('/')[1]);
      if (Number.isFinite(total)) size = total;
    }
    if (method === 'GET') res.body?.cancel().catch(() => {});
    return {
      ok: res.ok || res.status === 206,
      status: res.status,
      contentType: res.headers.get('content-type'),
      size: Number.isFinite(size) && size > 0 ? size : null,
      finalUrl: res.url,
    };
  };

  try {
    const head = await attempt('HEAD');
    if (head.ok && head.contentType) return head;
    return await attempt('GET');
  } catch {
    return { ok: false, status: 0, contentType: null, size: null, finalUrl: url };
  }
}

/** Turn any thrown value into a clean { message, status } pair for the API. */
export function toHttpError(err, fallback = 'Something went wrong.') {
  if (err?.status && err?.message) return { message: err.message, status: err.status };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return { message: 'The request timed out. The site may be slow or blocking us.', status: 504 };
  }
  return { message: err?.message || fallback, status: 502 };
}
