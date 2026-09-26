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
 *  - iOS ring/silent switch: Web Audio gets the 'ambient' session by default, which the silent
 *    switch mutes. unlock() asks for the 'playback' session (navigator.audioSession, Safari
 *    16.4+); on older iOS a looping silent <audio> element started inside the gesture gives the
 *    page the playback category instead (it is paused while the page is hidden).
 */

type Ctor = typeof AudioContext;

const GESTURE_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'touchend', 'keydown', 'click'] as const;

function audioContextCtor(): Ctor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

interface AudioSessionNav {
  audioSession?: { type: string };
}

/** Ask for the 'playback' audio session (not muted by the iOS silent switch). True if supported. */
export function requestPlaybackSession(nav: unknown = typeof navigator !== 'undefined' ? navigator : undefined): boolean {
  const n = nav as AudioSessionNav | undefined;
  if (!n || !n.audioSession) return false;
  try {
    if (n.audioSession.type !== 'playback') n.audioSession.type = 'playback';
    return true;
  } catch {
    return false;
  }
}

function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
}

/** A short silent 8 kHz mono WAV (object URL) for the legacy iOS playback-category trick. */
function silentWavUrl(): string | null {
  try {
    const n = 4000;
    const b = new ArrayBuffer(44 + n);
    const v = new DataView(b);
    const str = (o: number, t: string) => {
      for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i));
    };
    str(0, 'RIFF');
    v.setUint32(4, 36 + n, true);
    str(8, 'WAVEfmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true);
    v.setUint32(28, 8000, true);
    v.setUint16(32, 1, true);
    v.setUint16(34, 8, true);
    str(36, 'data');
    v.setUint32(40, n, true);
    for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
    return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
  } catch {
    return null;
  }
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
  /** Legacy iOS: looping silent element that holds the 'playback' category. */
  private silentEl: HTMLAudioElement | null = null;
  /** navigator.audioSession was set to 'playback'. */
  playbackSession = false;

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
    this.ensurePlaybackCategory();
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

  /** Inside a gesture: make the iOS silent switch not mute the game (see header). */
  private ensurePlaybackCategory(): void {
    if (this.playbackSession) return;
    if (requestPlaybackSession()) {
      this.playbackSession = true;
      return;
    }
    if (!isIOS() || typeof document === 'undefined') return;
    try {
      if (!this.silentEl) {
        const url = silentWavUrl();
        if (!url) return;
        const el = document.createElement('audio');
        el.setAttribute('x-webkit-airplay', 'deny');
        el.preload = 'auto';
        el.loop = true;
        el.src = url;
        this.silentEl = el;
      }
      if (this.silentEl.paused) void this.silentEl.play().catch(() => undefined);
    } catch {
      /* ignore */
    }
  }

  private readonly onGesture = (): void => {
    if (this.disposed || this.hidden) return;
    if (this.silentEl?.paused) this.ensurePlaybackCategory();
    if (this.ctx && this.ctx.state === 'running') return;
    void this.unlock();
  };

  private readonly onVisibility = (e?: Event): void => {
    const hidden = e?.type === 'pagehide' ? true : e?.type === 'pageshow' ? false : document.visibilityState === 'hidden';
    this.hidden = hidden;
    const ctx = this.ctx;
    if (!ctx || this.disposed) return;
    if (hidden) {
      this.silentEl?.pause();
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
    if (this.silentEl) {
      this.silentEl.pause();
      URL.revokeObjectURL(this.silentEl.src);
      this.silentEl = null;
    }
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}
