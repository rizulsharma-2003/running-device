// Downloads the scrcpy server that gets pushed to Android devices.
// The client protocol in src/android/scrcpy is written against this exact
// version: bump SCRCPY_VERSION in src/android/scrcpy/protocol.ts together with
// VERSION and SHA256 here.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const VERSION = '5.0.1';
const SHA256 = '764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536';
const URL = `https://github.com/Genymobile/scrcpy/releases/download/v${VERSION}/scrcpy-server-v${VERSION}`;
const OUT = new globalThis.URL('../resources/scrcpy-server', import.meta.url);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

if (existsSync(OUT) && sha256(readFileSync(OUT)) === SHA256) {
  console.log(`scrcpy-server v${VERSION} already present`);
  process.exit(0);
}

console.log(`Downloading ${URL}`);
const res = await fetch(URL);
if (!res.ok) {
  throw new Error(`Download failed: HTTP ${res.status}`);
}
const buf = Buffer.from(await res.arrayBuffer());
const actual = sha256(buf);
if (actual !== SHA256) {
  throw new Error(`Checksum mismatch: expected ${SHA256}, got ${actual}`);
}
mkdirSync(new globalThis.URL('../resources/', import.meta.url), { recursive: true });
writeFileSync(OUT, buf);
console.log(`Saved scrcpy-server v${VERSION}`);
