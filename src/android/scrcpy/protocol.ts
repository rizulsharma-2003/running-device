// Wire format of scrcpy v5.0.1. The protocol is internal to scrcpy and changes
// between releases, so the server in resources/ must be exactly this version.
// References (tag v5.0.1): app/src/control_msg.c, app/src/demuxer.c, doc/develop.md

export const SCRCPY_VERSION = '5.0.1';
export const DEVICE_SERVER_PATH = '/data/local/tmp/scrcpy-server.jar';
export const DEVICE_NAME_FIELD_LENGTH = 64;
export const PACKET_HEADER_SIZE = 12;

export const CODEC_IDS: Record<number, 'h264' | 'h265' | 'av1'> = {
  0x68323634: 'h264',
  0x68323635: 'h265',
  0x00617631: 'av1',
};

const enum ControlType {
  InjectKeycode = 0,
  InjectText = 1,
  InjectTouchEvent = 2,
  InjectScrollEvent = 3,
  BackOrScreenOn = 4,
  ExpandNotificationPanel = 5,
  ExpandSettingsPanel = 6,
  CollapsePanels = 7,
  SetDisplayPower = 10,
  RotateDevice = 11,
  ResetVideo = 17,
}

export const enum KeyAction {
  Down = 0,
  Up = 1,
}

export const enum MotionAction {
  Down = 0,
  Up = 1,
  Move = 2,
}

/** A mouse pointer with only the primary button is injected as a finger. */
export const POINTER_ID_MOUSE = -1n;
const BUTTON_PRIMARY = 1;

export const Keycode = {
  HOME: 3,
  BACK: 4,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  TAB: 61,
  SPACE: 62,
  ENTER: 66,
  DEL: 67,
  PAGE_UP: 92,
  PAGE_DOWN: 93,
  ESCAPE: 111,
  FORWARD_DEL: 112,
  MOVE_HOME: 122,
  MOVE_END: 123,
  APP_SWITCH: 187,
} as const;

const MetaState = {
  SHIFT: 0x1 | 0x40,
  ALT: 0x2 | 0x10,
  CTRL: 0x1000 | 0x2000,
  META: 0x10000 | 0x20000,
};

/** Maps KeyboardEvent.code to an Android keycode. */
export function androidKeycode(code: string): number | undefined {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) {
    return 29 + letter[1].charCodeAt(0) - 65; // KEYCODE_A = 29
  }
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) {
    return 7 + Number(digit[1]); // KEYCODE_0 = 7
  }
  const named: Record<string, number> = {
    Enter: Keycode.ENTER,
    NumpadEnter: Keycode.ENTER,
    Backspace: Keycode.DEL,
    Delete: Keycode.FORWARD_DEL,
    Tab: Keycode.TAB,
    Escape: Keycode.BACK,
    Space: Keycode.SPACE,
    ArrowUp: Keycode.DPAD_UP,
    ArrowDown: Keycode.DPAD_DOWN,
    ArrowLeft: Keycode.DPAD_LEFT,
    ArrowRight: Keycode.DPAD_RIGHT,
    Home: Keycode.MOVE_HOME,
    End: Keycode.MOVE_END,
    PageUp: Keycode.PAGE_UP,
    PageDown: Keycode.PAGE_DOWN,
    Comma: 55,
    Period: 56,
    Backquote: 68,
    Minus: 69,
    Equal: 70,
    BracketLeft: 71,
    BracketRight: 72,
    Backslash: 73,
    Semicolon: 74,
    Quote: 75,
    Slash: 76,
  };
  return named[code];
}

export function metaState(mods: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean }): number {
  return (
    (mods.shift ? MetaState.SHIFT : 0) |
    (mods.ctrl ? MetaState.CTRL : 0) |
    (mods.alt ? MetaState.ALT : 0) |
    (mods.meta ? MetaState.META : 0)
  );
}

// ---- Control message serialization ----

function floatToU16fp(f: number): number {
  const clamped = Math.min(Math.max(f, 0), 1);
  return clamped >= 1 ? 0xffff : Math.floor(clamped * 0x10000);
}

function floatToI16fp(f: number): number {
  const clamped = Math.min(Math.max(f, -1), 1);
  const v = clamped >= 1 ? 0x7fff : Math.trunc(clamped * 0x8000);
  return v & 0xffff;
}

function writePosition(buf: Buffer, offset: number, x: number, y: number, width: number, height: number) {
  buf.writeInt32BE(Math.round(x), offset);
  buf.writeInt32BE(Math.round(y), offset + 4);
  buf.writeUInt16BE(width, offset + 8);
  buf.writeUInt16BE(height, offset + 10);
}

export function injectKeycode(action: KeyAction, keycode: number, repeat = 0, meta = 0): Buffer {
  const buf = Buffer.alloc(14);
  buf.writeUInt8(ControlType.InjectKeycode, 0);
  buf.writeUInt8(action, 1);
  buf.writeUInt32BE(keycode, 2);
  buf.writeUInt32BE(repeat, 6);
  buf.writeUInt32BE(meta, 10);
  return buf;
}

const INJECT_TEXT_MAX_LENGTH = 300;

export function injectText(text: string): Buffer {
  let bytes = Buffer.from(text, 'utf8');
  if (bytes.length > INJECT_TEXT_MAX_LENGTH) {
    // Truncate on a code point boundary.
    bytes = Buffer.from(bytes.subarray(0, INJECT_TEXT_MAX_LENGTH).toString('utf8').replace(/�+$/, ''), 'utf8');
  }
  const buf = Buffer.alloc(5 + bytes.length);
  buf.writeUInt8(ControlType.InjectText, 0);
  buf.writeUInt32BE(bytes.length, 1);
  bytes.copy(buf, 5);
  return buf;
}

export function injectTouch(
  action: MotionAction,
  pointerId: bigint,
  x: number,
  y: number,
  width: number,
  height: number,
  pressure: number,
): Buffer {
  const buf = Buffer.alloc(32);
  buf.writeUInt8(ControlType.InjectTouchEvent, 0);
  buf.writeUInt8(action, 1);
  buf.writeBigInt64BE(pointerId, 2);
  writePosition(buf, 10, x, y, width, height);
  buf.writeUInt16BE(floatToU16fp(pressure), 22);
  const isMouse = pointerId === POINTER_ID_MOUSE;
  const actionButton = isMouse && action !== MotionAction.Move ? BUTTON_PRIMARY : 0;
  const buttons = isMouse && action !== MotionAction.Up ? BUTTON_PRIMARY : 0;
  buf.writeUInt32BE(actionButton, 24);
  buf.writeUInt32BE(buttons, 28);
  return buf;
}

/** dx/dy are in "notches", clamped to [-16, 16] like the scrcpy client. */
export function injectScroll(x: number, y: number, width: number, height: number, dx: number, dy: number): Buffer {
  const buf = Buffer.alloc(21);
  buf.writeUInt8(ControlType.InjectScrollEvent, 0);
  writePosition(buf, 1, x, y, width, height);
  buf.writeUInt16BE(floatToI16fp(dx / 16), 13);
  buf.writeUInt16BE(floatToI16fp(dy / 16), 15);
  buf.writeUInt32BE(0, 17);
  return buf;
}

export function backOrScreenOn(action: KeyAction): Buffer {
  return Buffer.from([ControlType.BackOrScreenOn, action]);
}

export const expandNotificationPanel = () => Buffer.from([ControlType.ExpandNotificationPanel]);
export const expandSettingsPanel = () => Buffer.from([ControlType.ExpandSettingsPanel]);
export const collapsePanels = () => Buffer.from([ControlType.CollapsePanels]);
export const rotateDevice = () => Buffer.from([ControlType.RotateDevice]);
export const resetVideo = () => Buffer.from([ControlType.ResetVideo]);
export const setDisplayPower = (on: boolean) => Buffer.from([ControlType.SetDisplayPower, on ? 1 : 0]);
