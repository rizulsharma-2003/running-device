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

  async listDevices(): Promise<DeviceInfo[]> {
    const devices = await this.adb.devices();
    return devices.map((d) => ({
      id: d.serial,
      name: d.model ?? d.serial,
      platform: 'android',
      state: d.state,
    }));
  }

  startMirroring(deviceId: string, options: MirrorOptions, events: MirrorEvents): Promise<MirrorSession> {
    return ScrcpySession.start(this.adb, deviceId, this.serverJar, options, events, this.log);
  }
}
