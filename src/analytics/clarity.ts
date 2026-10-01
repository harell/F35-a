/**
 * F35-A — Microsoft Clarity analytics (who plays, on what, and how missions go).
 *
 * Clarity cannot see inside the WebGL/HUD canvases, so recordings and heatmaps of the
 * flight itself are mostly blank. The useful signal is the custom events and session tags
 * sent from here — filter recordings/dashboards by them in the Clarity UI.
 *
 * Only active on the real deployment: production build, top-level window (not the
 * embedded artifact build), not on localhost, not under automation (Playwright e2e).
 * Override the project with VITE_CLARITY_ID at build time; set it to "" to disable.
 * Every call is a safe no-op when Clarity is inactive or blocked.
 */

type ClarityFn = ((...args: unknown[]) => void) & { q?: unknown[][] };
type ClarityWindow = Window & { clarity?: ClarityFn };

const DEFAULT_PROJECT_ID = 'yr2ioa8r88';

let active = false;

function projectId(): string {
  const fromEnv = import.meta.env.VITE_CLARITY_ID as string | undefined;
  return fromEnv ?? DEFAULT_PROJECT_ID;
}

function shouldRun(): boolean {
  if (!import.meta.env.PROD) return false;
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  try {
    if (window.top !== window.self) return false;
  } catch {
    return false;
  }
  if (navigator.webdriver) return false;
  const host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.local')) return false;
  return !!projectId();
}

/** Injects the Clarity tag (official snippet, typed). Calls made before it loads are queued. */
export function initAnalytics(tags: Record<string, string> = {}): void {
  if (active || !shouldRun()) return;
  const w = window as ClarityWindow;
  if (!w.clarity) {
    const stub: ClarityFn = (...args: unknown[]) => {
      (stub.q = stub.q || []).push(args);
    };
    w.clarity = stub;
  }
  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.clarity.ms/tag/${encodeURIComponent(projectId())}`;
  const first = document.getElementsByTagName('script')[0];
  if (first?.parentNode) first.parentNode.insertBefore(s, first);
  else document.head.appendChild(s);
  active = true;
  for (const [k, v] of Object.entries(tags)) tag(k, v);
}

function call(...args: unknown[]): void {
  if (!active) return;
  try {
    (window as ClarityWindow).clarity?.(...args);
  } catch {
    /* analytics must never break the game */
  }
}

/** Custom event (shows up under Smart events / filters). Keep names short and stable. */
export function track(name: string): void {
  call('event', name);
}

/** Session tag (key/value filter in dashboards and recordings). */
export function tag(key: string, value: string | number | boolean): void {
  call('set', key, String(value));
}

/** Marks the session as important so Clarity keeps the recording (sampling-proof). */
export function upgrade(reason: string): void {
  call('upgrade', reason);
}

/** True when the Clarity tag was injected (for tests / debugging). */
export function analyticsActive(): boolean {
  return active;
}
