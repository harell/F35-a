/**
 * F35-A UI — overlays that live above the screens: loading (progress + rotating tips), rotate-your-
 * phone hint, and toasts.
 */
import { icon } from './art/icons';
import { logoMark } from './art/logo';
import { h } from './dom';
import type { UiHost } from './host';
import { TIPS } from './tips';

export class LoadingOverlay {
  readonly el: HTMLDivElement;
  private readonly bar: HTMLElement;
  private readonly pct: HTMLElement;
  private readonly label: HTMLElement;
  private readonly tip: HTMLElement;
  private visible = false;
  private tipTimer = 0;
  private tipIndex = Math.floor(Math.random() * TIPS.length);
  private shownFraction = -1;
  private hideTimer = 0;

  constructor(private readonly host: UiHost) {
    const el = h('div', { class: 'ui-loading', attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' } });
    el.innerHTML =
      `<div class="ld-center">` +
      `<div class="ld-emblem">${logoMark()}</div>` +
      `<div class="ld-label">Loading</div>` +
      `<div class="ld-bar"><i></i><span class="ld-pct mono">0%</span></div>` +
      `<div class="ld-tip"><span class="ld-tip-k">${icon('info')} TIP</span><span class="ld-tip-t"></span></div>` +
      `</div>`;
    host.overlays.appendChild(el);
    this.el = el;
    this.bar = el.querySelector('.ld-bar i') as HTMLElement;
    this.pct = el.querySelector('.ld-pct') as HTMLElement;
    this.label = el.querySelector('.ld-label') as HTMLElement;
    this.tip = el.querySelector('.ld-tip-t') as HTMLElement;
  }

  show(fraction: number, label: string): void {
    window.clearTimeout(this.hideTimer);
    if (!this.visible) {
      this.visible = true;
      this.el.classList.remove('is-out');
      this.el.classList.add('is-on');
      this.host.setOverlayBg(true);
      this.nextTip();
      window.clearInterval(this.tipTimer);
      this.tipTimer = window.setInterval(() => this.nextTip(), 4800);
    }
    const f = Math.max(0, Math.min(1, fraction));
    if (Math.abs(f - this.shownFraction) > 0.001) {
      this.shownFraction = f;
      this.bar.style.transform = `scaleX(${f.toFixed(3)})`;
      this.pct.textContent = `${Math.round(f * 100)}%`;
      this.el.setAttribute('aria-valuenow', String(Math.round(f * 100)));
    }
    if (this.label.textContent !== label) this.label.textContent = label;
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    window.clearInterval(this.tipTimer);
    this.el.classList.add('is-out');
    this.host.setOverlayBg(false);
    this.hideTimer = window.setTimeout(() => {
      this.el.classList.remove('is-on', 'is-out');
      this.shownFraction = -1;
    }, 420);
  }

  private nextTip(): void {
    this.tipIndex = (this.tipIndex + 1) % TIPS.length;
    const t = this.tip;
    t.classList.remove('is-in');
    void t.offsetWidth;
    t.textContent = TIPS[this.tipIndex];
    t.classList.add('is-in');
  }
}

export class RotateOverlay {
  readonly el: HTMLDivElement;
  private on = false;

  constructor(host: UiHost) {
    const el = h('div', { class: 'ui-rotate', attrs: { 'aria-live': 'polite' } });
    el.innerHTML =
      `<div class="rt-phone"><div class="rt-screen"></div></div>` +
      `<div class="rt-t">Rotate your phone</div>` +
      `<div class="rt-s">F35-A flies in landscape — throttle under your left thumb, stick under your right.</div>`;
    host.root.appendChild(el);
    this.el = el;
  }

  set(visible: boolean): void {
    if (visible === this.on) return;
    this.on = visible;
    this.el.classList.toggle('is-on', visible);
  }
}

export class Toasts {
  private readonly el: HTMLDivElement;

  constructor(host: UiHost) {
    this.el = h('div', { class: 'ui-toasts', attrs: { 'aria-live': 'polite', role: 'status' } });
    host.root.appendChild(this.el);
  }

  /** Fade out every toast older than `minAgeMs` (screen changed → old messages are stale). */
  clearStale(minAgeMs = 350): void {
    const now = performance.now();
    for (const c of Array.from(this.el.children) as HTMLElement[]) {
      if (now - Number(c.dataset.t ?? 0) < minAgeMs || c.classList.contains('is-out')) continue;
      c.classList.add('is-out');
      window.setTimeout(() => c.remove(), 320);
    }
  }

  show(text: string, ms = 2600): void {
    // de-duplicate identical toasts already on screen
    for (const c of Array.from(this.el.children)) if (c.textContent === text && !c.classList.contains('is-out')) return;
    const t = h('div', { class: 'ui-toast', text, dataset: { t: String(performance.now()) } });
    this.el.appendChild(t);
    while (this.el.children.length > 3) this.el.firstElementChild?.remove();
    window.setTimeout(() => {
      t.classList.add('is-out');
      window.setTimeout(() => t.remove(), 320);
    }, ms);
  }
}
