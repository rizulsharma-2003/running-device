import { ChildProcess, execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const EXE = process.platform === 'win32' ? 'adb.exe' : 'adb';

/** Finds adb the same way Android tooling does: explicit path, SDK env vars, default SDK dir, PATH. */
export function resolveAdbPath(configured?: string): string {
  if (configured) {
    return configured;
  }
  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.platform === 'darwin' ? join(homedir(), 'Library', 'Android', 'sdk') : undefined,
    process.platform === 'win32' && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk')
      : undefined,
    process.platform === 'linux' ? join(homedir(), 'Android', 'Sdk') : undefined,
  ];
  for (const root of sdkRoots) {
    if (root) {
      const candidate = join(root, 'platform-tools', EXE);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return EXE;
}

export interface AdbDevice {
  serial: string;
  state: string;
  model?: string;
  product?: string;
}

export class Adb {
  constructor(readonly path: string) {}

  exec(args: string[], timeoutMs = 15_000): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.path, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const detail = stderr.trim() || stdout.trim() || err.message;
          reject(new Error(`adb ${args.join(' ')} failed: ${detail}`));
        } else {
          resolve(stdout);
        }
      });
    });
  }

  spawn(args: string[]): ChildProcess {
    return spawn(this.path, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  async devices(): Promise<AdbDevice[]> {
    const out = await this.exec(['devices', '-l']);
    return parseDevices(out);
  }

  push(serial: string, local: string, remote: string): Promise<string> {
    return this.exec(['-s', serial, 'push', local, remote], 60_000);
  }

  /** Forwards an ephemeral local TCP port to a device socket and returns the port. */
  async forward(serial: string, remote: string): Promise<number> {
    const out = await this.exec(['-s', serial, 'forward', 'tcp:0', remote]);
    const port = parseInt(out.trim(), 10);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`Unexpected output from adb forward: ${out.trim()}`);
    }
    return port;
  }

  async removeForward(serial: string, port: number): Promise<void> {
    await this.exec(['-s', serial, 'forward', '--remove', `tcp:${port}`]).catch(() => undefined);
  }
}

export function parseDevices(output: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('List of devices') || line.startsWith('*')) {
      continue;
    }
    const [serial, state, ...rest] = line.trim().split(/\s+/);
    if (!serial || !state) {
      continue;
    }
    const props: Record<string, string> = {};
    for (const token of rest) {
      const i = token.indexOf(':');
      if (i > 0) {
        props[token.slice(0, i)] = token.slice(i + 1);
      }
    }
    devices.push({ serial, state, model: props.model?.replace(/_/g, ' '), product: props.product });
  }
  return devices;
}
