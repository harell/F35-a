/**
 * F35-A — entry point.
 */
import { Game } from './game/Game';
import { initAnalytics, track } from './analytics/clarity';
import { GAME_BUILD } from './core/data';
import { prefetchChartData } from './ui/art/aucklandChart';

function displayMode(): string {
  if (matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone) return 'installed';
  return 'browser';
}

initAnalytics({
  build: GAME_BUILD,
  display_mode: displayMode(),
  pointer: matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse',
});

function showFatal(msg: string): void {
  const el = document.getElementById('fatal');
  if (el) {
    el.textContent = msg;
    el.style.display = 'flex';
  }
  track('fatal_error');
}

/** Can this browser create a context of `kind` right now? The probe context is released straight away. */
function contextAvailable(kind: 'webgl2' | 'webgl'): boolean {
  try {
    const gl = document.createElement('canvas').getContext(kind) as WebGLRenderingContext | WebGL2RenderingContext | null;
    (gl?.getExtension('WEBGL_lose_context') as { loseContext?: () => void } | null)?.loseContext?.();
    return !!gl;
  } catch {
    return false;
  }
}

if (!contextAvailable('webgl2')) {
  // Usually not an old browser: WebGL is switched off by disabled hardware acceleration, a blocklisted
  // GPU/driver, or the browser turning it off after a GPU crash (which a browser restart clears).
  // WebGL 1 still working narrows it to WebGL 2 alone (blocklist, or a pre-15 Safari).
  track('no_webgl2');
  track(contextAvailable('webgl') ? 'webgl1_only' : 'no_webgl');
  showFatal(
    'F35-A could not start WebGL 2 graphics. Fully quit and reopen the browser, and check that ' +
      'hardware (graphics) acceleration is turned on in its settings. ' +
      'If it still fails, use an up-to-date Chrome, Safari (iOS 15+) or Firefox.',
  );
} else {
  const game = new Game(document.getElementById('app')!);
  // the real coastline for the menu chart (and the first mission): fetched once the page is idle
  prefetchChartData();
  game.start().catch((err) => {
    console.error(err);
    showFatal(`Something went wrong: ${err?.message ?? err}`);
  });
}

/** Service worker only for a top-level deployment (GitHub Pages / installed PWA), not inside an embedding frame. */
function topLevel(): boolean {
  try {
    return window.top === window.self;
  } catch {
    return false;
  }
}

if ('serviceWorker' in navigator && import.meta.env.PROD && topLevel()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}
