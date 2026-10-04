/**
 * F35-A UI — service record: career rank (RNZAF ranks from progress totals), career stats, the
 * campaign's best grades and the medal cabinet (catalogue from src/missions MEDAL_LIST, earned
 * tally from the UI's own storage — see career.ts recordMedals).
 */
import type { CampaignProgress } from '../../core/contracts';
import { DIFFICULTIES } from '../../core/data';
import * as Missions from '../../missions';
import { icon } from '../art/icons';
import { careerRank, loadMedals } from '../career';
import { escapeHtml, h } from '../dom';
import { gradeTone, pad2 } from '../format';
import type { UiHost } from '../host';
import { screenHeader } from '../widgets';

interface MedalInfo {
  id: string;
  name: string;
  description: string;
}

/** Defensive read of the missions module's medal catalogue (empty if it is ever renamed). */
function medalCatalogue(): MedalInfo[] {
  const list = (Missions as unknown as { MEDAL_LIST?: MedalInfo[] }).MEDAL_LIST;
  return Array.isArray(list) ? list : [];
}

export function showServiceRecord(host: UiHost, progress: CampaignProgress | null): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const el = h('section', { class: 'scr-record' });
    const finish = () => {
      if (done) return;
      done = true;
      host.leave(el);
      resolve();
    };
    const p: CampaignProgress = progress ?? { unlocked: [], best: {}, totals: { missions: 0, airKills: 0, groundKills: 0, deaths: 0 } };
    const r = careerRank(p);
    // every playable campaign's missions, campaign by campaign (a disabled campaign's old grades aren't counted)
    const campaign = (Missions.PLAYABLE_CAMPAIGNS ?? []).flatMap((c) => c.missions.slice().sort((a, b) => a.index - b.index));
    const training = (Missions.TRAINING ?? []).slice().sort((a, b) => a.index - b.index);
    const campDone = campaign.filter((m) => p.best[m.id]).length;
    const trainDone = training.filter((m) => p.best[m.id]).length;
    const earned = loadMedals();
    // earned medals first (catalogue order within each group)
    const catalogue = medalCatalogue()
      .map((m, i) => ({ m, i }))
      .sort((a, b) => Number(!!earned[b.m.id]) - Number(!!earned[a.m.id]) || a.i - b.i)
      .map((e) => e.m);
    const nEarned = catalogue.filter((m) => earned[m.id]).length;

    el.appendChild(
      screenHeader({
        kicker: 'No. 75 Squadron RNZAF',
        title: 'Service record',
        back: finish,
        right: [h('div', { class: 'ml-stat', html: `<span class="chip">${icon('star')} ${nEarned}/${catalogue.length}</span>` })],
      }),
    );

    const body = h('div', { class: 'scr-body sr-body' });
    // ── left: rank + stats + campaign strip ──
    const left = h('div', { class: 'sr-left ui-panel brk ui-scroll' });
    const pct = r.next ? Math.max(0, Math.min(1, (r.points - r.rank.at) / (r.next.at - r.rank.at))) : 1;
    left.innerHTML =
      `<div class="sr-rank"><span class="sr-rank-i">${icon('shield')}</span><span class="sr-rank-t"><em>${escapeHtml(r.rank.abbr)}</em><b>${escapeHtml(r.rank.name)}</b></span></div>` +
      `<div class="sr-bar"><i style="width:${Math.round(pct * 100)}%"></i></div>` +
      `<div class="sr-next">${r.next ? `${formatPts(r.toNext)} pts to ${escapeHtml(r.next.name)}` : 'Highest rank reached'}</div>` +
      `<div class="sr-stats">` +
      stat('flag', 'Campaign', `${campDone}/${campaign.length}`) +
      stat('book', 'Training', `${trainDone}/${training.length}`) +
      stat('check', 'Sorties won', String(p.totals.missions)) +
      stat('jet', 'Air kills', String(p.totals.airKills)) +
      stat('target', 'Ground kills', String(p.totals.groundKills)) +
      stat('skull', 'Lost', String(p.totals.deaths)) +
      `</div>` +
      `<div class="sr-h">Campaign grades</div>` +
      `<div class="sr-grades">${campaign
        .map((m) => {
          const b = p.best[m.id];
          const d = b ? DIFFICULTIES[b.difficulty] : null;
          return `<span class="sr-g ${b ? `tone-${gradeTone(b.grade)}` : 'is-none'}" title="${escapeHtml(m.title)}${d ? ' · ' + d.label : ''}"><em>${pad2(m.index)}</em><b>${b ? b.grade : '–'}</b></span>`;
        })
        .join('')}</div>` +
      `<div class="sr-foot">Rank points: 2 per sortie won, 1 per air kill, ½ per ground kill, 1 per A/S grade.</div>`;

    // ── right: medal cabinet ──
    const right = h('div', { class: 'sr-right ui-panel ui-scroll' });
    right.appendChild(h('div', { class: 'sr-h', text: 'Medals' }));
    const grid = h('div', { class: 'sr-medals' });
    if (!catalogue.length) grid.appendChild(h('div', { class: 'sr-empty', text: 'No medals catalogue in this build.' }));
    catalogue.forEach((m, i) => {
      const e = earned[m.id];
      const cell = h('div', {
        class: `sr-medal ${e ? 'is-earned' : 'is-locked'}`,
        attrs: { title: m.description },
        html:
          `<span class="md-ico">${icon(e ? 'star' : 'lock')}</span>` +
          `<span class="md-txt"><b>${escapeHtml(m.name)}</b><em>${escapeHtml(m.description)}</em></span>` +
          (e && e.count > 1 ? `<span class="md-n mono">×${e.count}</span>` : ''),
      });
      cell.style.setProperty('--i', String(i));
      grid.appendChild(cell);
    });
    right.appendChild(grid);

    body.append(left, right);
    el.appendChild(body);
    const back = h('button', { class: 'ui-btn', attrs: { type: 'button' }, html: `${icon('back')}<span>Back</span>` });
    back.addEventListener('click', finish);
    el.appendChild(h('footer', { class: 'scr-foot' }, back, h('div', { class: 'spacer' })));
    host.present(el, { bg: true, back: finish, focus: back });
  });
}

function formatPts(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function stat(ic: string, k: string, v: string): string {
  return `<div class="sr-stat"><span class="sr-si">${icon(ic)}</span><span class="sr-sk">${k}</span><span class="sr-sv mono">${v}</span></div>`;
}
