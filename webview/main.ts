import type { DeviceButton, DeviceInfo, HostMessage, ToolbarAction, WebviewMessage } from '../shared/messages';
import { icon, type IconName } from '../src/html';
import { VideoRenderer } from './decoder';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();
const send = (msg: WebviewMessage) => vscode.postMessage(msg);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const body = document.body;
const select = $<HTMLSelectElement>('device');
const deviceName = $<HTMLSpanElement>('device-name');
const deviceMeta = $<HTMLSpanElement>('device-meta');
const toggle = $<HTMLButtonElement>('toggle');
const canvas = $<HTMLCanvasElement>('screen');
const stage = $<HTMLElement>('stage');
const frame = $<HTMLDivElement>('device-frame');
const controls = $<HTMLElement>('controls');
const handle = $<HTMLDivElement>('handle');
const toast = $<HTMLDivElement>('toast');
const skeletonText = $<HTMLSpanElement>('skeleton-text');
const card = $<HTMLElement>('card');
const cardTitle = $<HTMLHeadingElement>('card-title');
const cardText = $<HTMLParagraphElement>('card-text');
const cardPrimary = $<HTMLButtonElement>('card-primary');
const cardSecondary = $<HTMLButtonElement>('card-secondary');
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
    if (body.classList.contains('controls-overlay')) reveal(2500);
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
      layout();
      break;
    case 'recording':
      setRecording(msg.since);
      return;
    case 'toggleStats':
      toggleStats();
      return;
    case 'toast':
      showToast(msg.text);
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

const readyDevices = () => state.devices.filter((d) => d.state === 'device');
const currentDevice = () => state.devices.find((d) => d.id === (state.activeId ?? select.value));

/** Card shown instead of the phone: what it says and what its buttons do. */
interface CardSpec {
  title: string;
  text: string;
  error?: boolean;
  primary?: { label: string; icon?: IconName; run: () => void };
  secondary?: { label: string; icon?: IconName; run: () => void };
}

let cardSpec: CardSpec | null = null;

function cardFor(): CardSpec | null {
  if (!state.surfaceActive) {
    return {
      title: 'Showing in another window',
      text: state.activeId
        ? `${state.deviceName || currentDevice()?.name || 'The device'} is mirrored in another tab or window.`
        : 'Running Devices is open in another tab or window.',
      primary: { label: 'Show here', run: () => send({ type: 'showHere' }) },
    };
  }
  if (state.status === 'error') {
    return {
      title: "Couldn't connect",
      text: state.statusMessage || 'Something went wrong while mirroring.',
      error: true,
      primary: { label: 'Try again', icon: 'refresh', run: startSelected },
      secondary: { label: 'Show log', icon: 'log', run: () => action('showLog') },
    };
  }
  if (state.status !== 'idle') {
    return null;
  }
  const ready = readyDevices();
  if (ready.length) {
    const name = currentDevice()?.name ?? ready[0].name;
    return {
      title: 'Ready to mirror',
      text: `${name} is connected.`,
      primary: { label: 'Start mirroring', icon: 'play', run: startSelected },
    };
  }
  if (state.devices.length) {
    return {
      title: 'Allow USB debugging',
      text: 'Unlock the phone and accept the "Allow USB debugging?" prompt.',
      primary: { label: 'Refresh', icon: 'refresh', run: () => send({ type: 'refresh' }) },
    };
  }
  return {
    title: 'Connect a device',
    text: 'Plug in an Android phone with USB debugging on, or pair one over Wi-Fi.',
    primary: { label: 'Pair over Wi-Fi', icon: 'wifi', run: () => action('pairWifi') },
    secondary: { label: 'Refresh', icon: 'refresh', run: () => send({ type: 'refresh' }) },
  };
}

function setCta(button: HTMLButtonElement, spec: CardSpec['primary']) {
  button.hidden = !spec;
  if (spec) {
    button.innerHTML = (spec.icon ? icon(spec.icon) : '') + `<span></span>`;
    button.querySelector('span')!.textContent = spec.label;
  }
}

function render() {
  const live = state.surfaceActive && state.status === 'streaming' && state.hasFrame;
  body.dataset.state = state.status;
  body.classList.toggle('live', live);
  for (const b of document.querySelectorAll<HTMLButtonElement>('.needs-stream')) {
    b.disabled = !live;
  }

  cardSpec = cardFor();
  body.dataset.view = cardSpec ? 'card' : 'device';
  card.hidden = !cardSpec;
  if (cardSpec) {
    card.classList.toggle('error', !!cardSpec.error);
    cardTitle.textContent = cardSpec.title;
    cardText.textContent = cardSpec.text;
    setCta(cardPrimary, cardSpec.primary);
    setCta(cardSecondary, cardSpec.secondary);
  } else {
    skeletonText.textContent =
      state.status === 'connecting'
        ? state.statusMessage || 'Connecting…'
        : `Waiting for ${state.deviceName || 'the device'}…`;
    layout();
  }
}

function renderDevices() {
  const ids = state.devices.map((d) => `${d.id}:${d.state}:${d.detail ?? ''}`).join('|');
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
  }
  if (state.activeId) {
    select.value = state.activeId;
  }
  const device = currentDevice();
  deviceName.textContent = device ? device.name : 'No device';
  deviceMeta.textContent = device
    ? device.state === 'device'
      ? device.detail ?? ''
      : device.state === 'unauthorized'
        ? 'Waiting for permission'
        : device.state
    : 'Connect with USB or Wi-Fi';
  body.classList.toggle('has-device', readyDevices().length > 0);

  const running = !!state.activeId;
  select.disabled = !state.devices.length;
  toggle.disabled = !readyDevices().length && !running;
  toggle.classList.toggle('running', running);
  const label = running ? 'Stop mirroring' : 'Start mirroring';
  toggle.dataset.tip = label;
  toggle.setAttribute('aria-label', label);
}

function startSelected() {
  const id = select.value || readyDevices()[0]?.id;
  if (id) {
    send({ type: 'select', deviceId: id });
  }
}

const action = (a: ToolbarAction) => send({ type: 'action', action: a });

select.addEventListener('change', () => {
  renderDevices();
  if (state.activeId && select.value !== state.activeId) {
    send({ type: 'select', deviceId: select.value });
  } else {
    render();
  }
});

toggle.addEventListener('click', () => {
  if (state.activeId) {
    send({ type: 'stop' });
  } else {
    startSelected();
  }
});

cardPrimary.addEventListener('click', () => cardSpec?.primary?.run());
cardSecondary.addEventListener('click', () => cardSpec?.secondary?.run());

document.querySelector('.topbar')!.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  if (target) {
    action(target.dataset.action as ToolbarAction);
  }
});

// ---- device frame sizing ----

const PAD = 14;
const GAP = 12;
const HANDLE = 22;

type ControlsMode = 'side' | 'below' | 'overlay';

/** Size of the control bar in one orientation (measured, since it depends on font and theme). */
function measureControls(orient: 'h' | 'v') {
  controls.dataset.orient = orient;
  return { w: controls.offsetWidth, h: controls.offsetHeight };
}

/** Largest phone (screen + bezel, video aspect ratio) that fits in w × h. */
function fitPhone(w: number, h: number) {
  const aspect = video.width && video.height ? video.width / video.height : 9 / 19.5;
  let bezel = 9;
  let screenW = 0;
  let screenH = 0;
  for (let i = 0; i < 2; i++) {
    screenH = Math.max(60, Math.min(h - 2 * bezel, (w - 2 * bezel) / aspect));
    screenW = screenH * aspect;
    bezel = Math.round(Math.min(11, Math.max(5, Math.min(screenW, screenH) * 0.035)));
  }
  return { screenW, screenH, bezel, w: screenW + 2 * bezel, h: screenH + 2 * bezel };
}

/**
 * The screen gets all the room. The controls only use space the phone can't:
 * beside it, below it, or, when there's none, an auto-hiding bar over the bottom edge.
 */
function layout() {
  body.classList.toggle('narrow', body.clientWidth < 340);
  if (body.dataset.view !== 'device') return;
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  const availW = W - 2 * PAD;
  const availH = H - 2 * PAD;
  const v = measureControls('v');
  const hz = measureControls('h');

  let phone = fitPhone(availW, availH);
  const spareX = availW - phone.w;
  const spareY = availH - phone.h;
  let mode: ControlsMode;
  let x: number;
  let y: number;
  let cx: number;
  let cy: number;
  let orient: 'h' | 'v' = 'h';
  let scale = 1;

  if (spareX >= v.w + GAP && v.h <= availH) {
    // Beside: keep the phone centered if both sides have room, else shift it left a little.
    mode = 'side';
    orient = 'v';
    const group = spareX >= 2 * (v.w + GAP) ? phone.w : phone.w + GAP + v.w;
    x = PAD + (availW - group) / 2;
    y = PAD + (availH - phone.h) / 2;
    cx = x + phone.w + GAP;
    cy = y + (phone.h - v.h) / 2;
  } else if (spareY >= hz.h + GAP) {
    mode = 'below';
    x = PAD + (availW - phone.w) / 2;
    y = PAD + (availH - phone.h - GAP - hz.h) / 2;
    scale = Math.min(1, availW / hz.w);
    cx = PAD + (availW - hz.w) / 2;
    cy = y + phone.h + GAP;
  } else {
    // No spare room: give up only a thin strip for the handle.
    mode = 'overlay';
    phone = fitPhone(availW, availH - HANDLE + PAD / 2);
    x = PAD + (availW - phone.w) / 2;
    y = PAD + (availH - HANDLE + PAD / 2 - phone.h) / 2;
    scale = Math.min(1, (W - 16) / hz.w);
    cx = (W - hz.w) / 2;
    cy = y + phone.h - hz.h - Math.max(10, phone.bezel + 10);
  }

  const screenRadius = Math.round(Math.min(phone.screenW, phone.screenH) * 0.085);
  frame.style.left = `${Math.round(x)}px`;
  frame.style.top = `${Math.round(y)}px`;
  frame.style.width = `${Math.round(phone.w)}px`;
  frame.style.height = `${Math.round(phone.h)}px`;
  frame.style.setProperty('--bezel', `${phone.bezel}px`);
  frame.style.setProperty('--screen-radius', `${screenRadius}px`);
  frame.style.setProperty('--frame-radius', `${screenRadius + phone.bezel}px`);

  controls.dataset.orient = orient;
  controls.style.left = `${Math.round(cx)}px`;
  controls.style.top = `${Math.round(cy)}px`;
  controls.style.scale = String(scale);
  for (const b of controls.querySelectorAll<HTMLElement>('[data-tip]')) {
    b.dataset.tipSide = orient === 'v' ? 'left' : 'top';
  }
  body.classList.toggle('controls-overlay', mode === 'overlay');
}

// ---- toast ----

let toastTimer: number | undefined;

function showToast(text: string) {
  clearTimeout(toastTimer);
  toast.textContent = text;
  toast.classList.add('visible');
  toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 3800);
}

// ---- auto-hide for the overlay control bar ----

let hideTimer: number | undefined;

function reveal(ms?: number) {
  clearTimeout(hideTimer);
  body.classList.add('reveal');
  if (ms) {
    hideTimer = window.setTimeout(() => body.classList.remove('reveal'), ms);
  }
}

function scheduleHide(ms = 700) {
  clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => body.classList.remove('reveal'), ms);
}

handle.addEventListener('pointerenter', () => reveal());
handle.addEventListener('click', () => reveal(4000));
controls.addEventListener('pointerenter', () => body.classList.contains('controls-overlay') && reveal());
controls.addEventListener('pointerleave', () => body.classList.contains('controls-overlay') && scheduleHide());
handle.addEventListener('pointerleave', (e) => {
  if (!controls.contains(e.relatedTarget as Node)) scheduleHide();
});

new ResizeObserver(() => layout()).observe(body);

// ---- recording indicator ----

let recordTimer: number | undefined;

function setRecording(since: number | null) {
  clearInterval(recordTimer);
  recordButton.classList.toggle('recording', since !== null);
  const label = since === null ? 'Record screen' : 'Stop recording';
  recordButton.dataset.tip = label;
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

// ---- device buttons: press on pointerdown, release on pointerup so long-press works ----

for (const container of [controls]) {
  container.addEventListener('pointerdown', (e) => {
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
}

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
