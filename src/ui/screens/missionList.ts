/**
 * F35-A UI — one campaign's / training mission select: theatre sections with horizontally scrolling
 * mission cards (number, title, subtitle, time/weather/theatre, lock state, best grade + difficulty).
 * The campaign itself is picked first (campaignSelect.ts).
 */
import type { CampaignDef, CampaignProgress, MissionDef } from '../../core/contracts';
import { DIFFICULTIES, THEATER_INFO, TIME_OF_DAY_INFO } from '../../core/data';
import type { TheaterId } from '../../core/types';
import { icon } from '../art/icons';
import { silhouetteSvg } from '../art/planform';
import { escapeHtml, h } from '../dom';
import { formatScore, gradeTone, missionState, pad2, suggestedMissionIndex } from '../format';
import type { UiHost } from '../host';
import { findMission } from '../../missions';
import { BASIC_TRAINING, basicTrainingDone } from '../career';
import { screenHeader } from '../widgets';

const WEATHER_LABEL = { clear: 'Clear', scattered: 'Scattered', overcast: 'Overcast' } as const;

let jetArt = '';
function jet(): string {
  if (!jetArt) jetArt = silhouetteSvg(60, 60, { fill: 'rgba(8,14,20,0.85)', stroke: 'rgba(200,240,255,0.35)', strokeWidth: 0.6, cls: 'mc-jet' });
  return jetArt;
}

function card(m: MissionDef, progress: CampaignProgress, onPick: (m: MissionDef, el: HTMLElement) => void): HTMLButtonElement {
  const st = missionState(m, progress);
  const best = progress.best[m.id];
  const locked = st === 'locked';
  const b = h('button', {
    class: `mcard tod-${m.timeOfDay} wx-${m.weather} st-${st}`,
    attrs: { type: 'button', 'aria-label': `${m.kind === 'training' ? 'Training' : 'Mission'} ${m.index}: ${m.title}${locked ? ' (locked)' : ''}` },
  });
  let foot: string;
  if (locked) foot = `<span class="mc-lock">${icon('lock')} LOCKED</span>`;
  else if (best) {
    const d = DIFFICULTIES[best.difficulty];
    foot =
      `<span class="grade mc-grade tone-${gradeTone(best.grade)}">${best.grade}</span>` +
      `<span class="badge diff-${best.difficulty}">${d?.label ?? best.difficulty}</span>` +
      `<span class="mc-score mono">${formatScore(best.score)}</span>`;
  } else foot = `<span class="mc-new">${icon('play')} ${m.kind === 'campaign' ? 'NEW' : 'START'}</span>`;
  b.innerHTML =
    `<div class="mc-art"><div class="mc-sky"></div><div class="mc-clouds"></div>${jet()}` +
    `<div class="mc-num mono">${m.kind === 'training' ? 'T' : ''}${pad2(m.index)}</div>` +
    `<div class="mc-tod">${icon(m.timeOfDay)}</div></div>` +
    `<div class="mc-body"><div class="mc-title">${escapeHtml(m.title)}</div>` +
    `<div class="mc-sub">${escapeHtml(m.subtitle)}</div>` +
    `<div class="mc-meta"><span>${icon(m.timeOfDay)}${TIME_OF_DAY_INFO[m.timeOfDay].label}</span><span>${icon(m.weather)}${WEATHER_LABEL[m.weather]}</span></div></div>` +
    `<div class="mc-foot">${foot}</div>`;
  b.addEventListener('click', () => onPick(m, b));
  return b;
}

function listScreen(
  host: UiHost,
  kind: 'campaign' | 'training',
  title: string,
  missions: MissionDef[],
  progress: CampaignProgress,
  toast: (t: string) => void,
  trainingPick?: () => MissionDef | null,
): Promise<MissionDef | null> {
  return new Promise((resolve) => {
    let done = false;
    const el = h('section', { class: `scr-missions kind-${kind}` });
    const finish = (m: MissionDef | null) => {
      if (done) return;
      done = true;
      host.leave(el);
      resolve(m);
    };
    const completed = missions.filter((m) => progress.best[m.id]).length;
    const stat = h('div', { class: 'ml-stat' });
    stat.innerHTML =
      `<span class="chip">${icon('check')} ${completed}/${missions.length}</span>` +
      (kind === 'campaign' ? `<span class="chip">${icon('jet')} ${progress.totals.airKills}</span><span class="chip">${icon('target')} ${progress.totals.groundKills}</span>` : '');
    el.appendChild(
      screenHeader({
        kicker: kind === 'campaign' ? 'Campaign' : 'Flight school',
        title,
        back: () => finish(null),
        right: [stat],
      }),
    );

    const body = h('div', { class: 'scr-body ml-body ui-scroll' });
    // onboarding nudge: basic training first
    if (kind === 'campaign' && !basicTrainingDone(progress) && trainingPick) {
      const left = BASIC_TRAINING.filter((id) => !progress.best[id]);
      const nudge = h('div', { class: 'ml-nudge ui-panel' });
      nudge.innerHTML =
        `<span class="ml-nudge-i">${icon('book')}</span>` +
        `<span class="ml-nudge-t"><b>Recommended: complete Training first</b><em>${left.map((id) => id.toUpperCase()).join(' · ')} teach flying, locking and SAM defence (~10 min).</em></span>`;
      const go = h('button', { class: 'ui-btn ghost ml-nudge-b', attrs: { type: 'button' }, html: `<span>Training</span>${icon('next')}` });
      go.addEventListener('click', () => {
        const m = trainingPick();
        if (m) finish(m);
      });
      nudge.appendChild(go);
      body.appendChild(nudge);
    }
    // group by theatre (campaign is all Auckland today, but keep it generic)
    const groups = new Map<TheaterId, MissionDef[]>();
    for (const m of [...missions].sort((a, b) => a.index - b.index)) {
      const g = groups.get(m.theater) ?? [];
      g.push(m);
      groups.set(m.theater, g);
    }
    const suggested = missions[suggestedMissionIndex([...missions].sort((a, b) => a.index - b.index), progress)];
    let suggestedEl: HTMLElement | null = null;
    const onPick = (m: MissionDef, cardEl: HTMLElement) => {
      if (missionState(m, progress) === 'locked') {
        cardEl.classList.remove('shake');
        void cardEl.offsetWidth;
        cardEl.classList.add('shake');
        toast('Locked — complete the previous mission first');
        return;
      }
      finish(m);
    };
    for (const [th, list] of groups) {
      const info = THEATER_INFO[th];
      const sec = h('section', { class: 'ml-sec' });
      sec.appendChild(
        h('div', {
          class: 'ml-sec-head',
          html: `${icon('pin')}<span class="ml-sec-t">${escapeHtml(groups.size > 1 ? info.name : info.region)}</span><span class="ml-sec-r">${list.length} ${kind === 'campaign' ? 'missions' : 'lessons'}${groups.size > 1 ? ' · ' + escapeHtml(info.region) : ''}</span>`,
        }),
      );
      const row = h('div', { class: 'ml-row ui-hscroll' });
      list.forEach((m, i) => {
        const c = card(m, progress, onPick);
        c.style.setProperty('--i', String(i));
        if (m === suggested) {
          c.classList.add('is-suggested');
          suggestedEl = c;
        }
        row.appendChild(c);
      });
      sec.appendChild(row);
      body.appendChild(sec);
    }
    el.appendChild(body);
    host.present(el, { bg: true, back: () => finish(null), focus: suggestedEl });
    // bring the suggested mission into view
    requestAnimationFrame(() => {
      const s = suggestedEl as HTMLElement | null;
      const row = s?.parentElement;
      if (s && row) row.scrollLeft = Math.max(0, s.offsetLeft - row.clientWidth / 2 + s.clientWidth / 2);
    });
  });
}

/** First basic-training lesson not yet flown (the campaign nudge's shortcut). */
function nextTraining(progress: CampaignProgress): MissionDef | null {
  const id = BASIC_TRAINING.find((t) => !progress.best[t]);
  return id ? findMission(id) : null;
}

export const showCampaign = (host: UiHost, campaign: CampaignDef, progress: CampaignProgress, toast: (t: string) => void) =>
  listScreen(host, 'campaign', campaign.name, campaign.missions, progress, toast, () => nextTraining(progress));
export const showTraining = (host: UiHost, missions: MissionDef[], progress: CampaignProgress, toast: (t: string) => void) =>
  listScreen(host, 'training', 'Training', missions, progress, toast);
