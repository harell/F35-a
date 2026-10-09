/**
 * F35-A UI — main menu: logo + theatre card + pilot card (rank, current difficulty, service record)
 * on the left, six big menu items on the right. On a first launch a friendly prompt suggests the
 * Training lessons, or a sightseeing flight (Instant Action, A Stroll in the Park) for a player who
 * only wants to see Auckland (dismissable, remembered).
 */
import type { CampaignProgress, MainMenuChoice } from '../../core/contracts';
import { DIFFICULTIES } from '../../core/data';
import type { Settings } from '../../core/types';
import { icon } from '../art/icons';
import { logoBlock } from '../art/logo';
import { daysToPredatorFree } from '../predatorFree';
import { basicTrainingDone, careerRank, dismissOnboarding, isFirstLaunch } from '../career';
import { escapeHtml, h } from '../dom';
import type { UiHost } from '../host';
import { PLAYABLE_CAMPAIGNS, lessonsFor } from '../../missions';
import { stagger } from '../widgets';
import { showServiceRecord } from './serviceRecord';

/**
 * The menu items. Instant Action names its sightseeing flight first: most new players want to see Auckland
 * (playtest 2026-10-10: A Stroll in the Park was named nowhere on the main menu, 1.4-n).
 */
export const MAIN_MENU_ITEMS: { id: MainMenuChoice; title: string; sub: string; icon: string; primary?: boolean }[] = [
  { id: 'campaign', title: 'Campaign', sub: 'Defend Auckland', icon: 'flag', primary: true },
  { id: 'instant', title: 'Instant Action', sub: 'Sightseeing · dogfight · strike · defend', icon: 'crosshair' },
  { id: 'training', title: 'Training', sub: 'Learn to fly and fight the F-35A', icon: 'book' },
  { id: 'codex', title: 'Codex', sub: 'Weapons · warnings · threats', icon: 'missile' },
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
    let cleanup = () => {};
    const finish = (c: MainMenuChoice | 'record') => {
      if (done) return;
      done = true;
      cleanup();
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
      `<div class="mm-th-s">New Zealand's pests have formed an army, the Interspecies Revolutionary Guard Corps: drones over the city, fast boats in the Hauraki Gulf. Fly from RNZAF Base Auckland (Whenuapai) and defend the city.</div>` +
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
    for (const it of MAIN_MENU_ITEMS) {
      // the Campaign line names every playable campaign (a disabled one isn't shown)
      const sub = it.id === 'campaign' && PLAYABLE_CAMPAIGNS.length > 0 ? PLAYABLE_CAMPAIGNS.map((c) => c.name).join(' · ') : it.sub;
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
    const right = h('div', { class: 'mm-right' }, list);
    const pf = predatorFreeLine(Date.now());
    if (pf) {
      right.appendChild(pf.el);
      cleanup = pf.cleanup;
    }
    el.append(left, right);

    // first launch: suggest the Training lessons
    let focus: HTMLElement | null = first;
    if (isFirstLaunch()) {
      const card = h('div', { class: 'mm-onboard ui-panel brk', attrs: { role: 'dialog', 'aria-label': 'New pilot' } });
      card.innerHTML =
        `<div class="mo-k">${icon('book')} NEW PILOT?</div>` +
        `<div class="mo-t">Start with Training</div>` +
        `<div class="mo-s">${escapeHtml(firstLessonsLine())}</div>`;
      const go = h('button', { class: 'ui-btn primary go', attrs: { type: 'button' }, html: `${icon('play')}<span>Start training</span>` });
      const skip = h('button', { class: 'ui-btn ghost', attrs: { type: 'button' }, html: `<span>Not now</span>` });
      // Instant Action opens on A Stroll in the Park (its first, preselected mode)
      const look = h('button', { class: 'ui-btn ghost', attrs: { type: 'button' }, html: `<span>${SIGHTSEEING_LABEL}</span>` });
      look.addEventListener('click', () => {
        dismissOnboarding();
        finish('instant');
      });
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
      card.appendChild(h('div', { class: 'mo-btns' }, skip, look, go));
      el.appendChild(card);
      focus = go;
    }
    host.present(el, { bg: true, focus });
  });
}

/**
 * The quiet "<N> days to Predator Free 2050" line under the menu list (#211), with its explainer:
 * hover or keyboard focus opens it, a tap toggles it, a tap anywhere else closes it. Counted once,
 * when the menu opens. Null once the deadline has come (the line is hidden).
 */
function predatorFreeLine(nowMs: number): { el: HTMLElement; cleanup: () => void } | null {
  const days = daysToPredatorFree(nowMs);
  if (days <= 0) return null;
  // no thousands separator: the mono face renders "8,488" as "8, 488"
  const sentence = `${days} days to Predator Free 2050`;
  const line = h('button', {
    class: 'mm-pf mono',
    attrs: { type: 'button', 'aria-label': `${sentence}. New Zealand's goal: no possums, rats or stoats by 2050.`, 'aria-expanded': 'false' },
    html:
      `${icon('clock')}<span><b>${days}</b> days to Predator Free 2050</span>` +
      `<span class="mm-pf-pop ui-panel" role="tooltip">` +
      `<span class="mm-pf-k">PREDATOR FREE 2050</span>` +
      `<span class="mm-pf-s">Days left to New Zealand's goal: no possums, rats or stoats by 2050. <em>The Guard is counting too.</em></span>` +
      `</span>`,
  });
  const setOpen = (open: boolean) => {
    line.classList.toggle('is-open', open);
    line.setAttribute('aria-expanded', String(open));
  };
  line.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!line.classList.contains('is-open'));
  });
  const outside = (e: PointerEvent) => {
    if (!line.contains(e.target as Node)) setOpen(false);
  };
  document.addEventListener('pointerdown', outside);
  return { el: line, cleanup: () => document.removeEventListener('pointerdown', outside) };
}

/** The new-pilot card's button for a player who only wants to look around: into Instant Action's sightseeing flight. */
export const SIGHTSEEING_LABEL = 'Just look around Auckland';

const COUNT_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven'];

/**
 * The new-pilot card's line: the lessons the first campaign mission asks for (MissionDef.lessons), named
 * from the missions themselves so it follows any change to the lesson order.
 */
export function firstLessonsLine(): string {
  const first = PLAYABLE_CAMPAIGNS[0]?.missions[0];
  const lessons = first ? lessonsFor(first.id) : [];
  if (!first || lessons.length === 0) return 'Short lessons teach the controls before the campaign.';
  const n = COUNT_WORDS[lessons.length] ?? String(lessons.length);
  const names = lessons.map((m) => m.title.toLowerCase()).join(', ');
  return `${n} short ${lessons.length === 1 ? 'lesson' : 'lessons'} (${names}) prepare you for the first mission, ${first.title}.`;
}
