/**
 * F35-A UI — settings editor. Tabs: FLIGHT (difficulty, hints) · CONTROLS (stick/tilt + calibration
 * with a live bubble, invert, sensitivities, left-handed, haptics) · AUDIO · DISPLAY (HMD colour, FOV,
 * quality, FPS counter, default view). Resolves with the edited copy when closed.
 */
import { DIFFICULTIES } from '../../core/data';
import type { Difficulty, Settings } from '../../core/types';
import { RECENTER_TILT_EVENT } from '../../input/shared';
import { TiltSource } from '../../input/tilt';
import { screenAngle } from '../../input/tilt';
import { DEFAULT_TILT_NEUTRAL, tiltAngles, tiltToAxes, type TiltAngles, type TiltCalibration } from '../../input/tiltMath';
import { icon } from '../art/icons';
import { escapeHtml, h } from '../dom';
import type { UiHost } from '../host';
import { difficultyFacts } from '../career';
import { screenHeader, segmented, settingRow, slider, toggle } from '../widgets';

type Tab = 'flight' | 'controls' | 'audio' | 'display';


export function showSettings(host: UiHost, input: Settings, toast: (t: string) => void, opts: { overlay: boolean }): Promise<Settings> {
  return new Promise((resolve) => {
    const s: Settings = { ...input };
    let done = false;
    let tiltPreviewOff: (() => void) | null = null;
    const el = h('section', { class: `scr-settings ${opts.overlay ? 'is-overlay' : ''}` });
    const finish = () => {
      if (done) return;
      done = true;
      tiltPreviewOff?.();
      host.leave(el);
      resolve(s);
    };
    const doneBtn = h('button', { class: 'ui-btn primary', attrs: { type: 'button' }, html: `${icon('check')}<span>Done</span>` });
    doneBtn.addEventListener('click', finish);
    el.appendChild(screenHeader({ kicker: 'Options', title: 'Settings', back: finish, backLabel: 'Save and go back', right: [doneBtn] }));

    const body = h('div', { class: 'scr-body set-body' });
    const rail = h('nav', { class: 'set-rail', attrs: { role: 'tablist' } });
    const content = h('div', { class: 'set-content ui-panel ui-scroll' });
    body.append(rail, content);
    el.appendChild(body);

    const tabs: { id: Tab; label: string; icon: string; build: () => HTMLElement }[] = [
      { id: 'flight', label: 'Flight', icon: 'jet', build: buildFlight },
      { id: 'controls', label: 'Controls', icon: 'hand', build: buildControls },
      { id: 'audio', label: 'Audio', icon: 'sound', build: buildAudio },
      { id: 'display', label: 'Display', icon: 'display', build: buildDisplay },
    ];
    const railBtns = new Map<Tab, HTMLButtonElement>();
    const setTab = (t: Tab) => {
      tiltPreviewOff?.();
      tiltPreviewOff = null;
      for (const [id, b] of railBtns) {
        b.classList.toggle('is-on', id === t);
        b.setAttribute('aria-selected', String(id === t));
      }
      const def = tabs.find((x) => x.id === t)!;
      content.replaceChildren(def.build());
      content.scrollTop = 0;
    };
    for (const t of tabs) {
      const b = h('button', { class: 'set-tab', attrs: { type: 'button', role: 'tab' }, html: `${icon(t.icon)}<span>${t.label}</span>` });
      b.addEventListener('click', () => setTab(t.id));
      railBtns.set(t.id, b);
      rail.appendChild(b);
    }

    /* ───────── FLIGHT ───────── */
    function buildFlight(): HTMLElement {
      const page = h('div', { class: 'set-page' });
      page.appendChild(h('div', { class: 'set-h', text: 'Difficulty' }));
      if (opts.overlay) page.appendChild(h('div', { class: 'set-note', html: `${icon('info')}<span>A new difficulty applies from the next sortie (or RESTART).</span>` }));
      const grid = h('div', { class: 'diff-grid' });
      const cards: HTMLButtonElement[] = [];
      for (const id of Object.keys(DIFFICULTIES) as Difficulty[]) {
        const d = DIFFICULTIES[id];
        const c = h('button', {
          class: `diff-card diff-${id}`,
          attrs: { type: 'button', role: 'radio', 'aria-label': d.label },
          dataset: { id },
          html:
            `<div class="dc-head"><span class="dc-name">${escapeHtml(d.label)}</span><span class="dc-mult mono">×${d.scoreMultiplier}</span></div>` +
            `<div class="dc-desc">${escapeHtml(d.description)}</div>` +
            `<ul class="dc-facts">${difficultyFacts(d).map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>`,
        });
        c.addEventListener('click', () => {
          s.difficulty = id;
          sync();
        });
        cards.push(c);
        grid.appendChild(c);
      }
      const sync = () =>
        cards.forEach((c) => {
          const on = c.dataset.id === s.difficulty;
          c.classList.toggle('is-on', on);
          c.setAttribute('aria-checked', String(on));
        });
      sync();
      page.appendChild(grid);
      page.appendChild(settingRow('Hints', 'Tutorial prompts and contextual tips in flight', toggle(s.hints, (v) => (s.hints = v), 'Hints')));
      return page;
    }

    /* ───────── CONTROLS ───────── */
    function buildControls(): HTMLElement {
      const page = h('div', { class: 'set-page' });
      page.appendChild(h('div', { class: 'set-h', text: 'Steering' }));
      const tiltBox = h('div', { class: 'tilt-box' });
      const scheme = segmented(
        [
          { value: 'stick', label: 'Touch stick', icon: 'hand' },
          { value: 'tilt', label: 'Tilt', icon: 'phone' },
        ],
        s.controlScheme,
        async (v) => {
          if (v === 'tilt') {
            const ok = await TiltSource.requestPermission();
            if (!ok) {
              toast('Motion sensor access was denied — using the touch stick');
              scheme.set('stick');
              s.controlScheme = 'stick';
              return;
            }
          }
          s.controlScheme = v;
          renderTilt();
        },
      );
      page.appendChild(settingRow('Control scheme', 'Floating side-stick under your right thumb, or steer by tilting the phone', scheme, 'row-stack'));
      page.appendChild(tiltBox);

      const renderTilt = () => {
        tiltPreviewOff?.();
        tiltPreviewOff = null;
        tiltBox.replaceChildren();
        if (s.controlScheme !== 'tilt') return;
        const bubble = h('div', { class: 'tilt-bubble' }, h('i'));
        const cal = h('button', { class: 'ui-btn', attrs: { type: 'button' }, html: `${icon('target')}<span>Calibrate</span>` });
        const info = h('div', { class: 'tilt-info', text: 'Hold the phone the way you want to fly level, then tap Calibrate. The game also re-levels at the start of every mission.' });
        tiltBox.append(bubble, h('div', { class: 'tilt-side' }, info, cal));
        tiltBox.appendChild(settingRow('Tilt sensitivity', null, slider({ min: 0.25, max: 2, step: 0.05, value: s.tiltSensitivity, label: 'Tilt sensitivity', format: (v) => `${v.toFixed(2)}×`, onInput: (v) => (s.tiltSensitivity = v) })));
        // live preview
        const neutral: TiltCalibration = { ...DEFAULT_TILT_NEUTRAL };
        const ang: TiltAngles = { bank: 0, back: 0 };
        const axes = { roll: 0, pitch: 0 };
        let have = false;
        const dot = bubble.firstElementChild as HTMLElement;
        const onOri = (e: DeviceOrientationEvent) => {
          if (e.beta == null || e.gamma == null) return;
          tiltAngles(e.beta, e.gamma, screenAngle(), ang);
          if (!have) {
            have = true;
            bubble.classList.add('is-live');
          }
          tiltToAxes(ang, neutral, s.tiltSensitivity, s.invertPitch, axes);
          dot.style.transform = `translate(${(axes.roll * 34).toFixed(1)}px, ${(-axes.pitch * 34).toFixed(1)}px)`;
        };
        window.addEventListener('deviceorientation', onOri);
        tiltPreviewOff = () => window.removeEventListener('deviceorientation', onOri);
        cal.addEventListener('click', () => {
          neutral.bank = ang.bank;
          neutral.back = ang.back;
          window.dispatchEvent(new CustomEvent(RECENTER_TILT_EVENT));
          toast(have ? 'Tilt calibrated — this is now level flight' : 'Calibration saved (no motion sensor detected)');
        });
      };
      renderTilt();

      page.appendChild(
        settingRow('Stick sensitivity', 'Higher = shorter throw and a livelier centre', slider({ min: 0.25, max: 2, step: 0.05, value: s.stickSensitivity, label: 'Stick sensitivity', format: (v) => `${v.toFixed(2)}×`, onInput: (v) => (s.stickSensitivity = v) })),
      );
      page.appendChild(settingRow('Invert pitch', 'Off: pull the stick down (towards you) to climb, like a real jet', toggle(s.invertPitch, (v) => (s.invertPitch = v), 'Invert pitch')));
      page.appendChild(settingRow('Left-handed', 'Swap the stick and the throttle cluster', toggle(s.leftHanded, (v) => (s.leftHanded = v), 'Left-handed')));
      page.appendChild(settingRow('Haptics', 'Vibration on buttons, detents, hits and kills (Android)', toggle(s.haptics, (v) => (s.haptics = v), 'Haptics')));
      page.appendChild(h('div', { class: 'set-note', html: `${icon('gamepad')}<span>Keyboard and gamepads work too — press <b>H</b> in flight for the key list.</span>` }));
      return page;
    }

    /* ───────── AUDIO ───────── */
    function buildAudio(): HTMLElement {
      const page = h('div', { class: 'set-page' });
      page.appendChild(h('div', { class: 'set-h', text: 'Volume' }));
      const pct = (v: number) => `${Math.round(v * 100)}%`;
      page.appendChild(settingRow('Master', null, slider({ min: 0, max: 1, step: 0.05, value: s.masterVolume, label: 'Master volume', format: pct, onInput: (v) => (s.masterVolume = v) })));
      page.appendChild(settingRow('Effects', 'Engine, weapons, explosions, RWR tones', slider({ min: 0, max: 1, step: 0.05, value: s.sfxVolume, label: 'Effects volume', format: pct, onInput: (v) => (s.sfxVolume = v) })));
      page.appendChild(settingRow('Voice', 'Betty warnings, radio and AWACS calls', slider({ min: 0, max: 1, step: 0.05, value: s.voiceVolume, label: 'Voice volume', format: pct, onInput: (v) => (s.voiceVolume = v) })));
      // music has its own bus: silence it without losing the RWR / missile tones (Effects)
      page.appendChild(settingRow('Music', 'Menu theme and mission score — 0 turns it off', slider({ min: 0, max: 1, step: 0.05, value: s.musicVolume ?? 0.6, label: 'Music volume', format: (v) => (v <= 0 ? 'Off' : pct(v)), onInput: (v) => (s.musicVolume = v) })));
      page.appendChild(h('div', { class: 'set-note', html: `${icon('headphones')}<span>Headphones recommended — threat tones and missile warnings are directional.</span>` }));
      return page;
    }

    /* ───────── DISPLAY ───────── */
    function buildDisplay(): HTMLElement {
      const page = h('div', { class: 'set-page' });
      page.appendChild(h('div', { class: 'set-h', text: 'Helmet display' }));
      const sw = h('div', { class: 'hud-swatches', attrs: { role: 'radiogroup' } });
      const swBtns: HTMLButtonElement[] = [];
      for (const c of ['green', 'amber', 'cyan'] as const) {
        const b = h('button', {
          class: `hud-sw sw-${c}`,
          attrs: { type: 'button', role: 'radio', 'aria-label': `${c} symbology` },
          dataset: { c },
          html: `<svg viewBox="0 0 60 36" aria-hidden="true"><path d="M6 18h14M40 18h14M30 8v6M24 18a6 6 0 0 0 12 0" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="30" cy="18" r="2.2" fill="currentColor"/><text x="30" y="33" text-anchor="middle" font-size="7" fill="currentColor" font-family="monospace">450</text></svg><span>${c}</span>`,
        });
        b.addEventListener('click', () => {
          s.hudColor = c;
          swBtns.forEach((x) => x.classList.toggle('is-on', x.dataset.c === c));
        });
        b.classList.toggle('is-on', s.hudColor === c);
        swBtns.push(b);
        sw.appendChild(b);
      }
      page.appendChild(settingRow('Symbology colour', null, sw, 'row-stack'));
      page.appendChild(settingRow('Target camera', 'Small live view of your designated target (costs some frame rate)', toggle(s.targetCam, (v) => (s.targetCam = v), 'Target camera')));
      page.appendChild(settingRow('Field of view', 'Wider shows more; narrower makes targets bigger', slider({ min: 45, max: 90, step: 1, value: s.fov, label: 'Field of view', format: (v) => `${Math.round(v)}°`, onInput: (v) => (s.fov = v) })));
      page.appendChild(
        settingRow(
          'Default view',
          'Camera when a mission starts (CAM button cycles views)',
          segmented(
            [
              { value: 'cockpit', label: 'Cockpit' },
              { value: 'hud', label: 'HMD only' },
              { value: 'chase', label: 'Chase' },
            ],
            s.defaultView,
            (v) => (s.defaultView = v),
          ),
          'row-stack',
        ),
      );
      page.appendChild(h('div', { class: 'set-h', text: 'Performance' }));
      page.appendChild(
        settingRow(
          'Graphics quality',
          'Auto picks a level for your device. Lower = cooler phone, longer battery',
          segmented(
            [
              { value: 'auto', label: 'Auto' },
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
            ],
            s.quality,
            (v) => (s.quality = v),
          ),
          'row-stack',
        ),
      );
      page.appendChild(settingRow('FPS counter', 'Frame rate, draw calls and triangles', toggle(s.showFps, (v) => (s.showFps = v), 'FPS counter')));
      return page;
    }

    setTab('flight');
    host.present(el, { bg: !opts.overlay, back: finish, focus: doneBtn });
  });
}
