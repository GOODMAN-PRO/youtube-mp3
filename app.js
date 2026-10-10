'use strict';

const $ = (id) => document.getElementById(id);
const form = $('convert-form');
const input = $('video-url');
const convertButton = $('convert-button');
const convertLabel = $('convert-label');
const pasteButton = $('paste-button');
const clearButton = $('clear-button');
const browserSessionCheckbox = $('use-browser-session');
const accessInput = $('access-code');
const downloadButton = $('download-button');
const panel = $('job-panel');
const terminalStates = new Set(['ready', 'error', 'cancelled']);
const remoteMode = typeof window.CONVERTER_REMOTE !== 'undefined';
const apiBase = remoteMode ? remoteBase(window.CONVERTER_REMOTE?.apiBase) : '';
const storageKey = remoteMode ? `youtube-mp3-current-job:${apiBase}` : 'youtube-mp3-current-job';
const browserSessionStorageKey = 'youtube-mp3-use-browser-session';
const accessStorageKey = `youtube-mp3-access-code:${apiBase}`;
let csrfToken = '';
let serviceReady = false;
let remoteConnected = !remoteMode;
let accessCode = remoteMode && apiBase ? storedAccessCode() : '';
let authGeneration = 0;
let connecting = false;
let browserSessionAvailable = false;
let browserSessionPreference = storedBrowserSessionPreference();
let currentJob = null;
let pollTimer = null;
let requestInFlight = false;
let cancelInFlight = false;
let downloadInFlight = false;
let pollFailures = 0;
let pollGeneration = 0;

function remoteBase(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash ? url.origin : '';
  } catch { return ''; }
}

function storedAccessCode() {
  try { return sessionStorage.getItem(accessStorageKey) || ''; } catch { return ''; }
}

function saveAccessCode(code) {
  try {
    if (code) sessionStorage.setItem(accessStorageKey, code);
    else sessionStorage.removeItem(accessStorageKey);
  } catch { /* A connection still works without browser storage. */ }
}

function remoteError(message) {
  $('remote-connect-error').textContent = message || '';
  $('remote-connect-error').hidden = !message;
}

function disconnectRemote(message = '') {
  authGeneration += 1;
  stopPolling();
  accessCode = '';
  saveAccessCode('');
  accessInput.value = '';
  csrfToken = '';
  remoteConnected = false;
  serviceReady = false;
  connecting = false;
  currentJob = null;
  requestInFlight = false;
  cancelInFlight = false;
  downloadInFlight = false;
  connectionNotice('');
  remoteError(message);
  updateControls();
  accessInput.focus();
}

function staleRequest() {
  const error = new Error('This connection has ended.');
  error.cancelled = true;
  return error;
}

function saveJob(id) {
  try {
    if (id) sessionStorage.setItem(storageKey, id);
    else sessionStorage.removeItem(storageKey);
  } catch { /* The converter also works when browser storage is unavailable. */ }
}

function storedJob() {
  try { return sessionStorage.getItem(storageKey); } catch { return null; }
}

function storedBrowserSessionPreference() {
  try { return sessionStorage.getItem(browserSessionStorageKey) !== 'false'; } catch { return true; }
}

function configureBrowserSession(label) {
  browserSessionAvailable = typeof label === 'string' && label.trim().length > 0;
  $('browser-session-option').hidden = !browserSessionAvailable;
  if (browserSessionAvailable) {
    $('browser-session-label').textContent = remoteMode ? `Use the connected ${label.trim()} YouTube session` : `Use my ${label.trim()} YouTube session`;
    $('browser-session-hint').textContent = remoteMode ? 'Uses the YouTube sign-in from the connected PC.' : 'Uses your browser’s existing YouTube sign-in.';
    browserSessionCheckbox.checked = browserSessionPreference;
  }
}

async function api(path, options = {}) {
  if (remoteMode && (!apiBase || !accessCode)) {
    const error = new Error('Enter your access code to connect to your PC.');
    error.status = 401;
    throw error;
  }
  const generation = authGeneration;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      cache: 'no-store',
      signal: controller.signal,
      ...(remoteMode ? { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' } : {}),
      headers: {
        ...options.headers,
        ...(remoteMode ? { Authorization: `Bearer ${accessCode}` } : {}),
        ...(options.method === 'POST' ? { 'X-CSRF-Token': csrfToken } : {}),
      },
    });
    if (generation !== authGeneration) throw staleRequest();
    if (remoteMode && response.status === 401) {
      disconnectRemote('That access code was not accepted. Enter the current code from your PC and connect again.');
      const error = new Error('The access code was not accepted.');
      error.status = 401;
      throw error;
    }
    const data = await response.json().catch(() => ({}));
    if (generation !== authGeneration) throw staleRequest();
    if (!response.ok) {
      const error = new Error(data.error || 'The app could not complete that request. Please try again.');
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (generation !== authGeneration && error.status !== 401) throw staleRequest();
    if (error.name === 'AbortError' || error instanceof TypeError) {
      throw new Error(remoteMode
        ? 'Cannot reach your PC. Keep it on with the converter and remote connection running, then try again.'
        : 'The app is not responding. Make sure its launcher is still running, then try connecting again.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function formError(message) {
  $('form-error').textContent = message || '';
  $('form-error').hidden = !message;
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

function connectionNotice(message) {
  $('connection-message').textContent = message || '';
  $('connection-notice').hidden = !message;
}

function isActive() {
  return currentJob && !terminalStates.has(currentJob.status);
}

function updateControls() {
  const accessible = !remoteMode || remoteConnected;
  const busy = Boolean(requestInFlight || isActive());
  const finished = Boolean(currentJob && terminalStates.has(currentJob.status));
  input.disabled = busy;
  pasteButton.disabled = busy;
  browserSessionCheckbox.disabled = busy || !browserSessionAvailable;
  clearButton.hidden = !input.value || busy || finished;
  convertButton.disabled = !serviceReady || busy;
  convertButton.hidden = finished;
  convertLabel.textContent = busy ? 'Converting…' : 'Convert to MP3';
  $('cancel-button').disabled = cancelInFlight;
  $('cancel-button').textContent = cancelInFlight ? 'Cancelling…' : 'Cancel conversion';
  $('retry-button').disabled = !serviceReady || requestInFlight;
  form.hidden = !accessible;
  panel.hidden = !accessible || !currentJob;
  $('remote-connect-form').hidden = !remoteMode || remoteConnected;
  $('remote-connection').hidden = !remoteMode || !remoteConnected;
  accessInput.disabled = connecting || !apiBase;
  $('remote-connect-button').disabled = connecting || !apiBase;
  $('remote-connect-button').textContent = connecting ? 'Connecting…' : 'Connect';
  $('reconnect-button').hidden = !accessible;
  $('reconnect-button').disabled = connecting;
  $('download-label').textContent = downloadInFlight ? 'Preparing download…' : 'Download MP3';
  if (downloadInFlight) downloadButton.setAttribute('aria-disabled', 'true');
  else downloadButton.removeAttribute('aria-disabled');
}

function durationText(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
    : `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

function sizeText(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function renderJob(job) {
  currentJob = job;
  saveJob(job.id);
  panel.hidden = false;
  panel.dataset.state = job.status;
  $('job-title').textContent = job.title || (job.status === 'error' ? 'Conversion could not finish' : 'Getting your video');
  const meta = [durationText(job.duration), job.status === 'ready' ? sizeText(job.size) : '', 'MP3'].filter(Boolean);
  $('job-meta').textContent = job.title ? meta.join(' · ') : 'Reading video details…';
  const labels = {
    starting: 'Reading video details…',
    downloading: 'Downloading audio…',
    converting: 'Creating your MP3…',
    ready: 'Your MP3 is ready.',
    error: 'Conversion could not finish.',
    cancelled: 'Conversion cancelled.',
  };
  const label = labels[job.status] || 'Working…';
  if ($('job-status').textContent !== label) $('job-status').textContent = label;
  const active = !terminalStates.has(job.status);
  const numericProgress = Number.isFinite(job.progress);
  $('job-progress').hidden = !active;
  if (active && numericProgress) {
    $('job-progress').value = Math.max(0, Math.min(100, job.progress));
    $('progress-percent').textContent = `${Math.round(Math.max(0, Math.min(100, job.progress)))}%`;
  } else {
    $('job-progress').removeAttribute('value');
    $('progress-percent').textContent = '';
  }
  $('job-error').textContent = job.status === 'error' ? (job.error || 'Something went wrong. Please try this link again.') : '';
  $('job-error').hidden = job.status !== 'error';
  $('cancel-button').hidden = !active;
  $('download-button').hidden = job.status !== 'ready';
  if (job.status === 'ready') {
    if (remoteMode) {
      downloadButton.removeAttribute('href');
      downloadButton.removeAttribute('download');
      downloadButton.setAttribute('role', 'button');
      downloadButton.tabIndex = 0;
    } else {
      // Always use this app's own download route, even if a response has an unexpected URL.
      downloadButton.href = `/api/jobs/${encodeURIComponent(job.id)}/download`;
      downloadButton.download = job.filename || 'audio.mp3';
    }
  } else {
    $('download-button').removeAttribute('href');
  }
  $('retry-button').hidden = job.status !== 'error' && job.status !== 'cancelled';
  $('another-button').hidden = active;
  if ((job.status === 'error' || job.status === 'cancelled') && !job.title) {
    $('job-title').textContent = job.status === 'cancelled' ? 'Conversion cancelled' : 'Conversion could not finish';
    $('job-meta').textContent = 'Try again or paste a different link.';
  }
  updateControls();
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
  pollGeneration += 1;
}

function schedulePoll(delay = 900) {
  clearTimeout(pollTimer);
  if (!isActive() || (remoteMode && !remoteConnected)) return;
  const generation = pollGeneration;
  pollTimer = setTimeout(() => pollJob(generation), delay);
}

async function pollJob(generation) {
  if (!currentJob || generation !== pollGeneration) return;
  const id = currentJob.id;
  try {
    const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
    if (generation !== pollGeneration || currentJob?.id !== id) return;
    pollFailures = 0;
    connectionNotice('');
    renderJob(job);
    schedulePoll();
  } catch (error) {
    if (error.cancelled || (remoteMode && error.status === 401) || generation !== pollGeneration) return;
    if (error.status === 404) {
      connectionNotice('');
      resetJob(false);
      formError('This conversion has expired. Paste the link again to make another MP3.');
      return;
    }
    pollFailures += 1;
    connectionNotice(remoteMode ? 'Connection interrupted. Keep your PC on with the converter and remote connection running. Reconnecting…' : 'Connection interrupted. Reconnecting to your conversion…');
    schedulePoll(Math.min(5000, 900 * (pollFailures + 1)));
  }
}

function resetJob(clearInput = true) {
  stopPolling();
  currentJob = null;
  saveJob(null);
  panel.hidden = true;
  if (clearInput) input.value = '';
  formError('');
  updateControls();
  input.focus();
}

async function connect() {
  if (connecting || (remoteMode && (!apiBase || !accessCode))) return;
  const generation = authGeneration;
  connecting = true;
  remoteError('');
  updateControls();
  try {
    const health = await api('/api/health');
    if (health.app !== 'youtube-mp3' || !health.csrfToken) throw new Error('Could not connect to the converter. Restart the app using its launcher.');
    csrfToken = health.csrfToken;
    serviceReady = Boolean(health.ready);
    remoteConnected = true;
    if (remoteMode) {
      saveAccessCode(accessCode);
      accessInput.value = '';
    }
    configureBrowserSession(health.browserSessionLabel);
    if (!serviceReady) {
      connectionNotice(`The audio tools are not ready${health.missing?.length ? ` (${health.missing.join(', ')})` : ''}. Restart the app using its launcher to finish setup.`);
      updateControls();
      return;
    }
    connectionNotice('');
    stopPolling();
    if (health.activeJob) {
      renderJob(health.activeJob);
      schedulePoll();
    } else {
      const saved = currentJob?.id || storedJob();
      if (saved) {
        try {
          renderJob(await api(`/api/jobs/${encodeURIComponent(saved)}`));
          schedulePoll();
        } catch (error) {
          if (error.status !== 404) throw error;
          resetJob(false);
          formError('Your previous conversion has expired. Paste a link to make a new MP3.');
        }
      }
    }
  } catch (error) {
    if (error.cancelled || (remoteMode && error.status === 401)) return;
    serviceReady = false;
    if (remoteMode && !remoteConnected) remoteError(error.message);
    else connectionNotice(error.message);
  } finally {
    if (generation === authGeneration) {
      connecting = false;
      updateControls();
    }
  }
}

async function startConversion(event) {
  event?.preventDefault();
  if (requestInFlight || isActive() || !serviceReady) return;
  formError('');
  const value = input.value.trim();
  if (!value) {
    formError('Paste a YouTube video link first.');
    input.focus();
    return;
  }
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    const allowedHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be']);
    if (!allowedHosts.has(url.hostname) || url.username || url.password || !['https:', 'http:'].includes(url.protocol)) throw new Error('invalid');
  } catch {
    formError('Enter a YouTube video link, such as youtube.com/watch?v=… or youtu.be/…');
    input.focus();
    return;
  }
  stopPolling();
  const generation = authGeneration;
  requestInFlight = true;
  updateControls();
  try {
    const job = await api('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url.href, useBrowserSession: browserSessionAvailable && browserSessionCheckbox.checked }),
    });
    pollFailures = 0;
    connectionNotice('');
    renderJob(job);
    schedulePoll();
  } catch (error) {
    if (error.cancelled || (remoteMode && error.status === 401)) return;
    formError(error.message);
    if (!error.status || error.status === 403 || error.status === 409) await connect();
  } finally {
    if (generation === authGeneration) {
      requestInFlight = false;
      updateControls();
    }
  }
}

form.addEventListener('submit', startConversion);
$('retry-button').addEventListener('click', startConversion);
$('another-button').addEventListener('click', () => resetJob());
$('reconnect-button').addEventListener('click', connect);
$('remote-connect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!remoteMode || connecting || !apiBase) return;
  const code = accessInput.value.trim() || accessCode;
  if (!code) {
    remoteError('Enter the access code from your PC.');
    accessInput.focus();
    return;
  }
  accessCode = code;
  await connect();
});
$('disconnect-button').addEventListener('click', () => disconnectRemote());
browserSessionCheckbox.addEventListener('change', () => {
  browserSessionPreference = browserSessionCheckbox.checked;
  try { sessionStorage.setItem(browserSessionStorageKey, String(browserSessionPreference)); } catch { /* Keep the preference for this page when storage is unavailable. */ }
});
clearButton.addEventListener('click', () => {
  input.value = '';
  formError('');
  updateControls();
  input.focus();
});
input.addEventListener('input', () => {
  if (currentJob && terminalStates.has(currentJob.status)) resetJob(false);
  formError('');
  updateControls();
});

if (navigator.clipboard?.readText) {
  pasteButton.hidden = false;
  pasteButton.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (requestInFlight || isActive()) return;
      if (currentJob && terminalStates.has(currentJob.status)) resetJob(false);
      input.value = text.trim().slice(0, 2048);
      formError('');
      updateControls();
      input.focus();
      $('clipboard-status').textContent = text.trim() ? 'Link pasted.' : 'The clipboard is empty.';
    } catch {
      $('clipboard-status').textContent = 'Clipboard access is unavailable. Paste your link directly into the YouTube link field.';
      formError('Paste your link directly into the field using Ctrl+V or your device’s paste command.');
      input.focus();
    }
  });
}

$('cancel-button').addEventListener('click', async () => {
  if (!isActive() || cancelInFlight) return;
  const generation = authGeneration;
  cancelInFlight = true;
  stopPolling();
  updateControls();
  try {
    renderJob(await api(`/api/jobs/${encodeURIComponent(currentJob.id)}/cancel`, { method: 'POST' }));
    connectionNotice('');
  } catch (error) {
    if (error.cancelled || (remoteMode && error.status === 401)) return;
    connectionNotice(error.message);
  } finally {
    if (generation === authGeneration) {
      cancelInFlight = false;
      updateControls();
      schedulePoll();
    }
  }
});

downloadButton.addEventListener('click', async (event) => {
  if (!remoteMode) return;
  event.preventDefault();
  if (!remoteConnected || downloadInFlight || currentJob?.status !== 'ready') return;
  const id = currentJob.id;
  const generation = authGeneration;
  downloadInFlight = true;
  updateControls();
  try {
    const ticket = await api(`/api/jobs/${encodeURIComponent(id)}/download-ticket`, { method: 'POST' });
    if (generation !== authGeneration || currentJob?.id !== id) return;
    if (typeof ticket.downloadPath !== 'string' || !/^\/downloads\/[a-f0-9]{64}$/.test(ticket.downloadPath)) {
      throw new Error('The download could not be prepared. Try downloading again.');
    }
    const link = document.createElement('a');
    link.href = `${apiBase}${ticket.downloadPath}`;
    link.download = currentJob.filename || 'audio.mp3';
    link.referrerPolicy = 'no-referrer';
    link.rel = 'noopener noreferrer';
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    connectionNotice('');
  } catch (error) {
    if (!error.cancelled && error.status !== 401) connectionNotice(error.message);
  } finally {
    if (generation === authGeneration) {
      downloadInFlight = false;
      updateControls();
    }
  }
});
downloadButton.addEventListener('keydown', (event) => {
  if (remoteMode && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    downloadButton.click();
  }
});

updateControls();
if (remoteMode && !apiBase) {
  remoteError('This page is missing its PC connection address. Update the published app configuration and reload.');
} else if (!remoteMode || accessCode) {
  accessInput.value = accessCode;
  connect();
}
