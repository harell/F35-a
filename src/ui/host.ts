/**
 * F35-A UI — screen host: layers, animated screen transitions, the menu background, back handling
 * (Escape / gamepad B), spatial focus navigation (arrow keys / D-pad / left stick) and the UI click sound.
 */
import { MenuBackground } from './art/menuBackground';

export interface PresentOptions {
  /** Show the animated tactical-map background behind the screen (opaque menus). */
  bg: boolean;
  /** Back / cancel action (Escape, gamepad B, header back button). */
  back?: () => void;
  /** Element to focus first for keyboard / gamepad users. */
  focus?: HTMLElement | null;
}

const FOCUSABLE = 'button:not([disabled]), [tabindex="0"], input[type="range"]';

export class UiHost {
  readonly root: HTMLDivElement;
  readonly screens: HTMLDivElement;
  readonly overlays: HTMLDivElement;
  private readonly bgLayer: HTMLDivElement;
  private readonly bg: MenuBackground;
  private current: HTMLElement | null = null;
  private back: (() => void) | null = null;
  private bgWanted = false;
  private overlayBg = 0;
  private bgTimer = 0;
  private padRaf = 0;
  private padPrev: boolean[] = [];
  private padRepeat = 0;
  private padDir = '';
  /** A gamepad has been seen (only then is it worth polling). */
  private padsKnown = false;
  /** Called whenever a new screen is presented (e.g. to fade out stale toasts). */
  onPresent: (() => void) | null = null;
  /** performance.now() when the current screen appeared (ignore the key/button that opened it). */
  private presentedAt = 0;

  constructor(parent: HTMLElement, private readonly uiClick: () => void) {
    const root = document.createElement('div');
    root.className = 'f35-ui';
    parent.appendChild(root);
    this.root = root;
    this.bgLayer = document.createElement('div');
    this.bgLayer.className = 'ui-bg';
    root.appendChild(this.bgLayer);
    this.bg = new MenuBackground(this.bgLayer);
    this.screens = document.createElement('div');
    this.screens.className = 'ui-screens';
    root.appendChild(this.screens);
    this.overlays = document.createElement('div');
    this.overlays.className = 'ui-overlays';
    root.appendChild(this.overlays);

    // one delegated click sound for every tappable control
    window.addEventListener('gamepadconnected', () => {
      this.padsKnown = true;
      if (this.current) this.startPad();
    });
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement | null)?.closest('button, [data-click]');
      if (t && !t.hasAttribute('data-silent')) this.uiClick();
    });
    window.addEventListener('keydown', this.onKey);
  }

  get active(): HTMLElement | null {
    return this.current;
  }

  /** Show a screen (the previous one animates out). */
  present(el: HTMLElement, opts: PresentOptions): void {
    if (this.current && this.current !== el) this.leaveEl(this.current);
    el.classList.add('ui-screen');
    this.screens.appendChild(el);
    this.current = el;
    this.back = opts.back ?? null;
    this.bgWanted = opts.bg;
    this.presentedAt = performance.now();
    this.onPresent?.();
    this.syncBg();
    this.primePad();
    this.startPad();
    const f = opts.focus;
    if (f && !matchMedia('(pointer: coarse)').matches) requestAnimationFrame(() => f.focus({ preventScroll: true }));
  }

  /** Remove a screen (if it is the current one, the host becomes idle). */
  leave(el: HTMLElement): void {
    if (el === this.current) {
      this.current = null;
      this.back = null;
      this.bgWanted = false;
      // keep the background up for a moment: the next screen usually follows immediately
      window.clearTimeout(this.bgTimer);
      this.bgTimer = window.setTimeout(() => this.syncBg(), 60);
    }
    this.leaveEl(el);
  }

  /** Overlays (loading) can request the background too. */
  setOverlayBg(on: boolean): void {
    this.overlayBg = on ? 1 : 0;
    this.syncBg();
  }

  hideAll(): void {
    for (const el of Array.from(this.screens.children)) (el as HTMLElement).remove();
    this.current = null;
    this.back = null;
    this.bgWanted = false;
    this.syncBg();
  }

  private leaveEl(el: HTMLElement): void {
    if (!el.isConnected) return;
    el.classList.add('is-leaving');
    window.setTimeout(() => el.remove(), 210);
  }

  private syncBg(): void {
    const on = this.bgWanted || this.overlayBg > 0 || (this.current !== null && this.current.dataset.bg === '1');
    this.root.classList.toggle('has-bg', on);
    if (on) this.bg.start();
    else window.setTimeout(() => !this.root.classList.contains('has-bg') && this.bg.stop(), 450);
  }

  /* ───────── keyboard: Escape = back, arrows = spatial focus ───────── */

  private onKey = (e: KeyboardEvent): void => {
    if (!this.current) return;
    // the same key press that opened this screen (e.g. Esc → pause) must not also close it
    if (e.timeStamp <= this.presentedAt + 1) return;
    if (e.key === 'Escape' || e.key === 'Backspace') {
      if (e.repeat) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (e.key === 'Backspace' && (tag === 'INPUT' || tag === 'TEXTAREA')) return;
      if (this.back) {
        e.preventDefault();
        e.stopPropagation();
        this.back();
      }
      return;
    }
    const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
    if (!dir) return;
    const focused = document.activeElement as HTMLElement | null;
    if (focused instanceof HTMLInputElement && focused.type === 'range' && (dir === 'left' || dir === 'right')) return;
    e.preventDefault();
    this.moveFocus(dir as 'up' | 'down' | 'left' | 'right');
  };

  /** Move focus to the nearest focusable element in a direction (spatial navigation). */
  moveFocus(dir: 'up' | 'down' | 'left' | 'right'): void {
    const scope = this.current;
    if (!scope) return;
    const items = Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const cur = document.activeElement as HTMLElement | null;
    if (!cur || !scope.contains(cur)) {
      (scope.querySelector<HTMLElement>('.primary, .is-suggested') ?? items[0]).focus();
      return;
    }
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const el of items) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect();
      const bx = b.left + b.width / 2;
      const by = b.top + b.height / 2;
      const dx = bx - ax;
      const dy = by - ay;
      const along = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
      const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
      if (along <= 2) continue;
      const score = along + across * 2.2;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (best) {
      best.focus();
      best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
  }

  /* ───────── gamepad menu navigation ───────── */

  /** Snapshot held buttons so a button that opened the screen isn't read as a fresh press. */
  private primePad(): void {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
    for (const g of navigator.getGamepads()) {
      if (g && g.connected) {
        this.padPrev = g.buttons.map((b) => b.pressed);
        return;
      }
    }
  }

  private startPad(): void {
    if (!this.padsKnown || this.padRaf || typeof navigator === 'undefined' || !navigator.getGamepads) return;
    const loop = () => {
      this.padRaf = 0;
      if (!this.current) return;
      this.pollPad();
      this.padRaf = requestAnimationFrame(loop);
    };
    this.padRaf = requestAnimationFrame(loop);
  }

  private pollPad(): void {
    let p: Gamepad | null = null;
    for (const g of navigator.getGamepads()) {
      if (g && g.connected) {
        p = g;
        break;
      }
    }
    if (!p) return;
    const pressed = p.buttons.map((b) => b.pressed);
    const edge = (i: number) => pressed[i] && !this.padPrev[i];
    const ax = p.axes[0] ?? 0;
    const ay = p.axes[1] ?? 0;
    let dir = '';
    if (pressed[12] || ay < -0.6) dir = 'up';
    else if (pressed[13] || ay > 0.6) dir = 'down';
    else if (pressed[14] || ax < -0.6) dir = 'left';
    else if (pressed[15] || ax > 0.6) dir = 'right';
    const now = performance.now();
    if (dir && (dir !== this.padDir || now > this.padRepeat)) {
      this.moveFocus(dir as 'up' | 'down' | 'left' | 'right');
      this.padRepeat = now + (dir !== this.padDir ? 380 : 140);
    }
    this.padDir = dir;
    if (edge(0)) {
      const f = document.activeElement as HTMLElement | null;
      if (f && this.current?.contains(f)) f.click();
      else this.moveFocus('down');
    }
    if (edge(1) && this.back) this.back();
    if (edge(9)) (this.current?.querySelector<HTMLElement>('.primary') ?? null)?.click();
    this.padPrev = pressed;
  }
}
