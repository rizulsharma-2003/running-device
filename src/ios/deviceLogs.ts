import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import * as vscode from 'vscode';

// iPhone logs that keep working while the app is killed: the device's own
// syslog (filtered to one app, marking each relaunch) and the crash / CPU /
// memory-kill reports iOS writes when an app dies.

export interface DevApp {
  name: string;
  bundleId: string;
  /** Executable name, which is what syslog shows (Flutter apps: "Runner"). */
  process: string;
}

export interface Report {
  file: string;
  kind: 'Crash' | 'CPU limit' | 'Memory kill' | 'Hang' | 'Report';
  time: Date;
  title: string;
}

const run = (cmd: string, args: string[], timeout = 30_000) =>
  new Promise<string>((resolve, reject) =>
    execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, out, errOut) => (err ? reject(new Error(errOut || err.message)) : resolve(out))),
  );

// ---- syslog tool ----

/**
 * libimobiledevice's idevicesyslog: from settings, PATH (Homebrew), or the copy
 * the Flutter SDK ships (which needs its sibling libraries on DYLD_LIBRARY_PATH).
 */
export function findSyslogTool(): { bin: string; env: NodeJS.ProcessEnv } | null {
  const configured = vscode.workspace.getConfiguration('runningDevices').get<string>('idevicesyslogPath', '').trim();
  if (configured && existsSync(configured)) return withLibs(configured);
  for (const dir of (process.env.PATH ?? '').split(':').concat(['/opt/homebrew/bin', '/usr/local/bin'])) {
    const bin = join(dir, 'idevicesyslog');
    if (existsSync(bin)) return { bin, env: process.env };
  }
  for (const root of flutterRoots()) {
    const bin = join(root, 'bin', 'cache', 'artifacts', 'libimobiledevice', 'idevicesyslog');
    if (existsSync(bin)) return withLibs(bin);
  }
  return null;
}

function withLibs(bin: string) {
  const artifacts = dirname(dirname(bin));
  const libs = ['libimobiledevice', 'libimobiledeviceglue', 'libplist', 'libusbmuxd', 'openssl'].map((d) => join(artifacts, d)).filter(existsSync);
  return { bin, env: { ...process.env, DYLD_LIBRARY_PATH: [...libs, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(':') } };
}

function flutterRoots(): string[] {
  const roots = new Set<string>();
  const fromDart = vscode.workspace.getConfiguration('dart').get<string>('flutterSdkPath');
  if (fromDart) roots.add(fromDart.replace(/^~/, homedir()));
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const flutter = join(dir, 'flutter');
    if (existsSync(flutter)) {
      try {
        roots.add(dirname(dirname(realpathSync(flutter))));
      } catch {
        // ignore broken links
      }
    }
  }
  for (const p of ['/usr/local/flutter', '/opt/flutter', join(homedir(), 'flutter'), join(homedir(), 'development', 'flutter'), join(homedir(), 'fvm', 'default')]) {
    roots.add(p);
  }
  return [...roots];
}

// ---- apps ----

/** Apps the developer installed (devicectl lists those by default). */
export async function devApps(udid: string): Promise<DevApp[]> {
  const out = join(tmpdir(), `running-devices-apps-${process.pid}.json`);
  try {
    await run('xcrun', ['devicectl', 'device', 'info', 'apps', '--device', udid, '--json-output', out]);
    const apps = JSON.parse(readFileSync(out, 'utf8')).result?.apps ?? [];
    return apps
      .filter((a: any) => !/WebDriverAgentRunner/.test(a.bundleIdentifier ?? ''))
      .map((a: any) => ({
        name: a.name ?? a.bundleIdentifier,
        bundleId: a.bundleIdentifier,
        process: basename(String(a.url ?? '').replace(/\/$/, ''), '.app') || a.name,
      }));
  } finally {
    rmSync(out, { force: true });
  }
}

// ---- live device log ----

const ESC = '\x1b[';
const C = { dim: `${ESC}2m`, red: `${ESC}31m`, yellow: `${ESC}33m`, magenta: `${ESC}1;35m`, cyan: `${ESC}36m`, banner: `${ESC}1;36m`, reset: `${ESC}0m` };
// "Oct 14 17:52:40 Runner(Flutter)[2047] <Notice>: message"
const LINE = /^(\w{3}\s+\d+\s+[\d:]+)\s+(\S+?)(?:\(([^)]*)\))?\[(\d+)\]\s+<(\w+)>:\s?(.*)$/;

export function openDeviceLog(udid: string, deviceName: string, app: DevApp | null) {
  const tool = findSyslogTool();
  if (!tool) {
    void vscode.window
      .showErrorMessage(
        'iPhone device logs need idevicesyslog. It comes with the Flutter SDK, or install it with Homebrew: brew install libimobiledevice',
        'Copy Homebrew Command',
      )
      .then((c) => c && vscode.env.clipboard.writeText('brew install libimobiledevice'));
    return;
  }
  const write = new vscode.EventEmitter<string>();
  const close = new vscode.EventEmitter<number | void>();
  let proc: ReturnType<typeof spawn> | null = null;
  let partial = '';
  let lastPid = '';
  const line = (s: string) => write.fire(s.replace(/\n/g, '\r\n') + '\r\n');
  const banner = (s: string) => line(`${C.banner}──── ${s} ────${C.reset}`);

  const onLine = (raw: string) => {
    if (/^\[connected:/.test(raw)) return banner(`${deviceName} connected`);
    if (/^\[disconnected:/.test(raw)) return banner(`${deviceName} disconnected; waiting for it to come back`);
    const m = LINE.exec(raw);
    if (!m) return line(raw); // continuation of a multi-line message
    const [, time, proc, subsystem, pid, level, message] = m;
    if (app && pid !== lastPid) {
      // A new pid means iOS launched the app again (e.g. from a notification while it was killed).
      banner(`${app.name} started (pid ${pid})`);
      lastPid = pid;
    }
    const color = level === 'Error' ? C.red : level === 'Fault' ? C.magenta : level === 'Warning' ? C.yellow : /^(Info|Debug)$/.test(level) ? C.dim : '';
    const isFlutter = subsystem === 'Flutter' || /^flutter: /.test(message);
    const who = app ? (subsystem ? `${subsystem}` : '') : `${proc}${subsystem ? `(${subsystem})` : ''}`;
    line(`${C.dim}${time.split(/\s+/).pop()}${C.reset} ${color}${level[0]}${C.reset} ${who ? `${C.dim}${who}${C.reset} ` : ''}${isFlutter ? C.cyan : color}${message}${C.reset}`);
  };

  const pty: vscode.Pseudoterminal = {
    onDidWrite: write.event,
    onDidClose: close.event,
    open: () => {
      line(
        `${C.dim}Device log for ${app ? `${app.name} (process "${app.process}")` : 'all processes (noisy ones hidden)'} on ${deviceName}. ` +
          `Keeps running while the app is killed and relaunched. Close the terminal to stop.${C.reset}`,
      );
      proc = spawn(tool.bin, ['-u', udid, '--no-colors', ...(app ? ['-p', app.process] : ['-q'])], { env: tool.env });
      proc.stdout?.on('data', (d: Buffer) => {
        const lines = (partial + d.toString('utf8')).split('\n');
        partial = lines.pop() ?? '';
        lines.forEach((l) => l && onLine(l));
      });
      proc.stderr?.on('data', (d: Buffer) => line(`${C.red}${d.toString().trim()}${C.reset}`));
      proc.on('exit', () => banner('device log ended'));
    },
    close: () => proc?.kill(),
  };
  vscode.window.createTerminal({ name: `Device Log: ${app?.name ?? deviceName}`, pty, iconPath: new vscode.ThemeIcon('output') }).show();
}

// ---- crash / kill reports ----

/** Copies the iPhone's diagnostic reports and returns the ones about `app` (or all apps), newest first. */
export async function fetchReports(udid: string, storageDir: string, app: DevApp | null): Promise<Report[]> {
  const dir = join(storageDir, 'ios-reports', udid);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await run('xcrun', ['devicectl', 'device', 'copy', 'from', '--device', udid, '--domain-type', 'systemCrashLogs', '--source', '/', '--destination', dir], 120_000);

  const reports: Report[] = [];
  const seen = new Set<string>(); // iOS sometimes keeps two copies of one report
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  for (const file of walk(dir).filter((f) => f.endsWith('.ips'))) {
    const name = basename(file);
    const parsed = parseIps(file);
    if (!parsed) continue;
    const { header, body } = parsed;
    const incident = String(header.incident_id ?? body.incident ?? '');
    if (incident && seen.has(incident)) continue;
    if (incident) seen.add(incident);
    const time = new Date(String(header.timestamp ?? '').replace(/\.\d+ /, ' ').replace(' +', '+') || statSync(file).mtime);
    const proc = String(header.app_name ?? header.name ?? name.replace(/[-.].*$/, ''));

    if (/^JetsamEvent/.test(name)) {
      // Memory pressure: iOS lists every process; only report it if our app was killed.
      const victims = (body.processes ?? []).filter((p: any) => p.reason && (!app || p.name === app.process));
      for (const v of victims) {
        reports.push({ file, kind: 'Memory kill', time, title: `${v.name} killed for memory (${v.reason})` });
      }
      continue;
    }
    if (app && proc !== app.process) continue;
    const kind: Report['kind'] = /cpu_resource/.test(name) ? 'CPU limit' : String(header.bug_type) === '309' ? 'Crash' : /hang/i.test(name) ? 'Hang' : 'Report';
    const ex = body.exception;
    const title =
      kind === 'Crash'
        ? `${proc}: ${[ex?.type, ex?.signal].filter(Boolean).join(' ') || 'crash'}${crashedIn(body) ? ` in ${crashedIn(body)}` : ''}`
        : kind === 'CPU limit'
          ? `${proc} used too much CPU`
          : `${proc}: ${name.replace(/\.ips$/, '')}`;
    reports.push({ file, kind, time, title });
  }
  return reports.sort((a, b) => b.time.getTime() - a.time.getTime());
}

function parseIps(file: string): { header: any; body: any } | null {
  try {
    const text = readFileSync(file, 'utf8');
    const newline = text.indexOf('\n');
    const header = JSON.parse(text.slice(0, newline));
    let body: any = {};
    try {
      body = JSON.parse(text.slice(newline + 1));
    } catch {
      // some report types have a plain-text body
    }
    return { header, body };
  } catch {
    return null;
  }
}

function frameText(body: any, frame: any): string {
  const image = body.usedImages?.[frame.imageIndex]?.name ?? '???';
  return frame.symbol ? `${image}  ${frame.symbol} + ${frame.symbolLocation ?? 0}` : `${image}  +0x${Number(frame.imageOffset ?? 0).toString(16)}`;
}

function crashedIn(body: any): string | undefined {
  const frames = body.threads?.[body.faultingThread]?.frames;
  const first = frames?.find((f: any) => f.symbol) ?? frames?.[0];
  return first ? frameText(body, first).replace(/\s+\+.*$/, '').replace(/^\S+\s+/, '') : undefined;
}

/** A readable summary (Markdown) followed by the raw report. */
export function renderReport(report: Report): string {
  const parsed = parseIps(report.file);
  const h = parsed?.header ?? {};
  const b = parsed?.body ?? {};
  const out: string[] = [`# ${report.title}`, '', `- **When:** ${report.time.toLocaleString()}`, `- **Type:** ${report.kind}`];
  if (h.app_version || h.build_version) out.push(`- **App version:** ${h.app_version ?? '?'} (${h.build_version ?? '?'})`);
  if (h.bundleID) out.push(`- **Bundle:** ${h.bundleID}`);
  if (h.os_version) out.push(`- **iOS:** ${h.os_version}`);
  if (b.exception) {
    out.push(`- **Exception:** ${[b.exception.type, b.exception.signal, b.exception.subtype].filter(Boolean).join(' · ')}`);
  }
  if (b.termination) {
    out.push(`- **Termination:** ${[b.termination.namespace, b.termination.indicator, ...(b.termination.reasons ?? [])].filter(Boolean).join(' · ')}`);
  }
  if (b.asi) out.push(`- **Details:** ${JSON.stringify(b.asi)}`);
  const ft = b.faultingThread;
  const frames = ft !== undefined ? b.threads?.[ft]?.frames : undefined;
  if (frames?.length) {
    out.push('', `## Crashed thread ${ft}${b.threads[ft].name ? ` (${b.threads[ft].name})` : ''}`, '', '```');
    frames.slice(0, 40).forEach((f: any, i: number) => out.push(`${String(i).padStart(2)}  ${frameText(b, f)}`));
    out.push('```', '', '_Frames without symbols are in your app; symbolicate them in Xcode (Window → Devices and Simulators → View Device Logs) with the matching build._');
  }
  if (report.kind === 'Memory kill') {
    const victims = (b.processes ?? []).filter((p: any) => p.reason);
    out.push('', '## Processes killed in this memory event', '', '| Process | Reason | Pages |', '| --- | --- | --- |');
    victims.forEach((p: any) => out.push(`| ${p.name} | ${p.reason} | ${p.rpages ?? ''} |`));
  }
  out.push('', '## Full report', '', '```json', readFileSync(report.file, 'utf8'), '```');
  return out.join('\n');
}
