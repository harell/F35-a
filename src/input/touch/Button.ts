/**
 * F35-A touch controls — a multi-touch thumb button (pointer-captured, pressed state, optional long press).
 */
import { GESTURES } from '../gestures';
import type { Rect } from './layout';

export interface ButtonOptions {
  cls: string;
  label: string;
  sub?: string;
  /** Round (circle) vs rounded rect. */
  round?: boolean;
  /** Fired on pointer down. */
  onDown?: () => void;
  /** Fired on release (always). */
  onUp?: () => void;
  /** Fired on a release before the long-press threshold (only when onLong is set; else use onDown). */
  onTap?: () => void;
  /** Fired once when held past the long-press threshold. */
  onLong?: () => void;
  /** aria-label for accessibility / tests. */
  aria: string;
}

export class TouchButton {
  readonly el: HTMLDivElement;
  pressed = false;
  private readonly labelEl: HTMLSpanElement;
  private readonly subEl: HTMLSpanElement;
  private pointerId: number | null = null;
  private longTimer = 0;
  private longFired = false;
  private curLabel = '';
  private curSub = '';
  private disabled = false;
  private active = false;
  /** Button width (px) — used to fit long labels. */
  private width = 56;
  private basePx = 14;

  constructor(parent: HTMLElement, private readonly opts: ButtonOptions) {
    const el = document.createElement('div');
    el.className = `ctl-btn ${opts.round ? 'ctl-round' : 'ctl-rect'} ${opts.cls}`;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', opts.aria);
    el.dataset.ctl = opts.cls;
    this.labelEl = document.createElement('span');
    this.labelEl.className = 'ctl-label';
    this.subEl = document.createElement('span');
    this.subEl.className = 'ctl-sub';
    el.append(this.labelEl, this.subEl);
    parent.appendChild(el);
    this.el = el;
    this.setLabel(opts.label, opts.sub ?? '');

    el.addEventListener('pointerdown', this.down);
    el.addEventListener('pointerup', this.up);
    el.addEventListener('pointercancel', this.cancel);
    el.addEventListener('lostpointercapture', this.lost);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  place(rc: Rect): void {
    const st = this.el.style;
    st.left = `${rc.x}px`;
    st.top = `${rc.y}px`;
    st.width = `${rc.w}px`;
    st.height = `${rc.h}px`;
    this.width = rc.w;
    this.basePx = Math.round(Math.min(rc.w, rc.h) * 0.2 + 3);
    st.fontSize = `${this.basePx}px`;
    this.fit();
  }

  /** Shrink the main label so it fits inside the button (round buttons have less usable width). */
  private fit(): void {
    const usable = this.width * (this.opts.round ? 0.74 : 0.84);
    const emph = this.opts.cls === 'b-fire' ? 1.12 : 1;
    const len = Math.max(3, this.curLabel.length);
    const px = Math.min(this.basePx * emph, usable / (len * 0.74));
    this.labelEl.style.fontSize = `${px.toFixed(1)}px`;
  }

  setLabel(label: string, sub = ''): void {
    if (label !== this.curLabel) {
      const relen = label.length !== this.curLabel.length;
      this.curLabel = label;
      this.labelEl.textContent = label;
      if (relen) this.fit();
    }
    if (sub !== this.curSub) {
      this.curSub = sub;
      this.subEl.textContent = sub;
      this.subEl.style.display = sub ? '' : 'none';
    }
  }

  setDisabled(d: boolean): void {
    if (d === this.disabled) return;
    this.disabled = d;
    this.el.classList.toggle('is-empty', d);
  }

  setActive(a: boolean): void {
    if (a === this.active) return;
    this.active = a;
    this.el.classList.toggle('is-active', a);
  }

  setVisible(v: boolean): void {
    this.el.style.display = v ? '' : 'none';
    if (!v) this.release();
  }

  /** Force release (controls disabled, pause…). */
  release(): void {
    if (this.pointerId !== null) {
      try {
        this.el.releasePointerCapture(this.pointerId);
      } catch {
        /* already released */
      }
    }
    this.finish(false);
  }

  private down = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    if (this.pointerId !== null) return; // already held by another finger
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.pointerId = e.pointerId;
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events */
    }
    this.pressed = true;
    this.longFired = false;
    this.el.classList.add('is-down');
    this.opts.onDown?.();
    if (this.opts.onLong) {
      clearTimeout(this.longTimer);
      this.longTimer = window.setTimeout(() => {
        if (!this.pressed) return;
        this.longFired = true;
        this.el.classList.add('is-long');
        this.opts.onLong?.();
      }, GESTURES.longPressMs);
    }
  };

  private up = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    this.finish(true);
  };

  private cancel = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    this.finish(false);
  };

  private lost = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    // capture lost without an up (e.g. element hidden): treat as cancel
    this.finish(false);
  };

  private finish(tap: boolean): void {
    if (!this.pressed && this.pointerId === null) return;
    clearTimeout(this.longTimer);
    const wasPressed = this.pressed;
    this.pressed = false;
    this.pointerId = null;
    this.el.classList.remove('is-down', 'is-long');
    if (wasPressed) {
      this.opts.onUp?.();
      if (tap && !this.longFired && this.opts.onLong) this.opts.onTap?.();
    }
  }
}
