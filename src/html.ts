// Markup shared by every surface (side bar view, editor tab, floating window).

/** One consistent icon set: 16×16 grid, 1.5px rounded strokes, currentColor. */
const ICONS = {
  play: '<path d="M5 3.8v8.4a.6.6 0 0 0 .9.5l6.6-4.2a.6.6 0 0 0 0-1L5.9 3.3a.6.6 0 0 0-.9.5z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none"/>',
  back: '<path d="M11 3.5v9L4.5 8z"/>',
  home: '<circle cx="8" cy="8" r="4.5"/>',
  recents: '<rect x="3.5" y="3.5" width="9" height="9" rx="2"/>',
  volumeDown: '<path d="M2.5 6.2h2L8 3.5v9l-3.5-2.7h-2z"/><path d="M10.5 8h3.5"/>',
  volumeUp: '<path d="M2.5 6.2h2L8 3.5v9l-3.5-2.7h-2z"/><path d="M10.5 8h3.5M12.25 6.25v3.5"/>',
  power: '<path d="M8 2.5V7.5"/><path d="M4.8 4.6a4.75 4.75 0 1 0 6.4 0"/>',
  rotate: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9L13.5 5.7"/><path d="M13.5 2.5v3.2h-3.2"/>',
  screenshot: '<path d="M2.5 5.75a1.25 1.25 0 0 1 1.25-1.25h1.5l1-1.5h3.5l1 1.5h1.5a1.25 1.25 0 0 1 1.25 1.25v5.5a1.25 1.25 0 0 1-1.25 1.25h-8.5a1.25 1.25 0 0 1-1.25-1.25z"/><circle cx="8" cy="8.25" r="2.25"/>',
  record: '<circle cx="8" cy="8" r="5.25"/><circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none"/>',
  more: '<circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none"/>',
  notifications: '<path d="M4.25 11V7.25a3.75 3.75 0 0 1 7.5 0V11l1 1.25h-9.5z"/><path d="M6.75 14h2.5"/>',
} as const;

export function icon(name: keyof typeof ICONS): string {
  return `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

const iconButton = (button: string, title: string, iconName: keyof typeof ICONS) =>
  `<button class="icon-button" data-button="${button}" title="${title}" aria-label="${title}">${icon(iconName)}</button>`;

export function renderHtml(opts: { cspSource: string; nonce: string; scriptUri: string; styleUri: string }): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${opts.cspSource} data:; style-src ${opts.cspSource}; script-src 'nonce-${opts.nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${opts.styleUri}" rel="stylesheet">
</head>
<body data-state="idle">
  <header class="toolbar">
    <select id="device" title="Device" aria-label="Device"></select>
    <button id="toggle" class="icon-button toggle" title="Start mirroring" aria-label="Start mirroring">
      <span class="when-stopped">${icon('play')}</span><span class="when-running">${icon('stop')}</span>
    </button>
    <span class="divider"></span>
    <button class="icon-button needs-stream" data-action="screenshot" title="Take screenshot" aria-label="Take screenshot">${icon('screenshot')}</button>
    <button class="icon-button needs-stream record" id="record" data-action="record" title="Record screen" aria-label="Record screen">${icon('record')}<span id="record-time"></span></button>
    <button class="icon-button" data-action="menu" title="More actions: apps, logcat, Wi-Fi, quick settings…" aria-label="More actions">${icon('more')}</button>
  </header>
  <nav class="toolbar controls" id="buttons" aria-label="Device controls">
    <div class="group">
      ${iconButton('back', 'Back (Esc, right-click)', 'back')}
      ${iconButton('home', 'Home', 'home')}
      ${iconButton('recents', 'Overview', 'recents')}
    </div>
    <div class="group">
      ${iconButton('volumeDown', 'Volume down', 'volumeDown')}
      ${iconButton('volumeUp', 'Volume up', 'volumeUp')}
    </div>
    <div class="group">
      ${iconButton('power', 'Power (hold for power menu)', 'power')}
      ${iconButton('rotate', 'Rotate', 'rotate')}
      ${iconButton('notifications', 'Notifications', 'notifications')}
    </div>
  </nav>
  <main id="stage">
    <canvas id="screen" tabindex="0" aria-label="Device screen"></canvas>
    <div id="stats" hidden></div>
    <div id="drop-hint" hidden><span>Drop an APK to install it, or any file to copy it to Downloads</span></div>
    <div id="overlay">
      <p id="message"></p>
      <button id="show-here" class="text-button" hidden>Show here</button>
    </div>
  </main>
  <script nonce="${opts.nonce}" src="${opts.scriptUri}"></script>
</body>
</html>`;
}
