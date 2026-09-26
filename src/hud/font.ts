/**
 * HMD / PCD typeface: B612 Mono Bold — the open-source font Airbus designed for cockpit displays
 * (SIL OFL 1.1, see docs/CREDITS-hud.md). Loaded once through the FontFace API; until it arrives the
 * canvas falls back to the system monospace stack, so nothing blocks on it.
 */
import fontUrl from './assets/B612Mono-Bold.ttf?url';

export const HUD_FONT_FAMILY = '"B612 HMD", "B612 Mono", "DejaVu Sans Mono", Menlo, Consolas, "Roboto Mono", monospace';

let loading: Promise<boolean> | null = null;
let ready = false;
const listeners = new Set<() => void>();

/** True once the font is available for canvas text. */
export function hudFontReady(): boolean {
  return ready;
}

/** Start loading (idempotent). Calls `onReady` when the font becomes usable (possibly immediately). */
export function loadHudFont(onReady?: () => void): Promise<boolean> {
  if (onReady) {
    if (ready) onReady();
    else listeners.add(onReady);
  }
  if (loading) return loading;
  loading = (async () => {
    try {
      if (typeof FontFace === 'undefined' || typeof document === 'undefined') return false;
      const face = new FontFace('B612 HMD', `url(${fontUrl})`, { weight: '100 900', style: 'normal' });
      await face.load();
      (document.fonts as unknown as { add(f: FontFace): void }).add(face);
      ready = true;
      for (const fn of listeners) fn();
      listeners.clear();
      return true;
    } catch (err) {
      console.warn('[hud] HMD font failed to load, using system monospace', err);
      return false;
    }
  })();
  return loading;
}
