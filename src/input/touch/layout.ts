/**
 * F35-A touch controls — responsive layout (pure; unit-tested in tests/ui-layout.test.ts).
 *
 * Designed around the HMD layout's reserved zones (src/hud/hmd/layout.ts):
 *   - bottom-left / bottom-right thumb zones ≈ 24 % of the width × 40 % of the height
 *   - a ~70 px button column on the right edge
 * so the symbology (speed/altitude columns, weapon block, radio subtitles, PCD) stays visible.
 *
 * Right-handed (default, like the real F-35: throttle left hand, side-stick right hand):
 *
 *   ┌───────────────────────────────────────────────────────────┬──────┐
 *   │ (HUD objectives)                                    (kills)│PAUSE │
 *   │                                                            │ CAM  │
 *   │                  free 3D view: drag = look                 │ TGT  │
 *   │                  tap = designate / PCD                     │ WPN  │
 *   │ ┌──┐ (GUN)(CMS)                                           │RADAR │
 *   │ │TH│                                       floating stick zone   │
 *   │ └──┘ (FIRE)                                                       │
 *   └──────────────────────────────────────────────────────────────────┘
 * Left-handed swaps the throttle cluster and the stick zone (the button column stays on the right,
 * where the HUD expects it; the throttle then sits just inside the column).
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type ButtonId = 'fire' | 'gun' | 'cms' | 'pause' | 'cam' | 'tgt' | 'wpn' | 'radar' | 'recenter';

export interface TouchLayout {
  width: number;
  height: number;
  /** Size scale (1 on a 390 px tall phone). */
  s: number;
  throttle: Rect;
  buttons: Record<ButtonId, Rect>;
  /** Touches starting inside this rect grab the floating stick. */
  stickZone: Rect;
  /** Where the idle stick base is drawn (centre). */
  stickHome: { x: number; y: number };
  /** Stick travel radius at sensitivity 1 (px). */
  stickRadius: number;
}

export interface LayoutOptions {
  leftHanded: boolean;
}

const r = (x: number, y: number, w: number, h: number): Rect => ({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });

export function computeTouchLayout(width: number, height: number, safe: Insets, opts: LayoutOptions): TouchLayout {
  const W = Math.max(320, width);
  const H = Math.max(240, height);
  const s = Math.max(0.88, Math.min(1.35, H / 390));
  const pad = 10 * s;
  const L = safe.left + pad;
  const R = W - safe.right - pad;
  const T = safe.top + 8 * s;
  const B = H - Math.max(safe.bottom, 0) - pad;
  const thumbY = H * 0.6;

  // ── right-edge column ──
  const colW = 58 * s;
  const colX = W - safe.right - 8 * s - colW;
  const gap = 6 * s;
  const pause = r(colX + colW - 46 * s, T, 46 * s, 38 * s);
  let y = pause.y + pause.h + 8 * s;
  const bh = 54 * s;
  const cam = r(colX, y, colW, bh);
  y += bh + gap;
  const tgt = r(colX, y, colW, bh);
  y += bh + gap;
  const wpn = r(colX, y, colW, bh);
  y += bh + gap;
  const radar = r(colX, y, colW, 38 * s);

  // ── throttle cluster ──
  const thrW = 52 * s;
  const thrTop = Math.max(thumbY + 2, B - 176 * s);
  const thrH = B - thrTop;
  const fireD = 68 * s;
  const gunD = 60 * s;
  const cmsD = 54 * s;

  let throttle: Rect;
  let fire: Rect;
  let gun: Rect;
  let cms: Rect;
  if (!opts.leftHanded) {
    throttle = r(L, thrTop, thrW, thrH);
    const fx = L + thrW + 12 * s;
    fire = r(fx, B - fireD, fireD, fireD);
    gun = r(fx + (fireD - gunD) / 2, fire.y - 8 * s - gunD, gunD, gunD);
    cms = r(gun.x + gunD + 10 * s, gun.y + (gunD - cmsD) / 2 + 4 * s, cmsD, cmsD);
  } else {
    const tx = colX - 10 * s - thrW;
    throttle = r(tx, thrTop, thrW, thrH);
    const fx = tx - 12 * s - fireD;
    fire = r(fx, B - fireD, fireD, fireD);
    gun = r(fx + (fireD - gunD) / 2, fire.y - 8 * s - gunD, gunD, gunD);
    // mirrored cluster sits further in (the button column takes the edge), so CMS drops a row to keep
    // clear of the view centre and the altitude column
    cms = r(fx - 10 * s - cmsD, fire.y - 14 * s, cmsD, cmsD);
  }

  // ── stick zone (opposite side) ──
  const zoneW = Math.max(W * 0.3, 190 * s);
  const zoneTop = H * 0.48;
  let stickZone: Rect;
  if (!opts.leftHanded) {
    stickZone = r(W - safe.right - zoneW, zoneTop, zoneW + safe.right, H - zoneTop);
  } else {
    stickZone = r(0, zoneTop, safe.left + zoneW, H - zoneTop);
  }
  const radius = 65 * s;
  const homeX = opts.leftHanded ? L + radius + 18 * s : Math.min(colX - radius - 12 * s, R - radius - 60 * s);
  const homeY = B - radius - 6 * s;

  const recenter = r(opts.leftHanded ? L + 8 * s : colX - 96 * s, B - 44 * s, 96 * s, 42 * s);

  return {
    width: W,
    height: H,
    s,
    throttle,
    buttons: { fire, gun, cms, pause, cam, tgt, wpn, radar, recenter },
    stickZone,
    stickHome: { x: Math.round(homeX), y: Math.round(homeY) },
    stickRadius: radius,
  };
}

export function inRect(rc: Rect, x: number, y: number): boolean {
  return x >= rc.x && y >= rc.y && x <= rc.x + rc.w && y <= rc.y + rc.h;
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
