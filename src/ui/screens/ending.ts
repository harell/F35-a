/**
 * F35-A UI — campaign ending (after the final campaign mission, MissionResult.campaignComplete):
 * epilogue over the animated chart background, the career summary and a slow credits roll;
 * CONTINUE returns to the menu.
 */
import type { MissionResult } from '../../core/contracts';
import { DIFFICULTIES } from '../../core/data';
import { icon } from '../art/icons';
import { logoBlock } from '../art/logo';
import { careerRank } from '../career';
import { escapeHtml, h } from '../dom';
import { formatScore } from '../format';
import type { UiHost } from '../host';
import { loadProgress } from '../../missions';

const EPILOGUE = [
  'The last enemy battalion on the Hauraki Gulf islands has surrendered. Rangitoto, Motutapu and Waiheke are back in New Zealand hands.',
  'For twelve sorties No. 75 Squadron held the line over Auckland: the Harbour Bridge still stands, the Sky Tower still lights the city, and the ferries are running again.',
  'Operation Southern Cross is complete. Welcome home, Lightning.',
];

const ROLL: [string, string][] = [
  ['Operation', 'Southern Cross'],
  ['Aircraft', 'F-35A Lightning II'],
  ['Theatre', 'Auckland · Waitematā · Hauraki Gulf'],
  ['Home base', 'RNZAF Base Auckland (Whenuapai)'],
  ['Inspired by', "NovaLogic's F-22 Raptor"],
  ['Built with', 'three.js · TypeScript · Vite · Web Audio'],
  ['Thank you', 'for flying'],
];

export function showCampaignEnding(host: UiHost, r: MissionResult): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const el = h('section', { class: 'scr-ending' });
    const finish = () => {
      if (done) return;
      done = true;
      host.leave(el);
      resolve();
    };
    let rankLine = '';
    try {
      const p = loadProgress();
      const cr = careerRank(p);
      rankLine = `${cr.rank.name} · ${p.totals.airKills} air kills · ${p.totals.groundKills} ground kills`;
    } catch {
      /* storage */
    }
    const d = DIFFICULTIES[r.difficulty];
    const medal = (r.medals ?? []).find((m) => m.id === 'southern_cross');
    const wrap = h('div', { class: 'en-wrap' });
    wrap.innerHTML =
      `<div class="en-logo">${logoBlock('OPERATION SOUTHERN CROSS')}</div>` +
      `<div class="en-k">${icon('flag')} CAMPAIGN COMPLETE</div>` +
      `<div class="en-text">${EPILOGUE.map((t, i) => `<p style="--i:${i}">${escapeHtml(t)}</p>`).join('')}</div>` +
      `<div class="en-sum">` +
      (medal ? `<span class="chip en-medal">${icon('star')} ${escapeHtml(medal.name)}</span>` : '') +
      `<span class="chip">${icon('trophy')} Final sortie ${r.grade} · ${formatScore(r.score)}</span>` +
      `<span class="chip"><span class="badge diff-${r.difficulty}">${escapeHtml(d?.label ?? r.difficulty)}</span></span>` +
      `</div>` +
      (rankLine ? `<div class="en-rank">${escapeHtml(rankLine)}</div>` : '') +
      `<div class="en-roll" aria-hidden="true"><div class="en-roll-in">${ROLL.map(([k, v]) => `<div class="en-rl"><em>${escapeHtml(k)}</em><b>${escapeHtml(v)}</b></div>`).join('')}</div></div>`;
    const go = h('button', { class: 'ui-btn primary go', attrs: { type: 'button' }, html: `<span>Continue</span>${icon('next')}` });
    go.addEventListener('click', finish);
    el.append(wrap, h('footer', { class: 'scr-foot' }, h('div', { class: 'spacer' }), go));
    host.present(el, { bg: true, back: finish, focus: go });
  });
}
