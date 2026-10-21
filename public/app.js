/* SwiftGrab front-end - vanilla ES modules, no build step. */

const $ = (selector) => document.querySelector(selector);

const ICON = {
  video:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m15 10 4.5-2.6a1 1 0 0 1 1.5.9v7.4a1 1 0 0 1-1.5.9L15 14" stroke-linecap="round"/><rect x="3" y="7" width="12" height="10" rx="2.5"/></svg>',
  audio:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V6l9-2v12" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="15.5" cy="16" r="2.5"/></svg>',
  download:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4v10m0 0 4-4m-4 4-4-4M5 19h14" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const state = {
  health: null,
  resolved: null,
  jobs: [],
  library: [],
  polling: null,
  installing: false,
};

/* ------------------------------------------------------------------ *
 * Utilities
 * ------------------------------------------------------------------ */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text.slice(0, 200) || `HTTP ${res.status}` };
  }
  if (!res.ok) {
    const err = new Error(payload.error || `Request failed (${res.status})`);
    err.hint = payload.hint;
    err.status = res.status;
    throw err;
  }
  return payload;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null;
  return `${formatBytes(bytesPerSecond)}/s`;
}

function relativeTime(timestamp) {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

/* ------------------------------------------------------------------ *
 * Toasts
 * ------------------------------------------------------------------ */

function toast(title, message, { kind = 'info', actionLabel = null, onAction = null, timeout = kind === 'error' ? 11000 : 5200 } = {}) {
  const node = document.createElement('div');
  node.className = `toast ${kind === 'info' ? '' : kind}`;
  node.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span>`;
  if (actionLabel) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost-btn mini';
    button.style.marginTop = '9px';
    button.textContent = actionLabel;
    button.addEventListener('click', () => {
      node.remove();
      onAction?.();
    });
    node.appendChild(button);
  }
  $('#toasts').appendChild(node);
  if (timeout) setTimeout(() => node.remove(), timeout);
}

/* ------------------------------------------------------------------ *
 * Health / chips / yt-dlp pill
 * ------------------------------------------------------------------ */

function renderPill() {
  const pill = $('#ytdlp-pill');
  const label = $('#ytdlp-label');
  const tools = state.health?.ytdlp;
  if (state.installing) {
    pill.dataset.state = 'installing';
    label.textContent = 'Installing yt-dlp…';
    return;
  }
  if (tools?.installed) {
    pill.dataset.state = 'ready';
    label.textContent = `yt-dlp ${tools.version}`;
  } else {
    pill.dataset.state = 'optional';
    label.textContent = 'yt-dlp not installed';
  }
}

function renderChips() {
  const container = $('#site-chips');
  const sites = state.health?.sites ?? [];
  container.innerHTML = sites
    .map(
      (site) =>
        `<span class="chip"><span class="site-dot" style="--chip-color:${escapeHtml(site.color)}"></span>${escapeHtml(site.label)}</span>`
    )
    .join('');
}

async function loadHealth() {
  try {
    state.health = await api('/api/health');
  } catch (err) {
    toast('Server unreachable', err.message, { kind: 'error' });
    return;
  }
  renderPill();
  renderChips();
}

/* ------------------------------------------------------------------ *
 * Resolving
 * ------------------------------------------------------------------ */

function setGrabLoading(loading, label = 'Grab it') {
  const button = $('#grab-btn');
  button.disabled = loading;
  button.classList.toggle('loading', loading);
  button.querySelector('.label').textContent = loading ? 'Resolving…' : label;
}

function needsYtdlp(variant) {
  return variant?.engine === 'yt-dlp' && !state.health?.ytdlp?.installed;
}

async function resolveLink(rawUrl) {
  const url = rawUrl.trim();
  if (!url) {
    toast('Nothing to grab', 'Paste a video link first.', { kind: 'error' });
    return;
  }

  setGrabLoading(true);
  try {
    const payload = await api('/api/resolve', { method: 'POST', body: { url } });
    state.resolved = payload;
    renderResult();
    $('#result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (!payload.result.variants.some((v) => !needsYtdlp(v))) {
      // Everything on offer goes through yt-dlp.
      toast('yt-dlp recommended', 'Every stream for this link needs yt-dlp. Install it once and it stays.', {
        actionLabel: 'Install',
        onAction: () => installYtdlp(),
      });
    }
  } catch (err) {
    state.resolved = null;
    $('#result').hidden = true;
    toast('Could not grab that link', err.message, {
      kind: 'error',
      actionLabel: err.hint === 'yt-dlp' && !state.health?.ytdlp?.installed ? 'Install yt-dlp' : null,
      onAction: () => installYtdlp(),
    });
  } finally {
    setGrabLoading(false);
  }
}

function renderResult() {
  const section = $('#result');
  if (!state.resolved) {
    section.hidden = true;
    return;
  }

  const { result, engine, elapsedMs } = state.resolved;
  const badgeColor =
    state.health?.sites?.find((site) => site.id === engine)?.color ?? 'var(--accent)';

  const metaBits = [
    result.author ? escapeHtml(result.author) : null,
    result.duration ? formatDuration(result.duration) : null,
    `${result.variants.length} quality option${result.variants.length === 1 ? '' : 's'}`,
    `${elapsedMs} ms`,
  ].filter(Boolean);

  const thumb = result.thumbnail
    ? `<div class="thumb"><img src="${escapeHtml(result.thumbnail)}" alt="" referrerpolicy="no-referrer" loading="lazy" onerror="this.parentElement.style.display='none'" />${
        result.duration ? `<span class="duration">${escapeHtml(formatDuration(result.duration))}</span>` : ''
      }</div>`
    : '';

  const variants = result.variants
    .map((variant) => {
      const size = variant.size ? `${variant.approx ? '~' : ''}${formatBytes(variant.size)}` : null;
      const bits = [
        escapeHtml(String(variant.ext).toUpperCase()),
        size,
        variant.quality && variant.ext !== 'mp3' ? `${variant.quality}p` : null,
        variant.fps ? `${variant.fps} fps` : null,
        variant.kind === 'audio' && variant.bitrate ? `${Math.round(variant.bitrate / 1000)} kbps` : null,
        variant.kind === 'audio' ? null : 'video',
      ].filter(Boolean);

      const tags = [
        variant.engine === 'yt-dlp' ? '<span class="tag">yt-dlp</span>' : '',
        variant.note ? `<span class="tag info">${escapeHtml(variant.note)}</span>` : '',
      ].join('');

      const button = needsYtdlp(variant)
        ? `<button type="button" class="dl-btn" data-install="1">${ICON.download}Install yt-dlp</button>`
        : `<button type="button" class="dl-btn" data-variant="${escapeHtml(variant.id)}">${ICON.download}Download</button>`;

      return `
        <div class="variant">
          <span class="variant-kind ${variant.kind === 'audio' ? 'audio' : ''}">${variant.kind === 'audio' ? ICON.audio : ICON.video}</span>
          <div class="variant-text">
            <div class="variant-label">${escapeHtml(variant.label)}${tags}</div>
            <div class="variant-meta">${bits.map((b) => `<span>${b}</span>`).join('')}</div>
          </div>
          ${button}
        </div>`;
    })
    .join('');

  section.innerHTML = `
    <div class="result-header">
      ${thumb}
      <div class="result-info">
        <div class="result-top">
          <span class="source-badge" style="--badge-color:${escapeHtml(badgeColor)}">${escapeHtml(result.sourceLabel)}</span>
          ${engine === 'yt-dlp' ? '<span class="tag">resolved by yt-dlp</span>' : ''}
        </div>
        <h3 class="result-title">${escapeHtml(result.title)}</h3>
        <div class="result-sub">${metaBits.map((b) => `<span>${b}</span>`).join('')}</div>
        ${result.note ? `<p class="result-note">${escapeHtml(result.note)}</p>` : ''}
      </div>
    </div>
    <div class="variant-list">${variants}</div>
  `;
  section.hidden = false;

  section.querySelectorAll('[data-variant]').forEach((button) => {
    button.addEventListener('click', () => startDownload(button.dataset.variant));
  });
  section.querySelectorAll('[data-install]').forEach((button) => {
    button.addEventListener('click', () => installYtdlp());
  });
}

/* ------------------------------------------------------------------ *
 * Jobs
 * ------------------------------------------------------------------ */

async function startDownload(variantId) {
  if (!state.resolved) return;
  const variant = state.resolved.result.variants.find((v) => v.id === variantId);
  if (needsYtdlp(variant)) {
    installYtdlp();
    return;
  }

  try {
    const job = await api('/api/jobs', {
      method: 'POST',
      body: { rid: state.resolved.rid, variantId },
    });
    state.jobs = [job, ...state.jobs.filter((j) => j.id !== job.id)];
    $('#downloads').hidden = false;
    renderJobs();
    startPolling();
  } catch (err) {
    toast('Download did not start', err.message, {
      kind: 'error',
      actionLabel: err.status === 410 ? 'Re-resolve' : null,
      onAction: () => resolveLink($('#url-input').value),
    });
  }
}

const STATUS_TEXT = {
  queued: 'Waiting in queue',
  downloading: 'Downloading',
  processing: 'Muxing video + audio',
  done: 'Done',
  cancelled: 'Cancelled',
  error: 'Failed',
};

function renderJobs() {
  const panel = $('#downloads');
  const list = $('#job-list');
  const template = $('#job-template');

  if (!state.jobs.length) {
    panel.hidden = true;
    list.innerHTML = '';
    return;
  }
  panel.hidden = false;

  // Reconcile existing nodes by id so progress bars animate instead of
  // being rebuilt on every poll.
  const seen = new Set();
  for (const job of state.jobs) {
    seen.add(job.id);
    let node = list.querySelector(`[data-job="${CSS.escape(job.id)}"]`);
    if (!node) {
      node = template.content.firstElementChild.cloneNode(true);
      node.dataset.job = job.id;
      node.querySelector('.job-badge').style.setProperty('--badge-color', 'var(--accent)');
      node.querySelector('.job-badge').textContent = job.sourceLabel ?? 'video';
      node.querySelector('.job-title').textContent = job.filename ?? 'video';
      node.querySelector('.job-cancel').addEventListener('click', () => cancelJob(job.id));
      node.querySelector('.job-dismiss').addEventListener('click', () => dismissJob(job.id));
      node.querySelector('.job-reveal').addEventListener('click', () => revealJob(job.id));
      list.prepend(node);
    }

    node.className = `job ${job.status}`;
    node.querySelector('.progress-bar').style.width = `${Math.max(2, job.percent || 0)}%`;

    const status = node.querySelector('.job-status');
    status.textContent =
      job.status === 'error' && job.error ? job.error : STATUS_TEXT[job.status] ?? job.status;

    const speed = formatSpeed(job.speed);
    node.querySelector('.job-speed').textContent = job.status === 'downloading' && speed ? speed : '';
    node.querySelector('.job-size').textContent =
      job.status === 'done'
        ? formatBytes(job.total ?? job.received)
        : job.total
          ? `${formatBytes(job.received)} / ${formatBytes(job.total)}${job.eta ? ` · ${Math.round(job.eta)}s left` : ''}`
          : job.received
            ? formatBytes(job.received)
            : '';

    const errorNode = node.querySelector('.job-error');
    const failed = job.status === 'error';
    errorNode.textContent = failed && job.error ? job.error : '';

    const live = job.status === 'downloading' || job.status === 'processing' || job.status === 'queued';
    node.querySelector('.job-cancel').hidden = !live;
    node.querySelector('.job-dismiss').hidden = live;
    node.querySelector('.job-reveal').hidden = job.status !== 'done';
    const preview = node.querySelector('.job-preview');
    preview.hidden = job.status !== 'done';
    preview.onclick = () => window.open(`/api/jobs/${job.id}/file`, '_blank');
    const save = node.querySelector('.job-save');
    save.hidden = job.status !== 'done';
    save.href = `/api/jobs/${job.id}/file?download=1`;
    save.setAttribute('download', job.filename ?? '');
  }

  for (const node of [...list.children]) {
    if (!seen.has(node.dataset.job)) node.remove();
  }
}

async function cancelJob(id) {
  try {
    await api(`/api/jobs/${id}/cancel`, { method: 'POST' });
    refreshJobs();
  } catch (err) {
    toast('Could not cancel', err.message, { kind: 'error' });
  }
}

async function dismissJob(id) {
  const job = state.jobs.find((j) => j.id === id);
  const deleteFile = job?.status === 'done'
    ? window.confirm(`Also delete "${job.filename}" from disk?\n\nOK = delete the file\nCancel = keep it in the folder`)
    : false;
  try {
    await api(`/api/jobs/${id}?file=${deleteFile ? 1 : 0}`, { method: 'DELETE' });
    state.jobs = state.jobs.filter((j) => j.id !== id);
    renderJobs();
    if (deleteFile) loadLibrary();
  } catch (err) {
    toast('Could not dismiss', err.message, { kind: 'error' });
  }
}

async function revealJob(id) {
  const job = state.jobs.find((j) => j.id === id);
  try {
    await api('/api/reveal', { method: 'POST', body: { name: job?.filename } });
  } catch (err) {
    toast('Could not open Finder', err.message, { kind: 'error' });
  }
}

async function refreshJobs({ refreshLibraryOnFinish = true } = {}) {
  try {
    const payload = await api('/api/jobs');
    const previous = new Map(state.jobs.map((job) => [job.id, job.status]));
    state.jobs = payload.jobs;
    renderJobs();

    const finishedNow = payload.jobs.some(
      (job) => ['done', 'error', 'cancelled'].includes(job.status) && ['downloading', 'processing', 'queued'].includes(previous.get(job.id))
    );
    if (finishedNow && refreshLibraryOnFinish) loadLibrary();

    const active = payload.jobs.some((job) => ['queued', 'downloading', 'processing'].includes(job.status));
    if (!active) stopPolling();
  } catch {
    stopPolling();
  }
}

function startPolling() {
  if (state.polling) return;
  state.polling = setInterval(() => refreshJobs(), 550);
}

function stopPolling() {
  if (!state.polling) return;
  clearInterval(state.polling);
  state.polling = null;
}

/* ------------------------------------------------------------------ *
 * Library
 * ------------------------------------------------------------------ */

async function loadLibrary() {
  try {
    const payload = await api('/api/library');
    state.library = payload.files;
    $('#library-dir').textContent = payload.dir;
    renderLibrary();
  } catch {
    /* the panel is a nicety, not essential */
  }
}

function renderLibrary() {
  const panel = $('#library');
  const list = $('#library-list');
  if (!state.library.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  list.innerHTML = state.library
    .map(
      (file) => `
      <div class="library-item" data-name="${escapeHtml(file.name)}">
        <span class="variant-kind">${ICON.video}</span>
        <span class="library-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
        <span class="library-size">${escapeHtml(file.sizeFormatted)}</span>
        <span class="library-size">${escapeHtml(relativeTime(file.modified))}</span>
        <a class="ghost-btn mini" href="/api/library/file?name=${encodeURIComponent(file.name)}" target="_blank" rel="noopener">Play</a>
        <a class="ghost-btn mini" href="/api/library/file?name=${encodeURIComponent(file.name)}&download=1" download>Save</a>
        <button type="button" class="ghost-btn mini" data-delete="${escapeHtml(file.name)}">Delete</button>
      </div>`
    )
    .join('');

  list.querySelectorAll('[data-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      const name = button.dataset.delete;
      if (!window.confirm(`Delete "${name}" from disk?`)) return;
      try {
        await api(`/api/library?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
        loadLibrary();
      } catch (err) {
        toast('Could not delete', err.message, { kind: 'error' });
      }
    });
  });
}

/* ------------------------------------------------------------------ *
 * yt-dlp installer
 * ------------------------------------------------------------------ */

async function installYtdlp() {
  if (state.installing) return;
  state.installing = true;
  renderPill();

  const dialog = $('#ytdlp-dialog');
  if (!dialog.open) dialog.showModal();
  $('#ytdlp-progress-wrap').hidden = false;
  $('#ytdlp-progress').style.width = '2%';
  $('#ytdlp-progress-text').textContent = 'Contacting GitHub…';

  try {
    await api('/api/tools/install-ytdlp', { method: 'POST' });
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const status = await api('/api/tools/status');
      if (status.progress) {
        $('#ytdlp-progress').style.width = `${Math.max(2, status.progress.percent)}%`;
        $('#ytdlp-progress-text').textContent = status.progress.total
          ? `${formatBytes(status.progress.received)} of ${formatBytes(status.progress.total)}`
          : 'Downloading…';
        if (status.progress.error) throw new Error(status.progress.error);
      }
      if (status.installed) break;
      if (!status.installing && !status.progress) break;
    }
    await loadHealth();
    toast('yt-dlp installed', `Version ${state.health.ytdlp.version}. Adaptive streams and 1,000+ extra sites are now available.`, {
      kind: 'success',
    });
    if ($('#url-input').value.trim()) resolveLink($('#url-input').value);
  } catch (err) {
    toast('Install failed', err.message, { kind: 'error' });
  } finally {
    state.installing = false;
    renderPill();
    $('#ytdlp-progress-wrap').hidden = true;
  }
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

function updateClearButton() {
  $('#grab-form .field').classList.toggle('has-value', Boolean($('#url-input').value.trim()));
}

$('#grab-form').addEventListener('submit', (event) => {
  event.preventDefault();
  resolveLink($('#url-input').value);
});

$('#url-input').addEventListener('input', updateClearButton);

// Pasting a link resolves it straight away - the whole point of the app.
$('#url-input').addEventListener('paste', () => {
  setTimeout(() => {
    updateClearButton();
    const value = $('#url-input').value.trim();
    if (/^https?:\/\/\S+$/i.test(value) && value.length > 14) resolveLink(value);
  }, 40);
});

$('#paste-btn').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) {
      toast('Clipboard is empty', 'Copy a video link first.', { kind: 'info' });
      return;
    }
    $('#url-input').value = text.trim();
    updateClearButton();
    resolveLink(text);
  } catch {
    toast('Clipboard blocked', 'Your browser needs permission to read the clipboard. Paste into the box with ⌘V instead.', {
      kind: 'info',
    });
  }
});

$('#clear-btn').addEventListener('click', () => {
  $('#url-input').value = '';
  updateClearButton();
  $('#url-input').focus();
});

$('#clear-finished').addEventListener('click', () => {
  for (const job of state.jobs) {
    if (['done', 'error', 'cancelled'].includes(job.status)) {
      api(`/api/jobs/${job.id}`, { method: 'DELETE' }).catch(() => {});
    }
  }
  state.jobs = state.jobs.filter((job) => !['done', 'error', 'cancelled'].includes(job.status));
  renderJobs();
});

$('#reveal-folder').addEventListener('click', async () => {
  try {
    await api('/api/reveal', { method: 'POST', body: {} });
  } catch (err) {
    toast('Could not open the folder', err.message, { kind: 'error' });
  }
});

$('#ytdlp-pill').addEventListener('click', () => {
  const dialog = $('#ytdlp-dialog');
  const tools = state.health?.ytdlp;
  $('#ytdlp-copy').innerHTML = tools?.installed
    ? `Installed and ready.<br><br><code>${escapeHtml(tools.version)}</code> &nbsp; run via <code>${escapeHtml(
        tools.kind === 'local' ? './tools/yt-dlp' : tools.bin ?? 'yt-dlp'
      )}</code><br><br>${
        state.health.ffmpeg
          ? 'ffmpeg was found, so separate video and audio tracks can be muxed into one file.'
          : 'ffmpeg was <b>not</b> found. Downloads still work, but adaptive streams will be limited to pre-muxed formats.'
      }`
    : 'yt-dlp handles adaptive streams (HLS/DASH) and about a thousand sites SwiftGrab has no native extractor for, including YouTube, Twitch, SoundCloud and Bilibili.<br><br>It installs as a single self-contained binary inside <code>./tools</code>. No Homebrew, no Python, nothing system-wide.';
  $('#ytdlp-install').textContent = tools?.installed ? 'Update yt-dlp' : 'Install yt-dlp';
  $('#ytdlp-progress-wrap').hidden = true;
  dialog.showModal();
});

$('#ytdlp-close').addEventListener('click', () => $('#ytdlp-dialog').close());
$('#ytdlp-install').addEventListener('click', () => {
  $('#ytdlp-dialog').close();
  installYtdlp();
});

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'v' && document.activeElement !== $('#url-input')) {
    $('#url-input').focus();
  }
});

/* Boot */
updateClearButton();
await loadHealth();
await refreshJobs({ refreshLibraryOnFinish: false });
await loadLibrary();
if (state.jobs.some((job) => ['queued', 'downloading', 'processing'].includes(job.status))) startPolling();
