/**
 * F35-A UI — main menu: logo + theatre card on the left, five big menu items on the right.
 */
import type { MainMenuChoice } from '../../core/contracts';
import { icon } from '../art/icons';
import { logoBlock } from '../art/logo';
import { h } from '../dom';
import type { UiHost } from '../host';
import { stagger } from '../widgets';

const ITEMS: { id: MainMenuChoice; title: string; sub: string; icon: string; primary?: boolean }[] = [
  { id: 'campaign', title: 'Campaign', sub: 'Operation Southern Cross — defend Auckland', icon: 'flag', primary: true },
  { id: 'instant', title: 'Instant Action', sub: 'Dogfight · SAM gauntlet · strike · survival', icon: 'crosshair' },
  { id: 'training', title: 'Training', sub: 'Learn to fly and fight the F-35A', icon: 'book' },
  { id: 'settings', title: 'Settings', sub: 'Difficulty · controls · audio · display', icon: 'gear' },
  { id: 'credits', title: 'Credits', sub: 'Team, tools and licences', icon: 'info' },
];

export function showMainMenu(host: UiHost, version: string): Promise<MainMenuChoice> {
  return new Promise((resolve) => {
    const el = h('section', { class: 'scr-main' });
    const left = h('div', { class: 'mm-left' });
    left.innerHTML =
      logoBlock('LIGHTNING II · COMBAT FLIGHT') +
      `<div class="mm-theatre ui-panel brk">` +
      `<div class="mm-th-k">${icon('pin')} THEATRE</div>` +
      `<div class="mm-th-t">Auckland, New Zealand</div>` +
      `<div class="mm-th-s">Hostile forces hold the Hauraki Gulf islands. Fly from RNZAF Base Auckland (Whenuapai) and defend the city.</div>` +
      `</div>` +
      `<div class="mm-ver mono">v${version}</div>`;
    const list = h('nav', { class: 'mm-list', attrs: { 'aria-label': 'Main menu' } });
    let done = false;
    let first: HTMLButtonElement | null = null;
    for (const it of ITEMS) {
      const b = h('button', {
        class: `mm-item ${it.primary ? 'is-primary' : ''}`,
        attrs: { type: 'button' },
        dataset: { id: it.id },
        html:
          `<span class="mm-ico">${icon(it.icon)}</span>` +
          `<span class="mm-txt"><span class="mm-t">${it.title}</span><span class="mm-s">${it.sub}</span></span>` +
          `<span class="mm-go">${icon('next')}</span>`,
      });
      b.addEventListener('click', () => {
        if (done) return;
        done = true;
        host.leave(el);
        resolve(it.id);
      });
      if (!first) first = b;
      list.appendChild(b);
    }
    stagger(list);
    el.append(left, list);
    host.present(el, { bg: true, focus: first });
  });
}
