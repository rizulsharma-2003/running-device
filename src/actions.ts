import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import * as vscode from 'vscode';
import { SettingsBlockedError, type DeviceTools } from './android/deviceTools';
import { openLogcat } from './logcat';
import type { ActionMessage, MirrorController, RecordingResult } from './mirrorController';
import { pairWithCode, pairWithQrCode, switchToWifi } from './wifi';

interface Target {
  serial: string;
  name: string;
}

type MenuItem = vscode.QuickPickItem & { run?: () => unknown };

const isMac = process.platform === 'darwin';
const revealLabel = isMac ? 'Reveal in Finder' : process.platform === 'win32' ? 'Show in Explorer' : 'Show in Folder';

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Everything beyond mirroring: capture, apps, files, logcat, quick settings and Wi-Fi. */
export class DeviceActions {
  constructor(
    private readonly controller: MirrorController,
    private readonly tools: DeviceTools,
    private readonly extensionUri: vscode.Uri,
  ) {
    controller.onAction = (msg) => void this.handleWebviewAction(msg);
    controller.onRecordingStopped = (result) => void this.announceRecording(result);
    controller.onRotate = () => void this.rotate();
  }

  register(): vscode.Disposable[] {
    const cmd = (id: string, fn: (...args: any[]) => unknown) =>
      vscode.commands.registerCommand(`runningDevices.${id}`, async (...args: any[]) => {
        try {
          await fn(...args);
        } catch (err) {
          void vscode.window.showErrorMessage(errorMessage(err));
        }
      });
    return [
      cmd('screenshot', () => this.screenshot()),
      cmd('toggleRecording', () => this.toggleRecording()),
      cmd('installApk', (uri?: vscode.Uri, uris?: vscode.Uri[]) => this.installApks(uris?.length ? uris : uri ? [uri] : undefined)),
      cmd('pushFile', (uri?: vscode.Uri, uris?: vscode.Uri[]) => this.pushFiles(uris?.length ? uris : uri ? [uri] : undefined)),
      cmd('logcat', () => this.logcat(true)),
      cmd('logcatAll', () => this.logcat(false)),
      cmd('launchApp', () => this.launchApp()),
      cmd('openDeepLink', () => this.openDeepLink()),
      cmd('appActions', () => this.appActions()),
      cmd('quickSettings', () => this.quickSettings()),
      cmd('toggleStats', () => this.controller.toggleStats()),
      cmd('pairWifiQr', () => pairWithQrCode(this.tools, this.extensionUri, (a) => this.onWifiConnected(a))),
      cmd('pairWifiCode', () => pairWithCode(this.tools, (a) => this.onWifiConnected(a))),
      cmd('switchToWifi', () => this.switchToWifi()),
      cmd('connectWifi', () => this.connectWifi()),
      cmd('more', () => this.moreMenu()),
    ];
  }

  // ---- target device ----

  private async target(): Promise<Target | undefined> {
    const devices = (await this.tools.adb.devices()).filter((d) => d.state === 'device');
    const name = (serial: string) => devices.find((d) => d.serial === serial)?.model ?? serial;
    const active = this.controller.activeDeviceId;
    if (active) {
      return { serial: active, name: name(active) };
    }
    if (!devices.length) {
      void vscode.window.showWarningMessage('No Android device is connected.');
      return undefined;
    }
    if (devices.length === 1) {
      return { serial: devices[0].serial, name: name(devices[0].serial) };
    }
    const pick = await vscode.window.showQuickPick(
      devices.map((d) => ({ label: d.model ?? d.serial, description: d.serial, serial: d.serial })),
      { title: 'Choose a device' },
    );
    return pick && { serial: pick.serial, name: pick.label };
  }

  // ---- capture ----

  private captureFolder(): string {
    const configured = vscode.workspace.getConfiguration('runningDevices').get<string>('captureFolder', '').trim();
    let folder = configured
      ? configured
          .replace(/^~(?=$|[\\/])/, homedir())
          .replace('${workspaceFolder}', vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir())
      : join(homedir(), 'Desktop');
    if (!configured && !existsSync(folder)) {
      folder = homedir();
    }
    mkdirSync(folder, { recursive: true });
    return folder;
  }

  private captureName(prefix: string, device: string, ext: string) {
    const stamp = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
    return join(this.captureFolder(), `${prefix}_${device.replace(/[^\w-]+/g, '-')}_${stamp}.${ext}`);
  }

  async screenshot() {
    const target = await this.target();
    if (!target) return;
    const png = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Taking screenshot…' },
      () => this.tools.screenshot(target.serial),
    );
    const path = this.captureName('Screenshot', target.name, 'png');
    writeFileSync(path, png);
    await this.announceCapture(path, `Screenshot saved: ${basename(path)}`, true);
  }

  async toggleRecording() {
    if (this.controller.isRecording) {
      const result = this.controller.stopRecording();
      if (result) await this.announceRecording(result);
      return;
    }
    if (!this.controller.activeDeviceId) {
      void vscode.window.showWarningMessage('Start mirroring a device to record its screen.');
      return;
    }
    const target = await this.target();
    if (!target) return;
    this.controller.startRecording(this.captureName('Recording', target.name, 'mp4'));
  }

  private async announceRecording(result: RecordingResult) {
    if (!result.saved) {
      rmSync(result.path, { force: true });
      void vscode.window.showWarningMessage(result.reason ?? 'Nothing was recorded.');
      return;
    }
    const length = `${Math.round(result.duration)}s`;
    await this.announceCapture(result.path, `${result.reason ? result.reason + ' ' : ''}Recording saved (${length}): ${basename(result.path)}`, false);
  }

  private async announceCapture(path: string, message: string, isImage: boolean) {
    const uri = vscode.Uri.file(path);
    if (vscode.workspace.getConfiguration('runningDevices').get('openCaptures', true)) {
      void vscode.commands.executeCommand('vscode.open', uri, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    }
    const actions = [revealLabel, ...(isImage && (isMac || process.platform === 'win32') ? ['Copy Image'] : []), 'Copy Path'];
    const choice = await vscode.window.showInformationMessage(message, ...actions);
    if (choice === revealLabel) {
      void vscode.commands.executeCommand('revealFileInOS', uri);
    } else if (choice === 'Copy Path') {
      await vscode.env.clipboard.writeText(path);
    } else if (choice === 'Copy Image') {
      await copyImageToClipboard(path).catch((err) => vscode.window.showErrorMessage(`Could not copy image: ${errorMessage(err)}`));
    }
  }

  // ---- rotation ----

  private rotating = false;

  /** Rotates, then explains if the app in front kept the screen from turning. */
  async rotate() {
    const serial = this.controller.activeDeviceId;
    if (!serial || this.rotating) return;
    this.rotating = true;
    try {
      if ((await this.tools.sdk(serial)) < 29) {
        // No `wm user-rotation` before Android 10: use the mirror server's rotation.
        this.controller.sendInput({ type: 'button', button: 'rotate', action: 'press' });
        return;
      }
      // An app pinned to one orientation wins over any rotation request, so say so
      // right away instead of changing a setting that would surprise later.
      const [lock, pkg] = await Promise.all([this.tools.orientationLock(serial), this.tools.foregroundApp(serial)]);
      if (lock) {
        const last = pkg?.split('.').pop();
        const app = last ? last[0].toUpperCase() + last.slice(1) : 'This app';
        this.controller.toast(`${app} is locked to ${lock}, so the screen can't rotate.`);
        return;
      }
      if (!(await this.tools.rotate(serial))) {
        this.controller.toast("The screen didn't rotate. The current app may not support it.");
      }
    } catch (err) {
      this.controller.toast(`Couldn't rotate: ${errorMessage(err)}`);
    } finally {
      this.rotating = false;
    }
  }

  // ---- files ----

  async installApks(uris?: vscode.Uri[]) {
    uris ??= await vscode.window.showOpenDialog({
      title: 'Install APK on device',
      canSelectMany: true,
      filters: { 'Android package': ['apk'] },
    });
    if (!uris?.length) return;
    const target = await this.target();
    if (!target) return;
    for (const uri of uris) {
      await this.installOne(target, uri.fsPath, basename(uri.fsPath));
    }
  }

  private async installOne(target: Target, path: string, label: string) {
    const before = await this.packagePaths(target.serial);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Installing ${label} on ${target.name}…` },
      () => this.tools.install(target.serial, path),
    );
    // A (re)install moves the APK to a new directory, which tells us its package name.
    const after = await this.packagePaths(target.serial);
    const pkg = [...after].find(([p, apk]) => before.get(p) !== apk)?.[0];
    const choice = await vscode.window.showInformationMessage(`Installed ${pkg ?? label} on ${target.name}.`, ...(pkg ? ['Launch'] : []));
    if (choice === 'Launch' && pkg) {
      await this.tools.launch(target.serial, pkg);
    }
  }

  private async packagePaths(serial: string): Promise<Map<string, string>> {
    const out = await this.tools.adb.shell(serial, 'pm list packages -f -3').catch(() => '');
    const map = new Map<string, string>();
    for (const line of out.split(/\r?\n/)) {
      const m = /^package:(.+)=([\w.]+)\s*$/.exec(line.trim());
      if (m) map.set(m[2], m[1]);
    }
    return map;
  }

  async pushFiles(uris?: vscode.Uri[]) {
    uris ??= await vscode.window.showOpenDialog({ title: 'Copy files to device', canSelectMany: true });
    if (!uris?.length) return;
    const target = await this.target();
    if (!target) return;
    for (const uri of uris) {
      await this.pushOne(target, uri.fsPath);
    }
  }

  private async pushOne(target: Target, path: string) {
    const remote = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Copying ${basename(path)} to ${target.name}…` },
      () => this.tools.push(target.serial, path),
    );
    void vscode.window.showInformationMessage(`Copied to ${remote}`);
  }

  /** Files dropped on the mirrored screen: APKs are installed, anything else goes to Downloads. */
  private async handleWebviewAction(msg: ActionMessage) {
    try {
      if (msg.type === 'action') {
        const command = ({ screenshot: 'screenshot', record: 'toggleRecording', menu: 'more', pairWifi: 'pairWifiQr', showLog: 'showLog' } as const)[msg.action];
        await vscode.commands.executeCommand(`runningDevices.${command}`);
        return;
      }
      const target = await this.target();
      if (!target) return;
      if (msg.type === 'dropUris') {
        for (const raw of msg.uris) {
          const path = vscode.Uri.parse(raw).fsPath;
          await (extname(path).toLowerCase() === '.apk' ? this.installOne(target, path, basename(path)) : this.pushOne(target, path));
        }
      } else {
        const dir = join(tmpdir(), 'running-devices-drop');
        mkdirSync(dir, { recursive: true });
        const path = join(dir, basename(msg.name));
        writeFileSync(path, msg.data);
        try {
          await (extname(path).toLowerCase() === '.apk' ? this.installOne(target, path, msg.name) : this.pushOne(target, path));
        } finally {
          rmSync(path, { force: true });
        }
      }
    } catch (err) {
      void vscode.window.showErrorMessage(errorMessage(err));
    }
  }

  // ---- apps ----

  async logcat(currentAppOnly: boolean) {
    const target = await this.target();
    if (!target) return;
    const pkg = currentAppOnly ? await this.tools.foregroundApp(target.serial) : null;
    const level = vscode.workspace.getConfiguration('runningDevices').get<string>('logcatLevel', 'V');
    openLogcat(this.tools, target.serial, target.name, pkg, level);
  }

  async launchApp() {
    const target = await this.target();
    if (!target) return;
    const [packages, current] = await Promise.all([
      this.tools.listPackages(target.serial),
      this.tools.foregroundApp(target.serial),
    ]);
    const pick = await vscode.window.showQuickPick(
      packages.map((p) => ({ label: p, description: p === current ? 'in foreground' : undefined })),
      { title: `Launch an app on ${target.name}`, placeHolder: 'Type to filter installed apps', matchOnDescription: true },
    );
    if (pick) {
      await this.tools.launch(target.serial, pick.label);
    }
  }

  async openDeepLink() {
    const target = await this.target();
    if (!target) return;
    const url = await vscode.window.showInputBox({
      title: `Open a link on ${target.name}`,
      prompt: 'Opens with whichever app handles it. Great for testing deep links and app links.',
      placeHolder: 'myapp://profile/42 or https://example.com/path',
      validateInput: (v) => (/^[a-z][\w+.-]*:\S+$/i.test(v.trim()) ? null : 'Enter a URL with a scheme, e.g. https://… or myapp://…'),
    });
    if (url) {
      await this.tools.openUrl(target.serial, url.trim());
    }
  }

  async appActions() {
    const target = await this.target();
    if (!target) return;
    const pkg = await this.tools.foregroundApp(target.serial);
    if (!pkg) {
      void vscode.window.showWarningMessage('No app is in the foreground.');
      return;
    }
    const items: MenuItem[] = [
      { label: '$(debug-restart) Restart', description: 'Force stop and launch again', run: () => this.tools.restart(target.serial, pkg) },
      { label: '$(debug-stop) Force stop', run: () => this.tools.forceStop(target.serial, pkg) },
      { label: '$(output) Logcat for this app', run: () => openLogcat(this.tools, target.serial, target.name, pkg, vscode.workspace.getConfiguration('runningDevices').get('logcatLevel', 'V')) },
      {
        label: '$(info) App info',
        description: 'Open the system app settings',
        run: () => this.tools.adb.shell(target.serial, `am start -a android.settings.APPLICATION_DETAILS_SETTINGS -d package:${pkg}`),
      },
      {
        label: '$(clear-all) Clear data',
        description: 'Like a fresh install',
        run: () => this.confirm(`Clear all data of ${pkg}?`, 'Clear Data', () => this.tools.clearData(target.serial, pkg)),
      },
      {
        label: '$(trash) Uninstall',
        run: () => this.confirm(`Uninstall ${pkg} from ${target.name}?`, 'Uninstall', () => this.tools.uninstall(target.serial, pkg)),
      },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: pkg, placeHolder: `Foreground app on ${target.name}` });
    await pick?.run?.();
  }

  private async confirm(message: string, action: string, run: () => Promise<unknown>) {
    if ((await vscode.window.showWarningMessage(message, { modal: true }, action)) === action) {
      await run();
    }
  }

  // ---- quick settings ----

  async quickSettings() {
    const target = await this.target();
    if (!target) return;
    const s = this.tools;
    const serial = target.serial;
    const qp = vscode.window.createQuickPick<MenuItem>();
    qp.title = `Quick settings: ${target.name}`;
    qp.placeholder = 'Changes apply immediately';
    qp.matchOnDescription = true;

    const refresh = async () => {
      qp.busy = true;
      const q = await s.quickSettings(serial);
      const onOff = (v: boolean | null) => (v === null ? 'unsupported' : v ? 'On' : 'Off');
      const density = q.overrideDensity && q.physicalDensity ? `${Math.round((q.overrideDensity / q.physicalDensity) * 100)}%` : 'Default';
      qp.items = [
        { label: '$(color-mode) Dark theme', description: onOff(q.darkMode), run: () => q.darkMode !== null && s.setDarkMode(serial, !q.darkMode) },
        {
          label: '$(text-size) Font size',
          description: `${Math.round(q.fontScale * 100)}%`,
          run: () => this.choose('Font size', [0.85, 1, 1.15, 1.3, 1.5, 2].map((v) => [`${Math.round(v * 100)}%`, v]), (v) => s.setFontScale(serial, v)),
        },
        {
          label: '$(screen-full) Display size',
          description: density,
          run: () =>
            q.physicalDensity &&
            this.choose(
              'Display size',
              [['Small', 0.85], ['Default', null], ['Large', 1.15], ['Larger', 1.3]] as [string, number | null][],
              (v) => s.setDensity(serial, v === null ? null : q.physicalDensity! * v),
            ),
        },
        { label: '$(layout) Show layout bounds', description: onOff(q.layoutBounds), run: () => s.setLayoutBounds(serial, !q.layoutBounds) },
        { label: '$(eye) Show taps', description: onOff(q.showTaps), run: () => s.setShowTaps(serial, !q.showTaps) },
        {
          label: '$(dashboard) Animation speed',
          description: q.animationScale === 0 ? 'Off' : `${q.animationScale}x`,
          run: () => this.choose('Animation scale', [['Off', 0], ['0.5x', 0.5], ['1x', 1], ['2x', 2], ['5x (slow motion)', 5]], (v) => s.setAnimationScale(serial, v)),
        },
      ];
      qp.busy = false;
    };

    // Sub-menus temporarily hide this quick pick; don't dispose it while one is open.
    let busy = false;
    qp.onDidAccept(async () => {
      const item = qp.selectedItems[0];
      if (!item?.run) return;
      busy = true;
      try {
        await item.run();
      } catch (err) {
        if (err instanceof SettingsBlockedError) {
          busy = false;
          qp.hide();
          await this.explainSettingsBlocked(serial);
          return;
        }
        void vscode.window.showErrorMessage(errorMessage(err));
      }
      await refresh();
      qp.show();
      busy = false;
    });
    qp.onDidHide(() => !busy && qp.dispose());
    qp.show();
    await refresh();
  }

  private async explainSettingsBlocked(serial: string) {
    const open = 'Open Developer Options on Phone';
    const choice = await vscode.window.showWarningMessage(
      'This phone blocks adb from changing system settings.',
      {
        modal: true,
        detail:
          'Turn on this switch in Developer options, then try again:\n\n' +
          '• Realme, OPPO, OnePlus: "Disable permission monitoring"\n' +
          '• Xiaomi, Redmi, POCO: "USB debugging (Security settings)"\n\n' +
          'Dark theme and layout bounds work without it.',
      },
      open,
    );
    if (choice === open) {
      await this.tools.openDeveloperOptions(serial);
    }
  }

  /** Small sub-menu; the main quick pick re-opens afterwards. */
  private async choose<T>(title: string, options: [string, T][], apply: (v: T) => Promise<unknown>) {
    const pick = await vscode.window.showQuickPick(options.map(([label, value]) => ({ label, value })), { title });
    if (pick) await apply(pick.value);
  }

  // ---- wireless ----

  private onWifiConnected(address: string) {
    void vscode.window.showInformationMessage(`Connected over Wi-Fi: ${address}`);
    void this.controller.refresh().then(() => this.controller.start(address));
  }

  async switchToWifi() {
    const target = await this.target();
    if (!target) return;
    if (target.serial.includes(':') || target.serial.includes('._adb-tls')) {
      void vscode.window.showInformationMessage(`${target.name} is already connected over Wi-Fi.`);
      return;
    }
    const address = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Switching ${target.name} to Wi-Fi…` },
      () => switchToWifi(this.tools, target.serial),
    );
    void vscode.window.showInformationMessage(`${target.name} is connected over Wi-Fi at ${address}. You can unplug the USB cable.`);
    await this.controller.refresh();
    await this.controller.start(address);
  }

  async connectWifi() {
    const address = await vscode.window.showInputBox({
      title: 'Connect to device over Wi-Fi',
      prompt: 'IP address and port (shown under Developer options → Wireless debugging)',
      placeHolder: '192.168.1.20:5555',
      validateInput: (v) => (/^[\w.-]+(:\d+)?$/.test(v.trim()) ? null : 'Expected host or host:port'),
    });
    if (!address) return;
    const full = address.includes(':') ? address.trim() : `${address.trim()}:5555`;
    await this.tools.connect(full);
    this.onWifiConnected(full);
  }

  // ---- the toolbar's "more" menu ----

  async moreMenu() {
    const recording = this.controller.isRecording;
    const sep = (label: string): MenuItem => ({ label, kind: vscode.QuickPickItemKind.Separator });
    const item = (label: string, command: string, detail?: string): MenuItem => ({
      label,
      description: detail,
      run: () => vscode.commands.executeCommand(`runningDevices.${command}`),
    });
    const items: MenuItem[] = [
      sep('Capture'),
      item('$(device-camera) Take screenshot', 'screenshot'),
      item(recording ? '$(debug-stop) Stop recording' : '$(record) Record screen', 'toggleRecording'),
      sep('Apps'),
      item('$(rocket) Launch app…', 'launchApp'),
      item('$(link) Open deep link…', 'openDeepLink'),
      item('$(package) Current app…', 'appActions', 'Restart, force stop, clear data, uninstall'),
      item('$(output) Logcat: current app', 'logcat'),
      item('$(terminal) Logcat: everything', 'logcatAll'),
      sep('Files'),
      item('$(desktop-download) Install APK…', 'installApk', 'or drop an APK on the screen'),
      item('$(cloud-upload) Copy file to device…', 'pushFile', 'to Downloads'),
      sep('Device'),
      item('$(settings-gear) Quick settings…', 'quickSettings', 'Dark theme, font size, layout bounds…'),
      item('$(pulse) Toggle performance stats', 'toggleStats'),
      sep('Wireless'),
      item('$(radio-tower) Pair over Wi-Fi with QR code…', 'pairWifiQr', 'Android 11+'),
      item('$(broadcast) Pair with pairing code…', 'pairWifiCode'),
      item('$(plug) Switch USB device to Wi-Fi', 'switchToWifi'),
      item('$(link) Connect to IP address…', 'connectWifi'),
    ];
    const pick = await vscode.window.showQuickPick(items, { title: 'Running Devices', matchOnDescription: true });
    await pick?.run?.();
  }
}

/** Puts a PNG on the system clipboard as an image (macOS and Windows). */
function copyImageToClipboard(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (err: Error | null) => (err ? reject(err) : resolve());
    if (isMac) {
      const escaped = path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      execFile('osascript', ['-e', `set the clipboard to (read (POSIX file "${escaped}") as «class PNGf»)`], done);
    } else {
      const escaped = path.replace(/'/g, "''");
      execFile(
        'powershell',
        ['-NoProfile', '-STA', '-Command', `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; [System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile('${escaped}'))`],
        done,
      );
    }
  });
}
