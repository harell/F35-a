/**
 * F35-A UI — mission debrief: success/fail banner, animated grade letter, score count-up, kills by
 * type, accuracy, time, damage, objectives; NEXT (if available) / RETRY / MENU.
 */
import type { MissionResult } from '../../core/contracts';
import { DIFFICULTIES } from '../../core/data';
import { icon } from '../art/icons';
import { escapeHtml, h } from '../dom';
import { formatPercent, formatScore, formatTime, gradeTone } from '../format';
import type { UiHost } from '../host';

const GRADE_WORD: Record<MissionResult['grade'], string> = {
  S: 'OUTSTANDING',
  A: 'EXCELLENT',
  B: 'GOOD',
  C: 'SATISFACTORY',
  D: 'MARGINAL',
  F: 'UNSATISFACTORY',
};

export function showDebrief(host: UiHost, r: MissionResult, hasNext: boolean): Promise<'next' | 'retry' | 'menu'> {
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
      `<div class="db-banner"><span class="db-b-line"></span><span class="db-b-t">${r.success ? 'MISSION ACCOMPLISHED' : 'MISSION FAILED'}</span><span class="db-b-line"></span></div>` +
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

    const body = h('div', { class: 'scr-body db-body' }, left, right);
    el.appendChild(body);

    // ── footer ──
    const foot = h('footer', { class: 'scr-foot db-foot' });
    const menu = h('button', { class: 'ui-btn', attrs: { type: 'button' }, html: `${icon('menu')}<span>Menu</span>` });
    menu.addEventListener('click', () => finish('menu'));
    const retry = h('button', { class: `ui-btn ${hasNext ? '' : 'primary'}`, attrs: { type: 'button' }, html: `${icon('retry')}<span>Retry</span>` });
    retry.addEventListener('click', () => finish('retry'));
    foot.append(menu, h('div', { class: 'spacer' }), retry);
    let focusEl: HTMLElement = retry;
    if (hasNext) {
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
