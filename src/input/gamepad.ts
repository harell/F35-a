/**
 * F35-A input — Gamepad API ("standard" mapping, e.g. Xbox / PlayStation pads).
 *
 *   Left stick   pitch / roll            Right stick   look around (rate)
 *   RT / LT      throttle up / down      L3            MIL ↔ MAX AB
 *   A / Cross    weapon release          B / Circle    flares + chaff
 *   X / Square   gun (hold)              Y / Triangle  camera (hold = padlock)
 *   LB / RB      weapon / target cycle   D-pad ←/→     rudder, ↑ padlock, ↓ missile cam
 *   Back/Select  radar (EMCON)           Start         pause          R3  look reset
 */
import type { InputCommand } from '../core/contracts';
import { clamp, expo, throttleToggle } from './curves';

const DEADZONE = 0.14;

function axis(v: number | undefined): number {
  if (v === undefined || Math.abs(v) < DEADZONE) return 0;
  const s = (Math.abs(v) - DEADZONE) / (1 - DEADZONE);
  return expo(Math.sign(v) * Math.min(1, s), 0.35);
}

const btn = (p: Gamepad, i: number): number => {
  const b = p.buttons[i];
  return b ? (typeof b === 'object' ? b.value || (b.pressed ? 1 : 0) : Number(b)) : 0;
};

export class GamepadSource {
  pitch = 0;
  roll = 0;
  yaw = 0;
  gun = false;
  weapon = false;
  cms = false;
  lookYaw = 0;
  lookPitch = 0;
  connected = false;
  /** Button states (reused arrays — no per-frame allocation). */
  private readonly prev: boolean[] = new Array(20).fill(false);
  private readonly pressed: boolean[] = new Array(20).fill(false);
  private yHeld = 0;
  private yLong = false;
  /** Pads only become visible after 'gamepadconnected'; until then we don't poll at all (phones). */
  private known = 0;

  constructor(
    private readonly onCommand: (cmd: InputCommand) => void,
  ) {
    if (typeof window !== 'undefined') {
      window.addEventListener('gamepadconnected', () => this.known++);
      window.addEventListener('gamepaddisconnected', () => (this.known = Math.max(0, this.known - 1)));
    }
  }

  /** Rising edge of a button since the last poll (bound once — no per-frame closure). */
  private readonly edge = (i: number): boolean => this.pressed[i] && !this.prev[i];

  private snapshot(p: Gamepad): void {
    for (let i = 0; i < this.pressed.length; i++) this.pressed[i] = !!p.buttons[i]?.pressed;
  }

  /** Poll the first connected standard pad; returns the new throttle. */
  update(dt: number, throttle: number, enabled: boolean): number {
    this.lookYaw = this.lookPitch = 0;
    let p: Gamepad | null = null;
    if (this.known > 0 && typeof navigator !== 'undefined' && navigator.getGamepads) {
      for (const g of navigator.getGamepads()) {
        if (g && g.connected) {
          p = g;
          break;
        }
      }
    }
    this.connected = !!p;
    if (!p || !enabled) {
      this.pitch = this.roll = this.yaw = 0;
      this.gun = this.weapon = this.cms = false;
      if (p) {
        this.snapshot(p);
        for (let i = 0; i < this.prev.length; i++) this.prev[i] = this.pressed[i];
      }
      return throttle;
    }
    this.roll = axis(p.axes[0]);
    this.pitch = axis(p.axes[1]); // stick back (+) = pull = nose up
    const rx = axis(p.axes[2]);
    const ry = axis(p.axes[3]);
    this.lookYaw = rx * 2.4 * dt;
    this.lookPitch = -ry * 1.8 * dt;
    this.yaw = (btn(p, 15) > 0.5 ? 1 : 0) - (btn(p, 14) > 0.5 ? 1 : 0);
    this.weapon = btn(p, 0) > 0.5;
    this.cms = btn(p, 1) > 0.5;
    this.gun = btn(p, 2) > 0.5;

    let t = throttle + (btn(p, 7) - btn(p, 6)) * dt * 0.5;

    this.snapshot(p);
    const pressed = this.pressed;
    const prev = this.prev;
    const edge = this.edge;
    if (edge(10)) t = throttleToggle(t);
    if (edge(4)) this.onCommand('cycleWeapon');
    if (edge(5)) this.onCommand('cycleTarget');
    if (edge(8)) this.onCommand('radar');
    if (edge(9)) this.onCommand('pause');
    if (edge(11)) this.onCommand('lookReset');
    if (edge(12)) this.onCommand('padlock');
    if (edge(13)) this.onCommand('missileCam');
    // Y: tap = camera, hold = padlock
    if (pressed[3]) {
      this.yHeld += dt;
      if (this.yHeld > 0.5 && !this.yLong) {
        this.yLong = true;
        this.onCommand('padlock');
      }
    } else {
      if (prev[3] && !this.yLong) this.onCommand('camera');
      this.yHeld = 0;
      this.yLong = false;
    }
    for (let i = 0; i < prev.length; i++) prev[i] = pressed[i];
    return clamp(t, 0, 1);
  }
}
