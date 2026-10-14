# Contributing to Running Devices

Developer notes: building, running, architecture, and roadmap. The user-facing docs are in [README.md](README.md).

## Develop

```bash
npm install
npm run fetch-server   # downloads scrcpy-server (already present in resources/)
npm run build
```

Then open this folder in VS Code and press **F5** ("Run Extension"), or run the task **Run Extension (no debugger)**. In the new window, click the phone icon in the activity bar. Drag the view to the secondary sidebar if you want it on the right like Android Studio.

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
| [src/mirrorController.ts](src/mirrorController.ts) | Device polling, session lifecycle, routes the stream to the active surface |
| [src/surfaces.ts](src/surfaces.ts) | Side bar view and editor tab / floating window that display the device |
| [src/html.ts](src/html.ts) | Webview markup and the toolbar icon set |
| [src/actions.ts](src/actions.ts) | Commands and menus: capture, apps, files, quick settings, Wi-Fi |
| [src/android/deviceTools.ts](src/android/deviceTools.ts) | The adb calls behind those actions (no VS Code dependency) |
| [src/recorder.ts](src/recorder.ts) | Annex B → MP4 muxing of the mirror stream |
| [src/logcat.ts](src/logcat.ts) | Logcat pseudo-terminal with per-app pid tracking |
| [src/wifi.ts](src/wifi.ts) | QR / code pairing over mDNS, switch to Wi-Fi |
| [src/ios/iosBackend.ts](src/ios/iosBackend.ts) | iPhone/iPad backend: device watcher, devicectl lookup, stream sessions |
| [native/ios-mirror/main.swift](native/ios-mirror/main.swift) | macOS helper: CoreMediaIO screen capture → VideoToolbox H.264 → scrcpy framing on stdout. Rebuild with `npm run build-ios-helper` |
| [src/ios/wdaManager.ts](src/ios/wdaManager.ts) | iPhone touch control: builds/launches WebDriverAgent, maps mirror input to iOS gestures |
| [src/ios/deviceLogs.ts](src/ios/deviceLogs.ts) | iPhone device log (idevicesyslog) and crash/kill reports (devicectl) |
| [src/ios/usbmux.ts](src/ios/usbmux.ts) | usbmuxd client: TCP tunnel to the iPhone over USB |
| [src/ios/wda.ts](src/ios/wda.ts) | WebDriverAgent HTTP client |
| [src/videoStream.ts](src/videoStream.ts) | Shared demuxer for the packet framing |
| [src/flutter.ts](src/flutter.ts) | Flutter bar: finds the Dart-Code debug session on the mirrored device and drives hot reload, restart, inspector |
| [src/backend.ts](src/backend.ts) | Platform-neutral `DeviceBackend` / `MirrorSession` interfaces |
| [src/android/adb.ts](src/android/adb.ts) | adb discovery and commands |
| [src/android/scrcpy/](src/android/scrcpy/) | scrcpy v5.0.1 wire protocol, socket handling, demuxing |
| [shared/messages.ts](shared/messages.ts) | Host ⇄ webview message types |
| [webview/](webview/) | Decoder, rendering and input capture |

**scrcpy version pinning.** The scrcpy client/server protocol is internal and changes between releases, so `resources/scrcpy-server` must match `SCRCPY_VERSION` in [protocol.ts](src/android/scrcpy/protocol.ts). To upgrade, bump both that constant and `VERSION`/`SHA256` in [scripts/fetch-scrcpy-server.mjs](scripts/fetch-scrcpy-server.mjs), then re-check the protocol section of scrcpy's `doc/develop.md` and `app/src/control_msg.c` for changes.

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

## Packaging and publishing

```bash
npm run package                      # typecheck + production build + .vsix
code --install-extension running-devices-*.vsix   # install into your normal VS Code
npx vsce publish                     # VS Code Marketplace (needs `vsce login <publisher>`)
npx ovsx publish running-devices-*.vsix -p <token>   # Open VSX (Cursor, VSCodium, Windsurf)
```

Bump `version` in package.json and add a CHANGELOG.md entry before each publish.

## Licensing

`resources/scrcpy-server` is built by the [scrcpy](https://github.com/Genymobile/scrcpy) project under the Apache License 2.0; its license ships in `resources/scrcpy-LICENSE`.
