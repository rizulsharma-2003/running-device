import type { ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';
import type { DeviceTools } from './android/deviceTools';

const PID_POLL_MS = 1500;
const ANSI = /\x1b\[[0-9;]*m/g;
const DIM = '\x1b[2m';
const BOLD_CYAN = '\x1b[1;36m';
const RESET = '\x1b[0m';

/**
 * Logcat in a terminal: colored, optionally filtered to one app. Follows the
 * app across restarts by polling its pids, like Android Studio's Logcat.
 */
export function openLogcat(tools: DeviceTools, serial: string, deviceName: string, pkg: string | null, level: string) {
  const writeEmitter = new vscode.EventEmitter<string>();
  const closeEmitter = new vscode.EventEmitter<number | void>();
  let proc: ChildProcess | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let pids = new Set<number>();
  let partial = '';

  const writeLine = (line: string) => writeEmitter.fire(line + '\r\n');
  const banner = (text: string) => writeLine(`${BOLD_CYAN}──── ${text} ────${RESET}`);

  const pollPids = async () => {
    if (!pkg) return;
    const next = new Set(await tools.pidsOf(serial, pkg));
    const started = [...next].filter((p) => !pids.has(p));
    if (started.length) {
      banner(`${pkg} started (pid ${started.join(', ')})`);
    } else if (pids.size && !next.size) {
      banner(`${pkg} stopped`);
    }
    pids = next;
  };

  const onData = (chunk: Buffer) => {
    const lines = (partial + chunk.toString('utf8')).split('\n');
    partial = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (pkg) {
        // threadtime format: date time pid tid level tag: message
        const pid = Number(line.replace(ANSI, '').trim().split(/\s+/)[2]);
        if (!pids.has(pid)) continue;
      }
      writeLine(line);
    }
  };

  const pty: vscode.Pseudoterminal = {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,
    open: async () => {
      writeLine(`${DIM}Logcat for ${pkg ?? 'all apps'} on ${deviceName}. Level ${level} and above. Close the terminal to stop.${RESET}`);
      if (pkg) {
        await pollPids();
        if (!pids.size) {
          writeLine(`${DIM}Waiting for ${pkg} to start…${RESET}`);
        }
        pollTimer = setInterval(() => void pollPids().catch(() => undefined), PID_POLL_MS);
      }
      // -T 500: start with recent history; -v color: same colors as `adb logcat` in a shell.
      proc = tools.adb.spawn(['-s', serial, 'logcat', '-v', 'color', '-v', 'threadtime', '-T', '500', `*:${level}`]);
      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', (d: Buffer) => writeLine(`\x1b[31m${d.toString().trim()}${RESET}`));
      proc.on('exit', () => {
        banner('logcat ended (device disconnected?)');
        if (pollTimer) clearInterval(pollTimer);
      });
    },
    close: () => {
      if (pollTimer) clearInterval(pollTimer);
      proc?.kill();
    },
  };

  const terminal = vscode.window.createTerminal({
    name: `Logcat: ${pkg ?? deviceName}`,
    pty,
    iconPath: new vscode.ThemeIcon('output'),
  });
  terminal.show();
}
