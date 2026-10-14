import { closeSync, openSync, writeSync } from 'node:fs';
import { Muxer, StreamTarget } from 'mp4-muxer';

// Records the mirrored H.264 stream straight into an MP4 file, so a recording
// costs the device nothing extra and has no length limit (unlike `adb screenrecord`).

const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_AUD = 9;

/** Splits an Annex B buffer (00 00 01 / 00 00 00 01 start codes) into NAL units. */
export function splitAnnexB(buf: Uint8Array): Uint8Array[] {
  const units: Uint8Array[] = [];
  let start = -1;
  let i = 0;
  while (i + 2 < buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      if (start >= 0) {
        // Trim the extra zero of a 4-byte start code from the previous unit.
        let end = i;
        if (end > start && buf[end - 1] === 0) end--;
        units.push(buf.subarray(start, end));
      }
      i += 3;
      start = i;
    } else {
      i++;
    }
  }
  if (start >= 0 && start < buf.length) {
    units.push(buf.subarray(start));
  }
  return units;
}

/** Builds an AVCDecoderConfigurationRecord ("avcC") from SPS and PPS. */
export function buildAvcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const out = new Uint8Array(11 + sps.length + pps.length);
  let o = 0;
  out[o++] = 1; // configurationVersion
  out[o++] = sps[1]; // profile
  out[o++] = sps[2]; // compatibility
  out[o++] = sps[3]; // level
  out[o++] = 0xff; // 4-byte NAL lengths
  out[o++] = 0xe1; // 1 SPS
  out[o++] = sps.length >> 8;
  out[o++] = sps.length & 0xff;
  out.set(sps, o);
  o += sps.length;
  out[o++] = 1; // 1 PPS
  out[o++] = pps.length >> 8;
  out[o++] = pps.length & 0xff;
  out.set(pps, o);
  return out;
}

/** Annex B frame -> AVCC (4-byte length prefixes), dropping parameter sets and delimiters. */
function toAvcc(units: Uint8Array[]): Uint8Array {
  const kept = units.filter((u) => {
    const type = u[0] & 0x1f;
    return type !== NAL_SPS && type !== NAL_PPS && type !== NAL_AUD;
  });
  const out = new Uint8Array(kept.reduce((n, u) => n + 4 + u.length, 0));
  let o = 0;
  for (const u of kept) {
    out[o++] = (u.length >>> 24) & 0xff;
    out[o++] = (u.length >>> 16) & 0xff;
    out[o++] = (u.length >>> 8) & 0xff;
    out[o++] = u.length & 0xff;
    out.set(u, o);
    o += u.length;
  }
  return out;
}

const hex = (b: number) => b.toString(16).padStart(2, '0');

export class Mp4Recorder {
  private fd: number;
  private muxer: Muxer<StreamTarget> | null = null;
  private size: { width: number; height: number } | null = null;
  private avcC: Uint8Array | null = null;
  private codec = '';
  private started = false;
  private firstPts = 0;
  private lastPts = 0;
  frames = 0;

  constructor(readonly path: string) {
    this.fd = openSync(path, 'w');
  }

  /** A capture session started. Returns false if the size changed mid-recording (rotation). */
  onSession(width: number, height: number): boolean {
    if (this.started && this.size && (this.size.width !== width || this.size.height !== height)) {
      return false;
    }
    this.size = { width, height };
    return true;
  }

  push(data: Uint8Array, key: boolean, config: boolean, pts: number) {
    if (config) {
      const units = splitAnnexB(data);
      const sps = units.find((u) => (u[0] & 0x1f) === NAL_SPS);
      const pps = units.find((u) => (u[0] & 0x1f) === NAL_PPS);
      if (sps && pps) {
        this.avcC = buildAvcC(sps, pps);
        this.codec = `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
      }
      return;
    }
    if (!this.started) {
      if (!key || !this.avcC || !this.size) {
        return; // a recording must start on a key frame
      }
      this.muxer = new Muxer({
        target: new StreamTarget({
          onData: (chunk, position) => writeSync(this.fd, chunk, 0, chunk.length, position),
        }),
        video: { codec: 'avc', width: this.size.width, height: this.size.height },
        fastStart: false,
        firstTimestampBehavior: 'offset',
      });
      this.started = true;
      this.firstPts = pts;
    }
    if (pts < this.lastPts) {
      return; // timestamps must not go backwards
    }
    const meta =
      this.frames === 0
        ? {
            decoderConfig: {
              codec: this.codec,
              codedWidth: this.size!.width,
              codedHeight: this.size!.height,
              description: this.avcC!,
            },
          }
        : undefined;
    this.muxer!.addVideoChunkRaw(toAvcc(splitAnnexB(data)), key ? 'key' : 'delta', pts, 1_000_000 / 60, meta);
    this.lastPts = pts;
    this.frames++;
  }

  /** Seconds of video recorded so far. */
  get duration() {
    return this.frames ? (this.lastPts - this.firstPts) / 1e6 : 0;
  }

  /** Finalizes the file. Returns false if nothing was recorded. */
  finish(): boolean {
    try {
      if (this.muxer && this.frames) {
        this.muxer.finalize();
        return true;
      }
      return false;
    } finally {
      closeSync(this.fd);
    }
  }
}
