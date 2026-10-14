import type { DeviceButton, DeviceInfo, VideoCodec, WebviewMessage } from '../shared/messages';

// Every platform (Android now, iOS later) implements DeviceBackend. The view
// only talks to these interfaces, never to adb or scrcpy directly.

export interface MirrorOptions {
  maxSize: number;
  bitRate: number;
  maxFps: number;
  stayAwake: boolean;
}

export interface MirrorEvents {
  /** Stream is established; packets follow. */
  onStream(codec: VideoCodec, deviceName: string): void;
  /** Video size changed (first frame, rotation, fold). Expect a new config packet. */
  onSession(width: number, height: number): void;
  onPacket(data: Uint8Array, key: boolean, config: boolean, pts: number): void;
  /** Session ended; error is set if it ended unexpectedly. */
  onClose(error?: Error): void;
}

export type InputMessage = Extract<
  WebviewMessage,
  { type: 'pointer' | 'scroll' | 'key' | 'text' | 'button' | 'requestKeyFrame' | 'wake' }
>;

export interface MirrorSession {
  sendInput(input: InputMessage): void;
  /** Platform-native full-resolution screenshot, when the platform has no adb. */
  screenshot?(path: string): Promise<void>;
  dispose(): void;
}

export interface DeviceBackend {
  readonly platform: DeviceInfo['platform'];
  listDevices(): Promise<DeviceInfo[]>;
  startMirroring(deviceId: string, options: MirrorOptions, events: MirrorEvents): Promise<MirrorSession>;
}

export type { DeviceButton };
