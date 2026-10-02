/**
 * F35-A UI — campaign picker: one row per campaign (name, one-line description, missions won, or
 * "Coming soon" while a campaign has no missions yet). Picking one opens its mission list
 * (missionList.ts showCampaign); Back returns to the main menu.
 */
import type { CampaignDef, CampaignProgress } from '../../core/contracts';
import { icon } from '../art/icons';
import { escapeHtml, h } from '../dom';
import { campaignStatus } from '../format';
import type { UiHost } from '../host';
import { screenHeader, stagger } from '../widgets';

const CAMPAIGN_ICON: Record<CampaignDef['id'], string> = { southern_cross: 'flag', irgc: 'crosshair' };

export function showCampaigns(host: UiHost, campaigns: CampaignDef[], progress: CampaignProgress, toast: (t: string) => void): Promise<CampaignDef | null> {
  return new Promise((resolve) => {
    let done = false;
    const el = h('section', { class: 'scr-campaigns' });
    const finish = (c: CampaignDef | null) => {
      if (done) return;
      done = true;
      host.leave(el);
      resolve(c);
    };
    el.appendChild(screenHeader({ kicker: 'Campaign', title: 'Choose a campaign', back: () => finish(null) }));

    const body = h('div', { class: 'scr-body cp-body ui-scroll' });
    const list = h('nav', { class: 'cp-list', attrs: { 'aria-label': 'Campaigns' } });
    let focus: HTMLElement | null = null;
    for (const c of campaigns) {
      const st = campaignStatus(c, progress);
      const right = st.soon ? `<span class="badge cp-soon">${icon('lock')}Coming soon</span>` : `<span class="chip">${icon('check')} ${st.done}/${st.total}</span>`;
      const b: HTMLButtonElement = h('button', {
        class: `mm-item cp-item${st.soon ? ' is-soon' : ''}${!focus && !st.soon ? ' is-primary' : ''}`,
        attrs: { type: 'button', 'aria-label': `${c.name}: ${c.description}${st.soon ? ' (coming soon)' : `, ${st.done} of ${st.total} missions won`}` },
        dataset: { id: c.id },
        html:
          `<span class="mm-ico">${icon(CAMPAIGN_ICON[c.id] ?? 'flag')}</span>` +
          `<span class="mm-txt"><span class="mm-t">${escapeHtml(c.name)}</span><span class="mm-s">${escapeHtml(c.description)}</span></span>` +
          `<span class="cp-r">${right}</span>` +
          `<span class="mm-go">${icon('next')}</span>`,
      });
      b.addEventListener('click', () => {
        if (st.soon) {
          b.classList.remove('shake');
          void b.offsetWidth;
          b.classList.add('shake');
          toast(`${c.name}: coming soon`);
          return;
        }
        finish(c);
      });
      if (!focus && !st.soon) focus = b;
      list.appendChild(b);
    }
    stagger(list);
    body.appendChild(list);
    el.appendChild(body);
    host.present(el, { bg: true, back: () => finish(null), focus });
  });
}
