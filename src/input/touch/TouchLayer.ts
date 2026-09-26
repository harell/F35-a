/**
 * F35-A touch controls — the on-screen layer: floating stick, throttle lever, thumb buttons and the
 * free-view surface (drag = look around, tap = designate / PCD, double-tap = look reset).
 *
 * Every pointer is routed exactly once: buttons and the throttle capture their own pointers; the
 * full-screen surface underneath receives the rest and decides stick vs look by the start position.
 * Multi-touch is native (Pointer Events, one pointer id per finger).
 */
import type { InputCommand } from '../../core/contracts';
import type { CameraMode } from '../../core/types';
import { GESTURES, classifyGesture, isDoubleTap, lookDelta, type TapRecord } from '../gestures';
import type { Haptics } from '../haptics';
import { TouchButton } from './Button';
import { computeTouchLayout, inRect, type Insets, type TouchLayout } from './layout';
import { VirtualStick } from './Stick';
import { ThrottleLever } from './Throttle';
import './controls.css';

interface LookPointer {
  id: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  t0: number;
  dragging: boolean;
}

const VIEW_LABEL: Record<CameraMode, string> = {
  cockpit: 'PIT',
  hud: 'HMD',
  chase: 'CHASE',
  orbit: 'ORBIT',
  target: 'PADLK',
  missile: 'WPN',
  flyby: 'FLYBY',
  tactical: 'MAP',
};

export class TouchLayer {
  readonly el: HTMLDivElement;
  readonly stick: VirtualStick;
  readonly throttle: ThrottleLever;
  readonly fire: TouchButton;
  readonly gun: TouchButton;
  readonly cms: TouchButton;
  readonly pause: TouchButton;
  readonly cam: TouchButton;
  readonly tgt: TouchButton;
  readonly wpn: TouchButton;
  readonly radar: TouchButton;
  readonly recenter: TouchButton;
  private readonly surface: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private layout: TouchLayout | null = null;
  /** Last laid-out viewport (numbers compared every frame — no per-frame strings). */
  private readonly laid = { w: -1, h: -1, t: -1, r: -1, b: -1, l: -1, left: false };
  private readonly looks = new Map<number, LookPointer>();
  private lastTap: TapRecord | null = null;
  /** Accumulated look deltas (rad) since the last consume. */
  lookYaw = 0;
  lookPitch = 0;
  readonly taps: { x: number; y: number }[] = [];
  private tilt = false;
  private leftHanded = false;
  private fov = 60;
  private sensitivity = 1;
  private invert = false;
  private readonly look = { yaw: 0, pitch: 0 };
  /** Where/when the current stick touch began (a quick tap there still designates HUD targets). */
  private readonly stickStart = { x: 0, y: 0, t: 0 };
  private viewLabel = '';
  /** Set when a touch happened (show controls on hybrid devices). */
  touched = false;

  constructor(
    parent: HTMLElement,
    private readonly haptics: Haptics,
    private readonly onCommand: (cmd: InputCommand) => void,
  ) {
    const el = document.createElement('div');
    el.className = 'f35-ctl';
    parent.appendChild(el);
    this.el = el;

    const surface = document.createElement('div');
    surface.className = 'ctl-surface';
    el.appendChild(surface);
    this.surface = surface;

    this.hint = document.createElement('div');
    this.hint.className = 'ctl-stick-hint';
    this.hint.textContent = 'STICK';
    el.appendChild(this.hint);

    this.stick = new VirtualStick(el);
    this.throttle = new ThrottleLever(el, haptics);

    const cmd = (c: InputCommand) => () => {
      haptics.tap();
      this.onCommand(c);
    };
    const press = () => haptics.tap();
    this.fire = new TouchButton(el, { cls: 'b-fire', label: 'FIRE', sub: '', round: true, onDown: press, aria: 'Fire weapon' });
    this.gun = new TouchButton(el, { cls: 'b-gun', label: 'GUN', sub: '', round: true, onDown: press, aria: 'Gun' });
    this.cms = new TouchButton(el, { cls: 'b-cms', label: 'CMS', sub: '', round: true, onDown: press, aria: 'Countermeasures: flares and chaff' });
    this.pause = new TouchButton(el, { cls: 'b-pause', label: '❚❚', onDown: cmd('pause'), aria: 'Pause' });
    this.cam = new TouchButton(el, { cls: 'b-cam', label: 'CAM', sub: 'PIT', onTap: cmd('camera'), onLong: cmd('padlock'), onDown: press, aria: 'Camera (hold: padlock)' });
    this.tgt = new TouchButton(el, { cls: 'b-tgt', label: 'TGT', sub: 'NEXT', onDown: cmd('cycleTarget'), aria: 'Next target' });
    this.wpn = new TouchButton(el, { cls: 'b-wpn', label: 'WPN', sub: 'SEL', onDown: cmd('cycleWeapon'), aria: 'Next weapon' });
    this.radar = new TouchButton(el, { cls: 'b-radar', label: 'RDR', sub: 'ON', onDown: cmd('radar'), aria: 'Radar on/off (EMCON)' });
    this.recenter = new TouchButton(el, { cls: 'b-recenter', label: 'RECENTER', sub: 'TILT', onDown: cmd('recenterTilt'), aria: 'Recenter tilt' });

    surface.addEventListener('pointerdown', this.down);
    surface.addEventListener('pointermove', this.move);
    surface.addEventListener('pointerup', this.up);
    surface.addEventListener('pointercancel', this.cancel);
    surface.addEventListener('lostpointercapture', this.cancel);
    surface.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('touchstart', this.markTouched, { passive: true });
  }

  configure(o: { tilt: boolean; leftHanded: boolean; fov: number; sensitivity: number; invertPitch: boolean; hudColor: string }): void {
    this.tilt = o.tilt;
    this.fov = o.fov;
    this.sensitivity = o.sensitivity;
    this.invert = o.invertPitch;
    if (o.leftHanded !== this.leftHanded) {
      this.leftHanded = o.leftHanded;
      this.laid.w = -1; // force a re-layout
    }
    this.el.dataset.scheme = o.tilt ? 'tilt' : 'stick';
    this.el.dataset.hand = o.leftHanded ? 'left' : 'right';
    this.el.dataset.hud = o.hudColor;
    this.stick.setVisible(!o.tilt);
    this.hint.style.display = o.tilt ? 'none' : '';
    this.recenter.setVisible(o.tilt);
    this.stick.configure(o.sensitivity, o.invertPitch, this.layout?.s ?? 1);
  }

  /** Re-layout when the viewport or safe area changed. */
  relayout(width: number, height: number, safe: Insets): void {
    const d = this.laid;
    if (d.w === width && d.h === height && d.t === safe.top && d.r === safe.right && d.b === safe.bottom && d.l === safe.left && d.left === this.leftHanded) return;
    d.w = width;
    d.h = height;
    d.t = safe.top;
    d.r = safe.right;
    d.b = safe.bottom;
    d.l = safe.left;
    d.left = this.leftHanded;
    const L = computeTouchLayout(width, height, safe, { leftHanded: this.leftHanded });
    this.layout = L;
    this.throttle.place(L.throttle, L.s);
    this.fire.place(L.buttons.fire);
    this.gun.place(L.buttons.gun);
    this.cms.place(L.buttons.cms);
    this.pause.place(L.buttons.pause);
    this.cam.place(L.buttons.cam);
    this.tgt.place(L.buttons.tgt);
    this.wpn.place(L.buttons.wpn);
    this.radar.place(L.buttons.radar);
    this.recenter.place(L.buttons.recenter);
    this.stick.configure(this.sensitivity, this.invert, L.s);
    this.stick.setHome(L.stickHome.x, L.stickHome.y, width, height);
    this.hint.style.transform = `translate3d(${L.stickHome.x}px, ${L.stickHome.y}px, 0)`;
  }

  setCameraLabel(mode: CameraMode): void {
    const l = VIEW_LABEL[mode] ?? 'CAM';
    if (l !== this.viewLabel) {
      this.viewLabel = l;
      this.cam.setLabel('CAM', l);
    }
  }

  /** Drop every held pointer and neutralise (controls disabled / hidden). */
  releaseAll(): void {
    for (const id of this.looks.keys()) this.releaseCapture(id);
    this.looks.clear();
    if (this.stick.pointerId !== null) this.releaseCapture(this.stick.pointerId);
    this.stick.reset();
    this.throttle.release();
    for (const b of [this.fire, this.gun, this.cms, this.pause, this.cam, this.tgt, this.wpn, this.radar, this.recenter]) b.release();
    this.lookYaw = this.lookPitch = 0;
    this.taps.length = 0;
  }

  update(dt: number): void {
    this.stick.update(dt);
  }

  private markTouched = (): void => {
    this.touched = true;
  };

  private releaseCapture(id: number): void {
    try {
      this.surface.releasePointerCapture(id);
    } catch {
      /* ignore */
    }
  }

  private down = (e: PointerEvent): void => {
    e.preventDefault();
    if (e.pointerType === 'touch' || e.pointerType === 'pen') this.touched = true;
    const x = e.clientX;
    const y = e.clientY;
    try {
      this.surface.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const L = this.layout;
    const stickEligible = !this.tilt && e.pointerType !== 'mouse';
    if (stickEligible && L && this.stick.pointerId === null && inRect(L.stickZone, x, y)) {
      this.stickStart.x = x;
      this.stickStart.y = y;
      this.stickStart.t = e.timeStamp;
      this.stick.start(e.pointerId, x, y);
      this.hint.classList.add('is-hidden');
      return;
    }
    this.looks.set(e.pointerId, { id: e.pointerId, startX: x, startY: y, lastX: x, lastY: y, t0: e.timeStamp, dragging: false });
  };

  private move = (e: PointerEvent): void => {
    if (e.pointerId === this.stick.pointerId) {
      e.preventDefault();
      this.stick.move(e.clientX, e.clientY);
      return;
    }
    const p = this.looks.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    const x = e.clientX;
    const y = e.clientY;
    if (!p.dragging && classifyGesture(x - p.startX, y - p.startY, e.timeStamp - p.t0, false) === 'drag') {
      p.dragging = true;
      // start the drag from the current point minus the slop so it doesn't jump
      p.lastX = p.startX;
      p.lastY = p.startY;
    }
    if (p.dragging) {
      lookDelta(x - p.lastX, y - p.lastY, window.innerHeight, this.fov, this.look);
      this.lookYaw += this.look.yaw;
      this.lookPitch += this.look.pitch;
      p.lastX = x;
      p.lastY = y;
    }
  };

  private up = (e: PointerEvent): void => {
    if (e.pointerId === this.stick.pointerId) {
      this.stick.end();
      this.releaseCapture(e.pointerId);
      // a quick, still tap in the stick zone is also a view tap (HUD boxes can sit down there)
      const st = this.stickStart;
      if (classifyGesture(e.clientX - st.x, e.clientY - st.y, e.timeStamp - st.t, true) === 'tap') this.taps.push({ x: st.x, y: st.y });
      return;
    }
    const p = this.looks.get(e.pointerId);
    if (!p) return;
    this.looks.delete(e.pointerId);
    this.releaseCapture(e.pointerId);
    const now = e.timeStamp;
    const kind = p.dragging ? 'drag' : classifyGesture(e.clientX - p.startX, e.clientY - p.startY, now - p.t0, true);
    if (kind !== 'tap') return;
    const tap = { x: p.startX, y: p.startY, t: now };
    this.taps.push({ x: tap.x, y: tap.y });
    if (this.taps.length > 8) this.taps.shift();
    if (isDoubleTap(this.lastTap, tap, GESTURES)) {
      this.lastTap = null;
      this.onCommand('lookReset');
    } else {
      this.lastTap = tap;
    }
  };

  private cancel = (e: PointerEvent): void => {
    if (e.pointerId === this.stick.pointerId) {
      this.stick.end();
      return;
    }
    this.looks.delete(e.pointerId);
  };
}
