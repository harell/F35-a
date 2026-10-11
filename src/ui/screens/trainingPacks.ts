/**
 * F35-A UI — the Training screen: one pack per campaign mission (MissionDef.lessons), shown like an
 * album and its track list. The mission is the cover, its lessons are the tracks: flown ones shrink
 * to a line with their grade, the selected one (by default the next to fly) opens with its subtitle,
 * and one Start button flies it. Any lesson can be picked out of order; the order is a recommendation.
 */
import type { CampaignProgress, MissionDef } from '../../core/contracts';
import { trainingPacks, type TrainingPack } from '../../missions';
import { icon } from '../art/icons';
import { escapeHtml, h } from '../dom';
import { gradeTone, pad2 } from '../format';
import type { UiHost } from '../host';
import { screenHeader } from '../widgets';

const lessonNo = (m: MissionDef) => `T${pad2(m.index)}`;

function packEl(pack: TrainingPack, progress: CampaignProgress, i: number, fly: (m: MissionDef) => void): { el: HTMLElement; start: HTMLButtonElement } {
  const m = pack.mission;
  const el = h('article', { class: `tpack st-${pack.state}${pack.suggested ? ' is-suggested' : ''}` });
  el.style.setProperty('--i', String(i));
  const mark = pack.state === 'complete' ? `<span class="tp-mark">${icon('check')}</span>` : '';
  const tag = pack.suggested ? '<span class="tp-tag">NEXT UP</span>' : pack.state === 'won' ? '<span class="tp-tag won">MISSION WON</span>' : '';
  el.innerHTML =
    `<div class="tp-cover tod-${m.timeOfDay} wx-${m.weather}"><div class="mc-sky"></div><div class="mc-clouds"></div>` +
    `<div class="tp-mnum mono">MISSION ${pad2(m.index)}</div><div class="tp-mt">${escapeHtml(m.title)}</div>${mark}</div>` +
    `<div class="tp-meta"><span>${icon('book')}${pack.lessons.length} ${pack.lessons.length === 1 ? 'lesson' : 'lessons'}</span>${tag}</div>` +
    `<div class="tp-sub">${escapeHtml(m.subtitle)}</div>`;
  const list = h('ol', { class: 'tp-tracks ui-scroll' });
  const foot = h('div', { class: 'tp-foot' });
  const start = h('button', { class: 'ui-btn primary tp-start', attrs: { type: 'button' } }) as HTMLButtonElement;
  let selected = pack.next ?? pack.lessons[0];
  const rows = pack.lessons.map((lesson) => {
    const best = progress.best[lesson.id];
    const row = h('button', { class: `tp-track${best ? ' is-flown' : ''}`, attrs: { type: 'button' } });
    row.innerHTML =
      `<span class="tp-tn mono">${best ? icon('check') : lessonNo(lesson)}</span>` +
      `<span class="tp-tt"><b>${escapeHtml(lesson.title)}</b><i>${escapeHtml(lesson.subtitle)}</i></span>` +
      (best ? `<span class="grade tp-grade tone-${gradeTone(best.grade)}">${best.grade}</span>` : '');
    row.setAttribute('aria-label', `Lesson ${lesson.index}: ${lesson.title}${best ? ` (flown, grade ${best.grade})` : ''}`);
    row.addEventListener('click', () => {
      selected = lesson;
      sync();
    });
    const li = h('li');
    li.appendChild(row);
    list.appendChild(li);
    return { lesson, row };
  });
  const sync = () => {
    for (const r of rows) {
      r.row.classList.toggle('is-selected', r.lesson === selected);
      r.row.setAttribute('aria-pressed', String(r.lesson === selected));
    }
    start.innerHTML = `${icon(progress.best[selected.id] ? 'retry' : 'play')}<span>${progress.best[selected.id] ? 'Fly again' : 'Start'} ${lessonNo(selected)}</span>`;
  };
  sync();
  start.addEventListener('click', () => fly(selected));
  const bar = h('div', { class: 'tp-bar', attrs: { 'aria-hidden': 'true' } });
  bar.innerHTML = `<span style="width:${(pack.flown / pack.lessons.length) * 100}%"></span>`;
  foot.append(bar, h('span', { class: 'tp-count mono', text: `${pack.flown}/${pack.lessons.length}` }), start);
  el.append(list, foot);
  return { el, start };
}

export function showTraining(host: UiHost, missions: MissionDef[], progress: CampaignProgress): Promise<MissionDef | null> {
  return new Promise((resolve) => {
    let done = false;
    const el = h('section', { class: 'scr-missions kind-training' });
    const finish = (m: MissionDef | null) => {
      if (done) return;
      done = true;
      host.leave(el);
      resolve(m);
    };
    const stat = h('div', { class: 'ml-stat' });
    stat.innerHTML = `<span class="chip">${icon('check')} ${missions.filter((m) => progress.best[m.id]).length}/${missions.length}</span>`;
    el.appendChild(screenHeader({ kicker: 'Flight school', title: 'Training', back: () => finish(null), right: [stat] }));
    const body = h('div', { class: 'scr-body tp-body' });
    const row = h('div', { class: 'tp-row ui-hscroll' });
    // focus and scroll to the pack the player is training for, else the first with lessons left
    const packs = trainingPacks(progress);
    const lead = packs.find((k) => k.suggested) ?? packs.find((k) => k.state === 'open') ?? packs[0];
    let focusEl: HTMLElement | null = null;
    let leadEl: HTMLElement | null = null;
    packs.forEach((pack, i) => {
      const { el: p, start } = packEl(pack, progress, i, finish);
      if (pack === lead) {
        leadEl = p;
        focusEl = start;
      }
      row.appendChild(p);
    });
    body.appendChild(row);
    el.appendChild(body);
    host.present(el, { bg: true, back: () => finish(null), focus: focusEl });
    requestAnimationFrame(() => {
      const s = leadEl as HTMLElement | null;
      if (s) row.scrollLeft = Math.max(0, s.offsetLeft - row.clientWidth / 2 + s.clientWidth / 2);
    });
  });
}
