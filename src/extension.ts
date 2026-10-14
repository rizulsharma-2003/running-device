import * as vscode from 'vscode';
import { Adb, resolveAdbPath } from './android/adb';
import { AndroidBackend } from './android/androidBackend';
import { DevicesViewProvider } from './devicesView';

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Running Devices');
  const config = vscode.workspace.getConfiguration('runningDevices');
  const adb = new Adb(resolveAdbPath(config.get<string>('adbPath')));
  output.appendLine(`Using adb: ${adb.path}`);

  const serverJar = vscode.Uri.joinPath(context.extensionUri, 'resources', 'scrcpy-server').fsPath;
  const backends = [new AndroidBackend(adb, serverJar, (line) => output.appendLine(line))];
  const provider = new DevicesViewProvider(context.extensionUri, backends, output);

  context.subscriptions.push(
    output,
    provider,
    vscode.window.registerWebviewViewProvider(DevicesViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('runningDevices.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('runningDevices.stop', () => provider.stop()),
    vscode.commands.registerCommand('runningDevices.show', () =>
      vscode.commands.executeCommand(`${DevicesViewProvider.viewId}.focus`),
    ),
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
