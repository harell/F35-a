/**
 * F35-A audio — AudioContext lifecycle for mobile browsers.
 *
 *  - The context is created lazily on the first user gesture (or unlock()), so no autoplay
 *    warning is logged and missions started with ?autostart=1 simply stay silent until the
 *    first tap anywhere on the page.
 *  - unlock(): create + play a 1-sample silent buffer inside the gesture (iOS) + resume()
 *    with a timeout (resume() can hang forever when not allowed — never block the caller).
 *  - iOS 'interrupted' state (calls, Siri) and 'suspended' after background: re-resume on
 *    the next gesture; the page being hidden suspends the context to save battery.
 */

type Ctor = typeof AudioContext;

const GESTURE_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'touchend', 'keydown', 'click'] as const;

function audioContextCtor(): Ctor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | void> {
  return Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]);
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  private readonly readyCbs: ((ctx: AudioContext) => void)[] = [];
  private hidden = false;
  private disposed = false;
  private unlocking: Promise<void> | null = null;

  constructor() {
    if (typeof window === 'undefined') return;
    for (const ev of GESTURE_EVENTS) window.addEventListener(ev, this.onGesture, { capture: true, passive: true });
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onVisibility);
    window.addEventListener('pageshow', this.onVisibility);
  }

  /** Context exists and is producing sound. */
  get running(): boolean {
    return !!this.ctx && this.ctx.state === 'running' && !this.hidden;
  }

  get now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** Called once with the context as soon as it exists (immediately if it already does). */
  onReady(cb: (ctx: AudioContext) => void): void {
    if (this.ctx) cb(this.ctx);
    else this.readyCbs.push(cb);
  }

  /** Create the context if the browser supports Web Audio (does not resume it). */
  create(): AudioContext | null {
    if (this.ctx || this.disposed) return this.ctx;
    const C = audioContextCtor();
    if (!C) return null;
    try {
      this.ctx = new C({ latencyHint: 'interactive' });
    } catch {
      try {
        this.ctx = new C();
      } catch {
        return null;
      }
    }
    const ctx = this.ctx;
    ctx.addEventListener?.('statechange', () => {
      // iOS reports 'interrupted' after a phone call / Siri; try to come back right away —
      // if that is refused the next gesture resumes it.
      const st = ctx.state as string;
      if ((st === 'interrupted' || st === 'suspended') && !this.hidden && !this.disposed) void ctx.resume().catch(() => undefined);
    });
    const cbs = this.readyCbs.splice(0);
    for (const cb of cbs) {
      try {
        cb(ctx);
      } catch (err) {
        console.error('[audio] init failed', err);
      }
    }
    return ctx;
  }

  /** Must be called from a user gesture. Never rejects and resolves within ~1 s. */
  unlock(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.unlocking) return this.unlocking;
    const ctx = this.create();
    if (!ctx) return Promise.resolve();
    if (ctx.state === 'running' && !this.hidden) return Promise.resolve();
    // iOS: a buffer started synchronously inside the gesture unlocks the output
    try {
      const b = ctx.createBuffer(1, 1, ctx.sampleRate);
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.connect(ctx.destination);
      s.start(0);
      s.onended = () => s.disconnect();
    } catch {
      /* ignore */
    }
    this.unlocking = withTimeout(ctx.resume().catch(() => undefined), 900)
      .then(() => undefined)
      .finally(() => {
        this.unlocking = null;
      });
    return this.unlocking;
  }

  private readonly onGesture = (): void => {
    if (this.disposed || this.hidden) return;
    if (this.ctx && this.ctx.state === 'running') return;
    void this.unlock();
  };

  private readonly onVisibility = (e?: Event): void => {
    const hidden = e?.type === 'pagehide' ? true : e?.type === 'pageshow' ? false : document.visibilityState === 'hidden';
    this.hidden = hidden;
    const ctx = this.ctx;
    if (!ctx || this.disposed) return;
    if (hidden) {
      if (ctx.state === 'running') void ctx.suspend().catch(() => undefined);
    } else {
      void ctx.resume().catch(() => undefined);
    }
  };

  dispose(): void {
    this.disposed = true;
    if (typeof window !== 'undefined') {
      for (const ev of GESTURE_EVENTS) window.removeEventListener(ev, this.onGesture, { capture: true });
      document.removeEventListener('visibilitychange', this.onVisibility);
      window.removeEventListener('pagehide', this.onVisibility);
      window.removeEventListener('pageshow', this.onVisibility);
    }
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}
