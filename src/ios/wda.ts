// WebDriverAgent HTTP client: the touch/keyboard channel for iPhones.
// Coordinates are in iOS points (e.g. 393 × 852 on an iPhone 14 Pro).

export interface Point {
  x: number;
  y: number;
}

export interface TimedPoint extends Point {
  /** ms since the gesture started */
  t: number;
}

export class WdaClient {
  private sessionId: string | null = null;

  constructor(private readonly base: string) {}

  private async call<T = any>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json?.value?.error) {
      throw new Error(json?.value?.message ?? `WebDriverAgent ${method} ${path} failed (${res.status})`);
    }
    return json.value as T;
  }

  private session(path: string) {
    if (!this.sessionId) throw new Error('No WebDriverAgent session');
    return `/session/${this.sessionId}${path}`;
  }

  async status(): Promise<boolean> {
    try {
      await this.call('GET', '/status', undefined, 3000);
      return true;
    } catch {
      return false;
    }
  }

  async start() {
    const value = await this.call<{ sessionId?: string }>('POST', '/session', {
      capabilities: {
        alwaysMatch: { shouldWaitForQuiescence: false, shouldUseTestManagerForVisibilityDetection: false },
        firstMatch: [{}],
      },
    });
    // Older WDA puts the id at the top level; newer inside value.
    this.sessionId = value?.sessionId ?? (value as any)?.capabilities?.sessionId ?? null;
    if (!this.sessionId) {
      const status = await this.call<any>('GET', '/status');
      this.sessionId = status?.sessionId ?? null;
    }
    // Don't wait for the app to go idle before each action: that's the main source of lag.
    await this.call('POST', this.session('/appium/settings'), {
      settings: { waitForIdleTimeout: 0, animationCoolOffTimeout: 0, snapshotMaxDepth: 1, mjpegServerFramerate: 1 },
    }).catch(() => undefined);
  }

  windowSize(): Promise<{ width: number; height: number }> {
    return this.call('GET', this.session('/window/size'));
  }

  tap(p: Point) {
    return this.call('POST', this.session('/wda/tap'), { x: p.x, y: p.y });
  }

  touchAndHold(p: Point, seconds: number) {
    return this.call('POST', this.session('/wda/touchAndHold'), { x: p.x, y: p.y, duration: seconds });
  }

  /** Replays a finger path with its original timing (swipes, scrolls, drags). */
  gesture(points: TimedPoint[]) {
    const actions: any[] = [{ type: 'pointerMove', duration: 0, x: Math.round(points[0].x), y: Math.round(points[0].y) }, { type: 'pointerDown', button: 0 }];
    for (let i = 1; i < points.length; i++) {
      actions.push({
        type: 'pointerMove',
        duration: Math.max(10, Math.round(points[i].t - points[i - 1].t)),
        x: Math.round(points[i].x),
        y: Math.round(points[i].y),
      });
    }
    actions.push({ type: 'pointerUp', button: 0 });
    return this.call('POST', this.session('/actions'), {
      actions: [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions }],
    });
  }

  type(text: string) {
    return this.call('POST', this.session('/wda/keys'), { value: [...text] });
  }

  home() {
    return this.call('POST', '/wda/homescreen');
  }

  pressButton(name: 'volumeUp' | 'volumeDown' | 'home') {
    return this.call('POST', this.session('/wda/pressButton'), { name });
  }

  async toggleLock() {
    const locked = await this.call<boolean>('GET', '/wda/locked');
    return this.call('POST', locked ? '/wda/unlock' : '/wda/lock');
  }

  async toggleOrientation() {
    const current = await this.call<string>('GET', this.session('/orientation'));
    return this.call('POST', this.session('/orientation'), { orientation: current === 'PORTRAIT' ? 'LANDSCAPE' : 'PORTRAIT' });
  }
}
