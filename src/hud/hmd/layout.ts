/**
 * Screen layout for the HMD overlay (pure). All anchors are CSS px, derived from the viewport, the
 * safe-area insets and the LIVE touch-control layout (src/input/touch/layout.ts, same pure function the
 * input module uses, so the HUD always knows where the thumbs are — right- or left-handed).
 *
 * Fixed text zones (one owner each, nothing stacks into the centre of the screen):
 *
 *   ┌ objectives / damage / hint ┐        [ heading tape ]                     kill feed (max 3) ┐
 *   │ (top-left column)          │   (cockpit view: radio subtitles)                             │
 *   │                            │   ROW 1  PULL UP / MISSILE / MISSILE DEFEATED / STALL / title │
 *   │                            │   ROW 2  [SPIKE 29] [FLARES LOW] [BINGO] … chips              │
 *   │  weapon block          spd │            (flight path marker)              │ alt     DLZ    │
 *   │                            │   CUE    SHOOT / IN RNG / FOX 3                                │
 *   │                            │   MSG    one centre message (priority queue)                  │
 *   └ throttle cluster ──────────┴── radio subtitles (2 lines, paged) ──────── stick ┘
 *
 * External views keep the same rows but move CUE / MSG above the jet; the tactical map reuses them.
 * `u` scales sizes on bigger screens (tablets/desktop).
 */
import { computeTouchLayout, type TouchLayout } from '../../input/touch/layout';

export interface Safe {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface HudLayout {
  W: number;
  H: number;
  cx: number;
  cy: number;
  /** Size scale (1 on a 390 px tall phone). */
  u: number;
  /** Usable horizontal band (inside safe insets, left of the button column). */
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Thumb zones (anything below `thumbY` and left of `thumbLX` / right of `thumbRX` is covered). */
  thumbY: number;
  thumbLX: number;
  thumbRX: number;
  /** Live touch controls in the bottom band: right edge of the left cluster, left edge of the right one, top. */
  ctlLeft: number;
  ctlRight: number;
  ctlTop: number;
  /** Top of the 3D cockpit (glare-shield lip) at the default head pose; H when no cockpit. */
  cockpitTop: number;
  /** Heading tape. */
  tapeY: number;
  tapeHalfW: number;
  /** Speed box right edge / altitude box left edge / box centre y. */
  spdRight: number;
  altLeft: number;
  boxY: number;
  /** Line spacing for the columns. */
  line: number;
  /** DLZ scale. */
  dlzX: number;
  dlzTop: number;
  dlzBottom: number;
  /** Weapon status block (left aligned). */
  wpnX: number;
  wpnY: number;
  /** Warning band: row 1 (one big critical line) and row 2 (caution chips) centre y. */
  warnY: number;
  row2Y: number;
  /** Weapon cue line (SHOOT / IN RNG / FOX 3) centre y. */
  cueY: number;
  /** Legacy alias of cueY. */
  stackY: number;
  /** Centre message slot centre y (one message). */
  msgY: number;
  /** Lowest y the centre slot may use (cockpit lip / thumb band). */
  msgFloor: number;
  /** Radio subtitles: horizontal band, and either the pill TOP (radioTop) or its BOTTOM. */
  radioX0: number;
  radioX1: number;
  radioY: number;
  radioTop: boolean;
  /** Radio subtitle lines per page (2; 3 in the narrower cockpit column). */
  radioLines: number;
  /** Top-left column (objectives, damage, mission hint). */
  colX: number;
  colY: number;
  colW: number;
  colBottom: number;
  /** Legacy: mission hint y (top of the column). */
  hintY: number;
  /** Kill feed anchor (right aligned). */
  killX: number;
  killY: number;
  /** Objectives / damage block (left aligned). */
  objX: number;
  objY: number;
  /** RWR / off-screen cue ellipse. */
  edgeCx: number;
  edgeCy: number;
  edgeRx: number;
  edgeRy: number;
  /** External-view radar inset. */
  insetCx: number;
  insetCy: number;
  insetR: number;
  /** External-view info block. */
  extX: number;
  extY: number;
  /** Target camera window (PiP, see pip.ts); pipW = 0 when there is no room / it is off. */
  pipX: number;
  pipY: number;
  pipW: number;
  pipH: number;
}

export function makeLayout(): HudLayout {
  return {
    W: 1, H: 1, cx: 0, cy: 0, u: 1, left: 0, right: 1, top: 0, bottom: 1, thumbY: 1, thumbLX: 0, thumbRX: 1, ctlLeft: 0, ctlRight: 1,
    ctlTop: 1, cockpitTop: 1, tapeY: 0, tapeHalfW: 1, spdRight: 0, altLeft: 0, boxY: 0, line: 15, dlzX: 0, dlzTop: 0, dlzBottom: 0,
    wpnX: 0, wpnY: 0, warnY: 0, row2Y: 0, cueY: 0, stackY: 0, msgY: 0, msgFloor: 1, radioX0: 0, radioX1: 1, radioY: 0, radioTop: false, radioLines: 2,
    colX: 0, colY: 0, colW: 1, colBottom: 1, hintY: 0, killX: 0, killY: 0, objX: 0, objY: 0, edgeCx: 0, edgeCy: 0, edgeRx: 1, edgeRy: 1,
    insetCx: 0, insetCy: 0, insetR: 1, extX: 0, extY: 0, pipX: 0, pipY: 0, pipW: 0, pipH: 0,
  };
}

/** Width of the right-edge button column (CSS px). */
export const BUTTON_COLUMN = 70;
/** Thumb zones as fractions of the screen. */
export const THUMB_W = 0.24;
export const THUMB_H = 0.4;
/**
 * Angle (rad) of the glare-shield lip below the boresight at the default head pose (see cockpit
 * geometry). Lowered from 0.25 so ~60 % of the panoramic cockpit display is in view by default.
 */
export const GLARE_LIP_ANGLE = 0.2;
/** Radio subtitle font size / line height (CSS px at u = 1). */
export const RADIO_FONT = 12;
export const RADIO_LINE = 15;

export interface LayoutOptions {
  /** External (chase/orbit/…) or tactical view: no pitch ladder / FPM, the jet sits at the centre. */
  external?: boolean;
  /** Left-handed touch layout (throttle right, stick left). */
  leftHanded?: boolean;
  /**
   * Cockpit view: head pitch relative to the airframe (rad, + = looking up). The glare-shield lip moves
   * down the screen when looking up and up when looking down; conformal symbology stays above it.
   */
  headPitch?: number;
  /**
   * Reserve the target camera window (PiP). HMD views: top right, the DLZ scale starts below it and the
   * kill feed moves under it, left of the DLZ. External views: under the radar inset.
   */
  pip?: boolean;
}

/* live touch layout (cached: computeTouchLayout allocates) */
let tlKey = '';
let tl: TouchLayout | null = null;
function touchLayout(W: number, H: number, safe: Safe, leftHanded: boolean): TouchLayout | null {
  const key = W + '|' + H + '|' + safe.top + '|' + safe.right + '|' + safe.bottom + '|' + safe.left + '|' + leftHanded;
  if (key !== tlKey) {
    tlKey = key;
    try {
      tl = computeTouchLayout(W, H, safe, { leftHanded });
    } catch {
      tl = null;
    }
  }
  return tl;
}

/** Bottom-band control extents from the live touch layout (fallback: the thumb-zone fractions). */
function controlBand(out: HudLayout, W: number, H: number, safe: Safe, leftHanded: boolean): void {
  const t = touchLayout(W, H, safe, leftHanded);
  let l = W * THUMB_W;
  let r = W * (1 - THUMB_W);
  let top = H * (1 - THUMB_H);
  if (t && t.width === Math.max(320, W) && t.height === Math.max(240, H)) {
    l = 0;
    r = W;
    top = H;
    const b = t.buttons;
    const low = [t.throttle, b.fire, b.gun, b.cms];
    for (const rc of low) {
      if (rc.y < H * 0.45) continue;
      if (rc.x + rc.w / 2 < W / 2) l = Math.max(l, rc.x + rc.w);
      else r = Math.min(r, rc.x);
      top = Math.min(top, rc.y);
    }
    // drawn stick base (the stick zone itself is an invisible touch area)
    const sx0 = t.stickHome.x - t.stickRadius;
    const sx1 = t.stickHome.x + t.stickRadius;
    if (t.stickHome.x < W / 2) l = Math.max(l, sx1);
    else r = Math.min(r, sx0);
    top = Math.min(top, t.stickHome.y - t.stickRadius);
  }
  out.ctlLeft = l;
  out.ctlRight = r;
  out.ctlTop = top;
}

/**
 * @param tanHalfFov  tan(vertical FOV / 2) of the main camera (for the cockpit top line)
 * @param cockpit     3D cockpit shown (cockpit view)
 */
export function computeLayout(
  out: HudLayout,
  W: number,
  H: number,
  safe: Safe,
  tanHalfFov: number,
  cockpit: boolean,
  opts: LayoutOptions = {},
): HudLayout {
  const u = Math.max(0.85, Math.min(1.6, H / 390));
  const cx = W / 2;
  const cy = H / 2;
  const external = !!opts.external;
  out.W = W;
  out.H = H;
  out.cx = cx;
  out.cy = cy;
  out.u = u;
  out.left = safe.left + 10;
  out.right = W - safe.right - BUTTON_COLUMN - 6;
  out.top = safe.top + 6;
  out.bottom = H - safe.bottom - 6;
  out.thumbY = H * (1 - THUMB_H);
  out.thumbLX = W * THUMB_W;
  out.thumbRX = W * (1 - THUMB_W);
  controlBand(out, W, H, safe, !!opts.leftHanded);
  const lipAng = Math.max(-1.2, Math.min(1.2, GLARE_LIP_ANGLE + (opts.headPitch ?? 0)));
  out.cockpitTop = cockpit ? Math.max(0, Math.min(H, cy + (Math.tan(lipAng) / Math.max(0.1, tanHalfFov)) * cy)) : H;
  // text zones are laid out for the default head pose (they must not jump around while looking about)
  const restTop = cockpit ? Math.min(H, cy + (Math.tan(GLARE_LIP_ANGLE) / Math.max(0.1, tanHalfFov)) * cy) : H;

  out.line = 15 * u;
  out.tapeY = out.top + 2;
  out.tapeHalfW = Math.min(W * 0.17, 150 * u);

  // columns: keep them clear of the thumb zones horizontally
  const colOff = Math.min(150 * u, W * 0.2);
  out.spdRight = Math.max(out.thumbLX + 70 * u, cx - colOff);
  out.altLeft = Math.min(out.thumbRX - 74 * u, cx + colOff);
  out.boxY = cy - 26 * u;
  out.dlzX = Math.min(out.right - 44 * u, out.altLeft + 96 * u);
  out.dlzTop = cy - 92 * u;
  out.dlzBottom = Math.min(out.thumbY - 12, cy + 28 * u);

  out.wpnX = out.left + 4;
  out.wpnY = Math.min(out.thumbY - 4 * out.line, cy - 6 * u);

  // top-left column: objectives (briefly), damage, mission hint — never over the weapon block
  out.colX = out.left + 4;
  out.colY = out.top + 8 * u;
  out.colW = Math.max(150, Math.min(W * 0.27, 232 * u, out.spdRight - 24 * u - out.colX));
  out.colBottom = external ? out.ctlTop - 8 * u : Math.min(out.wpnY - 12 * u, out.boxY - 14 * u);
  out.hintY = out.colY;
  out.objX = out.colX;
  out.objY = out.colY;

  out.killX = out.right;
  out.killY = out.top + 10 * u;

  // radio subtitles: bottom centre between the touch clusters; cockpit view: top centre, under the
  // heading tape (never over the panoramic cockpit display)
  out.radioTop = cockpit && !external;
  if (out.radioTop) {
    // top of the left column (objectives / hint move below it): the warning band keeps its slot above
    // the flight path marker and the top centre stays clear for the fight
    out.radioX0 = out.colX - 4 * u;
    out.radioX1 = Math.max(out.colX + out.colW, cx - out.tapeHalfW - 12 * u);
    out.radioY = out.colY - 6 * u;
    out.radioLines = 3;
  } else {
    out.radioLines = 2;
    const x0 = Math.max(out.left, out.ctlLeft + 8 * u);
    const x1 = Math.min(W - safe.right - 6, out.ctlRight - 8 * u);
    // too narrow (odd layouts): fall back to a centred band
    if (x1 - x0 < 220 * u) {
      out.radioX0 = cx - 150 * u;
      out.radioX1 = cx + 150 * u;
    } else {
      out.radioX0 = x0;
      out.radioX1 = x1;
    }
    out.radioY = out.bottom - 2;
  }

  // warning band (top centre, above the flight path marker)
  if (external) out.warnY = out.tapeY + 84 * u;
  else out.warnY = out.tapeY + 76 * u;
  out.row2Y = out.warnY + 26 * u;

  // weapon cue + centre message slot: below the flight path marker (HMD), above the jet (external)
  const floor = Math.min(restTop, out.bottom);
  if (external) {
    out.cueY = out.row2Y + 26 * u;
    out.msgY = out.cueY + 22 * u;
    // the jet itself is registered as an occupied rect every frame, the slot dodges it
    out.msgFloor = out.bottom - 48 * u;
  } else {
    out.cueY = Math.min(cy + 50 * u, floor - 46 * u);
    out.msgY = out.cueY + 22 * u;
    // (never down into the radio band / onto the cockpit panel)
    out.msgFloor = cockpit ? restTop - 2 * u : out.bottom - 48 * u;
  }
  out.stackY = out.cueY;

  // RWR / off-screen cue ellipse: below the warning band, above the cockpit panel / radio
  const eTop = out.row2Y + 22 * u;
  const eBottom = Math.min(restTop - 16 * u, out.bottom - 42 * u);
  out.edgeCx = cx;
  out.edgeCy = (eTop + eBottom) / 2;
  out.edgeRy = Math.max(40 * u, (eBottom - eTop) / 2);
  out.edgeRx = Math.min(W * 0.37, Math.min(cx - out.left, out.right - cx) - 24 * u);

  out.insetR = Math.max(44, H * 0.13);
  out.insetCx = out.right - out.insetR - 2;
  out.insetCy = out.top + out.insetR + 4;
  out.extX = out.left + 4;
  out.extY = out.top + 4;

  pipLayout(out, external, !!opts.pip);
  return out;
}

/** PiP aspect ratio (w / h). */
export const PIP_ASPECT = 16 / 9;

/** Target camera window rect (and the blocks that make room for it). */
function pipLayout(out: HudLayout, external: boolean, on: boolean): void {
  out.pipX = out.pipY = out.pipW = out.pipH = 0;
  if (!on) return;
  const u = out.u;
  let w = Math.min(168 * u, out.W * 0.24);
  let y: number;
  let maxBottom: number;
  if (!external) {
    // top right, clear of the heading tape (and its caret band) on the left; a little smaller than in
    // the external views so three kill-feed lines still fit under it, above the centre band
    w = Math.min(146 * u, out.W * 0.24, out.right - (out.cx + out.tapeHalfW + 14 * u));
    y = out.top + 2;
    maxBottom = out.boxY - 40 * u;
  } else {
    y = out.insetCy + out.insetR + 18 * u;
    maxBottom = out.ctlTop - 14 * u;
  }
  let h = w / PIP_ASPECT;
  if (y + h > maxBottom) {
    h = maxBottom - y;
    w = h * PIP_ASPECT;
  }
  if (w < 96 || h < 54) return; // no room on this screen
  out.pipW = Math.round(w);
  out.pipH = Math.round(h);
  out.pipX = Math.round(out.right - out.pipW);
  out.pipY = Math.round(y);
  if (!external) {
    const bottom = out.pipY + out.pipH;
    out.dlzTop = Math.max(out.dlzTop, bottom + 20 * u);
    // kill feed: under the window, right-aligned just left of the DLZ scale
    out.killX = Math.min(out.killX, out.dlzX - 16 * u);
    out.killY = bottom + 10 * u;
  }
}
