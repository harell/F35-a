/**
 * Target camera window (PiP) — HUD side.
 *
 * The window shows a cinematic view of the designated / locked target (render/TargetCam.ts renders the 3D
 * view into it; render/targetCam/pose.ts frames the shot). This module owns everything 2D about it:
 *
 *  - when it is open: a live hostile target (designated or locked), the target-camera setting on, a view
 *    that has room for it (not the tactical map, the missile cam or the padlock/target view, not with the
 *    PCD zoom open). A destroyed target stays on screen for a moment ("DESTROYED") — the payoff shot.
 *  - where: HudLayout.pip* (layout.ts): top right in the HMD views (the DLZ scale and the kill feed move
 *    below / beside it), under the radar inset in the external views.
 *  - the open / close animation ("CRT" grow from the centre line) and the animated rect the 3D pass uses
 *    (`pipView`, read by Game after hud.update: the 3D image fills this frame's rect, so it moves with the
 *    frame on a view change, #62).
 *  - the overlay: corner brackets in the HMD colour, type / NATO name, range and a status pill (SAM
 *    radar state, or the bandit's aspect).
 *  - the Sky Tower cut: when an enemy hit damages the tower, or it starts to fall (whoever brought it
 *    down), the window cuts to the tower (pipLandmarkFocus: opens even with nothing designated) for
 *    long enough to see the hit or the whole collapse, then cuts back to the target with the usual
 *    "new shot" blink. The tower is a landmark, not an entity: pipView.landmark carries it to the 3D
 *    pass (render/targetCam/pose.ts landmarkCamPose frames it).
 *  - the pod (EOTS) view (#199): a ground target or SAM site is shown as the targeting pod sees it, along
 *    the line of sight from the jet at a fixed zoom step (core/pod.ts POD_ZOOM; a tap on the window
 *    cycles WIDE → NARROW → ZOOM), under a crosshair, the TGT readout, the zoom step and the slant range.
 *    With terrain or the overcast deck between the jet and the target the pod has no picture: the 3D
 *    pass is skipped and the window reads MASKED over a dark frame (stepPod, checked 4× a second).
 */
import { Vector3 } from 'three';
import { POD_ZOOM, POD_ZOOM_DEFAULT, isPodTarget, nextPodZoom } from '../../core/pod';
import { COLLAPSE } from '../../core/skyTower';
import type { AircraftType, SamType } from '../../core/types';
import type { TerrainQuery } from '../../sim/api';
import type { CivilPhase } from '../../sim/civil/route';
import type { AnyEntity } from '../../sim/entities';
import type { LandmarkEntity } from '../../sim/landmarks';
import { cloudBetween, lineOfSight } from '../../sim/sensors/los';
import { AIRCRAFT_LABEL, SAM_LABEL, entityLabel, groundLabel } from './format';
import type { HudFrame } from './frame';
import type { HudLayout } from './layout';

/** Seconds a destroyed target stays in the window. */
export const PIP_DESTROYED_HOLD = 3;
/** …a ship (it burns, lists and starts to settle — the sinking itself takes 60–90 s). */
export const PIP_SHIP_HOLD = 6;

/** How long the window holds on `t` after it is destroyed (s). */
export function pipHold(t: AnyEntity): number {
  return t.kind === 'ground' && t.type === 'ship' ? PIP_SHIP_HOLD : PIP_DESTROYED_HOLD;
}
/** Open / close animation time (s). */
const OPEN_TIME = 0.22;

/** Seconds the window shows the Sky Tower after an enemy hit damages it (the blast, the fire taking hold). */
export const PIP_TOWER_HIT_HOLD = 4;
/**
 * …after it starts to fall: the whole collapse (the pod hits the ground at COLLAPSE.impactAt, the ruins
 * settle at COLLAPSE.ruinsAt) and a moment of the dust; shorter than Game's end delay on a collapse.
 */
export const PIP_TOWER_DOWN_HOLD = COLLAPSE.ruinsAt + 1;

/** What the window shows: an entity, or a landmark (the Sky Tower being hit or collapsing). */
export type PipSubject = AnyEntity | LandmarkEntity;

/**
 * The landmark the window cuts to at sim time `time`: one an enemy hit damaged less than
 * PIP_TOWER_HIT_HOLD s ago, or one that started to fall less than PIP_TOWER_DOWN_HOLD s ago (any cause).
 * A function of the sim state alone, so a HUD hidden and shown again (or a pause) never replays it.
 */
export function pipLandmarkFocus(list: readonly LandmarkEntity[] | undefined, time: number): LandmarkEntity | null {
  if (!list) return null;
  for (const lm of list) {
    if (!lm.alive) {
      if (lm.destroyedAt >= 0 && time - lm.destroyedAt < PIP_TOWER_DOWN_HOLD) return lm;
    } else if (lm.damagedAt >= 0 && time - lm.damagedAt < PIP_TOWER_HIT_HOLD) return lm;
  }
  return null;
}

export const NATO_AIR: Record<AircraftType, string> = {
  f35a: 'LIGHTNING',
  mig29: 'FULCRUM',
  su27: 'FLANKER',
  su35: 'FLANKER-E',
  su57: 'FELON',
  a320: '', // civil airliner: no reporting name (pipName shows its callsign)
  shahed136: 'DRONE', // no NATO reporting name: the PiP reads "SHAHED-136 DRONE"
};

export const NATO_SAM: Record<SamType, string> = {
  sa6: 'GAINFUL',
  sa15: 'GAUNTLET',
  zsu23: 'SHILKA',
  ad_boat: '', // no reporting name: the PiP shows "AD BOAT" once
};

export type PipTone = 'main' | 'warn' | 'danger' | 'dim' | 'good' | 'civil';

/** Civil traffic (neutral airliners, ships): drawn in white like the HMD's CIV boxes, never as a threat. */
export function isCivil(t: AnyEntity): boolean {
  return t.team === 'neutral';
}

/** What a civil airliner is doing (its scripted flight phase). */
const CIVIL_PHASE: Record<CivilPhase, string> = {
  approach: 'APPROACH',
  flare: 'LANDING',
  rollout: 'LANDING',
  taxi: 'TAXI',
  takeoff: 'TAKEOFF',
  climb: 'CLIMB',
  enroute: 'CRUISE',
};

/**
 * Name line ("SA-6 GAINFUL", "MIG-29 FULCRUM", "AEROFLOP 104 A320", "SHIP").
 * @param short  narrow window: just the callsign (civil) or the type designation (military)
 */
export function pipName(t: AnyEntity, short = false): string {
  if (t.kind === 'aircraft' && isCivil(t)) {
    const cs = (t.callsign || t.name).toUpperCase();
    return short ? cs : `${cs} ${AIRCRAFT_LABEL[t.type] ?? ''}`.trim();
  }
  if (t.kind === 'ground' && isCivil(t)) {
    // civil ship: its name ("MV KŌTUKU TRADER"; narrow window: "KŌTUKU TRADER")
    const n = t.name.toUpperCase();
    return short ? n.replace(/^(MV|MS|MSC|SS) /, '') : n;
  }
  if (short && t.kind === 'aircraft') return AIRCRAFT_LABEL[t.type] ?? t.type.toUpperCase();
  if (short && t.kind === 'sam') return SAM_LABEL[t.type] ?? t.type.toUpperCase();
  if (t.kind === 'aircraft') return `${AIRCRAFT_LABEL[t.type] ?? t.type.toUpperCase()} ${NATO_AIR[t.type] ?? ''}`.trim();
  if (t.kind === 'sam') return `${SAM_LABEL[t.type] ?? t.type.toUpperCase()} ${NATO_SAM[t.type] ?? ''}`.trim();
  if (t.kind === 'ground') return groundLabel(t);
  return t.name.toUpperCase();
}

/**
 * Status pill. SAM: what its radar is doing. Aircraft: aspect relative to the player (HOT = pointing at
 * us, FLANK = beaming, COLD = running). Civil airliner: its flight phase, or CHECK FIRE once the player
 * has locked it. Civil ship: UNDERWAY / ANCHORED / MOORED (CHECK FIRE when locked). Ground: TGT.
 */
export function pipStatus(t: AnyEntity, playerPos: { x: number; y: number; z: number }, locked = false): { text: string; tone: PipTone } {
  if (isCivil(t)) {
    if (!t.alive) return { text: t.kind === 'ground' ? 'SINKING' : 'DOWN', tone: 'danger' };
    if (locked) return { text: 'CHECK FIRE', tone: 'warn' };
    if (t.kind === 'ground') return { text: t.velocity.lengthSq() > 0.25 ? 'UNDERWAY' : t.anchored ? 'ANCHORED' : 'MOORED', tone: 'civil' };
    const phase = t.kind === 'aircraft' ? t.civil?.phase : undefined;
    return { text: phase ? CIVIL_PHASE[phase] : 'CIVIL', tone: 'civil' };
  }
  if (!t.alive) return { text: 'DESTROYED', tone: 'good' };
  if (t.kind === 'sam') {
    if (!t.radarOn || t.state === 'off' || t.state === 'emcon') return { text: 'SILENT', tone: 'dim' };
    switch (t.state) {
      case 'search':
        return { text: 'SEARCH', tone: 'warn' };
      case 'track':
        return { text: 'TRACK', tone: 'danger' };
      case 'launch':
      case 'guiding':
        return { text: 'LAUNCH', tone: 'danger' };
      case 'reload':
        return { text: 'RELOAD', tone: 'dim' };
    }
    return { text: 'SEARCH', tone: 'warn' };
  }
  if (t.kind === 'aircraft') {
    const vx = t.velocity.x;
    const vy = t.velocity.y;
    const vz = t.velocity.z;
    const sp = Math.hypot(vx, vy, vz);
    const dx = playerPos.x - t.position.x;
    const dy = playerPos.y - t.position.y;
    const dz = playerPos.z - t.position.z;
    const d = Math.hypot(dx, dy, dz);
    if (sp < 1 || d < 1) return { text: 'TGT', tone: 'main' };
    const c = (vx * dx + vy * dy + vz * dz) / (sp * d);
    if (c > 0.5) return { text: 'HOT', tone: 'danger' };
    if (c < -0.5) return { text: 'COLD', tone: 'main' };
    return { text: 'FLANK', tone: 'warn' };
  }
  return { text: 'TGT', tone: 'main' };
}

/** Shared state between the HUD (owner) and the 3D pass (Game → TargetCam). CSS px. */
export interface PipView {
  /** A target is shown (the window may still be animating). */
  open: boolean;
  /** 0..1 open animation. */
  anim: number;
  targetId: number | null;
  /** A landmark shot (the Sky Tower hit / collapsing) instead of an entity: targetId is null then. */
  landmark: LandmarkEntity | null;
  /** Full window rect (layout). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Animated rect (what the 3D pass fills this frame); vh = 0 → nothing to render. */
  vx: number;
  vy: number;
  vw: number;
  vh: number;
  /** The pod (EOTS) view of a ground target / SAM site (stepPod), not the cinematic shot. */
  pod: boolean;
  /** Pod zoom step (index into core/pod.ts POD_ZOOM); kept across targets, a tap on the window cycles it. */
  zoom: number;
  /** Pod view with no line of sight ('' = clear): nothing is rendered and the window reads MASKED. */
  mask: PodMask;
}

/** Why the pod has no picture: terrain or a solid cloud deck between the jet and the target. */
export type PodMask = '' | 'TERRAIN' | 'CLOUD';

export const pipView: PipView = {
  open: false,
  anim: 0,
  targetId: null,
  landmark: null,
  x: 0,
  y: 0,
  w: 0,
  h: 0,
  vx: 0,
  vy: 0,
  vw: 0,
  vh: 0,
  pod: false,
  zoom: POD_ZOOM_DEFAULT,
  mask: '',
};

/**
 * Internal tracking (the destroyed-target hold, target switches). `shot`: what was on screen (entity id,
 * or the landmark's id) — a change while open is a cut, shown with the re-open blink.
 */
const track = { id: null as number | null, deadAge: 0, shot: null as number | string | null };

export function resetPip(): void {
  pipView.open = false;
  pipView.anim = 0;
  pipView.targetId = null;
  pipView.landmark = null;
  pipView.vw = pipView.vh = 0;
  pipView.pod = false;
  pipView.mask = '';
  track.id = null;
  track.deadAge = 0;
  track.shot = null;
  pod.id = null;
}

/** Back to the default zoom step (a new sortie / a new jet). */
export function resetPodZoom(): void {
  pipView.zoom = POD_ZOOM_DEFAULT;
}

/** Seconds between two line-of-sight checks of the pod (a terrain ray march: not every frame). */
export const POD_LOS_PERIOD = 0.25;
/** The pod's line of sight ends this far above the target's origin (m). */
const POD_LOS_LIFT = 1.5;

/** Pod bookkeeping: the target the line of sight was last checked for, and how long ago. */
const pod = { id: null as number | null, age: 0 };
const _losTgt = new Vector3();

/**
 * Line of sight of the pod from `eye` to `tgt`: CLOUD with a solid deck (base `cloud`, core/weather.ts
 * cloudBase) between them, TERRAIN with the ground in the way, '' when the pod can see the target.
 */
export function podMask(eye: Vector3, tgt: Vector3, terrain: TerrainQuery, cloud: number | null): PodMask {
  if (cloudBetween(eye.y, tgt.y, cloud)) return 'CLOUD';
  return lineOfSight(terrain, eye, tgt) ? '' : 'TERRAIN';
}

/**
 * Pod state for this frame (after stepPip): the pod view for a ground target / SAM site on screen,
 * and its line of sight from the player's jet (re-checked every POD_LOS_PERIOD s, at once on a new target).
 */
export function stepPod(subject: PipSubject | null, eye: Vector3, terrain: TerrainQuery, cloud: number | null, dt: number): void {
  if (!subject || subject.kind === 'landmark' || !isPodTarget(subject)) {
    pipView.pod = false;
    pipView.mask = '';
    pod.id = null;
    return;
  }
  pipView.pod = true;
  if (subject.id !== pod.id) {
    pod.id = subject.id;
    pod.age = Infinity;
  }
  pod.age += dt;
  if (pod.age < POD_LOS_PERIOD) return;
  pod.age = 0;
  _losTgt.copy(subject.position);
  _losTgt.y += POD_LOS_LIFT;
  pipView.mask = podMask(eye, _losTgt, terrain, cloud);
}

/** A tap on the pod window: next zoom step. False when the tap isn't on an open pod window. */
export function tapPip(x: number, y: number): boolean {
  const v = pipView;
  if (!v.pod || v.vh <= 0 || x < v.vx || x > v.vx + v.vw || y < v.vy || y > v.vy + v.vh) return false;
  v.zoom = nextPodZoom(v.zoom);
  return true;
}

/** Ease-out cubic. */
function ease(t: number): number {
  const k = 1 - Math.max(0, Math.min(1, t));
  return 1 - k * k * k;
}

/**
 * Advance the window state for this frame.
 * @param target   live hostile designated / locked target (HudFrame.target) or null
 * @param lookup   entity by id (to keep showing a just-destroyed target)
 * @param allowed  the setting is on and this view has room for the window (L.pipW > 0)
 * @param landmark a landmark to cut to (pipLandmarkFocus): it takes the window over the target while set
 * @param asset    a protected asset whose loss failed the mission (the Sky Tower falling, the tanker
 *                 sinking): it takes the window over everything, the setting included (the caller
 *                 checks the view has room for it)
 * @returns the entity (may be dead during the hold) or landmark to show, or null
 */
export function stepPip(
  L: HudLayout,
  target: AnyEntity | null,
  lookup: (id: number) => AnyEntity | null,
  allowed: boolean,
  dt: number,
  landmark: LandmarkEntity | null = null,
  asset: PipSubject | null = null,
): PipSubject | null {
  let show: AnyEntity | null = null;
  // the target on screen just died: hold the shot for the explosion, even when the radar has already
  // moved on to the next target (the cut to it follows the hold)
  const prev = track.id !== null && (!target || target.id !== track.id) ? lookup(track.id) : null;
  if (prev && !prev.alive && track.deadAge < pipHold(prev)) {
    track.deadAge += dt;
    show = prev;
  } else if (target) {
    show = target;
    track.deadAge = 0;
  }
  if (!allowed) show = null;
  // the tower being hit / falling takes the window over (the entity bookkeeping above carries on under it)
  const subject: PipSubject | null = asset ?? (allowed && landmark ? landmark : show);
  const shot = subject ? subject.id : null; // entity id, or the landmark's id ('skytower')
  const switched = shot !== null && track.shot !== null && shot !== track.shot && pipView.anim > 0.5;
  track.id = show ? show.id : target ? target.id : null;
  track.shot = shot ?? (target ? target.id : null);
  if (!show || show.alive) track.deadAge = 0;
  pipView.open = !!subject;
  if (subject && subject.kind === 'landmark') {
    pipView.landmark = subject;
    pipView.targetId = null;
  } else if (subject) {
    pipView.landmark = null;
    pipView.targetId = subject.id;
  }
  // a new target (or the cut to / from the tower) while open: quick re-open "blink" so the cut reads as a new shot
  if (switched) pipView.anim = 0.35;
  pipView.anim = Math.max(0, Math.min(1, pipView.anim + (subject ? dt : -dt) / OPEN_TIME));
  if (!subject && pipView.anim <= 0) {
    pipView.targetId = null;
    pipView.landmark = null;
  }
  pipView.x = L.pipX;
  pipView.y = L.pipY;
  pipView.w = L.pipW;
  pipView.h = L.pipH;
  const k = ease(pipView.anim);
  const vh = L.pipW > 0 ? Math.round(L.pipH * k) : 0;
  pipView.vx = Math.round(L.pipX);
  pipView.vw = Math.round(L.pipW);
  pipView.vh = vh >= 2 ? vh : 0;
  pipView.vy = Math.round(L.pipY + (L.pipH - vh) / 2);
  return subject ?? pipView.landmark ?? (pipView.targetId !== null ? lookup(pipView.targetId) : null);
}

/* ───────────────────────── overlay ───────────────────────── */

/** Short forms of the status tags for narrow windows. */
const STATUS_SHORT: Record<string, string> = {
  DESTROYED: 'KILL',
  SEARCH: 'SRCH',
  RELOAD: 'RLD',
  SILENT: 'OFF',
  LAUNCH: 'LNCH',
  'CHECK FIRE': 'CHK FIRE',
  APPROACH: 'APPR',
  TAKEOFF: 'T/O',
  LANDING: 'LDG',
  UNDERWAY: 'U/W',
  ANCHORED: 'ANCH',
  MOORED: 'MRD',
};

let rangeKey = -1;
let rangeText = '';
function rangeLabel(m: number): string {
  const k = Math.round(m / 185.2); // 0.1 NM steps
  if (k !== rangeKey) {
    rangeKey = k;
    rangeText = k >= 1000 ? `${Math.round(k / 10)} NM` : `${(k / 10).toFixed(1)} NM`;
  }
  return rangeText;
}

/**
 * Draw the window chrome over the 3D view. Clears the HUD canvas inside the window first so no
 * symbology overprints the picture. Call late (after the conformal symbology, before warnings / cues).
 */
export function drawPip(f: HudFrame, t: PipSubject | null): void {
  const v = pipView;
  if (!t || v.vh <= 0) return;
  if (t.kind === 'landmark') {
    drawLandmarkPip(f, t);
    return;
  }
  const { pal } = f;
  const locked = f.locked && f.target === t;
  if (v.pod) {
    drawPodPip(f, t, locked);
    return;
  }
  const civil = isCivil(t);
  drawFrame(f, civil ? pal.white : locked ? pal.bright : pal.main);
  if (v.anim < 0.9) return; // labels once the window is open
  drawLabels(f, t, locked, civil);
}

/** Thin frame and corner brackets of the window (the HUD canvas cleared inside it first). */
function drawFrame(f: HudFrame, col: string): void {
  const v = pipView;
  const { pen, pal, L } = f;
  const u = L.u;
  const x = v.vx;
  const y = v.vy;
  const w = v.vw;
  const h = v.vh;
  pen.g.clearRect(x, y, w, h);
  pen.begin();
  pen.rect(x + 0.5, y + 0.5, w - 1, h - 1);
  pen.strokePlain(pal.dim, 1);
  const c = Math.min(16 * u, h / 3);
  pen.begin();
  pen.line(x, y + c, x, y);
  pen.line(x, y, x + c, y);
  pen.line(x + w - c, y, x + w, y);
  pen.line(x + w, y, x + w, y + c);
  pen.line(x + w, y + h - c, x + w, y + h);
  pen.line(x + w, y + h, x + w - c, y + h);
  pen.line(x + c, y + h, x, y + h);
  pen.line(x, y + h, x, y + h - c);
  pen.strokeGlow(col, 2);
}

/**
 * The Sky Tower shot: "SKY TOWER" and a status pill — HIT (amber) while the first enemy hit burns,
 * DOWN (red) while it falls — over the range to it.
 */
function drawLandmarkPip(f: HudFrame, lm: LandmarkEntity): void {
  const { pen, pal, L, p } = f;
  const u = L.u;
  const v = pipView;
  const down = !lm.alive;
  const tone = down ? pal.danger : pal.warn;
  drawFrame(f, tone);
  if (v.anim < 0.9) return;
  const x = v.vx;
  const y = v.vy;
  const w = v.vw;
  const h = v.vh;
  pen.text(lm.name.toUpperCase(), x + 6 * u, y + 9 * u, pal.white, 10, 'left');
  const sh = 16 * u;
  const sy = y + h - sh;
  pen.setFill('rgba(4,9,7,0.72)');
  pen.g.fillRect(x + 1, sy, w - 2, sh - 1);
  const my = sy + sh / 2;
  const ix = x + 10 * u;
  pen.begin();
  pen.diamond(ix, my, 5 * u);
  pen.strokePlain(pal.friend, 1.5);
  pen.text(rangeLabel(lm.base.distanceTo(p.position)), ix + 9 * u, my, pal.white, 10, 'left');
  pill(f, down ? PIP_TOWER_DOWN_TAG : PIP_TOWER_HIT_TAG, tone, true, x + w - 5 * u, my, sh);
}

/** Status tags of the Sky Tower shot. */
export const PIP_TOWER_HIT_TAG = 'HIT';
export const PIP_TOWER_DOWN_TAG = 'DOWN';

/** Outlined status pill ending at `right`, with a blinking dot when `blinks`. */
function pill(f: HudFrame, label: string, tone: string, blinks: boolean, right: number, my: number, sh: number): void {
  const { pen, L } = f;
  const u = L.u;
  const tw = pen.textWidth(label, 9);
  const pw = tw + 18 * u;
  const px = right - pw;
  const ph = sh - 5 * u;
  pen.begin();
  pen.roundRect(px, my - ph / 2, pw, ph, 2 * u);
  pen.strokePlain(tone, 1);
  if (!blinks || f.st.clock % 1 < 0.6) {
    pen.begin();
    pen.circle(px + 6 * u, my, 2.2 * u);
    pen.fillPlain(tone);
  }
  pen.text(label, px + 11 * u, my + 0.5, tone, 9, 'left');
}

function drawLabels(f: HudFrame, t: AnyEntity, locked: boolean, civil: boolean): void {
  const v = pipView;
  const { pen, pal, L, p } = f;
  const u = L.u;
  const x = v.vx;
  const y = v.vy;
  const w = v.vw;
  const h = v.vh;
  const g = pen.g;
  // name (top left) + lock tag (top right)
  const tag = civil ? (locked ? 'LOCK' : 'CIV') : locked ? 'LOCK' : '';
  const tagW = tag ? pen.textWidth(tag, 9) + 8 * u : 0;
  const room = w - 12 * u - tagW;
  let name = pipName(t);
  if (pen.textWidth(name, 10) > room) name = pipName(t, true);
  // still too long (a long ship name in a narrow window): clip it rather than overprint the tag
  if (pen.textWidth(name, 10) > room) {
    while (name.length > 3 && pen.textWidth(`${name}…`, 10) > room) name = name.slice(0, -1).trimEnd();
    name = `${name}…`;
  }
  pen.text(name, x + 6 * u, y + 9 * u, pal.white, 10, 'left');
  if (tag) pen.text(tag, x + w - 6 * u, y + 9 * u, civil ? (locked ? pal.warn : pal.white) : pal.bright, 9, 'right');
  // bottom strip: threat icon, range, status pill
  const sh = 16 * u;
  const sy = y + h - sh;
  pen.setFill('rgba(4,9,7,0.72)');
  g.fillRect(x + 1, sy, w - 2, sh - 1);
  const my = sy + sh / 2;
  const ix = x + 10 * u;
  const danger = civil ? pal.white : t.team !== p.team ? pal.danger : pal.friend;
  pen.begin();
  if (civil) {
    // neutral symbol: a circle (not a threat chevron / diamond)
    pen.circle(ix, my, 4.5 * u);
  } else if (t.kind === 'aircraft') {
    g.moveTo(ix, my - 5 * u);
    g.lineTo(ix + 5 * u, my + 5 * u);
    g.lineTo(ix, my + 2 * u);
    g.lineTo(ix - 5 * u, my + 5 * u);
    g.closePath();
  } else pen.diamond(ix, my, 5 * u);
  pen.strokePlain(danger, 1.5);
  const range = rangeLabel(t.position.distanceTo(p.position));
  pen.text(range, ix + 9 * u, my, pal.white, 10, 'left');
  const rangeRight = ix + 9 * u + pen.textWidth(range, 10);
  const st = pipStatus(t, p.position, locked);
  const tone =
    st.tone === 'danger' ? pal.danger : st.tone === 'warn' ? pal.warn : st.tone === 'good' ? pal.good : st.tone === 'dim' ? pal.dim : st.tone === 'civil' ? pal.white : pal.main;
  // pill: outlined, blinking dot for the active states
  // (a narrow window: the long DESTROYED tag falls back to KILL rather than overprinting the range)
  let label = st.text;
  if (x + w - 5 * u - (pen.textWidth(label, 9) + 18 * u) < rangeRight + 6 * u) label = STATUS_SHORT[label] ?? label;
  pill(f, label, tone, st.tone === 'danger' || st.tone === 'warn', x + w - 5 * u, my, sh);
}

/* ───────────────────────── pod (EOTS) overlay ───────────────────────── */

/** The TGT readout line of the pod window ("TGT SA-6", "LOCK HANGAR"), as the PCD's TGT line reads. */
export function podReadout(t: AnyEntity, locked: boolean): string {
  return (locked ? 'LOCK ' : 'TGT ') + entityLabel(t);
}

/** Text of the masked pod window. */
export const POD_MASKED = 'MASKED';

/**
 * Pod view chrome: the crosshair, the TGT readout (top left), the zoom step (top right), and the slant
 * range with the status pill in the bottom strip. Masked: a dark frame reading MASKED and why.
 */
function drawPodPip(f: HudFrame, t: AnyEntity, locked: boolean): void {
  const v = pipView;
  const { pen, pal, L, p } = f;
  const u = L.u;
  drawFrame(f, locked ? pal.bright : pal.main);
  const x = v.vx;
  const y = v.vy;
  const w = v.vw;
  const h = v.vh;
  const cx = x + w / 2;
  const cy = y + h / 2;
  if (v.mask) {
    // no picture: the 3D pass is skipped, so the frame is filled opaque over the world
    pen.setFill('#050a08');
    pen.g.fillRect(x + 1, y + 1, w - 2, h - 2);
    if (v.anim < 0.9) return;
    pen.text(POD_MASKED, cx, cy - 5 * u, pal.warn, 12, 'center');
    pen.text(v.mask, cx, cy + 9 * u, pal.dim, 9, 'center');
  } else {
    // crosshair: four arms from the edges in towards a gap at the centre
    const gap = 6 * u;
    const arm = Math.min(w, h) * 0.3;
    pen.begin();
    pen.line(cx - gap - arm, cy, cx - gap, cy);
    pen.line(cx + gap, cy, cx + gap + arm, cy);
    pen.line(cx, cy - gap - arm * 0.6, cx, cy - gap);
    pen.line(cx, cy + gap, cx, cy + gap + arm * 0.6);
    pen.strokeGlow(pal.main, 1.2);
  }
  if (v.anim < 0.9) return;
  const zoom = POD_ZOOM[v.zoom]?.name ?? '';
  pen.text(zoom, x + w - 6 * u, y + 9 * u, pal.bright, 9, 'right');
  const room = w - 18 * u - pen.textWidth(zoom, 9);
  let name = podReadout(t, locked);
  while (name.length > 4 && pen.textWidth(name, 10) > room) name = name.slice(0, -1);
  pen.text(name, x + 6 * u, y + 9 * u, locked ? pal.bright : pal.white, 10, 'left');
  if (v.mask) return;
  // bottom strip: slant range (NM, as the rest of the HUD) and the status pill
  const sh = 16 * u;
  const sy = y + h - sh;
  pen.setFill('rgba(4,9,7,0.72)');
  pen.g.fillRect(x + 1, sy, w - 2, sh - 1);
  const my = sy + sh / 2;
  const range = rangeLabel(t.position.distanceTo(p.position));
  pen.text('SR', x + 6 * u, my, pal.dim, 9, 'left');
  const rx = x + 6 * u + pen.textWidth('SR ', 9);
  pen.text(range, rx, my, pal.white, 10, 'left');
  const rangeRight = rx + pen.textWidth(range, 10);
  const st = pipStatus(t, p.position, locked);
  const tone = st.tone === 'danger' ? pal.danger : st.tone === 'warn' ? pal.warn : st.tone === 'good' ? pal.good : st.tone === 'dim' ? pal.dim : pal.main;
  let label = st.text;
  if (x + w - 5 * u - (pen.textWidth(label, 9) + 18 * u) < rangeRight + 6 * u) label = STATUS_SHORT[label] ?? label;
  pill(f, label, tone, st.tone === 'danger' || st.tone === 'warn', x + w - 5 * u, my, sh);
}
