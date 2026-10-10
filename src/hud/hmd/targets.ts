/**
 * Conformal target symbology: sensor tracks (hostile air boxes, ground diamonds, SAM threat symbols),
 * the target designator (TD) box with range / type / missile time-to-impact, lock-on progress ring and
 * lock diamond, the ±30° lock cone + LOCKING cue, the off-screen target cue, friendly markers (aircraft
 * and the sites to defend), the steering waypoint and own missiles. Every tappable symbol is registered
 * for pick(); the TD box and its labels are registered as protected (text never covers them) and
 * secondary labels (contact types, waypoint name) are skipped or moved when they would collide.
 */
import { RAD, forwardOf, toNm, upOf } from '../../core/math';
import type { AircraftEntity, AnyEntity, MissileEntity, SamSiteEntity } from '../../sim/entities';
import { civilHidden } from '../../sim/entities';
import { PLAYER_LOCK_CONE } from '../../sim/sensors/Sensors';
import { acState } from '../../sim/weapons/context';
import { MUNITIONS } from '../../sim/weapons/defs';
import { glideTimeToGo, type MunitionDefLike } from '../../sim/weapons/dlz';
import { NumText, WEAPON_IS_BOMB, entityLabel, mmss, trackLabel, trackShort } from './format';
import { altColumnBottom, speedColumnBottom, zoneExt } from './zones';
import { hitsBankOrWaterline } from './flight';
import { ownMissileOn, reticle } from './weapons';
import { blink, type HudFrame } from './frame';
import { withAlpha } from './palette';
import { edgeOfEllipse } from './projector';
import { controlRects } from './layout';
import { protectedSites } from './sites';
import { TEST_HOOKS } from '../../core/data';
import { noteSteer, noteSteerDiamond, noteSteerName } from './drawn';
import { inDasWindow } from '../cockpit/das';

/** Max distance (m) at which ground targets / friendlies are drawn on the HMD. */
const GROUND_RANGE = 30_000;
const SAM_RANGE = 70_000;
const FRIEND_RANGE = 35_000;

const rangeTxt = new NumText(1);
const rangeTxtInt = new NumText(0);
const wpDist = new NumText(1, '', ' NM');
// missile time to impact: 'T', not 'M' (Mach in the speed column; playtest 1.2-n)
const mTxt = new NumText(0, 'T ');
const ttiTxt = new NumText(0, 'TTI ');
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
  // behind the panel: only through the DAS window (#116)
  if (f.cockpit && sp.y > f.L.cockpitTop + 4) return inDasWindow(sp.x, sp.y);
  return sp.y > f.L.tapeY + 44 * f.L.u;
}

/** Apparent half-size (px) of an entity for its box (never smaller than `min`). */
function boxHalf(f: HudFrame, e: AnyEntity, min: number): number {
  const px = (e.radius / Math.max(1, f.sp.depth)) * f.proj.pxPerRad * 1.3;
  return Math.max(min, Math.min(min * 3.5, px));
}

/* ───────────────────────── Symbol boxes for the centre cues ───────────────────────── */

/**
 * Register into f.sym the boxes of the conformal symbols drawn after the centre cues are planned (air
 * contact boxes, ground diamonds, SAM tents, the sites to defend, the steering waypoint), with the
 * draw functions' own projection and visibility rules: IN RANGE / SHOOT never print over one
 * (playtest 2.2-a: "IN□RANGE" over a contact box near the boresight), and the friendly markers. Call
 * before drawDesignated (its off-screen cue dodges them too) and planCues.
 */
export function reserveSymbols(f: HudFrame): void {
  const { p, world, L, sym } = f;
  const u = L.u;
  sym.clear();
  const tid = f.target?.id ?? -1;
  const now = world.time;
  for (const c of p.radar.contacts) {
    if (c.id === tid) continue;
    const e = world.getEntity(c.id);
    if (!e || !e.alive || e.team === p.team || e.kind !== 'aircraft') continue;
    if (now - c.lastSeen > 1.5) f.proj.point(c.position, f.sp);
    else project(f, e);
    if (!drawable(f)) continue;
    const h = boxHalf(f, e, 7 * u) + 2 * u;
    sym.addBox(f.sp.x, f.sp.y, h, h);
  }
  const px = p.position.x;
  const pz = p.position.z;
  for (const s of world.sams) {
    if (!s.alive || s.team === p.team || s.id === tid || (!s.known && !hasContact(f, s.id))) continue;
    if (Math.hypot(s.position.x - px, s.position.z - pz) > SAM_RANGE) continue;
    project(f, s);
    if (drawable(f)) sym.addBox(f.sp.x, f.sp.y, 10 * u, 8 * u);
  }
  for (const g of world.ground) {
    if (!g.alive || g.team === p.team || g.id === tid || (!g.known && !hasContact(f, g.id))) continue;
    if (Math.hypot(g.position.x - px, g.position.z - pz) > GROUND_RANGE) continue;
    project(f, g);
    if (drawable(f)) sym.addBox(f.sp.x, f.sp.y, 8 * u, 8 * u);
  }
  for (const site of protectedSites(f.ctx.mission, world, p.team)) {
    if (Math.hypot(site.x - px, site.z - pz) > SAM_RANGE) continue;
    f.v1.set(site.x, site.y, site.z);
    f.proj.point(f.v1, f.sp);
    if (drawable(f)) sym.addBox(f.sp.x, f.sp.y, 9 * u, 9 * u);
  }
  const wp = f.ctx.mission?.currentWaypoint;
  if (wp) {
    f.proj.point(wp.position, f.sp);
    if (drawable(f)) sym.add(f.sp.x - 9 * u, f.sp.y - 14 * u, f.sp.x + 9 * u, f.sp.y + 9 * u);
  }
  // wingmen and friendly traffic (their half-circle marker): the off-screen cue's text dodges them too
  // (playtest 1.2-l: a wingman marker over the cue's range)
  for (const a of world.aircraft) {
    if (!a.alive || a === p || a.team !== p.team) continue;
    if (a.position.distanceToSquared(p.position) > FRIEND_RANGE * FRIEND_RANGE) continue;
    f.proj.point(a.position, f.sp);
    if (!drawable(f)) continue;
    const r = friendRadius(f, a);
    sym.add(f.sp.x - r - 2 * u, f.sp.y - r - 2 * u, f.sp.x + r + 2 * u, f.sp.y + 3 * u);
  }
}

/** Friendly marker radius (px) at the last projected point. */
function friendRadius(f: HudFrame, a: AircraftEntity): number {
  const u = f.L.u;
  return Math.max(5 * u, Math.min(14 * u, (a.radius / Math.max(1, f.sp.depth)) * f.proj.pxPerRad));
}

/* ───────────────────────── Sensor tracks ───────────────────────── */

export function drawContacts(f: HudFrame): void {
  const { p, world, pen, pal, L, picks } = f;
  const u = L.u;
  const now = world.time;
  const tid = f.target?.id ?? -1;
  // text labels only on the two nearest contacts (plus the designated target): the rest keep their box.
  // Civil traffic likewise: the two nearest say CIV, the rest keep their white box (a stack of CIV labels
  // over the city: playtest 1.2-o)
  let d1 = Infinity;
  let d2 = Infinity;
  let c1 = Infinity;
  let c2 = Infinity;
  for (const c of p.radar.contacts) {
    if (c.id === tid) continue;
    const e = world.getEntity(c.id);
    if (!e || !e.alive || e.team === p.team || e.kind !== 'aircraft' || civilHidden(p, e)) continue;
    const d = c.position.distanceToSquared(p.position);
    if (e.team === 'neutral') {
      if (d < c1) {
        c2 = c1;
        c1 = d;
      } else if (d < c2) c2 = d;
      continue;
    }
    if (d < d1) {
      d2 = d1;
      d1 = d;
    } else if (d < d2) d2 = d;
  }
  pen.setDash('solid');
  for (const c of p.radar.contacts) {
    if (c.id === tid) continue;
    const e = world.getEntity(c.id);
    if (!e || !e.alive || e.team === p.team || civilHidden(p, e)) continue;
    if (e.kind !== 'aircraft') continue; // ground / SAM tracks are drawn by drawGroundAndSams
    // civil traffic: white box, always labelled CIV so it is never mistaken for a bandit
    const civil = e.team === 'neutral';
    // (a tagged jet, e.g. a STRK striker, is always labelled: it's the one to tell from its escort)
    const labelled = !!e.hudTag || c.position.distanceToSquared(p.position) <= (civil ? c2 : d2);
    const stale = now - c.lastSeen > 1.5;
    if (stale) f.proj.point(c.position, f.sp);
    else project(f, e);
    const sp = f.sp;
    if (!drawable(f)) continue;
    const h = boxHalf(f, e, 7 * u);
    pen.setDash(stale ? 'dash' : 'solid');
    pen.begin();
    pen.rect(sp.x - h, sp.y - h, h * 2, h * 2);
    pen.strokeGlow(civil ? pal.white : stale ? pal.dim : pal.main, 1.4);
    pen.setDash('solid');
    // engaged: our missile is in flight at it — a flag in the box's top-right corner, and its time to
    // impact ("T 12") beside the box where it fits, so a swarm shows which drones are already taken
    const m = civil ? null : ownMissileOn(f, e.id);
    if (m) drawEngaged(f, m, e, sp.x, sp.y, h);
    const lbl = labelled ? trackShort(e) : '';
    if (lbl) {
      const lw = pen.textWidth(lbl, 10.5) / 2 + 2;
      const ly = sp.y + h + 8 * u;
      if (!f.occ.hits(sp.x - lw, ly - 6 * u, sp.x + lw, ly + 6 * u)) {
        pen.text(lbl, sp.x, ly, civil ? pal.white : pal.dim, 10.5);
        f.occ.add(sp.x - lw, ly - 6 * u, sp.x + lw, ly + 6 * u);
      }
    }
    picks.add(e.id, sp.x, sp.y, h);
  }
}

/**
 * Engaged marker on a (non-designated) contact box: a filled corner flag, always, and "T n" (the newest
 * missile's time to impact) right of the box, or left of it, wherever no reserved text or symbol is.
 */
function drawEngaged(f: HudFrame, m: MissileEntity, e: AnyEntity, x: number, y: number, h: number): void {
  const { pen, pal, L, occ } = f;
  const u = L.u;
  const k = Math.min(6 * u, h * 0.8);
  const g = pen.g;
  pen.begin();
  g.moveTo(x + h, y - h);
  g.lineTo(x + h - k, y - h);
  g.lineTo(x + h, y - h + k);
  g.closePath();
  pen.fillPlain(pal.main);
  const txt = impactLabel(f, m, e);
  const tw = pen.textWidth(txt, 10);
  const ty = y - h + 4 * u;
  const gap = 3 * u;
  for (let side = 0; side < 2; side++) {
    const x0 = side === 0 ? x + h + gap : x - h - gap - tw;
    if (occ.hits(x0 - 1, ty - 6 * u, x0 + tw + 1, ty + 6 * u)) continue;
    pen.text(txt, side === 0 ? x0 : x0 + tw, ty, pal.main, 10, side === 0 ? 'left' : 'right');
    occ.add(x0 - 1, ty - 6 * u, x0 + tw + 1, ty + 6 * u);
    return;
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
  // ground targets (sensor tracks + known intel); civil ships: the two nearest say CIV (1.2-o)
  let labelled = 0;
  let c1 = Infinity;
  let c2 = Infinity;
  for (const g of world.ground) {
    if (!g.alive || g.team !== 'neutral' || g.id === tid || civilHidden(p, g) || (!g.known && !hasContact(f, g.id))) continue;
    const d = Math.hypot(g.position.x - px, g.position.z - pz);
    if (d < c1) {
      c2 = c1;
      c1 = d;
    } else if (d < c2) c2 = d;
  }
  for (const g of world.ground) {
    if (!g.alive || g.team === p.team || g.id === tid || civilHidden(p, g)) continue;
    if (!g.known && !hasContact(f, g.id)) continue;
    const d = Math.hypot(g.position.x - px, g.position.z - pz);
    if (d > GROUND_RANGE) continue;
    project(f, g);
    if (!drawable(f)) continue;
    const r = 6 * u;
    // civil ships: white box, always labelled CIV (like civil air traffic), never a threat diamond
    const civil = g.team === 'neutral';
    pen.begin();
    if (civil) pen.rect(f.sp.x - r, f.sp.y - r, r * 2, r * 2);
    else pen.diamond(f.sp.x, f.sp.y, r);
    pen.strokeGlow(civil ? pal.white : pal.main, 1.4);
    if (civil ? d <= c2 : d < 12_000 && labelled < 4) {
      const t = entityLabel(g);
      if (placeLabel(f, t, 10, f.sp.x, f.sp.y + r + 8 * u, f.sp.y - r - 8 * u)) {
        if (!civil) labelled++;
        pen.text(t, lblPos.x, lblPos.y, civil ? pal.white : pal.dim, 10);
      }
    }
    picks.add(g.id, f.sp.x, f.sp.y, r);
  }
  drawProtectedSites(f);
}

/**
 * Friendly sites the mission asks us to defend (sites.ts): a friendly circle-and-square at the
 * survivors' centroid with "DEFEND 8/9". Never pickable (friendlies can't be designated).
 */
function drawProtectedSites(f: HudFrame): void {
  const { p, pen, pal, L, occ } = f;
  const u = L.u;
  for (const site of protectedSites(f.ctx.mission, f.world, p.team)) {
    if (Math.hypot(site.x - p.position.x, site.z - p.position.z) > SAM_RANGE) continue;
    f.v1.set(site.x, site.y, site.z);
    f.proj.point(f.v1, f.sp);
    if (!drawable(f)) continue;
    let x = f.sp.x;
    let y = f.sp.y;
    const r = 7 * u;
    // external views: never on the jet silhouette (playtest 2.2-b: on the chase view's right wing, with
    // its label squeezed out): slid to the nearest clear spot beside / below / above it
    if (f.mode === 'external' && clearOfProtected(f, x, y, r + 2 * u)) {
      x = clearPos.x;
      y = clearPos.y;
    }
    pen.setDash('solid');
    pen.begin();
    pen.circle(x, y, r);
    pen.rect(x - 2.5 * u, y - 2.5 * u, 5 * u, 5 * u);
    pen.strokeGlow(pal.friend, 1.6);
    occ.addBox(x, y, r + 1, r + 1);
    // below / above the symbol, else beside it (the one label here that matters more than a type tag),
    // else clamped beside it at the nearest free height: the count never vanishes
    const side = r + 6 * u + pen.textWidth(site.label, 10.5) / 2;
    if (
      placeLabel(f, site.label, 10.5, x, y + r + 8 * u, y - r - 8 * u) ||
      placeLabel(f, site.label, 10.5, x + side, y, y) ||
      placeLabel(f, site.label, 10.5, x - side, y, y) ||
      placeLabelNear(f, site.label, 10.5, x + side, y, 34 * u) ||
      placeLabelNear(f, site.label, 10.5, x - side, y, 34 * u)
    ) {
      pen.text(site.label, lblPos.x, lblPos.y, pal.friend, 10.5);
    }
  }
}

const clearPos = { x: 0, y: 0 };
/**
 * Does the centred box (x, y, ±half) sit on a protected symbol (the jet in external views, the TD
 * box)? Then clearPos = the nearest centre, in 4 px steps beside / below / above, where it doesn't
 * (true), or the box is already clear / no spot within 120 px (false).
 */
function clearOfProtected(f: HudFrame, x: number, y: number, half: number): boolean {
  const { occ, L } = f;
  if (!occ.hits(x - half, y - half, x + half, y + half, 1)) return false;
  for (let d = 4; d <= 120; d += 4) {
    for (let k = 0; k < 4; k++) {
      const cx = k === 0 ? x + d : k === 1 ? x - d : x;
      const cy = k === 2 ? y + d : k === 3 ? y - d : y;
      if (cx - half < L.left || cx + half > L.right || cy - half < L.row2Y || cy + half > L.H) continue;
      if (!occ.hits(cx - half, cy - half, cx + half, cy + half, 1)) {
        clearPos.x = cx;
        clearPos.y = cy;
        return true;
      }
    }
  }
  return false;
}

/**
 * Last-resort label spot: centred on (x, ·) at the free height nearest `y` within ±`reach` (writes
 * lblPos and registers the rect like placeLabel). False = still no room.
 */
function placeLabelNear(f: HudFrame, text: string, size: number, x: number, y: number, reach: number): boolean {
  const { pen, occ, L } = f;
  const u = L.u;
  const hw = pen.textWidth(text, size) / 2 + 2 * u;
  const hh = (size * 0.5 + 1.5) * u;
  const lx = Math.max(L.left + hw, Math.min(L.right - hw, x));
  const top = occ.freeY(lx - hw, lx + hw, hh * 2, y - hh, Math.max(L.row2Y, y - reach - hh), Math.min(L.H, y + reach + hh));
  if (!Number.isFinite(top)) return false;
  occ.add(lx - hw, top, lx + hw, top + hh * 2);
  lblPos.x = lx;
  lblPos.y = top + hh;
  return true;
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
  const t = entityLabel(s);
  if (!placeLabel(f, t, 10.5, x, y + w + 7 * u, y - w - 7 * u)) return;
  if (!(tracking && !blink(f, 2.5, 0.7))) pen.text(t, lblPos.x, lblPos.y, col, 10.5);
}

const lblPos = { x: 0, y: 0 };
/**
 * Find a free spot for a centred world label: below its symbol, else above it. Registers the chosen
 * rect (so later labels never merge into it: "CAPSA-10") and writes it to lblPos. False = no room
 * (the symbol stays, the label is left out).
 */
export function placeLabel(f: HudFrame, text: string, size: number, x: number, yBelow: number, yAbove: number): boolean {
  const { pen, occ, L } = f;
  const u = L.u;
  const hw = pen.textWidth(text, size) / 2 + 2 * u;
  const hh = (size * 0.5 + 1.5) * u;
  const lx = Math.max(L.left + hw, Math.min(L.right - hw, x));
  for (let k = 0; k < 2; k++) {
    const ly = k === 0 ? yBelow : yAbove;
    if (!occ.hits(lx - hw, ly - hh, lx + hw, ly + hh)) {
      occ.add(lx - hw, ly - hh, lx + hw, ly + hh);
      lblPos.x = lx;
      lblPos.y = ly;
      return true;
    }
  }
  return false;
}

/* ───────────────────────── Designated target ───────────────────────── */

export function drawDesignated(f: HudFrame): void {
  const t = f.target;
  if (!t) return;
  const { p, pen, pal, L, picks, st, occ } = f;
  const u = L.u;
  const sp = f.sp;
  const visible = project(f, t) && sp.onScreen && !(f.mode === 'hmd' && f.cockpit && sp.y > L.cockpitTop + 4 && !inDasWindow(sp.x, sp.y));
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
  // lock-on progress ring + LOCKING
  const lp = p.radar.lockProgress;
  const building = !f.locked && lp > 0.01 && t.kind === 'aircraft';
  if (building) {
    pen.begin();
    pen.arc(x, y, h * 1.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, lp));
    pen.strokeGlow(pal.main, 2.2);
  }
  // labels: type above, range below, missile TOF / PITBULL below that; range + TOF stack above the
  // type label instead when they would print into reserved text under a low box (the radio pill, 3.3-a),
  // or all below; pushed out from the box when the gun pipper / AIM-9X seeker ring would cut them
  // (3.1-c, 1.2-c). See boxLabelLayout.
  const label = trackLabel(t);
  const m = ownMissileOn(f, t.id);
  const pit = !!m && m.seekerLocked && (m.def.guidance === 'active_radar' || m.def.guidance === 'anti_radiation');
  const tof = m && !pit ? impactLabel(f, m, t) : '';
  const lw = Math.max(h * 1.5, (pen.textWidth(label, 12) / 2) + 2 * u, pen.textWidth('88.8', 12.5) / 2);
  const sw = Math.max(lw, pen.textWidth(pit ? 'PITBULL' : tof, 11.5) / 2);
  const rng = rangeLabel(dist);
  boxLabelLayout(f, x, y, h, sw, !!m);
  // the labels (not the box) slide off the speed / altitude columns (#62: "MIG-29" into "M 0.77", the
  // range into "THR 76%" with the target near the screen side); a column row still under the box or a
  // label dims (colText), so the symbol reads through
  const tw = Math.max(pen.textWidth(label, 12), pen.textWidth(rng, 12.5), pen.textWidth(pit ? 'PITBULL' : tof, 11.5)) / 2 + 2 * u;
  const tx = slideOffColumns(f, x, tw, lay.top - 8 * u, lay.bottom + 8 * u);
  if (Number.isFinite(lay.typeY)) pen.text(label, tx, lay.typeY, col, 12);
  if (Number.isFinite(lay.rngY)) pen.text(rng, tx, lay.rngY, col, 12.5);
  if (m && Number.isFinite(lay.tofY)) {
    if (pit) {
      if (blink(f, 3, 0.75)) pen.text('PITBULL', tx, lay.tofY, pal.bright, 11.5);
    } else pen.text(tof, tx, lay.tofY, pal.main, 11.5);
  }
  // right of the box: "LOCK" flash after the lock event, LOCKING while it builds, NOSE ON when the
  // commanded lock can't build because the target is outside the ±30° lock cone
  // (right of the box, or left of it when the altitude column / screen edge / pipper ring is in the way)
  const side = Math.max(h * 1.5, h + 6 * u) + 6 * u;
  let label2 = '';
  let size2 = 12;
  let col2 = pal.main;
  let show2 = true;
  if (f.locked && st.lockAge < 1.4) {
    label2 = 'LOCK';
    size2 = 13;
    col2 = pal.bright;
    show2 = blink(f, 5);
  } else if (building) {
    label2 = 'LOCKING';
    show2 = blink(f, 2.5, 0.75);
  } else if (!f.locked && t.kind === 'aircraft' && f.lockCommanded && !inLockCone(p, t, f)) {
    label2 = 'NOSE ON';
    col2 = pal.warn;
  }
  let rw = label2 ? pen.textWidth(label2, size2) : 0;
  const rightLimit = f.mode === 'hmd' && y > L.boxY - 30 * u && y < L.boxY + 90 * u && x < L.altLeft ? L.altLeft - 12 * u : L.right;
  // (the left too when the right is under the ring or reserved text, the kill feed, and the left isn't)
  const slotBlocked = (x0: number, x1: number, yc: number) => ringCuts(f, x0, yc - 8 * u, x1, yc + 8 * u) || occ.hits(x0, yc - 8 * u, x1, yc + 8 * u, 0, 0);
  const rightBlocked = rw > 0 && slotBlocked(x + side, x + side + rw, y);
  const leftBlocked = rw > 0 && slotBlocked(x - side - rw, x - side, y);
  const rLeft = rw > 0 && (x + side + rw > rightLimit || (rightBlocked && !leftBlocked));
  let rx = rLeft ? x - side : x + side;
  let ry = y;
  let align: 'left' | 'right' | 'center' = rLeft ? 'right' : 'left';
  // both sides on reserved text (a box under the kill feed, #116): under the label rows, else over
  // them, else left out (the lock ring shows the lock building; LOCK is a moment's flash)
  if (rw > 0 && (rLeft ? leftBlocked : rightBlocked)) {
    const below = lay.bottom + 15 * u;
    const above = lay.top - 15 * u;
    const ok = (yc: number) => !slotBlocked(tx - rw / 2, tx + rw / 2, yc) && yc > L.tapeY + 44 * u && yc < (f.cockpit ? L.cockpitTop : L.H) - 10 * u;
    if (ok(below)) ry = below;
    else if (ok(above)) ry = above;
    else rw = 0;
    rx = tx;
    align = 'center';
  }
  if (label2 && show2 && rw > 0) pen.text(label2, rx, ry, col2, size2, align);
  // protected: the box, its ring and every label (text zones never cover it)
  const hb = building ? h * 1.5 : h;
  const top = Math.min(y - hb - 3 * u, lay.top - 8 * u, rw > 0 ? ry - 8 * u : Infinity);
  const bottom = Math.max(y + hb + 3 * u, lay.bottom + 8 * u, rw > 0 ? ry + 8 * u : -Infinity);
  const r0 = align === 'right' ? rx - rw : align === 'center' ? rx - rw / 2 : rx;
  occ.add(
    Math.min(x - lw - 2 * u, tx - tw - 2 * u, rw > 0 ? r0 - 2 * u : Infinity),
    top,
    Math.max(x + lw + 2 * u, tx + tw + 2 * u, rw > 0 ? r0 + rw + 2 * u : 0),
    bottom,
    1,
  );
  picks.add(t.id, x, y, h);
}

/**
 * The designated box's label rows this frame (centre y of the type label, the range and the missile
 * TOF / PITBULL; NaN = left out), and the rows' top / bottom centre y.
 */
const lay = { typeY: 0, rngY: 0, tofY: NaN, top: 0, bottom: 0 };

/** Layouts boxLabelLayout tries: type above + range below, all above, all below. */
const LAYOUTS = 3;
/** Extra gaps (× u) between the box and its labels, tried after the plain layouts. */
const LABEL_GAPS = [0, 8, 16, 24];

/**
 * Lay the designated box's labels out (into `lay`) against what is already on the screen: reserved text
 * (the radio pill and the target camera window, level 0) and the gun pipper / AIM-9X seeker ring
 * (`reticle`), which cut the drone's name and range as the pipper came onto it (3.1-c). Tries type above
 * + range below, all above, all below, each with the labels pushed 0 / 8 / 16 / 24 u off the box; the
 * first clear one wins, else the first clear of the ring. None: the plain layout, with any row the ring
 * would cut left out (the name is in the PiP and the info block; the gun's range is the pipper's arc).
 */
function boxLabelLayout(f: HudFrame, x: number, y: number, h: number, sw: number, withTof: boolean): void {
  const u = f.L.u;
  // clear of everything, else (a crowded screen) clear of the ring at least
  for (let ringOnly = 0; ringOnly < 2; ringOnly++) {
    for (const g of LABEL_GAPS) {
      for (let k = 0; k < LAYOUTS; k++) {
        setLayout(k, y, h, g * u, withTof, u);
        if (rowBlocked(f, x, sw, lay.typeY, ringOnly) || rowBlocked(f, x, sw, lay.rngY, ringOnly) || (withTof && rowBlocked(f, x, sw, lay.tofY, ringOnly))) continue;
        return;
      }
    }
    if (reticle.frame !== f.st.frame) break;
  }
  setLayout(0, y, h, 0, withTof, u);
  if (ringCuts(f, x - sw, lay.typeY - 7 * u, x + sw, lay.typeY + 7 * u)) lay.typeY = NaN;
  if (ringCuts(f, x - sw, lay.rngY - 7 * u, x + sw, lay.rngY + 7 * u)) lay.rngY = NaN;
  if (withTof && ringCuts(f, x - sw, lay.tofY - 7 * u, x + sw, lay.tofY + 7 * u)) lay.tofY = NaN;
  // (the rows' extent: whatever is left, else the box itself)
  lay.top = Math.min(Number.isFinite(lay.typeY) ? lay.typeY : y, Number.isFinite(lay.rngY) ? lay.rngY : y);
  lay.bottom = Math.max(Number.isFinite(lay.rngY) ? lay.rngY : y, withTof && Number.isFinite(lay.tofY) ? lay.tofY : y);
}

function setLayout(k: number, y: number, h: number, g: number, withTof: boolean, u: number): void {
  const typeY = y - h - 9 * u - g;
  const below = y + h + 10 * u + g;
  if (k === 0) {
    lay.typeY = typeY;
    lay.rngY = below;
    lay.tofY = below + 14 * u;
  } else if (k === 1) {
    lay.typeY = typeY;
    lay.rngY = typeY - 14 * u;
    lay.tofY = typeY - 28 * u;
  } else {
    lay.rngY = below;
    lay.tofY = below + 14 * u;
    lay.typeY = below + (withTof ? 28 : 14) * u;
  }
  if (!withTof) lay.tofY = NaN;
  lay.top = Math.min(lay.typeY, lay.rngY, withTof ? lay.tofY : Infinity);
  lay.bottom = Math.max(lay.typeY, lay.rngY, withTof ? lay.tofY : -Infinity);
}

/**
 * Is a label row centred at `ly` (± sw wide) on reserved text (the radio pill, the target camera window,
 * the kill feed), the flight path marker and its wings (level 2, #116), or a reticle ring?
 */
function rowBlocked(f: HudFrame, x: number, sw: number, ly: number, ringOnly: number): boolean {
  const u = f.L.u;
  const y0 = ly - 7 * u;
  const y1 = ly + 7 * u;
  return (!ringOnly && (f.occ.hits(x - sw, y0, x + sw, y1, 0, 0) || f.occ.hits(x - sw, y0, x + sw, y1, 2, 2))) || ringCuts(f, x - sw, y0, x + sw, y1);
}

/** Does the reticle ring drawn this frame (gun pipper, AIM-9X seeker) reach into the rect? */
function ringCuts(f: HudFrame, x0: number, y0: number, x1: number, y1: number): boolean {
  if (reticle.frame !== f.st.frame) return false;
  const nx = Math.max(x0, Math.min(x1, reticle.x));
  const ny = Math.max(y0, Math.min(y1, reticle.y));
  return Math.hypot(nx - reticle.x, ny - reticle.y) < reticle.r;
}

/** Target within the player's ±30° radar lock cone (nose). */
export function inLockCone(p: AircraftEntity, t: AnyEntity, f: HudFrame): boolean {
  const fwd = forwardOf(p.quaternion, f.v1);
  const d = f.v2.subVectors(t.position, p.position);
  const l = d.length();
  return l > 1 && fwd.dot(d) / l >= COS_CONE;
}
const COS_CONE = Math.cos(PLAYER_LOCK_CONE);

/** The human player commanded a lock on the current designation (combat state; defensive read). */
export function lockCommandedOf(p: AircraftEntity): boolean {
  try {
    return !!(acState(p) as { lockCommanded?: boolean }).lockCommanded;
  } catch {
    return false;
  }
}

/**
 * ±30° radar lock cone around the nose, drawn while an air target is designated but not locked (the
 * lock only builds inside it). Dim dashed circle; bright + blinking when a commanded lock is waiting
 * for the target to come inside.
 */
export function drawLockCone(f: HudFrame): void {
  const t = f.target;
  const p = f.p;
  if (f.mode !== 'hmd' || !t || f.locked || t.kind !== 'aircraft' || !p.radar.emitting) return;
  const { pen, pal, L, proj } = f;
  const u = L.u;
  const fwd = forwardOf(p.quaternion, f.v1);
  if (!proj.dir(fwd, f.sp) || !f.sp.front) return;
  const x = f.sp.x;
  const y = f.sp.y;
  // radius: project a direction 30° off the nose (toward the jet's up)
  const up = upOf(p.quaternion, f.v2);
  const c = Math.cos(PLAYER_LOCK_CONE);
  const s = Math.sin(PLAYER_LOCK_CONE);
  f.v3.set(fwd.x * c + up.x * s, fwd.y * c + up.y * s, fwd.z * c + up.z * s);
  if (!proj.dir(f.v3, f.sp2)) return;
  const r = Math.hypot(f.sp2.x - x, f.sp2.y - y);
  if (!(r > 10)) return;
  const inside = inLockCone(p, t, f);
  const waiting = f.lockCommanded && !inside;
  const a = waiting ? (blink(f, 2.5, 0.7) ? 0.9 : 0.45) : p.radar.lockProgress > 0.01 ? 0.5 : 0.32;
  const g = pen.g;
  g.save();
  g.beginPath();
  // keep it off the cockpit panel and the heading tape
  const bottom = f.cockpit ? L.cockpitTop : L.H;
  g.rect(0, L.tapeY + 44 * u, L.W, Math.max(0, bottom - (L.tapeY + 44 * u)));
  g.clip();
  pen.reset();
  pen.setDash('dash');
  pen.begin();
  pen.circle(x, y, r);
  g.globalAlpha = a;
  pen.strokeGlow(waiting ? pal.warn : pal.main, waiting ? 1.8 : 1.3);
  g.globalAlpha = 1;
  pen.setDash('solid');
  g.restore();
  pen.reset();
  // cone label at its upper-left rim
  const lx = x - r * 0.707;
  const lyy = y - r * 0.707;
  if (lyy > L.row2Y + 16 * u && lyy < bottom - 10 * u && lx > L.left + 30 * u) {
    pen.g.globalAlpha = a;
    pen.text('30°', lx - 4 * u, lyy - 4 * u, waiting ? pal.warn : pal.dim, 10.5, 'right');
    pen.g.globalAlpha = 1;
  }
}

/** Sideways steps (14 px each, both sides) the off-screen cue's text tries beside its arrow. */
const CUE_STEPS = 6;

/** Arrow on the screen-edge ellipse pointing at an off-screen target, with angle-off and label. */
function drawOffscreenCue(f: HudFrame, t: AnyEntity, dist: number): void {
  const { pen, pal, L } = f;
  const u = L.u;
  const sp = f.sp;
  edgeOfEllipse(L.edgeCx, L.edgeCy, L.edgeRx * 0.92, L.edgeRy * 0.8, sp.dirX, sp.dirY, edge);
  // keep the cue out of the cockpit panel in cockpit view, and off the touch controls
  if (f.cockpit && f.mode === 'hmd') edge.y = Math.min(edge.y, L.cockpitTop - 24 * u);
  if (edge.y > L.ctlTop - 40 * u && (edge.x < L.ctlLeft + 40 * u || edge.x > L.ctlRight - 40 * u)) edge.y = L.ctlTop - 40 * u;
  edge.y = Math.max(edge.y, L.row2Y + 20 * u);
  const col = f.locked ? pal.bright : pal.main;
  pen.setDash('solid');
  pen.begin();
  pen.arrow(edge.x + sp.dirX * 10 * u, edge.y + sp.dirY * 10 * u, sp.dirX, sp.dirY, 14 * u, 7 * u);
  pen.strokeGlow(col, 1.8);
  pen.fillPlain(withAlpha(col, 0.35));
  // our weapon on its way: the time to impact stays readable with the target behind us (a
  // StormBreaker's long glide, an AMRAAM fired before the turn)
  const m = ownMissileOn(f, t.id);
  const tl = m ? impactLabel(f, m, t) : '';
  const off = offTxt.get(sp.offAxis * RAD);
  const name = trackLabel(t);
  const rng = rangeLabel(dist);
  // the text block (angle-off, type, range, time to impact) sits inward of the arrow, clear of it
  // whichever way it points: anchored by its top line it ran down into a downward arrow (#62: "16°"
  // over "MIG-29 7.1" in the cockpit view, "35°" under the type line)
  const hw = Math.max(pen.textWidth(off, 12.5), pen.textWidth(name, 10.5), pen.textWidth(tl, 10.5)) / 2 + 2 * u;
  const below = (tl ? 41 : 28) * u + 6 * u; // last line's bottom (10.5 px row), from the first line's centre
  const hh = (below + 8 * u) / 2;
  // lowest the block may reach: above the cockpit panel (cockpit view) / the screen's bottom edge
  const maxTy = (f.cockpit && f.mode === 'hmd' ? L.cockpitTop - 3 * u : L.H - 4 * u) - below;
  // candidates: inward of the arrow, then beside it, stepping sideways (toward the centre first).
  // Inward of a mostly up / down arrow lands on the bank scale, the FPM or the waterline (#62
  // review), so the first spot clear of those (and of the protected symbols) wins; none clear: inward
  const reach = 10 * u + Math.abs(sp.dirX) * hw + Math.abs(sp.dirY) * hh;
  const side = sp.dirX > 0 ? -1 : 1;
  // the arrow's box: tip at edge + 10u along it, base corners 4u back and 7u either side
  const ax0 = Math.min(edge.x + sp.dirX * 10 * u, edge.x - sp.dirX * 4 * u - Math.abs(sp.dirY) * 7 * u) - 2 * u;
  const ax1 = Math.max(edge.x + sp.dirX * 10 * u, edge.x - sp.dirX * 4 * u + Math.abs(sp.dirY) * 7 * u) + 2 * u;
  const ay0 = Math.min(edge.y + sp.dirY * 10 * u, edge.y - sp.dirY * 4 * u - Math.abs(sp.dirX) * 7 * u) - 2 * u;
  const ay1 = Math.max(edge.y + sp.dirY * 10 * u, edge.y - sp.dirY * 4 * u + Math.abs(sp.dirX) * 7 * u) + 2 * u;
  // two passes: clear of everything, then (a crowded screen) of all but the contact / friendly symbols:
  // the protected ones, the incoming-missile arrows and TTIs among them, stay clear (1.2-d); none: inward
  const last = 2 + 2 * CUE_STEPS;
  let tx = 0;
  let ty = 0;
  for (let c = 0, pass = 0; c < last; c++) {
    if (c === last - 1 && pass === 0) {
      pass = 1;
      c = 0;
    }
    if (c === 0 || c === last - 1) {
      tx = edge.x - sp.dirX * reach;
      ty = edge.y - sp.dirY * reach - hh + 8 * u;
    } else {
      // beside the arrow, level with its middle (3u out along it)
      const k = (c - 1) >> 1;
      tx = edge.x + ((c & 1) === 1 ? side : -side) * ((ax1 - ax0) / 2 + hw + 4 * u + k * 14 * u);
      ty = edge.y + sp.dirY * 3 * u - hh + 8 * u;
    }
    // never over the speed / altitude columns or the DLZ scale (#62: "145° MIG-29" into the speed box)
    tx = slideOffColumns(f, tx, hw, ty - 8 * u, ty + below);
    tx = Math.max(L.left + hw, Math.min(L.right - hw, tx));
    ty = aboveControls(f, tx, hw, Math.max(L.row2Y + 8 * u, Math.min(maxTy, ty)), below);
    if (c === last - 1) break;
    const x0 = tx - hw;
    const x1 = tx + hw;
    const y0 = ty - 8 * u;
    const y1 = ty + below;
    if (f.occ.hits(x0, y0, x1, y1, 1)) continue;
    if (hitsBankOrWaterline(f, x0, y0, x1, y1) || (pass === 0 && f.sym.hits(x0, y0, x1, y1))) continue;
    if (x0 < ax1 && x1 > ax0 && y0 < ay1 && y1 > ay0) continue; // slid or clamped back over the arrow
    break;
  }
  // still on a symbol (a crowded centre: the incoming-missile ring round the FPM): step the spot up and
  // down until it clears them all, else (second pass) the protected ones
  if (blockedCue(f, tx, ty, hw, below, true)) {
    const bx = tx;
    const by = ty;
    let found = false;
    for (let pass = 0; pass < 2 && !found; pass++) {
      if (pass === 1 && !blockedCue(f, bx, by, hw, below, false)) break;
      for (let k = 1; k <= 12; k++) {
        const y0 = Math.max(L.row2Y + 8 * u, Math.min(maxTy, by + (k & 1 ? -1 : 1) * Math.ceil(k / 2) * 12 * u));
        const x = Math.max(L.left + hw, Math.min(L.right - hw, slideOffColumns(f, bx, hw, y0 - 8 * u, y0 + below)));
        const y = aboveControls(f, x, hw, y0, below);
        if (!blockedCue(f, x, y, hw, below, pass === 0) && !(x - hw < ax1 && x + hw > ax0 && y - 8 * u < ay1 && y + below > ay0)) {
          tx = x;
          ty = y;
          found = true;
          break;
        }
      }
    }
  }
  pen.text(off, tx, ty, col, 12.5);
  pen.text(name, tx, ty + 15 * u, pal.dim, 10.5);
  pen.text(rng, tx, ty + 28 * u, pal.dim, 10.5);
  if (tl) pen.text(tl, tx, ty + 41 * u, pal.main, 10.5);
  f.occ.add(tx - hw, ty - 8 * u, tx + hw, ty + below, 1);
}

/**
 * The top line of the off-screen cue's text block centred on x, lifted clear of the live touch
 * controls it would print under (the canvas draws below them: "AD BOAT" read "D BOAT" under the
 * throttle, playtest r1 1.2-j).
 */
function aboveControls(f: HudFrame, x: number, hw: number, ty: number, below: number): number {
  const u = f.L.u;
  const rects = controlRects();
  for (let pass = 0; pass < 2; pass++) {
    for (const rc of rects) {
      if (x + hw <= rc.x || x - hw >= rc.x + rc.w || ty + below <= rc.y - 2 * u || ty - 8 * u >= rc.y + rc.h) continue;
      ty = rc.y - 2 * u - below;
    }
  }
  return ty;
}

/**
 * Does the off-screen cue's text block centred on x (top line at y) cover a protected symbol (and, with
 * `syms`, a contact / site / waypoint / friendly symbol)?
 */
function blockedCue(f: HudFrame, x: number, y: number, hw: number, below: number, syms: boolean): boolean {
  const u = f.L.u;
  const x0 = x - hw;
  const y0 = y - 8 * u;
  const x1 = x + hw;
  const y1 = y + below;
  return f.occ.hits(x0, y0, x1, y1, 1) || hitsBankOrWaterline(f, x0, y0, x1, y1) || (syms && f.sym.hits(x0, y0, x1, y1));
}

/**
 * HMD views: the centre x for a text block [x ± hw] × [top, bot] that keeps it off the speed and
 * altitude columns and the DLZ scale (fixed blocks drawn after the target symbology, so they would
 * print on top of it): slid sideways, toward the screen centre, past the block it would cover (#62).
 * Other views: x unchanged.
 */
function slideOffColumns(f: HudFrame, x: number, hw: number, top: number, bot: number): number {
  if (f.mode !== 'hmd') return x;
  const L = f.L;
  const u = L.u;
  const z = f.zone;
  const dlz = !!z && z.rMax > 0 && z.weapon !== 'gun' && !WEAPON_IS_BOMB[z.weapon];
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < 3; k++) {
      let x0 = L.spdRight - 78 * u;
      let x1 = L.spdRight + 3 * u;
      let y0 = L.boxY - 13 * u;
      let y1 = speedColumnBottom(f);
      if (k === 1) {
        x0 = L.altLeft - 3 * u;
        x1 = L.altLeft + 92 * u;
        y1 = altColumnBottom(f);
      } else if (k === 2) {
        if (!dlz) continue;
        x0 = L.dlzX - 10 * u;
        x1 = L.dlzX + 62 * u;
        y0 = L.dlzTop - 18 * u;
        y1 = L.dlzBottom + 18 * u;
      }
      if (bot <= y0 || top >= y1 || x + hw <= x0 || x - hw >= x1) continue;
      x = (x0 + x1) / 2 < L.cx ? x1 + hw + 2 * u : x0 - hw - 2 * u;
    }
  }
  return x;
}

/** "TTI 42" for our bomb on its target, "T 12" for a missile (seconds to impact, cached strings). */
function impactLabel(f: HudFrame, m: MissileEntity, t: AnyEntity): string {
  const s = Math.max(0, Math.ceil(timeToImpact(f, m, t)));
  return m.def.category === 'bomb' ? ttiTxt.get(s) : mTxt.get(s);
}

function timeToImpact(f: HudFrame, m: MissileEntity, t: AnyEntity): number {
  if (m.def.category === 'bomb') return bombTimeToGo(m, t.position, f.world.time);
  const r = f.v1.subVectors(t.position, m.position);
  const d = r.length();
  if (d < 1) return 0;
  const closing = -f.v2.subVectors(t.velocity, m.velocity).dot(r) / d;
  return d / Math.max(80, closing);
}

/** Last bomb TTI per munition id: { world time it was computed, seconds to go then }. */
const bombTti = new Map<number, { at: number; tti: number }>();

/**
 * A bomb's predicted time of flight to `target` (its own glide law flown from its present state:
 * glideTimeToGo), not range ÷ closing speed, which read 99 s on a StormBreaker from 12 NM that took
 * 113 s (1.2-j). Re-flown at 4 Hz per bomb and counted down in between.
 */
export function bombTimeToGo(m: MissileEntity, target: { x: number; y: number; z: number }, now: number): number {
  const c = bombTti.get(m.id);
  if (c && now >= c.at && now - c.at < 0.25) return Math.max(0, c.tti - (now - c.at));
  const dx = target.x - m.position.x;
  const dz = target.z - m.position.z;
  const horiz = Math.hypot(dx, dz);
  const vh = horiz > 1 ? (m.velocity.x * dx + m.velocity.z * dz) / horiz : Math.hypot(m.velocity.x, m.velocity.z);
  const def = (MUNITIONS as Record<string, MunitionDefLike | undefined>)[m.def.id] ?? m.def;
  const tti = glideTimeToGo(def, horiz, m.position.y - target.y, vh, m.velocity.y, target.y, def.maxFlightTime - (m.age || 0));
  if (bombTti.size > 32) bombTti.clear();
  if (c) {
    c.at = now;
    c.tti = tti;
  } else bombTti.set(m.id, { at: now, tti });
  return tti;
}

/* ───────────────────────── Own missiles in flight ───────────────────────── */

/** Motor-glow marker colours (#282 F3): a warm halo and a hot core, like the 3D plume they stand in for. */
const MOTOR_HALO = 'rgba(255,168,72,0.5)';
const MOTOR_CORE = '#fff2d2';

/**
 * Does the player's own missile get the HUD motor-glow marker (#282 F3)? Right after launch an AMRAAM
 * flies down the line of sight to the boxed target (244 m out and ~4° low at 1.5 s), so the target box
 * and LOCK strokes, drawn on the HUD canvas over the 3D view, hide its motor glow. The marker redraws
 * the glow over them while the motor burns, in the pilot's-eye (HMD) views only: from an outside camera
 * the box and the plume are far apart.
 */
export function showsMotorGlow(m: MissileEntity, playerId: number, hmd: boolean): boolean {
  return hmd && m.alive && m.motorBurning && m.shooterId === playerId;
}

export function drawOwnMissiles(f: HudFrame): void {
  const { world, p, pen, pal, L } = f;
  const u = L.u;
  const hmd = f.mode === 'hmd';
  pen.setDash('solid');
  pen.begin();
  let any = false;
  let glow = false;
  for (const m of world.missiles) {
    if (!m.alive || m.shooterId !== p.id) continue;
    f.proj.point(m.position, f.sp);
    if (!drawable(f)) continue;
    pen.circle(f.sp.x, f.sp.y, 3.5 * u);
    any = true;
    if (showsMotorGlow(m, p.id, hmd)) glow = true;
  }
  if (any) pen.strokeGlow(pal.main, 1.3);
  if (!glow) return;
  // drawn after the designated box and the LOCK cue, so the glow sits on top of their strokes
  for (const m of world.missiles) {
    if (!showsMotorGlow(m, p.id, hmd)) continue;
    f.proj.point(m.position, f.sp);
    if (!drawable(f)) continue;
    pen.begin();
    pen.circle(f.sp.x, f.sp.y, 2.4 * u);
    pen.fillPlain(MOTOR_HALO);
    pen.begin();
    pen.circle(f.sp.x, f.sp.y, 1.1 * u);
    pen.fillPlain(MOTOR_CORE);
  }
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
    const r = friendRadius(f, a);
    pen.begin();
    pen.arc(f.sp.x, f.sp.y, r, Math.PI, Math.PI * 2);
    pen.line(f.sp.x - r, f.sp.y, f.sp.x + r, f.sp.y);
    pen.strokeGlow(pal.friend, 1.5);
    if (d < 15_000) {
      const t = a.callsign || a.name;
      if (placeLabel(f, t, 10, f.sp.x, f.sp.y - r - 8 * u, f.sp.y + r + 9 * u)) pen.text(t, lblPos.x, lblPos.y, pal.friend, 10);
    }
  }
}

/* ───────────────────────── Steering waypoint ───────────────────────── */

/**
 * Did drawWaypoint print the steering waypoint's name this frame (or leave it out on purpose: a target
 * waypoint with the bandits in reach)? When not, the fixed NEXT line (by the heading box in the HMD, in
 * the outside views' info block) names it instead: a tour is useless without its names (playtest 2.2-1).
 */
const wpName = { frame: -1, done: false };

export function waypointNamed(f: HudFrame): boolean {
  return wpName.frame === f.st.frame && wpName.done;
}

export function drawWaypoint(f: HudFrame): void {
  wpName.frame = f.st.frame;
  wpName.done = false;
  const wp = f.ctx.mission?.currentWaypoint;
  if (!wp) return;
  if (TEST_HOOKS) noteSteer(wp.label || wp.id);
  const { p, pen, pal, L, occ } = f;
  const u = L.u;
  // a target waypoint with the bandits in reach: the contact boxes take over, its labels ("SWARM 3.0 NM")
  // would only print into them (playtest: over the drone boxes through the g01 gun pass), and the NEXT
  // slot stays empty too
  const engaged = wp.kind === 'target' && airContactWithin(f, WP_ENGAGED_RANGE);
  wpName.done = engaged;
  f.proj.point(wp.position, f.sp);
  if (!drawable(f)) return;
  const x = f.sp.x;
  const y = f.sp.y;
  const r = 7 * u;
  // behind a fixed text block (external info block, columns, radio): not drawn at all
  if (occ.hits(x - r, y - r, x + r, y + r, 0, 0) && zoneBlocked(f, x, y)) return;
  pen.setDash('solid');
  pen.begin();
  pen.diamond(x, y, r);
  pen.line(x, y - r, x, y - r - 5 * u);
  pen.strokeGlow(pal.main, 1.6);
  if (TEST_HOOKS) noteSteerDiamond(x, y);
  if (engaged) return;
  const dx = wp.position.x - p.position.x;
  const dz = wp.position.z - p.position.z;
  const d = Math.hypot(dx, dz);
  const gs = Math.max(30, Math.hypot(p.velocity.x, p.velocity.z));
  // name above, distance / time below; any label that would collide with the target box, a contact
  // label or the FPM moves to the other side or is left out
  const name = wp.label || wp.id;
  const nw = pen.textWidth(name, 11) / 2 + 2;
  // labels never run under the button column / off the left edge
  const lx = Math.max(L.left + nw, Math.min(L.right - nw, x));
  const dist = wpDist.get(toNm(d));
  const dw = pen.textWidth(dist, 10.5) / 2 + 2;
  const aboveY = y - r - 14 * u;
  let belowY = y + r + 9 * u;
  const infoFree = !occ.hits(x - dw, belowY - 6 * u, x + dw, belowY + 18 * u);
  const dx2 = Math.max(L.left + dw, Math.min(L.right - dw, x));
  if (!occ.hits(lx - nw, aboveY - 7 * u, lx + nw, aboveY + 7 * u)) {
    pen.text(name, lx, aboveY, pal.main, 11);
    if (TEST_HOOKS) noteSteerName(lx, aboveY);
    occ.add(lx - nw, aboveY - 7 * u, lx + nw, aboveY + 7 * u);
    wpName.done = true;
  } else if (infoFree) {
    pen.text(name, lx, belowY, pal.main, 11);
    if (TEST_HOOKS) noteSteerName(lx, belowY);
    wpName.done = true;
    occ.add(lx - nw, belowY - 7 * u, lx + nw, belowY + 7 * u);
    belowY += 13 * u;
  }
  if (!occ.hits(dx2 - dw, belowY - 6 * u, dx2 + dw, belowY + 18 * u)) {
    pen.text(dist, dx2, belowY, pal.dim, 10.5);
    pen.text(mmss(d / gs), dx2, belowY + 12 * u, pal.dim, 10.5);
    occ.add(dx2 - dw, belowY - 6 * u, dx2 + dw, belowY + 18 * u);
  }
}

/** A target waypoint keeps only its diamond once a hostile aircraft is this close (m). */
export const WP_ENGAGED_RANGE = 5_000;

/** Is a live hostile aircraft contact within `range` (m) of the player? */
function airContactWithin(f: HudFrame, range: number): boolean {
  const { p, world } = f;
  const r2 = range * range;
  for (const c of p.radar.contacts) {
    if (c.team === p.team || c.team === 'neutral') continue;
    const e = world.getEntity(c.id);
    if (e && e.alive && e.kind === 'aircraft' && c.position.distanceToSquared(p.position) < r2) return true;
  }
  return false;
}

/** Is (x, y) inside one of the fixed text blocks (external info block / top-left column)? */
function zoneBlocked(f: HudFrame, x: number, y: number): boolean {
  const L = f.L;
  if (f.mode === 'external' && Number.isFinite(zoneExt.extBottom) && x < zoneExt.extRight && y < zoneExt.extBottom) return true;
  return Number.isFinite(zoneExt.colBottom) && x > L.colX - 6 && x < L.colX + L.colW && y < zoneExt.colBottom && y > L.colY - 10;
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

/**
 * The fixed NEXT line: the steering waypoint's name and distance ("NEXT HARBOUR BRIDGE 2.4 NM"), for
 * when its diamond has no room for them (waypointNamed). Text only; the caller places it.
 */
export function nextWaypointText(f: HudFrame): { name: string; dist: string } | null {
  const wp = f.ctx.mission?.currentWaypoint;
  if (!wp || waypointNamed(f)) return null;
  const d = Math.hypot(wp.position.x - f.p.position.x, wp.position.z - f.p.position.z);
  return { name: (wp.label || wp.id).toUpperCase(), dist: wpDist.get(toNm(d)) };
}
