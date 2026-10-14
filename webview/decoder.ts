// Decodes the device's Annex B H.264 stream with WebCodecs and paints frames
// to a canvas as soon as they come out: no buffering, lowest latency.

export class VideoRenderer {
  private decoder: VideoDecoder | null = null;
  private ctx: CanvasRenderingContext2D;
  /** SPS/PPS from the last config packet, prepended to the next key frame. */
  private config: Uint8Array | null = null;
  private pendingConfig = false;
  private needKeyFrame = true;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onFirstFrame: () => void,
    private readonly requestKeyFrame: () => void,
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })!;
  }

  /** New capture session (start, rotation): the next packets start with a fresh config. */
  resize(width: number, height: number) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.needKeyFrame = true;
  }

  push(data: Uint8Array, key: boolean, config: boolean, pts: number) {
    if (config) {
      this.configure(data);
      return;
    }
    if (!this.decoder || this.decoder.state !== 'configured') {
      return;
    }
    if (this.needKeyFrame && !key) {
      return; // can't decode deltas without a reference frame
    }
    let payload = data;
    if (this.pendingConfig && this.config) {
      payload = new Uint8Array(this.config.length + data.length);
      payload.set(this.config, 0);
      payload.set(data, this.config.length);
      this.pendingConfig = false;
    }
    this.needKeyFrame = false;
    try {
      this.decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: pts, data: payload }));
    } catch (err) {
      console.error('decode failed', err);
      this.recover();
    }
  }

  private configure(config: Uint8Array) {
    const codec = h264CodecString(config);
    if (!codec) {
      console.error('No SPS in config packet');
      return;
    }
    this.config = config;
    this.pendingConfig = true;
    this.needKeyFrame = true;
    if (!this.decoder || this.decoder.state === 'closed') {
      this.decoder = new VideoDecoder({
        output: (frame) => this.draw(frame),
        error: (err) => {
          console.error('decoder error', err);
          this.recover();
        },
      });
    }
    // No `description`: WebCodecs then expects Annex B with in-band SPS/PPS.
    this.decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'no-preference' });
  }

  private drawn = false;

  private draw(frame: VideoFrame) {
    if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;
    }
    this.ctx.drawImage(frame, 0, 0);
    frame.close();
    if (!this.drawn) {
      this.drawn = true;
      this.onFirstFrame();
    }
  }

  /** After an error, rebuild the decoder from the saved config and ask for a key frame. */
  private recover() {
    if (this.decoder && this.decoder.state !== 'closed') {
      this.decoder.close();
    }
    this.decoder = null;
    if (this.config) {
      this.configure(this.config);
    }
    this.requestKeyFrame();
  }

  reset() {
    if (this.decoder && this.decoder.state !== 'closed') {
      this.decoder.close();
    }
    this.decoder = null;
    this.config = null;
    this.pendingConfig = false;
    this.needKeyFrame = true;
    this.drawn = false;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}

/** Builds "avc1.PPCCLL" from the first SPS NAL unit of an Annex B buffer. */
export function h264CodecString(annexB: Uint8Array): string | null {
  for (let i = 0; i + 4 < annexB.length; i++) {
    if (annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 1) {
      const nal = i + 3;
      if ((annexB[nal] & 0x1f) === 7 && nal + 3 < annexB.length) {
        const hex = (b: number) => b.toString(16).padStart(2, '0');
        return `avc1.${hex(annexB[nal + 1])}${hex(annexB[nal + 2])}${hex(annexB[nal + 3])}`;
      }
    }
  }
  return null;
}
