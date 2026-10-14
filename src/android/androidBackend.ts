import type { DeviceInfo } from '../../shared/messages';
import type { DeviceBackend, MirrorEvents, MirrorOptions, MirrorSession } from '../backend';
import { Adb } from './adb';
import { ScrcpySession } from './scrcpy/session';

export class AndroidBackend implements DeviceBackend {
  readonly platform = 'android' as const;

  constructor(
    private readonly adb: Adb,
    private readonly serverJar: string,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  /** Android version per serial; it can't change while connected, so look it up once. */
  private versions = new Map<string, Promise<string | null>>();

  async listDevices(): Promise<DeviceInfo[]> {
    const devices = await this.adb.devices();
    return Promise.all(
      devices.map(async (d) => {
        const version = d.state === 'device' ? await this.androidVersion(d.serial) : null;
        return {
          id: d.serial,
          name: d.model ?? d.serial,
          platform: 'android' as const,
          state: d.state,
          detail: [version && `Android ${version}`, connectionType(d.serial)].filter(Boolean).join(' · '),
        };
      }),
    );
  }

  private androidVersion(serial: string): Promise<string | null> {
    let version = this.versions.get(serial);
    if (!version) {
      version = this.adb
        .shell(serial, 'getprop ro.build.version.release', 5000)
        .then((v) => v.trim() || null)
        .catch(() => {
          this.versions.delete(serial); // retry on the next poll
          return null;
        });
      this.versions.set(serial, version);
    }
    return version;
  }

  startMirroring(deviceId: string, options: MirrorOptions, events: MirrorEvents): Promise<MirrorSession> {
    return ScrcpySession.start(this.adb, deviceId, this.serverJar, options, events, this.log);
  }
}

function connectionType(serial: string): string {
  if (serial.startsWith('emulator-')) return 'Emulator';
  if (serial.includes(':') || serial.includes('._adb-tls')) return 'Wi-Fi';
  return 'USB';
}
