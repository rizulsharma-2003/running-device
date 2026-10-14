import { join } from 'node:path';
import * as vscode from 'vscode';
import type { FlutterAction, FlutterState } from '../shared/messages';

// Flutter controls for the mirrored device, on top of the Dart/Flutter extension
// (Dart-Code). We don't run Flutter ourselves: we find the debug session that
// targets the mirrored device and drive it through Dart-Code's debug adapter.

interface TrackedSession {
  session: vscode.DebugSession;
  deviceId?: string;
  mode?: string;
  started: boolean;
  /** Hot reload / restart in progress. */
  busy?: 'reloading' | 'restarting';
  busySince?: number;
  /** Last result, e.g. "Reloaded in 312 ms". */
  message?: string;
  inspecting: boolean;
}

interface FlutterProject {
  folder: vscode.WorkspaceFolder;
  dir: string;
  name: string;
}

const RELOAD_REASON = 'manual';
const DART_EXTENSION = 'Dart-Code.flutter';

export class FlutterIntegration implements vscode.Disposable {
  private sessions = new Map<string, TrackedSession>();
  private projects: FlutterProject[] = [];
  private disposables: vscode.Disposable[] = [];
  private messageTimer: NodeJS.Timeout | undefined;
  private starting = false;

  constructor(
    private readonly deviceId: () => string | null,
    private readonly publish: (state: FlutterState | null) => void,
  ) {
    this.disposables.push(
      vscode.debug.onDidStartDebugSession((s) => this.track(s)),
      vscode.debug.onDidTerminateDebugSession((s) => {
        if (this.sessions.delete(s.id)) this.update();
      }),
      vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => this.onEvent(e)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.findProjects()),
    );
    // A session that was already running before we activated has long since started.
    if (vscode.debug.activeDebugSession) this.track(vscode.debug.activeDebugSession, true);
    void this.findProjects();
  }

  // ---- discovery ----

  private async findProjects() {
    const files = await vscode.workspace.findFiles('**/pubspec.yaml', '**/{.dart_tool,build,.symlinks,ephemeral,node_modules}/**', 20);
    const projects: FlutterProject[] = [];
    for (const uri of files) {
      const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      // An app (not a package): depends on the Flutter SDK and has an entry point.
      if (!/sdk:\s*flutter/.test(text)) continue;
      const dir = vscode.Uri.joinPath(uri, '..');
      const main = vscode.Uri.joinPath(dir, 'lib', 'main.dart');
      if (!(await exists(main))) continue;
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (!folder) continue;
      const name = /^name:\s*([\w-]+)/m.exec(text)?.[1] ?? 'Flutter app';
      projects.push({ folder, dir: dir.fsPath, name });
    }
    this.projects = projects.sort((a, b) => a.dir.length - b.dir.length);
    this.update();
  }

  private track(session: vscode.DebugSession, started = false) {
    if (session.type !== 'dart' || this.sessions.has(session.id)) return;
    this.sessions.set(session.id, {
      session,
      deviceId: session.configuration.deviceId,
      started,
      inspecting: false,
    });
    this.update();
  }

  private onEvent(e: vscode.DebugSessionCustomEvent) {
    if (e.session.type !== 'dart') return;
    // First sight of a session mid-run (e.g. a reload event): it has already started.
    this.track(e.session, e.event !== 'flutter.appStart');
    const s = this.sessions.get(e.session.id)!;
    const body = e.body ?? {};
    switch (e.event) {
      case 'flutter.appStart':
        s.deviceId = body.deviceId ?? s.deviceId;
        s.mode = body.mode;
        break;
      case 'flutter.appStarted':
        s.started = true;
        break;
      case 'dart.progressStart': {
        const id = String(body.progressId ?? '').toLowerCase();
        if (id.includes('reload')) s.busy = 'reloading';
        else if (id.includes('restart')) s.busy = 'restarting';
        else return;
        s.busySince = Date.now();
        s.message = undefined;
        break;
      }
      case 'dart.progressEnd': {
        if (!s.busy) return;
        // The Flutter adapter ends progress without a message, so time it ourselves.
        const ms = /in ([\d,]+)\s*ms/i.exec(body.message ?? '')?.[1]?.replace(/,/g, '') ?? (s.busySince ? String(Date.now() - s.busySince) : undefined);
        s.message = ms
          ? `${s.busy === 'reloading' ? 'Reloaded' : 'Restarted'} in ${ms} ms`
          : body.message || (s.busy === 'reloading' ? 'Reloaded' : 'Restarted');
        s.busy = undefined;
        // Show the result briefly, then go back to the plain "running" status.
        clearTimeout(this.messageTimer);
        this.messageTimer = setTimeout(() => {
          s.message = undefined;
          this.update();
        }, 4000);
        break;
      }
      case 'flutter.serviceExtensionStateChanged':
        if (body.extension === 'ext.flutter.inspector.show') {
          s.inspecting = body.value === true || body.value === 'true';
        } else return;
        break;
      default:
        return;
    }
    this.update();
  }

  /** The Flutter session running on the mirrored device, if any. */
  private current(): TrackedSession | undefined {
    const id = this.deviceId();
    if (!id) return undefined;
    return [...this.sessions.values()].find((s) => isFlutterApp(s) && s.deviceId === id);
  }

  // ---- state for the webview ----

  update() {
    this.publish(this.state());
  }

  state(): FlutterState | null {
    if (!this.deviceId()) return null;
    const s = this.current();
    if (s) {
      return {
        appName: this.projectFor(s.session)?.name ?? (s.session.name.replace(/\s*\(.*\)\s*$/, '') || 'Flutter app'),
        phase: s.busy ?? (s.started ? 'running' : 'starting'),
        mode: s.mode,
        message: s.message,
        inspecting: s.inspecting,
      };
    }
    if (!this.projects.length) return null;
    return {
      appName: this.projects.length === 1 ? this.projects[0].name : `${this.projects.length} Flutter apps`,
      phase: this.starting ? 'starting' : 'stopped',
      inspecting: false,
    };
  }

  private projectFor(session: vscode.DebugSession) {
    const c = session.configuration;
    const path = String(c.cwd ?? c.program ?? session.workspaceFolder?.uri.fsPath ?? '');
    return [...this.projects].reverse().find((p) => path.startsWith(p.dir));
  }

  // ---- actions ----

  async run(action: FlutterAction) {
    const s = this.current();
    try {
      switch (action) {
        case 'run':
          return await this.launch();
        case 'hotReload':
          return await s?.session.customRequest('hotReload', { reason: RELOAD_REASON });
        case 'hotRestart':
          return await s?.session.customRequest('hotRestart', { reason: RELOAD_REASON });
        case 'restart':
          if (s) {
            await vscode.debug.stopDebugging(s.session);
            await this.launch(s.session.workspaceFolder, s.session.configuration);
          }
          return;
        case 'stop':
          return s && (await vscode.debug.stopDebugging(s.session));
        case 'inspect':
          return await vscode.commands.executeCommand(s?.inspecting ? 'flutter.cancelInspectWidget' : 'flutter.inspectWidget');
        case 'devtools':
          return await vscode.commands.executeCommand('flutter.openDevTools');
        case 'more':
          return await this.moreMenu();
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Flutter: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Starts the app on the mirrored device, using the user's launch config when there is one. */
  private async launch(folder?: vscode.WorkspaceFolder, previous?: vscode.DebugConfiguration) {
    const deviceId = this.deviceId();
    if (!deviceId) return;
    if (!vscode.extensions.getExtension(DART_EXTENSION)) {
      const install = 'Install Flutter Extension';
      if ((await vscode.window.showWarningMessage('Running Flutter apps needs the Flutter extension for VS Code.', install)) === install) {
        await vscode.commands.executeCommand('workbench.extensions.search', DART_EXTENSION);
      }
      return;
    }
    let config: vscode.DebugConfiguration | undefined = previous && { ...previous };
    if (!config) {
      const project =
        this.projects.length === 1
          ? this.projects[0]
          : await vscode.window
              .showQuickPick(
                this.projects.map((p) => ({ label: p.name, description: vscode.workspace.asRelativePath(p.dir), p })),
                { title: 'Which Flutter app?' },
              )
              .then((pick) => pick?.p);
      if (!project) return;
      folder = project.folder;
      config = await this.pickLaunchConfig(project);
      if (!config) return;
    }
    config.deviceId = deviceId;
    this.starting = true;
    this.update();
    try {
      await vscode.debug.startDebugging(folder, config);
    } finally {
      this.starting = false;
      this.update();
    }
  }

  private async pickLaunchConfig(project: FlutterProject): Promise<vscode.DebugConfiguration | undefined> {
    const configs = (vscode.workspace.getConfiguration('launch', project.folder).get<vscode.DebugConfiguration[]>('configurations') ?? []).filter(
      (c) => c.type === 'dart' && c.request === 'launch',
    );
    const fallback: vscode.DebugConfiguration = {
      type: 'dart',
      request: 'launch',
      name: project.name,
      cwd: project.dir,
      program: join(project.dir, 'lib', 'main.dart'),
    };
    if (configs.length === 0) return fallback;
    if (configs.length === 1) return { ...configs[0] };
    const pick = await vscode.window.showQuickPick(
      configs.map((c) => ({ label: c.name as string, description: c.flutterMode ?? c.program, c })),
      { title: 'Launch configuration' },
    );
    return pick && { ...pick.c };
  }

  private async moreMenu() {
    type Item = vscode.QuickPickItem & { command?: string };
    const items: Item[] = [
      { label: 'Visual debugging', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(symbol-ruler) Toggle debug painting', command: 'flutter.toggleDebugPainting' },
      { label: '$(dashboard) Toggle performance overlay', command: 'flutter.togglePerformanceOverlay' },
      { label: '$(debug-step-over) Toggle slow animations', command: 'flutter.toggleSlowAnimations' },
      { label: '$(color-mode) Toggle repaint rainbow', command: 'flutter.toggleRepaintRainbow' },
      { label: '$(symbol-color) Toggle platform brightness', command: 'flutter.toggleBrightness' },
      { label: '$(tag) Toggle debug banner', command: 'flutter.toggleDebugModeBanner' },
      { label: 'DevTools', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(inspect) Widget inspector', command: 'dart.openDevToolsInspector' },
      { label: '$(pulse) Performance', command: 'dart.openDevToolsPerformance' },
      { label: '$(graph) CPU profiler', command: 'dart.openDevToolsCpuProfiler' },
      { label: '$(server) Memory', command: 'dart.openDevToolsMemory' },
      { label: '$(globe) Network', command: 'dart.openDevToolsNetwork' },
      { label: '$(output) Logging', command: 'dart.openDevToolsLogging' },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: 'Flutter' });
    if (pick?.command) await vscode.commands.executeCommand(pick.command);
  }

  dispose() {
    clearTimeout(this.messageTimer);
    this.disposables.forEach((d) => d.dispose());
  }
}

/** Flutter apps target a device (plain Dart scripts don't); tests are excluded. */
function isFlutterApp(s: TrackedSession) {
  const program = String(s.session.configuration.program ?? '');
  return (s.deviceId !== undefined || s.mode !== undefined) && !/_test\.dart$/.test(program);
}

async function exists(uri: vscode.Uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
