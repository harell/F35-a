/**
 * F35-A UI — Instant Action setup: mode cards + theatre / time / weather / enemy / count pickers.
 * Remembers the last setup in localStorage (per device convenience).
 */
import type { InstantActionOptions } from '../../core/contracts';
import { AIRCRAFT_INFO, DIFFICULTIES, THEATER_INFO } from '../../core/data';
import { DIFFICULTY_ORDER } from '../career';
import type { AircraftType, TheaterId, TimeOfDay, Weather } from '../../core/types';
import { icon } from '../art/icons';
import { h } from '../dom';
import type { UiHost } from '../host';
import { screenHeader, segmented, settingRow, stagger } from '../widgets';

const KEY = 'f35a.instant.v1';

const MODES: { id: InstantActionOptions['mode']; title: string; desc: string; icon: string }[] = [
  { id: 'dogfight', title: 'Dogfight', desc: 'Air-to-air brawl against enemy fighters', icon: 'dogfight' },
  { id: 'sam_gauntlet', title: 'SAM Gauntlet', desc: 'Punch through layered SAM belts', icon: 'sam' },
  { id: 'strike', title: 'Strike', desc: 'Hit defended ground targets and get home', icon: 'bomb' },
  { id: 'survival', title: 'Survival', desc: 'Endless waves — how long can you last?', icon: 'waves' },
];

const THEATERS: TheaterId[] = ['auckland', 'desert', 'islands', 'mountains', 'arctic'];
const THEATER_SHORT: Record<TheaterId, string> = { auckland: 'Auckland', desert: 'Desert', islands: 'Islands', mountains: 'Mountains', arctic: 'Arctic' };
const ENEMIES: (AircraftType | 'mixed')[] = ['mixed', 'mig29', 'su27', 'su35', 'su57', 'tu22m', 'a50'];

const DEFAULTS: InstantActionOptions = { mode: 'dogfight', theater: 'auckland', timeOfDay: 'day', weather: 'scattered', enemyType: 'mixed', enemyCount: 4 };

function load(): InstantActionOptions {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = { ...DEFAULTS, ...JSON.parse(raw) } as InstantActionOptions;
      if (!THEATERS.includes(v.theater)) v.theater = 'auckland';
      v.enemyCount = Math.max(1, Math.min(8, Math.round(v.enemyCount) || 4));
      return v;
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
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
        'Theatre',
        null,
        segmented(
          THEATERS.map((t) => ({ value: t, label: THEATER_SHORT[t], title: `${THEATER_INFO[t].region}` })),
          o.theater,
          (v) => {
            o.theater = v;
            updateSummary();
          },
          'seg-wrap',
        ),
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
    opts.appendChild(
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
    opts.appendChild(settingRow('Enemy count', countNote(), count));

    body.append(modes, opts);
    el.appendChild(body);

    const summary = h('div', { class: 'ia-summary' });
    const updateSummary = () => {
      const mode = MODES.find((m) => m.id === o.mode);
      const enemy = o.enemyType === 'mixed' ? 'mixed bandits' : `${AIRCRAFT_INFO[o.enemyType].name}s`;
      summary.innerHTML = `<b>${mode?.title ?? ''}</b> · ${THEATER_SHORT[o.theater]} · ${o.timeOfDay} · ${o.enemyCount}× ${enemy}`;
    };
    const start = h('button', { class: 'ui-btn primary go', attrs: { type: 'button' }, html: `${icon('play')}<span>Start</span>` });
    start.addEventListener('click', () => finish({ ...o }));
    const foot = h('footer', { class: 'scr-foot' }, summary, h('div', { class: 'spacer' }), start);
    el.appendChild(foot);
    setCount(o.enemyCount);
    host.present(el, { bg: true, back: () => finish(null), focus: start });
  });
}

/**
 * Enemy-count note from the live DIFFICULTIES numbers: dogfight and strike flights scale their
 * total by enemyCountScale (missions/content/instant.ts script.scaleEnemyTotal); the gauntlet's
 * number is its SAM sites and survival's is the first wave.
 */
export function countNote(): string {
  const scales = DIFFICULTY_ORDER.map((id) => DIFFICULTIES[id]).filter(Boolean);
  const lo = scales[0];
  const hi = scales[scales.length - 1];
  const scaled = scales.some((d) => d.enemyCountScale !== 1);
  if (!scaled || !lo || !hi) return 'Exact number of bandits';
  return `Dogfight/strike: ×${lo.enemyCountScale} on ${lo.label} … ×${hi.enemyCountScale} on ${hi.label} · Gauntlet: SAM sites · Survival: first wave`;
}
