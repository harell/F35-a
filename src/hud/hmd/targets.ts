/**
 * Conformal target symbology: sensor tracks (hostile air boxes, ground diamonds, SAM threat symbols),
 * the target designator (TD) box with range / type / missile time-to-impact, lock-on progress ring and
 * lock diamond, the off-screen target cue, friendly markers, the steering waypoint and own missiles.
 * Every tappable symbol is registered for pick().
 */
import { RAD, toNm } from '../../core/math';
import type { AnyEntity, MissileEntity, SamSiteEntity } from '../../sim/entities';
import { AIRCRAFT_SHORT, NumText, entityLabel, mmss } from './format';
import { blink, type HudFrame } from './frame';
import { withAlpha } from './palette';
import { edgeOfEllipse } from './projector';

/** Max distance (m) at which ground targets / friendlies are drawn on the HMD. */
const GROUND_RANGE = 30_000;
const SAM_RANGE = 70_000;
const FRIEND_RANGE = 35_000;

const rangeTxt = new NumText(1);
const rangeTxtInt = new NumText(0);
const wpDist = new NumText(1, '', ' NM');
const mTxt = new NumText(0, 'M ');
const offTxt = new NumText(0, '', '°');
const edge = { x: 0, y: 0 };

/** Range label in nm: one decimal below 10 nm. */
export function rangeLabel(m: number): string {
  const nm = toNm(m);
  return nm < 10 ? rangeTxt.get(nm) : rangeTxtInt.get(nm);
}

const rangeNmTxt = new NumText(1, '', ' NM');
const rangeNmTxtInt = new NumText(0, '', ' NM');
/** "12.4 NM" / "18 NM" (cached strings). */
export function rangeLabelNm(m: number): string {
  const nm = toNm(m);
  return nm < 10 ? rangeNmTxt.get(nm) : rangeNmTxtInt.get(nm);
}

/** Screen position of an entity (uses the live entity position when the track is fresh). */
function project(f: HudFrame, e: AnyEntity): boolean {
  return f.proj.point(e.position, f.sp);
}

/**
 * Is the last projected point (f.sp) drawable for a conformal symbol? Keeps symbols off the cockpit
 * panel (cockpit view) and out of the heading-tape band (HMD).
 */
function drawable(f: HudFrame): boolean {
  const sp = f.sp;
  if (!sp.front || !sp.onScreen) return false;
  if (f.mode !== 'hmd') return true;
  if (f.cockpit && sp.y > f.L.cockpitTop + 4) return false;
  return sp.y > f.L.tapeY + 44 * f.L.u;
}

/** Apparent half-size (px) of an entity for its box (never smaller than `min`). */
function boxHalf(f: HudFrame, e: AnyEntity, min: number): number {
  const px = (e.radius / Math.max(1, f.sp.depth)) * f.proj.pxPerRad * 1.3;
  return Math.max(min, Math.min(min * 3.5, px));
}

/* ───────────────────────── Sensor tracks ───────────────────────── */

export function drawContacts(f: HudFrame): void {
  const { p, world, pen, pal, L, picks } = f;
  const u = L.u;
  const now = world.time;
  const tid = f.target?.id ?? -1;
  pen.setDash('solid');
  for (const c of p.radar.contacts) {
    if (c.id === tid) continue;
    const e = world.getEntity(c.id);
    if (!e || !e.alive || e.team === p.team) continue;
    if (e.kind !== 'aircraft') continue; // ground / SAM tracks are drawn by drawGroundAndSams
    const stale = now - c.lastSeen > 1.5;
    if (stale) f.proj.point(c.position, f.sp);
    else project(f, e);
    const sp = f.sp;
    if (!drawable(f)) continue;
    const h = boxHalf(f, e, 7 * u);
    pen.setDash(stale ? 'dash' : 'solid');
    pen.begin();
    pen.rect(sp.x - h, sp.y - h, h * 2, h * 2);
    pen.strokeGlow(stale ? pal.dim : pal.main, 1.4);
    pen.setDash('solid');
    const lbl = AIRCRAFT_SHORT[e.type] ?? '';
    if (lbl) pen.text(lbl, sp.x, sp.y + h + 8 * u, pal.dim, 10.5);
    picks.add(e.id, sp.x, sp.y, h);
  }
}

/** Known SAM sites and ground targets (diamonds / threat symbols with type labels). */
export function drawGroundAndSams(f: HudFrame): void {
  const { p, world, pen, pal, L, picks } = f;
  const u = L.u;
  const tid = f.target?.id ?? -1;
  const px = p.position.x;
  const pz = p.position.z;
  // SAMs
  for (const s of world.sams) {
    if (!s.alive || s.team === p.team || s.id === tid) continue;
    if (!s.known && !hasContact(f, s.id)) continue;
    const d = Math.hypot(s.position.x - px, s.position.z - pz);
    if (d > SAM_RANGE) continue;
    project(f, s);
    if (!drawable(f)) continue;
    drawSamSymbol(f, s, f.sp.x, f.sp.y, d);
    picks.add(s.id, f.sp.x, f.sp.y, 9 * u);
  }
  // ground targets (sensor tracks + known intel)
  let labelled = 0;
  for (const g of world.ground) {
    if (!g.alive || g.team === p.team || g.id === tid) continue;
    if (!g.known && !hasContact(f, g.id)) continue;
    const d = Math.hypot(g.position.x - px, g.position.z - pz);
    if (d > GROUND_RANGE) continue;
    project(f, g);
    if (!drawable(f)) continue;
    const r = 6 * u;
    pen.begin();
    pen.diamond(f.sp.x, f.sp.y, r);
    pen.strokeGlow(pal.main, 1.4);
    if (d < 12_000 && labelled < 6) {
      labelled++;
      pen.text(entityLabel(g), f.sp.x, f.sp.y + r + 8 * u, pal.dim, 10);
    }
    picks.add(g.id, f.sp.x, f.sp.y, r);
  }
}

function hasContact(f: HudFrame, id: number): boolean {
  for (const c of f.p.radar.contacts) if (c.id === id) return true;
  return false;
}

/** SAM threat symbol: a "tent" with the type label; red when its radar tracks us. */
export function drawSamSymbol(f: HudFrame, s: SamSiteEntity, x: number, y: number, dist: number): void {
  const { pen, pal, L, p } = f;
  const u = L.u;
  const tracking = s.radarOn && s.trackedTargetId === p.id;
  const inRing = dist < (s.engageRange ?? 20_000);
  const col = tracking ? pal.danger : inRing ? pal.warn : withAlpha(pal.warn, 0.8);
  const w = 8 * u;
  pen.begin();
  const g = pen.g;
  g.moveTo(x - w, y + w * 0.6);
  g.lineTo(x, y - w * 0.7);
  g.lineTo(x + w, y + w * 0.6);
  pen.line(x - w * 0.4, y + w * 0.6, x + w * 0.4, y + w * 0.6);
  pen.strokeGlow(col, 1.6);
  if (!(tracking && !blink(f, 2.5, 0.7))) pen.text(entityLabel(s), x, y + w + 7 * u, col, 10.5);
}

/* ───────────────────────── Designated target ───────────────────────── */

export function drawDesignated(f: HudFrame): void {
  const t = f.target;
  if (!t) return;
  const { p, pen, pal, L, picks, st } = f;
  const u = L.u;
  const sp = f.sp;
  const visible = project(f, t) && sp.onScreen && !(f.mode === 'hmd' && f.cockpit && sp.y > L.cockpitTop + 4);
  const dist = t.position.distanceTo(p.position);
  if (!visible) {
    drawOffscreenCue(f, t, dist);
    return;
  }
  const x = sp.x;
  const y = sp.y;
  const h = boxHalf(f, t, 13 * u);
  const col = f.locked ? pal.bright : pal.main;
  pen.setDash('solid');
  // TD box (corner brackets when locked for a crisper look)
  pen.begin();
  if (f.locked) {
    const k = h * 0.45;
    pen.line(x - h, y - h, x - h + k, y - h);
    pen.line(x - h, y - h, x - h, y - h + k);
    pen.line(x + h, y - h, x + h - k, y - h);
    pen.line(x + h, y - h, x + h, y - h + k);
    pen.line(x - h, y + h, x - h + k, y + h);
    pen.line(x - h, y + h, x - h, y + h - k);
    pen.line(x + h, y + h, x + h - k, y + h);
    pen.line(x + h, y + h, x + h, y + h - k);
    pen.diamond(x, y, h * 0.62);
  } else {
    pen.rect(x - h, y - h, h * 2, h * 2);
  }
  pen.strokeGlow(col, 2);
  // lock-on progress ring
  const lp = p.radar.lockProgress;
  if (!f.locked && lp > 0.01 && t.kind === 'aircraft') {
    pen.begin();
    pen.arc(x, y, h * 1.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, lp));
    pen.strokeGlow(pal.main, 2.2);
  }
  // labels: type above, range below, missile TOF / PITBULL below that
  pen.text(entityLabel(t), x, y - h - 9 * u, col, 12);
  let ly = y + h + 10 * u;
  pen.text(rangeLabel(dist), x, ly, col, 12.5);
  ly += 14 * u;
  const m = ownMissileOn(f, t.id);
  if (m) {
    const tti = timeToImpact(f, m, t);
    const pit = m.seekerLocked && (m.def.guidance === 'active_radar' || m.def.guidance === 'anti_radiation');
    if (pit) {
      if (blink(f, 3, 0.75)) pen.text('PITBULL', x, ly, pal.bright, 11.5);
    } else pen.text(mTxt.get(Math.max(0, Math.ceil(tti))), x, ly, pal.main, 11.5);
    ly += 14 * u;
  }
  // "LOCK" flash right after the lock event
  if (f.locked && st.lockAge < 1.4 && blink(f, 5)) pen.text('LOCK', x + h + 8 * u, y, pal.bright, 13, 'left');
  picks.add(t.id, x, y, h);
}

/** Arrow on the screen-edge ellipse pointing at an off-screen target, with angle-off and label. */
function drawOffscreenCue(f: HudFrame, t: AnyEntity, dist: number): void {
  const { pen, pal, L } = f;
  const u = L.u;
  const sp = f.sp;
  edgeOfEllipse(L.edgeCx, L.edgeCy, L.edgeRx * 0.92, L.edgeRy * 0.8, sp.dirX, sp.dirY, edge);
  // keep the cue out of the cockpit panel in cockpit view
  if (f.cockpit && f.mode === 'hmd') edge.y = Math.min(edge.y, L.cockpitTop - 24 * u);
  const col = f.locked ? pal.bright : pal.main;
  pen.setDash('solid');
  pen.begin();
  pen.arrow(edge.x + sp.dirX * 10 * u, edge.y + sp.dirY * 10 * u, sp.dirX, sp.dirY, 14 * u, 7 * u);
  pen.strokeGlow(col, 1.8);
  pen.fillPlain(withAlpha(col, 0.35));
  const tx = edge.x - sp.dirX * 20 * u;
  const ty = edge.y - sp.dirY * 16 * u;
  pen.text(offTxt.get(sp.offAxis * RAD), tx, ty, col, 12.5);
  pen.text(entityLabel(t), tx, ty + 13 * u, pal.dim, 10.5);
  pen.text(rangeLabel(dist), tx, ty + 25 * u, pal.dim, 10.5);
}

/** Newest live player missile guiding on `targetId`. */
function ownMissileOn(f: HudFrame, targetId: number): MissileEntity | null {
  let best: MissileEntity | null = null;
  for (const m of f.world.missiles) {
    if (!m.alive || m.shooterId !== f.p.id || m.targetId !== targetId) continue;
    if (!best || m.age < best.age) best = m;
  }
  return best;
}

function timeToImpact(f: HudFrame, m: MissileEntity, t: AnyEntity): number {
  const r = f.v1.subVectors(t.position, m.position);
  const d = r.length();
  if (d < 1) return 0;
  const closing = -f.v2.subVectors(t.velocity, m.velocity).dot(r) / d;
  return d / Math.max(80, closing);
}

/* ───────────────────────── Own missiles in flight ───────────────────────── */

export function drawOwnMissiles(f: HudFrame): void {
  const { world, p, pen, pal, L } = f;
  const u = L.u;
  pen.setDash('solid');
  pen.begin();
  let any = false;
  for (const m of world.missiles) {
    if (!m.alive || m.shooterId !== p.id) continue;
    f.proj.point(m.position, f.sp);
    if (!drawable(f)) continue;
    pen.circle(f.sp.x, f.sp.y, 3.5 * u);
    any = true;
  }
  if (any) pen.strokeGlow(pal.main, 1.3);
}

/* ───────────────────────── Friendlies ───────────────────────── */

export function drawFriendlies(f: HudFrame): void {
  const { world, p, pen, pal, L } = f;
  const u = L.u;
  pen.setDash('solid');
  for (const a of world.aircraft) {
    if (!a.alive || a === p || a.team !== p.team) continue;
    const d = a.position.distanceTo(p.position);
    if (d > FRIEND_RANGE) continue;
    f.proj.point(a.position, f.sp);
    if (!drawable(f)) continue;
    const r = Math.max(5 * u, Math.min(14 * u, (a.radius / Math.max(1, f.sp.depth)) * f.proj.pxPerRad));
    pen.begin();
    pen.arc(f.sp.x, f.sp.y, r, Math.PI, Math.PI * 2);
    pen.line(f.sp.x - r, f.sp.y, f.sp.x + r, f.sp.y);
    pen.strokeGlow(pal.friend, 1.5);
    if (d < 15_000) pen.text(a.callsign || a.name, f.sp.x, f.sp.y - r - 8 * u, pal.friend, 10);
  }
}

/* ───────────────────────── Steering waypoint ───────────────────────── */

export function drawWaypoint(f: HudFrame): void {
  const wp = f.ctx.mission?.currentWaypoint;
  if (!wp) return;
  const { p, pen, pal, L } = f;
  const u = L.u;
  f.proj.point(wp.position, f.sp);
  if (!drawable(f)) return;
  const x = f.sp.x;
  const y = f.sp.y;
  const r = 7 * u;
  pen.setDash('solid');
  pen.begin();
  pen.diamond(x, y, r);
  pen.line(x, y - r, x, y - r - 5 * u);
  pen.strokeGlow(pal.main, 1.6);
  const dx = wp.position.x - p.position.x;
  const dz = wp.position.z - p.position.z;
  const d = Math.hypot(dx, dz);
  const gs = Math.max(30, Math.hypot(p.velocity.x, p.velocity.z));
  pen.text(wp.label || wp.id, x, y - r - 14 * u, pal.main, 11);
  pen.text(wpDist.get(toNm(d)), x, y + r + 9 * u, pal.dim, 10.5);
  pen.text(mmss(d / gs), x, y + r + 21 * u, pal.dim, 10.5);
}

/** Bearing (rad, true) to the current waypoint, or null. */
export function waypointBearing(f: HudFrame): number | null {
  const wp = f.ctx.mission?.currentWaypoint;
  if (!wp) return null;
  const dx = wp.position.x - f.p.position.x;
  const dz = wp.position.z - f.p.position.z;
  if (Math.hypot(dx, dz) < 1) return null;
  let b = Math.atan2(dx, -dz);
  if (b < 0) b += Math.PI * 2;
  return b;
}
