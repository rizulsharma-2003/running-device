# Running Devices for VS Code

Mirror and control a connected Android device inside VS Code, like Android Studio's **Running Devices** window. iOS support is planned (see [Roadmap](#roadmap)).

## Features (Android)

- Live screen mirroring (H.264, hardware-decoded via WebCodecs, low latency)
- Touch: click/drag to tap and swipe; multi-touch on touch-screen laptops
- Scroll wheel / trackpad scrolling
- Keyboard: type into the device when the screen has focus; arrows, Enter, Backspace, Tab, Esc (= Back), and Cmd+V paste text
- Toolbar: Back, Home, Overview, Volume ±, Power (long-press works), Rotate, Notifications
- Right-click = Back
- Auto-starts when exactly one device is connected; follows rotation; stops cleanly when the device is unplugged

## Requirements

- `adb` (Android SDK Platform-Tools). Auto-detected from `ANDROID_HOME`, `ANDROID_SDK_ROOT`, the default SDK location, or `PATH`; override with `runningDevices.adbPath`.
- A device or emulator with USB debugging enabled (Android 5.0+).

## Develop

```bash
npm install
npm run fetch-server   # downloads scrcpy-server (already present in resources/)
npm run build
```

Then open this folder in VS Code and press **F5** ("Run Extension"). In the new window, click the phone icon in the activity bar. Drag the view to the secondary sidebar if you want it on the right like Android Studio.

`npm run watch` rebuilds on change; reload the Extension Development Host window (Cmd+R) to pick it up.

### Test without VS Code

```bash
npx esbuild scripts/smoke-test.ts --bundle --platform=node --outfile=dist/smoke-test.js
node dist/smoke-test.js [serial] [out.h264]
```

Connects to the device, streams for 4 seconds, and reports what arrived.

## How it works

```
 VS Code extension host (Node)                         Android device
 ┌──────────────────────────────┐   adb push / forward   ┌──────────────────────┐
 │ AndroidBackend               │ ─────────────────────▶ │ scrcpy-server.jar    │
 │  └ ScrcpySession             │                        │ (app_process, shell) │
 │     video socket  ◀──────────│──── H.264 packets ─────│  MediaCodec encoder  │
 │     control socket ──────────│──── touch/keys ───────▶│  InputManager inject │
 └──────────────┬───────────────┘                        └──────────────────────┘
                │ postMessage (packets / input)
 ┌──────────────▼───────────────┐
 │ Webview                      │
 │  VideoDecoder → <canvas>     │
 │  pointer/keyboard → input    │
 └──────────────────────────────┘
```

This is the same technique Android Studio's device mirroring and [scrcpy](https://github.com/Genymobile/scrcpy) use: a small server runs on the device as the `shell` user, captures the display into the hardware video encoder, and streams it over an adb tunnel.

| Path | Role |
| --- | --- |
| [src/extension.ts](src/extension.ts) | Activation, commands, wiring |
| [src/devicesView.ts](src/devicesView.ts) | Webview view: device polling, session lifecycle, message routing |
| [src/backend.ts](src/backend.ts) | Platform-neutral `DeviceBackend` / `MirrorSession` interfaces |
| [src/android/adb.ts](src/android/adb.ts) | adb discovery and commands |
| [src/android/scrcpy/](src/android/scrcpy/) | scrcpy v5.0.1 wire protocol, socket handling, demuxing |
| [shared/messages.ts](shared/messages.ts) | Host ⇄ webview message types |
| [webview/](webview/) | Decoder, rendering and input capture |

**scrcpy version pinning.** The scrcpy client/server protocol is internal and changes between releases, so `resources/scrcpy-server` must match `SCRCPY_VERSION` in [protocol.ts](src/android/scrcpy/protocol.ts). To upgrade, bump both that constant and `VERSION`/`SHA256` in [scripts/fetch-scrcpy-server.mjs](scripts/fetch-scrcpy-server.mjs), then re-check the protocol section of scrcpy's `doc/develop.md` and `app/src/control_msg.c` for changes.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `runningDevices.adbPath` | auto | Path to adb |
| `runningDevices.maxSize` | 1600 | Longest video side in px (0 = native) |
| `runningDevices.bitRate` | 8000000 | Video bit rate |
| `runningDevices.maxFps` | 60 | Frame-rate cap |
| `runningDevices.stayAwake` | true | Keep the device awake while mirroring |
| `runningDevices.autoStart` | true | Start automatically with a single device |

## Roadmap

**Android, next**
- Multiple devices at once (tabs, like Android Studio)
- Clipboard sync (device → host uses the control socket's device messages)
- Audio forwarding (scrcpy supports Opus/AAC on Android 11+)
- Wireless debugging pairing (`adb pair` / `adb connect`) from the UI
- Emulator launch from the device picker (`emulator -list-avds`)
- Screenshot and screen recording buttons

**iOS.** Add an `IosBackend` implementing `DeviceBackend`; the webview needs no changes as long as it emits H.264 packets. Likely approaches:
- *Simulators*: `xcrun simctl io <udid> screenshot` is too slow for live video; [`idb`](https://fbidb.io) (`idb video-stream --format h264`) gives a stream plus `idb ui tap/swipe/text` for input.
- *Physical devices*: video via the CoreMediaIO screen-capture stream QuickTime uses (enable with `CMIOObjectSetPropertyData` "allow screen capture devices", then AVFoundation capture, encode with VideoToolbox) in a small helper binary; input via [WebDriverAgent](https://github.com/appium/WebDriverAgent) (taps, swipes, keys). macOS-only, and needs a signed WDA build on the device.

## Licensing

`resources/scrcpy-server` is built by the [scrcpy](https://github.com/Genymobile/scrcpy) project and distributed under the Apache License 2.0. Include scrcpy's license and notice when publishing this extension.
