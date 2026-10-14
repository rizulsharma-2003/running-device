import * as vscode from 'vscode';
import type { DeviceInfo, FlutterAction, FlutterState, HostMessage, VideoCodec, WebviewMessage } from '../shared/messages';
import type { DeviceBackend, InputMessage, MirrorOptions, MirrorSession } from './backend';
import { Mp4Recorder } from './recorder';

const POLL_INTERVAL_MS = 2000;
const WAKE_MIN_INTERVAL_MS = 3000;

/** A webview that can show the device: the side bar view or an editor tab (which may live in its own window). */
export interface Surface {
  readonly visible: boolean;
  post(msg: HostMessage): void;
}

type Status = Extract<HostMessage, { type: 'status' }>;

/** Webview messages the controller doesn't handle itself (toolbar actions, file drops). */
export type ActionMessage = Extract<WebviewMessage, { type: 'action' | 'dropUris' | 'dropFile' }>;

export interface RecordingResult {
  path: string;
  saved: boolean;
  duration: number;
  /** Why recording stopped, if it wasn't the user. */
  reason?: string;
}

/**
 * Owns device discovery and the single mirroring session, independent of
 * where it's displayed. Device list and status go to every surface; the video
 * goes only to the active one, so moving between side bar, editor and window
 * doesn't restart the session.
 */
export class MirrorController implements vscode.Disposable {
  private surfaces: Surface[] = [];
  private active: Surface | null = null;

  private devices: DeviceInfo[] = [];
  private session: MirrorSession | null = null;
  private activeId: string | null = null;
  /** Incremented on every start/stop so stale async results are ignored. */
  private generation = 0;
  private status: Status = { type: 'status', state: 'idle' };
  private stream: Extract<HostMessage, { type: 'stream' }> | null = null;
  private videoSize: Extract<HostMessage, { type: 'session' }> | null = null;
  private config: Extract<HostMessage, { type: 'packet' }> | null = null;

  private pollTimer: NodeJS.Timeout | null = null;
  private autoStarted = new Set<string>();
  private lastListError = '';
  private lastWake = 0;
  private recorder: Mp4Recorder | null = null;
  private recordingSince: number | null = null;

  /** Set by the extension: handles toolbar actions and drops. */
  onAction: (msg: ActionMessage) => void = () => undefined;
  /** Flutter bar buttons. */
  onFlutter: (action: FlutterAction) => void = () => undefined;
  /** The mirrored device changed (or mirroring stopped). */
  onDeviceChanged: () => void = () => undefined;
  private flutterState: FlutterState | null = null;

  /** Handles the rotate button (needs adb, so it lives with the device actions). */
  onRotate: () => void = () => undefined;
  /** Called when a recording stops without the user asking (rotation, disconnect). */
  onRecordingStopped: (result: RecordingResult) => void = () => undefined;

  constructor(
    private readonly backends: DeviceBackend[],
    private readonly output: vscode.OutputChannel,
  ) {}

  // ---- surfaces ----

  /** Registers a surface. `takeOver` moves the stream to it (e.g. a newly opened editor tab). */
  attach(surface: Surface, takeOver: boolean) {
    this.surfaces.push(surface);
    if (takeOver || !this.active) {
      this.setActive(surface);
    }
    this.updatePolling();
  }

  detach(surface: Surface) {
    this.surfaces = this.surfaces.filter((s) => s !== surface);
    if (this.active === surface) {
      this.active = null;
      const fallback = this.surfaces[this.surfaces.length - 1];
      if (fallback) {
        this.setActive(fallback);
      }
    }
    this.updatePolling();
  }

  isActive(surface: Surface) {
    return this.active === surface;
  }

  /** Called when a surface's visibility changes. */
  updatePolling() {
    const shouldPoll = this.surfaces.some((s) => s.visible);
    if (shouldPoll && !this.pollTimer) {
      void this.refresh();
      this.pollTimer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
    } else if (!shouldPoll && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private setActive(surface: Surface) {
    const previous = this.active;
    this.active = surface;
    if (previous && previous !== surface) {
      previous.post({ type: 'surface', active: false });
    }
    this.sendState(surface);
  }

  /** Brings a surface fully up to date, including the current video config. */
  private sendState(surface: Surface) {
    const active = surface === this.active;
    surface.post({ type: 'surface', active });
    surface.post({ type: 'devices', devices: this.devices, activeId: this.activeId });
    surface.post(this.status);
    surface.post({ type: 'recording', since: this.recordingSince });
    surface.post({ type: 'flutter', state: this.flutterState });
    if (active && this.session) {
      if (this.stream) surface.post(this.stream);
      if (this.videoSize) surface.post(this.videoSize);
      if (this.config) surface.post(this.config);
      // The new decoder can only start from a key frame.
      this.session.sendInput({ type: 'requestKeyFrame' });
    }
  }

  private broadcast(msg: HostMessage) {
    for (const s of this.surfaces) {
      s.post(msg);
    }
  }

  private postVideo(msg: HostMessage) {
    this.active?.post(msg);
  }

  private setStatus(state: Status['state'], message?: string) {
    this.status = { type: 'status', state, message };
    this.broadcast(this.status);
  }

  onMessage(surface: Surface, msg: WebviewMessage) {
    switch (msg.type) {
      case 'ready':
        this.sendState(surface);
        void this.refresh();
        break;
      case 'showHere':
        this.setActive(surface);
        break;
      case 'select':
        void this.start(msg.deviceId);
        break;
      case 'stop':
        this.stop();
        break;
      case 'refresh':
        void this.refresh();
        break;
      case 'flutter':
        this.onFlutter(msg.action);
        break;
      case 'action':
      case 'dropUris':
      case 'dropFile':
        this.onAction(msg);
        break;
      case 'wake': {
        const now = Date.now();
        const enabled = vscode.workspace.getConfiguration('runningDevices').get('wakeOnHover', true);
        if (enabled && surface === this.active && now - this.lastWake >= WAKE_MIN_INTERVAL_MS) {
          this.lastWake = now;
          this.session?.sendInput(msg);
        }
        break;
      }
      default:
        if (surface !== this.active) {
          break;
        }
        if (msg.type === 'button' && msg.button === 'rotate') {
          if (msg.action !== 'up') this.onRotate();
          break;
        }
        this.session?.sendInput(msg);
    }
  }

  // ---- devices ----

  async refresh(): Promise<void> {
    const results = await Promise.allSettled(this.backends.map((b) => b.listDevices()));
    const devices: DeviceInfo[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') {
        devices.push(...r.value);
      } else if (r.reason?.message !== this.lastListError) {
        this.lastListError = r.reason?.message ?? String(r.reason);
        this.output.appendLine(`Device listing failed: ${this.lastListError}`);
      }
    }
    this.devices = devices;
    this.broadcast({ type: 'devices', devices, activeId: this.activeId });

    if (this.activeId && !devices.some((d) => d.id === this.activeId && d.state === 'device')) {
      this.output.appendLine(`Device ${this.activeId} disconnected`);
      this.stop();
    }
    this.maybeAutoStart();
  }

  private maybeAutoStart() {
    const ready = this.devices.filter((d) => d.state === 'device');
    // Forget devices that went away so they auto-start again when reconnected.
    for (const id of this.autoStarted) {
      if (!ready.some((d) => d.id === id)) {
        this.autoStarted.delete(id);
      }
    }
    const autoStart = vscode.workspace.getConfiguration('runningDevices').get<boolean>('autoStart', true);
    if (autoStart && !this.activeId && ready.length === 1 && !this.autoStarted.has(ready[0].id)) {
      this.autoStarted.add(ready[0].id);
      void this.start(ready[0].id);
    }
  }

  // ---- session ----

  async start(deviceId: string): Promise<void> {
    this.stop();
    const device = this.devices.find((d) => d.id === deviceId);
    const backend = this.backends.find((b) => b.platform === device?.platform);
    if (!device || !backend) {
      return;
    }
    if (device.state !== 'device') {
      this.setStatus(
        'error',
        device.state === 'unauthorized'
          ? 'Device is unauthorized. Accept the USB debugging prompt on the device.'
          : `Device is ${device.state}.`,
      );
      return;
    }

    const generation = ++this.generation;
    this.setActiveDevice(deviceId);
    this.setStatus('connecting', `Connecting to ${device.name}…`);

    try {
      const session = await backend.startMirroring(deviceId, this.options(), {
        onStream: (codec: VideoCodec, deviceName: string) => {
          if (generation !== this.generation) return;
          this.stream = { type: 'stream', codec, deviceName };
          this.postVideo(this.stream);
          this.setStatus('streaming');
        },
        onSession: (width, height) => {
          if (generation !== this.generation) return;
          this.videoSize = { type: 'session', width, height };
          this.config = null;
          this.postVideo(this.videoSize);
          if (this.recorder && !this.recorder.onSession(width, height)) {
            this.onRecordingStopped(this.stopRecording('The device rotated, so the recording was saved.')!);
          }
        },
        onPacket: (data, key, config, pts) => {
          if (generation !== this.generation) return;
          // Copy into a plain Uint8Array: a Node Buffer would be JSON-serialized via
          // Buffer#toJSON instead of being transferred as binary to the webview.
          const msg: HostMessage = { type: 'packet', data: new Uint8Array(data), key, config, pts };
          if (config) {
            this.config = msg;
          }
          this.recorder?.push(data, key, config, pts);
          this.postVideo(msg);
        },
        onClose: (error) => {
          if (generation !== this.generation) return;
          this.session = null;
          if (this.recorder) {
            this.onRecordingStopped(this.stopRecording('The device disconnected, so the recording was saved.')!);
          }
          this.clearStream();
          this.setActiveDevice(null);
          if (error) {
            this.output.appendLine(`Mirroring stopped: ${error.message}`);
            this.setStatus('error', error.message);
          } else {
            this.setStatus('idle');
          }
        },
      });
      if (generation !== this.generation) {
        session.dispose();
        return;
      }
      this.session = session;
    } catch (err) {
      if (generation !== this.generation) return;
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`Could not start mirroring: ${message}`);
      this.setActiveDevice(null);
      this.setStatus('error', message);
    }
  }

  stop(): void {
    if (this.recorder) {
      this.onRecordingStopped(this.stopRecording('Mirroring stopped, so the recording was saved.')!);
    }
    this.generation++;
    const session = this.session;
    this.session = null;
    session?.dispose();
    this.clearStream();
    this.setActiveDevice(null);
    this.setStatus('idle');
  }

  // ---- recording ----

  get activeDeviceId() {
    return this.activeId;
  }

  /** All known devices (latest poll). */
  get deviceList(): DeviceInfo[] {
    return this.devices;
  }

  /** The device being mirrored, with its platform and capabilities. */
  get activeDevice(): DeviceInfo | undefined {
    return this.devices.find((d) => d.id === this.activeId);
  }

  /** Screenshot through the mirroring session (platforms without adb). */
  async sessionScreenshot(path: string): Promise<boolean> {
    if (!this.session?.screenshot) return false;
    await this.session.screenshot(path);
    return true;
  }

  get isRecording() {
    return !!this.recorder;
  }

  startRecording(path: string) {
    if (!this.session) {
      throw new Error('Start mirroring a device first.');
    }
    if (this.recorder) {
      return;
    }
    this.recorder = new Mp4Recorder(path);
    this.recordingSince = Date.now();
    this.broadcast({ type: 'recording', since: this.recordingSince });
    // Restart the capture so the recording begins with a fresh session and key frame.
    this.session.sendInput({ type: 'requestKeyFrame' });
  }

  stopRecording(reason?: string): RecordingResult | null {
    const recorder = this.recorder;
    if (!recorder) {
      return null;
    }
    this.recorder = null;
    this.recordingSince = null;
    this.broadcast({ type: 'recording', since: null });
    const saved = recorder.finish();
    return { path: recorder.path, saved, duration: recorder.duration, reason };
  }

  /** Sends input straight to the device (used as a fallback by actions). */
  sendInput(msg: InputMessage) {
    this.session?.sendInput(msg);
  }

  setFlutter(state: FlutterState | null) {
    this.flutterState = state;
    this.broadcast({ type: 'flutter', state });
  }

  toast(text: string) {
    this.active?.post({ type: 'toast', text });
  }

  toggleStats() {
    this.active?.post({ type: 'toggleStats' });
  }

  private clearStream() {
    this.stream = null;
    this.videoSize = null;
    this.config = null;
  }

  private setActiveDevice(id: string | null) {
    this.activeId = id;
    void vscode.commands.executeCommand('setContext', 'runningDevices.mirroring', !!id);
    this.broadcast({ type: 'devices', devices: this.devices, activeId: id });
    this.onDeviceChanged();
  }

  private options(): MirrorOptions {
    const config = vscode.workspace.getConfiguration('runningDevices');
    return {
      maxSize: config.get('maxSize', 1600),
      bitRate: config.get('bitRate', 8_000_000),
      maxFps: config.get('maxFps', 60),
      stayAwake: config.get('stayAwake', true),
    };
  }

  dispose(): void {
    this.stop();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
  }
}
