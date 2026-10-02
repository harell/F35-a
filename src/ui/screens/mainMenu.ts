/**
 * F35-A UI — main menu: logo + theatre card + pilot card (rank, current difficulty, service record)
 * on the left, five big menu items on the right. On a first launch a friendly prompt suggests the
 * Training lessons (dismissable, remembered).
 */
import type { CampaignProgress, MainMenuChoice } from '../../core/contracts';
import { DIFFICULTIES } from '../../core/data';
import type { Settings } from '../../core/types';
import { icon } from '../art/icons';
import { logoBlock } from '../art/logo';
import { basicTrainingDone, careerRank, dismissOnboarding, isFirstLaunch } from '../career';
import { escapeHtml, h } from '../dom';
import type { UiHost } from '../host';
import { CAMPAIGNS } from '../../missions';
import { stagger } from '../widgets';
import { showServiceRecord } from './serviceRecord';

const ITEMS: { id: MainMenuChoice; title: string; sub: string; icon: string; primary?: boolean }[] = [
  { id: 'campaign', title: 'Campaign', sub: 'Operation Southern Cross — defend Auckland', icon: 'flag', primary: true },
  { id: 'instant', title: 'Instant Action', sub: 'Dogfight · SAM gauntlet · strike · survival', icon: 'crosshair' },
  { id: 'training', title: 'Training', sub: 'Learn to fly and fight the F-35A', icon: 'book' },
  { id: 'settings', title: 'Settings', sub: 'Difficulty · controls · audio · display', icon: 'gear' },
  { id: 'credits', title: 'Credits', sub: 'Team, tools and licences', icon: 'info' },
];

export interface MainMenuContext {
  settings: () => Settings;
  progress: () => CampaignProgress | null;
}

export async function showMainMenu(host: UiHost, build: string, ctx: MainMenuContext): Promise<MainMenuChoice> {
  for (;;) {
    const choice = await menuOnce(host, build, ctx);
    if (choice !== 'record') return choice;
    await showServiceRecord(host, ctx.progress());
  }
}

function menuOnce(host: UiHost, build: string, ctx: MainMenuContext): Promise<MainMenuChoice | 'record'> {
  return new Promise((resolve) => {
    const el = h('section', { class: 'scr-main' });
    let done = false;
    const finish = (c: MainMenuChoice | 'record') => {
      if (done) return;
      done = true;
      host.leave(el);
      resolve(c);
    };
    const settings = ctx.settings();
    const progress = ctx.progress();
    const needsTraining = progress ? !basicTrainingDone(progress) : true;

    const left = h('div', { class: 'mm-left' });
    left.innerHTML =
      logoBlock() +
      `<div class="mm-theatre ui-panel brk">` +
      `<div class="mm-th-k">${icon('pin')} THEATRE</div>` +
      `<div class="mm-th-t">Auckland, New Zealand</div>` +
      `<div class="mm-th-s">Hostile forces hold the Hauraki Gulf islands. Fly from RNZAF Base Auckland (Whenuapai) and defend the city.</div>` +
      `</div>` +
      `<div class="mm-ver mono">Build ${build}</div>`;

    // pilot card: rank → service record; difficulty chip → settings
    const pilot = h('div', { class: 'mm-pilot' });
    const rank = progress ? careerRank(progress).rank : null;
    const rec = h('button', {
      class: 'ui-btn ghost mm-rec',
      attrs: { type: 'button', 'aria-label': 'Service record: rank, medals and stats' },
      html: `${icon('trophy')}<span class="mm-rec-t"><b>${escapeHtml(rank?.abbr ?? 'PLTOFF')}</b><em>Service record</em></span>`,
    });
    rec.addEventListener('click', () => finish('record'));
    const d = DIFFICULTIES[settings.difficulty];
    const diff = h('button', {
      class: 'ui-btn ghost mm-diff',
      attrs: { type: 'button', 'aria-label': `Difficulty: ${d?.label ?? settings.difficulty}. Change in settings`, title: d?.description ?? '' },
      html: `<span class="mm-diff-k">DIFFICULTY</span><span class="badge diff-${settings.difficulty}">${escapeHtml(d?.label ?? settings.difficulty)}</span>`,
    });
    diff.addEventListener('click', () => finish('settings'));
    pilot.append(rec, diff);
    left.insertBefore(pilot, left.querySelector('.mm-ver'));

    const list = h('nav', { class: 'mm-list', attrs: { 'aria-label': 'Main menu' } });
    let first: HTMLButtonElement | null = null;
    for (const it of ITEMS) {
      // the Campaign line names every campaign (the campaign picker follows)
      const sub = it.id === 'campaign' && CAMPAIGNS.length > 1 ? CAMPAIGNS.map((c) => c.name).join(' · ') : it.sub;
      const recBadge = it.id === 'training' && needsTraining ? '<span class="badge mm-recb">RECOMMENDED</span>' : '';
      const b = h('button', {
        class: `mm-item ${it.primary ? 'is-primary' : ''} ${recBadge ? 'is-rec' : ''}`,
        attrs: { type: 'button' },
        dataset: { id: it.id },
        html:
          `<span class="mm-ico">${icon(it.icon)}</span>` +
          `<span class="mm-txt"><span class="mm-t">${it.title}${recBadge}</span><span class="mm-s">${escapeHtml(sub)}</span></span>` +
          `<span class="mm-go">${icon('next')}</span>`,
      });
      b.addEventListener('click', () => finish(it.id));
      if (!first) first = b;
      list.appendChild(b);
    }
    stagger(list);
    el.append(left, list);

    // first launch: suggest the Training lessons
    let focus: HTMLElement | null = first;
    if (isFirstLaunch()) {
      const card = h('div', { class: 'mm-onboard ui-panel brk', attrs: { role: 'dialog', 'aria-label': 'New pilot' } });
      card.innerHTML =
        `<div class="mo-k">${icon('book')} NEW PILOT?</div>` +
        `<div class="mo-t">Start with Training</div>` +
        `<div class="mo-s">Three short lessons — basic flight, air-to-air, surviving SAMs — teach the controls before Operation Southern Cross. About 10 minutes.</div>`;
      const go = h('button', { class: 'ui-btn primary go', attrs: { type: 'button' }, html: `${icon('play')}<span>Start training</span>` });
      const skip = h('button', { class: 'ui-btn ghost', attrs: { type: 'button' }, html: `<span>Not now</span>` });
      go.addEventListener('click', () => {
        dismissOnboarding();
        finish('training');
      });
      skip.addEventListener('click', () => {
        dismissOnboarding();
        card.classList.add('is-out');
        window.setTimeout(() => card.remove(), 180);
        first?.focus();
      });
      card.appendChild(h('div', { class: 'mo-btns' }, skip, go));
      el.appendChild(card);
      focus = go;
    }
    host.present(el, { bg: true, focus });
  });
}
