const MAX_BYTES = 100 * 1024 * 1024;
const API_BASE = (document.body.dataset.apiBase || '').replace(/\/+$/, '');

function api(path) {
  return `${API_BASE}${path}`;
}

const ACTION_LABELS = {
  home: 'Home',
  back: 'Back',
  recent: 'Recent apps',
  volumeUp: 'Volume up',
  volumeDown: 'Volume down',
  power: 'Power',
};

const state = {
  file: null,
  sessionId: null,
  expiresAt: null,
  timerId: null,
  ending: false,
};

const el = {
  dropzone: document.getElementById('dropzone'),
  apkInput: document.getElementById('apkInput'),
  fileInfo: document.getElementById('fileInfo'),
  startBtn: document.getElementById('startBtn'),
  uploadError: document.getElementById('uploadError'),
  mockNote: document.getElementById('mockNote'),
  sessionPill: document.getElementById('sessionPill'),
  sessionStatus: document.getElementById('sessionStatus'),
  timer: document.getElementById('timer'),
  screenPlaceholder: document.getElementById('screenPlaceholder'),
  placeholderTitle: document.getElementById('placeholderTitle'),
  placeholderHint: document.getElementById('placeholderHint'),
  streamFrame: document.getElementById('streamFrame'),
  endBtn: document.getElementById('endBtn'),
  log: document.getElementById('log'),
  controls: Array.from(document.querySelectorAll('[data-action]')),
};

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRemaining(milliseconds) {
  const totalSeconds = Math.ceil(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function shortId(id) {
  return id ? id.slice(0, 8) : '';
}

function setUploadError(message) {
  el.uploadError.textContent = message || '';
  el.uploadError.hidden = !message;
}

function log(message, tone = '') {
  const line = document.createElement('p');
  line.className = `log-line${tone ? ` ${tone}` : ''}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  el.log.prepend(line);
}

function setBusy(isBusy) {
  el.startBtn.disabled = isBusy || !state.file;
  el.startBtn.textContent = isBusy ? 'Starting…' : 'Start session';
}

function setControlsEnabled(enabled) {
  for (const button of el.controls) button.disabled = !enabled;
  el.endBtn.disabled = !enabled;
}

function validateFile(file) {
  if (!file) return 'Choose an APK file first.';
  if (!file.name.toLowerCase().endsWith('.apk')) return 'Only files ending in .apk are supported.';
  if (file.size === 0) return 'That file is empty.';
  if (file.size > MAX_BYTES) return 'APK must be 100 MB or smaller.';
  return null;
}

function selectFile(file) {
  state.file = null;
  el.fileInfo.hidden = true;

  const problem = validateFile(file);
  if (problem) {
    setUploadError(problem);
    setBusy(false);
    return;
  }

  setUploadError('');
  state.file = file;
  el.fileInfo.textContent = `${file.name} · ${formatBytes(file.size)}`;
  el.fileInfo.hidden = false;
  setBusy(false);
}

async function readResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

function startTimer() {
  clearInterval(state.timerId);

  const tick = () => {
    const remaining = Math.max(0, state.expiresAt - Date.now());
    el.timer.textContent = formatRemaining(remaining);
    el.timer.classList.toggle('expired', remaining === 0);

    if (remaining === 0) {
      log('Session time reached its limit.', 'error');
      endSession(true);
    }
  };

  tick();
  state.timerId = setInterval(tick, 1000);
}

function resetUI() {
  clearInterval(state.timerId);
  state.timerId = null;
  state.sessionId = null;
  state.expiresAt = null;
  state.ending = false;
  state.file = null;

  el.apkInput.value = '';
  el.fileInfo.hidden = true;
  el.timer.textContent = '--:--';
  el.timer.classList.remove('expired');
  el.sessionStatus.textContent = 'No active session';
  el.sessionPill.classList.remove('active');
  el.streamFrame.removeAttribute('src');
  el.streamFrame.hidden = true;
  el.screenPlaceholder.hidden = false;
  el.placeholderTitle.textContent = 'Your Android screen will appear here';
  el.placeholderHint.textContent = 'Upload an APK to begin';
  el.mockNote.hidden = false;

  setControlsEnabled(false);
  setBusy(false);
}

async function startSession() {
  if (!state.file || state.sessionId) return;

  setBusy(true);
  setUploadError('');

  try {
    const form = new FormData();
    form.append('apk', state.file, state.file.name);

    const response = await fetch(api('/api/session/start'), { method: 'POST', body: form });
    const data = await readResponse(response);

    state.sessionId = data.sessionId;
    state.expiresAt = Date.parse(data.expiresAt);
    state.ending = false;

    el.sessionStatus.textContent = `Session ${shortId(data.sessionId)}`;
    el.sessionPill.classList.add('active');
    el.mockNote.hidden = Boolean(data.dockerEnabled);
    setControlsEnabled(true);

    if (data.streamUrl) {
      el.streamFrame.src = data.streamUrl;
      el.streamFrame.hidden = false;
      el.screenPlaceholder.hidden = true;
    } else {
      el.placeholderTitle.textContent = 'Demo mode — stream placeholder';
      el.placeholderHint.textContent = 'Enable Docker to attach the ws-scrcpy stream';
    }

    startTimer();
    log(`Session started: ${data.sessionId}`, 'ok');

    if (data.preparedCommands?.length > 0) {
      log(`Prepared: ${data.preparedCommands[0]}`);
    }
  } catch (error) {
    setUploadError(error.message);
    log(error.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function sendAction(action) {
  if (!state.sessionId) return;

  try {
    const response = await fetch(api(`/api/session/${encodeURIComponent(state.sessionId)}/action`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const data = await readResponse(response);

    log(`${ACTION_LABELS[action] || action} → ${data.command}`, 'ok');
  } catch (error) {
    log(error.message, 'error');
  }
}

async function endSession(expired = false) {
  if (!state.sessionId || state.ending) return;

  state.ending = true;
  const id = state.sessionId;
  setControlsEnabled(false);
  clearInterval(state.timerId);

  try {
    const response = await fetch(api(`/api/session/${encodeURIComponent(id)}/stop`), {
      method: 'POST',
    });
    await readResponse(response);
    log(expired ? 'Session expired — resources cleaned up.' : `Session ${shortId(id)} ended.`, expired ? 'error' : 'ok');
  } catch (error) {
    log(error.message, 'error');
  } finally {
    resetUI();
  }
}

el.dropzone.addEventListener('click', () => el.apkInput.click());
el.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    el.apkInput.click();
  }
});

el.apkInput.addEventListener('change', (event) => {
  selectFile(event.target.files?.[0]);
});

el.dropzone.addEventListener('dragenter', (event) => {
  event.preventDefault();
  el.dropzone.classList.add('dragging');
});

el.dropzone.addEventListener('dragover', (event) => {
  event.preventDefault();
  el.dropzone.classList.add('dragging');
});

el.dropzone.addEventListener('dragleave', (event) => {
  if (!el.dropzone.contains(event.relatedTarget)) {
    el.dropzone.classList.remove('dragging');
  }
});

el.dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  el.dropzone.classList.remove('dragging');
  selectFile(event.dataTransfer?.files?.[0]);
});

el.startBtn.addEventListener('click', startSession);
el.endBtn.addEventListener('click', () => endSession(false));

for (const button of el.controls) {
  button.addEventListener('click', () => sendAction(button.dataset.action));
}

log('Ready. Docker mode is reported by the server on session start.');
