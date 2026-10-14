import * as vscode from 'vscode';
import { Adb, resolveAdbPath } from './android/adb';
import { AndroidBackend } from './android/androidBackend';
import { DeviceTools } from './android/deviceTools';
import { DeviceActions } from './actions';
import { MirrorController } from './mirrorController';
import { DevicePanel, DevicesViewProvider } from './surfaces';

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Running Devices');
  const config = vscode.workspace.getConfiguration('runningDevices');
  const adb = new Adb(resolveAdbPath(config.get<string>('adbPath')));
  output.appendLine(`Using adb: ${adb.path}`);

  const serverJar = vscode.Uri.joinPath(context.extensionUri, 'resources', 'scrcpy-server').fsPath;
  const backends = [new AndroidBackend(adb, serverJar, (line) => output.appendLine(line))];
  const controller = new MirrorController(backends, output);
  const panel = new DevicePanel(context.extensionUri, controller);
  const actions = new DeviceActions(controller, new DeviceTools(adb), context.extensionUri);

  const focusView = () => vscode.commands.executeCommand(`${DevicesViewProvider.viewId}.focus`);

  context.subscriptions.push(
    ...actions.register(),
    output,
    controller,
    vscode.window.registerWebviewViewProvider(
      DevicesViewProvider.viewId,
      new DevicesViewProvider(context.extensionUri, controller),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    // Restores the editor tab / floating window after a window reload.
    vscode.window.registerWebviewPanelSerializer(DevicePanel.viewType, {
      async deserializeWebviewPanel(webviewPanel) {
        panel.adopt(webviewPanel);
      },
    }),
    vscode.commands.registerCommand('runningDevices.refresh', () => controller.refresh()),
    vscode.commands.registerCommand('runningDevices.showLog', () => output.show()),
    vscode.commands.registerCommand('runningDevices.stop', () => controller.stop()),
    vscode.commands.registerCommand('runningDevices.show', focusView),
    vscode.commands.registerCommand('runningDevices.openInEditor', () => panel.open()),
    vscode.commands.registerCommand('runningDevices.popOut', () => panel.popOut()),
    vscode.commands.registerCommand('runningDevices.moveToSideBar', async () => {
      panel.close();
      await focusView();
    }),
    vscode.commands.registerCommand('runningDevices.moveView', async () => {
      await focusView();
      await vscode.commands.executeCommand('workbench.action.moveFocusedView');
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('runningDevices.adbPath')) {
        void vscode.window
          .showInformationMessage('Reload the window to use the new adb path.', 'Reload')
          .then((choice) => choice && vscode.commands.executeCommand('workbench.action.reloadWindow'));
      }
    }),
  );
}

export function deactivate() {}
