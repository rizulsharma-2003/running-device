import { basename } from 'node:path';
import { Adb, shellQuote } from './adb';

// Everyday developer actions on an Android device, as plain adb calls.
// No VS Code dependency, so each one can be exercised from a script.

export interface QuickSettings {
  darkMode: boolean | null;
  fontScale: number;
  physicalDensity: number | null;
  overrideDensity: number | null;
  layoutBounds: boolean;
  showTaps: boolean;
  animationScale: number;
}

export interface MdnsService {
  name: string;
  type: string;
  address: string;
}

const PKG = /^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/;

/** Thrown when the phone's vendor ROM blocks adb from changing settings (Xiaomi, OPPO, Realme, OnePlus…). */
export class SettingsBlockedError extends Error {
  constructor() {
    super('This phone blocks adb from changing system settings.');
  }
}

function assertPackage(pkg: string) {
  if (!PKG.test(pkg)) {
    throw new Error(`Invalid package name: ${pkg}`);
  }
}

export class DeviceTools {
  constructor(readonly adb: Adb) {}

  // ---- capture ----

  /** Full-resolution PNG of the current screen. */
  screenshot(serial: string): Promise<Buffer> {
    return this.adb.execBuffer(['-s', serial, 'exec-out', 'screencap', '-p']);
  }

  // ---- files and apps ----

  async install(serial: string, apkPath: string): Promise<void> {
    // -r: replace existing, -t: allow test APKs, -d: allow version downgrade (common while developing)
    const out = await this.adb.exec(['-s', serial, 'install', '-r', '-t', '-d', apkPath], 5 * 60_000);
    if (!/Success/.test(out)) {
      throw new Error(out.trim().split('\n').pop() || 'Install failed');
    }
  }

  /** Copies a file to the device's Download folder and returns the device path. */
  async push(serial: string, localPath: string, remoteDir = '/sdcard/Download'): Promise<string> {
    const remote = `${remoteDir}/${basename(localPath)}`;
    await this.adb.exec(['-s', serial, 'push', localPath, remote], 10 * 60_000);
    // Make it show up in gallery / file apps right away.
    await this.adb
      .shell(serial, `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${shellQuote(`file://${remote}`)}`)
      .catch(() => undefined);
    return remote;
  }

  async listPackages(serial: string, thirdPartyOnly = true): Promise<string[]> {
    const out = await this.adb.shell(serial, `pm list packages${thirdPartyOnly ? ' -3' : ''}`);
    return out
      .split(/\r?\n/)
      .map((l) => l.replace(/^package:/, '').trim())
      .filter(Boolean)
      .sort();
  }

  /** Package of the activity currently in the foreground, if any. */
  async foregroundApp(serial: string): Promise<string | null> {
    const out = await this.adb.shell(serial, 'dumpsys activity activities | grep -E "topResumedActivity|mResumedActivity"');
    const match = /\s([\w.]+)\/[\w.$]+/.exec(out);
    return match ? match[1] : null;
  }

  async launch(serial: string, pkg: string): Promise<void> {
    assertPackage(pkg);
    const out = await this.adb.shell(serial, `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
    if (/No activities found|monkey aborted/i.test(out)) {
      throw new Error(`${pkg} has no launchable activity`);
    }
  }

  async forceStop(serial: string, pkg: string): Promise<void> {
    assertPackage(pkg);
    await this.adb.shell(serial, `am force-stop ${pkg}`);
  }

  async restart(serial: string, pkg: string): Promise<void> {
    await this.forceStop(serial, pkg);
    await this.launch(serial, pkg);
  }

  async clearData(serial: string, pkg: string): Promise<void> {
    assertPackage(pkg);
    const out = await this.adb.shell(serial, `pm clear ${pkg}`);
    if (!/Success/.test(out)) {
      throw new Error(out.trim() || 'Clear data failed');
    }
  }

  async uninstall(serial: string, pkg: string): Promise<void> {
    assertPackage(pkg);
    const out = await this.adb.exec(['-s', serial, 'uninstall', pkg], 60_000);
    if (!/Success/.test(out)) {
      throw new Error(out.trim() || 'Uninstall failed');
    }
  }

  /** Opens a URL or deep link (e.g. myapp://profile/42) with whatever app handles it. */
  async openUrl(serial: string, url: string): Promise<void> {
    const out = await this.adb.shell(serial, `am start -a android.intent.action.VIEW -d ${shellQuote(url)}`);
    if (/Error|unable to resolve/i.test(out)) {
      throw new Error(out.trim().split('\n').pop() || 'No app can open this link');
    }
  }

  async pidsOf(serial: string, pkg: string): Promise<number[]> {
    assertPackage(pkg);
    const out = await this.adb.shell(serial, `pidof ${pkg}`).catch(() => '');
    return out
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
  }

  // ---- rotation ----

  private sdkCache = new Map<string, number>();

  async sdk(serial: string): Promise<number> {
    let sdk = this.sdkCache.get(serial);
    if (sdk === undefined) {
      sdk = parseInt(await this.adb.shell(serial, 'getprop ro.build.version.sdk'), 10) || 0;
      this.sdkCache.set(serial, sdk);
    }
    return sdk;
  }

  /** Current display rotation, 0–3 (quarter turns). */
  async rotation(serial: string): Promise<number> {
    const out = await this.adb.shell(serial, 'dumpsys window displays | grep -m1 mCurrentRotation');
    const m = /ROTATION_(\d+)/.exec(out);
    return m ? Number(m[1]) / 90 : 0;
  }

  /** Orientation the foreground activity insists on ("portrait", "landscape"), or null if it follows the device. */
  async orientationLock(serial: string): Promise<string | null> {
    const out = await this.adb.shell(serial, 'dumpsys activity activities | grep -A60 topResumedActivity | grep -m1 mOrientation=');
    const m = /SCREEN_ORIENTATION_(\w+)/.exec(out)?.[1];
    if (!m) return null;
    if (/PORTRAIT/.test(m)) return 'portrait';
    if (/LANDSCAPE/.test(m)) return 'landscape';
    return null;
  }

  /**
   * Toggles portrait/landscape and pins it (works with auto-rotate on, unlike a
   * one-off rotation that the sensor immediately undoes). Android 10+.
   * Returns whether the screen actually turned.
   */
  async rotate(serial: string): Promise<boolean> {
    const before = await this.rotation(serial);
    const target = before % 2 === 0 ? 1 : 0;
    await this.adb.shell(serial, `wm user-rotation lock ${target}`);
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 150));
      if ((await this.rotation(serial)) !== before) return true;
    }
    return false;
  }

  // ---- quick settings ----

  async quickSettings(serial: string): Promise<QuickSettings> {
    // One round trip; markers separate the outputs.
    const out = await this.adb.shell(
      serial,
      [
        'cmd uimode night',
        'settings get system font_scale',
        'wm density',
        'getprop debug.layout',
        'settings get system show_touches',
        'settings get global animator_duration_scale',
      ].join('; echo @@; '),
    );
    const [night, font, density, layout, taps, anim] = out.split('@@').map((s) => s.trim());
    const num = (s: string | undefined, fallback: number) => {
      const n = parseFloat(s ?? '');
      return Number.isFinite(n) ? n : fallback;
    };
    return {
      darkMode: /yes/i.test(night) ? true : /no/i.test(night) ? false : null,
      fontScale: num(font, 1),
      physicalDensity: num(/Physical density:\s*(\d+)/.exec(density)?.[1], NaN) || null,
      overrideDensity: num(/Override density:\s*(\d+)/.exec(density)?.[1], NaN) || null,
      layoutBounds: layout === 'true',
      showTaps: taps === '1',
      animationScale: num(anim, 1),
    };
  }

  /** Runs a settings-changing command; some tools print an exception but still exit 0. */
  private async write(serial: string, command: string) {
    let out: string;
    try {
      out = await this.adb.shell(serial, command);
    } catch (err) {
      out = err instanceof Error ? err.message : String(err);
      if (!/Exception|not granted|permission/i.test(out)) throw err;
    }
    if (/SecurityException|not granted|WRITE_SETTINGS|INJECT_EVENTS|Exception occurred/i.test(out)) {
      throw new SettingsBlockedError();
    }
  }

  async setDarkMode(serial: string, on: boolean) {
    await this.write(serial, `cmd uimode night ${on ? 'yes' : 'no'}`);
  }

  async setFontScale(serial: string, scale: number) {
    await this.write(serial, `settings put system font_scale ${Number(scale)}`);
  }

  /** null resets to the device default. */
  async setDensity(serial: string, density: number | null) {
    await this.write(serial, density === null ? 'wm density reset' : `wm density ${Math.round(density)}`);
  }

  async setLayoutBounds(serial: string, on: boolean) {
    // The magic transaction makes running apps re-read system properties (what Developer options does).
    await this.write(serial, `setprop debug.layout ${on}; service call activity 1599295570 > /dev/null 2>&1`);
  }

  async setShowTaps(serial: string, on: boolean) {
    await this.write(serial, `settings put system show_touches ${on ? 1 : 0}`);
  }

  async openDeveloperOptions(serial: string) {
    await this.adb.shell(serial, 'am start -a android.settings.APPLICATION_DEVELOPMENT_SETTINGS');
  }

  async setAnimationScale(serial: string, scale: number) {
    const s = Number(scale);
    await this.write(
      serial,
      `settings put global window_animation_scale ${s}; settings put global transition_animation_scale ${s}; settings put global animator_duration_scale ${s}`,
    );
  }

  // ---- wireless ----

  async wifiAddress(serial: string): Promise<string | null> {
    const out = await this.adb.shell(serial, 'ip -f inet addr show wlan0').catch(() => '');
    return /inet (\d+\.\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
  }

  /** Restarts adbd on the device in TCP mode (USB-connected devices only). */
  async enableTcpip(serial: string, port = 5555) {
    await this.adb.exec(['-s', serial, 'tcpip', String(port)]);
  }

  async connect(address: string): Promise<void> {
    const out = await this.adb.exec(['connect', address], 20_000);
    if (!/connected to/i.test(out)) {
      throw new Error(out.trim() || `Could not connect to ${address}`);
    }
  }

  async pair(address: string, code: string): Promise<void> {
    const out = await this.adb.exec(['pair', address, code], 30_000);
    if (!/Successfully paired/i.test(out)) {
      throw new Error(out.trim() || 'Pairing failed');
    }
  }

  async mdnsServices(): Promise<MdnsService[]> {
    const out = await this.adb.exec(['mdns', 'services']).catch(() => '');
    const services: MdnsService[] = [];
    for (const line of out.split(/\r?\n/)) {
      const [name, type, address] = line.trim().split(/\s+/);
      if (name && type?.startsWith('_adb') && address?.includes(':')) {
        services.push({ name, type: type.replace(/\.$/, ''), address });
      }
    }
    return services;
  }
}
