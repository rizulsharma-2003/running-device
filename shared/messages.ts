// Messages exchanged between the extension host and the webview.
// Platform-agnostic on purpose: the webview only knows about video packets
// and normalized input, so an iOS backend can reuse the same UI.

export type Platform = 'android' | 'ios';

export interface DeviceInfo {
  id: string;
  name: string;
  platform: Platform;
  /** e.g. "device", "unauthorized", "offline" */
  state: string;
}

export type VideoCodec = 'h264' | 'h265' | 'av1';

/** Hardware-ish buttons shown in the toolbar. */
export type DeviceButton =
  | 'back'
  | 'home'
  | 'recents'
  | 'power'
  | 'volumeUp'
  | 'volumeDown'
  | 'rotate'
  | 'notifications';

export type PointerAction = 'down' | 'move' | 'up';

// ---- host -> webview ----

export type HostMessage =
  | { type: 'devices'; devices: DeviceInfo[]; activeId: string | null }
  | { type: 'status'; state: 'idle' | 'connecting' | 'streaming' | 'error'; message?: string }
  | { type: 'stream'; codec: VideoCodec; deviceName: string }
  | { type: 'session'; width: number; height: number }
  | { type: 'packet'; data: Uint8Array; key: boolean; config: boolean; pts: number };

// ---- webview -> host ----

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'select'; deviceId: string }
  | { type: 'stop' }
  | { type: 'refresh' }
  | {
      type: 'pointer';
      action: PointerAction;
      pointerId: number;
      /** Position in video pixels. */
      x: number;
      y: number;
      /** Current video size; the device ignores events sent for a stale size. */
      width: number;
      height: number;
      pressure: number;
    }
  | { type: 'scroll'; x: number; y: number; width: number; height: number; dx: number; dy: number }
  | { type: 'key'; action: 'down' | 'up'; code: string; repeat: number; shift: boolean; ctrl: boolean; alt: boolean; meta: boolean }
  | { type: 'text'; text: string }
  | { type: 'button'; button: DeviceButton; action: 'down' | 'up' | 'press' }
  | { type: 'requestKeyFrame' };
