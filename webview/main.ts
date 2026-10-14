import type { DeviceButton, DeviceInfo, HostMessage, WebviewMessage } from '../shared/messages';
import { VideoRenderer } from './decoder';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();
const send = (msg: WebviewMessage) => vscode.postMessage(msg);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const select = $<HTMLSelectElement>('device');
const toggle = $<HTMLButtonElement>('toggle');
const canvas = $<HTMLCanvasElement>('screen');
const message = $<HTMLDivElement>('message');
const buttons = $<HTMLElement>('buttons');

let devices: DeviceInfo[] = [];
let activeId: string | null = null;
let video = { width: 0, height: 0 };

const renderer = new VideoRenderer(
  canvas,
  () => {
    showMessage('');
    canvas.focus();
  },
  () => send({ type: 'requestKeyFrame' }),
);

// ---- host messages ----

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'devices':
      devices = msg.devices;
      activeId = msg.activeId;
      renderDevices();
      break;
    case 'status':
      document.body.dataset.state = msg.state;
      if (msg.state === 'idle') {
        renderer.reset();
        video = { width: 0, height: 0 };
        showMessage(devices.some((d) => d.state === 'device') ? 'Select a device and press Start.' : noDevicesHint);
      } else if (msg.state === 'connecting' || msg.state === 'error') {
        renderer.reset();
        showMessage(msg.message ?? '', msg.state === 'error');
      }
      break;
    case 'stream':
      showMessage(`Waiting for video from ${msg.deviceName}…`);
      break;
    case 'session':
      video = { width: msg.width, height: msg.height };
      renderer.resize(msg.width, msg.height);
      break;
    case 'packet':
      if (!(msg.data instanceof Uint8Array)) {
        showMessage('Received a video packet in an unexpected format.', true);
        return;
      }
      renderer.push(msg.data, msg.key, msg.config, msg.pts);
      break;
  }
});

const noDevicesHint =
  'No devices found. Connect a device with USB debugging enabled, or start an emulator.';

function showMessage(text: string, error = false) {
  message.textContent = text;
  message.hidden = !text;
  message.classList.toggle('error', error);
}

function renderDevices() {
  const ids = devices.map((d) => `${d.id}:${d.state}`).join('|');
  if (select.dataset.ids !== ids) {
    select.dataset.ids = ids;
    select.replaceChildren(
      ...devices.map((d) => {
        const option = document.createElement('option');
        option.value = d.id;
        option.textContent = d.state === 'device' ? d.name : `${d.name} (${d.state})`;
        return option;
      }),
    );
    if (!devices.length) {
      const option = document.createElement('option');
      option.textContent = 'No devices';
      option.disabled = true;
      select.append(option);
    }
  }
  if (activeId) {
    select.value = activeId;
  }
  select.disabled = !devices.length;
  toggle.disabled = !devices.length && !activeId;
  toggle.textContent = activeId ? 'Stop' : 'Start';
  toggle.classList.toggle('primary', !activeId);
  if (!activeId && document.body.dataset.state !== 'error' && document.body.dataset.state !== 'connecting') {
    showMessage(devices.length ? 'Select a device and press Start.' : noDevicesHint);
  }
}

select.addEventListener('change', () => {
  if (activeId && select.value !== activeId) {
    send({ type: 'select', deviceId: select.value });
  }
});

toggle.addEventListener('click', () => {
  if (activeId) {
    send({ type: 'stop' });
  } else if (select.value) {
    send({ type: 'select', deviceId: select.value });
  }
});

// ---- toolbar buttons: press on pointerdown, release on pointerup so long-press works ----

buttons.addEventListener('pointerdown', (e) => {
  const target = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-button]');
  if (!target || !activeId) {
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

canvas.addEventListener('contextmenu', (e) => {
  // Right click = back, like scrcpy.
  e.preventDefault();
  if (activeId) {
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
  if (!activeId) {
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
  if (activeId && text && document.activeElement === canvas) {
    e.preventDefault();
    send({ type: 'text', text });
  }
});

function mods(e: KeyboardEvent) {
  return { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey };
}

send({ type: 'ready' });
