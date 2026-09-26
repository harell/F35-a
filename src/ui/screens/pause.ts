/**
 * F35-A UI — in-flight pause menu (translucent over the frozen game): objectives with live states,
 * RESUME / RESTART / SETTINGS / QUIT (restart & quit need a second tap to confirm).
 */
import type { MissionRunnerApi } from '../../core/contracts';
import { icon } from '../art/icons';
import { escapeHtml, h } from '../dom';
import type { UiHost } from '../host';

export type PauseChoice = 'resume' | 'restart' | 'settings' | 'quit';

const STATE_ICON = { pending: 'clock', active: 'target', complete: 'check', failed: 'close' } as const;
const STATE_LABEL = { pending: 'PENDING', active: 'ACTIVE', complete: 'DONE', failed: 'FAILED' } as const;

export function showPause(host: UiHost, mission: MissionRunnerApi | null): Promise<PauseChoice> {
  return new Promise((resolve) => {
    let done = false;
    const el = h('section', { class: 'scr-pause' });
    const finish = (c: PauseChoice) => {
      if (done) return;
      done = true;
      host.leave(el);
      resolve(c);
    };
    const panel = h('div', { class: 'pz-panel ui-panel brk' });
    const info = h('div', { class: 'pz-info' });
    const def = mission?.def;
    info.innerHTML =
      `<div class="pz-k">${icon('pause')} PAUSED</div>` +
      `<h2 class="pz-title">${escapeHtml(def?.title ?? 'Mission')}</h2>` +
      (def ? `<div class="pz-sub">${escapeHtml(def.subtitle)}</div>` : '');
    const objs = mission?.objectives ?? [];
    if (objs.length) {
      const ul = h('ul', { class: 'pz-obj ui-scroll' });
      for (const o of objs) {
        const prog = o.progress ? ` <span class="mono">${o.progress.done}/${o.progress.total}</span>` : '';
        ul.appendChild(
          h('li', {
            class: `st-${o.state} ${o.primary ? '' : 'is-bonus'}`,
            html: `<span class="pz-ico">${icon(STATE_ICON[o.state] ?? 'target')}</span><span class="pz-l">${escapeHtml(o.label)}${prog}</span><span class="pz-st">${o.primary ? STATE_LABEL[o.state] : 'BONUS'}</span>`,
          }),
        );
      }
      info.appendChild(ul);
    }
    if (mission?.hint) info.appendChild(h('div', { class: 'pz-hint', html: `${icon('info')}<span>${escapeHtml(mission.hint)}</span>` }));

    const btns = h('div', { class: 'pz-btns' });
    const resume = h('button', { class: 'ui-btn primary go', attrs: { type: 'button' }, html: `${icon('play')}<span>Resume</span>` });
    resume.addEventListener('click', () => finish('resume'));
    const settings = h('button', { class: 'ui-btn', attrs: { type: 'button' }, html: `${icon('gear')}<span>Settings</span>` });
    settings.addEventListener('click', () => finish('settings'));
    const confirmBtn = (label: string, ico: string, armedLabel: string, choice: PauseChoice) => {
      const b = h('button', { class: 'ui-btn danger', attrs: { type: 'button' }, html: `${icon(ico)}<span>${label}</span>` });
      let armed = 0;
      b.addEventListener('click', () => {
        if (armed) return finish(choice);
        armed = window.setTimeout(() => {
          armed = 0;
          b.classList.remove('is-armed');
          (b.lastElementChild as HTMLElement).textContent = label;
        }, 2600);
        b.classList.add('is-armed');
        (b.lastElementChild as HTMLElement).textContent = armedLabel;
      });
      return b;
    };
    btns.append(resume, confirmBtn('Restart', 'retry', 'Tap to restart', 'restart'), settings, confirmBtn('Quit', 'quit', 'Tap to quit', 'quit'));
    panel.append(info, btns);
    el.appendChild(panel);
    host.present(el, { bg: false, back: () => finish('resume'), focus: resume });
  });
}
