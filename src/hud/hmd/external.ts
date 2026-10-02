/**
 * External-view HUD (chase / orbit / flyby / target / missile): compact flight + weapon + target block,
 * mini DLZ, radar/TSD inset (top-right), missile-cam label. (The tactical MAP view lives in tacmap.ts.)
 */
import { RAD, toFeet, toKnots, toNm } from '../../core/math';
import { dlzLayout, makeDlzGeometry } from './dlz';
import { HDG3_STR, INT_STR, NumText, WEAPON_IS_BOMB, entityLabel } from './format';
import { blink, type HudFrame } from './frame';
import { withAlpha } from './palette';
import { rangeLabel, rangeLabelNm } from './targets';
import { autoTsdRange, drawTsd, makeTsdStyle, type TsdColors } from './tsd';
import { drawWeaponBlock } from './weapons';

const spdTxt = new NumText(0);
const altTxt = new NumText(0, '', '', true);
const machTxt = new NumText(2, 'M');
const gTxt = new NumText(1, 'G');
const ttiTxt = new NumText(0, 'TTI ');
const tPlus = new NumText(0, 'T+', 's');
const tsdStyle = makeTsdStyle();
let insetRange = 0;
const dlzG = makeDlzGeometry();

const colorCache = new Map<string, TsdColors>();
function tsdColors(f: HudFrame): TsdColors {
  const pal = f.pal;
  let c = colorCache.get(pal.id);
  if (!c) {
    c = {
      ring: withAlpha(pal.main, 0.35),
      text: pal.main,
      own: '#ffffff',
      hostile: pal.danger,
      friend: pal.friend,
      sam: withAlpha(pal.warn, 0.8),
      samFill: withAlpha(pal.danger, 0.08),
      ground: pal.warn,
      route: withAlpha('#9fe8ff', 0.8),
      highlight: pal.bright,
    };
    colorCache.set(pal.id, c);
  }
  return c;
}

/* ───────────────────────── Compact block ───────────────────────── */

let miniX = 0;
let miniW = 1;
/** Mini horizontal DLZ: map the vertical-scale coordinate (0 = far, w = near) to x. */
function xs(v: number): number {
  return miniX + (miniW - v);
}

export function drawExternalBlock(f: HudFrame): number {
  const { pen, pal, L, p } = f;
  const u = L.u;
  const fl = p.flight;
  let x = L.extX;
  let y = L.extY + 11 * u;
  // speed + altitude boxes
  const cw = pen.charWidth(15);
  const bw1 = cw * 4 + 10 * u;
  const bw2 = cw * 6 + 10 * u;
  const bh = 20 * u;
  pen.box(x, y - bh / 2, bw1, bh, pal.main, 1.4, pal.back);
  pen.text(spdTxt.get(Math.max(0, toKnots(fl.ias))), x + bw1 - 5 * u, y + 0.5, pal.main, 15, 'right');
  pen.text('KT', x + bw1 + 4 * u, y + 1, pal.dim, 10, 'left');
  const ax = x + bw1 + 26 * u;
  pen.box(ax, y - bh / 2, bw2, bh, pal.main, 1.4, pal.back);
  pen.text(altTxt.get(Math.round(Math.max(0, toFeet(fl.altitude)) / 10) * 10), ax + bw2 - 5 * u, y + 0.5, pal.main, 15, 'right');
  pen.text('FT', ax + bw2 + 4 * u, y + 1, pal.dim, 10, 'left');
  y += 22 * u;
  // mach / G / heading
  const hdg = Math.round((((fl.heading * RAD) % 360) + 360) % 360) % 360;
  let tx = x;
  const m = machTxt.get(fl.mach);
  pen.text(m, tx, y, pal.main, 12, 'left');
  tx += pen.textWidth(m, 12) + 10 * u;
  const gs = gTxt.get(fl.gLoad);
  pen.text(gs, tx, y, fl.gLoad > 8.5 ? pal.warn : pal.main, 12, 'left');
  tx += pen.textWidth(gs, 12) + 10 * u;
  pen.text(HDG3_STR[hdg], tx, y, pal.main, 12, 'left');
  if (fl.afterburner > 0.02) pen.text('AB', tx + pen.textWidth('000', 12) + 10 * u, y, pal.warn, 12, 'left');
  y += 18 * u;
  // weapon
  y = drawWeaponBlock(f, x, y, true);
  // target
  const t = f.target;
  if (t) {
    const d = t.position.distanceTo(p.position);
    const lbl = entityLabel(t);
    pen.text(lbl, x, y, f.locked ? pal.bright : pal.main, 12, 'left');
    const rl = rangeLabelNm(d);
    pen.text(rl, x + pen.textWidth(lbl, 12) + 8 * u, y, pal.main, 12, 'left');
    // lock state: LOCK / LOCKING (builds inside the ±30° nose cone) / NOSE ON (commanded, outside it)
    const lx = x + pen.textWidth(lbl, 12) + pen.textWidth(rl, 12) + 16 * u;
    if (f.locked) pen.text('LOCK', lx, y, pal.bright, 12, 'left');
    else if (p.radar.lockProgress > 0.01 && t.kind === 'aircraft') {
      if (blink(f, 2.5, 0.75)) pen.text('LOCKING', lx, y, pal.main, 12, 'left');
    } else if (f.lockCommanded && t.kind === 'aircraft') pen.text('NOSE ON', lx, y, pal.warn, 12, 'left');
    y += 14 * u;
    // mini horizontal DLZ
    const z = f.zone;
    if (z && z.rMax > 0 && z.weapon !== 'gun' && !WEAPON_IS_BOMB[z.weapon]) {
      const w = 120 * u;
      // map left (0) → right (scale) using the vertical helper on a horizontal axis
      const g = dlzLayout(z, 0, w, dlzG, f.st.dlzScale);
      f.st.dlzScale = g.scaleMax;
      miniX = x;
      miniW = w;
      const col = z.shoot ? pal.bright : pal.main;
      pen.begin();
      pen.line(xs(g.yMin), y, xs(g.yMax), y);
      pen.line(xs(g.yMax), y - 5 * u, xs(g.yMax), y + 5 * u);
      pen.line(xs(g.yMin), y - 5 * u, xs(g.yMin), y + 5 * u);
      pen.strokeGlow(col, 1.5);
      pen.setFill(col);
      pen.g.fillRect(xs(g.yMin), y - 2.5 * u, xs(g.yNe) - xs(g.yMin), 5 * u);
      pen.begin();
      pen.arrow(xs(g.yRange), y - 3 * u, 0, 1, 7 * u, 4.5 * u);
      pen.strokeGlow(col, 1.3);
      pen.fillPlain(col);
      y += 14 * u;
    }
  }
  return y;
}

/* ───────────────────────── Radar inset ───────────────────────── */

export function drawInset(f: HudFrame): void {
  const { pen, pal, L, p, ctx } = f;
  const r = L.insetR;
  const cx = L.insetCx;
  const cy = L.insetCy;
  // range: fit the designated target / current waypoint
  let need = 18_000;
  if (f.target) need = Math.max(need, f.target.position.distanceTo(p.position) * 1.15);
  insetRange = autoTsdRange(insetRange, need, [10, 20, 40]);
  pen.begin();
  pen.circle(cx, cy, r);
  pen.fillPlain('rgba(0,12,8,0.5)');
  pen.strokeGlow(pal.dim, 1.2);
  const s = tsdStyle;
  s.cx = cx;
  s.cy = cy;
  s.radius = r * 0.92;
  s.range = insetRange;
  s.clipCircle = r - 1;
  s.clipRect = null;
  s.rings = 2;
  s.labels = false;
  s.font = 9;
  s.sym = 0.85 * L.u;
  s.compass = true;
  s.route = true;
  s.bullseye = false;
  s.lw = 1;
  drawTsd(pen, ctx, p, s, tsdColors(f), blink(f, 3));
  pen.text(INT_STR[Math.min(399, Math.round(toNm(insetRange)))], cx + r * 0.72, cy + r * 0.8, pal.dim, 9.5);
}

/* ───────────────────────── Missile cam ───────────────────────── */

export function drawMissileCam(f: HudFrame): void {
  const { pen, pal, L, world, ctx } = f;
  const u = L.u;
  const m = world.getEntity(ctx.focusId);
  const y = L.tapeY + 12 * u;
  if (!m || m.kind !== 'missile') {
    pen.text('MISSILE CAM', L.cx, y, pal.dim, 13);
    return;
  }
  pen.text(m.def.name, L.cx, y, pal.main, 15);
  let info = tPlus.get(m.age);
  const t = world.getEntity(m.targetId);
  if (t && t.alive) {
    const d = t.position.distanceTo(m.position);
    const closing = Math.max(80, m.velocity.length() - 0);
    info += '  ' + ttiTxt.get(d / closing) + '  ' + rangeLabel(d) + ' NM';
    if (f.proj.point(t.position, f.sp) && f.sp.onScreen) {
      const h = 16 * u;
      pen.begin();
      pen.rect(f.sp.x - h, f.sp.y - h, h * 2, h * 2);
      pen.strokeGlow(pal.main, 1.8);
      pen.text(entityLabel(t), f.sp.x, f.sp.y - h - 9 * u, pal.main, 11.5);
    }
  }
  pen.text(info, L.cx, y + 18 * u, pal.dim, 12);
  if (m.seekerLocked && blink(f, 3, 0.75)) pen.text(m.def.guidance === 'ir' ? 'TRACKING' : 'PITBULL', L.cx, y + 36 * u, pal.bright, 13);
  if (m.decoyed) pen.text('DECOYED', L.cx, y + 52 * u, pal.warn, 13);
}
