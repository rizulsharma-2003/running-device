import { ChildProcess, execFile, spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeviceInfo } from '../../shared/messages';
import type { DeviceBackend, InputMessage, MirrorEvents, MirrorOptions, MirrorSession } from '../backend';
import { SocketReader } from '../android/scrcpy/socketReader';
import { readVideoPackets } from '../videoStream';
import { type DeviceControl, WdaManager, WdaSetupError } from './wdaManager';

// iPhone / iPad mirroring over USB (macOS only), through resources/ios-mirror.
// Touch control (optional) goes through WebDriverAgent; see wdaManager.ts.

interface CaptureDevice {
  /** AVFoundation capture device id (what the helper needs). */
  captureId: string;
  name: string;
}

interface DeviceDetails {
  udid: string;
  osVersion?: string;
}

const FRIENDLY_ERRORS: Record<string, string> = {
  'camera-denied':
    'macOS needs Camera access to capture an iPhone screen. Allow Visual Studio Code in System Settings → Privacy & Security → Camera, then try again.',
  'device-not-found': 'The iPhone was not found. Connect it with a USB cable, unlock it, and tap Trust if asked.',
  'device-disconnected': 'The iPhone was disconnected.',
};

/**
 * Makes sure the bundled helper can run: zip extraction can drop the executable
 * bit, and a quarantine flag would make macOS refuse an ad-hoc signed binary.
 */
export function prepareHelper(helper: string) {
  try {
    if ((statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
  } catch {
    // reported when spawning
  }
  execFile('xattr', ['-d', 'com.apple.quarantine', helper], () => undefined);
}

export class IosBackend implements DeviceBackend {
  readonly platform = 'ios' as const;
  private watcher: ChildProcess | null = null;
  private devices: CaptureDevice[] = [];
  /** By device name: UDID and iOS version from Xcode's devicectl (if installed). */
  private details = new Map<string, DeviceDetails>();
  private lookingUp = false;
  private disposed = false;

  /** Short user-facing notices (e.g. "touch control ready"). */
  onNotice: (text: string) => void = () => undefined;

  constructor(
    private readonly helper: string,
    readonly wda: WdaManager,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  static isSupported(helper: string) {
    return process.platform === 'darwin' && existsSync(helper);
  }

  async listDevices(): Promise<DeviceInfo[]> {
    this.ensureWatcher();
    return this.devices.map((d) => {
      const details = this.details.get(d.name);
      return {
        // Prefer the UDID: it's what Flutter and Xcode use, so sessions can be matched.
        id: details?.udid ?? d.captureId,
        name: d.name,
        platform: 'ios',
        state: 'device',
        detail: [details?.osVersion ? `iOS ${details.osVersion}` : 'iOS', 'USB', ...(details && this.wda.control(details.udid) ? [] : ['View only'])].join(' · '),
        controls: !!(details && this.wda.control(details.udid)),
      };
    });
  }

  private captureIdFor(id: string) {
    const byUdid = [...this.details].find(([, d]) => d.udid === id)?.[0];
    return (byUdid && this.devices.find((d) => d.name === byUdid)?.captureId) ?? id;
  }

  async startMirroring(deviceId: string, options: MirrorOptions, events: MirrorEvents): Promise<MirrorSession> {
    const name = this.devices.find((d) => d.captureId === this.captureIdFor(deviceId))?.name ?? 'iPhone';
    const session = await IosSession.start(this.helper, this.captureIdFor(deviceId), name, options, events, this.log);
    // Look the control up per input: it may be started later (setup, restart) from elsewhere.
    session.controlFor = () => {
      const udid = this.details.get(name)?.udid;
      return udid ? this.wda.control(udid) : undefined;
    };
    const udid = this.details.get(name)?.udid;
    if (udid && this.wda.isSetUp) void this.startControl(udid);
    return session;
  }

  /** Starts touch control for a mirrored iPhone (WDA must already be built). */
  async startControl(udid: string) {
    try {
      await this.wda.start(udid);
      this.onNotice('Touch control is on: click to tap, drag to swipe, type to enter text.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`iPhone touch control unavailable: ${message}`);
      this.onNotice(err instanceof WdaSetupError ? message : `Touch control couldn't start: ${message}`);
    }
  }

  udidFor(id: string): string | undefined {
    return [...this.details.values()].find((d) => d.udid === id)?.udid;
  }

  private ensureWatcher() {
    if (this.watcher || this.disposed) return;
    const proc = spawn(this.helper, ['watch'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.watcher = proc;
    let partial = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      const lines = (partial + chunk.toString()).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const list = JSON.parse(line).devices as { id: string; name: string }[];
          this.devices = list.map((d) => ({ captureId: d.id, name: d.name }));
          if (this.devices.some((d) => !this.details.has(d.name))) void this.lookUpDetails();
        } catch {
          // ignore partial / non-JSON lines
        }
      }
    });
    proc.stderr.on('data', (d: Buffer) => this.log(`[ios-mirror] ${d.toString().trim()}`));
    proc.on('exit', (code) => {
      this.watcher = null;
      this.devices = [];
      if (!this.disposed) {
        this.log(`ios-mirror watcher exited (${code}); restarting`);
        setTimeout(() => this.ensureWatcher(), 3000);
      }
    });
  }

  /** UDID + iOS version via `xcrun devicectl` (part of Xcode). Optional: without it we use capture ids. */
  private async lookUpDetails() {
    if (this.lookingUp) return;
    this.lookingUp = true;
    const out = join(tmpdir(), `running-devices-devicectl-${process.pid}.json`);
    try {
      await new Promise<void>((resolve, reject) =>
        execFile('xcrun', ['devicectl', 'list', 'devices', '--json-output', out], { timeout: 20_000 }, (err) =>
          err ? reject(err) : resolve(),
        ),
      );
      const json = JSON.parse(readFileSync(out, 'utf8'));
      for (const d of json.result?.devices ?? []) {
        const name = d.deviceProperties?.name;
        const udid = d.hardwareProperties?.udid;
        if (name && udid && d.hardwareProperties?.reality !== 'simulated') {
          this.details.set(name, { udid, osVersion: d.deviceProperties?.osVersionNumber });
        }
      }
    } catch (err) {
      this.log(`devicectl lookup skipped: ${err instanceof Error ? err.message : err}`);
    } finally {
      rmSync(out, { force: true });
      this.lookingUp = false;
    }
  }

  dispose() {
    this.disposed = true;
    this.wda.dispose();
    this.watcher?.stdin?.end();
    this.watcher?.kill();
  }
}

class IosSession implements MirrorSession {
  /** Touch control for this device, if WebDriverAgent is running for it. */
  controlFor: () => DeviceControl | undefined = () => undefined;
  private disposed = false;
  private stderrLines: string[] = [];
  private snapshotWaiters = new Map<string, (error?: string) => void>();

  private constructor(
    private readonly proc: ChildProcess,
    private readonly events: MirrorEvents,
    private readonly log: (line: string) => void,
  ) {}

  static async start(
    helper: string,
    captureId: string,
    name: string,
    options: MirrorOptions,
    events: MirrorEvents,
    log: (line: string) => void,
  ): Promise<IosSession> {
    const proc = spawn(
      helper,
      ['stream', captureId, '--max-size', String(options.maxSize), '--bit-rate', String(options.bitRate), '--max-fps', String(options.maxFps)],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const session = new IosSession(proc, events, log);
    session.listen();
    log(`Streaming ${name} via ios-mirror`);
    events.onStream('h264', name);
    void session.readVideo(new SocketReader(proc.stdout!));
    return session;
  }

  private listen() {
    let partial = '';
    this.proc.stderr!.on('data', (chunk: Buffer) => {
      const lines = (partial + chunk.toString()).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines.filter(Boolean)) {
        this.log(`[ios-mirror] ${line}`);
        this.stderrLines = [...this.stderrLines.slice(-20), line];
        const snap = /^@snapshot (ok|error) (.*)$/.exec(line);
        if (snap) {
          const waiter = [...this.snapshotWaiters.values()][0];
          const key = [...this.snapshotWaiters.keys()][0];
          if (key) this.snapshotWaiters.delete(key);
          waiter?.(snap[1] === 'ok' ? undefined : snap[2]);
        }
      }
    });
    this.proc.on('exit', (code) => {
      if (this.disposed) return;
      const err = this.stderrLines.map((l) => /^@error (.*)$/.exec(l)?.[1]).filter(Boolean).pop();
      this.fail(new Error(FRIENDLY_ERRORS[err ?? ''] ?? err ?? `iPhone capture stopped (code ${code}).`));
    });
  }

  private async readVideo(reader: SocketReader) {
    try {
      await readVideoPackets(reader, this.events, () => this.disposed);
    } catch {
      // The exit handler reports why the helper stopped.
    }
  }

  sendInput(input: InputMessage): void {
    if (input.type === 'requestKeyFrame') {
      this.proc.stdin?.write('k\n');
      return;
    }
    this.controlFor()?.handle(input);
  }

  /** Full-resolution PNG straight from the capture (not the scaled stream). */
  screenshot(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.snapshotWaiters.delete(path);
        reject(new Error('Timed out. Unlock the iPhone so it sends frames, then try again.'));
      }, 6000);
      this.snapshotWaiters.set(path, (error) => {
        clearTimeout(timer);
        error ? reject(new Error(error)) : resolve();
      });
      this.proc.stdin?.write(`s ${path}\n`);
    });
  }

  private fail(err: Error) {
    if (this.disposed) return;
    this.disposed = true;
    this.events.onClose(err);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.proc.stdin?.end();
    setTimeout(() => this.proc.kill(), 1000);
    this.events.onClose();
  }
}
