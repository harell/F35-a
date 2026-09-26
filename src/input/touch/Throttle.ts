/**
 * F35-A touch controls — throttle lever (left thumb by default).
 *
 * Relative drag (grab anywhere on the lever, slide 1:1), persistent position, IDLE → MIL → detent
 * gate → AB zone (see curves.leverToThrottle). A haptic tick marks the detent and the idle stop.
 * Quick double-tap toggles MIL ↔ MAX AB. The handle shows the throttle % (or "AB").
 */
import { AB_DETENT } from '../../core/types';
import { LEVER_AB, LEVER_MIL, clamp, leverToThrottle, throttleToLever, throttleToggle, throttleZone, type ThrottleZone } from '../curves';
import { GESTURES, classifyGesture, isDoubleTap, type TapRecord } from '../gestures';
import type { Haptics } from '../haptics';
import type { Rect } from './layout';

export class ThrottleLever {
  readonly el: HTMLDivElement;
  private readonly handle: HTMLDivElement;
  private readonly readout: HTMLSpanElement;
  private readonly fill: HTMLDivElement;
  private pointerId: number | null = null;
  private startY = 0;
  private startX = 0;
  private startLever = 0;
  private startT = 0;
  private lever = throttleToLever(0.75);
  private travel = 100;
  private handleH = 30;
  private lastTap: TapRecord | null = null;
  private zone: ThrottleZone = 'dry';
  private lastText = '';
  /** Current throttle 0..1 (authoritative while dragging, else mirrors the shared value). */
  value = 0.75;
  /** Set when the user moved the lever this frame (Input copies it into the shared throttle). */
  changed = false;

  constructor(parent: HTMLElement, private readonly haptics: Haptics) {
    const el = document.createElement('div');
    el.className = 'ctl-throttle';
    el.setAttribute('role', 'slider');
    el.setAttribute('aria-label', 'Throttle');
    el.setAttribute('aria-valuemin', '0');
    el.setAttribute('aria-valuemax', '100');
    el.innerHTML = `
      <div class="thr-track">
        <div class="thr-fill"></div>
        <div class="thr-ab"><span>AB</span></div>
        <div class="thr-gate"></div>
        <span class="thr-mark thr-mil">MIL</span>
        <span class="thr-mark thr-idle">IDLE</span>
      </div>
      <div class="thr-handle"><span class="thr-val">75</span></div>`;
    parent.appendChild(el);
    this.el = el;
    this.handle = el.querySelector('.thr-handle') as HTMLDivElement;
    this.readout = el.querySelector('.thr-val') as HTMLSpanElement;
    this.fill = el.querySelector('.thr-fill') as HTMLDivElement;

    el.addEventListener('pointerdown', this.down);
    el.addEventListener('pointermove', this.moveEv);
    el.addEventListener('pointerup', this.up);
    el.addEventListener('pointercancel', this.up);
    el.addEventListener('lostpointercapture', this.up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  place(rc: Rect, scale: number): void {
    const st = this.el.style;
    st.left = `${rc.x}px`;
    st.top = `${rc.y}px`;
    st.width = `${rc.w}px`;
    st.height = `${rc.h}px`;
    this.handleH = Math.round(30 * scale);
    this.handle.style.height = `${this.handleH}px`;
    this.travel = Math.max(40, rc.h - this.handleH - 8);
    const track = this.el.querySelector('.thr-track') as HTMLDivElement;
    const pad = 4 + this.handleH / 2;
    track.style.top = `${pad}px`;
    track.style.bottom = `${pad}px`;
    // AB zone + gate positions along the track (percent from the bottom)
    (this.el.querySelector('.thr-ab') as HTMLDivElement).style.height = `${((1 - LEVER_AB) * 100).toFixed(1)}%`;
    const gate = this.el.querySelector('.thr-gate') as HTMLDivElement;
    gate.style.bottom = `${(LEVER_MIL * 100).toFixed(1)}%`;
    gate.style.height = `${((LEVER_AB - LEVER_MIL) * 100).toFixed(1)}%`;
    (this.el.querySelector('.thr-mil') as HTMLSpanElement).style.bottom = `${(LEVER_MIL * 100).toFixed(1)}%`;
    this.render();
  }

  get dragging(): boolean {
    return this.pointerId !== null;
  }

  /** Mirror an externally changed throttle (keyboard, gamepad, setThrottle) when not held. */
  sync(throttle: number): void {
    if (this.pointerId !== null) return;
    if (Math.abs(throttle - this.value) < 1e-4) return;
    this.value = throttle;
    this.lever = throttleToLever(throttle);
    this.zone = throttleZone(throttle);
    this.render();
  }

  release(): void {
    if (this.pointerId !== null) {
      try {
        this.el.releasePointerCapture(this.pointerId);
      } catch {
        /* ignore */
      }
    }
    this.pointerId = null;
    this.el.classList.remove('is-down');
  }

  private down = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    if (this.pointerId !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.pointerId = e.pointerId;
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.startLever = this.lever;
    this.startT = e.timeStamp;
    this.el.classList.add('is-down');
  };

  private moveEv = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    e.preventDefault();
    const lever = clamp(this.startLever + (this.startY - e.clientY) / this.travel, 0, 1);
    this.setLever(lever);
  };

  private up = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    // event timestamps (not handler time) so a slow frame can't turn a double-tap into two taps
    const now = e.timeStamp;
    const kind = classifyGesture(e.clientX - this.startX, e.clientY - this.startY, now - this.startT, true);
    this.release();
    if (kind === 'tap') {
      const tap = { x: e.clientX, y: e.clientY, t: now };
      if (isDoubleTap(this.lastTap, tap, GESTURES)) {
        this.lastTap = null;
        const t = throttleToggle(this.value);
        this.value = t;
        this.lever = throttleToLever(t);
        this.changed = true;
        this.zone = throttleZone(t);
        if (t > AB_DETENT) this.haptics.bump();
        else this.haptics.detent();
        this.el.classList.add('is-snap');
        window.setTimeout(() => this.el.classList.remove('is-snap'), 220);
        this.render();
      } else {
        this.lastTap = tap;
      }
    }
  };

  private setLever(lever: number): void {
    this.lever = lever;
    const t = leverToThrottle(lever);
    const z = throttleZone(t);
    if (z !== this.zone) {
      // tick when crossing the MIL/AB gate or hitting the idle stop
      if (z === 'ab' || this.zone === 'ab' || z === 'idle') this.haptics.detent();
      this.zone = z;
    }
    if (t !== this.value) {
      this.value = t;
      this.changed = true;
    }
    this.render();
  }

  /** Visual lever position: inside the detent gate the handle "sticks" near MIL (resistance). */
  private visualLever(): number {
    const l = this.lever;
    if (l > LEVER_MIL && l < LEVER_AB) return LEVER_MIL + (l - LEVER_MIL) * 0.3;
    return l;
  }

  private render(): void {
    const v = this.visualLever();
    const y = (1 - v) * this.travel + 4;
    this.handle.style.transform = `translate3d(0, ${y.toFixed(1)}px, 0)`;
    this.fill.style.transform = `scaleY(${v.toFixed(3)})`;
    const ab = this.zone === 'ab';
    const text = ab ? `AB${Math.max(1, Math.min(5, Math.ceil(((this.value - AB_DETENT) / (1 - AB_DETENT)) * 5)))}` : this.zone === 'mil' ? 'MIL' : this.zone === 'idle' ? 'IDLE' : String(Math.round((this.value / AB_DETENT) * 100));
    if (text !== this.lastText) {
      this.lastText = text;
      this.readout.textContent = text;
      this.el.classList.toggle('is-ab', ab);
      this.el.classList.toggle('is-idle', this.zone === 'idle');
      this.el.setAttribute('aria-valuenow', String(Math.round(this.value * 100)));
    }
  }
}
