# Changelog

## 0.7.0

- **iPhone touch control** (optional): click to tap, drag to swipe or scroll, hold for long-press, and type into the iPhone from VS Code. Toolbar buttons map to iPhone gestures (Back = edge swipe, Overview = app switcher, Home, volume, lock, rotate).
- One-time setup from **⋯ → Enable touch control**: builds WebDriverAgent with your Apple Development signing; afterwards it starts automatically whenever you mirror the iPhone

## 0.6.0

- **iPhone and iPad mirroring** (macOS): connect with a USB cable and the device shows up next to your Android devices, at up to 60 fps. View-only, since iOS doesn't allow input from a Mac.
- Full-resolution iPhone screenshots and MP4 recording, device frame with iPhone-style corners
- The Flutter bar works with Flutter apps running on a mirrored iPhone

## 0.5.0

- **Flutter controls**: when a Flutter app from VS Code runs on the mirrored device, a Flutter bar appears with hot reload, hot restart, restart, stop, widget inspector and DevTools, plus live status ("Hot reloading…", "Reloaded in 312 ms"). Hot reloads on save show up there too.
- **Run on this device**: in a Flutter project, start the app on the mirrored device in one click (uses your launch configuration if you have one)
- **Inspect widget**: turn on select mode, tap a widget on the mirrored screen, and jump to its code
- Visual debugging toggles (debug painting, performance overlay, slow animations, repaint rainbow) and DevTools pages in the Flutter ⋯ menu

## 0.4.0

A complete visual redesign.

- The screen sits in a realistic device frame that sizes itself to the panel, with a soft glow while live
- Device chip with live status, Android version and connection type (USB, Wi-Fi, emulator)
- The screen always gets the most room: device controls sit beside or below it only when there's spare space, otherwise they tuck behind a handle at the bottom edge and slide up on hover
- Capture actions grouped in one control, a recording pill with a live timer, and a single start/stop button
- Clear states for every situation: connect a device (with Wi-Fi pairing), connecting, errors with Try again and Show log, and "showing in another window"
- Rotate now sticks even with auto-rotate on, and tells you when the app in front is locked to portrait or landscape
- Quick tooltips, press feedback, and full support for light, dark and high-contrast themes

## 0.3.0

- **Screenshots** at full device resolution, opened in VS Code, with Copy Image (macOS, Windows)
- **Screen recording** to MP4 straight from the mirror stream: no time limit, no extra load on the phone, live timer in the toolbar
- **Wi-Fi**: pair with a QR code (Android 11+) or pairing code, switch a USB device to Wi-Fi, or connect by IP
- **Logcat** in a colored terminal, filtered to the current app and following it across restarts
- **Install APKs** by dropping them on the screen or from the Explorer context menu; copy any file to the phone's Downloads
- **App actions**: launch any app, open deep links, restart / force stop / clear data / uninstall the current app
- **Quick settings**: dark theme, font size, display size, layout bounds, show taps, animation speed
- **Performance stats** overlay (fps, bitrate, resolution)

## 0.2.0

- **Pop out to window**: show the device in its own floating window, or as an editor tab
- **Move View…** button to place the panel in the Side Bar, Secondary Side Bar or Panel
- **Wake on hover**: moving the mouse over the screen turns the device screen on and keeps it awake (`runningDevices.wakeOnHover`)
- Redesigned toolbar with a consistent icon set that follows your theme
- The stream moves between side bar, tab and window without reconnecting

## 0.1.0

First release.

- Mirror a connected Android device or emulator in a VS Code panel
- Control it with mouse, trackpad and keyboard, including clipboard paste
- Toolbar with Back, Home, Overview, Volume, Power, Rotate and Notifications
- Automatically starts with a single device, follows rotation, and stops when the device is unplugged
