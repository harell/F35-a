/**
 * F35-A UI — mission briefing: intel map (left) + tabs BRIEFING / OBJECTIVES / HANGAR (right),
 * loadout picker limited to allowedLoadouts (default recommendedLoadout) with store diagrams and a
 * stealth rating bar, difficulty picker (4 levels, saved to settings), FLY / BACK.
 */
import type { MissionDef } from '../../core/contracts';
import { DIFFICULTIES, LOADOUTS, THEATER_INFO, TIME_OF_DAY_INFO, WEAPON_INFO } from '../../core/data';
import type { LoadoutId, Settings } from '../../core/types';
import { icon } from '../art/icons';
import { storesDiagramSvg } from '../art/storesDiagram';
import { escapeHtml, h } from '../dom';
import { missionGunAmmo } from '../../missions';
import { formatTime, pad2, stealthRating, storeLines } from '../format';
import type { UiHost } from '../host';
import { screenHeader } from '../widgets';
import { openDifficultySheet } from './difficultySheet';
import { drawIntelMap } from './intelMap';
import { aucklandLinz, loadAucklandLinz } from '../../world/terrain/theaters/aucklandLinz';

const WEATHER_LABEL = { clear: 'Clear', scattered: 'Scattered cloud', overcast: 'Overcast' } as const;
const ROLE_LABEL = { aa: 'AIR-AIR', ag: 'STRIKE', sead: 'SEAD' } as const;
const WEAPON_NAMES: Record<string, string> = Object.fromEntries(Object.entries(WEAPON_INFO).map(([k, v]) => [k, v.name]));

type Tab = 'brief' | 'obj' | 'hangar';

export function showBriefing(host: UiHost, m: MissionDef, settings: Settings): Promise<{ loadout: LoadoutId } | null> {
  return new Promise((resolve) => {
    let done = false;
    const allowed = (m.allowedLoadouts?.length ? m.allowedLoadouts : [m.recommendedLoadout]).filter((id) => LOADOUTS[id]);
    let loadout: LoadoutId = allowed.includes(m.recommendedLoadout) ? m.recommendedLoadout : allowed[0] ?? 'a2a_stealth';
    const el = h('section', { class: 'scr-brief' });
    const finish = (v: { loadout: LoadoutId } | null) => {
      if (done) return;
      done = true;
      window.removeEventListener('resize', redraw);
      host.leave(el);
      resolve(v);
    };

    const kind = m.kind === 'campaign' ? `Mission ${pad2(m.index)}` : m.kind === 'training' ? `Training ${pad2(m.index)}` : 'Instant action';
    const chips = h('div', { class: 'br-chips' });
    chips.innerHTML =
      `<span class="chip">${icon(m.timeOfDay)}${TIME_OF_DAY_INFO[m.timeOfDay].label}</span>` +
      `<span class="chip">${icon(m.weather)}${WEATHER_LABEL[m.weather]}</span>` +
      (m.timeLimit ? `<span class="chip">${icon('clock')}${formatTime(m.timeLimit)}</span>` : '');
    el.appendChild(screenHeader({ kicker: `${kind} · ${THEATER_INFO[m.theater].region}`, title: m.title, back: () => finish(null), right: [chips] }));

    const body = h('div', { class: 'scr-body br-body' });

    // ── intel map ──
    const mapWrap = h('div', { class: 'br-map ui-panel brk' });
    const canvas = h('canvas', { class: 'br-map-canvas', attrs: { role: 'img', 'aria-label': `Intel map for ${m.title}` } });
    const sweep = h('div', { class: 'br-map-sweep' });
    const legend = h('div', { class: 'br-legend' });
    legend.innerHTML =
      `<span class="lg lg-start">START</span><span class="lg lg-route">ROUTE</span>` +
      (m.intel.some((i) => i.kind === 'sam') ? `<span class="lg lg-sam">SAM</span>` : '') +
      (m.intel.some((i) => i.kind === 'air') ? `<span class="lg lg-air">AIR</span>` : '') +
      (m.intel.some((i) => i.kind === 'target') ? `<span class="lg lg-tgt">TARGET</span>` : '');
    mapWrap.append(canvas, sweep, legend);
    const expand = h('button', { class: 'ui-btn icon-only br-map-expand', attrs: { type: 'button', 'aria-label': 'Enlarge map' }, html: icon('display') });
    expand.addEventListener('click', () => {
      el.classList.toggle('map-big');
      requestAnimationFrame(redraw);
    });
    mapWrap.appendChild(expand);

    // ── right panel with tabs ──
    const side = h('div', { class: 'br-side ui-panel' });
    const tabs = h('div', { class: 'br-tabs', attrs: { role: 'tablist' } });
    const pages = h('div', { class: 'br-pages' });
    const tabDefs: { id: Tab; label: string; icon: string }[] = [
      { id: 'brief', label: 'Briefing', icon: 'book' },
      { id: 'obj', label: 'Objectives', icon: 'target' },
      { id: 'hangar', label: 'Hangar', icon: 'jet' },
    ];
    const tabBtns = new Map<Tab, HTMLButtonElement>();
    const pageEls = new Map<Tab, HTMLElement>();
    let cur: Tab = 'brief';
    const setTab = (t: Tab) => {
      cur = t;
      for (const [id, b] of tabBtns) {
        b.classList.toggle('is-on', id === t);
        b.setAttribute('aria-selected', String(id === t));
      }
      for (const [id, p] of pageEls) p.classList.toggle('is-on', id === t);
    };
    for (const t of tabDefs) {
      const b = h('button', { class: 'br-tab', attrs: { type: 'button', role: 'tab' }, html: `${icon(t.icon)}<span>${t.label}</span>` });
      b.addEventListener('click', () => setTab(t.id));
      tabBtns.set(t.id, b);
      tabs.appendChild(b);
    }

    // briefing text
    const brief = h('div', { class: 'br-page br-text ui-scroll' });
    brief.innerHTML =
      `<p class="br-lead">${escapeHtml(m.subtitle)}</p>` +
      m.briefing.map((p) => `<p>${escapeHtml(p)}</p>`).join('') +
      `<p class="br-sig mono">— DARKSTAR / RNZAF BASE AUCKLAND</p>`;
    pageEls.set('brief', brief);

    // objectives
    const obj = h('div', { class: 'br-page br-obj ui-scroll' });
    const objList = h('ol', { class: 'obj-list' });
    m.objectiveText.forEach((t) => {
      const bonus = /^bonus:/i.test(t);
      objList.appendChild(h('li', { class: bonus ? 'is-bonus' : '', html: `<span class="obj-mark">${bonus ? icon('star') : icon('target')}</span><span>${escapeHtml(bonus ? t.replace(/^bonus:\s*/i, '') : t)}</span>${bonus ? '<span class="badge obj-bonus">BONUS</span>' : ''}` }));
    });
    obj.appendChild(objList);
    const threats = m.intel.filter((i) => i.kind === 'sam' || i.kind === 'air');
    if (threats.length) {
      obj.appendChild(h('div', { class: 'br-sub', text: 'Known threats' }));
      const tl = h('div', { class: 'threat-list' });
      const counted = new Map<string, { kind: string; label: string; radius?: number; n: number }>();
      for (const t of threats) {
        const key = `${t.kind}|${t.label}`;
        const e = counted.get(key);
        if (e) e.n++;
        else counted.set(key, { kind: t.kind, label: t.label, radius: t.radius, n: 1 });
      }
      for (const t of counted.values()) {
        tl.appendChild(
          h('span', {
            class: `chip threat-${t.kind}`,
            html: `${icon(t.kind === 'sam' ? 'sam' : 'jet')}${t.n > 1 ? `${t.n}× ` : ''}${escapeHtml(t.label)}${t.radius ? ` · ${Math.round(t.radius / 1000)} km` : ''}`,
          }),
        );
      }
      obj.appendChild(tl);
    }
    pageEls.set('obj', obj);

    // hangar / loadouts
    const hangar = h('div', { class: 'br-page br-hangar ui-scroll' });
    const cards = h('div', { class: 'lo-cards' });
    const cardEls: HTMLButtonElement[] = [];
    // the mission may set its own gun rounds, per difficulty (MissionDef.gunAmmo)
    const gunLine = (id: LoadoutId) => `GAU-22 · ${missionGunAmmo(m, settings.difficulty, id)} rds`;
    const syncCards = () => {
      for (const c of cardEls) c.classList.toggle('is-on', c.dataset.id === loadout);
      loSummary.innerHTML = `${icon('jet')}<span>${escapeHtml(LOADOUTS[loadout].name)}</span>`;
    };
    for (const id of allowed) {
      const l = LOADOUTS[id];
      const stealth = stealthRating(l.rcsMultiplier);
      const tone = stealth > 0.8 ? 'good' : stealth > 0.45 ? 'ok' : 'bad';
      const c = h('button', { class: `lo-card ${id === m.recommendedLoadout ? 'is-rec' : ''}`, attrs: { type: 'button', 'aria-label': l.name }, dataset: { id } });
      c.innerHTML =
        `<div class="lo-art">${storesDiagramSvg(l, 110, 110)}</div>` +
        `<div class="lo-info"><div class="lo-name">${escapeHtml(l.name)}</div>` +
        `<div class="lo-tags"><span class="badge lo-role">${ROLE_LABEL[l.role]}</span>${id === m.recommendedLoadout ? '<span class="badge lo-recb">RECOMMENDED</span>' : ''}</div>` +
        `<ul class="lo-stores">${storeLines(l, WEAPON_NAMES)
          .map((s) => `<li class="${s.internal ? 'int' : 'ext'}">${escapeHtml(s.text)}<em>${s.internal ? 'bay' : 'pylon'}</em></li>`)
          .join('')}<li class="int lo-gun">${gunLine(id)}</li><li class="int">${l.flares} flares · ${l.chaff} chaff</li></ul>` +
        `<div class="lo-rcs"><span>STEALTH</span><div class="bar"><i class="tone-bar-${tone}" style="width:${Math.round(stealth * 100)}%"></i></div><b class="mono">${Math.round(stealth * 100)}</b></div>` +
        `<div class="lo-desc">${escapeHtml(l.description)}</div></div>`;
      c.addEventListener('click', () => {
        loadout = id;
        syncCards();
      });
      cardEls.push(c);
      cards.appendChild(c);
    }
    hangar.appendChild(cards);
    pageEls.set('hangar', hangar);

    pages.append(brief, obj, hangar);
    side.append(tabs, pages);
    body.append(mapWrap, side);
    el.appendChild(body);

    // ── footer ──
    // difficulty: tap to change right here (writes the Game's live settings object + saves it)
    const diffEl = h('button', { class: 'ui-btn ghost br-diff', attrs: { type: 'button', 'aria-haspopup': 'dialog' } });
    const syncDiff = () => {
      const d = DIFFICULTIES[settings.difficulty];
      diffEl.title = d?.description ?? '';
      diffEl.setAttribute('aria-label', `Difficulty: ${d?.label ?? settings.difficulty}. Tap to change`);
      diffEl.innerHTML = `<span class="br-diff-k">DIFFICULTY</span><span class="badge diff-${settings.difficulty}">${escapeHtml(d?.label ?? settings.difficulty)}</span><span class="br-diff-chg">${icon('next')}</span>`;
    };
    syncDiff();
    let closeSheet: (() => boolean) | null = null;
    diffEl.addEventListener('click', () => {
      closeSheet = openDifficultySheet(el, settings, () => {
        closeSheet = null;
        syncDiff();
        for (const c of cardEls) {
          const gun = c.querySelector('.lo-gun');
          if (gun) gun.textContent = gunLine(c.dataset.id as LoadoutId);
        }
        diffEl.focus();
      });
    });
    const loSummary = h('button', { class: 'ui-btn ghost br-lo-sum', attrs: { type: 'button', 'aria-label': 'Change loadout' } });
    loSummary.addEventListener('click', () => setTab('hangar'));
    const fly = h('button', { class: 'ui-btn primary go', attrs: { type: 'button' }, html: `${icon('jet')}<span>Fly</span>` });
    fly.addEventListener('click', () => finish({ loadout }));
    el.appendChild(h('footer', { class: 'scr-foot' }, diffEl, h('div', { class: 'spacer' }), loSummary, fly));

    syncCards();
    setTab(cur);

    // draw the map once laid out (and on resize / enlarge)
    const redraw = () => {
      if (!canvas.isConnected) return;
      // layout size (not the transformed rect — the screen may still be animating in)
      const w = mapWrap.clientWidth;
      const hh = mapWrap.clientHeight;
      if (w < 10 || hh < 10) return;
      drawIntelMap(canvas, m, w, hh, Math.min(2, window.devicePixelRatio || 1));
    };
    window.addEventListener('resize', redraw);
    host.present(el, { bg: true, back: () => (closeSheet?.() ? undefined : finish(null)), focus: fly });
    requestAnimationFrame(() => requestAnimationFrame(redraw));
    // the real coastline may still be downloading (prefetched at app start): redraw when it lands
    if (!aucklandLinz()) void loadAucklandLinz().then((ok) => ok && redraw());
  });
}
