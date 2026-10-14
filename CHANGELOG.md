# Changelog

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
