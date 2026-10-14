import type { ChildProcess } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { connect, Socket } from 'node:net';
import type { DeviceButton, InputMessage, MirrorEvents, MirrorOptions, MirrorSession } from '../../backend';
import type { Adb } from '../adb';
import * as P from './protocol';
import { readVideoPackets } from '../../videoStream';
import { SocketReader } from './socketReader';

const CONNECT_ATTEMPTS = 100;
const CONNECT_RETRY_MS = 100;

/**
 * One mirroring session against one device, using scrcpy-server over an
 * `adb forward` tunnel:
 *   1. push server jar, 2. forward tcp:<port> -> localabstract:scrcpy_<scid>,
 *   3. start server via app_process, 4. connect video socket (wait for dummy
 *   byte), then control socket, 5. read device name + codec, 6. demux packets.
 */
export class ScrcpySession implements MirrorSession {
  private server: ChildProcess | null = null;
  private video: Socket | null = null;
  private control: Socket | null = null;
  private port = 0;
  private disposed = false;
  private serverLog = '';

  private constructor(
    private readonly adb: Adb,
    private readonly serial: string,
    private readonly events: MirrorEvents,
    private readonly log: (line: string) => void,
  ) {}

  static async start(
    adb: Adb,
    serial: string,
    serverJar: string,
    options: MirrorOptions,
    events: MirrorEvents,
    log: (line: string) => void = () => undefined,
  ): Promise<ScrcpySession> {
    const session = new ScrcpySession(adb, serial, events, log);
    try {
      await session.connect(serverJar, options);
    } catch (err) {
      session.teardown();
      throw err;
    }
    return session;
  }

  private async connect(serverJar: string, options: MirrorOptions) {
    const scid = randomInt(0, 0x7fffffff).toString(16).padStart(8, '0');

    this.log(`Pushing scrcpy-server ${P.SCRCPY_VERSION} to ${this.serial}`);
    await this.adb.push(this.serial, serverJar, P.DEVICE_SERVER_PATH);
    this.port = await this.adb.forward(this.serial, `localabstract:scrcpy_${scid}`);

    const args = [
      `scid=${scid}`,
      'log_level=info',
      'tunnel_forward=true',
      'audio=false',
      'video_codec=h264',
      'clipboard_autosync=false',
      `max_size=${options.maxSize}`,
      `video_bit_rate=${options.bitRate}`,
      `max_fps=${options.maxFps}`,
      ...(options.stayAwake ? ['stay_awake=true'] : []),
    ];
    this.server = this.adb.spawn([
      '-s', this.serial, 'shell',
      `CLASSPATH=${P.DEVICE_SERVER_PATH}`, 'app_process', '/', 'com.genymobile.scrcpy.Server',
      P.SCRCPY_VERSION, ...args,
    ]);
    const onOutput = (data: Buffer) => {
      const text = data.toString();
      this.serverLog = (this.serverLog + text).slice(-4000);
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) {
          this.log(line);
        }
      }
    };
    this.server.stdout?.on('data', onOutput);
    this.server.stderr?.on('data', onOutput);
    let serverExited = false;
    this.server.on('exit', (code) => {
      serverExited = true;
      this.log(`scrcpy-server exited (${code})`);
      this.fail(new Error(`Device server exited (code ${code}). ${this.lastServerError()}`));
    });

    // With a forward tunnel the TCP connect succeeds as soon as adb listens,
    // even before the server does. The server's dummy byte proves it's really there.
    let videoReader: SocketReader | null = null;
    for (let attempt = 0; attempt < CONNECT_ATTEMPTS && !this.disposed; attempt++) {
      if (serverExited) {
        throw new Error(`Device server exited before connecting. ${this.lastServerError()}`);
      }
      const socket = await openSocket(this.port);
      const reader = new SocketReader(socket);
      try {
        await reader.read(1);
        this.video = socket;
        videoReader = reader;
        break;
      } catch {
        socket.destroy();
        await delay(CONNECT_RETRY_MS);
      }
    }
    if (!videoReader || !this.video) {
      throw new Error(`Could not connect to the device server. ${this.lastServerError()}`);
    }
    this.control = await openSocket(this.port);
    this.control.on('data', () => undefined); // device messages (clipboard etc.) are not used yet
    this.control.on('error', (err) => this.fail(err));

    const meta = await videoReader.read(P.DEVICE_NAME_FIELD_LENGTH);
    const nul = meta.indexOf(0);
    const deviceName = meta.subarray(0, nul < 0 ? meta.length : nul).toString('utf8');

    const codecId = (await videoReader.read(4)).readUInt32BE(0);
    if (codecId === 0 || codecId === 1) {
      throw new Error(`Device could not start video capture. ${this.lastServerError()}`);
    }
    const codec = P.CODEC_IDS[codecId];
    if (!codec) {
      throw new Error(`Unsupported video codec id 0x${codecId.toString(16)}`);
    }
    this.log(`Streaming ${codec} from "${deviceName}"`);
    this.events.onStream(codec, deviceName);
    void this.readVideo(videoReader);
  }

  private async readVideo(reader: SocketReader) {
    try {
      await readVideoPackets(reader, this.events, () => this.disposed);
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  sendInput(input: InputMessage): void {
    const msg = this.encodeInput(input);
    for (const buf of msg) {
      this.control?.write(buf);
    }
  }

  private encodeInput(input: InputMessage): Buffer[] {
    switch (input.type) {
      case 'pointer': {
        const action =
          input.action === 'down' ? P.MotionAction.Down : input.action === 'up' ? P.MotionAction.Up : P.MotionAction.Move;
        const pointerId = input.pointerId < 0 ? P.POINTER_ID_MOUSE : BigInt(input.pointerId);
        return [P.injectTouch(action, pointerId, input.x, input.y, input.width, input.height, input.pressure)];
      }
      case 'scroll':
        return [P.injectScroll(input.x, input.y, input.width, input.height, input.dx, input.dy)];
      case 'text':
        return [P.injectText(input.text)];
      case 'key': {
        const keycode = P.androidKeycode(input.code);
        if (keycode === undefined) {
          return [];
        }
        const action = input.action === 'down' ? P.KeyAction.Down : P.KeyAction.Up;
        return [P.injectKeycode(action, keycode, input.repeat, P.metaState(input))];
      }
      case 'button':
        return encodeButton(input.button, input.action);
      case 'requestKeyFrame':
        return [P.resetVideo()];
      case 'wake':
        return [P.injectKeycode(P.KeyAction.Down, P.Keycode.WAKEUP), P.injectKeycode(P.KeyAction.Up, P.Keycode.WAKEUP)];
    }
  }

  private lastServerError(): string {
    const lines = this.serverLog.split(/\r?\n/).filter((l) => /ERROR|Exception|error/i.test(l));
    return lines.slice(-3).join(' ').trim();
  }

  private fail(err: Error) {
    if (this.disposed) {
      return;
    }
    this.teardown();
    this.events.onClose(err);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.teardown();
    this.events.onClose();
  }

  private teardown() {
    this.disposed = true;
    this.video?.destroy();
    this.control?.destroy();
    this.server?.kill();
    if (this.port) {
      void this.adb.removeForward(this.serial, this.port);
    }
  }
}

function encodeButton(button: DeviceButton, action: 'down' | 'up' | 'press'): Buffer[] {
  const actions = action === 'press' ? [P.KeyAction.Down, P.KeyAction.Up] : [action === 'down' ? P.KeyAction.Down : P.KeyAction.Up];
  const key = (keycode: number) => actions.map((a) => P.injectKeycode(a, keycode));
  switch (button) {
    case 'back':
      return actions.map((a) => P.backOrScreenOn(a));
    case 'home':
      return key(P.Keycode.HOME);
    case 'recents':
      return key(P.Keycode.APP_SWITCH);
    case 'power':
      return key(P.Keycode.POWER);
    case 'volumeUp':
      return key(P.Keycode.VOLUME_UP);
    case 'volumeDown':
      return key(P.Keycode.VOLUME_DOWN);
    case 'rotate':
      return action === 'up' ? [] : [P.rotateDevice()];
    case 'notifications':
      return action === 'up' ? [] : [P.expandNotificationPanel()];
  }
}

function openSocket(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port, noDelay: true });
    socket.once('connect', () => {
      socket.removeListener('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
