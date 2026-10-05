/**
 * F35-A UI — mission debrief: success/fail banner, animated grade letter, score count-up, kills by
 * type, accuracy, time, damage, objectives, medals earned (saved to the service record), debrief
 * tips; NEXT (if available, labelled by the caller: 'Next mission', 'Next lesson', 'Start the
 * campaign') / RETRY / MENU, "Retry on Recruit" after repeated failures, and the campaign ending
 * (result.campaignComplete) before returning to the menu. Free flight shows what the sightseer did
 * (sightseeingRows) instead of the combat stats.
 */
import type { MissionResultExt } from '../../missions/runtime/resultExt';
import type { MissionResult } from '../../core/contracts';
import type { Difficulty, Settings } from '../../core/types';
import { findMission, fixedDifficulty } from '../../missions';
import { recordMedals, setDifficulty } from '../career';
import { DIFFICULTIES, WEAPON_INFO } from '../../core/data';
import { formatNzd } from '../../missions/runtime/costs';
import { icon } from '../art/icons';
import { escapeHtml, h } from '../dom';
import { formatPercent, formatScore, formatTime, gradeTone } from '../format';
import type { UiHost } from '../host';
import { codexEntry } from '../codex/data';
import { showCampaignEnding } from './ending';

const GRADE_WORD: Record<MissionResult['grade'], string> = {
  S: 'OUTSTANDING',
  A: 'EXCELLENT',
  B: 'GOOD',
  C: 'SATISFACTORY',
  D: 'MARGINAL',
  F: 'UNSATISFACTORY',
};

export interface DebriefContext {
  /** The Game's live settings (for "Retry on Recruit"). */
  settings: () => Settings;
  /** Consecutive failures of this mission, including this one (from saved progress). */
  failStreak: number;
}

/** Offer "Retry on Recruit" after this many failures in a row (not already on Recruit). */
export const RECRUIT_OFFER_AFTER = 2;

/**
 * Show "Retry on Recruit": after RECRUIT_OFFER_AFTER failures in a row, not already on Recruit, and
 * not in a mission whose difficulty is fixed (a training lesson flies at Pilot whatever the setting,
 * so switching to Recruit would change nothing there).
 */
export function offerRecruitRetry(r: Pick<MissionResult, 'success' | 'missionId'>, failStreak: number, setting: Difficulty): boolean {
  if (r.success || failStreak < RECRUIT_OFFER_AFTER || setting === 'recruit' || !DIFFICULTIES.recruit) return false;
  const m = findMission(r.missionId);
  return !(m && fixedDifficulty(m));
}

/** Debrief stat rows for civil losses: airliners downed, civil ships and trains destroyed (only when > 0). */
export function civilLossRows(r: MissionResultExt): [string, string, string][] {
  const ships = r.civilianShipKills ?? 0;
  const trains = r.civilianTrainKills ?? 0;
  const airliners = (r.civilianKills ?? 0) - ships - trains;
  const rows: [string, string, string][] = [];
  if (airliners > 0) rows.push(['skull', 'Civil airliners downed', String(airliners)]);
  if (ships > 0) rows.push(['skull', 'Civil ships destroyed', String(ships)]);
  if (trains > 0) rows.push(['skull', 'Civil trains destroyed', String(trains)]);
  return rows;
}

const FT_PER_M = 3.28084;
const M_PER_NM = 1852;

/** A height for the debrief: feet like the HMD, metres alongside ("850 ft <small>260 m</small>"). */
function heightCell(m: number | null): string {
  if (m === null) return '—';
  const v = Math.max(0, m);
  return `${Math.round(v * FT_PER_M).toLocaleString('en-US')} ft <small>${Math.round(v).toLocaleString('en-US')} m</small>`;
}

/**
 * Debrief stat rows for free flight (A Stroll in the Park, issue #113): what a sightseer did — tour
 * stops visited, flight time, distance flown and the highest and lowest pass above the ground —
 * instead of accuracy, damage and kills.
 */
/**
 * The cost summary rows (#201: MissionResultExt.costSummary): flight time, each weapon fired, the
 * total, then the mission's comparison and what was removed. Empty when the mission has none.
 */
export function costRows(r: MissionResultExt): [string, string, string][] {
  const c = r.costSummary;
  if (!c) return [];
  const rows: [string, string, string][] = [['clock', `F-35A, ${c.hours.toFixed(2)} flight hours`, formatNzd(c.flightNzd)]];
  for (const w of c.weapons) rows.push(['target', `${w.count} × ${WEAPON_INFO[w.weapon].name}`, formatNzd(w.nzd)]);
  rows.push(['star', 'Total', formatNzd(c.totalNzd)]);
  rows.push(['shield', escapeHtml(c.comparison.label), formatNzd(c.comparison.nzd)]);
  rows.push(['check', escapeHtml(c.removed.label), String(c.removed.count)]);
  return rows;
}

export function sightseeingRows(r: MissionResultExt): [string, string, string][] {
  const t = r.sightseeing;
  const rows: [string, string, string][] = [];
  if (t) rows.push(['flag', 'Tour stops', `${t.stops}/${t.totalStops}`]);
  rows.push(['clock', 'Flight time', formatTime(r.time)]);
  if (t) {
    const nm = t.distance / M_PER_NM;
    rows.push(
      ['jet', 'Distance flown', `${nm < 10 ? nm.toFixed(1) : Math.round(nm)} nm <small>${Math.round(t.distance / 1000)} km</small>`],
      ['pin', 'Highest pass', heightCell(t.highestAgl)],
      ['pin', 'Lowest pass', heightCell(t.lowestAgl)],
    );
  }
  rows.push(...civilLossRows(r));
  return rows;
}

/**
 * The debrief's primary (highlighted, focused) button: the campaign ending after the last win, NEXT
 * when there is a next mission or lesson, MENU after any other win, RETRY after a failure.
 */
export function debriefPrimary(r: Pick<MissionResult, 'success' | 'campaignComplete'>, hasNext: boolean): 'ending' | 'next' | 'retry' | 'menu' {
  if (!r.success) return 'retry';
  if (r.campaignComplete) return 'ending';
  return hasNext ? 'next' : 'menu';
}

/** `next`: the label of the button that flies the next mission or lesson, null when there is none. */
export async function showDebrief(host: UiHost, r: MissionResult, next: string | null, ctx?: DebriefContext): Promise<'next' | 'retry' | 'menu'> {
  let fresh: string[] = [];
  try {
    fresh = recordMedals(r);
  } catch {
    /* storage */
  }
  const choice = await debriefScreen(host, r, next, ctx, new Set(fresh));
  if (r.campaignComplete && r.success && choice !== 'retry') {
    await showCampaignEnding(host, r);
    return 'menu';
  }
  return choice;
}

function debriefScreen(host: UiHost, r: MissionResult, nextLabel: string | null, ctx: DebriefContext | undefined, freshMedals: Set<string>): Promise<'next' | 'retry' | 'menu'> {
  return new Promise((resolve) => {
    let done = false;
    let raf = 0;
    /** Close function of an open Codex sheet. */
    let closeSheet: (() => boolean) | null = null;
    const el = h('section', { class: `scr-debrief ${r.success || r.freeFlight ? 'is-win' : 'is-loss'}` });
    const finish = (c: 'next' | 'retry' | 'menu') => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      closeSheet?.();
      host.leave(el);
      resolve(c);
    };
    const tone = gradeTone(r.grade);
    const diff = DIFFICULTIES[r.difficulty];

    // ── left: banner + grade + score ──
    const left = h('div', { class: 'db-left' });
    // free flight (A Stroll in the Park): 'FLIGHT OVER', no grade or score, nothing to beat
    const banner = r.freeFlight ? 'FLIGHT OVER' : r.success ? (r.campaignComplete ? 'CAMPAIGN COMPLETE' : 'MISSION ACCOMPLISHED') : 'MISSION FAILED';
    left.innerHTML =
      `<div class="db-banner"><span class="db-b-line"></span><span class="db-b-t">${banner}</span><span class="db-b-line"></span></div>` +
      `<div class="db-mission">${escapeHtml(r.title)}</div>` +
      `<div class="db-reason">${escapeHtml(r.reason)}</div>` +
      (r.freeFlight
        ? ''
        : `<div class="db-grade-wrap"><div class="db-ring tone-${tone}"></div><div class="db-grade tone-${tone}">${r.grade}</div></div>` +
          `<div class="db-gword tone-${tone}">${GRADE_WORD[r.grade]}</div>` +
          `<div class="db-score"><span class="db-score-k">SCORE</span><span class="db-score-v mono">0</span></div>` +
          `<div class="db-diff"><span class="badge diff-${r.difficulty}">${diff?.label ?? r.difficulty}</span><span class="mono">×${diff?.scoreMultiplier ?? 1}</span></div>`);

    // ── right: stats + objectives ──
    const right = h('div', { class: 'db-right ui-panel ui-scroll' });
    const ext = r as MissionResultExt;
    const stats: [string, string, string][] = r.freeFlight ? sightseeingRows(ext) : [
      ['jet', 'Air kills', String(r.kills.air)],
      ['sam', 'SAM kills', String(r.kills.sam)],
      ['target', 'Ground kills', String(r.kills.ground)],
      ['crosshair', 'Accuracy', `${formatPercent(r.accuracy)} <small>${r.hits}/${r.shotsFired}</small>`],
      ['clock', 'Mission time', formatTime(r.time)],
      ['shield', 'Damage taken', `${Math.round(r.damageTaken)}%`],
      ['skull', 'Friendly losses', String(r.friendlyLosses)],
    ];
    if (!r.freeFlight) {
      // who else scored (Viper 2, Weasel…): the grade weighs the player's share of the flight's kills
      for (const t of ext.teamKills ?? []) if (t.kills > 0) stats.push(['jet', `${escapeHtml(t.callsign)} kills`, String(t.kills)]);
      for (const t of ext.saved ?? []) stats.push(['shield', escapeHtml(t.label), `${t.saved}/${t.total}`]);
      stats.push(...civilLossRows(ext));
      if (ext.playerShare !== undefined && (ext.teamKills ?? []).some((t) => t.flight && t.kills > 0)) stats.push(['star', 'Your share', formatPercent(ext.playerShare)]);
    }
    // (free flight: one row each, so the sightseer's long values keep their labels whole)
    const grid = h('div', { class: r.freeFlight ? 'db-stats is-flight' : 'db-stats' });
    stats.forEach(([ic, k, v], i) => {
      const cell = h('div', { class: 'db-stat', html: `<span class="db-si">${icon(ic)}</span><span class="db-sk">${k}</span><span class="db-sv mono">${v}</span>` });
      cell.style.setProperty('--i', String(i));
      grid.appendChild(cell);
    });
    right.appendChild(h('div', { class: 'db-h', text: r.freeFlight ? 'Your flight' : 'Performance' }));
    right.appendChild(grid);
    // the sortie's cost against the job done another way (#201, g03)
    const bill = costRows(ext);
    if (bill.length) {
      const g2 = h('div', { class: 'db-stats is-flight' });
      bill.forEach(([ic, k, v], i) => {
        const cell = h('div', { class: 'db-stat', html: `<span class="db-si">${icon(ic)}</span><span class="db-sk">${k}</span><span class="db-sv mono">${v}</span>` });
        cell.style.setProperty('--i', String(stats.length + i));
        g2.appendChild(cell);
      });
      right.appendChild(h('div', { class: 'db-h', text: 'Cost of the sortie' }));
      right.appendChild(g2);
    }
    if (r.objectives.length) {
      right.appendChild(h('div', { class: 'db-h', text: 'Objectives' }));
      const ul = h('ul', { class: 'db-obj' });
      for (const o of r.objectives) {
        const ok = o.state === 'complete';
        const fail = o.state === 'failed';
        ul.appendChild(
          h('li', {
            class: `${ok ? 'is-ok' : fail ? 'is-fail' : 'is-open'} ${o.primary ? '' : 'is-bonus'}`,
            html: `<span class="db-oi">${icon(ok ? 'check' : fail ? 'close' : 'clock')}</span><span>${escapeHtml(o.label)}</span>${o.primary ? '' : '<span class="badge">BONUS</span>'}`,
          }),
        );
      }
      right.appendChild(ul);
    }

    const medals = r.medals ?? [];
    if (medals.length) {
      right.insertBefore(h('div', { class: 'db-h', text: medals.length > 1 ? `Medals · ${medals.length}` : 'Medal' }), right.firstChild);
      const mg = h('div', { class: 'db-medals' });
      medals.forEach((m, i) => {
        const cell = h('div', {
          class: `db-medal ${freshMedals.has(m.id) ? 'is-new' : ''}`,
          html: `<span class="md-ico">${icon('star')}</span><span class="md-txt"><b>${escapeHtml(m.name)}</b><em>${escapeHtml(m.description)}</em></span>${freshMedals.has(m.id) ? '<span class="badge md-new">NEW</span>' : ''}`,
        });
        cell.style.setProperty('--i', String(i));
        mg.appendChild(cell);
      });
      right.insertBefore(mg, right.children[1] ?? null);
    }
    const tips = (r.tips ?? []).filter((t) => typeof t === 'string' && t.trim());
    if (tips.length) {
      const box = h('div', { class: `db-tips ${r.success ? 'is-win' : 'is-loss'}` });
      box.appendChild(h('div', { class: 'db-tips-h', html: `${icon('info')}<span>${r.success ? 'Debrief notes' : 'How to beat it'}</span>` }));
      const ul = h('ul');
      for (const t of tips.slice(0, 4)) ul.appendChild(h('li', { text: t }));
      box.appendChild(ul);
      // failures: advice first (it is what the player needs); wins: after the stats
      if (r.success) right.appendChild(box);
      else right.insertBefore(box, right.firstChild);
    }
    // what ended the sortie, explained: opens the Codex at that warning or weapon
    const learnEntry = !r.success && r.codexId ? codexEntry(r.codexId) : null;
    if (learnEntry) {
      const learn = h('button', {
        class: 'ui-btn ghost db-learn',
        attrs: { type: 'button' },
        html: `${icon('book')}<span>What happened? Read <b>${escapeHtml(learnEntry.name)}</b> in the Codex</span>${icon('next')}`,
      });
      learn.addEventListener('click', () => {
        void import('./codex').then((m) => {
          if (done) return;
          closeSheet = m.openCodexSheet(el, learnEntry.id, () => {
            closeSheet = null;
            learn.focus();
          });
        }, () => undefined); // offline before the Codex was ever loaded: nothing to show
      });
      const tipsBox = right.querySelector('.db-tips');
      if (tipsBox) tipsBox.appendChild(learn);
      else right.insertBefore(learn, right.firstChild);
    }

    const body = h('div', { class: 'scr-body db-body' }, left, right);
    el.appendChild(body);

    // ── footer ──
    const foot = h('footer', { class: 'scr-foot db-foot' });
    const primary = debriefPrimary(r, nextLabel !== null);
    const menu = h('button', { class: `ui-btn ${primary === 'menu' ? 'primary' : ''}`, attrs: { type: 'button' }, html: `${icon('menu')}<span>Menu</span>` });
    menu.addEventListener('click', () => finish('menu'));
    const retry = h('button', { class: `ui-btn ${primary === 'retry' ? 'primary' : ''}`, attrs: { type: 'button' }, html: `${icon('retry')}<span>Retry</span>` });
    retry.addEventListener('click', () => finish('retry'));
    foot.append(menu, h('div', { class: 'spacer' }));
    const live = ctx?.settings();
    if (live && ctx && offerRecruitRetry(r, ctx.failStreak, live.difficulty)) {
      const easy = h('button', { class: 'ui-btn db-easy', attrs: { type: 'button', title: DIFFICULTIES.recruit.description }, html: `${icon('shield')}<span>Retry on Recruit</span>` });
      easy.addEventListener('click', () => {
        setDifficulty(live, 'recruit');
        finish('retry');
      });
      foot.appendChild(easy);
    }
    foot.appendChild(retry);
    let focusEl: HTMLElement = primary === 'menu' ? menu : retry;
    if (primary === 'ending') {
      const fin = h('button', { class: 'ui-btn primary go', attrs: { type: 'button' }, html: `<span>Campaign complete</span>${icon('next')}` });
      fin.addEventListener('click', () => finish('menu'));
      foot.appendChild(fin);
      focusEl = fin;
    } else if (primary === 'next') {
      const next = h('button', { class: 'ui-btn primary go', attrs: { type: 'button' }, html: `<span>${escapeHtml(nextLabel ?? 'Next mission')}</span>${icon('next')}` });
      next.addEventListener('click', () => finish('next'));
      foot.appendChild(next);
      focusEl = next;
    }
    el.appendChild(foot);
    host.present(el, { bg: true, back: () => (closeSheet?.() ? undefined : finish('menu')), focus: focusEl });

    // score count-up (starts once the grade has landed)
    const scoreEl = left.querySelector('.db-score-v') as HTMLElement | null;
    if (!scoreEl) return;
    const t0 = performance.now() + 650;
    const dur = 1200;
    const step = (now: number) => {
      const k = Math.max(0, Math.min(1, (now - t0) / dur));
      const e = 1 - Math.pow(1 - k, 3);
      scoreEl.textContent = formatScore(r.score * e);
      if (k < 1 && !done) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  });
}
