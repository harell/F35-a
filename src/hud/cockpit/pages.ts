/**
 * Panoramic Cockpit Display (PCD) pages, drawn with Canvas2D into a portal rectangle of the PCD
 * texture: TSD (tactical situation), RDR (B-scope attack radar), SMS (stores), FUEL, ENG, ICAWS
 * (cautions & warnings), RWR/EW. Big fonts (≥ 22 texels ≈ 9–10 CSS px on the phone PCD, ≥ 26 for
 * values): the texture is seen small on a phone. The same renderers draw the full-size PCD zoom
 * overlay (tap a portal), where the page gets a wider box and every TSD label.
 *
 * Content is ordered top-first: at the default head position the upper ~60 % of the PCD is in view
 * (the rest shows when the pilot looks down or zooms the page).
 */
import { NM, RAD, toFeet, toNm } from '../../core/math';
import type { FrameContext } from '../../core/contracts';
import { BINGO_FRACTION } from '../../core/data';
import { AB_DETENT } from '../../core/types';
import type { AircraftEntity, StoreStation } from '../../sim/entities';
import { AIRCRAFT_LABEL, WARNING_INFO, WEAPON_HUD, entityLabel, groupThousands, hmm } from '../hmd/format';
import type { Pen } from '../hmd/pen';
import { autoTsdRange, drawTsd, makeTsdStyle, type TsdColors } from '../hmd/tsd';
import type { WarningId, WeaponId } from '../../core/types';

export const PC = {
  bg: '#03070a',
  portal: '#060c11',
  frame: '#1f3240',
  titleBg: '#0c1720',
  title: '#d6ecff',
  label: '#86a9bd',
  value: '#f3f8fb',
  green: '#46e27a',
  cyan: '#52d8ff',
  amber: '#ffb52e',
  red: '#ff4538',
  blue: '#5aa9ff',
  dim: '#35505f',
  grid: '#1a2c38',
};

export interface PcdData {
  ctx: FrameContext;
  p: AircraftEntity;
  /** Slow blink state (true/false) for flashing items. */
  flash: boolean;
  /** Drawn in the large 2D zoom overlay (all TSD labels; more room). */
  zoom?: boolean;
}

export type PageId = 'TSD' | 'RDR' | 'SMS' | 'FUEL' | 'ENG' | 'ICAWS' | 'RWR';
export type PageFn = (pen: Pen, x: number, y: number, w: number, h: number, d: PcdData) => void;

const KG_TO_LB = 2.20462;
/** F-35A internal fuel (kg) — 18,250 lb. */
const F35_FUEL_KG = 8_278;

/* ───────────────────────── TSD ───────────────────────── */

const tsdStyle = makeTsdStyle();
let tsdRange = 0;
const TSD_COLORS: TsdColors = {
  ring: '#2b4757',
  text: '#9cc4d8',
  own: '#ffffff',
  hostile: PC.red,
  friend: PC.blue,
  sam: 'rgba(255,181,46,0.85)',
  samFill: 'rgba(255,69,56,0.10)',
  ground: PC.amber,
  route: PC.cyan,
  highlight: PC.green,
};

/** TSD range steps (NM): 5 / 10 NM when the fight is close, up to 80 NM for a far waypoint. */
export const TSD_STEPS_NM = [5, 10, 20, 40, 80] as const;

/**
 * Distance (m) the TSD must show: the designated / locked target, else the nearest hostile air
 * contact, else the steering waypoint (capped at 75 km) — never less than ~4 NM. The 20 NM floor of
 * iteration 1 packed WP, contacts, ground squares and SAM rings within ~40 px of ownship.
 */
export function tsdNeed(p: AircraftEntity, ctx: FrameContext): number {
  let need = 8_000;
  const t = ctx.world.getEntity(p.radar.lockedId ?? p.radar.designatedId);
  if (t && t.alive) return Math.max(need, t.position.distanceTo(p.position) * 1.1);
  let nearest = Infinity;
  for (const c of p.radar.contacts) {
    if (c.team === p.team || c.team === 'neutral') continue;
    const e = ctx.world.getEntity(c.id);
    if (!e || !e.alive || e.kind !== 'aircraft') continue;
    nearest = Math.min(nearest, Math.hypot(c.position.x - p.position.x, c.position.z - p.position.z));
  }
  if (Number.isFinite(nearest)) return Math.max(need, nearest * 1.15);
  const wp = ctx.mission?.currentWaypoint;
  if (wp) need = Math.max(need, Math.min(75_000, Math.hypot(wp.position.x - p.position.x, wp.position.z - p.position.z) * 1.05));
  return need;
}

/**
 * Font size (texels) of the TSD and RWR corner readouts ("10 NM", "HDG 045", "BULL 005/6", "2 EMIT",
 * EMCON / LAUNCH). The PCD is drawn small in the cockpit view (about 0.43 px per texel on an 844×390
 * phone): at 22–24 texels they were 9–10 px tall, and read like 8 px on the tilted panel (#62). At 30
 * texels they are about 13 px and still fit a 256-texel side portal.
 */
export const PCD_CORNER = 30;

export const drawTsdPage: PageFn = (pen, x, y, w, h, d) => {
  const { p, ctx } = d;
  const t = ctx.world.getEntity(p.radar.lockedId ?? p.radar.designatedId);
  tsdRange = autoTsdRange(tsdRange, tsdNeed(p, ctx), TSD_STEPS_NM);
  const s = tsdStyle;
  s.cx = x + w / 2;
  // ownship high in the portal: at the default head pose only the upper part of the PCD is in view
  s.cy = y + h * (d.zoom ? 0.5 : 0.44);
  s.radius = h * (d.zoom ? 0.4 : 0.38);
  s.range = tsdRange;
  s.clipRect = [x, y, w, h];
  s.clipCircle = 0;
  s.coast = true;
  s.rings = 2;
  s.labels = d.zoom ? true : 'key';
  s.font = d.zoom ? 21 : 24;
  s.sym = d.zoom ? 1.8 : 2.2;
  s.compass = true;
  s.route = true;
  s.bullseye = true;
  s.lw = 2;
  // overlay readouts, measured first: the TSD's labels and N marker keep off them (#62 review: "N",
  // "SA-6" and "WP2 CAP" under "BULL 214/2")
  const rng = String(Math.round(tsdRange / NM)) + ' NM';
  const hdg = Math.round((((p.flight.heading * RAD) % 360) + 360) % 360) % 360;
  const hdgTxt = 'HDG ' + String(hdg).padStart(3, '0');
  // bullseye call (Sky Tower = origin): bearing/range from bullseye to ownship
  const bx = p.position.x;
  const bz = p.position.z;
  let brg = Math.atan2(bx, -bz) * RAD;
  if (brg < 0) brg += 360;
  const bull = 'BULL ' + String(Math.round(brg) % 360).padStart(3, '0') + '/' + Math.round(toNm(Math.hypot(bx, bz)));
  const tgt = !!t && t.alive;
  const lbl = tgt ? (p.radar.lockedId === t.id ? 'LOCK ' : 'TGT ') + entityLabel(t) : '';
  const hc = PCD_CORNER * 0.6;
  reserveRect(0, x + 10, y + 19, pen.textWidth(rng, PCD_CORNER), hc);
  const hw = pen.textWidth(hdgTxt, PCD_CORNER);
  reserveRect(1, x + w - 10 - hw, y + 19, hw, hc);
  reserveRect(2, x + 10, y + 51, pen.textWidth(bull, PCD_CORNER), hc);
  // the target name: beside the bullseye call with two ems between them, else on its own row below it
  // (1.2-f: "BULL 136/8 TGT FUEL DEPOT" read as one line), shrunk only if wider than the portal
  const bw = pen.textWidth(bull, PCD_CORNER);
  const lsz = tgt ? Math.min(22, (22 * (w - 20)) / Math.max(1, pen.textWidth(lbl, 22))) : 22;
  const lw = tgt ? pen.textWidth(lbl, lsz) : 0;
  const ly = bw + lw + 2 * PCD_CORNER + 20 <= w ? y + 51 : y + 51 + PCD_CORNER - 2;
  if (tgt) reserveRect(3, x + w - 10 - lw, ly, lw, lsz * 0.6);
  s.reserve = tsdReserve;
  s.reserveN = tgt ? 4 : 3;
  drawTsd(pen, ctx, p, s, TSD_COLORS, d.flash);
  pen.text(rng, x + 10, y + 19, PC.label, PCD_CORNER, 'left');
  pen.text(hdgTxt, x + w - 10, y + 19, PC.value, PCD_CORNER, 'right');
  pen.text(bull, x + 10, y + 51, PC.cyan, PCD_CORNER, 'left');
  if (tgt) pen.text(lbl, x + w - 10, ly, p.radar.lockedId === t.id ? PC.green : PC.value, lsz, 'right');
};

/** The TSD page's corner readout rects, reserved on the plot (x0, y0, x1, y1 each). */
const tsdReserve = new Float32Array(16);

function reserveRect(i: number, x0: number, yc: number, tw: number, half: number): void {
  tsdReserve[i * 4] = x0 - 2;
  tsdReserve[i * 4 + 1] = yc - half;
  tsdReserve[i * 4 + 2] = x0 + tw + 2;
  tsdReserve[i * 4 + 3] = yc + half;
}

/* ───────────────────────── Radar (B-scope) ───────────────────────── */

const RDR_RANGES = [10, 20, 40, 80];
let rdrRange = 40 * NM;

export const drawRadarPage: PageFn = (pen, x, y, w, h, d) => {
  const { p, ctx } = d;
  const g = pen.g;
  const az = 60 / RAD;
  const px = x + 30;
  const pw = w - 70;
  const top = y + 38;
  const bottom = y + h - 12;
  const ph = bottom - top;
  // range: fit the farthest hostile air contact
  let far = 15_000;
  for (const c of p.radar.contacts) {
    if (c.team === p.team || c.team === 'neutral') continue;
    far = Math.max(far, c.position.distanceTo(p.position));
  }
  rdrRange = autoTsdRange(rdrRange, Math.min(far * 1.1, 150_000), RDR_RANGES);
  // grid
  pen.begin();
  for (let i = 1; i < 4; i++) pen.line(px, top + (ph * i) / 4, px + pw, top + (ph * i) / 4);
  for (let i = 1; i < 4; i++) pen.line(px + (pw * i) / 4, top, px + (pw * i) / 4, bottom);
  pen.strokePlain(PC.grid, 2);
  pen.begin();
  pen.rect(px, top, pw, ph);
  pen.strokePlain(PC.frame, 2);
  const mode = p.radar.mode === 'acm' ? 'ACM' : p.radar.mode === 'ground' ? 'GMT' : 'RWS';
  pen.text(p.radar.emitting ? mode : 'SILENT', x + 10, y + 18, p.radar.emitting ? PC.green : PC.amber, 24, 'left');
  pen.text(String(Math.round(rdrRange / NM)), px + pw + 4, top + 12, PC.label, 22, 'left');
  pen.text(String(Math.round(rdrRange / NM / 2)), px + pw + 4, top + ph / 2, PC.label, 22, 'left');
  // scan line
  if (p.radar.emitting) {
    const tt = ctx.time * 0.9;
    const sweep = Math.sin(tt * Math.PI) * 0.5 + 0.5;
    const sx = px + sweep * pw;
    pen.begin();
    pen.line(sx, top, sx, bottom);
    pen.strokePlain('rgba(70,226,122,0.35)', 3);
  }
  // contacts
  const hdg = p.flight.heading;
  const lock = p.radar.lockedId;
  const des = p.radar.designatedId;
  let lockLabel = '';
  for (const c of p.radar.contacts) {
    const e = ctx.world.getEntity(c.id);
    if (!e || !e.alive || e.kind !== 'aircraft') continue;
    const dx = c.position.x - p.position.x;
    const dz = c.position.z - p.position.z;
    const r = Math.hypot(dx, dz);
    let b = Math.atan2(dx, -dz) - hdg;
    b = Math.atan2(Math.sin(b), Math.cos(b));
    if (Math.abs(b) > az || r > rdrRange) continue;
    const cx = px + ((b + az) / (2 * az)) * pw;
    const cy = bottom - (r / rdrRange) * ph;
    const friend = e.team === p.team;
    const col = friend ? PC.blue : e.team === 'neutral' ? PC.value : PC.red;
    pen.begin();
    if (friend) pen.circle(cx, cy, 9);
    else pen.rect(cx - 9, cy - 9, 18, 18);
    if (e.id === lock) pen.fillPlain(col);
    pen.strokePlain(col, 3);
    if (!friend) pen.text(String(Math.round(toFeet(c.position.y) / 1000)), cx + 14, cy + 2, PC.value, 22, 'left');
    if (e.id === lock || e.id === des) {
      pen.begin();
      pen.rect(cx - 16, cy - 16, 32, 32);
      pen.strokePlain(PC.green, 3);
      lockLabel = (e.id === lock ? 'LOCK ' : 'TGT ') + (e.kind === 'aircraft' ? AIRCRAFT_LABEL[e.type] : '') + ' ' + toNm(r).toFixed(1);
    }
  }
  if (lockLabel) pen.text(lockLabel, x + w - 10, y + 18, PC.green, 24, 'right');
  // ownship caret
  pen.begin();
  g.moveTo(px + pw / 2, bottom - 14);
  g.lineTo(px + pw / 2 - 10, bottom);
  g.lineTo(px + pw / 2 + 10, bottom);
  g.closePath();
  pen.fillPlain(PC.value);
  if (!p.radar.emitting && d.flash) pen.text('EMCON', px + pw / 2, top + ph * 0.3, PC.amber, 36);
};

/* ───────────────────────── SMS ───────────────────────── */

function stationCount(stores: StoreStation[], w: WeaponId): number {
  let n = 0;
  for (const s of stores) if (s.weapon === w) n += s.count;
  return n;
}

const WEAPON_NAME: Record<WeaponId, string> = {
  gun: 'GAU-22',
  aim120: 'AIM-120D',
  aim9x: 'AIM-9X',
  gbu31: 'GBU-31',
  gbu53: 'GBU-53',
  aargm: 'AGM-88G',
};

export const drawSmsPage: PageFn = (pen, x, y, w, h, d) => {
  const { p } = d;
  const sel = p.selectedWeapon;
  const n = sel === 'gun' ? p.gunAmmo : stationCount(p.stores, sel);
  const cx = x + w / 2;
  pen.text(WEAPON_NAME[sel], cx, y + 26, PC.green, 32);
  pen.text((sel === 'gun' ? 'RDS ' : 'QTY ') + n, cx, y + 62, n > 0 ? PC.value : PC.amber, 30);
  const bay = p.bayDoors > 0.05 ? (p.bayDoors > 0.9 ? 'BAY OPEN' : 'BAY MOVING') : 'BAY CLSD';
  pen.text(bay, cx, y + 94, p.bayDoors > 0.05 ? PC.amber : PC.label, 23);
  pen.text('GUN ' + p.gunAmmo, x + 10, y + 124, sel === 'gun' ? PC.green : PC.value, 23, 'left');
  pen.text('F' + p.flares + ' C' + p.chaff, x + w - 10, y + 124, p.flares <= 4 || p.chaff <= 4 ? PC.amber : PC.value, 23, 'right');

  // planform with stations (internal bays + wing pylons)
  const g = pen.g;
  const oy = y + 146;
  const sh = h - 154;
  const s = Math.min(w / 240, sh / 230);
  const ox = cx;
  const P = (px: number, py: number) => [ox + px * s, oy + py * s] as const;
  pen.begin();
  const outline: [number, number][] = [
    [0, 0], [10, 30], [14, 70], [100, 120], [104, 140], [30, 150], [34, 185], [60, 205], [58, 215], [14, 210], [0, 214],
  ];
  let first = true;
  for (const [ux, uy] of outline) {
    const [X, Y] = P(ux, uy);
    if (first) g.moveTo(X, Y);
    else g.lineTo(X, Y);
    first = false;
  }
  for (let i = outline.length - 1; i >= 0; i--) {
    const [X, Y] = P(-outline[i][0], outline[i][1]);
    g.lineTo(X, Y);
  }
  g.closePath();
  pen.strokePlain(PC.dim, 2.5);
  // stations: internal stores alternate left/right bay; external on the wing pylons
  let li = 0;
  let ri = 0;
  let le = 0;
  let re = 0;
  for (let i = 0; i < p.stores.length; i++) {
    const st = p.stores[i];
    const left = i % 2 === 0;
    let sx: number;
    let sy: number;
    if (st.internal) {
      const k = left ? li++ : ri++;
      sx = (left ? -1 : 1) * (22 + k * 18);
      sy = 110 + k * 8;
    } else {
      const k = left ? le++ : re++;
      sx = (left ? -1 : 1) * (58 + k * 26);
      sy = 118 + k * 4;
    }
    const [X, Y] = P(sx, sy);
    const selected = st.weapon === sel;
    const empty = st.count <= 0;
    const col = empty ? PC.dim : selected ? PC.green : PC.value;
    pen.begin();
    pen.rect(X - 15, Y - 22, 30, 44);
    if (selected && !empty) {
      pen.setFill('rgba(70,226,122,0.22)');
      g.fill();
    }
    pen.strokePlain(col, 2.5);
    pen.text(WEAPON_HUD[st.weapon].slice(0, 4), X, Y - 34, col, 17);
    pen.text(String(st.count), X, Y + 1, col, 24);
  }
};

/* ───────────────────────── FUEL ───────────────────────── */

export const drawFuelPage: PageFn = (pen, x, y, w, h, d) => {
  const fl = d.p.flight;
  const lb = fl.fuel * KG_TO_LB;
  const maxLb = F35_FUEL_KG * KG_TO_LB;
  const bingoLb = F35_FUEL_KG * BINGO_FRACTION * KG_TO_LB;
  const cx = x + w / 2;
  const low = d.p.warnings.has('bingo') || lb < bingoLb;
  pen.text('TOTAL LB', cx, y + 20, PC.label, 22);
  pen.text(groupThousands(Math.round(lb / 10) * 10), cx, y + 56, low ? PC.amber : PC.value, 42);
  // gauge bar with bingo mark
  const bx = x + 18;
  const bw = w - 36;
  const by = y + 86;
  pen.begin();
  pen.rect(bx, by, bw, 20);
  pen.strokePlain(PC.frame, 2);
  pen.setFill(low ? PC.amber : PC.green);
  pen.g.fillRect(bx + 2, by + 2, (bw - 4) * Math.max(0, Math.min(1, lb / maxLb)), 16);
  const bm = bx + bw * (bingoLb / maxLb);
  pen.begin();
  pen.line(bm, by - 5, bm, by + 25);
  pen.strokePlain(PC.red, 3);
  const flowPph = fl.fuelFlow * KG_TO_LB * 3600;
  const endur = fl.fuelFlow > 0.01 ? fl.fuel / fl.fuelFlow : 0;
  row(pen, x, y + 134, w, 'ENDUR', hmm(endur), endur < 300 ? PC.amber : PC.value);
  row(pen, x, y + 168, w, 'BINGO', groupThousands(Math.round(bingoLb / 100) * 100), PC.value);
  row(pen, x, y + 202, w, 'FLOW PPH', groupThousands(Math.round(flowPph / 100) * 100), fl.afterburner > 0.02 ? PC.amber : PC.value);
  const leak = d.p.damage.fuelLeak > 0.05;
  if (leak && d.flash) pen.text('FUEL LEAK', cx, y + 240, PC.red, 28);
};

function row(pen: Pen, x: number, y: number, w: number, label: string, value: string, col: string): void {
  pen.text(label, x + 12, y, PC.label, 22, 'left');
  pen.text(value, x + w - 12, y, col, 27, 'right');
}

/* ───────────────────────── ENG ───────────────────────── */

export const drawEngPage: PageFn = (pen, x, y, w, h, d) => {
  const p = d.p;
  const fl = p.flight;
  const cx = x + w / 2;
  const n2 = Math.max(0, fl.engineRpm * 100);
  const gy = y + 110;
  const R = Math.min(w * 0.3, 62);
  // N2 arc gauge
  const a0 = Math.PI * 0.8;
  const a1 = Math.PI * 2.2;
  pen.begin();
  pen.arc(cx, gy, R, a0, a1);
  pen.strokePlain(PC.frame, 8);
  const frac = Math.max(0, Math.min(1, n2 / 110));
  const fire = p.damage.fire;
  pen.begin();
  pen.arc(cx, gy, R, a0, a0 + (a1 - a0) * frac);
  pen.strokePlain(fire ? PC.red : n2 > 100 ? PC.amber : PC.green, 8);
  pen.text(Math.round(n2) + '%', cx, gy + 2, PC.value, 34);
  pen.text('N2', cx, gy + 34, PC.label, 22);
  const thr = p.input.throttle;
  const ab = fl.afterburner > 0.02;
  const stage = ab ? Math.max(1, Math.min(5, Math.ceil(((thr - AB_DETENT) / (1 - AB_DETENT)) * 5))) : 0;
  pen.text(ab ? 'AB ' + stage : thr >= AB_DETENT - 0.02 ? 'MIL' : thr < 0.08 ? 'IDLE' : 'THR ' + Math.round((thr / AB_DETENT) * 100), x + 12, y + 22, ab ? PC.amber : PC.green, 28, 'left');
  const tit = 520 + n2 * 5.6 + fl.afterburner * 90 + (fire ? 250 : 0);
  if (fire && d.flash) pen.text('ENG FIRE', x + w - 12, y + 22, PC.red, 26, 'right');
  else if (p.damage.engine > 0.05) pen.text('DMG ' + Math.round(p.damage.engine * 100) + '%', x + w - 12, y + 22, PC.amber, 24, 'right');
  row(pen, x, y + 190, w, 'TIT °C', String(Math.round(tit / 5) * 5), tit > 1150 ? PC.amber : PC.value);
  row(pen, x, y + 224, w, 'THRUST', (fl.thrust * 0.2248 / 1000).toFixed(1) + 'K', PC.value);
  row(pen, x, y + 258, w, 'NOZ %', String(Math.round(ab ? 60 + fl.afterburner * 40 : 25 + (1 - Math.min(1, thr / AB_DETENT)) * 20)), PC.value);
};

/* ───────────────────────── ICAWS ───────────────────────── */

const ORDER = (Object.keys(WARNING_INFO) as WarningId[]).sort((a, b) => WARNING_INFO[a].order - WARNING_INFO[b].order);

export const drawIcawsPage: PageFn = (pen, x, y, w, h, d) => {
  const p = d.p;
  let yy = y + 22;
  let n = 0;
  for (const id of ORDER) {
    if (!p.warnings.has(id)) continue;
    const info = WARNING_INFO[id];
    const col = info.level === 2 ? PC.red : info.level === 1 ? PC.amber : PC.cyan;
    const flashOff = info.level === 2 && !d.flash;
    pen.setFill(info.level === 2 ? 'rgba(255,69,56,0.18)' : 'rgba(255,181,46,0.12)');
    pen.g.fillRect(x + 6, yy - 16, w - 12, 32);
    pen.setFill(col);
    pen.g.fillRect(x + 6, yy - 16, 6, 32);
    if (!flashOff) pen.text(info.label, x + 20, yy, col, 25, 'left');
    yy += 38;
    if (++n >= 6) break;
  }
  if (n === 0) {
    pen.text('NO FAULTS', x + w / 2, y + 28, PC.green, 30);
    yy = y + 64;
  }
  // subsystem status
  const hp = p.maxHealth > 0 ? p.health / p.maxHealth : 1;
  const dm = p.damage;
  yy += 6;
  row(pen, x, yy, w, 'AIRFRAME', Math.round(hp * 100) + '%', hp < 0.4 ? PC.red : hp < 0.75 ? PC.amber : PC.green);
  row(pen, x, yy + 32, w, 'ENGINE', Math.round((1 - dm.engine) * 100) + '%', dm.engine > 0.5 ? PC.red : dm.engine > 0.05 ? PC.amber : PC.green);
  row(pen, x, yy + 64, w, 'HYD', Math.round((1 - dm.hydraulics) * 100) + '%', dm.hydraulics > 0.5 ? PC.red : dm.hydraulics > 0.05 ? PC.amber : PC.green);
  row(pen, x, yy + 96, w, 'AVIONICS', Math.round((1 - dm.avionics) * 100) + '%', dm.avionics > 0.5 ? PC.red : dm.avionics > 0.05 ? PC.amber : PC.green);
};

/* ───────────────────────── RWR / EW ───────────────────────── */

const RWR_MAX = 24;
const rwrB = new Float32Array(RWR_MAX);
const rwrR = new Float32Array(RWR_MAX);
/** Minimum radial separation between co-bearing RWR symbols (texels; symbols are ~40 texels wide). */
const RWR_SEP = 36;

/**
 * RWR declutter (pure): radius for a symbol at `bearing` so its centre keeps RWR_SEP from every symbol
 * already placed (co-bearing emitters are offset radially: the preferred radius, then inward / outward
 * steps inside [0.2R, 0.95R]).
 */
export function rwrDeclutter(bearing: number, r: number, R: number, n: number, bs: ArrayLike<number> = rwrB, rs: ArrayLike<number> = rwrR): number {
  const sb = Math.sin(bearing);
  const cb = Math.cos(bearing);
  // nearest placed symbol (squared distance) for a candidate radius
  const nearest = (rr: number): number => {
    let m = Infinity;
    for (let i = 0; i < n; i++) {
      const dx = sb * rr - Math.sin(bs[i]) * rs[i];
      const dy = cb * rr - Math.cos(bs[i]) * rs[i];
      m = Math.min(m, dx * dx + dy * dy);
    }
    return m;
  };
  const sep2 = RWR_SEP * RWR_SEP;
  let best = r;
  let bestD = nearest(r);
  if (bestD >= sep2) return r;
  // symbols closer than RWR_SEP clash: try radial offsets; a crowded scope keeps the least-bad one
  const step = RWR_SEP / 4;
  for (let k = 1; k <= 24; k++) {
    const rr = r + (k % 2 === 1 ? -1 : 1) * Math.ceil(k / 2) * step;
    if (rr < R * 0.15 || rr > R * 0.98) continue;
    const d = nearest(rr);
    if (d >= sep2) return rr;
    if (d > bestD) {
      bestD = d;
      best = rr;
    }
  }
  return best;
}

export const drawRwrPage: PageFn = (pen, x, y, w, h, d) => {
  const p = d.p;
  const g = pen.g;
  const cx = x + w / 2;
  const cy = y + h * 0.44;
  const R = Math.min(w * 0.42, h * 0.37);
  // rings + ticks
  pen.begin();
  pen.circle(cx, cy, R);
  pen.circle(cx, cy, R * 0.5);
  pen.strokePlain(PC.frame, 2.5);
  pen.begin();
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const r0 = i % 3 === 0 ? R - 12 : R - 6;
    pen.line(cx + Math.sin(a) * r0, cy - Math.cos(a) * r0, cx + Math.sin(a) * R, cy - Math.cos(a) * R);
  }
  pen.strokePlain(PC.dim, 2.5);
  // ownship
  pen.begin();
  g.moveTo(cx, cy - 9);
  g.lineTo(cx + 7, cy + 7);
  g.lineTo(cx - 7, cy + 7);
  g.closePath();
  pen.fillPlain(PC.value);
  let launch = false;
  let placed = 0;
  for (const c of p.rwr) {
    let r = R * (0.95 - 0.7 * Math.max(0, Math.min(1, c.strength)));
    // standard RWR declutter: emitters within 8° of an already placed one are offset radially
    r = rwrDeclutter(c.bearing, r, R, placed);
    if (placed < RWR_MAX) {
      rwrB[placed] = c.bearing;
      rwrR[placed] = r;
      placed++;
    }
    const sx = cx + Math.sin(c.bearing) * r;
    const sy = cy - Math.cos(c.bearing) * r;
    const col = c.state === 'launch' ? PC.red : c.state === 'track' ? PC.amber : PC.green;
    if (c.state === 'launch') launch = true;
    if (c.state === 'launch' && !d.flash) continue;
    pen.begin();
    if (c.state === 'launch') pen.circle(sx, sy, 19);
    else if (c.state === 'track') pen.diamond(sx, sy, 20);
    else if (c.age < 3) pen.arc(sx, sy, 17, Math.PI, Math.PI * 2);
    pen.strokePlain(col, 3);
    pen.text(c.symbol || 'U', sx, sy + 1, col, 24);
  }
  for (const m of p.incoming) {
    const r = R * Math.max(0.12, Math.min(0.95, m.timeToImpact / 20));
    const sx = cx + Math.sin(m.bearing) * r;
    const sy = cy - Math.cos(m.bearing) * r;
    pen.begin();
    g.moveTo(sx, sy - 10);
    g.lineTo(sx + 9, sy + 7);
    g.lineTo(sx - 9, sy + 7);
    g.closePath();
    pen.fillPlain(m.guidance === 'ir' ? '#ff8a1c' : PC.red);
  }
  const emit = p.rwr.length + ' EMIT';
  pen.text(emit, x + 10, y + 19, PC.label, PCD_CORNER, 'left');
  // LAUNCH / EMCON top right; on the next row, on a plate over the scope, when it can't sit beside
  // "n EMIT" with two ems between them (1.2-e: "2 EMITLAUNCH", LAUNCH clipped at the portal edge)
  const tag = launch ? 'LAUNCH' : !p.radar.emitting ? 'EMCON' : '';
  if (tag && (!launch || d.flash)) {
    const tw = pen.textWidth(tag, PCD_CORNER);
    const oneRow = pen.textWidth(emit, PCD_CORNER) + tw + 2 * PCD_CORNER + 20 <= w;
    const ty = oneRow ? y + 19 : y + 19 + PCD_CORNER + 2;
    if (!oneRow) {
      pen.setFill(PC.portal);
      g.fillRect(x + w - 14 - tw, ty - PCD_CORNER * 0.55, tw + 8, PCD_CORNER * 1.1);
    }
    pen.text(tag, x + w - 10, ty, launch ? PC.red : PC.amber, PCD_CORNER, 'right');
  }
};

export const PAGE_FNS: Record<PageId, PageFn> = {
  TSD: drawTsdPage,
  RDR: drawRadarPage,
  SMS: drawSmsPage,
  FUEL: drawFuelPage,
  ENG: drawEngPage,
  ICAWS: drawIcawsPage,
  RWR: drawRwrPage,
};


