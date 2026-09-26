/**
 * Screen layout for the HMD overlay (pure). All anchors are CSS px, derived from the viewport, the
 * safe-area insets and the touch-control zones:
 *   - bottom-left throttle and bottom-right stick zones: ~40 % of the height x 24 % of the width
 *   - right-edge button column: ~70 px
 * Symbology blocks stay out of those zones. `u` scales sizes on bigger screens (tablets/desktop).
 */

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
  /** Centre stack (SHOOT / warnings) start y. */
  stackY: number;
  /** Centre message y. */
  msgY: number;
  /** Mission hint y. */
  hintY: number;
  /** Radio subtitle y (centre of the pill). */
  radioY: number;
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
}

export function makeLayout(): HudLayout {
  return {
    W: 1, H: 1, cx: 0, cy: 0, u: 1, left: 0, right: 1, top: 0, bottom: 1, thumbY: 1, thumbLX: 0, thumbRX: 1, cockpitTop: 1,
    tapeY: 0, tapeHalfW: 1, spdRight: 0, altLeft: 0, boxY: 0, line: 15, dlzX: 0, dlzTop: 0, dlzBottom: 0, wpnX: 0, wpnY: 0,
    stackY: 0, msgY: 0, hintY: 0, radioY: 0, killX: 0, killY: 0, objX: 0, objY: 0, edgeCx: 0, edgeCy: 0, edgeRx: 1, edgeRy: 1,
    insetCx: 0, insetCy: 0, insetR: 1, extX: 0, extY: 0,
  };
}

/** Width of the right-edge button column (CSS px). */
export const BUTTON_COLUMN = 70;
/** Thumb zones as fractions of the screen. */
export const THUMB_W = 0.24;
export const THUMB_H = 0.4;
/** Angle (rad) of the glare-shield lip below the boresight at the default head pose (see cockpit geometry). */
export const GLARE_LIP_ANGLE = 0.29;

/**
 * @param tanHalfFov  tan(vertical FOV / 2) of the main camera (for the cockpit top line)
 * @param cockpit     3D cockpit shown (cockpit view)
 */
export function computeLayout(out: HudLayout, W: number, H: number, safe: Safe, tanHalfFov: number, cockpit: boolean): HudLayout {
  const u = Math.max(0.85, Math.min(1.6, H / 390));
  const cx = W / 2;
  const cy = H / 2;
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
  out.cockpitTop = cockpit ? Math.min(H, cy + (Math.tan(GLARE_LIP_ANGLE) / Math.max(0.1, tanHalfFov)) * cy) : H;

  out.line = 15 * u;
  out.tapeY = out.top + 2;
  out.tapeHalfW = Math.min(W * 0.17, 150 * u);
  out.hintY = out.tapeY + 52 * u;
  out.msgY = Math.max(out.hintY + 26 * u, H * 0.3);

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

  out.stackY = cy + 50 * u;
  const floor = Math.min(out.cockpitTop, out.bottom);
  out.radioY = cockpit ? Math.min(out.cockpitTop - 14 * u, H - 30 * u) : out.bottom - 14 * u;
  if (out.stackY > floor - 40 * u) out.stackY = floor - 40 * u;

  out.killX = out.right;
  out.killY = out.top + 10 * u;
  out.objX = out.left + 4;
  out.objY = out.top + 8 * u;

  out.edgeCx = cx;
  out.edgeCy = cy - H * 0.02;
  out.edgeRx = Math.min(W * 0.38, Math.min(cx - out.left, out.right - cx) - 22 * u);
  out.edgeRy = H * 0.4;

  out.insetR = Math.max(44, H * 0.13);
  out.insetCx = out.right - out.insetR - 2;
  out.insetCy = out.top + out.insetR + 4;
  out.extX = out.left + 4;
  out.extY = out.top + 4;
  return out;
}
