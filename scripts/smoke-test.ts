// Headless end-to-end check against a real device, no VS Code needed:
//   npx esbuild scripts/smoke-test.ts --bundle --platform=node --outfile=dist/smoke-test.js && node dist/smoke-test.js [serial] [out.h264]
// Streams for a few seconds, reports what was received, and optionally saves the raw H.264.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Adb, resolveAdbPath } from '../src/android/adb';
import { AndroidBackend } from '../src/android/androidBackend';

async function main() {
  const adb = new Adb(resolveAdbPath());
  const backend = new AndroidBackend(adb, join(__dirname, '..', 'resources', 'scrcpy-server'), (l) => console.log('  [log]', l));
  const devices = await backend.listDevices();
  console.log('devices:', devices);
  const serial = process.argv[2] || devices.find((d) => d.state === 'device')?.id;
  if (!serial) {
    throw new Error('No device in "device" state');
  }

  const chunks: Buffer[] = [];
  let packets = 0;
  let keyFrames = 0;
  let bytes = 0;
  const started = Date.now();
  let closeError: Error | undefined;

  const session = await backend.startMirroring(
    serial,
    { maxSize: 1280, bitRate: 8_000_000, maxFps: 60, stayAwake: true },
    {
      onStream: (codec, name) => console.log(`stream: ${codec} from ${name}`),
      onSession: (w, h) => console.log(`session: ${w}x${h}`),
      onPacket: (data, key, config) => {
        packets++;
        bytes += data.length;
        if (key) keyFrames++;
        if (config) console.log(`config packet (${data.length} bytes): ${Buffer.from(data.subarray(0, 12)).toString('hex')}`);
        chunks.push(Buffer.from(data));
      },
      onClose: (err) => {
        closeError = err;
      },
    },
  );
  console.log(`connected in ${Date.now() - started} ms`);

  // Ask for a fresh key frame, then wait for traffic.
  session.sendInput({ type: 'requestKeyFrame' });
  await new Promise((r) => setTimeout(r, 4000));
  session.dispose();

  console.log(`received ${packets} packets, ${keyFrames} key frames, ${(bytes / 1024).toFixed(0)} KiB`);
  if (closeError) console.log('closed with error:', closeError.message);
  if (process.argv[3]) {
    writeFileSync(process.argv[3], Buffer.concat(chunks));
    console.log('wrote', process.argv[3]);
  }
  if (packets === 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
