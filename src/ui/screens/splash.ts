/**
 * F35-A UI — title screen. Resolves on the first user gesture (click / key / gamepad A), which the
 * game uses to unlock Web Audio, request fullscreen and motion permission.
 */
import { icon } from '../art/icons';
import { logoBlock } from '../art/logo';
import { h } from '../dom';
import type { UiHost } from '../host';

export function showSplash(host: UiHost, build: string): Promise<void> {
  return new Promise((resolve) => {
    const el = h('section', { class: 'scr-splash', dataset: { bg: '1' }, attrs: { 'data-click': '', role: 'button', 'aria-label': 'Tap to start' } });
    el.innerHTML =
      `<div class="spl-center">${logoBlock()}` +
      `<div class="spl-op">OPERATION SOUTHERN CROSS <span>·</span> AOTEAROA</div>` +
      `<div class="spl-start"><span class="spl-start-line"></span><span class="spl-start-text">TAP TO START</span><span class="spl-start-line"></span></div></div>` +
      `<div class="spl-foot"><span class="spl-note">${icon('headphones')} Best with headphones <i>·</i> ${icon('rotate')} Landscape</span>` +
      `<span class="spl-ver mono">Build ${build}</span></div>`;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', onKey);
      el.classList.add('is-go');
      host.leave(el);
      resolve();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') finish();
    };
    // resolve inside the gesture handler so audio unlock / fullscreen still count as user-initiated
    el.addEventListener('click', finish);
    window.addEventListener('keydown', onKey);
    host.present(el, { bg: true });
    // gamepad A/Start on the splash (host focus nav has nothing to focus here)
    const pollPad = () => {
      if (done) return;
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const p of pads) if (p && p.connected && (p.buttons[0]?.pressed || p.buttons[9]?.pressed)) return finish();
      requestAnimationFrame(pollPad);
    };
    requestAnimationFrame(pollPad);
  });
}
