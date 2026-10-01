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
 *    (`pipView`, read by Game right after the main render — one frame behind the HUD, invisible).
 *  - the overlay: corner brackets in the HMD colour, type / NATO name, range and a status pill (SAM
 *    radar state, or the bandit's aspect).
 */
import type { AircraftType, SamType } from '../../core/types';
import type { CivilPhase } from '../../sim/civil/route';
import type { AnyEntity } from '../../sim/entities';
import { AIRCRAFT_LABEL, GROUND_LABEL, SAM_LABEL } from './format';
import type { HudFrame } from './frame';
import type { HudLayout } from './layout';

/** Seconds a destroyed target stays in the window. */
export const PIP_DESTROYED_HOLD = 3;
/** Open / close animation time (s). */
const OPEN_TIME = 0.22;

export const NATO_AIR: Record<AircraftType, string> = {
  f35a: 'LIGHTNING',
  mig29: 'FULCRUM',
  su27: 'FLANKER',
  su35: 'FLANKER-E',
  su57: 'FELON',
  tu22m: 'BACKFIRE',
  a50: 'MAINSTAY',
  a320: '', // civil airliner: no reporting name (pipName shows its callsign)
};

export const NATO_SAM: Record<SamType, string> = {
  sa6: 'GAINFUL',
  sa8: 'GECKO',
  sa10: 'GRUMBLE',
  sa15: 'GAUNTLET',
  sa18: 'GROUSE',
  zsu23: 'SHILKA',
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
  if (t.kind === 'ground' && isCivil(t)) return t.name.toUpperCase(); // civil ship: its name
  if (short && t.kind === 'aircraft') return AIRCRAFT_LABEL[t.type] ?? t.type.toUpperCase();
  if (short && t.kind === 'sam') return SAM_LABEL[t.type] ?? t.type.toUpperCase();
  if (t.kind === 'aircraft') return `${AIRCRAFT_LABEL[t.type] ?? t.type.toUpperCase()} ${NATO_AIR[t.type] ?? ''}`.trim();
  if (t.kind === 'sam') return `${SAM_LABEL[t.type] ?? t.type.toUpperCase()} ${NATO_SAM[t.type] ?? ''}`.trim();
  if (t.kind === 'ground') return GROUND_LABEL[t.type] ?? t.type.toUpperCase();
  return t.name.toUpperCase();
}

/**
 * Status pill. SAM: what its radar is doing. Aircraft: aspect relative to the player (HOT = pointing at
 * us, FLANK = beaming, COLD = running). Civil airliner: its flight phase, or CHECK FIRE once the player
 * has locked it. Ground: TGT.
 */
export function pipStatus(t: AnyEntity, playerPos: { x: number; y: number; z: number }, locked = false): { text: string; tone: PipTone } {
  if (isCivil(t)) {
    if (!t.alive) return { text: t.kind === 'ground' ? 'SINKING' : 'DOWN', tone: 'danger' };
    if (locked) return { text: 'CHECK FIRE', tone: 'warn' };
    if (t.kind === 'ground') return { text: t.velocity.lengthSq() > 0.25 ? 'UNDERWAY' : 'CIVIL', tone: 'civil' };
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
}

export const pipView: PipView = { open: false, anim: 0, targetId: null, x: 0, y: 0, w: 0, h: 0, vx: 0, vy: 0, vw: 0, vh: 0 };

/** Internal tracking (the destroyed-target hold, target switches). */
const track = { id: null as number | null, deadAge: 0 };

export function resetPip(): void {
  pipView.open = false;
  pipView.anim = 0;
  pipView.targetId = null;
  pipView.vw = pipView.vh = 0;
  track.id = null;
  track.deadAge = 0;
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
 * @returns the entity to show (may be dead during the hold) or null
 */
export function stepPip(L: HudLayout, target: AnyEntity | null, lookup: (id: number) => AnyEntity | null, allowed: boolean, dt: number): AnyEntity | null {
  let show: AnyEntity | null = null;
  // the target on screen just died: hold the shot for the explosion, even when the radar has already
  // moved on to the next target (the cut to it follows the hold)
  const prev = track.id !== null && (!target || target.id !== track.id) ? lookup(track.id) : null;
  if (prev && !prev.alive && track.deadAge < PIP_DESTROYED_HOLD) {
    track.deadAge += dt;
    show = prev;
  } else if (target) {
    show = target;
    track.deadAge = 0;
  }
  if (!allowed) show = null;
  const switched = !!show && track.id !== null && show.id !== track.id && pipView.anim > 0.5;
  track.id = show ? show.id : target ? target.id : null;
  if (!show || show.alive) track.deadAge = 0;
  pipView.open = !!show;
  if (show) pipView.targetId = show.id;
  // a new target while open: quick re-open "blink" so the cut reads as a new shot
  if (switched) pipView.anim = 0.35;
  pipView.anim = Math.max(0, Math.min(1, pipView.anim + (show ? dt : -dt) / OPEN_TIME));
  if (!show && pipView.anim <= 0) pipView.targetId = null;
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
  return pipView.targetId !== null ? (show ?? lookup(pipView.targetId)) : null;
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
export function drawPip(f: HudFrame, t: AnyEntity | null): void {
  const v = pipView;
  if (!t || v.vh <= 0) return;
  const { pen, pal, L, p } = f;
  const u = L.u;
  const x = v.vx;
  const y = v.vy;
  const w = v.vw;
  const h = v.vh;
  const g = pen.g;
  g.clearRect(x, y, w, h);
  const locked = f.locked && f.target === t;
  const civil = isCivil(t);
  const col = civil ? pal.white : locked ? pal.bright : pal.main;
  // thin frame + corner brackets
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
  if (v.anim < 0.9) return; // labels once the window is open
  // name (top left) + lock tag (top right)
  const tag = civil ? (locked ? 'LOCK' : 'CIV') : locked ? 'LOCK' : '';
  const tagW = tag ? pen.textWidth(tag, 9) + 8 * u : 0;
  let name = pipName(t);
  if (pen.textWidth(name, 10) > w - 12 * u - tagW) name = pipName(t, true);
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
  const tw = pen.textWidth(label, 9);
  const pw = tw + 18 * u;
  const px = x + w - 5 * u - pw;
  const ph = sh - 5 * u;
  pen.begin();
  pen.roundRect(px, my - ph / 2, pw, ph, 2 * u);
  pen.strokePlain(tone, 1);
  const blink = st.tone === 'danger' || st.tone === 'warn' ? f.st.clock % 1 < 0.6 : true;
  if (blink) {
    pen.begin();
    pen.circle(px + 6 * u, my, 2.2 * u);
    pen.fillPlain(tone);
  }
  pen.text(label, px + 11 * u, my + 0.5, tone, 9, 'left');
}
