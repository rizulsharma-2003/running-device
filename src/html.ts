// Markup shared by every surface (side bar view, editor tab, floating window).

/** One consistent icon set: 16×16 grid, 1.5px rounded strokes, currentColor. */
const ICONS = {
  play: '<path d="M5.5 3.9v8.2a.6.6 0 0 0 .92.5l6.3-4.1a.6.6 0 0 0 0-1L6.42 3.4a.6.6 0 0 0-.92.5z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none"/>',
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
  chevron: '<path d="m4.5 6.25 3.5 3.5 3.5-3.5"/>',
  wifi: '<path d="M2 6.3a8.5 8.5 0 0 1 12 0"/><path d="M4.1 8.6a5.5 5.5 0 0 1 7.8 0"/><path d="M6.2 10.9a2.5 2.5 0 0 1 3.6 0"/><circle cx="8" cy="13" r=".6" fill="currentColor"/>',
  refresh: '<path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71"/><path d="M13.25 2.75v2.5h-2.5"/>',
  log: '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5 6l2 2-2 2M8.5 10.5h2.5"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName): string {
  return `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

/** Device button with a custom tooltip; `tip` sets which side the tooltip opens on. */
const deviceButton = (button: string, label: string, iconName: IconName, tip: 'top' | 'left' | 'bottom') =>
  `<button class="btn" data-button="${button}" data-tip="${label}" data-tip-side="${tip}" aria-label="${label}">${icon(iconName)}</button>`;

/** Illustration for empty states: a phone in the brand gradient. */
const HERO = `<svg class="hero-art" viewBox="0 0 64 64" fill="none" aria-hidden="true">
  <defs><linearGradient id="hero-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6E5BFF"/><stop offset="1" stop-color="#18B6D8"/></linearGradient></defs>
  <rect x="35" y="10" width="20" height="36" rx="5" stroke="url(#hero-g)" stroke-width="2.5" opacity=".45"/>
  <rect x="13" y="16" width="22" height="40" rx="6" stroke="url(#hero-g)" stroke-width="2.5"/>
  <path d="M21 21h6" stroke="url(#hero-g)" stroke-width="2.5" stroke-linecap="round"/>
  <path d="M21.5 31.5v10l8-5z" fill="url(#hero-g)"/>
</svg>`;

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
  <header class="topbar">
    <label class="picker">
      <span class="status-dot" aria-hidden="true"></span>
      <span class="picker-text">
        <span id="device-name" class="picker-name">No device</span>
        <span id="device-meta" class="picker-meta"></span>
      </span>
      <span class="picker-chevron">${icon('chevron')}</span>
      <select id="device" aria-label="Device"></select>
    </label>
    <div class="segmented" role="group" aria-label="Capture">
      <button class="btn needs-stream" data-action="screenshot" data-tip="Screenshot" data-tip-side="bottom" aria-label="Take screenshot">${icon('screenshot')}</button>
      <button class="btn needs-stream record" id="record" data-action="record" data-tip="Record screen" data-tip-side="bottom" aria-label="Record screen">${icon('record')}<span id="record-time"></span></button>
      <button class="btn" data-action="menu" data-tip="More actions" data-tip-side="bottom" data-tip-align="end" aria-label="More actions">${icon('more')}</button>
    </div>
    <button id="toggle" class="power-toggle" data-tip="Start mirroring" data-tip-side="bottom" data-tip-align="end" aria-label="Start mirroring">
      <span class="when-stopped">${icon('play')}</span><span class="when-running">${icon('stop')}</span>
    </button>
  </header>

  <main id="stage">
    <div class="glow" aria-hidden="true"></div>
    <div class="device-layout" id="layout">
      <div class="device" id="device-frame">
        <canvas id="screen" tabindex="0" aria-label="Device screen"></canvas>
        <div class="skeleton" aria-hidden="true">
          <span class="spinner"></span>
          <span id="skeleton-text" class="skeleton-text"></span>
        </div>
        <div id="stats" class="stats" hidden></div>
      </div>
      <nav class="rail" aria-label="Hardware buttons">
        ${deviceButton('volumeUp', 'Volume up', 'volumeUp', 'left')}
        ${deviceButton('volumeDown', 'Volume down', 'volumeDown', 'left')}
        <span class="rail-sep"></span>
        ${deviceButton('power', 'Power · hold for menu', 'power', 'left')}
        ${deviceButton('rotate', 'Rotate', 'rotate', 'left')}
        ${deviceButton('notifications', 'Notifications', 'notifications', 'left')}
      </nav>
      <nav class="dock" aria-label="Navigation">
        ${deviceButton('back', 'Back · Esc', 'back', 'top')}
        ${deviceButton('home', 'Home', 'home', 'top')}
        ${deviceButton('recents', 'Overview', 'recents', 'top')}
      </nav>
    </div>

    <section id="card" class="card" hidden>
      ${HERO}
      <h2 id="card-title"></h2>
      <p id="card-text"></p>
      <div class="card-actions">
        <button id="card-primary" class="cta primary"></button>
        <button id="card-secondary" class="cta ghost"></button>
      </div>
    </section>

    <div id="drop-hint" class="drop-hint" hidden>
      <span>Drop an APK to install it<br><small>or any file to copy it to Downloads</small></span>
    </div>
  </main>
  <script nonce="${opts.nonce}" src="${opts.scriptUri}"></script>
</body>
</html>`;
}

