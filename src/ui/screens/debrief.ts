/**
 * F35-A UI — mission debrief: success/fail banner, animated grade letter, score count-up, kills by
 * type, accuracy, time, damage, objectives, medals earned (saved to the service record), debrief
 * tips; NEXT (if available) / RETRY / MENU, "Retry on Recruit" after repeated failures, and the
 * campaign ending (result.campaignComplete) before returning to the menu.
 */
import type { MissionResultExt } from '../../missions/runtime/resultExt';
import type { MissionResult } from '../../core/contracts';
import type { Settings } from '../../core/types';
import { recordMedals, setDifficulty } from '../career';
import { DIFFICULTIES } from '../../core/data';
import { icon } from '../art/icons';
import { escapeHtml, h } from '../dom';
import { formatPercent, formatScore, formatTime, gradeTone } from '../format';
import type { UiHost } from '../host';
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

/** Debrief stat rows for civil losses: airliners downed and civil ships destroyed (only when > 0). */
export function civilLossRows(r: MissionResultExt): [string, string, string][] {
  const ships = r.civilianShipKills ?? 0;
  const airliners = (r.civilianKills ?? 0) - ships;
  const rows: [string, string, string][] = [];
  if (airliners > 0) rows.push(['skull', 'Civil airliners downed', String(airliners)]);
  if (ships > 0) rows.push(['skull', 'Civil ships destroyed', String(ships)]);
  return rows;
}

export async function showDebrief(host: UiHost, r: MissionResult, hasNext: boolean, ctx?: DebriefContext): Promise<'next' | 'retry' | 'menu'> {
  let fresh: string[] = [];
  try {
    fresh = recordMedals(r);
  } catch {
    /* storage */
  }
  const choice = await debriefScreen(host, r, hasNext, ctx, new Set(fresh));
  if (r.campaignComplete && r.success && choice !== 'retry') {
    await showCampaignEnding(host, r);
    return 'menu';
  }
  return choice;
}

function debriefScreen(host: UiHost, r: MissionResult, hasNext: boolean, ctx: DebriefContext | undefined, freshMedals: Set<string>): Promise<'next' | 'retry' | 'menu'> {
  return new Promise((resolve) => {
    let done = false;
    let raf = 0;
    const el = h('section', { class: `scr-debrief ${r.success ? 'is-win' : 'is-loss'}` });
    const finish = (c: 'next' | 'retry' | 'menu') => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      host.leave(el);
      resolve(c);
    };
    const tone = gradeTone(r.grade);
    const diff = DIFFICULTIES[r.difficulty];

    // ── left: banner + grade + score ──
    const left = h('div', { class: 'db-left' });
    left.innerHTML =
      `<div class="db-banner"><span class="db-b-line"></span><span class="db-b-t">${r.success ? (r.campaignComplete ? 'CAMPAIGN COMPLETE' : 'MISSION ACCOMPLISHED') : 'MISSION FAILED'}</span><span class="db-b-line"></span></div>` +
      `<div class="db-mission">${escapeHtml(r.title)}</div>` +
      `<div class="db-reason">${escapeHtml(r.reason)}</div>` +
      `<div class="db-grade-wrap"><div class="db-ring tone-${tone}"></div><div class="db-grade tone-${tone}">${r.grade}</div></div>` +
      `<div class="db-gword tone-${tone}">${GRADE_WORD[r.grade]}</div>` +
      `<div class="db-score"><span class="db-score-k">SCORE</span><span class="db-score-v mono">0</span></div>` +
      `<div class="db-diff"><span class="badge diff-${r.difficulty}">${diff?.label ?? r.difficulty}</span><span class="mono">×${diff?.scoreMultiplier ?? 1}</span></div>`;

    // ── right: stats + objectives ──
    const right = h('div', { class: 'db-right ui-panel ui-scroll' });
    const stats: [string, string, string][] = [
      ['jet', 'Air kills', String(r.kills.air)],
      ['sam', 'SAM kills', String(r.kills.sam)],
      ['target', 'Ground kills', String(r.kills.ground)],
      ['crosshair', 'Accuracy', `${formatPercent(r.accuracy)} <small>${r.hits}/${r.shotsFired}</small>`],
      ['clock', 'Mission time', formatTime(r.time)],
      ['shield', 'Damage taken', `${Math.round(r.damageTaken)}%`],
      ['skull', 'Friendly losses', String(r.friendlyLosses)],
    ];
    // who else scored (Viper 2, Weasel…): the grade weighs the player's share of the flight's kills
    const ext = r as MissionResultExt;
    for (const t of ext.teamKills ?? []) if (t.kills > 0) stats.push(['jet', `${escapeHtml(t.callsign)} kills`, String(t.kills)]);
    for (const t of ext.saved ?? []) stats.push(['shield', escapeHtml(t.label), `${t.saved}/${t.total}`]);
    stats.push(...civilLossRows(ext));
    if (ext.playerShare !== undefined && (ext.teamKills ?? []).some((t) => t.flight && t.kills > 0)) stats.push(['star', 'Your share', formatPercent(ext.playerShare)]);
    const grid = h('div', { class: 'db-stats' });
    stats.forEach(([ic, k, v], i) => {
      const cell = h('div', { class: 'db-stat', html: `<span class="db-si">${icon(ic)}</span><span class="db-sk">${k}</span><span class="db-sv mono">${v}</span>` });
      cell.style.setProperty('--i', String(i));
      grid.appendChild(cell);
    });
    right.appendChild(h('div', { class: 'db-h', text: 'Performance' }));
    right.appendChild(grid);
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

    const body = h('div', { class: 'scr-body db-body' }, left, right);
    el.appendChild(body);

    // ── footer ──
    const foot = h('footer', { class: 'scr-foot db-foot' });
    const menu = h('button', { class: 'ui-btn', attrs: { type: 'button' }, html: `${icon('menu')}<span>Menu</span>` });
    menu.addEventListener('click', () => finish('menu'));
    const retry = h('button', { class: `ui-btn ${hasNext ? '' : 'primary'}`, attrs: { type: 'button' }, html: `${icon('retry')}<span>Retry</span>` });
    retry.addEventListener('click', () => finish('retry'));
    foot.append(menu, h('div', { class: 'spacer' }));
    const live = ctx?.settings();
    if (!r.success && live && ctx && ctx.failStreak >= RECRUIT_OFFER_AFTER && live.difficulty !== 'recruit' && DIFFICULTIES.recruit) {
      const easy = h('button', { class: 'ui-btn db-easy', attrs: { type: 'button', title: DIFFICULTIES.recruit.description }, html: `${icon('shield')}<span>Retry on Recruit</span>` });
      easy.addEventListener('click', () => {
        setDifficulty(live, 'recruit');
        finish('retry');
      });
      foot.appendChild(easy);
    }
    foot.appendChild(retry);
    let focusEl: HTMLElement = retry;
    if (r.campaignComplete && r.success) {
      const fin = h('button', { class: 'ui-btn primary go', attrs: { type: 'button' }, html: `<span>Campaign complete</span>${icon('next')}` });
      fin.addEventListener('click', () => finish('menu'));
      foot.appendChild(fin);
      focusEl = fin;
      retry.classList.remove('primary');
    } else if (hasNext) {
      const next = h('button', { class: 'ui-btn primary go', attrs: { type: 'button' }, html: `<span>Next mission</span>${icon('next')}` });
      next.addEventListener('click', () => finish('next'));
      foot.appendChild(next);
      focusEl = next;
    }
    el.appendChild(foot);
    host.present(el, { bg: true, back: () => finish('menu'), focus: focusEl });

    // score count-up (starts once the grade has landed)
    const scoreEl = left.querySelector('.db-score-v') as HTMLElement;
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
