/**
 * Tactical MAP view — a real 2D tactical situation map drawn by the HUD over the (dimmed) top-down 3D
 * view: north-up around ownship, 10 / 20 / 40 km range (tap the map to cycle, tap a symbol to target
 * it), range rings + scale bar, the Auckland coastline / islands / urban areas (WORLD module map data,
 * read defensively), landmark names, known SAM threat rings, the mission route and objective markers,
 * sensor-fused hostile air tracks (type, angels, velocity leader), datalinked friendlies, ground targets,
 * the friendly sites to defend, missiles in flight, edge arrows for hostiles beyond the map, and a legend.
 *
 * Coastline geometry is cached as Path2D objects in km (built once), drawn with a canvas transform, so
 * a frame costs a handful of fills and no allocation.
 */
import { toFeet, toNm } from '../../core/math';
import { AKL } from '../../core/auckland';
import { aucklandLinz, aucklandLinzVersion } from '../../world/terrain/theaters/aucklandLinz';
import * as aklMap from '../../world/terrain/theaters/aucklandMap';
import type { AnyEntity } from '../../sim/entities';
import { civilHidden } from '../../sim/entities';
import { isMissileBoatLive } from '../../sim/boats';
import { NumText, SAM_LABEL, groundLabel, trackLabel } from './format';
import { blink, type HudFrame } from './frame';
import { withAlpha } from './palette';
import { protectedSites } from './sites';
import type { Occupancy } from './occupancy';

/** Map range choices (km, ownship → outer ring). */
export const TAC_SCALES_KM = [10, 20, 40] as const;

/** Persistent tactical-map state (zoom), owned by the HUD. */
export class TacMapState {
  scaleIdx = 1;
  /** Pick the range automatically (fit the fight) until the player taps to choose one. */
  auto = true;
  /** Map was on screen last frame (entering the view re-fits the range). */
  active = false;
  /** Legend: shown for a few seconds on entry, then collapsed behind the 'i' chip (tap to toggle). */
  legendPinned: boolean | null = null;
  legendUntil = 0;
  /** Legend / chip rectangle (CSS px) for tap hit-testing. */
  readonly legendRect = { x: 0, y: 0, w: 0, h: 0 };

  /** Is the full legend showing at animation time `clock`? */
  legendOpen(clock: number): boolean {
    return this.legendPinned ?? clock < this.legendUntil;
  }

  /** Tap on the legend / 'i' chip: toggle it (true = the tap was consumed). */
  tapLegend(x: number, y: number, clock: number): boolean {
    const r = this.legendRect;
    if (r.w <= 0 || x < r.x - 6 || x > r.x + r.w + 6 || y < r.y - 6 || y > r.y + r.h + 6) return false;
    this.legendPinned = !this.legendOpen(clock);
    return true;
  }

  get rangeKm(): number {
    return TAC_SCALES_KM[this.scaleIdx];
  }

  /** Tap on the map (not on a symbol): next range. */
  cycle(): number {
    this.auto = false;
    this.scaleIdx = (this.scaleIdx + 1) % TAC_SCALES_KM.length;
    return this.rangeKm;
  }

  /** Smallest range that contains `needM` metres (auto mode). */
  fit(needM: number): void {
    let i = TAC_SCALES_KM.length - 1;
    for (let k = 0; k < TAC_SCALES_KM.length; k++) {
      if (TAC_SCALES_KM[k] * 1000 >= needM) {
        i = k;
        break;
      }
    }
    this.scaleIdx = i;
  }
}

/** North-up projection: world XZ (m) → screen px around (cx, cy) with `k` px per metre. */
export interface TacProjection {
  cx: number;
  cy: number;
  ox: number;
  oz: number;
  k: number;
  /** Map radius (px) = the range ring. */
  R: number;
}

export function tacProject(v: TacProjection, x: number, z: number, out: { x: number; y: number }): { x: number; y: number } {
  out.x = v.cx + (x - v.ox) * v.k;
  out.y = v.cy + (z - v.oz) * v.k; // +z = south = down: north-up
  return out;
}

/* ───────────────────────── Auckland chart geometry (Path2D in km) ───────────────────────── */

export interface Chart {
  water: Path2D;
  islands: Path2D;
  lakes: Path2D;
  urban: Path2D;
  /** Fill rule for `water` (the LINZ coastline is a set of nested rings: even–odd). */
  rule: CanvasFillRule;
}
let chart: Chart | null | undefined;
let chartVersion = -1;

function polyInto(p: Path2D, pts: number[]): void {
  if (pts.length < 6) return;
  p.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) p.lineTo(pts[i], pts[i + 1]);
  p.closePath();
}

/** Auckland chart paths (km, +z south), built once and shared with the TSD. */
export function chartPaths(): Chart | null {
  if (chart !== undefined && chartVersion === aucklandLinzVersion()) return chart;
  chartVersion = aucklandLinzVersion();
  chart = null;
  try {
    if (typeof Path2D === 'undefined') return null;
    const m = aklMap as unknown as {
      AKL_WATER?: { pts: number[] }[];
      AKL_ISLANDS?: ({ pts: number[] } | { ellipse: [number, number, number, number, number] })[];
      AKL_LAKES?: [number, number, number][];
      AKL_URBAN?: number[][];
    };
    if (!Array.isArray(m.AKL_WATER)) return null;
    const water = new Path2D();
    for (const w of m.AKL_WATER) if (w && Array.isArray(w.pts)) polyInto(water, w.pts);
    const islands = new Path2D();
    for (const isl of m.AKL_ISLANDS ?? []) {
      if ('pts' in isl) polyInto(islands, isl.pts);
      else if (Array.isArray(isl.ellipse)) {
        const [cx, cz, rx, rz, rot] = isl.ellipse;
        islands.moveTo(cx + rx * Math.cos(rot), cz + rx * Math.sin(rot));
        islands.ellipse(cx, cz, rx, rz, rot, 0, Math.PI * 2);
        islands.closePath();
      }
    }
    const lakes = new Path2D();
    for (const [x, z, r] of m.AKL_LAKES ?? []) {
      lakes.moveTo(x + r, z);
      lakes.arc(x, z, r, 0, Math.PI * 2);
    }
    const urban = new Path2D();
    for (const u of m.AKL_URBAN ?? []) if (Array.isArray(u)) polyInto(urban, u);
    const linz = aucklandLinz();
    if (linz) {
      // Real (LINZ) coastline: water = everything outside an odd number of rings.
      const real = new Path2D();
      real.rect(-80, -80, 160, 160);
      for (const ring of linz.rings) {
        const km: number[] = [];
        for (let i = 0; i < ring.length; i++) km.push(ring[i] / 1000);
        polyInto(real, km);
      }
      chart = { water: real, islands: new Path2D(), lakes, urban, rule: 'evenodd' };
    } else chart = { water, islands, lakes, urban, rule: 'nonzero' };
  } catch {
    chart = null;
  }
  return chart;
}

const LANDMARKS: { id: string; text: string }[] = [
  { id: 'cbd', text: 'AUCKLAND CBD' },
  { id: 'rangitoto', text: 'RANGITOTO' },
  { id: 'motutapu', text: 'MOTUTAPU' },
  { id: 'waiheke', text: 'WAIHEKE' },
  { id: 'whenuapai', text: 'WHENUAPAI AB' },
  { id: 'devonport', text: 'DEVONPORT' },
  { id: 'takapuna', text: 'TAKAPUNA' },
  { id: 'akl_airport', text: 'AKL AIRPORT' },
  { id: 'ardmore', text: 'ARDMORE' },
  { id: 'whangaparaoa', text: 'WHANGAPARAOA' },
  { id: 'tiritiri', text: 'TIRITIRI' },
  { id: 'waitakere', text: 'WAITAKERE RA' },
  { id: 'motuihe', text: 'MOTUIHE' },
];

/**
 * Free flight (A Stroll in the Park) also names the city's sights and suburbs, so a sightseer can
 * find a place (playtest 2026-10-02 bc94edd, 1.1-c); combat missions keep the sparse chart.
 */
const SIGHTS: { id: string; text: string }[] = [
  { id: 'skytower', text: 'SKY TOWER' },
  { id: 'bridge_n', text: 'HARBOUR BRIDGE' },
  { id: 'eden_park', text: 'EDEN PARK' },
  { id: 'domain', text: 'MUSEUM' },
  { id: 'mt_eden', text: 'MT EDEN' },
  { id: 'one_tree_hill', text: 'ONE TREE HILL' },
  { id: 'north_head', text: 'NORTH HEAD' },
  { id: 'tamaki_drive', text: 'MISSION BAY' },
  { id: 'ponsonby', text: 'PONSONBY' },
  { id: 'parnell', text: 'PARNELL' },
  { id: 'newmarket', text: 'NEWMARKET' },
  { id: 'st_heliers', text: 'ST HELIERS' },
  { id: 'northcote', text: 'NORTHCOTE' },
  { id: 'mt_albert', text: 'MT ALBERT' },
  { id: 'mt_roskill', text: 'MT ROSKILL' },
  { id: 'mt_wellington', text: 'MT WELLINGTON' },
  { id: 'onehunga', text: 'ONEHUNGA' },
  { id: 'otahuhu', text: 'OTAHUHU' },
  { id: 'titirangi', text: 'TITIRANGI' },
  { id: 'hobsonville', text: 'HOBSONVILLE' },
  { id: 'browns_bay', text: 'BROWNS BAY' },
  { id: 'long_bay', text: 'LONG BAY' },
  { id: 'piha', text: 'PIHA' },
  { id: 'muriwai', text: 'MURIWAI' },
  { id: 'beachlands', text: 'BEACHLANDS' },
];

/* ───────────────────────── colours ───────────────────────── */

const C = {
  sea: 'rgba(5,17,28,0.93)',
  land: '#1b2a24',
  urban: '#243429',
  coast: '#5e8c7a',
  grid: 'rgba(120,170,160,0.10)',
  ring: 'rgba(150,220,200,0.45)',
  ringText: 'rgba(170,230,210,0.85)',
  place: 'rgba(170,200,190,0.55)',
  own: '#ffffff',
  route: '#52d8ff',
  ground: '#ffc02e',
  samFill: 'rgba(255,59,48,0.075)',
  panel: 'rgba(0,8,12,0.72)',
};

/* ───────────────────────── scratch / text caches ───────────────────────── */

const pt = { x: 0, y: 0 };
/** Ownship planform (local px: x right, y forward). */
const OWN_SHAPE = [0, 9, 7, -5, 2.5, -3, 3, -8, -3, -8, -2.5, -3, -7, -5];
const proj: TacProjection = { cx: 0, cy: 0, ox: 0, oz: 0, k: 1, R: 1 };
const ringTxt = new Map<number, string>();
function kmLabel(km: number): string {
  let s = ringTxt.get(km);
  if (!s) ringTxt.set(km, (s = (km % 1 === 0 ? String(km) : km.toFixed(1)) + ' km'));
  return s;
}
const angelsCache = new Map<string, string>();
/** "MIG-29 A20" (type + angels) — cached per (label, angels). */
function airLabel(label: string, altM: number): string {
  const a = Math.max(0, Math.round(toFeet(altM) / 1000));
  const key = label + '|' + a;
  let s = angelsCache.get(key);
  if (!s) {
    if (angelsCache.size > 400) angelsCache.clear();
    angelsCache.set(key, (s = label + ' A' + a));
  }
  return s;
}
const edgeRange = new NumText(0, '', ' NM');
const launchTxt: string[] = [];
/** "LAUNCH 12": a missile boat's countdown on the tac map (cached, no per-frame strings). */
function launchLabel(timer: number): string {
  const n = Math.max(0, Math.ceil(timer));
  return (launchTxt[n] ??= `LAUNCH ${n}`);
}
const samOff = new Map<string, string>();
function samLabel(type: keyof typeof SAM_LABEL, on: boolean): string {
  const l = SAM_LABEL[type] ?? 'SAM';
  if (on) return l;
  let s = samOff.get(l);
  if (!s) samOff.set(l, (s = l + ' OFF'));
  return s;
}
const titleCache = new Map<number, string>();

/* ───────────────────────── draw ───────────────────────── */

/** The whole tactical map. Returns the bottom of the legend panel (top-left). */
/** Seconds the full legend shows on entering the map. */
export const LEGEND_SHOW = 5;

/**
 * Keep map labels off the live touch controls (bottom clusters, right button column), the radio pill
 * and kill feed: seeded into the occupancy registry before any symbol label.
 */
function reserveControls(f: HudFrame): void {
  const { L, occ } = f;
  occ.add(0, L.ctlTop - 4, L.ctlLeft + 4, L.H);
  occ.add(L.ctlRight - 4, L.ctlTop - 4, L.W, L.H);
  occ.add(L.right + 2, 0, L.W, L.H);
}

export function drawTacticalMap(f: HudFrame, tm: TacMapState): number {
  const { pen, pal, L, p, world, ctx, picks, occ } = f;
  const g = pen.g;
  const u = L.u;

  // range: fit the fight when entering the view (until the player picks a range)
  if (!tm.active || tm.auto) {
    let need = 8_000;
    const t = f.target;
    if (t) need = Math.max(need, t.position.distanceTo(p.position) * 1.15);
    else {
      let nearest = Infinity;
      for (const c of p.radar.contacts) {
        if (c.team === p.team || c.team === 'neutral') continue;
        const e = world.getEntity(c.id);
        if (!e || !e.alive || e.kind !== 'aircraft') continue;
        nearest = Math.min(nearest, Math.hypot(c.position.x - p.position.x, c.position.z - p.position.z));
      }
      if (Number.isFinite(nearest)) need = Math.max(need, nearest * 1.2);
    }
    if (!tm.active || tm.auto) tm.fit(need);
  }
  if (!tm.active) {
    // entering the map: legend up for 5 s (unless the player pinned it open / shut)
    tm.legendUntil = f.st.clock + LEGEND_SHOW;
  }
  tm.active = true;
  const legendOpen = tm.legendOpen(f.st.clock);
  // (the legend lists the DEFEND symbol only in a mission with a site to defend)
  legendSites = protectedSites(ctx.mission, world, p.team).length > 0;

  const R = Math.max(80, Math.min(L.H / 2 - 22 * u, (L.right - L.left) / 2 - 10 * u));
  const rangeM = tm.rangeKm * 1000;
  proj.cx = L.cx;
  proj.cy = L.cy;
  proj.ox = p.position.x;
  proj.oz = p.position.z;
  proj.k = R / rangeM;
  proj.R = R;
  const k = proj.k;

  // labels never land under the touch controls or the legend / 'i' chip
  reserveControls(f);
  const lr = tm.legendRect;
  legendSize(f, legendOpen, lr);
  occ.add(lr.x, lr.y, lr.x + lr.w, lr.y + lr.h);

  /* background + chart */
  pen.setFill(C.sea);
  g.fillRect(0, 0, L.W, L.H);
  const ch = chartPaths();
  if (ch) {
    const d = pen.dpr;
    const s = k * 1000; // px per km
    g.save();
    g.setTransform(d * s, 0, 0, d * s, d * (proj.cx - proj.ox * k), d * (proj.cy - proj.oz * k));
    g.fillStyle = C.land;
    // land base covering the visible area (km)
    const x0 = (proj.ox - (proj.cx + 10) / k) / 1000;
    const z0 = (proj.oz - (proj.cy + 10) / k) / 1000;
    g.fillRect(x0, z0, (L.W + 20) / s, (L.H + 20) / s);
    g.fillStyle = C.urban;
    g.fill(ch.urban);
    g.lineJoin = 'round';
    g.strokeStyle = C.coast;
    g.lineWidth = 2.4 / s;
    g.stroke(ch.water);
    g.fillStyle = '#07141f';
    g.fill(ch.water, ch.rule);
    g.stroke(ch.islands);
    g.fillStyle = C.land;
    g.fill(ch.islands);
    g.lineWidth = 1.6 / s;
    g.stroke(ch.lakes);
    g.fillStyle = '#07141f';
    g.fill(ch.lakes);
    g.restore();
    pen.reset();
    pen.baseTransform();
  }

  /* grid (world-aligned, gives motion + scale) */
  const gridM = tm.rangeKm >= 40 ? 10_000 : 5_000;
  pen.setDash('solid');
  pen.begin();
  const gx0 = Math.floor((proj.ox - proj.cx / k) / gridM) * gridM;
  const gz0 = Math.floor((proj.oz - proj.cy / k) / gridM) * gridM;
  for (let x = gx0; x <= proj.ox + (L.W - proj.cx) / k; x += gridM) {
    const sx = proj.cx + (x - proj.ox) * k;
    pen.line(sx, 0, sx, L.H);
  }
  for (let z = gz0; z <= proj.oz + (L.H - proj.cy) / k; z += gridM) {
    const sy = proj.cy + (z - proj.oz) * k;
    pen.line(0, sy, L.W, sy);
  }
  pen.strokePlain(C.grid, 1);

  /* range rings + compass */
  pen.setDash('dash');
  pen.begin();
  pen.circle(proj.cx, proj.cy, R);
  pen.circle(proj.cx, proj.cy, R / 2);
  pen.strokePlain(C.ring, 1.2);
  pen.setDash('solid');
  pen.begin();
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    const l = i % 9 === 0 ? 10 * u : i % 3 === 0 ? 6 * u : 3 * u;
    pen.line(proj.cx + Math.sin(a) * R, proj.cy - Math.cos(a) * R, proj.cx + Math.sin(a) * (R - l), proj.cy - Math.cos(a) * (R - l));
  }
  pen.strokePlain(C.ring, 1.2);
  pen.text('N', proj.cx, proj.cy - R - 9 * u, pal.white, 13);
  pen.text('E', proj.cx + R + 9 * u, proj.cy, C.ringText, 10.5);
  pen.text('W', proj.cx - R - 9 * u, proj.cy, C.ringText, 10.5);
  pen.text(kmLabel(tm.rangeKm), proj.cx + R * 0.72 + 4 * u, proj.cy - R * 0.72 - 6 * u, C.ringText, 10.5, 'left');
  pen.text(kmLabel(tm.rangeKm / 2), proj.cx + R * 0.36 + 3 * u, proj.cy - R * 0.36 - 5 * u, C.ringText, 10, 'left');
  // ring labels + ownship velocity leader: symbol labels keep off them
  occ.add(proj.cx + R * 0.72 + 2 * u, proj.cy - R * 0.72 - 13 * u, proj.cx + R * 0.72 + 50 * u, proj.cy - R * 0.72 + 1 * u);
  occ.add(proj.cx + R * 0.36 + 1 * u, proj.cy - R * 0.36 - 12 * u, proj.cx + R * 0.36 + 46 * u, proj.cy - R * 0.36 + 2 * u);
  occLine(f, proj.cx, proj.cy, proj.cx + p.velocity.x * 45 * k, proj.cy + p.velocity.z * 45 * k);

  /* SAM threat rings (known) */
  for (const s of world.sams) {
    if (!s.alive || s.team === p.team || (!s.known && !hasContact(f, s.id))) continue;
    tacProject(proj, s.position.x, s.position.z, pt);
    const rr = (s.engageRange ?? 20_000) * k;
    if (pt.x + rr < 0 || pt.x - rr > L.W || pt.y + rr < 0 || pt.y - rr > L.H) continue;
    const tracking = s.radarOn && s.trackedTargetId === p.id;
    pen.begin();
    pen.circle(pt.x, pt.y, rr);
    pen.fillPlain(C.samFill);
    pen.setDash(tracking ? 'solid' : 'dash');
    pen.strokePlain(withAlpha(pal.danger, tracking && blink(f, 2.5) ? 1 : 0.7), tracking ? 2 : 1.3);
    pen.setDash('solid');
    // site symbol + label
    const w = 7 * u;
    pen.begin();
    g.moveTo(pt.x - w, pt.y + w * 0.6);
    g.lineTo(pt.x, pt.y - w * 0.7);
    g.lineTo(pt.x + w, pt.y + w * 0.6);
    g.closePath();
    pen.strokeGlow(pal.danger, 1.6);
    occ.addBox(pt.x, pt.y, w + 2 * u, w);
    const sl = samLabel(s.type, s.radarOn);
    const shw = pen.textWidth(sl, 10.5) / 2 + 2;
    const sy = pt.y + w + 8 * u;
    if (!occ.hits(pt.x - shw, sy - 6 * u, pt.x + shw, sy + 6 * u)) {
      pen.text(sl, pt.x, sy, pal.danger, 10.5);
      occ.add(pt.x - shw, sy - 6 * u, pt.x + shw, sy + 6 * u);
    }
    if (s.id === p.radar.designatedId || s.id === p.radar.lockedId) highlight(f, pt.x, pt.y, 12 * u, s.id === p.radar.lockedId);
    if (onMap(pt.x, pt.y, R)) picks.add(s.id, pt.x, pt.y, 10 * u);
  }

  /* missile boats' launch rings (#79): solid and blinking, with the seconds left, while one counts down */
  for (const gt of world.ground) {
    const strike = gt.boat?.strike;
    if (!strike || !isMissileBoatLive(gt, p.team) || (!gt.known && !hasContact(f, gt.id))) continue;
    tacProject(proj, gt.position.x, gt.position.z, pt);
    const rr = strike.range * k;
    if (pt.x + rr < 0 || pt.x - rr > L.W || pt.y + rr < 0 || pt.y - rr > L.H) continue;
    const counting = strike.timer >= 0;
    pen.begin();
    pen.circle(pt.x, pt.y, rr);
    pen.setDash(counting ? 'solid' : 'dash');
    pen.strokePlain(withAlpha(pal.danger, counting && blink(f, 2.5) ? 1 : 0.6), counting ? 2 : 1.1);
    pen.setDash('solid');
    if (counting) pen.text(launchLabel(strike.timer), pt.x, pt.y - 14 * u, pal.danger, 10.5);
  }

  /* route + objective markers */
  const mission = ctx.mission;
  if (mission && mission.waypoints.length) {
    const cur = mission.currentWaypoint;
    pen.begin();
    let first = true;
    for (const w of mission.waypoints) {
      tacProject(proj, w.position.x, w.position.z, pt);
      if (first) g.moveTo(pt.x, pt.y);
      else g.lineTo(pt.x, pt.y);
      first = false;
    }
    pen.strokePlain(withAlpha(C.route, 0.55), 1.4);
    // every marker first, then the names round them (the steering point's first, then the ones
    // still ahead): a name tries above, below, beside and the diagonals, so a crowded tour keeps its
    // stop names (#113, playtest 2.2-2: 4–5 of the stroll's 11 fitted at 10 km)
    const wps = mission.waypoints;
    for (const w of wps) {
      tacProject(proj, w.position.x, w.position.z, pt);
      const isCur = w === cur;
      pen.begin();
      if (w.kind === 'target') pen.diamond(pt.x, pt.y, (isCur ? 8 : 6) * u);
      else pen.circle(pt.x, pt.y, (isCur ? 6.5 : 5) * u);
      pen.strokeGlow(isCur ? pal.bright : C.route, isCur ? 2.2 : 1.4);
      occ.addBox(pt.x, pt.y, 7 * u, 7 * u);
    }
    const from = cur ? Math.max(0, wps.indexOf(cur)) : 0;
    for (let n = 0; n < wps.length; n++) {
      const w = wps[(from + n) % wps.length];
      tacProject(proj, w.position.x, w.position.z, pt);
      const isCur = w === cur;
      labelAround(f, w.label || w.id, pt.x, pt.y, isCur ? pal.bright : C.route, isCur);
    }
    if (cur) {
      tacProject(proj, cur.position.x, cur.position.z, pt);
      pen.setDash('dot');
      pen.begin();
      pen.line(proj.cx, proj.cy, pt.x, pt.y);
      pen.strokePlain(pal.bright, 1.4);
      pen.setDash('solid');
    }
  }

  /* ground targets */
  for (const gt of world.ground) {
    if (!gt.alive || gt.team === p.team || civilHidden(p, gt) || (!gt.known && !hasContact(f, gt.id))) continue;
    tacProject(proj, gt.position.x, gt.position.z, pt);
    if (!onMap(pt.x, pt.y, R * 1.02)) continue;
    const r = 4 * u;
    const civil = gt.team === 'neutral'; // civil ships: white, labelled CIV
    const col = civil ? pal.white : C.ground;
    pen.begin();
    pen.rect(pt.x - r, pt.y - r, r * 2, r * 2);
    pen.strokeGlow(col, 1.5);
    occ.addBox(pt.x, pt.y, r + 2, r + 2);
    const lbl = civil ? 'CIV' : groundLabel(gt);
    const hw = pen.textWidth(lbl, 9.5) / 2 + 2;
    const ly = pt.y + r + 7 * u;
    if (lbl && !occ.hits(pt.x - hw, ly - 5, pt.x + hw, ly + 5)) {
      pen.text(lbl, pt.x, ly, withAlpha(col, 0.85), 9.5);
      occ.add(pt.x - hw, ly - 5, pt.x + hw, ly + 5);
    }
    if (gt.id === p.radar.designatedId || gt.id === p.radar.lockedId) highlight(f, pt.x, pt.y, 10 * u, gt.id === p.radar.lockedId);
    picks.add(gt.id, pt.x, pt.y, 8 * u);
  }

  /* friendly sites to defend (protect objectives, sites.ts): pinned to the ring when beyond it, never pickable */
  for (const site of protectedSites(mission, world, p.team)) {
    tacProject(proj, site.x, site.z, pt);
    const dx = pt.x - proj.cx;
    const dy = pt.y - proj.cy;
    const dist = Math.hypot(dx, dy);
    const edge = dist > R - 8 * u;
    if (edge) {
      pt.x = proj.cx + (dx / dist) * (R - 8 * u);
      pt.y = proj.cy + (dy / dist) * (R - 8 * u);
    }
    const r = (edge ? 5 : 6.5) * u;
    pen.begin();
    pen.circle(pt.x, pt.y, r);
    pen.rect(pt.x - 2.2 * u, pt.y - 2.2 * u, 4.4 * u, 4.4 * u);
    pen.strokeGlow(edge ? withAlpha(pal.friend, 0.75) : pal.friend, 1.6);
    occ.addBox(pt.x, pt.y, r + 2, r + 2);
    labelNear(f, site.label, pt.x, pt.y, pal.friend);
  }

  /* friendlies (datalink) */
  const lead = 45; // s of travel for the velocity leader
  for (const a of world.aircraft) {
    if (!a.alive || a === p || a.team !== p.team) continue;
    tacProject(proj, a.position.x, a.position.z, pt);
    if (!onMap(pt.x, pt.y, R * 1.05)) continue;
    const r = 5 * u;
    pen.begin();
    pen.arc(pt.x, pt.y, r, Math.PI, Math.PI * 2);
    pen.line(pt.x - r, pt.y, pt.x + r, pt.y);
    pen.line(pt.x, pt.y - r, pt.x + a.velocity.x * lead * k, pt.y - r + a.velocity.z * lead * k);
    pen.strokeGlow(pal.friend, 1.6);
    occ.addBox(pt.x, pt.y, r + 2, r + 2);
    occLine(f, pt.x, pt.y - r, pt.x + a.velocity.x * lead * k, pt.y - r + a.velocity.z * lead * k);
    labelNear(f, airLabel((a.callsign || a.name).toUpperCase(), a.position.y), pt.x, pt.y, pal.friend);
  }

  /* hostile air tracks (sensor fused) + edge arrows for the ones beyond the map */
  const now = world.time;
  for (const c of p.radar.contacts) {
    if (c.team === p.team) continue;
    const e = world.getEntity(c.id);
    if (!e || !e.alive || e.kind !== 'aircraft' || civilHidden(p, e)) continue;
    const col = e.team === 'neutral' ? pal.white : pal.danger; // civil traffic in white
    const stale = now - c.lastSeen > 1.5;
    const pos = stale ? c.position : e.position;
    const vel = stale ? c.velocity : e.velocity;
    tacProject(proj, pos.x, pos.z, pt);
    const dx = pt.x - proj.cx;
    const dy = pt.y - proj.cy;
    const dist = Math.hypot(dx, dy);
    const des = e.id === p.radar.designatedId;
    const lock = e.id === p.radar.lockedId;
    if (dist > R) {
      // beyond the range ring: arrow on the ring with type + range
      const ux = dx / dist;
      const uy = dy / dist;
      const ex = proj.cx + ux * (R - 4 * u);
      const ey = proj.cy + uy * (R - 4 * u);
      pen.begin();
      pen.arrow(ex, ey, ux, uy, 13 * u, 6 * u);
      pen.strokeGlow(col, 1.4);
      pen.fillPlain(withAlpha(col, lock || des ? 1 : 0.6));
      const lbl = trackLabel(e);
      const tx = ex - ux * 22 * u;
      const ty = ey - uy * 18 * u;
      pen.text(lbl, tx, ty, col, 9.5);
      pen.text(edgeRange.get(toNm(Math.hypot(pos.x - p.position.x, pos.z - p.position.z))), tx, ty + 11 * u, withAlpha(col, 0.8), 9);
      occ.add(tx - 24 * u, ty - 7 * u, tx + 24 * u, ty + 17 * u);
      picks.add(e.id, ex, ey, 10 * u);
      continue;
    }
    const s = 6 * u;
    pen.setDash(stale ? 'dash' : 'solid');
    pen.begin();
    g.moveTo(pt.x - s, pt.y + s * 0.3);
    g.lineTo(pt.x, pt.y - s);
    g.lineTo(pt.x + s, pt.y + s * 0.3);
    pen.line(pt.x, pt.y - s, pt.x + vel.x * lead * k, pt.y - s + vel.z * lead * k);
    pen.strokeGlow(col, 1.8);
    pen.setDash('solid');
    if (lock) {
      pen.begin();
      g.moveTo(pt.x - s, pt.y + s * 0.3);
      g.lineTo(pt.x, pt.y - s);
      g.lineTo(pt.x + s, pt.y + s * 0.3);
      g.closePath();
      pen.fillPlain(col);
    }
    if (des || lock) highlight(f, pt.x, pt.y - 2 * u, 11 * u, lock);
    occ.addBox(pt.x, pt.y, s + 3 * u, s + 3 * u);
    // (the label goes on the side away from its own velocity leader)
    occLine(f, pt.x, pt.y - s, pt.x + vel.x * lead * k, pt.y - s + vel.z * lead * k);
    labelNear(f, airLabel(trackLabel(e) || 'BANDIT', pos.y), pt.x, pt.y, col);
    picks.add(e.id, pt.x, pt.y, 10 * u);
  }

  /* missiles in flight */
  pen.begin();
  let anyOwn = false;
  for (const m of world.missiles) {
    if (!m.alive || m.shooterId !== p.id) continue;
    tacProject(proj, m.position.x, m.position.z, pt);
    pen.circle(pt.x, pt.y, 2.2 * u);
    anyOwn = true;
  }
  if (anyOwn) pen.fillPlain(C.own);
  for (const inc of p.incoming) {
    const m = world.getEntity(inc.missileId);
    if (!m || !m.alive) continue;
    tacProject(proj, m.position.x, m.position.z, pt);
    pen.setDash('dot');
    pen.begin();
    pen.line(pt.x, pt.y, proj.cx, proj.cy);
    pen.strokePlain(withAlpha(pal.danger, 0.7), 1.2);
    pen.setDash('solid');
    pen.begin();
    pen.circle(pt.x, pt.y, 3.2 * u);
    if (blink(f, 3)) pen.fillPlain(pal.danger);
    pen.strokePlain(pal.danger, 1.2);
  }

  /* ownship */
  const hd = p.flight.heading;
  const sh = Math.sin(hd);
  const chh = Math.cos(hd);
  pen.begin();
  for (let i = 0; i < OWN_SHAPE.length; i += 2) {
    // local (x right, y forward) → screen (heading-rotated, north-up)
    const lx = OWN_SHAPE[i];
    const ly = OWN_SHAPE[i + 1];
    const X = proj.cx + (lx * chh + ly * sh) * u;
    const Y = proj.cy + (lx * sh - ly * chh) * u;
    if (i === 0) g.moveTo(X, Y);
    else g.lineTo(X, Y);
  }
  g.closePath();
  pen.setFill(C.own);
  g.fill();
  pen.strokeGlow('rgba(0,0,0,0.6)', 0.8);
  pen.begin();
  pen.line(proj.cx + sh * 9 * u, proj.cy - chh * 9 * u, proj.cx + p.velocity.x * lead * k, proj.cy + p.velocity.z * lead * k);
  pen.strokePlain(C.own, 1.3);
  occ.addBox(proj.cx, proj.cy, 12 * u, 12 * u);
  const legendBottom = drawLegend(f, tm, legendOpen);

  /* landmark names last, only where they don't collide with a symbol or label */
  pen.setFont(9);
  pen.setAlign('center', 'middle');
  const names = f.ctx.mission?.def?.script?.freeFlight ? [...LANDMARKS, ...SIGHTS] : LANDMARKS;
  for (const lm of names) {
    const a = AKL[lm.id];
    if (!a) continue;
    tacProject(proj, a.x, a.z, pt);
    if (pt.x < L.left + 20 || pt.x > L.right - 20 || pt.y < L.top + 10 || pt.y > L.bottom - 10) continue;
    const hw = pen.textWidth(lm.text, 9) / 2 + 3;
    if (occ.hits(pt.x - hw, pt.y - 7, pt.x + hw, pt.y + 7)) continue;
    pen.setFill(C.place);
    g.fillText(lm.text, pt.x, pt.y);
  }
  return legendBottom;
}

function onMap(x: number, y: number, R: number): boolean {
  return Math.hypot(x - proj.cx, y - proj.cy) <= R;
}

function hasContact(f: HudFrame, id: number): boolean {
  for (const c of f.p.radar.contacts) if (c.id === id) return true;
  return false;
}

function highlight(f: HudFrame, x: number, y: number, r: number, locked: boolean): void {
  const { pen, pal } = f;
  pen.begin();
  if (locked) pen.diamond(x, y, r * 1.2);
  else pen.rect(x - r, y - r, r * 2, r * 2);
  pen.strokeGlow(pal.bright, 1.8);
}

/** Register a leader line as 3 small boxes along it (labels keep off it without blocking its whole bbox). */
function occLine(f: HudFrame, x0: number, y0: number, x1: number, y1: number): void {
  const occ = f.occ;
  for (let i = 0; i < 3; i++) {
    const a0 = i / 3;
    const a1 = (i + 1) / 3;
    occ.add(x0 + (x1 - x0) * a0 - 2, y0 + (y1 - y0) * a0 - 2, x0 + (x1 - x0) * a1 + 2, y0 + (y1 - y0) * a1 + 2);
  }
}

/** Label beside a symbol: right, else left, else below — skipped if every spot is taken. */
function labelNear(f: HudFrame, text: string, x: number, y: number, col: string): void {
  const { pen, L, occ } = f;
  const u = L.u;
  const w = pen.textWidth(text, 10);
  const h = 6 * u;
  for (let i = 0; i < 4; i++) {
    // right, left, below, above
    const sx = i === 0 ? x + 10 * u : i === 1 ? x - 10 * u : x;
    const sy = i === 2 ? y + 14 * u : i === 3 ? y - 16 * u : y;
    const al = i === 0 ? 'left' : i === 1 ? 'right' : 'center';
    const x0 = al === 'left' ? sx : al === 'right' ? sx - w : sx - w / 2;
    if (occ.hits(x0 - 1, sy - h, x0 + w + 1, sy + h)) continue;
    pen.text(text, sx, sy, col, 10, al);
    occ.add(x0 - 1, sy - h, x0 + w + 1, sy + h);
    return;
  }
}

/**
 * Slots round a map marker for its name, in order of preference: above, below, right, left, then the
 * four diagonals. dx/dy in layout units from the marker's centre to the text anchor.
 */
export const LABEL_SLOTS: readonly { dx: number; dy: number; align: 'left' | 'right' | 'center' }[] = [
  { dx: 0, dy: -13, align: 'center' },
  { dx: 0, dy: 13, align: 'center' },
  { dx: 10, dy: 0, align: 'left' },
  { dx: -10, dy: 0, align: 'right' },
  { dx: 7, dy: -11, align: 'left' },
  { dx: -7, dy: -11, align: 'right' },
  { dx: 7, dy: 11, align: 'left' },
  { dx: -7, dy: 11, align: 'right' },
];

/**
 * The first free slot round a marker at (x, y) for a label `w` px wide (null = all taken): the label's
 * box [x0, y0, x1, y1] and its anchor.
 */
export function freeLabelSlot(
  occ: Occupancy,
  w: number,
  x: number,
  y: number,
  u: number,
): { x: number; y: number; align: 'left' | 'right' | 'center'; box: [number, number, number, number] } | null {
  const h = 6;
  for (const s of LABEL_SLOTS) {
    const sx = x + s.dx * u;
    const sy = y + s.dy * u;
    const x0 = s.align === 'left' ? sx : s.align === 'right' ? sx - w : sx - w / 2;
    const box: [number, number, number, number] = [x0 - 2, sy - h, x0 + w + 2, sy + h];
    if (!occ.hits(box[0], box[1], box[2], box[3])) return { x: sx, y: sy, align: s.align, box };
  }
  return null;
}

/** A waypoint's name in the first free slot round its marker; the steering point's is always drawn (above when crowded). */
function labelAround(f: HudFrame, text: string, x: number, y: number, col: string, always: boolean): void {
  const { pen, occ, L } = f;
  const w = pen.textWidth(text, 10);
  const slot = freeLabelSlot(occ, w, x, y, L.u);
  if (slot) {
    pen.text(text, slot.x, slot.y, col, 10, slot.align);
    occ.add(...slot.box);
  } else if (always) {
    const ly = y - 13 * L.u;
    pen.text(text, x, ly, col, 10);
    occ.add(x - w / 2 - 2, ly - 6, x + w / 2 + 2, ly + 6);
  }
}

/** This frame's map has a friendly site to defend (an extra legend row). */
let legendSites = false;

/** Legend panel size (full or collapsed chip) — reserved before the symbols are labelled. */
function legendSize(f: HudFrame, open: boolean, out: { x: number; y: number; w: number; h: number }): void {
  const L = f.L;
  const u = L.u;
  out.x = L.colX - 4 * u;
  out.y = L.colY - 4 * u;
  out.w = open ? Math.min(L.colW, 196 * u) : 118 * u;
  out.h = open ? 18 * u + (legendSites ? 7 : 6) * 13 * u + 34 * u : 22 * u;
}

/** Legend + scale bar + tap hint (top-left panel), or the collapsed 'i' chip. Returns the panel bottom. */
function drawLegend(f: HudFrame, tm: TacMapState, open: boolean): number {
  const { pen, pal, L } = f;
  const g = pen.g;
  const u = L.u;
  const x = L.colX;
  let y = L.colY;
  const r = tm.legendRect;
  legendSize(f, open, r);
  const w = r.w;
  const h = r.h;
  const lh = 13 * u;
  if (!open) {
    // collapsed: [i] + range, one line (tap to open the legend)
    pen.setFill(C.panel);
    pen.roundRect(r.x, r.y, w, h, 6 * u);
    g.fill();
    pen.begin();
    pen.circle(r.x + 11 * u, r.y + h / 2, 7 * u);
    pen.strokeGlow(pal.bright, 1.3);
    pen.text('i', r.x + 11 * u, r.y + h / 2 + 0.5, pal.bright, 10.5);
    let t = chipCache.get(tm.rangeKm);
    if (!t) chipCache.set(tm.rangeKm, (t = 'MAP ' + tm.rangeKm + ' KM'));
    pen.text(t, r.x + 23 * u, r.y + h / 2 + 0.5, pal.white, 10.5, 'left');
    return r.y + h;
  }
  pen.setFill(C.panel);
  pen.roundRect(x - 4 * u, y - 4 * u, w, h, 6 * u);
  g.fill();
  let t = titleCache.get(tm.rangeKm);
  if (!t) titleCache.set(tm.rangeKm, (t = 'TACTICAL MAP  ' + tm.rangeKm + ' KM'));
  pen.text(t, x + 2 * u, y + 6 * u, pal.bright, 11.5, 'left');
  y += 20 * u;
  const sx = x + 9 * u;
  const tx = x + 22 * u;
  const s = 5 * u;
  // ownship
  pen.begin();
  g.moveTo(sx, y - s);
  g.lineTo(sx + s * 0.8, y + s * 0.7);
  g.lineTo(sx - s * 0.8, y + s * 0.7);
  g.closePath();
  pen.fillPlain(C.own);
  pen.text('YOU / 45 s LEADER', tx, y, pal.white, 9.5, 'left');
  y += lh;
  pen.begin();
  g.moveTo(sx - s, y + s * 0.3);
  g.lineTo(sx, y - s);
  g.lineTo(sx + s, y + s * 0.3);
  pen.strokeGlow(pal.danger, 1.6);
  pen.text('HOSTILE AIR  TYPE A=ANGELS', tx, y, pal.danger, 9.5, 'left');
  y += lh;
  pen.begin();
  pen.arc(sx, y + 2 * u, s, Math.PI, Math.PI * 2);
  pen.line(sx - s, y + 2 * u, sx + s, y + 2 * u);
  pen.strokeGlow(pal.friend, 1.5);
  pen.text('FRIENDLY (DATALINK)', tx, y, pal.friend, 9.5, 'left');
  y += lh;
  if (legendSites) {
    // the site to defend: the map's circle-and-square (sites.ts)
    pen.begin();
    pen.circle(sx, y, s);
    pen.rect(sx - s * 0.34, y - s * 0.34, s * 0.68, s * 0.68);
    pen.strokeGlow(pal.friend, 1.4);
    pen.text('DEFEND n/m  SITE TO PROTECT', tx, y, pal.friend, 9.5, 'left');
    y += lh;
  }
  pen.begin();
  pen.circle(sx, y, s);
  pen.fillPlain(C.samFill);
  pen.setDash('dash');
  pen.strokePlain(pal.danger, 1.2);
  pen.setDash('solid');
  pen.text('SAM THREAT RING', tx, y, pal.danger, 9.5, 'left');
  y += lh;
  pen.begin();
  pen.rect(sx - s * 0.8, y - s * 0.8, s * 1.6, s * 1.6);
  pen.strokeGlow(C.ground, 1.4);
  pen.text('GROUND TARGET', tx, y, C.ground, 9.5, 'left');
  y += lh;
  pen.begin();
  pen.circle(sx, y, s * 0.9);
  pen.strokeGlow(C.route, 1.4);
  pen.text('ROUTE / WAYPOINT', tx, y, C.route, 9.5, 'left');
  y += lh + 4 * u;
  // scale bar: a nice round length ~ 1/4 of the range
  const barKm = tm.rangeKm / 4;
  const barPx = barKm * 1000 * proj.k;
  pen.begin();
  pen.line(x + 2 * u, y, x + 2 * u + barPx, y);
  pen.line(x + 2 * u, y - 3 * u, x + 2 * u, y + 3 * u);
  pen.line(x + 2 * u + barPx, y - 3 * u, x + 2 * u + barPx, y + 3 * u);
  pen.strokeGlow(pal.white, 1.4);
  pen.text(kmLabel(barKm), x + 8 * u + barPx, y, pal.white, 9.5, 'left');
  y += 13 * u;
  pen.text('TAP MAP: ZOOM  TAP i: LEGEND', x + 2 * u, y, pal.dim, 8.5, 'left');
  return L.colY - 4 * u + h;
}
const chipCache = new Map<number, string>();

/** Distance (m) used by tests: how far the map shows (outer ring). */
export function tacRangeMeters(tm: TacMapState): number {
  return tm.rangeKm * 1000;
}

/** Test/helper: map a world entity to the current map projection (last drawn frame). */
export function tacScreenOf(e: AnyEntity, out: { x: number; y: number }): { x: number; y: number } {
  return tacProject(proj, e.position.x, e.position.z, out);
}
