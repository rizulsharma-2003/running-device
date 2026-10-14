# Running Devices

See and control your Android phone right inside VS Code. Plug in a device, open the panel, and its live screen appears next to your code. Tap, swipe, scroll and type with your mouse and keyboard.

No app to install on the phone, and no root.

## Getting started

1. Turn on **USB debugging** on your Android device (Settings → About phone → tap *Build number* 7 times, then Settings → Developer options → *USB debugging*).
2. Connect it with a USB cable and accept the "Allow USB debugging?" prompt on the phone. An emulator works too.
3. Click the **Running Devices** icon in the VS Code activity bar.

If only one device is connected, mirroring starts automatically. Otherwise pick one from the dropdown and press the ▶ (Start) button.

## Features

- **Screenshot** (camera button in the toolbar): saves a full-resolution PNG and opens it in VS Code.
- **Record screen** (● in the toolbar): records an MP4 with no time limit. Click again to stop; a timer shows while recording.
- **Install APKs**: drop an `.apk` onto the device screen, or right-click it in the Explorer → *Install APK on Android Device*. Drop any other file to copy it to the phone's Downloads.
- **Logcat**: colored logs for the app in the foreground, in a VS Code terminal. It keeps following the app when it restarts.
- **Apps**: launch any installed app, open a deep link (`myapp://…`) to test it, or restart, force stop, clear data and uninstall the current app.
- **Quick settings**: toggle dark theme, font size, display size, layout bounds, show taps and animation speed without touching the phone.
- **Wireless**: pair over Wi-Fi by scanning a QR code (Android 11+), or switch a USB-connected phone to Wi-Fi in one click and unplug it.
- **Performance stats**: live fps, bitrate and resolution over the screen.

Everything beyond the toolbar is in the **⋯** menu and in the Command Palette under *Running Devices*.

## Put it anywhere

Use the buttons in the panel's title bar:

- **Pop Out to Window** opens the device in its own floating window, which you can place on another monitor.
- **Open in Editor Tab** shows it as a tab, so you can split it next to your code.
- **Move View…** (under **⋯**) moves the panel to the Secondary Side Bar (to keep the device on the right of your code), the bottom Panel, or back.

Only one place shows the live screen at a time. The others show a **Show here** button to bring it back. Switching doesn't reconnect to the device.

## Controls

| On your computer | On the device |
| --- | --- |
| Click / drag | Tap / swipe |
| Scroll wheel, trackpad | Scroll |
| Right-click or Esc | Back |
| Typing (click the screen first) | Types into the focused field |
| Cmd/Ctrl + V | Pastes your clipboard text |
| Moving the mouse over the screen | Wakes the screen if it's off and keeps it on |
| Arrows, Enter, Backspace, Tab | The same keys |

The toolbar has **Back**, **Home**, **Overview**, **Volume up/down**, **Power** (hold for the power menu), **Rotate** and **Notifications**.

## Requirements

- **adb** from the Android SDK Platform-Tools. It's found automatically if the Android SDK is installed in its default location, or if `adb` is on your `PATH`. Otherwise set `runningDevices.adbPath`.
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
| `runningDevices.wakeOnHover` | `true` | Turn the screen on when the mouse is over it |
| `runningDevices.captureFolder` | Desktop | Where screenshots and recordings are saved (supports `~` and `${workspaceFolder}`) |
| `runningDevices.openCaptures` | `true` | Open screenshots and recordings in VS Code after saving |
| `runningDevices.logcatLevel` | `V` | Minimum Logcat level: V, D, I, W or E |

## Troubleshooting

- **"No devices found"**: run `adb devices` in a terminal. If the device shows as `unauthorized`, unlock the phone and accept the USB debugging prompt.
- **Black or frozen screen**: some devices struggle at high resolutions. Try `runningDevices.maxSize` = `1024`.
- **Quick settings say the phone blocks changes**: Xiaomi, OPPO, Realme and OnePlus phones need an extra switch in Developer options: *Disable permission monitoring* (OPPO, Realme, OnePlus) or *USB debugging (Security settings)* (Xiaomi). Dark theme and layout bounds work without it.
- **Wi-Fi pairing doesn't find the phone**: the phone and computer must be on the same network, and some office or guest networks block device discovery. Use *Pair with pairing code* or *Switch USB device to Wi-Fi* instead.
- **Anything else**: open **View → Output** and choose **Running Devices** to see the connection log.

## Coming soon

iOS device and simulator mirroring, multiple devices side by side, clipboard sync, and audio forwarding.

## Credits

Screen capture on the device uses [scrcpy](https://github.com/Genymobile/scrcpy) by Genymobile and Romain Vimont, licensed under Apache 2.0.
