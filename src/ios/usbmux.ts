import { createConnection, createServer, type Server, type Socket } from 'node:net';

// Minimal client for macOS's usbmuxd: the daemon Xcode and Finder use to talk
// to iPhones over USB. "Connect" turns a usbmuxd socket into a raw TCP tunnel
// to a port on the device, which is how we reach WebDriverAgent (port 8100)
// without Wi-Fi.

const SOCKET = '/var/run/usbmuxd';
const PLIST_MESSAGE = 8;
const CLIENT = { ClientVersionString: 'running-devices', ProgName: 'running-devices' };

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

// ---- tiny XML plist codec (only what usbmuxd uses) ----

function encodePlist(value: Record<string, PlistValue>): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const enc = (v: PlistValue): string => {
    if (typeof v === 'string') return `<string>${esc(v)}</string>`;
    if (typeof v === 'number') return `<integer>${Math.trunc(v)}</integer>`;
    if (typeof v === 'boolean') return v ? '<true/>' : '<false/>';
    if (Array.isArray(v)) return `<array>${v.map(enc).join('')}</array>`;
    return `<dict>${Object.entries(v).map(([k, x]) => `<key>${esc(k)}</key>${enc(x)}`).join('')}</dict>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${enc(value)}</plist>`;
}

function decodePlist(xml: string): any {
  const tokens = xml.replace(/<\?xml[^>]*>|<!DOCTYPE[^>]*>|<\/?plist[^>]*>/g, '').match(/<[^>]+>|[^<]+/g) ?? [];
  let i = 0;
  const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const next = () => {
    while (i < tokens.length && !tokens[i].trim()) i++;
    return tokens[i++];
  };
  const textUntil = (close: string) => {
    let text = '';
    while (i < tokens.length && tokens[i] !== close) text += tokens[i++];
    i++;
    return unesc(text);
  };
  const value = (tag: string): any => {
    switch (tag) {
      case '<dict>': {
        const obj: Record<string, any> = {};
        for (let t = next(); t !== '</dict>'; t = next()) {
          const key = textUntil('</key>');
          obj[key] = value(next());
        }
        return obj;
      }
      case '<dict/>':
        return {};
      case '<array>': {
        const arr: any[] = [];
        for (let t = next(); t !== '</array>'; t = next()) arr.push(value(t));
        return arr;
      }
      case '<array/>':
        return [];
      case '<string>':
        return textUntil('</string>');
      case '<string/>':
        return '';
      case '<integer>':
        return Number(textUntil('</integer>'));
      case '<real>':
        return Number(textUntil('</real>'));
      case '<data>':
        return textUntil('</data>').trim();
      case '<true/>':
        return true;
      case '<false/>':
        return false;
      default:
        return undefined;
    }
  };
  return value(next());
}

// ---- protocol ----

function frame(message: Record<string, PlistValue>, tag: number): Buffer {
  const body = Buffer.from(encodePlist(message), 'utf8');
  const header = Buffer.alloc(16);
  header.writeUInt32LE(16 + body.length, 0);
  header.writeUInt32LE(1, 4); // version
  header.writeUInt32LE(PLIST_MESSAGE, 8);
  header.writeUInt32LE(tag, 12);
  return Buffer.concat([header, body]);
}

/** Sends one request and resolves with the reply; the socket is left open (for Connect). */
function request(message: Record<string, PlistValue>): Promise<{ reply: any; socket: Socket; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(SOCKET);
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 16) return;
      const length = buf.readUInt32LE(0);
      if (buf.length < length) return;
      socket.off('data', onData);
      socket.off('error', reject);
      resolve({ reply: decodePlist(buf.subarray(16, length).toString('utf8')), socket, rest: buf.subarray(length) });
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.once('connect', () => socket.write(frame({ ...message, ...CLIENT }, 1)));
  });
}

/** usbmuxd's numeric id for a device, by UDID (USB connections preferred). */
export async function findDevice(udid: string): Promise<number | null> {
  const { reply, socket } = await request({ MessageType: 'ListDevices' });
  socket.destroy();
  const norm = (s: string) => s.replace(/-/g, '').toUpperCase();
  const matches = (reply.DeviceList ?? []).filter((d: any) => norm(String(d.Properties?.SerialNumber ?? '')) === norm(udid));
  const usb = matches.find((d: any) => d.Properties?.ConnectionType === 'USB') ?? matches[0];
  return usb ? Number(usb.DeviceID) : null;
}

/** A raw TCP connection to `port` on the device, tunneled over USB. */
export async function connectToDevice(deviceId: number, port: number): Promise<Socket> {
  const swapped = ((port & 0xff) << 8) | ((port >> 8) & 0xff); // usbmuxd wants network byte order
  const { reply, socket, rest } = await request({ MessageType: 'Connect', DeviceID: deviceId, PortNumber: swapped });
  if (reply.Number !== 0) {
    socket.destroy();
    throw new Error(`usbmuxd refused the connection to port ${port} (code ${reply.Number})`);
  }
  if (rest.length) socket.unshift(rest);
  return socket;
}

/** Local TCP server that forwards every connection to `port` on the device. Resolves with the local port. */
export function forwardPort(deviceId: number, port: number): Promise<{ port: number; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer((local) => {
      connectToDevice(deviceId, port).then(
        (remote) => {
          local.pipe(remote).pipe(local);
          const close = () => {
            local.destroy();
            remote.destroy();
          };
          local.on('error', close);
          remote.on('error', close);
          local.on('close', close);
          remote.on('close', close);
        },
        () => local.destroy(),
      );
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ port: typeof address === 'object' && address ? address.port : 0, server });
    });
  });
}
