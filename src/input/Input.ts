/**
 * F35-A — player input (UI/INPUT module). Exports `createInput` (see core/contracts.ts InputApi).
 *
 * Sources, merged every frame into one ControlInput:
 *   touch   — floating side-stick, throttle lever with AB detent, thumb buttons, look/tap surface
 *             (src/input/touch/*)
 *   tilt    — DeviceOrientation steering, calibrated & landscape aware (tilt.ts, tiltMath.ts)
 *   keyboard — desktop flying (keyboard.ts)
 *   gamepad — standard-mapping pads (gamepad.ts)
 * The throttle is a persistent lever shared by all sources; stick axes are summed and clamped.
 *
 * Also listens for window CustomEvents from the settings screen:
 *   'f35a:recenter-tilt'  → make the current pose neutral (starts tilt sensing if needed)
 */
import type { CreateInput, FrameContext, InputApi, InputCommand } from '../core/contracts';
import { WEAPON_INFO } from '../core/data';
import type { CameraMode, Settings, WeaponId } from '../core/types';
import { neutralControls } from '../core/types';
import { clamp } from './curves';
import { GamepadSource } from './gamepad';
import { Haptics } from './haptics';
import { KeyboardSource } from './keyboard';
import { TiltSource } from './tilt';
import { TouchLayer } from './touch/TouchLayer';

import { RECENTER_TILT_EVENT } from './shared';

const KEY_LEGEND: [string, string][] = [
  ['↑↓ / W S', 'Pitch'],
  ['←→ / A D', 'Roll'],
  ['Q  E', 'Rudder'],
  ['Shift / Ctrl', 'Throttle'],
  ['Tab', 'MIL ↔ AB'],
  ['Space', 'Gun'],
  ['Enter / B', 'Fire weapon'],
  ['X', 'Flares + chaff'],
  ['N  T', 'Weapon / target'],
  ['V', 'Radar (EMCON)'],
  ['C  L', 'Camera / padlock'],
  ['Mouse drag', 'Look around'],
  ['P / Esc', 'Pause'],
  ['H', 'This help'],
];

export const createInput: CreateInput = (root, initialSettings) => {
  const controls = neutralControls();
  const handlers = new Map<InputCommand, Set<() => void>>();
  const haptics = new Haptics();
  let settings: Settings = { ...initialSettings };
  let enabled = false;
  let disabledAt = -1e9;
  /** Seconds flown since the controls were last enabled. */
  let enabledFor = 0;
  /**
   * Tilt selected but no orientation data (sensor missing / permission denied): after a short grace
   * period the touch stick comes back so the jet is never uncontrollable.
   */
  let tiltFallback = false;

  const emit = (cmd: InputCommand): void => {
    if (!enabled && cmd !== 'recenterTilt') return;
    const set = handlers.get(cmd);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        fn();
      } catch (err) {
        console.error(`[input] handler for ${cmd} threw`, err);
      }
    }
  };

  const touch = new TouchLayer(root, haptics, emit);
  const keyboard = new KeyboardSource(emit, () => enabled);
  const gamepad = new GamepadSource(emit);
  const tilt = new TiltSource();
  keyboard.start();

  // Desktop keyboard legend
  const legend = document.createElement('div');
  legend.className = 'ctl-keys';
  legend.setAttribute('aria-hidden', 'true');
  legend.innerHTML =
    `<div class="k-title">KEYBOARD</div>` + KEY_LEGEND.map(([k, v]) => `<b>${k}</b><span>${v}</span>`).join('');
  touch.el.appendChild(legend);
  let legendTimer = 0;
  const showLegend = (seconds: number) => {
    legend.classList.add('is-shown');
    window.clearTimeout(legendTimer);
    legendTimer = window.setTimeout(() => legend.classList.remove('is-shown'), seconds * 1000);
  };
  const onHelpKey = (e: KeyboardEvent) => {
    if (!enabled || e.repeat) return;
    if (e.code === 'KeyH' || e.code === 'F1') {
      e.preventDefault();
      if (legend.classList.contains('is-shown')) legend.classList.remove('is-shown');
      else showLegend(12);
    }
  };
  window.addEventListener('keydown', onHelpKey);

  const coarse = typeof matchMedia === 'function' && (matchMedia('(pointer: coarse)').matches || matchMedia('(any-pointer: coarse)').matches);
  const touchVisible = () => coarse || touch.touched;
  let touchShown: boolean | null = null;

  const onRecenterEvent = () => {
    tilt.start();
    tilt.recenter();
  };
  window.addEventListener(RECENTER_TILT_EVENT, onRecenterEvent);

  const configureTouch = () => {
    const s = settings;
    const tiltUi = s.controlScheme === 'tilt' && !tiltFallback;
    touch.configure({ tilt: tiltUi, leftHanded: s.leftHanded, fov: s.fov, sensitivity: s.stickSensitivity, invertPitch: s.invertPitch, hudColor: s.hudColor });
  };

  const applySettings = (s: Settings) => {
    settings = { ...s };
    haptics.enabled = s.haptics;
    const isTilt = s.controlScheme === 'tilt';
    tiltFallback = false;
    configureTouch();
    tilt.configure(s.tiltSensitivity, s.invertPitch);
    if (isTilt) tilt.start();
    else tilt.stop();
  };
  applySettings(settings);
  touch.el.classList.add('is-disabled');

  const neutralise = () => {
    controls.pitch = controls.roll = controls.yaw = 0;
    controls.fireGun = controls.fireWeapon = controls.flare = controls.chaff = controls.airbrake = false;
  };

  const lookOut = { yaw: 0, pitch: 0 };
  const tapOut: { x: number; y: number }[] = [];

  /** Last values pushed to the button labels (numbers compared first, so no per-frame strings). */
  const shown = { weapon: '' as WeaponId | '', count: -1, gun: -1, flares: -1, chaff: -1, emitting: -1, tgt: -1 };

  let deadShown: boolean | null = null;
  const updateLabels = (ctx: FrameContext) => {
    const p = ctx.player;
    const dead = !p || !p.alive;
    if (dead !== deadShown) {
      deadShown = dead;
      touch.el.classList.toggle('is-dead', dead);
    }
    touch.setCameraLabel(ctx.viewMode as CameraMode);
    if (!p || !ctx.world) return;
    const w = p.selectedWeapon;
    const n = w === 'gun' ? p.gunAmmo : ctx.world.combat.remaining(p, w);
    if (w !== shown.weapon || n !== shown.count) {
      const changedWeapon = shown.weapon !== '' && w !== shown.weapon;
      shown.weapon = w;
      shown.count = n;
      const label = w === 'gun' ? 'GUN' : WEAPON_INFO[w]?.short ?? String(w).toUpperCase();
      const sub = w === 'gun' ? String(n) : `×${n}`;
      touch.fire.setLabel(label, sub);
      touch.fire.setDisabled(n <= 0);
      touch.fire.el.setAttribute('aria-label', `Fire ${label} ${sub}`);
      if (changedWeapon) {
        // brief flash so the new selection is noticed
        touch.fire.el.classList.add('is-long');
        window.setTimeout(() => touch.fire.el.classList.remove('is-long'), 180);
      }
    }
    if (p.gunAmmo !== shown.gun) {
      shown.gun = p.gunAmmo;
      touch.gun.setLabel('GUN', String(p.gunAmmo));
      touch.gun.setDisabled(p.gunAmmo <= 0);
    }
    if (p.flares !== shown.flares || p.chaff !== shown.chaff) {
      shown.flares = p.flares;
      shown.chaff = p.chaff;
      touch.cms.setLabel('CMS', `F${p.flares}·C${p.chaff}`);
      touch.cms.setDisabled(p.flares <= 0 && p.chaff <= 0);
    }
    const emitting = p.radar.emitting ? 1 : 0;
    if (emitting !== shown.emitting) {
      shown.emitting = emitting;
      touch.radar.setLabel('RDR', emitting ? 'ON' : 'EMCON');
      touch.radar.setActive(!!emitting);
      touch.radar.el.classList.toggle('is-emcon', !emitting);
    }
    const tgt = p.radar.lockedId != null ? 2 : p.radar.designatedId != null ? 1 : 0;
    if (tgt !== shown.tgt) {
      shown.tgt = tgt;
      touch.tgt.setLabel('TGT', tgt === 2 ? 'LOCK' : tgt === 1 ? 'NEXT' : 'SEL');
      touch.tgt.setActive(tgt === 2);
    }
  };

  const api: InputApi = {
    controls,

    get touchShown() {
      return touchShown === true;
    },
    get activeScheme() {
      return settings.controlScheme === 'tilt' && !tiltFallback ? 'tilt' : 'stick';
    },

    update(dt, ctx) {
      const sc = ctx.screen;
      touch.relayout(sc.width, sc.height, sc.safe);
      const tv = touchVisible();
      if (tv !== touchShown) {
        touchShown = tv;
        touch.el.dataset.touch = tv ? '1' : '0';
      }

      if (!enabled || ctx.paused) {
        neutralise();
        return;
      }

      touch.update(dt);
      enabledFor += dt;
      let isTilt = settings.controlScheme === 'tilt';
      if (isTilt) {
        tilt.update(dt);
        const wantFallback = !tilt.hasData && enabledFor > 1.5;
        if (wantFallback !== tiltFallback) {
          tiltFallback = wantFallback;
          configureTouch();
        }
        if (tiltFallback) isTilt = false;
      }

      // ── throttle: lever (authoritative while held) → keyboard → gamepad ──
      let t = controls.throttle;
      if (touch.throttle.changed) {
        touch.throttle.changed = false;
        t = touch.throttle.value;
      }
      t = keyboard.update(dt, t);
      t = gamepad.update(dt, t, true);
      controls.throttle = t;
      touch.throttle.sync(t);

      // ── axes ──
      const sp = isTilt ? tilt.pitch : touch.stick.pitch;
      const sr = isTilt ? tilt.roll : touch.stick.roll;
      controls.pitch = clamp(sp + keyboard.pitch + gamepad.pitch, -1, 1);
      controls.roll = clamp(sr + keyboard.roll + gamepad.roll, -1, 1);
      controls.yaw = clamp(keyboard.yaw + gamepad.yaw, -1, 1);

      // ── triggers ──
      const gunSelected = ctx.player?.selectedWeapon === 'gun';
      const firePressed = touch.fire.pressed || keyboard.weapon || gamepad.weapon;
      controls.fireWeapon = firePressed;
      controls.fireGun = touch.gun.pressed || keyboard.gun || gamepad.gun || (gunSelected && firePressed);
      const cms = touch.cms.pressed || keyboard.cms || gamepad.cms;
      controls.flare = cms;
      controls.chaff = cms;
      // throttle at the idle stop also deploys the speed brake (no dedicated touch button needed)
      controls.airbrake = keyboard.airbrake || t <= 0.001;

      // ── gamepad look ──
      if (gamepad.lookYaw || gamepad.lookPitch) {
        touch.lookYaw += gamepad.lookYaw;
        touch.lookPitch += gamepad.lookPitch;
      }

      updateLabels(ctx);
    },

    on(cmd, fn) {
      let set = handlers.get(cmd);
      if (!set) handlers.set(cmd, (set = new Set()));
      set.add(fn);
      return () => {
        set!.delete(fn);
      };
    },

    consumeLook() {
      lookOut.yaw = touch.lookYaw;
      lookOut.pitch = touch.lookPitch;
      touch.lookYaw = 0;
      touch.lookPitch = 0;
      return lookOut;
    },

    consumeTaps() {
      tapOut.length = 0;
      for (const t of touch.taps) tapOut.push(t);
      touch.taps.length = 0;
      return tapOut;
    },

    setEnabled(e) {
      if (e === enabled) return;
      enabled = e;
      touch.el.classList.toggle('is-disabled', !e);
      if (!e) {
        disabledAt = performance.now();
        touch.releaseAll();
        keyboard.clear();
        neutralise();
        legend.classList.remove('is-shown');
        return;
      }
      shown.weapon = '';
      shown.count = shown.gun = shown.flares = shown.chaff = shown.emitting = shown.tgt = -1;
      enabledFor = 0;
      const fresh = performance.now() - disabledAt > 5000;
      // a new mission: re-level the tilt neutral to however the phone is held right now
      if (fresh && settings.controlScheme === 'tilt') tilt.recenter();
      if (fresh && !touchVisible() && settings.hints) showLegend(10);
    },

    setThrottle(v) {
      controls.throttle = clamp(v, 0, 1);
      touch.throttle.sync(controls.throttle);
    },

    applySettings,

    async requestMotionPermission() {
      const ok = await TiltSource.requestPermission();
      if (ok && settings.controlScheme === 'tilt') tilt.start();
      return ok;
    },

    recenterTilt() {
      tilt.recenter();
      haptics.detent();
      touch.recenter.el.classList.add('is-long');
      window.setTimeout(() => touch.recenter.el.classList.remove('is-long'), 260);
    },

    dispose() {
      keyboard.stop();
      tilt.stop();
      touch.releaseAll();
      window.removeEventListener('keydown', onHelpKey);
      window.removeEventListener(RECENTER_TILT_EVENT, onRecenterEvent);
      window.clearTimeout(legendTimer);
      touch.el.remove();
      handlers.clear();
    },
  };
  return api;
};
