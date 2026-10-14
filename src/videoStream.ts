import type { MirrorEvents } from './backend';
import { SocketReader } from './android/scrcpy/socketReader';

/**
 * Reads scrcpy-framed video until the stream ends. Shared by Android (scrcpy
 * server over adb) and iOS (our ios-mirror helper writes the same framing):
 *   session packet: MSB set, then u32 width, u32 height
 *   media packet:   u64 pts with config/key flags in bits 62/61, u32 size, payload
 */
export async function readVideoPackets(
  reader: SocketReader,
  events: Pick<MirrorEvents, 'onSession' | 'onPacket'>,
  isDisposed: () => boolean,
): Promise<void> {
  while (!isDisposed()) {
    const header = await reader.read(12);
    if (header[0] & 0x80) {
      events.onSession(header.readUInt32BE(4), header.readUInt32BE(8));
      continue;
    }
    const ptsAndFlags = header.readBigUInt64BE(0);
    const config = (ptsAndFlags & (1n << 62n)) !== 0n;
    const key = (ptsAndFlags & (1n << 61n)) !== 0n;
    const pts = Number(ptsAndFlags & ((1n << 61n) - 1n));
    const data = await reader.read(header.readUInt32BE(8));
    events.onPacket(data, key, config, pts);
  }
}
