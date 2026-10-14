# Running Devices

See and control your Android phone right inside VS Code, the same way Android Studio's **Running Devices** window works. Plug in a device, open the panel, and its screen appears next to your code. Tap, swipe, scroll and type with your mouse and keyboard.

No app to install on the phone, and no root.

## Getting started

1. Turn on **USB debugging** on your Android device (Settings → About phone → tap *Build number* 7 times, then Settings → Developer options → *USB debugging*).
2. Connect it with a USB cable and accept the "Allow USB debugging?" prompt on the phone. An emulator works too.
3. Click the **Running Devices** icon in the VS Code activity bar.

If only one device is connected, mirroring starts automatically. Otherwise pick one from the dropdown and press the ▶ (Start) button.

## Put it anywhere

Use the buttons in the panel's title bar:

- **Pop Out to Window** opens the device in its own floating window, which you can place on another monitor.
- **Open in Editor Tab** shows it as a tab, so you can split it next to your code.
- **Move View…** (under **⋯**) moves the panel to the Secondary Side Bar (on the right, like Android Studio), the bottom Panel, or back.

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
| `runningDevices.wakeOnHover` | `true` | Turn the screen on when the mouse is over it |

## Troubleshooting

- **"No devices found"**: run `adb devices` in a terminal. If the device shows as `unauthorized`, unlock the phone and accept the USB debugging prompt.
- **Black or frozen screen**: some devices struggle at high resolutions. Try `runningDevices.maxSize` = `1024`.
- **Anything else**: open **View → Output** and choose **Running Devices** to see the connection log.

## Coming soon

iOS device and simulator mirroring, multiple devices side by side, clipboard sync, and audio.

## Credits

Screen capture on the device uses [scrcpy](https://github.com/Genymobile/scrcpy) by Genymobile and Romain Vimont, licensed under Apache 2.0.
