import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { HostMessage, WebviewMessage } from '../shared/messages';
import { renderHtml } from './html';
import type { MirrorController, Surface } from './mirrorController';

function setupWebview(webview: vscode.Webview, extensionUri: vscode.Uri) {
  webview.options = {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'media')],
  };
  webview.html = renderHtml({
    cspSource: webview.cspSource,
    nonce: randomBytes(16).toString('base64'),
    scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js')).toString(),
    styleUri: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview.css')).toString(),
  });
}

/** The "Running Devices" view. Users can drag it to the Panel or Secondary Side Bar. */
export class DevicesViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'runningDevices.view';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: MirrorController,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    setupWebview(view.webview, this.extensionUri);
    const surface: Surface = {
      get visible() {
        return view.visible;
      },
      post: (msg: HostMessage) => void view.webview.postMessage(msg),
    };
    view.webview.onDidReceiveMessage((msg: WebviewMessage) => this.controller.onMessage(surface, msg));
    view.onDidChangeVisibility(() => this.controller.updatePolling());
    view.onDidDispose(() => this.controller.detach(surface));
    this.controller.attach(surface, false);
  }
}

/** The device as an editor tab, which VS Code can move into its own floating window. */
export class DevicePanel {
  static readonly viewType = 'runningDevices.panel';
  private panel: vscode.WebviewPanel | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: MirrorController,
  ) {}

  get isOpen() {
    return !!this.panel;
  }

  open(column = vscode.ViewColumn.Beside): vscode.WebviewPanel {
    if (this.panel) {
      this.panel.reveal(column);
      return this.panel;
    }
    const panel = vscode.window.createWebviewPanel(DevicePanel.viewType, 'Running Devices', column, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.adopt(panel);
    return panel;
  }

  /** Opens the device in an editor tab, then moves that tab into a new window. */
  async popOut() {
    const panel = this.open(vscode.ViewColumn.Active);
    panel.reveal(undefined, false);
    await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
  }

  close() {
    this.panel?.dispose();
  }

  /** Takes over a panel we created, or one VS Code restored after a reload. */
  adopt(panel: vscode.WebviewPanel) {
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png');
    setupWebview(panel.webview, this.extensionUri);
    const surface: Surface = {
      get visible() {
        return panel.visible;
      },
      post: (msg: HostMessage) => void panel.webview.postMessage(msg),
    };
    panel.webview.onDidReceiveMessage((msg: WebviewMessage) => this.controller.onMessage(surface, msg));
    panel.onDidChangeViewState(() => this.controller.updatePolling());
    panel.onDidDispose(() => {
      this.panel = null;
      this.controller.detach(surface);
      void vscode.commands.executeCommand('setContext', 'runningDevices.panelOpen', false);
    });
    void vscode.commands.executeCommand('setContext', 'runningDevices.panelOpen', true);
    this.controller.attach(surface, true);
  }
}
