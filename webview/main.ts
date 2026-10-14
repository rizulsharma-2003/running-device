import type { DeviceButton, DeviceInfo, HostMessage, ToolbarAction, WebviewMessage } from '../shared/messages';
import { VideoRenderer } from './decoder';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();
const send = (msg: WebviewMessage) => vscode.postMessage(msg);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const select = $<HTMLSelectElement>('device');
const toggle = $<HTMLButtonElement>('toggle');
const canvas = $<HTMLCanvasElement>('screen');
const overlay = $<HTMLDivElement>('overlay');
const message = $<HTMLParagraphElement>('message');
const showHere = $<HTMLButtonElement>('show-here');
const buttons = $<HTMLElement>('buttons');
const stage = $<HTMLElement>('stage');
const recordButton = $<HTMLButtonElement>('record');
const recordTime = $<HTMLSpanElement>('record-time');
const stats = $<HTMLDivElement>('stats');
const dropHint = $<HTMLDivElement>('drop-hint');

const state = {
  devices: [] as DeviceInfo[],
  activeId: null as string | null,
  status: 'idle' as Extract<HostMessage, { type: 'status' }>['state'],
  statusMessage: '',
  deviceName: '',
  /** False when another surface (editor tab, window) is showing the stream. */
  surfaceActive: true,
  hasFrame: false,
};
let video = { width: 0, height: 0 };

const renderer = new VideoRenderer(
  canvas,
  () => {
    state.hasFrame = true;
    render();
    canvas.focus();
  },
  () => send({ type: 'requestKeyFrame' }),
);

// ---- host messages ----

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'devices':
      state.devices = msg.devices;
      state.activeId = msg.activeId;
      renderDevices();
      break;
    case 'status':
      if (msg.state !== 'streaming') {
        resetVideo();
      }
      state.status = msg.state;
      state.statusMessage = msg.message ?? '';
      break;
    case 'surface':
      state.surfaceActive = msg.active;
      if (!msg.active) {
        resetVideo();
      }
      break;
    case 'stream':
      state.deviceName = msg.deviceName;
      break;
    case 'session':
      video = { width: msg.width, height: msg.height };
      renderer.resize(msg.width, msg.height);
      break;
    case 'recording':
      setRecording(msg.since);
      return;
    case 'toggleStats':
      toggleStats();
      return;
    case 'packet':
      bytesThisSecond += msg.data?.byteLength ?? 0;
      if (!(msg.data instanceof Uint8Array)) {
        state.status = 'error';
        state.statusMessage = 'Received a video packet in an unexpected format.';
        break;
      }
      renderer.push(msg.data, msg.key, msg.config, msg.pts);
      return; // hot path: nothing to re-render
  }
  render();
});

function resetVideo() {
  renderer.reset();
  state.hasFrame = false;
  video = { width: 0, height: 0 };
}

// ---- rendering ----

function render() {
  const live = state.surfaceActive && state.status === 'streaming';
  document.body.dataset.state = state.status;
  document.body.classList.toggle('live', live && state.hasFrame);
  document.body.classList.toggle('elsewhere', !state.surfaceActive);
  for (const b of document.querySelectorAll<HTMLButtonElement>('.needs-stream')) {
    b.disabled = !(live && state.hasFrame);
  }

  let text = '';
  let isError = false;
  if (!state.surfaceActive && state.activeId) {
    text = 'Showing in another tab or window.';
  } else if (!state.surfaceActive) {
    text = 'Running Devices is open in another tab or window.';
  } else if (state.status === 'error') {
    text = state.statusMessage;
    isError = true;
  } else if (state.status === 'connecting') {
    text = state.statusMessage || 'Connecting…';
  } else if (state.status === 'streaming' && !state.hasFrame) {
    text = `Waiting for video from ${state.deviceName || 'device'}…`;
  } else if (state.status === 'idle') {
    text = state.devices.length
      ? 'Select a device and press Start.'
      : 'No devices found. Connect a device with USB debugging enabled, or start an emulator.';
  }
  message.textContent = text;
  message.classList.toggle('error', isError);
  overlay.hidden = !text;
  showHere.hidden = state.surfaceActive;
}

function renderDevices() {
  const ids = state.devices.map((d) => `${d.id}:${d.state}`).join('|');
  if (select.dataset.ids !== ids) {
    select.dataset.ids = ids;
    select.replaceChildren(
      ...state.devices.map((d) => {
        const option = document.createElement('option');
        option.value = d.id;
        option.textContent = d.state === 'device' ? d.name : `${d.name} (${d.state})`;
        return option;
      }),
    );
    if (!state.devices.length) {
      const option = document.createElement('option');
      option.textContent = 'No devices';
      option.disabled = true;
      select.append(option);
    }
  }
  if (state.activeId) {
    select.value = state.activeId;
  }
  const running = !!state.activeId;
  select.disabled = !state.devices.length;
  toggle.disabled = !state.devices.length && !running;
  toggle.classList.toggle('running', running);
  const label = running ? 'Stop mirroring' : 'Start mirroring';
  toggle.title = label;
  toggle.setAttribute('aria-label', label);
}

select.addEventListener('change', () => {
  if (state.activeId && select.value !== state.activeId) {
    send({ type: 'select', deviceId: select.value });
  }
});

toggle.addEventListener('click', () => {
  if (state.activeId) {
    send({ type: 'stop' });
  } else if (select.value) {
    send({ type: 'select', deviceId: select.value });
  }
});

showHere.addEventListener('click', () => send({ type: 'showHere' }));

// ---- header actions: screenshot, record, more (handled by the extension) ----

document.querySelector('header')!.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  if (target) {
    send({ type: 'action', action: target.dataset.action as ToolbarAction });
  }
});

let recordTimer: number | undefined;

function setRecording(since: number | null) {
  clearInterval(recordTimer);
  recordButton.classList.toggle('recording', since !== null);
  const label = since === null ? 'Record screen' : 'Stop recording';
  recordButton.title = label;
  recordButton.setAttribute('aria-label', label);
  recordTime.textContent = '';
  if (since !== null) {
    const tick = () => {
      const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
      recordTime.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    recordTimer = window.setInterval(tick, 500);
  }
}

// ---- performance stats overlay ----

let framesThisSecond = 0;
let bytesThisSecond = 0;
let statsTimer: number | undefined;
renderer.onFrame = () => framesThisSecond++;

function toggleStats() {
  stats.hidden = !stats.hidden;
  clearInterval(statsTimer);
  framesThisSecond = 0;
  bytesThisSecond = 0;
  if (!stats.hidden) {
    stats.textContent = 'measuring…';
    statsTimer = window.setInterval(() => {
      const mbps = (bytesThisSecond * 8) / 1e6;
      stats.textContent = `${framesThisSecond} fps · ${mbps.toFixed(1)} Mbps · ${video.width}×${video.height}`;
      framesThisSecond = 0;
      bytesThisSecond = 0;
    }, 1000);
  }
}

// ---- drag & drop: APKs are installed, other files are copied to the device ----

let dragDepth = 0;
const hasFiles = (e: DragEvent) =>
  !!e.dataTransfer && [...e.dataTransfer.types].some((t) => t === 'Files' || t === 'text/uri-list' || t === 'application/vnd.code.uri-list');

stage.addEventListener('dragenter', (e) => {
  if (!hasFiles(e) || !state.activeId) return;
  e.preventDefault();
  dragDepth++;
  dropHint.hidden = false;
});
stage.addEventListener('dragover', (e) => {
  if (!hasFiles(e) || !state.activeId) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'copy';
});
stage.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dropHint.hidden = true;
  }
});
stage.addEventListener('drop', async (e) => {
  dragDepth = 0;
  dropHint.hidden = true;
  if (!e.dataTransfer || !state.activeId) return;
  e.preventDefault();
  // From VS Code's Explorer: URIs. From the OS: file contents.
  const uriList = e.dataTransfer.getData('application/vnd.code.uri-list') || e.dataTransfer.getData('text/uri-list');
  const uris = uriList
    .split(/\r?\n/)
    .map((u) => u.trim())
    .filter((u) => u && !u.startsWith('#'));
  if (uris.length) {
    send({ type: 'dropUris', uris });
    return;
  }
  for (const file of [...e.dataTransfer.files]) {
    send({ type: 'dropFile', name: file.name, data: new Uint8Array(await file.arrayBuffer()) });
  }
});

// ---- toolbar buttons: press on pointerdown, release on pointerup so long-press works ----

buttons.addEventListener('pointerdown', (e) => {
  const target = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-button]');
  if (!target || !state.activeId || !state.surfaceActive) {
    return;
  }
  const button = target.dataset.button as DeviceButton;
  target.setPointerCapture(e.pointerId);
  if (button === 'rotate' || button === 'notifications') {
    send({ type: 'button', button, action: 'press' });
    return;
  }
  send({ type: 'button', button, action: 'down' });
  const up = () => {
    send({ type: 'button', button, action: 'up' });
    target.removeEventListener('pointerup', up);
    target.removeEventListener('pointercancel', up);
  };
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', up);
});

// ---- touch / mouse on the screen ----

function toVideo(e: { clientX: number; clientY: number }) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * video.width,
    y: ((e.clientY - rect.top) / rect.height) * video.height,
  };
}

const activePointers = new Set<number>();

function sendPointer(e: PointerEvent, action: 'down' | 'move' | 'up') {
  if (!video.width) {
    return;
  }
  const { x, y } = toVideo(e);
  send({
    type: 'pointer',
    action,
    // Mouse and pen map to scrcpy's mouse pointer; real touches keep their ids (multi-touch).
    pointerId: e.pointerType === 'touch' ? e.pointerId : -1,
    x: Math.min(Math.max(x, 0), video.width),
    y: Math.min(Math.max(y, 0), video.height),
    width: video.width,
    height: video.height,
    pressure: action === 'up' ? 0 : e.pressure || 1,
  });
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) {
    return;
  }
  canvas.focus();
  canvas.setPointerCapture(e.pointerId);
  activePointers.add(e.pointerId);
  sendPointer(e, 'down');
  e.preventDefault();
});

canvas.addEventListener('pointermove', (e) => {
  if (activePointers.has(e.pointerId)) {
    for (const ev of e.getCoalescedEvents?.() ?? [e]) {
      sendPointer(ev, 'move');
    }
  }
});

const endPointer = (e: PointerEvent) => {
  if (activePointers.delete(e.pointerId)) {
    sendPointer(e, 'up');
  }
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

// Hovering over the screen wakes the device. The host throttles and checks the setting.
let lastWake = 0;
const wake = () => {
  const now = Date.now();
  if (state.activeId && state.surfaceActive && now - lastWake > 1000) {
    lastWake = now;
    send({ type: 'wake' });
  }
};
canvas.addEventListener('pointerenter', wake);
canvas.addEventListener('pointermove', wake);

canvas.addEventListener('contextmenu', (e) => {
  // Right click = back, like scrcpy.
  e.preventDefault();
  if (state.activeId) {
    send({ type: 'button', button: 'back', action: 'press' });
  }
});

canvas.addEventListener(
  'wheel',
  (e) => {
    if (!video.width) {
      return;
    }
    e.preventDefault();
    const scale = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 1 / 3 : 1 / 100;
    const { x, y } = toVideo(e);
    send({
      type: 'scroll',
      x,
      y,
      width: video.width,
      height: video.height,
      dx: -e.deltaX * scale,
      dy: -e.deltaY * scale,
    });
  },
  { passive: false },
);

// ---- keyboard: printable characters as text, everything else as key codes ----

const keysDown = new Set<string>();

canvas.addEventListener('keydown', (e) => {
  if (!state.activeId) {
    return;
  }
  const isShortcut = e.ctrlKey || e.metaKey || e.altKey;
  if (e.metaKey && e.code === 'KeyV') {
    return; // let the paste event deliver clipboard text
  }
  e.preventDefault();
  if (e.key.length === 1 && !isShortcut) {
    send({ type: 'text', text: e.key });
    return;
  }
  keysDown.add(e.code);
  send({ type: 'key', action: 'down', code: e.code, repeat: e.repeat ? 1 : 0, ...mods(e) });
});

canvas.addEventListener('keyup', (e) => {
  if (keysDown.delete(e.code)) {
    e.preventDefault();
    send({ type: 'key', action: 'up', code: e.code, repeat: 0, ...mods(e) });
  }
});

canvas.addEventListener('blur', () => {
  for (const code of keysDown) {
    send({ type: 'key', action: 'up', code, repeat: 0, shift: false, ctrl: false, alt: false, meta: false });
  }
  keysDown.clear();
});

document.addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text/plain');
  if (state.activeId && text && document.activeElement === canvas) {
    e.preventDefault();
    send({ type: 'text', text });
  }
});

function mods(e: KeyboardEvent) {
  return { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey };
}

render();
send({ type: 'ready' });
