import { ChildProcess, execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InputMessage } from '../backend';
import { findDevice, forwardPort } from './usbmux';
import { type TimedPoint, WdaClient } from './wda';

// iPhone touch control through WebDriverAgent (WDA), Apple's UI-testing based
// automation server. One-time setup builds WDA with the user's signing team;
// afterwards a runner is started per device whenever it's mirrored.

const WDA_REPO = 'https://github.com/appium/WebDriverAgent.git';
const WDA_PORT = 8100;

export interface SigningTeam {
  id: string;
  name: string;
  org: string;
}

interface BuildState {
  team: string;
  xctestrun: string;
}

export class WdaSetupError extends Error {
  constructor(
    message: string,
    readonly kind: 'locked' | 'untrusted' | 'noXcode' | 'build' | 'launch',
  ) {
    super(message);
  }
}

const run = (cmd: string, args: string[], opts: { cwd?: string; timeout?: number } = {}) =>
  new Promise<string>((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || stdout || err.message).toString().trim().split('\n').slice(-6).join('\n'))) : resolve(stdout),
    ),
  );

/** Apple Development signing teams available in the keychain. */
export async function signingTeams(): Promise<SigningTeam[]> {
  const pem = await run('security', ['find-certificate', '-a', '-c', 'Apple Development', '-p']).catch(() => '');
  const teams = new Map<string, SigningTeam>();
  for (const cert of pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []) {
    const subject = await new Promise<string>((resolve) => {
      const p = execFile('openssl', ['x509', '-noout', '-subject', '-nameopt', 'multiline'], (_e, out) => resolve(out ?? ''));
      p.stdin?.end(cert);
    });
    const field = (name: string) => new RegExp(`${name}\\s*=\\s*(.*)`).exec(subject)?.[1]?.trim();
    const id = field('organizationalUnitName');
    if (id) teams.set(id, { id, name: field('commonName') ?? id, org: field('organizationName') ?? '' });
  }
  return [...teams.values()];
}

export class WdaManager {
  private readonly root: string;
  private runners = new Map<string, DeviceControl>();

  constructor(
    storageDir: string,
    private readonly log: (line: string) => void,
  ) {
    this.root = join(storageDir, 'wda');
  }

  private get statePath() {
    return join(this.root, 'state.json');
  }

  get state(): BuildState | null {
    try {
      const s = JSON.parse(readFileSync(this.statePath, 'utf8')) as BuildState;
      return existsSync(s.xctestrun) ? s : null;
    } catch {
      return null;
    }
  }

  get isSetUp() {
    return !!this.state;
  }

  /** Downloads WDA and builds it for testing, signed with `team`. Takes a few minutes the first time. */
  async setUp(team: string, udid: string, progress: (message: string) => void): Promise<void> {
    try {
      await run('xcodebuild', ['-version']);
    } catch {
      throw new WdaSetupError('iPhone touch control needs Xcode. Install it from the App Store, open it once, then try again.', 'noXcode');
    }
    mkdirSync(this.root, { recursive: true });
    const src = join(this.root, 'src');
    if (!existsSync(join(src, 'WebDriverAgent.xcodeproj'))) {
      progress('Downloading WebDriverAgent…');
      rmSync(src, { recursive: true, force: true });
      await run('git', ['clone', '--depth', '1', WDA_REPO, src], { timeout: 5 * 60_000 });
    }

    // Bundle ids must be unique to the signing team.
    const prefix = `com.runningdevices.${team.toLowerCase()}`;
    const pbx = join(src, 'WebDriverAgent.xcodeproj', 'project.pbxproj');
    writeFileSync(
      pbx,
      readFileSync(pbx, 'utf8')
        .replace(/com\.[\w.]*?\.?WebDriverAgentRunner(?=;)/g, `${prefix}.WebDriverAgentRunner`)
        .replace(/com\.[\w.]*?\.?WebDriverAgentLib(?=;)/g, `${prefix}.WebDriverAgentLib`),
    );

    progress('Building WebDriverAgent (2–4 minutes the first time)…');
    const derived = join(this.root, `build-${team}`);
    await new Promise<void>((resolve, reject) => {
      const p = spawn('xcodebuild', [
        'build-for-testing',
        '-project', join(src, 'WebDriverAgent.xcodeproj'),
        '-scheme', 'WebDriverAgentRunner',
        '-destination', `id=${udid}`,
        '-derivedDataPath', derived,
        '-allowProvisioningUpdates',
        `DEVELOPMENT_TEAM=${team}`,
        'CODE_SIGN_STYLE=Automatic',
      ]);
      let tail = '';
      let compiled = 0;
      const onData = (d: Buffer) => {
        const text = d.toString();
        tail = (tail + text).slice(-6000);
        const n = (text.match(/^(CompileC|SwiftCompile|Ld|CodeSign) /gm) ?? []).length;
        if (n) {
          compiled += n;
          progress(`Building WebDriverAgent… (${compiled} steps)`);
        }
        if (/CodeSign /.test(text)) progress('Signing… if macOS asks for your keychain password, enter it and click Always Allow.');
      };
      p.stdout.on('data', onData);
      p.stderr.on('data', onData);
      p.on('exit', (code) => {
        if (code === 0) return resolve();
        const errors = tail.split('\n').filter((l) => /error:|No Account|No profiles|provisioning/i.test(l)).slice(-4).join('\n');
        this.log(tail);
        reject(new WdaSetupError(errors || `xcodebuild failed (${code})`, 'build'));
      });
    });

    const products = join(derived, 'Build', 'Products');
    const xctestrun = readdirSync(products).find((f) => f.endsWith('.xctestrun'));
    if (!xctestrun) throw new WdaSetupError('Build finished but no .xctestrun was produced.', 'build');
    writeFileSync(this.statePath, JSON.stringify({ team, xctestrun: join(products, xctestrun) } satisfies BuildState));
  }

  control(udid: string): DeviceControl | undefined {
    const c = this.runners.get(udid);
    return c?.ready ? c : undefined;
  }

  /** Starts (or reuses) the WDA runner for a device. */
  async start(udid: string): Promise<DeviceControl> {
    const existing = this.runners.get(udid);
    if (existing && !existing.closed) return existing.whenReady();
    const state = this.state;
    if (!state) throw new WdaSetupError('iPhone touch control is not set up yet.', 'launch');
    const control = new DeviceControl(udid, state.xctestrun, this.log);
    this.runners.set(udid, control);
    try {
      return await control.whenReady();
    } catch (err) {
      this.runners.delete(udid);
      throw err;
    }
  }

  stop(udid: string) {
    this.runners.get(udid)?.dispose();
    this.runners.delete(udid);
  }

  dispose() {
    for (const c of this.runners.values()) c.dispose();
    this.runners.clear();
  }
}

/** A running WDA for one device, plus the translation from mirror input to iOS gestures. */
export class DeviceControl {
  private proc: ChildProcess | null = null;
  private server: { close(): void } | null = null;
  private wda: WdaClient | null = null;
  private ready_: Promise<DeviceControl>;
  ready = false;
  closed = false;
  private size = { width: 393, height: 852 };
  /** Requests run one at a time, in order; the device handles one gesture at a time anyway. */
  private queue: Promise<unknown> = Promise.resolve();
  private path: TimedPoint[] = [];
  private pathStart = 0;
  private textBuffer = '';
  private textTimer: NodeJS.Timeout | undefined;
  private scroll = { dx: 0, dy: 0, x: 0, y: 0, timer: undefined as NodeJS.Timeout | undefined };

  constructor(
    private readonly udid: string,
    private readonly xctestrun: string,
    private readonly log: (line: string) => void,
  ) {
    this.ready_ = this.start();
  }

  whenReady() {
    return this.ready_;
  }

  private async start(): Promise<DeviceControl> {
    // A runner may already be up (e.g. from a previous window): just connect to it.
    if (await this.attach().catch(() => false)) {
      this.log('iPhone touch control: reusing the running WebDriverAgent');
      return this;
    }
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3 && !this.closed; attempt++) {
      try {
        return await this.launch();
      } catch (err) {
        lastError = err;
        // Locked / untrusted need the user; anything else is often a runner still shutting down.
        if (err instanceof WdaSetupError && (err.kind === 'locked' || err.kind === 'untrusted')) throw err;
        this.log(`iPhone touch control: launch attempt ${attempt} failed (${err instanceof Error ? err.message : err}); retrying`);
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** Connects to WDA on the device over USB. Resolves false if nothing answers. */
  private async attach(): Promise<boolean> {
    const deviceId = await findDevice(this.udid);
    if (deviceId === null) throw new Error('iPhone not found on USB');
    const fwd = await forwardPort(deviceId, WDA_PORT);
    const wda = new WdaClient(`http://127.0.0.1:${fwd.port}`);
    if (!(await wda.status())) {
      fwd.server.close();
      return false;
    }
    await wda.start();
    this.size = await wda.windowSize();
    this.server = fwd.server;
    this.wda = wda;
    this.ready = true;
    this.closed = false;
    this.log(`iPhone touch control ready (${this.size.width}×${this.size.height} pt)`);
    return true;
  }

  private launch(): Promise<DeviceControl> {
    const proc = spawn('xcodebuild', ['test-without-building', '-xctestrun', this.xctestrun, '-destination', `id=${this.udid}`]);
    this.proc = proc;
    return new Promise((resolve, reject) => {
      let output = '';
      let settled = false;
      const timer = setTimeout(() => fail(new WdaSetupError('WebDriverAgent did not start within 90 seconds.', 'launch')), 90_000);
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.kill();
        reject(err);
      };
      const onData = async (d: Buffer) => {
        output = (output + d.toString()).slice(-20000);
        if (/Unlock .* to Continue|device is locked/i.test(output)) {
          return fail(new WdaSetupError('Unlock your iPhone so touch control can start.', 'locked'));
        }
        if (/not trusted|Untrusted Developer|invalid code signature/i.test(output)) {
          return fail(
            new WdaSetupError(
              'On the iPhone, open Settings → General → VPN & Device Management, tap your developer account and tap Trust. Then try again.',
              'untrusted',
            ),
          );
        }
        if (!settled && /ServerURLHere->/.test(output)) {
          proc.stdout?.off('data', onData);
          proc.stderr?.off('data', onData);
          try {
            if (!(await this.attach())) throw new Error('WebDriverAgent started but is not answering over USB');
            settled = true;
            clearTimeout(timer);
            resolve(this);
          } catch (err) {
            fail(err instanceof Error ? err : new Error(String(err)));
          }
        }
      };
      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);
      proc.on('exit', () => {
        if (!settled) fail(new WdaSetupError(launchFailureReason(output), 'launch'));
        if (this.proc === proc) {
          this.ready = false;
          this.closed = true;
        }
      });
    });
  }

  private enqueue(fn: (wda: WdaClient) => Promise<unknown>) {
    const wda = this.wda;
    if (!wda) return;
    this.queue = this.queue.then(() => fn(wda)).catch((err) => this.log(`iPhone control: ${err.message}`));
  }

  /** Mirror coordinates (video pixels) → iOS points. */
  private toPoints(x: number, y: number, width: number, height: number) {
    // The video can be landscape while WDA still reports portrait points (or vice versa).
    const landscape = width > height;
    const w = landscape ? Math.max(this.size.width, this.size.height) : Math.min(this.size.width, this.size.height);
    const h = landscape ? Math.min(this.size.width, this.size.height) : Math.max(this.size.width, this.size.height);
    return { x: (x / width) * w, y: (y / height) * h };
  }

  handle(input: InputMessage) {
    switch (input.type) {
      case 'pointer': {
        const p = this.toPoints(input.x, input.y, input.width, input.height);
        if (input.action === 'down') {
          this.pathStart = Date.now();
          this.path = [{ ...p, t: 0 }];
        } else if (input.action === 'move' && this.path.length) {
          const t = Date.now() - this.pathStart;
          const last = this.path[this.path.length - 1];
          if (t - last.t >= 16) this.path.push({ ...p, t });
        } else if (input.action === 'up' && this.path.length) {
          this.path.push({ ...p, t: Date.now() - this.pathStart });
          this.finishGesture(this.path);
          this.path = [];
        }
        return;
      }
      case 'scroll': {
        // Wheel notches → a drag in the opposite direction, coalesced over a short window.
        const s = this.scroll;
        const p = this.toPoints(input.x, input.y, input.width, input.height);
        s.x = p.x;
        s.y = p.y;
        s.dx += input.dx;
        s.dy += input.dy;
        clearTimeout(s.timer);
        s.timer = setTimeout(() => {
          const dist = (n: number) => Math.max(-300, Math.min(300, n * 60));
          const from = { x: s.x, y: s.y, t: 0 };
          const to = { x: s.x + dist(s.dx), y: s.y + dist(s.dy), t: 140 };
          s.dx = s.dy = 0;
          this.enqueue((w) => w.gesture([from, { ...to, t: 70 }, to]));
        }, 90);
        return;
      }
      case 'text':
        this.textBuffer += input.text;
        clearTimeout(this.textTimer);
        this.textTimer = setTimeout(() => this.flushText(), 120);
        return;
      case 'key':
        if (input.action !== 'down') return;
        if (input.code === 'Backspace') this.typeKey('\b');
        else if (input.code === 'Enter' || input.code === 'NumpadEnter') this.typeKey('\n');
        else if (input.code === 'Tab') this.typeKey('\t');
        else if (input.code === 'Escape') this.enqueue((w) => w.home());
        return;
      case 'button':
        if (input.action === 'up') return;
        return this.button(input.button);
      default:
        return;
    }
  }

  private flushText() {
    const text = this.textBuffer;
    this.textBuffer = '';
    if (text) this.enqueue((w) => w.type(text));
  }

  private typeKey(ch: string) {
    this.textBuffer += ch;
    this.flushText();
  }

  private finishGesture(path: TimedPoint[]) {
    const first = path[0];
    const last = path[path.length - 1];
    const moved = Math.hypot(last.x - first.x, last.y - first.y);
    const duration = last.t;
    if (moved < 8 && duration < 450) {
      this.enqueue((w) => w.tap(first));
    } else if (moved < 8) {
      this.enqueue((w) => w.touchAndHold(first, duration / 1000));
    } else {
      // Keep at most ~24 points so the request stays small but the path's shape and speed survive.
      const step = Math.max(1, Math.ceil(path.length / 24));
      const sampled = path.filter((_, i) => i % step === 0 || i === path.length - 1);
      this.enqueue((w) => w.gesture(sampled));
    }
  }

  private button(button: string) {
    const { width: w, height: h } = this.size;
    const t = (x: number, y: number, ms: number): TimedPoint => ({ x, y, t: ms });
    switch (button) {
      case 'home':
        return this.enqueue((wda) => wda.home());
      case 'back': // iOS "back" is a swipe in from the left edge
        return this.enqueue((wda) => wda.gesture([t(1, h * 0.45, 0), t(w * 0.35, h * 0.45, 120), t(w * 0.75, h * 0.45, 260)]));
      case 'recents': // swipe up from the bottom and pause: the app switcher
        return this.enqueue((wda) => wda.gesture([t(w / 2, h - 2, 0), t(w / 2, h * 0.7, 250), t(w / 2, h * 0.62, 700)]));
      case 'notifications':
        return this.enqueue((wda) => wda.gesture([t(w * 0.2, 2, 0), t(w * 0.2, h * 0.55, 300)]));
      case 'volumeUp':
        return this.enqueue((wda) => wda.pressButton('volumeUp'));
      case 'volumeDown':
        return this.enqueue((wda) => wda.pressButton('volumeDown'));
      case 'power':
        return this.enqueue((wda) => wda.toggleLock());
      case 'rotate':
        return this.enqueue(async (wda) => {
          await wda.toggleOrientation();
          this.size = await wda.windowSize();
        });
    }
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.server?.close();
    this.proc?.kill();
  }
}

/** The human-readable reason from xcodebuild's noisy output. */
function launchFailureReason(output: string): string {
  const lines = output.split('\n').map((l) => l.trim());
  const described = lines
    .map((l) => /NSLocalizedDescription\s*=\s*"?([^";]+)/.exec(l)?.[1] ?? /^(?:Testing failed:|error:)\s*(.+)/i.exec(l)?.[1])
    .filter((l): l is string => !!l && !/result bundle/i.test(l));
  return described.slice(-2).join(' ') || 'WebDriverAgent stopped before it was ready.';
}
