# Running Devices

See and control your Android phone right inside VS Code, the same way Android Studio's **Running Devices** window works. Plug in a device, open the panel, and its screen appears next to your code. Tap, swipe, scroll and type with your mouse and keyboard.

No app to install on the phone, and no root.

## Getting started

1. Turn on **USB debugging** on your Android device (Settings → About phone → tap *Build number* 7 times, then Settings → Developer options → *USB debugging*).
2. Connect it with a USB cable and accept the "Allow USB debugging?" prompt on the phone. An emulator works too.
3. Click the **Running Devices** icon in the VS Code activity bar.

If only one device is connected, mirroring starts automatically. Otherwise pick one from the dropdown and press **Start**.

**Tip:** drag the panel into the Secondary Side Bar to keep the device on the right of your editor, like Android Studio.

## Controls

| On your computer | On the device |
| --- | --- |
| Click / drag | Tap / swipe |
| Scroll wheel, trackpad | Scroll |
| Right-click or Esc | Back |
| Typing (click the screen first) | Types into the focused field |
| Cmd/Ctrl + V | Pastes your clipboard text |
| Arrows, Enter, Backspace, Tab | The same keys |

The toolbar has **Back**, **Home**, **Overview**, **Volume up/down**, **Power** (hold for the power menu), **Rotate** and **Notifications**.

## Requirements

- **adb** from the Android SDK Platform-Tools. It's found automatically if Android Studio is installed, or if `adb` is on your `PATH`. Otherwise set `runningDevices.adbPath`.
- Android 5.0 or newer.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `runningDevices.adbPath` | auto-detect | Path to the adb executable |
| `runningDevices.maxSize` | `1600` | Longest side of the video in pixels (`0` = full resolution) |
| `runningDevices.bitRate` | `8000000` | Video bit rate. Lower it on slow USB connections |
| `runningDevices.maxFps` | `60` | Frame-rate limit |
| `runningDevices.stayAwake` | `true` | Keep the device awake while mirroring |
| `runningDevices.autoStart` | `true` | Start automatically when a single device is connected |

## Troubleshooting

- **"No devices found"**: run `adb devices` in a terminal. If the device shows as `unauthorized`, unlock the phone and accept the USB debugging prompt.
- **Black or frozen screen**: some devices struggle at high resolutions. Try `runningDevices.maxSize` = `1024`.
- **Anything else**: open **View → Output** and choose **Running Devices** to see the connection log.

## Coming soon

iOS device and simulator mirroring, multiple devices side by side, clipboard sync, and audio.

## Credits

Screen capture on the device uses [scrcpy](https://github.com/Genymobile/scrcpy) by Genymobile and Romain Vimont, licensed under Apache 2.0.
