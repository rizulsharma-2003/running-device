/** Minimal readable: a socket or a child process's stdout. */
type Readable = { on(event: string, listener: (...args: any[]) => void): unknown };

/** Turns a socket or stream into exact-length async reads, which is what a framed protocol needs. */
export class SocketReader {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private pending: { size: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  private closedError: Error | null = null;

  constructor(socket: Readable) {
    socket.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
      this.flush();
    });
    const close = (err?: Error) => {
      if (!this.closedError) {
        this.closedError = err ?? new Error('Socket closed');
        this.flush();
      }
    };
    socket.on('error', close);
    socket.on('close', () => close());
    socket.on('end', () => close());
  }

  read(size: number): Promise<Buffer> {
    if (this.pending) {
      return Promise.reject(new Error('Concurrent reads are not supported'));
    }
    return new Promise((resolve, reject) => {
      this.pending = { size, resolve, reject };
      this.flush();
    });
  }

  private flush() {
    const p = this.pending;
    if (!p) {
      return;
    }
    if (this.buffered >= p.size) {
      this.pending = null;
      p.resolve(this.take(p.size));
    } else if (this.closedError) {
      this.pending = null;
      p.reject(this.closedError);
    }
  }

  private take(size: number): Buffer {
    if (this.chunks[0].length === size) {
      this.buffered -= size;
      return this.chunks.shift()!;
    }
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.buffered);
    const out = all.subarray(0, size);
    const rest = all.subarray(size);
    this.chunks = rest.length ? [rest] : [];
    this.buffered = rest.length;
    return out;
  }
}
