/**
 * Weapon symbology: status block (master mode, selected weapon + count, countermeasures, EMCON,
 * release denials), DLZ scale with target caret / time of flight, SHOOT cue, AIM-9X seeker circle,
 * gun LCOS pipper + EEGS funnel, bomb CCIP pipper and JDAM/SDB release cue (azimuth steering line,
 * time to release, IN RANGE).
 */
import { DEG, G, dirFromHeadingPitch, forwardOf, rightOf, toKnots, upOf } from '../../core/math';
import type { Vector3 } from 'three';
import type { WeaponId } from '../../core/types';
import type { BombCue } from '../../sim/api';
import { dlzLayout, makeDlzGeometry } from './dlz';
import { INT_STR, NumText, WEAPON_BREVITY, WEAPON_HUD, WEAPON_IS_BOMB } from './format';
import { blink, type HudFrame } from './frame';
import { TEST_HOOKS } from '../../core/data';
import { noteCue, noteFunnelBar, notePipper } from './drawn';
import { colText } from './flight';
import { weaponMismatch } from '../../sim/weapons/fit';

const dlzGeom = makeDlzGeometry();
const tofTxt = new NumText(0, 'TOF ');
const vcTxt = new NumText(0);
const relTxt = new NumText(0, 'REL ');
const flTxt = new NumText(0, 'FL ');
const chTxt = new NumText(0, 'CH ');

const weaponLine: Record<string, string> = {};
function weaponLabel(w: WeaponId, n: number): string {
  const key = w + n;
  let s = weaponLine[key];
  if (!s) weaponLine[key] = s = WEAPON_HUD[w] + ' ' + (n < 400 ? INT_STR[n] : String(n));
  return s;
}

export function remainingOf(f: HudFrame, w: WeaponId): number {
  if (w === 'gun') return f.p.gunAmmo;
  try {
    return f.world.combat.remaining(f.p, w);
  } catch {
    let n = 0;
    for (const s of f.p.stores) if (s.weapon === w) n += s.count;
    return n;
  }
}

/* ───────────────────────── Weapon status block ───────────────────────── */

/**
 * The selected weapon can't engage the boxed target ('AIR TGT: GUN OR A-A'…): a steady amber line
 * under the weapon and the target camera's status pill, before FIRE is pressed (owner, 2026-10-06:
 * an AARGM on a locked A320 read LOCK and CHECK FIRE, as if it could shoot).
 */
export function weaponMismatchOf(f: HudFrame): string | null {
  const t = f.target;
  if (!t || (t.kind !== 'aircraft' && t.kind !== 'ground' && t.kind !== 'sam')) return null;
  return weaponMismatch(f.p.selectedWeapon, t.kind);
}

/** Seconds the weapon block shows the selected weapon after a change. */
export const WEAPON_NEWS_S = 2;

/** "Low" for the selected weapon: the last store, or under a fifth of the gun's rounds. */
function weaponLow(f: HudFrame, w: WeaponId, n: number): boolean {
  return w === 'gun' ? n < 0.2 * Math.max(1, f.p.gunMaxAmmo) : n <= 1;
}

/** The rows the weapon block draws this frame. */
export interface WeaponRows {
  /** The selected weapon and its count (and "n IN FLT"). */
  weapon: boolean;
  /** Gun rounds under a selected missile or bomb. */
  gun: boolean;
  /** Flares and chaff. */
  cms: boolean;
  emcon: boolean;
  bay: boolean;
  wrong: string | null;
  denied: boolean;
}
const wrows: WeaponRows = { weapon: false, gun: false, cms: false, emcon: false, bay: false, wrong: null, denied: false };

/**
 * The counts have another home in this view: the SMS page in the cockpit, the buttons with touch controls.
 * The block then shows only news (owner, 2026-10-06): a weapon change (WEAPON_NEWS_S), low or empty, our
 * weapons in flight, a refusal or a wrong weapon. Elsewhere (HUD and chase views on a desktop) it keeps
 * the counts as before.
 */
export function countsElsewhere(f: HudFrame): boolean {
  return f.cockpit || !!f.ctx.touchControls;
}

/** Which weapon-block rows show this frame (drawWeaponBlock and weaponBlockLines read the same). */
export function weaponRows(f: HudFrame, compact = false): WeaponRows {
  const { p, st } = f;
  const w = p.selectedWeapon;
  const n = remainingOf(f, w);
  const news = countsElsewhere(f);
  wrows.wrong = weaponMismatchOf(f);
  wrows.denied = deniedShown(f) && st.deniedText !== wrows.wrong;
  wrows.weapon = !news || st.weaponAge < WEAPON_NEWS_S || weaponLow(f, w, n) || ownInFlight(f) > 0 || !!wrows.wrong || wrows.denied;
  wrows.gun = !compact && !news && w !== 'gun';
  wrows.cms = !compact && (!news || p.flares <= 4 || p.chaff <= 4);
  // EMCON: the RDR button says it with touch controls
  wrows.emcon = !p.radar.emitting && !f.ctx.touchControls;
  wrows.bay = !compact && !news && p.bayDoors > 0.05;
  return wrows;
}

/** Lines the full (non-compact) weapon block will use this frame. */
export function weaponBlockLines(f: HudFrame): number {
  const r = weaponRows(f);
  return (r.weapon ? 1 : 0) + (r.gun ? 1 : 0) + (r.cms ? 1 : 0) + (r.emcon ? 1 : 0) + (r.bay ? 1 : 0) + (r.wrong ? 1 : 0) + (r.denied ? 1 : 0);
}

/**
 * The release denial ("NO SEEKER") shows for 1.8 s, and only while the weapon it was for is still
 * selected: under 'GUN 400' after a switch it read as the gun's (playtest 2.1-e).
 */
export function deniedShown(f: HudFrame): boolean {
  const st = f.st;
  return st.deniedAge < 1.8 && !!st.deniedText && (!st.deniedWeapon || st.deniedWeapon === f.p.selectedWeapon);
}

const inFltTxt = new NumText(0, '', ' IN FLT');

/** The player's missiles and bombs in flight. */
export function ownInFlight(f: HudFrame): number {
  let n = 0;
  for (const m of f.world.missiles) if (m.alive && m.shooterId === f.p.id) n++;
  return n;
}

export function drawWeaponBlock(f: HudFrame, x: number, y: number, compact = false): number {
  const { pen, pal, L, p, st } = f;
  const u = L.u;
  const w = p.selectedWeapon;
  const n = remainingOf(f, w);
  const r = weaponRows(f, compact);
  // (no A-A / A-G master-mode line: the weapon's name says it, owner 2026-10-06)
  if (r.weapon) {
    // selected weapon (flashes briefly after a change; amber when low, as when empty)
    const label = weaponLabel(w, n);
    const fresh = st.weaponAge < 0.9;
    const col = n === 0 || (countsElsewhere(f) && weaponLow(f, w, n)) ? pal.warn : fresh ? pal.bright : pal.main;
    if (fresh) {
      const tw = pen.textWidth(label, 14) + 8 * u;
      pen.box(x - 4 * u, y - 9 * u, tw, 18 * u, pal.bright, 1.4, pal.back);
    }
    colText(f, label, x, y, col, 14, 'left');
    // our weapons in flight ("3 IN FLT"): a fixed place that always reads, where the per-box "T n" marks
    // in a tight swarm find no room (playtest 2.1-a)
    const flying = ownInFlight(f);
    if (flying > 0) colText(f, inFltTxt.get(flying), x + pen.textWidth(label, 14) + 10 * u, y + 0.5, pal.main, 11.5, 'left');
    y += L.line + 1;
  }
  // gun rounds as a secondary line when a missile/bomb is selected
  if (r.gun) {
    colText(f, weaponLabel('gun', p.gunAmmo), x, y, pal.dim, 11.5, 'left');
    y += L.line * 0.9;
  }
  if (r.cms) {
    const fl = flTxt.get(p.flares);
    const ch = chTxt.get(p.chaff);
    colText(f, fl, x, y, p.flares <= 4 ? pal.warn : pal.main, 11.5, 'left');
    colText(f, ch, x + pen.textWidth(fl, 11.5) + 8 * u, y, p.chaff <= 4 ? pal.warn : pal.main, 11.5, 'left');
    y += L.line * 0.9;
  }
  if (r.emcon) {
    colText(f, 'EMCON', x, y, pal.warn, 12, 'left');
    y += L.line * 0.9;
  }
  if (r.bay) {
    colText(f, 'BAY OPEN', x, y, pal.dim, 11, 'left');
    y += L.line * 0.9;
  }
  // the weapon can't engage the boxed target: steady, while it lasts (a denial saying the same blinks it)
  const wrong = r.wrong;
  if (wrong) {
    if (!(deniedShown(f) && st.deniedText === wrong) || blink(f, 4, 0.7)) colText(f, wrong, x, y, pal.warn, 12.5, 'left');
    if (TEST_HOOKS) noteCue(wrong, x, y, true);
    y += L.line;
  }
  if (r.denied) {
    if (blink(f, 4, 0.7)) colText(f, st.deniedText, x, y, pal.warn, 12.5, 'left');
    y += L.line;
  }
  return y;
}

/* ───────────────────────── DLZ ───────────────────────── */

export function drawDlz(f: HudFrame, x: number, top: number, bottom: number): void {
  const z = f.zone;
  if (!z || z.weapon === 'gun' || z.rMax <= 0) return;
  if (WEAPON_IS_BOMB[z.weapon]) return; // bombs use the release cue
  const { pen, pal, L, st } = f;
  const u = L.u;
  const g = dlzLayout(z, top, bottom, dlzGeom, st.dlzScale);
  st.dlzScale = g.scaleMax;
  const col = z.shoot ? pal.bright : pal.main;
  pen.setDash('solid');
  // scale top tick + label
  pen.begin();
  pen.line(x - 4 * u, top, x + 4 * u, top);
  // launch zone Rmin..Rmax
  pen.line(x, g.yMax, x, g.yMin);
  pen.line(x - 7 * u, g.yMax, x + 3 * u, g.yMax); // Rmax
  pen.line(x - 7 * u, g.yMin, x + 3 * u, g.yMin); // Rmin
  pen.strokeGlow(col, 1.6);
  // no-escape zone: thick bar Rmin..Rne
  pen.setFill(pal.outline);
  pen.g.fillRect(x - 5 * u, g.yNe - 1, 5 * u + 2, g.yMin - g.yNe + 2);
  pen.setFill(col);
  pen.g.fillRect(x - 4 * u, g.yNe, 3.5 * u, g.yMin - g.yNe);
  pen.text(INT_STR[g.scaleNm] ?? String(g.scaleNm), x, top - 9 * u, pal.dim, 10.5);
  // target caret with closure
  const cy = g.yRange;
  pen.begin();
  pen.arrow(x + 3 * u, cy, -1, 0, 9 * u, 5 * u);
  pen.strokeGlow(col, 1.5);
  if (!g.clamped) pen.fillPlain(col);
  pen.text(vcTxt.get(toKnots(z.closure)), x + 14 * u, cy, col, 11, 'left');
  // time of flight
  if (z.timeOfFlight > 0) pen.text(tofTxt.get(z.timeOfFlight), x, bottom + 11 * u, pal.main, 11);
}

/** Centre x of the last line placeCueLine placed. */
export const cueAt = { x: 0 };

/** Sideways offsets (× the line's width) placeCueLine tries when the centre column has no room. */
const CUE_SHIFTS = [0, 1, -1, 2, -2];

/**
 * Place one centre-cue text line near `yPref` (fixed slot below the FPM / above the jet), dodging the
 * protected symbols: in the centre column, else beside it (a target box, the incoming-missile TTIs and
 * the bank arc can fill the column on a phone: 1.2-d). Returns the centre y (cueAt.x the centre x) and
 * registers the line. Nowhere clear: an `optional` line (the FOX call) returns NaN and is left out (it
 * printed over the target box's type label: 'FOX 23', 1.2-b), any other goes in the centre slot anyway.
 */
export function placeCueLine(f: HudFrame, text: string, size: number, yPref: number, optional = false): number {
  const { pen, L, occ } = f;
  const u = L.u;
  const hw = pen.textWidth(text, size) / 2 + 4 * u;
  const h = (size + 4) * u;
  const lo = L.row2Y + 16 * u;
  const hi = Math.max(L.msgFloor, yPref + h);
  // (clear of the protected symbols and text, and of the contact / ground / waypoint symbols)
  let top = NaN;
  let x = L.cx;
  for (const k of CUE_SHIFTS) {
    x = L.cx + k * (hw * 2 + 6 * u);
    if (x - hw < L.left || x + hw > L.right) continue;
    top = occ.freeY(x - hw, x + hw, h, yPref - h / 2, lo, hi, 'down', 4, f.sym);
    if (Number.isFinite(top)) break;
  }
  if (!Number.isFinite(top)) {
    if (optional) return NaN;
    x = L.cx;
    top = yPref - h / 2;
  }
  occ.add(x - hw, top, x + hw, top + h);
  cueAt.x = x;
  return top + h / 2;
}

/* ───────────────────────── Centre cue lines (SHOOT / IN RANGE / FOX 3) ───────────────────────── */

interface CueLine {
  text: string;
  size: number;
  col: string;
  /** Blink rate (0 = steady). */
  hz: number;
  alpha: number;
  /** Left out when there is no room for it (the FOX call). */
  optional: boolean;
  x: number;
  /** NaN = not placed this frame. */
  y: number;
}
const cues: CueLine[] = Array.from({ length: 3 }, () => ({ text: '', size: 0, col: '', hz: 0, alpha: 1, optional: false, x: 0, y: 0 }));
let cueCount = 0;

function addCue(text: string, size: number, col: string, hz: number, alpha = 1, optional = false): void {
  if (cueCount >= cues.length || !text) return;
  const c = cues[cueCount++];
  c.text = text;
  c.size = size;
  c.col = col;
  c.hz = hz;
  c.alpha = alpha;
  c.optional = optional;
}

/**
 * Decide the centre cue lines for this frame and RESERVE their spots (below the FPM / above the jet,
 * dodging the protected symbols). Call right after the protected symbols, before secondary labels, so
 * waypoint / contact labels make way for the cues. `drawCues` draws them later, on top.
 */
export function planCues(f: HudFrame): number {
  cueCount = 0;
  const { pal, st, p, L } = f;
  const z = f.zone;
  // SHOOT (also for the gun: the pipper goes bright in range, the word lives in the cue slot so it
  // never lands on the target box that the pipper is tracking)
  if (z && z.shoot && !WEAPON_IS_BOMB[z.weapon]) addCue('SHOOT', 20, pal.bright, 4);
  // bombs: release cue. The GPS cue (REL n / IN RANGE, the wording the briefings and hints use) shows
  // in every view, chase included; the CCIP cue goes with its pipper, which only the HMD draws
  const w = p.selectedWeapon;
  if (WEAPON_IS_BOMB[w]) {
    const bi = bombInfo(f);
    if (bi) {
      if (p.radar.groundPoint) {
        if (bi.inRange) addCue('IN RANGE', 19, pal.bright, 3.5);
        else if (bi.timeToRelease >= 0) addCue(relTxt.get(Math.ceil(bi.timeToRelease)), 17, pal.main, 0);
        // our bomb is still guiding onto it: nothing to steer for (STEER read as "turn back for the bomb")
        else if (bi.bombAway) addCue('BOMB AWAY', 15, pal.main, 0);
        // target outside the bomb's release cone: which way to turn
        else if (bi.offAxis) addCue(bi.steer < 0 ? 'STEER LEFT' : 'STEER RIGHT', 17, pal.warn, 0);
        else addCue('OUT OF RANGE', 15, pal.warn, 0);
      } else if (f.mode === 'hmd') {
        if (!bombOnScreen) addCue('CCIP', 13, pal.dim, 0);
        else if (bi.inRange) addCue('PICKLE', 17, pal.bright, 3.5);
      }
    }
  }
  // brevity flash after a release ("FOX 3")
  if (st.brevityAge <= 1.3 && st.brevity) addCue(st.brevity, 15, pal.white, 0, Math.max(0, Math.min(1, (1.3 - st.brevityAge) / 0.4)), true);
  let y = L.cueY;
  let placed = 0;
  for (let i = 0; i < cueCount; i++) {
    const c = cues[i];
    c.y = placeCueLine(f, c.text, c.size, y, c.optional);
    c.x = cueAt.x;
    if (!Number.isFinite(c.y)) continue;
    placed++;
    // (a line moved aside leaves the centre column's next slot where it was)
    if (c.x === L.cx) y = c.y + (c.size + 4) * L.u;
  }
  return placed > 0 ? y : L.msgY;
}

const gapT = new Float32Array(cues.length * 2);
/**
 * Path the segment a→b with a gap where it crosses a planned cue line, so a steering line never runs
 * through "IN RANGE" (#62: the GPS azimuth steering line struck the R's stem). Liang–Barsky clip of
 * the segment against each cue's text rect; the pieces outside go on the current path.
 */
function lineAroundCues(f: HudFrame, ax: number, ay: number, bx: number, by: number): void {
  const { pen, L } = f;
  const u = L.u;
  const dx = bx - ax;
  const dy = by - ay;
  let n = 0;
  for (let i = 0; i < cueCount; i++) {
    const c = cues[i];
    if (!Number.isFinite(c.y)) continue;
    const hw = pen.textWidth(c.text, c.size) / 2 + 4 * u;
    const hh = (c.size / 2 + 2) * u;
    let t0 = 0;
    let t1 = 1;
    const clip = (pp: number, q: number): boolean => {
      if (pp === 0) return q >= 0;
      const r = q / pp;
      if (pp < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      return t0 <= t1;
    };
    if (clip(-dx, ax - (c.x - hw)) && clip(dx, c.x + hw - ax) && clip(-dy, ay - (c.y - hh)) && clip(dy, c.y + hh - ay) && t1 > t0) {
      gapT[n * 2] = t0;
      gapT[n * 2 + 1] = t1;
      n++;
    }
  }
  let t = 0;
  // (at most three gaps: pick them in order without sorting an array)
  for (let k = 0; k < n; k++) {
    let best = -1;
    for (let j = 0; j < n; j++) if (gapT[j * 2 + 1] > t && (best < 0 || gapT[j * 2] < gapT[best * 2])) best = j;
    if (best < 0) break;
    const g0 = gapT[best * 2];
    if (g0 > t) pen.line(ax + dx * t, ay + dy * t, ax + dx * g0, ay + dy * g0);
    t = Math.max(t, gapT[best * 2 + 1]);
  }
  if (t < 1) pen.line(ax + dx * t, ay + dy * t, bx, by);
}

/** Draw the planned cue lines. */
export function drawCues(f: HudFrame): void {
  const { pen } = f;
  for (let i = 0; i < cueCount; i++) {
    const c = cues[i];
    if (!Number.isFinite(c.y)) continue;
    const on = c.hz <= 0 || blink(f, c.hz, 0.7);
    if (TEST_HOOKS) noteCue(c.text, c.x, c.y, on);
    if (!on) continue;
    pen.g.globalAlpha = c.alpha * f.declutter;
    pen.text(c.text, c.x, c.y, c.col, c.size);
    pen.g.globalAlpha = 1;
  }
}

/* ───────────────────────── AIM-9X ───────────────────────── */

export function drawAim9x(f: HudFrame): void {
  if (f.p.selectedWeapon !== 'aim9x') return;
  const { pen, pal, L, proj, p } = f;
  const u = L.u;
  let ir: ReturnType<typeof f.world.combat.irSeekerState>;
  try {
    ir = f.world.combat.irSeekerState(p);
  } catch {
    return;
  }
  if (!ir || ir.state === 'off') return;
  const dir = ir.direction ?? forwardOf(p.quaternion, f.v1);
  if (!proj.dir(dir, f.sp) || !f.sp.onScreen) return;
  const x = f.sp.x;
  const y = f.sp.y;
  const locked = ir.state === 'locked';
  const r = locked ? 17 * u + Math.sin(f.st.clock * 12) * 1.2 * u : 24 * u + Math.sin(f.st.clock * 7) * 1.5 * u;
  if (locked) {
    pen.setDash('solid');
    pen.begin();
    pen.circle(x, y, r);
    pen.line(x - 5 * u, y, x + 5 * u, y);
    pen.line(x, y - 5 * u, x, y + 5 * u);
    pen.strokeGlow(pal.bright, 2);
  } else {
    // searching: dashed wobbling circle ("growl")
    pen.setDash('dash');
    pen.begin();
    pen.circle(x, y, r);
    pen.strokeGlow(pal.main, 1.6);
    pen.setDash('solid');
  }
  f.occ.add(x - r - 3 * u, y - r - 3 * u, x + r + 3 * u, y + r + 3 * u, 1);
  setReticle(f, x, y, r + 2 * u);
  // TONE / GROWL goes on once the target box has laid its labels out (drawSeekerLabel): under the
  // circle it covered the box's range readout (1.2-c)
  seekerLabel.frame = f.st.frame;
  seekerLabel.text = locked ? 'TONE' : 'GROWL';
  seekerLabel.col = locked ? pal.bright : pal.dim;
  seekerLabel.size = locked ? 11 : 10.5;
  seekerLabel.x = x;
  seekerLabel.y = y;
  seekerLabel.r = r;
}

/** The ring of the reticle drawn this frame (gun pipper / AIM-9X seeker): the target box labels keep out of it. */
export const reticle = { frame: -1, x: 0, y: 0, r: 0 };

function setReticle(f: HudFrame, x: number, y: number, r: number): void {
  reticle.frame = f.st.frame;
  reticle.x = x;
  reticle.y = y;
  reticle.r = r;
}

const seekerLabel = { frame: -1, text: '', col: '', size: 11, x: 0, y: 0, r: 0 };

/**
 * The AIM-9X seeker's TONE / GROWL, after the target box: under the circle, else left / right of it,
 * else above it (then the same 8 u further out), wherever nothing registered is (the box's range readout
 * included); none: under it.
 */
export function drawSeekerLabel(f: HudFrame): void {
  const sl = seekerLabel;
  if (sl.frame !== f.st.frame || f.p.selectedWeapon !== 'aim9x') return;
  const { pen, L, occ } = f;
  const u = L.u;
  const w = pen.textWidth(sl.text, sl.size);
  const hh = 7 * u;
  let lx = sl.x;
  let ly = sl.y + sl.r + 11 * u;
  // (each side in turn, then each again 8 u further out; clear of everything, else of the protected
  // symbols and the target box's labels at least: a fixed zone's reserved rect is wider than its text)
  search: for (let minLevel = 0; minLevel < 2; minLevel++) {
    for (let k = 0; k < 16; k++) {
      const d = (k >> 2) * 8 * u;
      const s = k & 3;
      const cx = s === 0 || s === 3 ? sl.x : s === 1 ? sl.x - sl.r - 6 * u - w / 2 - d : sl.x + sl.r + 6 * u + w / 2 + d;
      const cy = s === 0 ? sl.y + sl.r + 11 * u + d : s === 3 ? sl.y - sl.r - 11 * u - d : sl.y;
      if (cx - w / 2 < L.left || cx + w / 2 > L.right || cy - hh < L.row2Y || cy + hh > L.H) continue;
      if (occ.hits(cx - w / 2 - u, cy - hh, cx + w / 2 + u, cy + hh, minLevel)) continue;
      lx = cx;
      ly = cy;
      break search;
    }
  }
  pen.text(sl.text, lx, ly, sl.col, sl.size);
  occ.add(lx - w / 2 - u, ly - hh, lx + w / 2 + u, ly + hh, 1);
}

/* ───────────────────────── Gun ───────────────────────── */

const FUNNEL_RANGES = [150, 300, 450, 600, 800, 1000, 1250];
const funnelL = new Float32Array(FUNNEL_RANGES.length * 2);
const funnelR = new Float32Array(FUNNEL_RANGES.length * 2);
const GUN_EFFECTIVE = 1200;
const BULLET_SPEED = 1040;
const WINGSPAN = 11;
/** Shortest the EEGS range bar is drawn (× the HUD unit, px). */
const FUNNEL_BAR_MIN = 22;
/** The gun's closure cue ("Vc 140", knots) shows inside this range of a designated air target (m). */
export const GUN_VC_RANGE = 3000;
/**
 * OVERSHOOT (amber) is a time-to-close cue: lit when the jet will be inside GUN_OVERSHOOT_MIN (the
 * warhead's reach, where it must break off) in under GUN_OVERSHOOT_TIME at the present closure — too
 * little time to pull the pipper onto a slow target (a Shahed at ~100 kt) and fire. 600 m at Vc 100 kt
 * is 8.8 s (no cue); 300 m at Vc 154 kt is 1.9 s (cue). (A closure-only threshold lit at 580 m, Vc 154,
 * long before the pipper could reach the drone: playtest 2.1-b.)
 */
export const GUN_OVERSHOOT_TIME = 4;
export const GUN_OVERSHOOT_MIN = 150;

/** OVERSHOOT at `range` (m) closing at `closure` (m/s)? */
export function gunOvershoot(range: number, closure: number): boolean {
  return closure > 0 && (range - GUN_OVERSHOOT_MIN) / closure < GUN_OVERSHOOT_TIME;
}
const gunVcTxt = new NumText(0, 'Vc ');

/** Closure rate (m/s, positive = closing) between the player and `t`. */
export function closureRate(p: { position: Vector3; velocity: Vector3 }, t: { position: Vector3; velocity: Vector3 }): number {
  const dx = t.position.x - p.position.x;
  const dy = t.position.y - p.position.y;
  const dz = t.position.z - p.position.z;
  const d = Math.hypot(dx, dy, dz);
  if (d < 1) return 0;
  return -((t.velocity.x - p.velocity.x) * dx + (t.velocity.y - p.velocity.y) * dy + (t.velocity.z - p.velocity.z) * dz) / d;
}

/**
 * Gun closure cue beside the anchor (the LCOS pipper, or the gun cross without one): "Vc 140", and
 * OVERSHOOT under it when closing too fast (gunOvershoot). Drawn after the target box and its labels
 * (drawGunCues), so it tries right, left, below, above the anchor for a spot clear of everything
 * registered, them included (playtest 2.1-d: "Vc" into the drone's name), then registers itself.
 */
function drawGunClosure(f: HudFrame, ax: number, ay: number, ar: number): void {
  const t = f.target;
  if (!t || t.kind !== 'aircraft') return;
  const { pen, pal, L, p, proj } = f;
  const range = t.position.distanceTo(p.position);
  if (range > GUN_VC_RANGE) return;
  const u = L.u;
  const closure = closureRate(p, t);
  const kt = toKnots(closure);
  const over = gunOvershoot(range, closure);
  const vc = gunVcTxt.get(kt);
  const lh = 12 * u;
  const w = Math.max(pen.textWidth(vc, 11), over ? pen.textWidth('OVERSHOOT', 11) : 0) + 2 * u;
  const h = (over ? 2 : 1) * lh;
  // the target box (drawn after the gun cues) stays clear too
  const tb = proj.point(t.position, f.sp2) && f.sp2.onScreen;
  const tbh = 24 * u;
  let x0 = NaN;
  let y0 = NaN;
  for (let i = 0; i < 4; i++) {
    const cx = i === 0 ? ax + ar + 6 * u : i === 1 ? ax - ar - 6 * u - w : ax - w / 2;
    const cy = i < 2 ? ay - h / 2 : i === 2 ? ay + ar + 6 * u : ay - ar - 6 * u - h;
    if (cx < L.left || cx + w > L.right || cy < 0 || cy + h > L.H) continue;
    if (f.occ.hits(cx, cy, cx + w, cy + h)) continue;
    if (tb && cx < f.sp2.x + tbh && f.sp2.x - tbh < cx + w && cy < f.sp2.y + tbh && f.sp2.y - tbh < cy + h) continue;
    x0 = cx;
    y0 = cy;
    break;
  }
  if (!Number.isFinite(x0)) {
    // nowhere clear: right of the anchor all the same (the closure matters more than a tidy screen)
    x0 = ax + ar + 6 * u;
    y0 = ay - h / 2;
  }
  pen.text(vc, x0 + u, y0 + lh / 2, over ? pal.warn : pal.main, 11, 'left');
  if (over) pen.text('OVERSHOOT', x0 + u, y0 + lh * 1.5, pal.warn, 11, 'left');
  f.occ.add(x0, y0, x0 + w, y0 + h, 1);
}

/** Where drawGun left the closure cue's anchor this frame (the pipper, or the gun cross). */
const gunAnchor = { frame: -1, x: 0, y: 0, r: 0 };

/** The gun's closure cue (Vc / OVERSHOOT), once the target box and its labels are drawn. */
export function drawGunCues(f: HudFrame): void {
  if (f.p.selectedWeapon !== 'gun' || gunAnchor.frame !== f.st.frame) return;
  drawGunClosure(f, gunAnchor.x, gunAnchor.y, gunAnchor.r);
}

/**
 * Gun symbology: EEGS funnel, gun cross, LCOS pipper.
 * @param dirs  draw the direction-projected symbols (funnel, gun cross): the HMD views and an external
 *              camera close to the jet (chase); a far camera (flyby) gets the pipper only, which is a
 *              world point and projects right from anywhere
 */
export function drawGun(f: HudFrame, dirs = true): void {
  if (f.p.selectedWeapon !== 'gun') return;
  const { pen, pal, L, proj, p } = f;
  const u = L.u;
  if (!dirs) {
    drawPipper(f, NaN, NaN);
    return;
  }
  // EEGS funnel: bullet stream lags the nose rotation and drops with gravity
  const fwd = forwardOf(p.quaternion, f.v1);
  const fx = fwd.x, fy = fwd.y, fz = fwd.z;
  const up = upOf(p.quaternion, f.v2);
  const ux = up.x, uy = up.y, uz = up.z;
  const right = rightOf(p.quaternion, f.v3);
  const rx = right.x, ry = right.y, rz = right.z;
  const sp = f.sp;
  const own = p.velocity.length();
  const dir = f.v1;
  let n = 0;
  let prevX = NaN;
  let prevY = NaN;
  for (let i = 0; i < FUNNEL_RANGES.length; i++) {
    const r = FUNNEL_RANGES[i];
    const t = r / (BULLET_SPEED + own * 0.5);
    const aPitch = -p.rates.y * t;
    const aYaw = -p.rates.z * t;
    const drop = (0.5 * G * t * t) / r;
    dir.set(fx + ux * aPitch + rx * aYaw, fy + uy * aPitch + ry * aYaw - drop, fz + uz * aPitch + rz * aYaw).normalize();
    if (!proj.dir(dir, sp)) break;
    // perpendicular to the funnel centreline on screen; width = wingspan at that range
    const hw = (WINGSPAN / 2 / r) * proj.pxPerRad;
    let px = 1;
    let py = 0;
    if (Number.isFinite(prevX)) {
      const sx = sp.x - prevX;
      const sy = sp.y - prevY;
      const l = Math.hypot(sx, sy);
      if (l > 0.5) {
        px = -sy / l;
        py = sx / l;
        if (px < 0) {
          px = -px;
          py = -py;
        }
      }
    }
    funnelL[n * 2] = sp.x - px * hw;
    funnelL[n * 2 + 1] = sp.y - py * hw;
    funnelR[n * 2] = sp.x + px * hw;
    funnelR[n * 2 + 1] = sp.y + py * hw;
    prevX = sp.x;
    prevY = sp.y;
    n++;
  }
  if (n >= 2) {
    pen.setDash('solid');
    pen.begin();
    const g = pen.g;
    g.moveTo(funnelL[0], funnelL[1]);
    for (let i = 1; i < n; i++) g.lineTo(funnelL[i * 2], funnelL[i * 2 + 1]);
    g.moveTo(funnelR[0], funnelR[1]);
    for (let i = 1; i < n; i++) g.lineTo(funnelR[i * 2], funnelR[i * 2 + 1]);
    // (main, not dim: in the pilot's review the dim rails didn't read as a funnel at all, #116)
    pen.strokeGlow(pal.main, 1.4);
    // EEGS range line: a bar across the funnel at the target's range. The bandit's wings filling the
    // funnel where the bar sits is the firing solution, the same cue as the pipper's range arc (#116)
    const t = f.target;
    if (t && t.kind === 'aircraft') {
      const rt = t.position.distanceTo(p.position);
      const k = funnelIndexAt(rt, n);
      if (k >= 0) {
        const i0 = Math.floor(k);
        const i1 = Math.min(n - 1, i0 + 1);
        const w = k - i0;
        const lx = funnelL[i0 * 2] + (funnelL[i1 * 2] - funnelL[i0 * 2]) * w;
        const ly = funnelL[i0 * 2 + 1] + (funnelL[i1 * 2 + 1] - funnelL[i0 * 2 + 1]) * w;
        const rx = funnelR[i0 * 2] + (funnelR[i1 * 2] - funnelR[i0 * 2]) * w;
        const ry = funnelR[i0 * 2 + 1] + (funnelR[i1 * 2 + 1] - funnelR[i0 * 2 + 1]) * w;
        // past ~300 m a fighter's wingspan is only a few px on a phone: the bar never gets shorter than
        // BAR_MIN, with ticks at the true funnel width so the "wings fill it" read stays
        const mx = (lx + rx) / 2;
        const my = (ly + ry) / 2;
        const len = Math.hypot(rx - lx, ry - ly);
        const half = Math.max(len, FUNNEL_BAR_MIN * u) / 2;
        const ex = len > 0.5 ? (rx - lx) / len : 1;
        const ey = len > 0.5 ? (ry - ly) / len : 0;
        pen.begin();
        pen.line(mx - ex * half, my - ey * half, mx + ex * half, my + ey * half);
        pen.line(lx + ey * 3 * u, ly - ex * 3 * u, lx - ey * 3 * u, ly + ex * 3 * u);
        pen.line(rx + ey * 3 * u, ry - ex * 3 * u, rx - ey * 3 * u, ry + ex * 3 * u);
        pen.strokeGlow(rt < GUN_EFFECTIVE ? pal.bright : pal.main, 2);
        if (TEST_HOOKS) noteFunnelBar(mx, my, len, rt);
      }
    }
    // protected: text never lands on the funnel (one box per funnel segment)
    for (let i = 1; i < n; i++) {
      const a = i * 2;
      const b = a - 2;
      f.occ.add(
        Math.min(funnelL[a], funnelL[b], funnelR[a], funnelR[b]) - 3,
        Math.min(funnelL[a + 1], funnelL[b + 1], funnelR[a + 1], funnelR[b + 1]) - 3,
        Math.max(funnelL[a], funnelL[b], funnelR[a], funnelR[b]) + 3,
        Math.max(funnelL[a + 1], funnelL[b + 1], funnelR[a + 1], funnelR[b + 1]) + 3,
        1,
      );
    }
  }
  // gun cross at the gun line
  forwardOf(p.quaternion, f.v1);
  let crossX = NaN;
  let crossY = NaN;
  if (proj.dir(f.v1, sp) && sp.onScreen) {
    pen.begin();
    pen.line(sp.x - 6 * u, sp.y - 8 * u, sp.x + 6 * u, sp.y - 8 * u);
    pen.line(sp.x, sp.y - 14 * u, sp.x, sp.y - 2 * u);
    pen.strokeGlow(pal.main, 1.4);
    crossX = sp.x;
    crossY = sp.y - 8 * u;
  }
  // LCOS pipper at the lead point with a range bar
  drawPipper(f, crossX, crossY);
}

/**
 * Fractional index into the drawn funnel points (the first `n` of FUNNEL_RANGES) of a range (m);
 * −1 outside the drawn funnel.
 */
export function funnelIndexAt(range: number, n: number): number {
  if (n < 2 || range < FUNNEL_RANGES[0] || range > FUNNEL_RANGES[n - 1]) return -1;
  for (let i = 1; i < n; i++) {
    const a = FUNNEL_RANGES[i - 1];
    const b = FUNNEL_RANGES[i];
    if (range <= b) return i - 1 + (range - a) / (b - a);
  }
  return n - 1;
}

/** LCOS pipper (and the closure cue's anchor: the pipper, else the gun cross at crossX / crossY). */
function drawPipper(f: HudFrame, crossX: number, crossY: number): void {
  const { pen, pal, L, proj, p } = f;
  const u = L.u;
  const sp = f.sp;
  let lead: ReturnType<typeof f.world.combat.gunLeadPoint>;
  try {
    lead = f.world.combat.gunLeadPoint(p, f.world);
  } catch {
    lead = null;
  }
  if (!lead || !proj.point(lead, sp) || !sp.onScreen) {
    if (Number.isFinite(crossX)) setAnchor(f, crossX, crossY, 14 * u);
    return;
  }
  const x = sp.x;
  const y = sp.y;
  const R = 19 * u;
  f.occ.add(x - R - 7 * u, y - R - 7 * u, x + R + 7 * u, y + R + 7 * u, 1);
  setReticle(f, x, y, R + 2 * u);
  const t = f.target;
  const range = t ? t.position.distanceTo(p.position) : GUN_EFFECTIVE * 2;
  const inRange = range < GUN_EFFECTIVE;
  const col = inRange ? pal.bright : pal.main;
  pen.begin();
  pen.circle(x, y, R);
  pen.strokeGlow(col, 1.8);
  pen.setFill(col);
  pen.g.fillRect(x - 1.6 * u, y - 1.6 * u, 3.2 * u, 3.2 * u);
  // range bar: arc from 12 o'clock, full circle = 2 km; tick at the effective range
  const frac = Math.max(0, Math.min(1, range / 2000));
  if (t) {
    pen.begin();
    pen.arc(x, y, R - 4 * u, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    pen.strokeGlow(col, 2.4);
  }
  const ta = -Math.PI / 2 + (GUN_EFFECTIVE / 2000) * Math.PI * 2;
  pen.begin();
  pen.line(x + Math.cos(ta) * (R + 1), y + Math.sin(ta) * (R + 1), x + Math.cos(ta) * (R + 6 * u), y + Math.sin(ta) * (R + 6 * u));
  pen.strokeGlow(pal.main, 1.4);
  setAnchor(f, x, y, R + 7 * u);
  if (TEST_HOOKS) notePipper(x, y, R);
}

function setAnchor(f: HudFrame, x: number, y: number, r: number): void {
  gunAnchor.frame = f.st.frame;
  gunAnchor.x = x;
  gunAnchor.y = y;
  gunAnchor.r = r;
}

/* ───────────────────────── Air-to-ground ───────────────────────── */

let bombOnScreen = false;
let biFrame = -1;
let biCache: BombCue | null = null;
/** Bomb impact / release info for this frame (cached: planCues + drawAirToGround both need it). */
function bombInfo(f: HudFrame): BombCue | null {
  if (biFrame === f.st.frame) return biCache;
  biFrame = f.st.frame;
  try {
    biCache = f.world.combat.bombImpactPoint(f.p, f.world);
  } catch {
    biCache = null;
  }
  bombOnScreen = !!biCache && f.proj.point(biCache.point, f.sp2) && f.sp2.onScreen;
  return biCache;
}

/** Air-to-ground conformal cues: GPS azimuth steering line / target point, or the CCIP pipper. */
export function drawAirToGround(f: HudFrame): void {
  const p = f.p;
  const w = p.selectedWeapon;
  if (!WEAPON_IS_BOMB[w]) return;
  const { pen, pal, L, proj } = f;
  const u = L.u;
  const bi = bombInfo(f);
  if (!bi) return;
  const gp = p.radar.groundPoint;
  if (gp) {
    // GPS weapon: azimuth steering line through the target bearing
    const brg = Math.atan2(gp.x - p.position.x, -(gp.z - p.position.z));
    dirFromHeadingPitch(brg, f.vPitch + 7 * DEG, f.v1);
    dirFromHeadingPitch(brg, f.vPitch - 9 * DEG, f.v2);
    const a = f.sp;
    const b = f.sp2;
    if (proj.dir(f.v1, a) && proj.dir(f.v2, b) && (a.onScreen || b.onScreen)) {
      pen.setDash('solid');
      pen.begin();
      lineAroundCues(f, a.x, a.y, b.x, b.y);
      pen.strokeGlow(bi.inRange ? pal.bright : pal.main, 1.8);
    }
    // target point marker (for designations without an entity box)
    if (proj.point(gp, a) && a.onScreen && !f.target) {
      pen.begin();
      pen.diamond(a.x, a.y, 9 * u);
      pen.strokeGlow(pal.main, 1.8);
    }
    return;
  }
  // CCIP: impact pipper + bomb fall line from the FPM
  if (!proj.point(bi.point, f.sp) || !f.sp.onScreen) return;
  const x = f.sp.x;
  const y = f.sp.y;
  f.occ.addBox(x, y, 13 * u, 13 * u, 1);
  const col = bi.inRange ? pal.bright : pal.main;
  pen.setDash(bi.inRange ? 'solid' : 'dash');
  if (f.fpm.front && f.fpm.onScreen) {
    pen.begin();
    pen.line(f.fpm.x, f.fpm.y + 8 * u, x, y - 9 * u);
    pen.strokeGlow(pal.dim, 1.3);
  }
  pen.setDash('solid');
  pen.begin();
  pen.circle(x, y, 9 * u);
  pen.strokeGlow(col, 1.8);
  pen.setFill(col);
  pen.g.fillRect(x - 1.5 * u, y - 1.5 * u, 3 * u, 3 * u);
}

export { WEAPON_BREVITY };
