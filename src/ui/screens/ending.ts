/**
 * F35-A UI — campaign ending (after a campaign's final mission, MissionResult.campaignComplete), one
 * per campaign: epilogue over the animated chart background, the career summary and a slow credits
 * roll; CONTINUE returns to the menu.
 */
import type { CampaignId, MissionResult } from '../../core/contracts';
import { DIFFICULTIES } from '../../core/data';
import { icon } from '../art/icons';
import { logoBlock } from '../art/logo';
import { careerRank } from '../career';
import { escapeHtml, h } from '../dom';
import { formatScore } from '../format';
import type { UiHost } from '../host';
import { CAMPAIGNS, campaignOf, loadProgress } from '../../missions';

/** The credits after the campaign's own first line. */
const ROLL: [string, string][] = [
  ['Aircraft', 'F-35A Lightning II'],
  ['Theatre', 'Auckland · Waitematā · Hauraki Gulf'],
  ['Home base', 'RNZAF Base Auckland (Whenuapai)'],
  ['Inspired by', "NovaLogic's F-22 Raptor"],
  ['Built with', 'three.js · TypeScript · Vite · Web Audio'],
  ['Thank you', 'for flying'],
];

/** What a campaign's ending screen shows. */
export interface CampaignEnding {
  /** Line under the logo. */
  tag: string;
  epilogue: string[];
  roll: [string, string][];
  /** Medal id shown as a chip when this sortie awarded it. */
  medal: string | null;
}

/** The IRGC campaign's name (a working title until it is decided: content/irgc.ts). */
const irgcName = (): string => CAMPAIGNS.find((c) => c.id === 'irgc')?.name ?? 'IRGC · Interspecies Revolutionary Guard Corps';

/**
 * Placeholder ending for the IRGC campaign until the campaign is complete (epic #72: its finale is
 * not decided yet). Short on purpose; the real epilogue arrives with the campaign's last mission.
 */
const IRGC_EPILOGUE = (name: string) => [
  'The Wasp air wing is out of the sky over Auckland, the Rat navy out of the Hauraki Gulf and Stoat Command off Waiheke.',
  `${name}: the campaign is complete. 2050 is still ahead, and the Guard is counting too. Welcome home, Lightning.`,
];

/** The ending of a campaign (the IRGC campaign is the only one; an unknown id gets its ending too). */
export function campaignEnding(_id: CampaignId | null): CampaignEnding {
  const name = irgcName();
  return { tag: name.toUpperCase(), epilogue: IRGC_EPILOGUE(name), roll: [['Campaign', name], ...ROLL], medal: null };
}

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
    const ending = campaignEnding(campaignOf(r.missionId)?.id ?? null);
    const d = DIFFICULTIES[r.difficulty];
    const medal = ending.medal ? (r.medals ?? []).find((m) => m.id === ending.medal) : undefined;
    const wrap = h('div', { class: 'en-wrap' });
    wrap.innerHTML =
      `<div class="en-logo">${logoBlock(ending.tag)}</div>` +
      `<div class="en-k">${icon('flag')} CAMPAIGN COMPLETE</div>` +
      `<div class="en-text">${ending.epilogue.map((t, i) => `<p style="--i:${i}">${escapeHtml(t)}</p>`).join('')}</div>` +
      `<div class="en-sum">` +
      (medal ? `<span class="chip en-medal">${icon('star')} ${escapeHtml(medal.name)}</span>` : '') +
      `<span class="chip">${icon('trophy')} Final sortie ${r.grade} · ${formatScore(r.score)}</span>` +
      `<span class="chip"><span class="badge diff-${r.difficulty}">${escapeHtml(d?.label ?? r.difficulty)}</span></span>` +
      `</div>` +
      (rankLine ? `<div class="en-rank">${escapeHtml(rankLine)}</div>` : '') +
      `<div class="en-roll" aria-hidden="true"><div class="en-roll-in">${ending.roll.map(([k, v]) => `<div class="en-rl"><em>${escapeHtml(k)}</em><b>${escapeHtml(v)}</b></div>`).join('')}</div></div>`;
    const go = h('button', { class: 'ui-btn primary go', attrs: { type: 'button' }, html: `<span>Continue</span>${icon('next')}` });
    go.addEventListener('click', finish);
    el.append(wrap, h('footer', { class: 'scr-foot' }, h('div', { class: 'spacer' }), go));
    host.present(el, { bg: true, back: finish, focus: go });
  });
}
