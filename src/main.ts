/**
 * F35-A — entry point.
 */
import { Game } from './game/Game';

function showFatal(msg: string): void {
  const el = document.getElementById('fatal');
  if (el) {
    el.textContent = msg;
    el.style.display = 'flex';
  }
}

function webgl2Available(): boolean {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

if (!webgl2Available()) {
  showFatal('F35-A needs WebGL 2. Please use an up-to-date Chrome, Safari (iOS 15+) or Firefox.');
} else {
  const game = new Game(document.getElementById('app')!);
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
