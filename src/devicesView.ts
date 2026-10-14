import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { DeviceInfo, HostMessage, WebviewMessage } from '../shared/messages';
import type { DeviceBackend, MirrorOptions, MirrorSession } from './backend';

const POLL_INTERVAL_MS = 2000;

/** The "Running Devices" webview: device picker, toolbar and the mirrored screen. */
export class DevicesViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'runningDevices.view';

  private view: vscode.WebviewView | null = null;
  private devices: DeviceInfo[] = [];
  private session: MirrorSession | null = null;
  private activeId: string | null = null;
  /** Incremented on every start/stop so stale async results are ignored. */
  private generation = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private autoStarted = new Set<string>();
  private lastListError = '';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly backends: DeviceBackend[],
    private readonly output: vscode.OutputChannel,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg: WebviewMessage) => this.onMessage(msg));
    view.onDidChangeVisibility(() => this.updatePolling());
    view.onDidDispose(() => {
      this.view = null;
      this.stop();
      this.updatePolling();
    });
    this.updatePolling();
  }

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
    this.post({ type: 'devices', devices, activeId: this.activeId });

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

  async start(deviceId: string): Promise<void> {
    this.stop();
    const device = this.devices.find((d) => d.id === deviceId);
    const backend = this.backends.find((b) => b.platform === device?.platform);
    if (!device || !backend) {
      return;
    }
    if (device.state !== 'device') {
      this.post({
        type: 'status',
        state: 'error',
        message:
          device.state === 'unauthorized'
            ? 'Device is unauthorized. Accept the USB debugging prompt on the device.'
            : `Device is ${device.state}.`,
      });
      return;
    }

    const generation = ++this.generation;
    this.activeId = deviceId;
    void vscode.commands.executeCommand('setContext', 'runningDevices.mirroring', true);
    this.post({ type: 'devices', devices: this.devices, activeId: deviceId });
    this.post({ type: 'status', state: 'connecting', message: `Connecting to ${device.name}…` });

    try {
      const session = await backend.startMirroring(deviceId, this.options(), {
        onStream: (codec, deviceName) => {
          if (generation === this.generation) {
            this.post({ type: 'stream', codec, deviceName });
            this.post({ type: 'status', state: 'streaming' });
          }
        },
        onSession: (width, height) => generation === this.generation && this.post({ type: 'session', width, height }),
        onPacket: (data, key, config, pts) =>
          generation === this.generation &&
          // Copy into a plain Uint8Array: a Node Buffer would be JSON-serialized via
          // Buffer#toJSON instead of being transferred as binary to the webview.
          this.post({ type: 'packet', data: new Uint8Array(data), key, config, pts }),
        onClose: (error) => {
          if (generation !== this.generation) {
            return;
          }
          this.session = null;
          this.activeId = null;
          void vscode.commands.executeCommand('setContext', 'runningDevices.mirroring', false);
          this.post({ type: 'devices', devices: this.devices, activeId: null });
          if (error) {
            this.output.appendLine(`Mirroring stopped: ${error.message}`);
            this.post({ type: 'status', state: 'error', message: error.message });
          } else {
            this.post({ type: 'status', state: 'idle' });
          }
        },
      });
      if (generation !== this.generation) {
        session.dispose();
        return;
      }
      this.session = session;
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`Could not start mirroring: ${message}`);
      this.activeId = null;
      void vscode.commands.executeCommand('setContext', 'runningDevices.mirroring', false);
      this.post({ type: 'devices', devices: this.devices, activeId: null });
      this.post({ type: 'status', state: 'error', message });
    }
  }

  stop(): void {
    this.generation++;
    const session = this.session;
    this.session = null;
    this.activeId = null;
    session?.dispose();
    void vscode.commands.executeCommand('setContext', 'runningDevices.mirroring', false);
    this.post({ type: 'devices', devices: this.devices, activeId: null });
    this.post({ type: 'status', state: 'idle' });
  }

  private onMessage(msg: WebviewMessage) {
    switch (msg.type) {
      case 'ready':
        void this.refresh();
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
      default:
        this.session?.sendInput(msg);
    }
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

  /** Poll for devices only while the view is visible. */
  private updatePolling() {
    const shouldPoll = !!this.view?.visible;
    if (shouldPoll && !this.pollTimer) {
      void this.refresh();
      this.pollTimer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
    } else if (!shouldPoll && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private post(msg: HostMessage) {
    void this.view?.webview.postMessage(msg);
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview.css'));
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${style}" rel="stylesheet">
</head>
<body>
  <header class="toolbar">
    <select id="device" title="Device"></select>
    <button id="toggle" class="primary">Start</button>
  </header>
  <nav class="toolbar buttons" id="buttons">
    <button data-button="back" title="Back (Esc)">◁</button>
    <button data-button="home" title="Home">○</button>
    <button data-button="recents" title="Overview">▢</button>
    <span class="sep"></span>
    <button data-button="volumeUp" title="Volume up">Vol+</button>
    <button data-button="volumeDown" title="Volume down">Vol−</button>
    <button data-button="power" title="Power">⏻</button>
    <button data-button="rotate" title="Rotate">⟳</button>
    <button data-button="notifications" title="Notifications">▾</button>
  </nav>
  <main id="stage">
    <canvas id="screen" tabindex="0"></canvas>
    <div id="message"></div>
  </main>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.stop();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
  }
}
