import { randomBytes, randomInt } from 'node:crypto';
import * as QRCode from 'qrcode';
import * as vscode from 'vscode';
import type { DeviceTools } from './android/deviceTools';

const PAIRING_SERVICE = '_adb-tls-pairing._tcp';
const CONNECT_SERVICE = '_adb-tls-connect._tcp';
const POLL_MS = 1000;
const TIMEOUT_MS = 3 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const host = (address: string) => address.slice(0, address.lastIndexOf(':'));

/** After pairing, the phone advertises a connect service on the same IP; connect to it. */
async function connectAfterPairing(tools: DeviceTools, ip: string, isCancelled: () => boolean): Promise<string | null> {
  for (let i = 0; i < 15 && !isCancelled(); i++) {
    const service = (await tools.mdnsServices()).find((s) => s.type === CONNECT_SERVICE && host(s.address) === ip);
    if (service) {
      await tools.connect(service.address);
      return service.address;
    }
    await sleep(POLL_MS);
  }
  return null;
}

/**
 * "Pair devices using Wi-Fi" with a QR code, like Android Studio (Android 11+).
 * The QR encodes a service name and password; the phone advertises that name
 * over mDNS once scanned, and we pair with it.
 */
export async function pairWithQrCode(tools: DeviceTools, extensionUri: vscode.Uri, onConnected: (address: string) => void) {
  const name = `vscode-${randomBytes(3).toString('hex')}`;
  const password = String(randomInt(100000, 1000000)) + randomBytes(2).toString('hex');
  const svg = await QRCode.toString(`WIFI:T:ADB;S:${name};P:${password};;`, {
    type: 'svg',
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
  });

  const panel = vscode.window.createWebviewPanel('runningDevices.pair', 'Pair Device over Wi-Fi', vscode.ViewColumn.Active, {});
  panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');
  let closed = false;
  panel.onDidDispose(() => (closed = true));

  const render = (status: string, tone: 'waiting' | 'ok' | 'error' = 'waiting') => {
    if (!closed) panel.webview.html = pairingHtml(svg, status, tone);
  };
  render('Waiting for your phone to scan the code…');

  const deadline = Date.now() + TIMEOUT_MS;
  try {
    while (!closed && Date.now() < deadline) {
      const service = (await tools.mdnsServices()).find((s) => s.name === name && s.type === PAIRING_SERVICE);
      if (!service) {
        await sleep(POLL_MS);
        continue;
      }
      render(`Found your phone at ${host(service.address)}. Pairing…`);
      await tools.pair(service.address, password);
      render('Paired. Connecting…');
      const address = await connectAfterPairing(tools, host(service.address), () => closed);
      if (!address) {
        render(
          'Paired, but the phone did not show up for connection. Keep Wireless debugging open on the phone and run "Connect to Device over Wi-Fi…" with the IP address and port it shows.',
          'error',
        );
        return;
      }
      render(`Connected to ${address}. You can close this tab.`, 'ok');
      onConnected(address);
      setTimeout(() => panel.dispose(), 2500);
      return;
    }
    if (!closed) {
      render('Timed out. Close this tab and try again.', 'error');
    }
  } catch (err) {
    render(err instanceof Error ? err.message : String(err), 'error');
  }
}

/** Fallback for "Pair device with pairing code" on the phone. */
export async function pairWithCode(tools: DeviceTools, onConnected: (address: string) => void) {
  const address = await vscode.window.showInputBox({
    title: 'Pair with pairing code (1/2)',
    prompt: 'On the phone: Developer options → Wireless debugging → Pair device with pairing code. Enter the IP address & port shown there.',
    placeHolder: '192.168.1.20:37123',
    validateInput: (v) => (/^[\w.-]+:\d+$/.test(v.trim()) ? null : 'Expected host:port'),
  });
  if (!address) return;
  const code = await vscode.window.showInputBox({
    title: 'Pair with pairing code (2/2)',
    prompt: 'Wi-Fi pairing code shown on the phone',
    placeHolder: '123456',
    validateInput: (v) => (/^\d{6}$/.test(v.trim()) ? null : 'Six digits'),
  });
  if (!code) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Pairing over Wi-Fi…' },
    async (progress) => {
      await tools.pair(address.trim(), code.trim());
      progress.report({ message: 'Paired. Connecting…' });
      let connected = await connectAfterPairing(tools, host(address.trim()), () => false);
      if (!connected) {
        const manual = await vscode.window.showInputBox({
          title: 'Connect',
          prompt: 'Enter the IP address & port shown at the top of the Wireless debugging screen (not the pairing port).',
          placeHolder: '192.168.1.20:41234',
        });
        if (!manual) return;
        await tools.connect(manual.trim());
        connected = manual.trim();
      }
      onConnected(connected);
    },
  );
}

/** Switches a USB-connected device to adb over Wi-Fi, so the cable can be unplugged. */
export async function switchToWifi(tools: DeviceTools, serial: string): Promise<string> {
  const ip = await tools.wifiAddress(serial);
  if (!ip) {
    throw new Error('The device is not on Wi-Fi. Connect it to the same network as this computer.');
  }
  await tools.enableTcpip(serial, 5555);
  // adbd restarts in TCP mode; give it a moment before connecting.
  let lastError: unknown;
  for (let i = 0; i < 10; i++) {
    await sleep(700);
    try {
      await tools.connect(`${ip}:5555`);
      return `${ip}:5555`;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Could not connect to ${ip}:5555`);
}

function pairingHtml(svg: string, status: string, tone: 'waiting' | 'ok' | 'error') {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return /* html */ `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); display: flex; justify-content: center; padding: 32px 16px; }
  main { max-width: 440px; display: flex; flex-direction: column; align-items: center; gap: 20px; text-align: center; }
  h1 { font-size: 1.4em; font-weight: 600; margin: 0; }
  .qr { width: 240px; height: 240px; padding: 8px; background: #fff; border-radius: 12px; }
  .qr svg { width: 100%; height: 100%; display: block; }
  ol { text-align: left; line-height: 1.7; margin: 0; padding-left: 1.2em; color: var(--vscode-descriptionForeground); }
  b { color: var(--vscode-foreground); font-weight: 600; }
  .status { padding: 8px 14px; border-radius: 6px; background: var(--vscode-textBlockQuote-background); }
  .status.ok { color: var(--vscode-testing-iconPassed, #73c991); }
  .status.error { color: var(--vscode-errorForeground); }
  .status.waiting::before { content: ''; display: inline-block; width: 8px; height: 8px; margin-right: 8px; border-radius: 50%;
    background: var(--vscode-progressBar-background, #0078d4); animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .25; } }
  .note { font-size: .9em; color: var(--vscode-descriptionForeground); }
</style></head>
<body><main>
  <h1>Pair a device over Wi-Fi</h1>
  <div class="qr">${svg}</div>
  <ol>
    <li>Connect the phone to the <b>same Wi-Fi network</b> as this computer.</li>
    <li>On the phone, open <b>Settings → Developer options → Wireless debugging</b> and turn it on.</li>
    <li>Tap <b>Pair device with QR code</b> and scan this code.</li>
  </ol>
  <div class="status ${tone}">${esc(status)}</div>
  <p class="note">Requires Android 11 or newer. On older phones, connect with USB once and use <b>Switch to Wi-Fi</b>.</p>
</main></body></html>`;
}
