/**
 * Tactical Situation Display renderer, shared by the HMD radar inset (external views) and the PCD TSD
 * page: moving map around ownship (heading-up), range rings, compass, route / waypoints, bullseye
 * (Sky Tower = world origin), known SAM threat rings, ground targets, the friendly sites to defend,
 * sensor-fused air tracks with velocity leaders (hostile red, friendly blue), designated / locked
 * highlight, missiles in flight.
 */
import { NM } from '../../core/math';
import type { FrameContext } from '../../core/contracts';
import type { AircraftEntity } from '../../sim/entities';
import { AIRCRAFT_SHORT, SAM_LABEL } from './format';
import { Occupancy } from './occupancy';
import type { Pen } from './pen';
import { protectedSites } from './sites';
import { chartPaths } from './tacmap';

/** Label de-collision inside one TSD draw. */
const lblOcc = new Occupancy(64);
/** Draw a label unless it would overlap one already drawn (or the ownship). */
function label(pen: Pen, text: string, x: number, y: number, color: string, size: number, align: 'left' | 'center' = 'center'): void {
  if (!text) return;
  const w = pen.textWidth(text, size);
  const x0 = align === 'left' ? x : x - w / 2;
  const h = size * 0.55;
  if (lblOcc.hits(x0, y - h, x0 + w, y + h)) return;
  lblOcc.add(x0, y - h, x0 + w, y + h);
  pen.text(text, x, y, color, size, align);
}

export interface TsdColors {
  ring: string;
  text: string;
  own: string;
  hostile: string;
  friend: string;
  sam: string;
  samFill: string;
  ground: string;
  route: string;
  highlight: string;
  /** Coastline stroke (optional). */
  coast?: string;
}

export interface TsdStyle {
  /** Ownship position on the canvas. */
  cx: number;
  cy: number;
  /** Pixels for `range` metres. */
  radius: number;
  range: number;
  /** Clip region: circle (cx, cy, clipR) or rectangle. */
  clipCircle: number;
  clipRect: [number, number, number, number] | null;
  rings: number;
  /** Labels: 'all' (de-collided), 'key' (designated / locked / current waypoint / SAMs tracking us), false. */
  labels: boolean | 'key';
  /** Base font size. */
  font: number;
  /** Symbol scale. */
  sym: number;
  compass: boolean;
  route: boolean;
  bullseye: boolean;
  /** Line width scale. */
  lw: number;
  /** Faint Auckland coastline / islands under the symbols (heading-up). */
  coast?: boolean;
}

export function makeTsdStyle(): TsdStyle {
  return { cx: 0, cy: 0, radius: 50, range: 40_000, clipCircle: 50, clipRect: null, rings: 1, labels: false, font: 10, sym: 1, compass: true, route: true, bullseye: true, lw: 1 };
}

let sinH = 0;
let cosH = 1;
let ox = 0;
let oz = 0;
let scale = 1;
let ocx = 0;
let ocy = 0;
const pt = { x: 0, y: 0 };

/** World XZ → display (heading-up). */
function map(x: number, z: number): { x: number; y: number } {
  const rx = (x - ox) * scale;
  const ry = (z - oz) * scale; // +z = south = down (north-up)
  pt.x = ocx + rx * cosH + ry * sinH;
  pt.y = ocy - rx * sinH + ry * cosH;
  return pt;
}

/** Display-space direction of a world XZ vector (unit not required). */
function mapDir(dx: number, dz: number, out: { x: number; y: number }): void {
  out.x = dx * cosH + dz * sinH;
  out.y = -dx * sinH + dz * cosH;
}
const dv = { x: 0, y: 0 };

export function drawTsd(pen: Pen, ctx: FrameContext, p: AircraftEntity, st: TsdStyle, c: TsdColors, flash: boolean): void {
  const g = pen.g;
  const world = ctx.world;
  const h = p.flight.heading;
  sinH = Math.sin(h);
  cosH = Math.cos(h);
  ox = p.position.x;
  oz = p.position.z;
  scale = st.radius / st.range;
  ocx = st.cx;
  ocy = st.cy;
  const s = st.sym;
  const lw = st.lw;

  g.save();
  g.beginPath();
  if (st.clipRect) g.rect(st.clipRect[0], st.clipRect[1], st.clipRect[2], st.clipRect[3]);
  else g.arc(st.cx, st.cy, st.clipCircle, 0, Math.PI * 2);
  g.clip();
  pen.reset();
  lblOcc.clear();
  lblOcc.addBox(st.cx, st.cy, 9 * st.sym, 9 * st.sym);
  const all = st.labels === true;
  const key = st.labels === 'key' || all;

  // faint coastline + islands (Auckland theatre): the cached tactical-map Path2D, transformed heading-up
  if (st.coast && (ctx.mission?.def?.theater ?? 'auckland') === 'auckland') {
    const ch = chartPaths();
    if (ch) {
      const k = 1000 * scale;
      g.save();
      g.transform(cosH * k, -sinH * k, sinH * k, cosH * k, ocx - (cosH * ox + sinH * oz) * scale, ocy + (sinH * ox - cosH * oz) * scale);
      g.globalAlpha *= 0.55;
      g.lineJoin = 'round';
      g.fillStyle = 'rgba(40,110,150,0.16)';
      g.fill(ch.water, ch.rule);
      g.strokeStyle = c.coast ?? 'rgba(120,180,200,0.7)';
      g.lineWidth = (1.6 * lw) / k;
      g.stroke(ch.water);
      g.stroke(ch.islands);
      g.restore();
      pen.reset();
    }
  }

  // range rings
  pen.setDash('dash');
  pen.begin();
  for (let i = 1; i <= st.rings; i++) pen.circle(st.cx, st.cy, (st.radius * i) / st.rings);
  pen.strokePlain(c.ring, 1 * lw);
  pen.setDash('solid');
  if (key && st.rings > 0) {
    const nm = Math.round(st.range / NM);
    pen.text(String(nm), st.cx + st.radius * 0.72, st.cy - st.radius * 0.72, c.ring, st.font * 0.9);
  }

  // compass: north marker on the outer ring
  if (st.compass) {
    mapDir(0, -1, dv);
    const r = st.radius * (st.rings > 0 ? 1 : 0.85);
    const nx = st.cx + dv.x * r;
    const ny = st.cy + dv.y * r;
    pen.text('N', nx, ny, c.text, st.font);
  }

  // SAM threat rings (known SAMs)
  for (const sam of world.sams) {
    if (!sam.alive || sam.team === p.team || !sam.known) continue;
    const R = (sam.engageRange ?? 20_000) * scale;
    map(sam.position.x, sam.position.z);
    const tracking = sam.radarOn && sam.trackedTargetId === p.id;
    pen.begin();
    pen.circle(pt.x, pt.y, R);
    pen.setFill(c.samFill);
    g.fill();
    pen.strokePlain(tracking && flash ? c.hostile : c.sam, (tracking ? 2 : 1.3) * lw);
  }

  // route
  const mission = ctx.mission;
  if (st.route && mission && mission.waypoints.length) {
    const cur = mission.currentWaypoint;
    pen.begin();
    let first = true;
    for (const w of mission.waypoints) {
      map(w.position.x, w.position.z);
      if (first) g.moveTo(pt.x, pt.y);
      else g.lineTo(pt.x, pt.y);
      first = false;
    }
    pen.strokePlain(c.route, 1.2 * lw);
    for (const w of mission.waypoints) {
      map(w.position.x, w.position.z);
      const isCur = w === cur;
      pen.begin();
      pen.circle(pt.x, pt.y, (isCur ? 5.5 : 4) * s);
      pen.strokePlain(isCur ? c.highlight : c.route, (isCur ? 2 : 1.2) * lw);
      if (all || (key && isCur)) label(pen, w.label || w.id, pt.x, pt.y - 11 * s, isCur ? c.highlight : c.route, st.font * 0.85);
    }
    // steering line from ownship to the current waypoint
    if (cur) {
      map(cur.position.x, cur.position.z);
      pen.setDash('dot');
      pen.begin();
      pen.line(st.cx, st.cy, pt.x, pt.y);
      pen.strokePlain(c.highlight, 1.2 * lw);
      pen.setDash('solid');
    }
  }

  // bullseye (world origin)
  if (st.bullseye) {
    map(0, 0);
    pen.begin();
    pen.circle(pt.x, pt.y, 6 * s);
    pen.circle(pt.x, pt.y, 2.5 * s);
    pen.line(pt.x - 9 * s, pt.y, pt.x + 9 * s, pt.y);
    pen.line(pt.x, pt.y - 9 * s, pt.x, pt.y + 9 * s);
    pen.strokePlain(c.route, 1 * lw);
  }

  const des = p.radar.designatedId;
  const lock = p.radar.lockedId;

  // SAM sites + ground targets
  for (const sam of world.sams) {
    if (!sam.alive || sam.team === p.team || !sam.known) continue;
    map(sam.position.x, sam.position.z);
    const x = pt.x;
    const y = pt.y;
    pen.begin();
    g.moveTo(x - 5 * s, y + 4 * s);
    g.lineTo(x, y - 5 * s);
    g.lineTo(x + 5 * s, y + 4 * s);
    g.closePath();
    pen.strokePlain(c.hostile, 1.6 * lw);
    const samTracking = sam.radarOn && sam.trackedTargetId === p.id;
    if (all || (key && (samTracking || sam.id === des || sam.id === lock))) label(pen, SAM_LABEL[sam.type] ?? '', x, y + 12 * s, c.hostile, st.font * 0.85);
    if (sam.id === des || sam.id === lock) ringHighlight(pen, x, y, s, c, sam.id === lock);
  }
  for (const gt of world.ground) {
    if (!gt.alive || gt.team === p.team || (!gt.known && !tracked(p, gt.id))) continue;
    map(gt.position.x, gt.position.z);
    pen.begin();
    pen.rect(pt.x - 3.2 * s, pt.y - 3.2 * s, 6.4 * s, 6.4 * s);
    // civil ships (sensor tracks only): neutral (text) colour, like civil air traffic
    pen.strokePlain(gt.team === 'neutral' ? c.text : c.ground, 1.3 * lw);
    if (gt.id === des || gt.id === lock) ringHighlight(pen, pt.x, pt.y, s, c, gt.id === lock);
  }
  // friendly sites to defend (protect objectives, sites.ts): circle-and-square in the friendly colour
  for (const site of protectedSites(mission, world, p.team)) {
    map(site.x, site.z);
    pen.begin();
    pen.circle(pt.x, pt.y, 5 * s);
    pen.rect(pt.x - 1.8 * s, pt.y - 1.8 * s, 3.6 * s, 3.6 * s);
    pen.strokePlain(c.friend, 1.5 * lw);
    if (key) label(pen, site.label, pt.x, pt.y + 12 * s, c.friend, st.font * 0.85);
  }

  // hostile air tracks (sensor fused)
  const now = world.time;
  for (const ct of p.radar.contacts) {
    const e = world.getEntity(ct.id);
    if (!e || !e.alive || e.kind !== 'aircraft' || e.team === p.team) continue;
    const stale = now - ct.lastSeen > 1.5;
    const pos = stale ? ct.position : e.position;
    const vel = stale ? ct.velocity : e.velocity;
    map(pos.x, pos.z);
    const x = pt.x;
    const y = pt.y;
    mapDir(vel.x, vel.z, dv);
    const lead = 30 * scale; // 30 s leader
    const col = e.team === 'neutral' ? c.text : c.hostile; // civil traffic: neutral (text) colour
    pen.setDash(stale ? 'dash' : 'solid');
    pen.begin();
    // hostile: red half-diamond (chevron)
    g.moveTo(x - 5 * s, y + 1 * s);
    g.lineTo(x, y - 5 * s);
    g.lineTo(x + 5 * s, y + 1 * s);
    pen.line(x, y - 5 * s, x + dv.x * lead, y - 5 * s + dv.y * lead);
    pen.strokePlain(col, 1.8 * lw);
    pen.setDash('solid');
    if (e.id === lock) {
      pen.begin();
      g.moveTo(x - 5 * s, y + 1 * s);
      g.lineTo(x, y - 5 * s);
      g.lineTo(x + 5 * s, y + 1 * s);
      g.closePath();
      pen.fillPlain(col);
    }
    if (e.id === des || e.id === lock) ringHighlight(pen, x, y - 1 * s, s, c, e.id === lock);
    if (all || (key && (e.id === des || e.id === lock))) label(pen, AIRCRAFT_SHORT[e.type] ?? '', x + 9 * s, y + 6 * s, col, st.font * 0.85, 'left');
  }

  // friendlies (datalink)
  for (const a of world.aircraft) {
    if (!a.alive || a === p || a.team !== p.team) continue;
    map(a.position.x, a.position.z);
    const x = pt.x;
    const y = pt.y;
    mapDir(a.velocity.x, a.velocity.z, dv);
    const lead = 30 * scale;
    pen.begin();
    pen.arc(x, y, 4.5 * s, Math.PI, Math.PI * 2);
    pen.line(x - 4.5 * s, y, x + 4.5 * s, y);
    pen.line(x, y - 4.5 * s, x + dv.x * lead, y - 4.5 * s + dv.y * lead);
    pen.strokePlain(c.friend, 1.6 * lw);
  }

  // missiles in flight
  pen.begin();
  let anyOwn = false;
  for (const m of world.missiles) {
    if (!m.alive || m.shooterId !== p.id) continue;
    map(m.position.x, m.position.z);
    pen.circle(pt.x, pt.y, 1.8 * s);
    anyOwn = true;
  }
  if (anyOwn) pen.fillPlain(c.own);
  for (const inc of p.incoming) {
    const m = world.getEntity(inc.missileId);
    if (!m || !m.alive) continue;
    map(m.position.x, m.position.z);
    pen.begin();
    pen.circle(pt.x, pt.y, 2.5 * s);
    if (flash) pen.fillPlain(c.hostile);
  }

  // ownship (F-35 planform-ish arrow)
  pen.begin();
  const x = st.cx;
  const y = st.cy;
  g.moveTo(x, y - 7 * s);
  g.lineTo(x + 5.5 * s, y + 4 * s);
  g.lineTo(x + 2 * s, y + 3 * s);
  g.lineTo(x + 2.5 * s, y + 6 * s);
  g.lineTo(x - 2.5 * s, y + 6 * s);
  g.lineTo(x - 2 * s, y + 3 * s);
  g.lineTo(x - 5.5 * s, y + 4 * s);
  g.closePath();
  pen.fillPlain(c.own);

  g.restore();
  pen.reset();
}

/** Is `id` in the ownship's sensor picture? */
function tracked(p: AircraftEntity, id: number): boolean {
  const cs = p.radar.contacts;
  for (let i = 0; i < cs.length; i++) if (cs[i].id === id) return true;
  return false;
}

function ringHighlight(pen: Pen, x: number, y: number, s: number, c: TsdColors, locked: boolean): void {
  pen.begin();
  if (locked) pen.diamond(x, y, 10 * s);
  else pen.rect(x - 8 * s, y - 8 * s, 16 * s, 16 * s);
  pen.strokePlain(c.highlight, 1.6);
}

/** Pick a nice TSD range (nm steps) with hysteresis. */
export function autoTsdRange(prev: number, need: number, steps: readonly number[] = [10, 20, 40]): number {
  const needNm = need / NM;
  let r = steps[steps.length - 1];
  for (const s of steps) {
    if (s >= needNm) {
      r = s;
      break;
    }
  }
  const prevNm = prev / NM;
  // keep the previous range unless the content no longer fits or fits in < 45 % of it
  if (prevNm > 0 && prevNm >= needNm && needNm > prevNm * 0.45) r = prevNm;
  return r * NM;
}
