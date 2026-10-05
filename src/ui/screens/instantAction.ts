/**
 * F35-A UI — Instant Action setup: mode cards + city / time / weather / enemy / count pickers
 * (the enemy rows hide for A Stroll in the Park, which has no hostiles).
 * Remembers the last setup in localStorage (per device convenience).
 */
import type { InstantActionOptions } from '../../core/contracts';
import { AIRCRAFT_INFO, DIFFICULTIES } from '../../core/data';
import { DIFFICULTY_ORDER } from '../career';
import { IA_ENEMY_COUNT_SCALE } from '../../missions/content/instant';
import type { AircraftType, TheaterId, TimeOfDay, Weather } from '../../core/types';
import { icon } from '../art/icons';
import { landmark, type LandmarkId } from '../art/landmarks';
import { h } from '../dom';
import type { UiHost } from '../host';
import { screenHeader, segmented, settingRow, stagger } from '../widgets';

const KEY = 'f35a.instant.v1';

const MODES: { id: InstantActionOptions['mode']; title: string; desc: string; icon: string }[] = [
  { id: 'stroll', title: 'A Stroll in the Park', desc: "Everyone's friendly. It's New Zealand.", icon: 'pram' },
  { id: 'dogfight', title: 'Dogfight', desc: 'Air-to-air brawl against enemy fighters', icon: 'dogfight' },
  { id: 'sam_gauntlet', title: 'SAM Gauntlet', desc: 'Punch through layered SAM belts', icon: 'sam' },
  { id: 'strike', title: 'Strike', desc: 'Hit defended ground targets and get home', icon: 'bomb' },
  { id: 'defend', title: 'Defend', desc: 'Stop a strike on the Wiri fuel terminal', icon: 'shield' },
];

/**
 * Cities on offer. Only those with a theatre (Auckland) are playable; the rest are shown locked
 * ("Coming soon") to gauge interest before they are built.
 */
const CITIES: { name: string; tagline: string; art: LandmarkId; theater?: TheaterId }[] = [
  { name: 'Auckland', tagline: 'Latte, Traffic, Repeat', art: 'skyTower', theater: 'auckland' },
  { name: 'Wellington', tagline: "Can't Beat Today", art: 'beehive' },
  { name: 'Christchurch', tagline: 'Which High School?', art: 'cathedral' },
];
const PLAYABLE: TheaterId[] = CITIES.flatMap((c) => (c.theater ? [c.theater] : []));
const ENEMIES: (AircraftType | 'mixed')[] = ['mixed', 'mig29', 'su27', 'su35', 'su57'];

const DEFAULTS: InstantActionOptions = { mode: 'stroll', theater: 'auckland', timeOfDay: 'day', weather: 'scattered', enemyType: 'mixed', enemyCount: 4 };

/**
 * The Instant Action setup from its saved JSON (localStorage 'f35a.instant.v1'), else the defaults.
 * A theatre that isn't playable (a locked city, or one of the procedural theatres older builds
 * had) falls back to Auckland; a broken save to the defaults.
 */
export function parseInstantSetup(raw: string | null): InstantActionOptions {
  try {
    if (raw) {
      const v = { ...DEFAULTS, ...JSON.parse(raw) } as InstantActionOptions;
      if (!PLAYABLE.includes(v.theater)) v.theater = 'auckland';
      // a save from before Survival was removed (issue #63) falls back to the default mode
      if (!MODES.some((m) => m.id === v.mode)) v.mode = DEFAULTS.mode;
      v.enemyCount = Math.max(1, Math.min(8, Math.round(v.enemyCount) || 4));
      return v;
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

function load(): InstantActionOptions {
  try {
    return parseInstantSetup(localStorage.getItem(KEY));
  } catch {
    return { ...DEFAULTS };
  }
}

function save(o: InstantActionOptions): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(o));
  } catch {
    /* ignore */
  }
}

export function showInstantAction(host: UiHost): Promise<InstantActionOptions | null> {
  return new Promise((resolve) => {
    const o = load();
    let done = false;
    const el = h('section', { class: 'scr-instant' });
    const finish = (v: InstantActionOptions | null) => {
      if (done) return;
      done = true;
      if (v) save(v);
      host.leave(el);
      resolve(v);
    };
    el.appendChild(screenHeader({ kicker: 'Quick mission', title: 'Instant Action', back: () => finish(null) }));

    const body = h('div', { class: 'scr-body ia-body' });
    // ── modes ──
    const modes = h('div', { class: 'ia-modes' });
    const modeEls: HTMLButtonElement[] = [];
    const syncModes = () => modeEls.forEach((b) => b.classList.toggle('is-on', b.dataset.id === o.mode));
    for (const m of MODES) {
      const b = h('button', {
        class: 'ia-mode',
        attrs: { type: 'button', 'aria-label': m.title },
        dataset: { id: m.id },
        html: `<span class="ia-mode-ico">${icon(m.icon)}</span><span class="ia-mode-t">${m.title}</span><span class="ia-mode-d">${m.desc}</span>`,
      });
      b.addEventListener('click', () => {
        o.mode = m.id;
        syncModes();
        syncEnemyRows();
        updateSummary();
      });
      modeEls.push(b);
      modes.appendChild(b);
    }
    syncModes();
    stagger(modes);

    // ── options ──
    const opts = h('div', { class: 'ia-opts ui-panel ui-scroll' });
    opts.appendChild(
      settingRow(
        'City',
        null,
        cityPicker(o.theater, (v) => {
          o.theater = v;
          updateSummary();
        }),
        'row-stack',
      ),
    );
    opts.appendChild(
      settingRow(
        'Time',
        null,
        segmented<TimeOfDay>(
          [
            { value: 'dawn', label: 'Dawn', icon: 'dawn' },
            { value: 'day', label: 'Day', icon: 'day' },
            { value: 'dusk', label: 'Dusk', icon: 'dusk' },
            { value: 'night', label: 'Night', icon: 'night' },
          ],
          o.timeOfDay,
          (v) => {
            o.timeOfDay = v;
            updateSummary();
          },
        ),
        'row-stack',
      ),
    );
    opts.appendChild(
      settingRow(
        'Weather',
        null,
        segmented<Weather>(
          [
            { value: 'clear', label: 'Clear', icon: 'clear' },
            { value: 'scattered', label: 'Scattered', icon: 'scattered' },
            { value: 'overcast', label: 'Overcast', icon: 'overcast' },
          ],
          o.weather,
          (v) => {
            o.weather = v;
            updateSummary();
          },
        ),
        'row-stack',
      ),
    );
    const enemyRow = opts.appendChild(
      settingRow(
        'Enemy aircraft',
        null,
        segmented<AircraftType | 'mixed'>(
          ENEMIES.map((e) => ({ value: e, label: e === 'mixed' ? 'Mixed' : AIRCRAFT_INFO[e].name, title: e === 'mixed' ? 'Mixed types' : `${AIRCRAFT_INFO[e].name} “${AIRCRAFT_INFO[e].nato}”` })),
          o.enemyType,
          (v) => {
            o.enemyType = v;
            updateSummary();
          },
          'seg-wrap',
        ),
        'row-stack',
      ),
    );
    // count stepper
    const count = h('div', { class: 'stepper' });
    const minus = h('button', { class: 'ui-btn icon-only', attrs: { type: 'button', 'aria-label': 'Fewer enemies' }, text: '−' });
    const plus = h('button', { class: 'ui-btn icon-only', attrs: { type: 'button', 'aria-label': 'More enemies' }, text: '+' });
    const val = h('span', { class: 'stepper-val mono', text: String(o.enemyCount) });
    const setCount = (n: number) => {
      o.enemyCount = Math.max(1, Math.min(8, n));
      val.textContent = String(o.enemyCount);
      minus.disabled = o.enemyCount <= 1;
      plus.disabled = o.enemyCount >= 8;
      updateSummary();
    };
    minus.addEventListener('click', () => setCount(o.enemyCount - 1));
    plus.addEventListener('click', () => setCount(o.enemyCount + 1));
    count.append(minus, val, plus);
    const countRow = opts.appendChild(settingRow('Enemy count', countNote(), count));
    // no hostiles in A Stroll in the Park: nothing to pick
    const syncEnemyRows = () => {
      for (const r of [enemyRow, countRow]) r.hidden = o.mode === 'stroll';
    };
    syncEnemyRows();

    body.append(modes, opts);
    el.appendChild(body);

    const summary = h('div', { class: 'ia-summary' });
    const updateSummary = () => {
      const mode = MODES.find((m) => m.id === o.mode);
      const enemy = o.enemyType === 'mixed' ? 'mixed bandits' : `${AIRCRAFT_INFO[o.enemyType].name}s`;
      const threat = o.mode === 'stroll' ? 'no hostiles' : `${o.enemyCount}× ${enemy}`;
      summary.innerHTML = `<b>${mode?.title ?? ''}</b> · ${CITIES.find((c) => c.theater === o.theater)?.name ?? ''} · ${o.timeOfDay} · ${threat}`;
    };
    const start = h('button', { class: 'ui-btn primary go', attrs: { type: 'button' }, html: `${icon('play')}<span>Start</span>` });
    start.addEventListener('click', () => finish({ ...o }));
    const foot = h('footer', { class: 'scr-foot' }, summary, h('div', { class: 'spacer' }), start);
    el.appendChild(foot);
    setCount(o.enemyCount);
    host.present(el, { bg: true, back: () => finish(null), focus: start });
  });
}

/** City chips: landmark emblem + name + motto; cities without a theatre are disabled under a "Coming soon" tab. */
function cityPicker(value: TheaterId, onChange: (v: TheaterId) => void): HTMLElement {
  const wrap = h('div', { class: 'ia-cities', attrs: { role: 'radiogroup', 'aria-label': 'City' } });
  const buttons: HTMLButtonElement[] = [];
  let cur = value;
  const sync = () => {
    for (const b of buttons) {
      if (b.disabled) continue;
      const on = b.dataset.value === cur;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', String(on));
    }
  };
  for (const c of CITIES) {
    const locked = !c.theater;
    const b = h('button', {
      class: 'ia-city',
      attrs: { type: 'button', role: 'radio', 'aria-checked': 'false', 'aria-label': locked ? `${c.name}, coming soon` : c.name, title: locked ? `${c.name} — coming soon` : c.name },
      dataset: { value: c.theater ?? '' },
      html:
        `<span class="ia-city-emb">${landmark(c.art)}</span>` +
        `<span class="ia-city-t"><span class="ia-city-n">${c.name}</span><span class="ia-city-m">${c.tagline}</span></span>` +
        (locked ? `<span class="ia-city-soon">${icon('lock')}Coming soon</span>` : ''),
    });
    if (locked) b.disabled = true;
    else
      b.addEventListener('click', () => {
        if (!c.theater || cur === c.theater) return;
        cur = c.theater;
        sync();
        onChange(c.theater);
      });
    buttons.push(b);
    wrap.appendChild(b);
  }
  sync();
  return wrap;
}

/**
 * Enemy-count note from the live DIFFICULTIES numbers: dogfight and strike flights scale their
 * total by enemyCountScale (missions/content/instant.ts script.scaleEnemyTotal); the gauntlet's
 * number is its SAM sites.
 */
export function countNote(): string {
  // Instant Action's own scale where it has one (none today, issue #60)
  const scales = DIFFICULTY_ORDER.map((id) => DIFFICULTIES[id] && { ...DIFFICULTIES[id], enemyCountScale: IA_ENEMY_COUNT_SCALE[id] ?? DIFFICULTIES[id].enemyCountScale }).filter(Boolean);
  const lo = scales[0];
  const hi = scales[scales.length - 1];
  const scaled = scales.some((d) => d.enemyCountScale !== 1);
  if (!scaled || !lo || !hi) return 'Exact number of bandits';
  return `Dogfight/strike: ×${lo.enemyCountScale} on ${lo.label} … ×${hi.enemyCountScale} on ${hi.label} · Gauntlet: SAM sites · Defend: strikers + escort`;
}
