/**
 * Weapon window: the player's missile or bomb, followed to the target in the target camera's slot.
 *
 * One slot (top right in the HMD views, under the radar inset outside), one owner at a time:
 *
 *  - STRIP: from launch, a two-line data strip (weapon ▸ target, guidance phase, time to impact, range,
 *    progress) docked under the target camera (or in its slot when the camera is closed). No 3D pass.
 *    Same target as the target camera: docked flush, "▲ SAME TGT" instead of the name.
 *  - VIDEO: from 3 s before the expected impact, the window takes the slot from the target camera,
 *    grows to 1.6× (setting 'dynamic'; 'compact' keeps the slot's size) and shows a chase shot behind
 *    the weapon (render/TargetCam.ts renderWeapon). It stays open until the outcome unless the time to
 *    impact climbs past 5 s again (the target turned away).
 *  - OUTCOME: a hit holds SPLASH 1.6 s; a kill of the target camera's own target holds the camera's
 *    DESTROYED hold instead (3 s, 6 s for a ship) and the camera doesn't replay it. Hits less than 1.6 s
 *    apart count up (SPLASH ×N). MISSED / DECOYED / LOST / NO TGT hold 2 s in amber, then the slot goes
 *    back to the target camera, still on its live target. A result gives way at once when another
 *    weapon enters its last 3 s (it stays as an amber chip).
 *  - Several weapons: one window, on the next to hit (lowest time to impact, held ≥ 2 s; a tap on the
 *    window cycles and pins one). The others are chips under it, by time to impact; from 4 weapons up
 *    grouped by target, 3 rows at most, then "+N".
 *  - A red cue (MISSILE, PULL UP, STALL) or the Sky Tower cut keeps it a strip.
 *
 * Outcomes come from the sim: 'munition:end' (onEnd) and the missile's own state (decoyed, trackBroken,
 * the target dead before it arrives, the range opening again after the closest approach: a miss).
 *
 * The planner (planWpn) and the tracker are pure / DOM-free and unit tested (tests/hud-wpncam.test.ts).
 */
import { Vector3 } from 'three';
import type { Guidance, MissileEntity, AnyEntity } from '../../sim/entities';
import type { HudFrame } from './frame';
import type { HudLayout } from './layout';
import { entityLabel } from './format';
import { pipHold } from './pip';
import { bombTimeToGo } from './targets';

/** Seconds before the expected impact the window opens the video. */
export const WPN_TERMINAL = 3;
/** An open video closes back to the strip only if the time to impact climbs past this (s). */
export const WPN_REOPEN = 5;
/** SPLASH hold (s); the target camera's own target holds its DESTROYED hold instead (pipHold). */
export const WPN_SPLASH_HOLD = 1.6;
/** MISSED / DECOYED / LOST / NO TGT hold (s). */
export const WPN_RESULT_HOLD = 2;
/** The window stays on its weapon at least this long before it moves to another one (s). */
export const WPN_DWELL = 2;
/** Video size in the 'dynamic' setting (× the target camera's slot). */
export const WPN_GROW = 1.6;
/** Strip height (CSS px at u = 1). */
export const WPN_STRIP_H = 30;
/** Open / grow animation time (s). */
const ANIM_TIME = 0.28;
/** Miss: the range opens this far past the closest approach (m), inside MISS_CPA. */
const MISS_MARGIN = 40;
const MISS_CPA = 1_500;

export type WpnSetting = 'off' | 'compact' | 'dynamic';
export type WpnOutcome = 'flight' | 'hit' | 'kill' | 'impact' | 'miss' | 'decoyed' | 'lost' | 'notgt';
export type WpnLook = 'closed' | 'strip' | 'video';

export interface WpnTrack {
  /** Missile entity id. */
  readonly id: number;
  /** Short name, as the FIRE button reads: "AMRAAM", "GBU-53". */
  readonly name: string;
  readonly guidance: Guidance;
  readonly bomb: boolean;
  /** Weapon length (m): the chase shot's distance. */
  readonly len: number;
  /** The target it was fired at (a decoyed missile keeps it); null = a GPS aim point. */
  readonly targetId: number | null;
  /** Target label ("MIG-29", "MSL BOAT", "GPS PT"). */
  readonly label: string;
  readonly launchAt: number;
  outcome: WpnOutcome;
  /** Sim time of the outcome (−1 in flight). */
  endAt: number;
  /** Seconds the outcome stays on screen. */
  hold: number;
  /** Range to the target (m). */
  range: number;
  minRange: number;
  /** Expected time to impact (s); Infinity while not closing. */
  tti: number;
  /** Seeker on (pitbull, IR track, terminal seeker). */
  active: boolean;
  /** The outcome came while this weapon had the video. */
  wasVideo: boolean;
  /** Last weapon / target state (the chase shot holds on the wreck after the weapon is gone). */
  readonly pos: Vector3;
  readonly vel: Vector3;
  readonly tgt: Vector3;
  /** Sim time last seen alive in world.missiles. */
  seen: number;
}

export function isHitOutcome(o: WpnOutcome): boolean {
  return o === 'hit' || o === 'kill' || o === 'impact';
}
export function isResultOutcome(o: WpnOutcome): boolean {
  return o === 'miss' || o === 'decoyed' || o === 'lost' || o === 'notgt';
}

/** Progress launch → impact (0..1). */
export function wpnProgress(t: WpnTrack, now: number): number {
  if (t.outcome !== 'flight') return 1;
  const age = Math.max(0, now - t.launchAt);
  if (!Number.isFinite(t.tti)) return 0;
  return Math.max(0, Math.min(1, age / Math.max(1e-3, age + t.tti)));
}

/* ───────────────────────── tracker ───────────────────────── */

const _rel = new Vector3();
const _relV = new Vector3();
const ZERO = new Vector3();

/** Follows the player's weapons in flight and settles each one's outcome. */
export class WpnTracker {
  readonly tracks: WpnTrack[] = [];
  /** Settled ids (a weapon still flying after NO TGT is not picked up again). */
  private readonly done = new Set<number>();
  private readonly ended: { id: number; reason: string }[] = [];
  /** Focus and look of the last plan (wasVideo of an outcome). */
  focusId: number | null = null;
  video = false;

  reset(): void {
    this.tracks.length = 0;
    this.done.clear();
    this.ended.length = 0;
    this.focusId = null;
    this.video = false;
  }

  /** 'munition:end' of one of the player's weapons. */
  onEnd(id: number, reason: string): void {
    this.ended.push({ id, reason });
  }

  find(id: number | null): WpnTrack | null {
    if (id === null) return null;
    for (const t of this.tracks) if (t.id === id) return t;
    return null;
  }

  /**
   * @param missiles     world.missiles
   * @param playerId     the player's entity id
   * @param getEntity    entity by id
   * @param now          sim time (s)
   * @param pipTargetId  the target camera's target (a kill of it holds its DESTROYED hold)
   */
  update(missiles: readonly MissileEntity[], playerId: number, lookup: (id: number) => AnyEntity | null, now: number, pipTargetId: number | null): void {
    const getEntity = (id: number | null) => (id === null ? null : lookup(id));
    // outcomes reported by the sim first (a weapon that killed its target is gone from the scan below)
    for (const e of this.ended) {
      const t = this.find(e.id);
      if (!t || t.outcome !== 'flight') continue;
      const tgt = getEntity(t.targetId);
      let o: WpnOutcome;
      if (tgt && !tgt.alive) o = 'kill';
      else if (e.reason === 'hit' || e.reason === 'proximity') o = tgt ? 'hit' : 'impact';
      else if (t.targetId === null && (e.reason === 'ground' || e.reason === 'water')) o = 'impact';
      else if (e.reason === 'decoyed') o = 'decoyed';
      else o = 'miss';
      this.settle(t, o, now, o === 'kill' && tgt && pipTargetId === t.targetId ? pipHold(tgt) : undefined);
    }
    this.ended.length = 0;

    for (const m of missiles) {
      if (!m.alive || m.shooterId !== playerId || this.done.has(m.id)) continue;
      let t = this.find(m.id);
      const orig = 'originalTargetId' in m ? (m as MissileEntity & { originalTargetId: number | null }).originalTargetId : m.targetId;
      if (!t) {
        const target = getEntity(orig);
        const bomb = m.def.category === 'bomb';
        t = {
          id: m.id,
          // the short name the FIRE button and the HMD's weapon column use ('AMRAAM', 'GBU-53'; #282:
          // the strip and the result card read 'AIM-120D', 'GBU-53/B'); the full name plus '▲ SAME TGT'
          // would overrun the 146 px strip on a phone
          name: m.def.short,
          guidance: m.def.guidance,
          bomb,
          len: m.def.length || 3,
          targetId: orig,
          label: target ? entityLabel(target) || target.name.toUpperCase() : orig === null ? 'GPS PT' : 'TGT',
          launchAt: now - (m.age || 0),
          outcome: 'flight',
          endAt: -1,
          hold: 0,
          range: Infinity,
          minRange: Infinity,
          tti: Infinity,
          active: false,
          wasVideo: false,
          pos: new Vector3(),
          vel: new Vector3(),
          tgt: new Vector3(),
          seen: now,
        };
        this.tracks.push(t);
      }
      t.seen = now;
      const tgt = getEntity(t.targetId);
      const tp = tgt ? tgt.position : m.targetPoint;
      t.pos.copy(m.position);
      t.vel.copy(m.velocity);
      t.tgt.copy(tp);
      _rel.subVectors(tp, m.position);
      const range = _rel.length();
      const tv = tgt && 'velocity' in tgt ? (tgt as { velocity: Vector3 }).velocity : ZERO;
      _relV.subVectors(tv, m.velocity);
      const closing = range > 1e-3 ? -_relV.dot(_rel) / range : 0;
      t.range = range;
      t.minRange = Math.min(t.minRange, range);
      t.tti = t.bomb ? bombTimeToGo(m, tp, now) : closing > 1 ? range / closing : Infinity;
      t.active = m.seekerLocked;
      if (tgt && !tgt.alive) this.settle(t, 'notgt', now);
      else if (m.decoyed) this.settle(t, 'decoyed', now);
      else if ('trackBroken' in m && (m as MissileEntity & { trackBroken: boolean }).trackBroken) this.settle(t, 'lost', now);
      else if (!t.bomb && tgt && t.minRange < MISS_CPA && range > t.minRange + MISS_MARGIN && closing < 0) this.settle(t, 'miss', now);
    }

    for (let i = this.tracks.length - 1; i >= 0; i--) {
      const t = this.tracks[i];
      // gone without an end event (removed from the world): lost
      if (t.outcome === 'flight' && now - t.seen > 0.5) this.settle(t, 'lost', now);
      if (t.outcome !== 'flight' && now - t.endAt > 8) this.tracks.splice(i, 1);
    }
  }

  private settle(t: WpnTrack, o: WpnOutcome, now: number, hold?: number): void {
    t.outcome = o;
    t.endAt = now;
    t.hold = hold ?? (isHitOutcome(o) ? WPN_SPLASH_HOLD : WPN_RESULT_HOLD);
    t.wasVideo = this.video && this.focusId === t.id;
    t.tti = 0;
    this.done.add(t.id);
  }
}

/* ───────────────────────── planner (pure) ───────────────────────── */

export interface WpnChip {
  label: string;
  /** Weapons in this row (grouped by target from 4 in flight up). */
  count: number;
  tti: number;
  prog: number;
  outcome: WpnOutcome;
}

export interface WpnPlan {
  focus: WpnTrack | null;
  look: WpnLook;
  /** Video size (× the slot). */
  scale: number;
  /** Hits in the current SPLASH cluster. */
  splashN: number;
  /** Other weapons under the window (≤ 3 rows, plus a "+N" row as count with an empty label). */
  chips: WpnChip[];
  /** Weapons in flight. */
  flying: number;
}

export interface WpnPlanInput {
  now: number;
  setting: WpnSetting;
  /** A red cue (MISSILE, PULL UP, STALL) or the Sky Tower cut: no video. */
  suppressed: boolean;
  /** Weapon pinned by a tap on the window. */
  pinned: number | null;
  /** Focus of the last plan, since when, and whether it had the video. */
  prevFocus: number | null;
  prevSince: number;
  prevVideo: boolean;
}

const byTti = (a: WpnTrack, b: WpnTrack) => a.tti - b.tti || a.id - b.id;

export function planWpn(tracks: readonly WpnTrack[], inp: WpnPlanInput): WpnPlan {
  const { now } = inp;
  const flying = tracks.filter((t) => t.outcome === 'flight').sort(byTti);
  const plan: WpnPlan = { focus: null, look: 'closed', scale: inp.setting === 'compact' ? 1 : WPN_GROW, splashN: 0, chips: [], flying: flying.length };
  if (inp.setting === 'off') return plan;
  // 1) a SPLASH hold: never cut short (hits close together chain into SPLASH ×N)
  const hits = tracks.filter((t) => isHitOutcome(t.outcome)).sort((a, b) => a.endAt - b.endAt);
  const last = hits[hits.length - 1];
  if (last && now - last.endAt < last.hold) {
    plan.focus = last;
    plan.look = 'video';
    plan.splashN = 1;
    for (let k = hits.length - 2; k >= 0 && hits[k + 1].endAt - hits[k].endAt < WPN_SPLASH_HOLD; k--) plan.splashN++;
  } else {
    // 2) a weapon in its last seconds (an open video stays open until WPN_REOPEN)
    let term: WpnTrack | null = null;
    for (const t of flying) {
      if (t.tti < WPN_TERMINAL || (t.id === inp.prevFocus && inp.prevVideo && t.tti <= WPN_REOPEN)) {
        term = t;
        break;
      }
    }
    if (term) {
      plan.focus = term;
      plan.look = 'video';
    } else {
      // 3) a MISSED / DECOYED / LOST / NO TGT hold
      let res: WpnTrack | null = null;
      for (const t of tracks) if (isResultOutcome(t.outcome) && now - t.endAt < t.hold && (!res || t.endAt > res.endAt)) res = t;
      if (res) {
        plan.focus = res;
        plan.look = res.wasVideo ? 'video' : 'strip';
      } else if (flying.length) {
        // 4) the next to hit (a pinned weapon, else the current one for at least WPN_DWELL s)
        const pinned = inp.pinned !== null ? flying.find((t) => t.id === inp.pinned) : undefined;
        const prev = inp.prevFocus !== null ? flying.find((t) => t.id === inp.prevFocus) : undefined;
        plan.focus = pinned ?? (prev && now - inp.prevSince < WPN_DWELL ? prev : flying[0]);
        plan.look = 'strip';
      }
    }
  }
  if (plan.look === 'video' && inp.suppressed) plan.look = 'strip';
  // chips: the other weapons in flight, then results still on their hold (amber)
  const others = flying.filter((t) => t !== plan.focus);
  const rows: WpnChip[] = [];
  if (flying.length >= 4) {
    for (const t of others) {
      const r = rows.find((c) => c.label === t.label);
      if (r) r.count++;
      else rows.push({ label: t.label, count: 1, tti: t.tti, prog: wpnProgress(t, now), outcome: 'flight' });
    }
  } else for (const t of others) rows.push({ label: t.label, count: 1, tti: t.tti, prog: wpnProgress(t, now), outcome: 'flight' });
  for (const t of tracks) if (t !== plan.focus && isResultOutcome(t.outcome) && now - t.endAt < t.hold) rows.push({ label: t.label, count: 1, tti: 0, prog: 1, outcome: t.outcome });
  if (rows.length > 3) {
    let more = 0;
    for (let i = 2; i < rows.length; i++) more += rows[i].count;
    plan.chips = rows.slice(0, 2);
    plan.chips.push({ label: '', count: more, tti: 0, prog: 0, outcome: 'flight' });
  } else plan.chips = rows;
  return plan;
}

/* ───────────────────────── view (HUD ↔ 3D pass) ───────────────────────── */

/** What the 3D pass (Game → TargetCam.renderWeapon) needs: the animated video rect and the shot. CSS px. */
export interface WpnView {
  open: boolean;
  look: WpnLook;
  /** 0..1: slot-sized → full video (0 with the strip / closed). */
  anim: number;
  /** The window owns the slot this frame (the target camera is neither rendered nor drawn). */
  owns: boolean;
  /** Animated video rect; vh = 0 → no 3D pass. h: its full height (no crop). */
  vx: number;
  vy: number;
  vw: number;
  vh: number;
  h: number;
  /** Strip rect (w = 0: no strip). */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Lowest y of the window, strip and chips (the DLZ scale and the kill feed move under it). */
  bottom: number;
  /** Shot: the weapon (alive = still flying), its last state, the target. */
  focusId: number | null;
  targetId: number | null;
  flying: boolean;
  len: number;
  readonly pos: Vector3;
  readonly vel: Vector3;
  readonly tgt: Vector3;
}

export const wpnView: WpnView = {
  open: false,
  look: 'closed',
  anim: 0,
  owns: false,
  vx: 0,
  vy: 0,
  vw: 0,
  vh: 0,
  h: 0,
  sx: 0,
  sy: 0,
  sw: 0,
  sh: 0,
  bottom: 0,
  focusId: null,
  targetId: null,
  flying: false,
  len: 3,
  pos: new Vector3(),
  vel: new Vector3(),
  tgt: new Vector3(),
};

/** A screen rect as x0 / y0 / x1 / y1 (the warning band's chips row, zones.bandExt). */
export interface BandRect {
  chx0: number;
  chy0: number;
  chx1: number;
  chy1: number;
}

/** HUD-side state of the window (tracker, last plan, tap pin). */
export const wpnState = {
  tracker: new WpnTracker(),
  plan: null as WpnPlan | null,
  pinned: null as number | null,
  since: 0,
};

export function resetWpn(): void {
  wpnState.tracker.reset();
  wpnState.plan = null;
  wpnState.pinned = null;
  wpnState.since = 0;
  wpnView.open = false;
  wpnView.look = 'closed';
  wpnView.anim = 0;
  wpnView.owns = false;
  wpnView.vw = wpnView.vh = wpnView.sw = 0;
  wpnView.focusId = null;
  wpnView.targetId = null;
}

function ease(t: number): number {
  const k = 1 - Math.max(0, Math.min(1, t));
  return 1 - k * k * k;
}

/**
 * Plan this frame and lay the window out in the slot (L.pip*).
 * @param allowed  setting on, a view with room, slot laid out (L.pipW > 0)
 * @param pipShown the target camera window is on screen (the strip docks under it)
 * @param pipTargetId its target (same target: the strip docks flush, ▲ SAME TGT)
 * @param chipH    chip row height incl. gap (CSS px)
 * @param maxBottom the video never reaches below this (the speed / altitude boxes)
 * @param band     the caution chips row as drawn last frame (zones.bandExt; null = none): survival
 *                 cues win, so the video stops growing above it and the strip moves under it
 */
export function stepWpn(
  L: HudLayout,
  inp: Omit<WpnPlanInput, 'pinned' | 'prevFocus' | 'prevSince' | 'prevVideo'>,
  allowed: boolean,
  pipShown: boolean,
  pipTargetId: number | null,
  dt: number,
  chipH: number,
  maxBottom: number,
  band: BandRect | null = null,
): WpnPlan | null {
  const s = wpnState;
  const tr = s.tracker;
  const plan = allowed
    ? planWpn(tr.tracks, { ...inp, pinned: s.pinned, prevFocus: tr.focusId, prevSince: s.since, prevVideo: tr.video })
    : null;
  const focus = plan?.focus ?? null;
  if ((focus?.id ?? null) !== tr.focusId) s.since = inp.now;
  tr.focusId = focus?.id ?? null;
  tr.video = plan?.look === 'video';
  if (s.pinned !== null && !tr.tracks.some((t) => t.id === s.pinned && t.outcome === 'flight')) s.pinned = null;
  s.plan = plan;
  const v = wpnView;
  const look: WpnLook = plan && focus ? plan.look : 'closed';
  v.open = look !== 'closed';
  v.look = look;
  v.anim = Math.max(0, Math.min(1, v.anim + ((look === 'video' ? 1 : -1) * dt) / ANIM_TIME));
  v.owns = v.anim > 0;
  const u = L.u;
  // video: from the slot to `scale` × the slot, anchored at its top-right corner, clear of the speed /
  // altitude boxes (maxBottom)
  let w = L.pipW * (plan?.scale ?? 1);
  let h = L.pipH * (plan?.scale ?? 1);
  if (L.pipY + h > maxBottom) {
    h = Math.max(L.pipH, maxBottom - L.pipY);
    w = Math.max(L.pipW, (h * L.pipW) / Math.max(1, L.pipH));
  }
  w = Math.min(w, Math.max(L.pipW, (L.right - L.left) * 0.42));
  // the caution chips reach into the video's column: it stops growing above them
  if (band && band.chy0 > L.pipY + L.pipH && L.pipY + h > band.chy0 - 3 * u && band.chx1 > L.pipX + L.pipW - w && band.chx0 < L.pipX + L.pipW) {
    h = Math.max(L.pipH, band.chy0 - 3 * u - L.pipY);
    w = Math.max(L.pipW, (h * L.pipW) / Math.max(1, L.pipH));
  }
  const k = ease(v.anim);
  const vw = Math.round(L.pipW + (w - L.pipW) * k);
  const vh = Math.round(L.pipH + (h - L.pipH) * k);
  v.vw = v.owns && L.pipW > 0 ? vw : 0;
  v.vh = v.owns && L.pipW > 0 ? vh : 0;
  v.h = v.vh;
  v.vx = Math.round(L.pipX + L.pipW - vw);
  v.vy = Math.round(L.pipY);
  // strip: under the target camera (flush when it shows the same target), else in the slot
  const same = !!focus && pipShown && focus.targetId !== null && focus.targetId === pipTargetId;
  v.sw = look === 'strip' && L.pipW > 0 ? L.pipW : 0;
  v.sh = Math.round(WPN_STRIP_H * u);
  v.sx = L.pipX;
  v.sy = pipShown ? L.pipY + L.pipH + (same ? 0 : Math.round(4 * u)) : L.pipY;
  // …and the strip moves under them
  if (band && band.chx1 > v.sx && band.chx0 < v.sx + L.pipW && v.sy < band.chy1 && v.sy + v.sh > band.chy0) v.sy = Math.round(band.chy1 + 3 * u);
  let bottom = v.owns ? v.vy + v.vh : v.sw > 0 ? v.sy + v.sh : L.pipY;
  if (plan && v.open) bottom += plan.chips.length * chipH;
  v.bottom = v.open || v.owns ? bottom : 0;
  // the shot
  v.focusId = focus?.id ?? null;
  v.targetId = focus?.targetId ?? null;
  v.flying = focus?.outcome === 'flight';
  if (focus) {
    v.len = focus.len;
    v.pos.copy(focus.pos);
    v.vel.copy(focus.vel);
    v.tgt.copy(focus.tgt);
  }
  return plan;
}

/** Tap on the window: show the next weapon in flight (pinned until it settles). Returns true if consumed. */
export function tapWpn(x: number, y: number): boolean {
  const v = wpnView;
  const inVideo = v.vh > 0 && x >= v.vx && x <= v.vx + v.vw && y >= v.vy && y <= v.vy + v.vh;
  const inStrip = v.sw > 0 && x >= v.sx && x <= v.sx + v.sw && y >= v.sy && y <= v.sy + v.sh;
  if (!inVideo && !inStrip) return false;
  const fly = wpnState.tracker.tracks.filter((t) => t.outcome === 'flight').sort(byTti);
  if (fly.length < 2) return true;
  const i = fly.findIndex((t) => t.id === v.focusId);
  wpnState.pinned = fly[(i + 1) % fly.length].id;
  return true;
}

/* ───────────────────────── drawing ───────────────────────── */

const strCache = new Map<string, string>();
function cached(key: string, make: () => string): string {
  let s = strCache.get(key);
  if (s === undefined) {
    if (strCache.size > 400) strCache.clear();
    s = make();
    strCache.set(key, s);
  }
  return s;
}

/** "T-6.1" / "12" style seconds. */
export function secText(s: number, prefix = ''): string {
  if (!Number.isFinite(s)) return prefix + '--';
  const k = s >= 10 ? Math.ceil(s) : Math.max(0, Math.round(s * 10) / 10);
  return cached(prefix + '|' + k, () => prefix + (s >= 10 ? String(k) : k.toFixed(1)));
}

/** Range: NM with one decimal, metres inside 1 NM ("850 M"). */
export function rangeText(m: number): string {
  if (!Number.isFinite(m)) return '';
  if (m >= 1852) {
    const k = Math.round(m / 185.2);
    return cached('nm|' + k, () => (k >= 1000 ? Math.round(k / 10) : (k / 10).toFixed(1)) + ' NM');
  }
  const k = Math.max(0, Math.round(m / 10) * 10);
  return cached('m|' + k, () => k + ' M');
}

/** Guidance phase tag. */
export function phaseText(t: WpnTrack): string {
  switch (t.guidance) {
    case 'active_radar':
      return t.active ? 'ACTIVE' : 'DL';
    case 'ir':
      return 'IR';
    case 'semi_active':
      return 'SARH';
    case 'tri_mode':
      return t.active ? 'SEEKER' : 'GPS';
    case 'anti_radiation':
      return 'ARM';
    case 'command':
      return 'CMD';
    default:
      return 'GPS';
  }
}

const RESULT_TEXT: Record<string, string> = { miss: 'MISSED', decoyed: 'DECOYED', lost: 'LOST', notgt: 'NO TGT' };
const RESULT_TAG: Record<string, string> = { miss: 'MISS', decoyed: 'DECOY', lost: 'LOST', notgt: 'NO TGT' };

function headLine(t: WpnTrack, same: boolean): string {
  return cached('h|' + t.name + '|' + t.label + '|' + same, () => (same ? `${t.name} ▲ SAME TGT` : `${t.name} ▸ ${t.label}`));
}

/** Outlined tag ("DL", "ACTIVE", "HIT", "MISS") at x (left edge), centred on my; returns its right edge. */
function tag(f: HudFrame, label: string, color: string, x: number, my: number, h: number): number {
  const { pen, L } = f;
  const u = L.u;
  const w = pen.textWidth(label, 8.5) + 7 * u;
  pen.begin();
  pen.roundRect(x, my - h / 2, w, h, 2 * u);
  pen.strokePlain(color, 1);
  pen.text(label, x + 3.5 * u, my + 0.5, color, 8.5, 'left');
  return x + w;
}

function corners(f: HudFrame, x: number, y: number, w: number, h: number, c: number, col: string, top = true): void {
  const { pen } = f;
  pen.begin();
  if (top) {
    pen.line(x, y + c, x, y);
    pen.line(x, y, x + c, y);
    pen.line(x + w - c, y, x + w, y);
    pen.line(x + w, y, x + w, y + c);
  }
  pen.line(x + w, y + h - c, x + w, y + h);
  pen.line(x + w, y + h, x + w - c, y + h);
  pen.line(x + c, y + h, x, y + h);
  pen.line(x, y + h, x, y + h - c);
  pen.strokeGlow(col, 2);
}

/**
 * Draw the window (strip or video chrome) and the chips. Call where the target camera's chrome is drawn
 * (it replaces it while the window owns the slot).
 * @param pipTargetId the target camera's target, when its window shows (the strip's ▲ SAME TGT)
 */
export function drawWpn(f: HudFrame, plan: WpnPlan | null, pipTargetId: number | null): void {
  const v = wpnView;
  if (!plan || !plan.focus || (!(v.owns && v.vh > 0) && v.sw <= 0)) return;
  const { pen, pal, L } = f;
  const u = L.u;
  const t = plan.focus;
  const now = f.world.time;
  const hit = isHitOutcome(t.outcome);
  const result = isResultOutcome(t.outcome);
  const tone = result ? pal.warn : hit || t.tti < WPN_TERMINAL ? pal.bright : pal.main;
  const killHold = t.outcome === 'kill' && now - t.endAt >= WPN_SPLASH_HOLD;
  const bigText = hit
    ? killHold
      ? 'DESTROYED'
      : t.outcome === 'impact'
        ? 'IMPACT'
        : plan.splashN > 1
          ? cached('sx|' + plan.splashN, () => 'SPLASH ×' + plan.splashN)
          : 'SPLASH'
    : result
      ? RESULT_TEXT[t.outcome]
      : null;
  let bottom: number;
  if (v.owns && v.vh > 0) {
    // video chrome over the 3D picture: nothing else prints inside it
    const x = v.vx;
    const y = v.vy;
    const w = v.vw;
    const h = v.vh;
    pen.g.clearRect(x, y, w, h);
    pen.begin();
    pen.rect(x + 0.5, y + 0.5, w - 1, h - 1);
    pen.strokePlain(result ? pal.warn : pal.dim, 1);
    corners(f, x, y, w, h, Math.min(16 * u, h / 3), tone);
    if (v.anim > 0.6) {
      pen.text(headLine(t, false), x + 6 * u, y + 9 * u, pal.white, 9.5, 'left');
      if (plan.flying > 1) pen.text(cached('fl|' + plan.flying, () => plan.flying + ' IN FLT'), x + w - 6 * u, y + 9 * u, pal.main, 9, 'right');
      const sh = 17 * u;
      const sy = y + h - sh;
      pen.setFill('rgba(4,9,7,0.74)');
      pen.g.fillRect(x + 1, sy, w - 2, sh - 1);
      const my = sy + sh / 2;
      if (bigText) {
        const r = tag(f, hit ? 'HIT' : RESULT_TAG[t.outcome], result ? pal.warn : pal.good, x + 5 * u, my, sh - 6 * u);
        pen.text(bigText, r + 6 * u, my, result ? pal.warn : pal.bright, 12, 'left');
        pen.text(t.label, x + w - 6 * u, my, pal.white, 9, 'right');
      } else {
        const r = tag(f, phaseText(t), t.active ? pal.bright : pal.warn, x + 5 * u, my, sh - 6 * u);
        pen.text(secText(t.tti, 'TTI '), r + 6 * u, my, pal.bright, 12, 'left');
        pen.text(rangeText(t.range), x + w - 6 * u, my, pal.white, 9.5, 'right');
        // progress, launch → impact
        pen.setFill('rgba(0,0,0,0.45)');
        pen.g.fillRect(x + 1, sy - 2 * u, w - 2, 2 * u);
        pen.setFill(pal.main);
        pen.g.fillRect(x + 1, sy - 2 * u, (w - 2) * wpnProgress(t, now), 2 * u);
      }
    }
    bottom = y + h;
  } else {
    // strip: data only
    const x = v.sx;
    const y = v.sy;
    const w = v.sw;
    const h = v.sh;
    const same = pipTargetId !== null && t.targetId === pipTargetId && v.sy > L.pipY;
    pen.setFill('rgba(4,9,7,0.74)');
    pen.g.fillRect(x, y, w, h);
    pen.begin();
    pen.rect(x + 0.5, y + 0.5, w - 1, h - 1);
    pen.strokePlain(result ? pal.warn : pal.dim, 1);
    corners(f, x, y, w, h, Math.min(7 * u, h / 3), tone, !same);
    pen.text(headLine(t, same), x + 5 * u, y + 8 * u, pal.white, 9, 'left');
    const my = y + 19.5 * u;
    if (bigText) {
      const r = tag(f, hit ? 'HIT' : RESULT_TAG[t.outcome], result ? pal.warn : pal.good, x + 5 * u, my, 11 * u);
      pen.text(bigText, r + 5 * u, my, result ? pal.warn : pal.bright, 11, 'left');
    } else {
      const r = tag(f, phaseText(t), t.active ? pal.bright : pal.warn, x + 5 * u, my, 11 * u);
      pen.text(secText(t.tti, 'T-'), r + 5 * u, my, pal.bright, 11, 'left');
      pen.text(rangeText(t.range), x + w - 5 * u, my, pal.white, 9.5, 'right');
      pen.setFill('rgba(255,255,255,0.15)');
      pen.g.fillRect(x + 4 * u, y + h - 4 * u, w - 8 * u, 2 * u);
      pen.setFill(pal.main);
      pen.g.fillRect(x + 4 * u, y + h - 4 * u, (w - 8 * u) * wpnProgress(t, now), 2 * u);
    }
    bottom = y + h;
  }
  // chips, right-aligned under the window
  const right = v.owns ? v.vx + v.vw : v.sx + v.sw;
  let cy = bottom + 3 * u;
  const ch = 13 * u;
  for (const c of plan.chips) {
    const res = isResultOutcome(c.outcome);
    const label = c.label === '' ? cached('more|' + c.count, () => `+${c.count} MORE`) : c.count > 1 ? cached('g|' + c.label + '|' + c.count, () => `${c.label} ×${c.count}`) : c.label;
    const val = res ? RESULT_TAG[c.outcome] : c.label === '' ? '' : secText(c.tti) + 's';
    const lw = pen.textWidth(label, 8.5);
    const vw2 = val ? pen.textWidth(val, 8.5) : 0;
    const barW = c.label === '' || res ? 0 : 20 * u;
    const w = lw + vw2 + barW + (val ? 6 * u : 0) + (barW ? 5 * u : 0) + 8 * u;
    const x = right - w;
    pen.setFill('rgba(4,9,7,0.74)');
    pen.g.fillRect(x, cy, w, ch);
    pen.begin();
    pen.rect(x + 0.5, cy + 0.5, w - 1, ch - 1);
    pen.strokePlain(res ? pal.warn : c.label === '' ? pal.dim : pal.dim, 1);
    const my = cy + ch / 2;
    pen.text(label, x + 4 * u, my, res ? pal.warn : c.label === '' ? pal.dim : pal.white, 8.5, 'left');
    const bx = x + 4 * u + lw + 5 * u;
    if (barW) {
      pen.setFill('rgba(255,255,255,0.18)');
      pen.g.fillRect(bx, my - 1 * u, barW, 2 * u);
      pen.setFill(pal.main);
      pen.g.fillRect(bx, my - 1 * u, barW * c.prog, 2 * u);
    }
    if (val) pen.text(val, right - 4 * u, my, res ? pal.warn : pal.bright, 8.5, 'right');
    cy += ch + 2 * u;
  }
}

/** Occupancy: labels make way for the window, strip and chips (level 0, like the target camera). */
export function reserveWpn(f: HudFrame): void {
  const v = wpnView;
  if (!v.open && !v.owns) return;
  const u = f.L.u;
  if (v.owns && v.vh > 0) f.occ.add(v.vx - 4 * u, v.vy - 4 * u, v.vx + v.vw + 4 * u, Math.max(v.vy + v.vh, v.bottom) + 4 * u);
  else if (v.sw > 0) f.occ.add(v.sx - 4 * u, v.sy - 4 * u, v.sx + v.sw + 4 * u, Math.max(v.sy + v.sh, v.bottom) + 4 * u);
}
