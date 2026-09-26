/**
 * F35-A touch controls — floating virtual side-stick.
 *
 * A touch anywhere in the stick zone becomes the stick centre; dragging deflects the knob (clamped to
 * the travel circle). Output axes are shaped by curves.shapeStick (deadzone + square gate + expo).
 * On release the knob springs back (CSS transition) and the axes return to neutral quickly.
 * Pointer routing is done by the TouchLayer surface; this class is visuals + maths.
 */
import { clampToCircle, lowPass, shapeStick, stickShapeFor, type StickShape, type Vec2 } from '../curves';

export class VirtualStick {
  readonly el: HTMLDivElement;
  private readonly knob: HTMLDivElement;
  private readonly ring: HTMLDivElement;
  pointerId: number | null = null;
  /** Shaped axes (what the jet gets). */
  roll = 0;
  pitch = 0;
  private targetRoll = 0;
  private targetPitch = 0;
  private cx = 0;
  private cy = 0;
  private homeX = 0;
  private homeY = 0;
  private shape: StickShape = stickShapeFor(1);
  private scale = 1;
  private sensitivity = 1;
  private invert = false;
  private readonly off: Vec2 = { x: 0, y: 0 };
  private readonly axes = { roll: 0, pitch: 0 };
  private bounds = { w: 844, h: 390 };

  constructor(parent: HTMLElement) {
    const el = document.createElement('div');
    el.className = 'ctl-stick';
    el.setAttribute('aria-hidden', 'true');
    const ring = document.createElement('div');
    ring.className = 'ctl-stick-ring';
    const knob = document.createElement('div');
    knob.className = 'ctl-stick-knob';
    el.append(ring, knob);
    parent.appendChild(el);
    this.el = el;
    this.ring = ring;
    this.knob = knob;
  }

  configure(sensitivity: number, invertPitch: boolean, scale: number): void {
    this.sensitivity = sensitivity;
    this.invert = invertPitch;
    this.scale = scale;
    this.shape = stickShapeFor(sensitivity, scale);
    const d = Math.round(this.shape.radius * 2 + 34 * scale);
    this.el.style.width = this.el.style.height = `${d}px`;
    this.el.style.marginLeft = this.el.style.marginTop = `${-d / 2}px`;
    const k = Math.round(58 * scale);
    this.knob.style.width = this.knob.style.height = `${k}px`;
    this.knob.style.marginLeft = this.knob.style.marginTop = `${-k / 2}px`;
    this.ring.style.inset = `${Math.round(17 * scale)}px`;
  }

  setHome(x: number, y: number, w: number, h: number): void {
    this.homeX = x;
    this.homeY = y;
    this.bounds.w = w;
    this.bounds.h = h;
    if (this.pointerId === null) this.moveBase(x, y);
  }

  get active(): boolean {
    return this.pointerId !== null;
  }

  start(pointerId: number, x: number, y: number): void {
    this.pointerId = pointerId;
    // keep the whole base on screen so full deflection is always reachable
    const r = this.shape.radius + 8;
    this.cx = Math.min(this.bounds.w - r * 0.5, Math.max(r * 0.5, x));
    this.cy = Math.min(this.bounds.h - r * 0.35, Math.max(r * 0.5, y));
    this.moveBase(this.cx, this.cy);
    this.el.classList.add('is-active');
    this.knob.style.transition = 'none';
    this.move(x, y);
  }

  move(x: number, y: number): void {
    clampToCircle(x - this.cx, y - this.cy, this.shape.radius, this.off);
    this.knob.style.transform = `translate3d(${this.off.x.toFixed(1)}px, ${this.off.y.toFixed(1)}px, 0)`;
    shapeStick(x - this.cx, y - this.cy, this.shape, this.invert, this.axes);
    this.targetRoll = this.axes.roll;
    this.targetPitch = this.axes.pitch;
    // react instantly while the finger is down
    this.roll = this.targetRoll;
    this.pitch = this.targetPitch;
    const m = Math.min(1, Math.hypot(this.off.x, this.off.y) / this.shape.radius);
    this.ring.style.opacity = (0.35 + 0.65 * m).toFixed(2);
  }

  end(): void {
    this.pointerId = null;
    this.targetRoll = 0;
    this.targetPitch = 0;
    this.el.classList.remove('is-active');
    this.knob.style.transition = '';
    this.knob.style.transform = 'translate3d(0,0,0)';
    this.ring.style.opacity = '';
    this.moveBase(this.homeX, this.homeY);
  }

  /** Spring the axes back to centre after release. */
  update(dt: number): void {
    if (this.pointerId !== null) return;
    this.roll = lowPass(this.roll, this.targetRoll, dt, 0.035);
    this.pitch = lowPass(this.pitch, this.targetPitch, dt, 0.035);
    if (Math.abs(this.roll) < 1e-3) this.roll = 0;
    if (Math.abs(this.pitch) < 1e-3) this.pitch = 0;
  }

  reset(): void {
    this.end();
    this.roll = this.pitch = 0;
  }

  setVisible(v: boolean): void {
    this.el.style.display = v ? '' : 'none';
    if (!v) this.reset();
  }

  private moveBase(x: number, y: number): void {
    this.el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  }

  get sens(): number {
    return this.sensitivity;
  }

  get uiScale(): number {
    return this.scale;
  }
}
