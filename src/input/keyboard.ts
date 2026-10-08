/**
 * F35-A input — keyboard (desktop).
 *
 *   Pitch/roll   Arrows or WASD (↑/W = nose down, ↓/S = pull up)      Yaw  Q / E
 *   Throttle     Shift / R = up, Ctrl / F = down (stops at MIL — press again for AB), Tab = MIL ↔ MAX AB
 *   Gun          Space            Weapon release   Enter / B          Flares + chaff   X
 *   Weapon       1 / N (cycle)    Target           T                  Camera           C (L = padlock, M = missile cam)
 *   Radar        V (EMCON)        Look reset       Home / Numpad5     Pause            P / Esc
 *   Speed brake  Z               Recenter tilt    K                  Civil traffic  I (show / hide CIV)
 * Axes ramp smoothly (no bang-bang inputs) and return to centre faster than they deflect.
 */
import type { InputCommand } from '../core/contracts';
import { AB_DETENT } from '../core/types';
import { clamp, throttleToggle } from './curves';

const COMMAND_KEYS: Record<string, InputCommand> = {
  KeyC: 'camera',
  KeyP: 'pause',
  Escape: 'pause',
  KeyN: 'cycleWeapon',
  Digit1: 'cycleWeapon',
  KeyT: 'cycleTarget',
  KeyV: 'radar',
  Home: 'lookReset',
  Numpad5: 'lookReset',
  KeyL: 'padlock',
  KeyM: 'missileCam',
  KeyK: 'recenterTilt',
  KeyI: 'civilTraffic',
};

/** Keys whose default browser action we suppress while flying. */
const PREVENT = new Set(['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter']);

export class KeyboardSource {
  pitch = 0;
  roll = 0;
  yaw = 0;
  gun = false;
  weapon = false;
  cms = false;
  airbrake = false;
  /** Any key touched since start (used to hide touch controls on desktop). */
  used = false;
  private readonly keys = new Set<string>();
  /** The MIL→AB gate was opened by a fresh throttle-up press while sitting on the detent. */
  private gateOpen = false;
  private lastThrottle = 0.75;
  private listening = false;

  constructor(
    private readonly onCommand: (cmd: InputCommand) => void,
    private readonly isEnabled: () => boolean,
  ) {}

  start(): void {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener('keydown', this.down);
    window.addEventListener('keyup', this.up);
    window.addEventListener('blur', this.clear);
  }

  stop(): void {
    this.listening = false;
    window.removeEventListener('keydown', this.down);
    window.removeEventListener('keyup', this.up);
    window.removeEventListener('blur', this.clear);
    this.clear();
  }

  clear = (): void => {
    this.keys.clear();
    this.pitch = this.roll = this.yaw = 0;
    this.gun = this.weapon = this.cms = this.airbrake = false;
  };

  /** Pending one-shot throttle action for Input (Tab toggle). */
  toggleAb = false;

  /**
   * Advance axes and return the new throttle given the current one.
   */
  update(dt: number, throttle: number): number {
    const k = this.keys;
    const tp = (k.has('ArrowDown') || k.has('KeyS') ? 1 : 0) - (k.has('ArrowUp') || k.has('KeyW') ? 1 : 0);
    const tr = (k.has('ArrowRight') || k.has('KeyD') ? 1 : 0) - (k.has('ArrowLeft') || k.has('KeyA') ? 1 : 0);
    const ty = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
    this.pitch = ramp(this.pitch, tp, dt);
    this.roll = ramp(this.roll, tr, dt);
    this.yaw = ramp(this.yaw, ty, dt);
    this.gun = k.has('Space');
    this.weapon = k.has('Enter') || k.has('NumpadEnter') || k.has('KeyB');
    this.cms = k.has('KeyX');
    this.airbrake = k.has('KeyZ');

    let t = throttle;
    if (this.toggleAb) {
      this.toggleAb = false;
      t = throttleToggle(t);
    }
    const up = k.has('ShiftLeft') || k.has('ShiftRight') || k.has('KeyR') || k.has('PageUp');
    const dn = k.has('ControlLeft') || k.has('ControlRight') || k.has('KeyF') || k.has('PageDown');
    if (up && !dn) {
      const next = t + dt * 0.45;
      // stop at the MIL detent; a fresh press while sitting on it pushes through into AB
      t = t <= AB_DETENT && next > AB_DETENT && !this.gateOpen ? AB_DETENT : next;
    } else if (dn && !up) {
      t -= dt * 0.45;
    }
    if (t < AB_DETENT - 0.01) this.gateOpen = false;
    t = clamp(t, 0, 1);
    this.lastThrottle = t;
    return t;
  }

  private down = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
    if (!this.isEnabled()) return;
    this.used = true;
    if (PREVENT.has(e.code)) e.preventDefault();
    const fresh = !this.keys.has(e.code) && !e.repeat;
    this.keys.add(e.code);
    if (!fresh) return;
    if (e.code === 'Tab') this.toggleAb = true;
    // a fresh throttle-up press while sitting on the detent opens the gate into AB
    if ((e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code === 'KeyR' || e.code === 'PageUp') && Math.abs(this.lastThrottle - AB_DETENT) < 2e-3) {
      this.gateOpen = true;
    }
    const cmd = COMMAND_KEYS[e.code];
    if (cmd) this.onCommand(cmd);
  };

  private up = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };
}

function ramp(v: number, target: number, dt: number): number {
  const rate = target === 0 || Math.sign(target) !== Math.sign(v) ? 7 : 3.2;
  const d = target - v;
  const step = rate * dt;
  return Math.abs(d) <= step ? target : v + Math.sign(d) * step;
}
